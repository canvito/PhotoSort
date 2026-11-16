"""Face-tagging results and workers for the dashboard sidecar (dashboard_sidecar.py).

Reads the `photosort_faces.json` a `photosort faces` run writes into its source folder, lists the people folder,
and checks face workers. Nothing here runs a model or sends media anywhere: a worker check only asks an SSH host
whether PhotoSort's worker environment exists (`test -x`), after the same LAN-only check the real run makes.
Paths in a results file are trusted only inside the folder it is in, and only where the sidecar's own rules
(Library.allowed) allow; thumbnails for these files go through the same media routes as the index's.
"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

from face_tagger import (REMOTE_PYTHON, SSH_OPTIONS, FaceTaggingError, ensure_lan_host, parse_workers)
from local_only import LocalOnlyError
from media import VIDEO_EXTS
from photosort import IMAGE_EXTS, load_config
from thumbs import MediaUnavailable, media_stat

FACES_FILE = "photosort_faces.json"
FACES_FORMAT = "photosort-faces-v1"
MAX_PEOPLE = 200
SAMPLES = 4
CHECK_TIMEOUT_S = 25
MODEL_FILES = ("det_10g.onnx", "w600k_r50.onnx")
ORIENTATION = 0x0112


def _folder(raw, roots) -> Path:
    p = Path(str(raw))
    if not p.is_absolute() or str(p).startswith("\\\\") or os.path.islink(p):
        raise LocalOnlyError("not a local folder")
    resolved = p.resolve()
    if str(resolved).startswith("\\\\"):
        raise LocalOnlyError("not a local folder")
    if roots is not None and not any(resolved == r or resolved.is_relative_to(r) for r in roots):
        raise LocalOnlyError("outside the fixture library")
    if not resolved.is_dir():
        raise MediaUnavailable("missing")
    return resolved


def _status(faces: list, error) -> str:
    if error:
        return "error"
    if any(f.get("person") for f in faces):
        return "named"
    return "unknown" if faces else "none"


class Faces:
    def __init__(self, library, config_path: Path):
        self.lib = library
        self.config_path = config_path
        self._cache: dict[str, tuple] = {}
        self._lock = threading.Lock()
        # Starts from the clock so it keeps growing across sidecar restarts (the Faces page keeps the largest seen).
        self._generation = time.time_ns() // 1_000_000

    # ---------- results files ----------

    def _load(self, folder) -> dict:
        root = _folder(folder, self.lib.roots)
        file = root / FACES_FILE
        if os.path.islink(file):
            raise LocalOnlyError("results file is a link")
        try:
            st = file.stat()
        except OSError:
            raise MediaUnavailable("no_results") from None
        key = (st.st_size, st.st_mtime_ns)
        with self._lock:
            hit = self._cache.get(str(file))
            if hit and hit[0] == key:
                return hit[1]
        try:
            data = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise MediaUnavailable("bad_results") from None
        if not isinstance(data, dict) or data.get("format") != FACES_FORMAT or not isinstance(data.get("images"), list):
            raise MediaUnavailable("bad_results")
        items, skipped = [], 0
        for rec in data["images"]:
            rel = rec.get("file") if isinstance(rec, dict) else None
            if not isinstance(rel, str) or not rel or Path(rel).is_absolute() or ".." in Path(rel).parts:
                skipped += 1
                continue
            path = root / rel
            if not self.lib.allowed(str(path), check_link=False):
                skipped += 1
                continue
            faces = [f for f in rec.get("faces") or [] if isinstance(f, dict)]
            error = rec.get("error") if isinstance(rec.get("error"), str) else None
            named = sorted({str(f["person"]) for f in faces if f.get("person")})
            items.append({"id": self.lib.row_id(str(path)), "path": path, "faces": faces, "error": error,
                          "frames": rec.get("frames") if isinstance(rec.get("frames"), int) else None,
                          "people": named, "unknown": sum(not f.get("person") for f in faces),
                          "status": _status(faces, error)})
        counts = {"all": len(items), "people": {}, "unknown": 0, "none": 0, "errors": 0}
        for it in items:
            for name in it["people"]:
                counts["people"][name] = counts["people"].get(name, 0) + 1
            counts["unknown"] += it["unknown"] > 0
            counts["none"] += it["status"] == "none"
            counts["errors"] += it["status"] == "error"
        with self._lock:
            self._generation += 1
            parsed = {"generation": self._generation, "items": items, "by_id": {it["id"]: it for it in items},
                      "counts": counts, "skipped": skipped,
                      "meta": {k: data.get(k) for k in ("model", "provider", "threshold", "margin", "people",
                                                         "started_at", "finished_at", "duration_s", "summary",
                                                         "workers")}}
            if len(self._cache) > 8:
                self._cache.clear()
            self._cache[str(file)] = (key, parsed)
        return parsed

    def read(self, folder) -> dict:
        r = self._load(folder)
        return {"generation": r["generation"], "counts": r["counts"], "skipped": r["skipped"], **r["meta"]}

    @staticmethod
    def _matches(it: dict, filter: str) -> bool:
        if filter == "all":
            return True
        if filter.startswith("person:"):
            return filter[7:] in it["people"]
        if filter == "unknown":
            return it["unknown"] > 0
        return it["status"] == {"none": "none", "errors": "error"}.get(filter, "")

    def _public(self, it: dict) -> dict:
        row = self.lib.remember(it["path"], len(it["faces"]))
        return {**self.lib.public(row), "status": it["status"], "people": it["people"], "faces": len(it["faces"]),
                "unknown": it["unknown"], "frames": it["frames"], "error": it["error"]}

    def items(self, folder, filter="all", cursor=0, limit=200) -> dict:
        r = self._load(folder)
        self.lib.sync()
        rows = [it for it in r["items"] if self._matches(it, str(filter))]
        cursor, limit = max(0, int(cursor)), min(500, max(1, int(limit)))
        end = cursor + limit
        return {"items": [self._public(it) for it in rows[cursor:end]], "total": len(rows),
                "nextCursor": end if end < len(rows) else None, "generation": r["generation"]}

    def item(self, folder, id: str) -> dict:
        """One file's faces: who, how sure, where (bbox in the upright picture's pixels) and, in videos, when."""
        r = self._load(folder)
        it = r["by_id"].get(id)
        if it is None:
            raise MediaUnavailable("missing")
        self.lib.sync()
        out = {**self._public(it), "path": str(it["path"]), "width": None, "height": None,
               "detections": [{k: f.get(k) for k in ("person", "similarity", "bbox", "time_s") if k in f}
                              for f in it["faces"]]}
        if it["path"].suffix.lower() not in VIDEO_EXTS:
            try:
                media_stat(it["path"])  # never opens a cloud-only file (that would download it)
                with Image.open(it["path"]) as im:
                    w, h = im.size
                    if im.getexif().get(ORIENTATION) in (5, 6, 7, 8):
                        w, h = h, w
                out["width"], out["height"] = w, h
            except (MediaUnavailable, OSError, ValueError, Image.DecompressionBombError):
                pass
        return out

    # ---------- the people folder ----------

    def people(self, dir) -> dict:
        root = _folder(dir, self.lib.roots)
        people, problems = [], []
        for sub in sorted((p for p in root.iterdir() if p.is_dir() and not os.path.islink(p)), key=lambda p: p.name.casefold()):
            if len(people) >= MAX_PEOPLE:
                break
            images = sorted(p for p in sub.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS
                            and not os.path.islink(p))
            if not images:
                problems.append(f"{sub.name}: no photos")
                continue
            samples = [self.lib.public(self.lib.remember(p, 1)) for p in images[:SAMPLES] if self.lib.allowed(str(p))]
            people.append({"name": sub.name, "count": len(images), "samples": samples})
        return {"people": people, "problems": problems}

    # ---------- face workers ----------

    def workers(self) -> dict:
        configured = load_config(self.config_path).get("face_workers") or []
        return {"configured": [str(w) for w in configured], "effective": [str(w) for w in configured] or ["local"],
                "fixture": self.lib.roots is not None}

    def _check_local(self) -> dict:
        if self.lib.roots is not None:
            return {"state": "ready", "detail": "Fixture mode: the stand-in worker answers from the test pictures' "
                                                "colour codes (no model)."}
        missing = [m for m in ("insightface", "onnxruntime") if importlib.util.find_spec(m) is None]
        if missing:
            return {"state": "needs_setup", "detail": f"Missing Python packages: {', '.join(missing)}. "
                                                      "Install PhotoSort\\requirements-faces.txt."}
        pack = Path.home() / ".insightface" / "models" / "buffalo_l"
        if any(not (pack / f).is_file() for f in MODEL_FILES):
            return {"state": "needs_setup", "detail": "The buffalo_l model pack is not installed under "
                                                      "%USERPROFILE%\\.insightface\\models (see the README)."}
        return {"state": "ready", "detail": "InsightFace and the buffalo_l model are installed."}

    def _check_ssh(self, host: str) -> dict:
        if self.lib.roots is not None:
            return {"state": "skipped", "detail": "Fixture mode never contacts other machines."}
        try:
            ensure_lan_host(host)
        except FaceTaggingError as e:
            return {"state": "refused", "detail": str(e)[:300]}
        try:
            done = subprocess.run(["ssh", *SSH_OPTIONS, host, f"test -x {REMOTE_PYTHON}"], stdin=subprocess.DEVNULL,
                                  capture_output=True, text=True, timeout=CHECK_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError) as e:
            return {"state": "unreachable", "detail": f"SSH did not answer: {type(e).__name__}"}
        if done.returncode == 0:
            return {"state": "ready", "detail": "The worker environment is installed; the worker code is copied "
                                                "on each run."}
        if done.returncode == 1:
            return {"state": "needs_setup", "detail": "No worker environment yet: use Set up."}
        last = (done.stderr or "").strip().splitlines()[-1:] or [f"exit {done.returncode}"]
        return {"state": "unreachable", "detail": f"SSH failed: {last[0][:200]}"}

    def check_workers(self, workers=None) -> dict:
        specs = parse_workers(workers or self.workers()["effective"])
        with ThreadPoolExecutor(len(specs)) as ex:
            results = list(ex.map(lambda s: self._check_local() if s.is_local else self._check_ssh(s.host), specs))
        return {"workers": [{"host": s.host, "threads": s.threads, **r} for s, r in zip(specs, results)]}
