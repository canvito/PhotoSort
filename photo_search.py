"""Natural-language photo search built only on local models served by the NVIDIA PAIR Ollama proxy.

`index` captions every photo with a local vision model (in parallel across the PAIR nodes) and embeds the
caption and the visible text with a local embedding model. `search` embeds the query locally and ranks photos
by cosine similarity. The index lives in a local SQLite file outside OneDrive; photos are never modified.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Callable, Iterable

import numpy as np
import requests

import runctl
from local_only import require_local_models, require_loopback
from media import is_video, people_dirs, video_jpegs

log = logging.getLogger("photosort.search")

DEFAULT_INDEX = os.path.join("%LOCALAPPDATA%", "PhotoSort", "search_index.sqlite")
DEFAULTS = {"caption_model": "gemma4:12b", "embed_model": "qwen3-embedding:8b", "index_concurrency": 12}
PROMPT_VERSION = 1
VIDEO_PROMPT_VERSION = 1
TEXT_LIMIT = 300
PROMPT = ("Describe this image for a private photo search index. Reply with JSON only: "
          '{"caption": "2-3 factual sentences: subjects, actions, setting, notable colors/objects", '
          '"objects": ["key nouns"], "scene": "indoor/outdoor/screen + place type", '
          '"text": "important visible text verbatim, max 300 chars, empty if none", "people_count": 0}')
VIDEO_PROMPT = ("These are frames, in time order, from one video. Describe the whole video for a private search "
                'index. Reply with JSON only: {"caption": "2-3 factual sentences: subjects, what happens, setting, '
                'notable colors/objects", "objects": ["key nouns"], "scene": "indoor/outdoor/screen + place type", '
                '"text": "important visible text verbatim, max 300 chars, empty if none", '
                '"people_count": "most people visible in one frame"}')
SCHEMA = {"type": "object", "required": ["caption", "objects", "scene", "text", "people_count"],
          "properties": {"caption": {"type": "string"}, "objects": {"type": "array", "items": {"type": "string"}},
                         "scene": {"type": "string"}, "text": {"type": "string"},
                         "people_count": {"type": "integer"}}}
# Used only to redo a caption whose reply ran to the length limit: on some nodes gemma4 repeats a video's visible
# text without end. The cap makes it close the field at TEXT_LIMIT, where longer text is cut anyway; caption,
# objects and scene come first in the reply, so they are what the normal request gives. (A repeat penalty fixed it
# on only some nodes.) Normal captions are requested without the cap, so they stay exactly as before.
TEXT_CAPPED_SCHEMA = {**SCHEMA, "properties": {**SCHEMA["properties"],
                                               "text": {"type": "string", "maxLength": TEXT_LIMIT}}}
# qwen3-embedding is instruction-tuned: queries carry a task prefix, indexed documents do not.
QUERY_INSTRUCT = "Instruct: Given a photo search query, retrieve the description of the matching photo\nQuery: "

TABLE = """
CREATE TABLE IF NOT EXISTS photos (
    path TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    caption_model TEXT NOT NULL,
    embed_model TEXT NOT NULL,
    prompt_version INTEGER NOT NULL,
    caption TEXT NOT NULL,
    scene TEXT NOT NULL,
    objects TEXT NOT NULL,
    text TEXT NOT NULL,
    people_count INTEGER NOT NULL,
    vec_visual BLOB NOT NULL,
    vec_text BLOB,
    indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_sha256 ON photos(sha256);
"""
COLUMNS = ("path", "size", "mtime_ns", "sha256", "caption_model", "embed_model", "prompt_version", "caption",
           "scene", "objects", "text", "people_count", "vec_visual", "vec_text", "indexed_at")


class SearchError(RuntimeError):
    pass


class ReplyCutOff(ValueError):
    pass


def settings(cfg: dict) -> dict:
    s = {**DEFAULTS, **{k: cfg[k] for k in DEFAULTS if k in cfg}}
    s["index_path"] = index_path(cfg)
    return s


def index_path(cfg: dict) -> Path:
    return Path(os.path.expandvars(cfg.get("index_path") or DEFAULT_INDEX))


def normalize_caption(data: dict) -> dict:
    caption = str(data.get("caption") or "").strip()
    if not caption:
        raise ValueError("model returned an empty caption")
    objects = data.get("objects") or []
    if not isinstance(objects, list):
        objects = [objects]
    try:
        people = max(0, int(data.get("people_count") or 0))
    except (TypeError, ValueError):
        people = 0
    return {"caption": caption, "scene": str(data.get("scene") or "").strip(),
            "objects": [str(o).strip() for o in objects if str(o).strip()][:30],
            "text": str(data.get("text") or "").strip()[:TEXT_LIMIT], "people_count": people}


def visual_doc(c: dict, video: bool = False) -> str:
    return (f"{'Video: ' if video else ''}{c['caption']} Scene: {c['scene']}. Objects: {', '.join(c['objects'])}. "
            f"People: {c['people_count']}.")


def text_doc(c: dict) -> str | None:
    # Raw visible text as its own vector: a "Visible text:" label made any photo with a little text match
    # queries such as "text message conversation", and merging it into the caption let long screenshot
    # text drown out the description.
    return c["text"] or None


class PairSearchClient:
    """Thread-safe caption + embedding client for the local PAIR Ollama proxy."""

    def __init__(self, cfg: dict, encode_image: Callable[[Path, int], str]):
        require_loopback(cfg["base_url"])
        self.url = cfg["base_url"].rstrip("/")
        self.s = settings(cfg)
        require_local_models([self.s["caption_model"], self.s["embed_model"]])
        self.max_side, self.timeout, self.retries = cfg["max_side"], cfg["timeout_s"], cfg["retries"]
        self.encode_image = encode_image
        self._tls = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self._tls, "s", None)
        if s is None:
            s = requests.Session()
            s.trust_env = False  # never route through system/env HTTP proxies
            self._tls.s = s
        return s

    def preflight(self, models: list[str] | None = None) -> None:
        """Check that the models exist in the PAIR cluster and run on the user's machines, not in the cloud."""
        models = models or [self.s["caption_model"], self.s["embed_model"]]
        r = self._session().get(f"{self.url}/api/tags", timeout=30)
        r.raise_for_status()
        available = r.json().get("models", [])
        names = {m["name"] for m in available}
        missing = [m for m in models if m not in names]
        if missing:
            raise SearchError(f"model(s) not available in the PAIR cluster: {', '.join(missing)}")
        require_local_models(models, available)

    def _post(self, endpoint: str, body: dict, parse: Callable[[dict], object], if_cut_off: dict | None = None):
        """POST with retries. After a reply cut off at the length limit, the remaining attempts send `if_cut_off`
        instead, if given: at temperature 0 the same request would loop the same way again."""
        err = "no attempts"
        for attempt in range(self.retries):
            if runctl.cancelled():
                raise SearchError("cancelled")
            try:
                r = self._session().post(f"{self.url}{endpoint}", json=body, timeout=self.timeout)
                r.raise_for_status()
                return parse(r.json())
            except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log.debug("retry %d %s: %s", attempt + 1, endpoint, err)
                if isinstance(e, ReplyCutOff) and if_cut_off is not None:
                    body = if_cut_off
                    continue
                runctl.sleep(min(2 ** attempt, 10))
        raise SearchError(err)

    def caption(self, path: Path) -> dict:
        if is_video(path):
            images, prompt = video_jpegs(path, self.max_side), VIDEO_PROMPT
        else:
            images, prompt = [self.encode_image(path, self.max_side)], PROMPT
        body = {"model": self.s["caption_model"], "stream": False, "think": False, "format": SCHEMA,
                "keep_alive": "30m", "options": {"temperature": 0, "num_predict": 1024, "num_ctx": 4096},
                "messages": [{"role": "user", "content": prompt, "images": images}]}

        def parse(j):
            if j.get("done_reason") == "length":
                raise ReplyCutOff("caption reply hit the length limit (the model repeated itself)")
            return normalize_caption(json.loads(j["message"]["content"]))

        return self._post("/api/chat", body, parse, if_cut_off={**body, "format": TEXT_CAPPED_SCHEMA})

    def embed(self, texts: list[str], query: bool = False) -> np.ndarray:
        inputs = [QUERY_INSTRUCT + t for t in texts] if query else list(texts)
        body = {"model": self.s["embed_model"], "input": inputs, "keep_alive": "30m", "truncate": True}

        def parse(j):
            v = np.asarray(j["embeddings"], dtype=np.float32)
            if v.ndim != 2 or len(v) != len(texts):
                raise ValueError("unexpected embedding response shape")
            return v

        return unit_rows(self._post("/api/embed", body, parse))


def unit_rows(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float32)
    return v / np.maximum(np.linalg.norm(v, axis=1, keepdims=True), 1e-12)


def to_blob(v: np.ndarray) -> bytes:
    return np.asarray(v, dtype=np.float16).tobytes()


def from_blobs(blobs: list[bytes]) -> np.ndarray:
    return np.frombuffer(b"".join(blobs), dtype=np.float16).reshape(len(blobs), -1).astype(np.float32)


def score_vectors(visual: np.ndarray, text: np.ndarray | None, with_text, q: np.ndarray) -> np.ndarray:
    """Shared by the streaming CLI and the dashboard's cached vectors; never renormalize stored float16s."""
    score = visual @ q
    if text is not None and len(with_text):
        score[with_text] = np.maximum(score[with_text], text @ q)
    return score


def ranked_indices(scores: np.ndarray, top: int) -> np.ndarray:
    return np.argsort(-scores, kind="stable")[:top]


def open_index(path: Path, create: bool = True) -> sqlite3.Connection:
    path = Path(path)
    if not create and not path.exists():
        raise SearchError(f"no search index at {path}; run `photosort index <folder>` first")
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=60)
    db.executescript(TABLE)
    return db


def _folder_key(folder: Path) -> str:
    return os.path.normcase(str(Path(folder).resolve())).rstrip("\\/") + os.sep


def _is_under(path: str, key: str) -> bool:
    return os.path.normcase(path).startswith(key)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _try_sha256(path: Path) -> str | None:
    try:
        return sha256_file(path)
    except OSError as e:
        log.warning("cannot read %s: %s", path.name, e)
        return None


def prompt_version(path: Path) -> int:
    return VIDEO_PROMPT_VERSION if is_video(path) else PROMPT_VERSION


def _analyze(client, path: Path) -> dict:
    c = client.caption(path)
    docs = [visual_doc(c, is_video(path))] + ([text_doc(c)] if c["text"] else [])
    vecs = client.embed(docs)
    return {**c, "vec_visual": to_blob(vecs[0]), "vec_text": to_blob(vecs[1]) if len(vecs) > 1 else None}


def index_folder(cfg: dict, source: Path, client, image_exts: Iterable[str], limit: int = 0,
                 concurrency: int | None = None) -> dict:
    """Caption + embed every photo and video under source (recursively). Unchanged files are skipped and moved or
    duplicated files are matched by SHA-256, so re-running only sends new files to the cluster."""
    started, t_start = datetime.now(), time.perf_counter()
    s = settings(cfg)
    workers = concurrency or s["index_concurrency"]
    source = Path(source).resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    exts = {e.lower() for e in image_exts}
    runctl.emit("phase", name="scan")
    listing = sorted(source.rglob("*"))
    files = [p for p in listing if p.is_file() and p.suffix.lower() in exts]
    crops = people_dirs(listing)  # folders of face crops (faces-discover) are not part of the library
    if crops:
        files = [p for p in files if not crops.intersection(p.resolve().parents)]
    current = {str(p) for p in files}
    current_nc = {os.path.normcase(p) for p in current}
    files = files[: limit or None]
    models = (s["caption_model"], s["embed_model"])
    db = open_index(s["index_path"])
    key = _folder_key(source)
    known = {row[0]: row[1:] for row in db.execute(
        "SELECT path, size, mtime_ns, caption_model, embed_model, prompt_version FROM photos")
        if _is_under(row[0], key)}
    todo, unchanged = [], 0
    for p in files:
        st = p.stat()
        if known.get(str(p)) == (st.st_size, st.st_mtime_ns, *models, prompt_version(p)):
            unchanged += 1
        else:
            todo.append((p, st))
    log.info("index %s: %d files, %d unchanged, %d to check; captions=%s embeddings=%s workers=%d",
             source, len(files), unchanged, len(todo), s["caption_model"], s["embed_model"], workers)

    counts = {"captioned": 0, "reused": 0, "errors": 0}

    def store(path: Path, st, sha: str, fields: dict) -> None:
        row = {"path": str(path), "size": st.st_size, "mtime_ns": st.st_mtime_ns, "sha256": sha,
               "caption_model": s["caption_model"], "embed_model": s["embed_model"],
               "prompt_version": prompt_version(path), "objects": json.dumps(fields["objects"]),
               "indexed_at": datetime.now().isoformat(timespec="seconds"),
               **{k: fields[k] for k in ("caption", "scene", "text", "people_count", "vec_visual", "vec_text")}}
        db.execute(f"INSERT OR REPLACE INTO photos ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})",
                   [row[c] for c in COLUMNS])

    ex = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="photoindex")
    try:
        runctl.emit("phase", name="hash", total=len(todo), files=len(files), unchanged=unchanged)
        hashes = {}
        for (p, _), sha in zip(todo, ex.map(lambda t: _try_sha256(t[0]), todo)):
            runctl.checkpoint()
            hashes[p] = sha
        pending = []
        for p, st in todo:
            if hashes[p] is None:
                counts["errors"] += 1
                runctl.emit("item", phase="hash", path=str(p), error="cannot read the file")
                continue
            match = db.execute(
                "SELECT caption, scene, objects, text, people_count, vec_visual, vec_text FROM photos "
                "WHERE sha256 = ? AND caption_model = ? AND embed_model = ? AND prompt_version = ? LIMIT 1",
                (hashes[p], *models, prompt_version(p))).fetchone()
            if match:  # same bytes already indexed (moved, renamed or duplicated): no model call needed
                fields = dict(zip(("caption", "scene", "objects", "text", "people_count", "vec_visual",
                                   "vec_text"), match))
                fields["objects"] = json.loads(fields["objects"])
                store(p, st, hashes[p], fields)
                counts["reused"] += 1
            else:
                pending.append((p, st))
        db.commit()
        runctl.emit("phase", name="caption", total=len(pending), reused=counts["reused"])
        futures = {ex.submit(_analyze, client, p): (p, st) for p, st in pending}
        for n, fut in enumerate(runctl.completed(futures), 1):
            runctl.checkpoint()
            p, st = futures[fut]
            try:
                store(p, st, hashes[p], fut.result())
                counts["captioned"] += 1
                log.info("[%d/%d] indexed %s", n, len(pending), p.name)
                runctl.emit("item", phase="caption", n=n, total=len(pending), path=str(p),
                            result={"status": "captioned"})
            except Exception as e:  # keep going; the photo is retried on the next index run
                counts["errors"] += 1
                log.warning("[%d/%d] FAILED %s: %s: %s", n, len(pending), p.name, type(e).__name__, str(e)[:200])
                runctl.emit("item", phase="caption", n=n, total=len(pending), path=str(p),
                            error=f"{type(e).__name__}: {str(e)[:200]}")
            if n % 10 == 0:
                db.commit()
        db.commit()
        # A case-only rename still "exists" on Windows, so compare against the scan as well.
        stale = [path for path in known if path not in current
                 and (os.path.normcase(path) in current_nc or not Path(path).exists())]
        db.executemany("DELETE FROM photos WHERE path = ?", [(path,) for path in stale])
        db.commit()
        total = db.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    except KeyboardInterrupt:
        db.commit()
        log.warning("interrupted; photos indexed so far are saved, re-run to continue")
        raise
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
        db.close()
    elapsed = time.perf_counter() - t_start
    return {"source": str(source), "index_path": str(s["index_path"]), "caption_model": s["caption_model"],
            "embed_model": s["embed_model"], "workers": workers, "images": len(files),
            "videos": sum(map(is_video, files)), "unchanged": unchanged,
            **counts, "removed": len(stale), "total_indexed": total,
            "started_at": started.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"), "elapsed_s": round(elapsed, 1),
            "per_min": round(counts["captioned"] / elapsed * 60, 1) if elapsed else 0.0}


def search_index(cfg: dict, query: str, client, folder: Path | None = None, top: int = 10) -> dict:
    """Rank indexed photos for a plain-language query. Score = max(caption similarity, visible-text similarity)."""
    t_start = time.perf_counter()
    if not query.strip():
        raise ValueError("search query is empty")
    s = settings(cfg)
    db = open_index(s["index_path"], create=False)
    key = _folder_key(folder) if folder else None
    q = client.embed([query], query=True)[0]
    paths, scores, other_model, searched = [], [], 0, 0
    try:
        cur = db.execute("SELECT path, embed_model, vec_visual, vec_text, caption FROM photos")
        while rows := cur.fetchmany(2048):
            if key:
                rows = [r for r in rows if _is_under(r[0], key)]
            ok = [r for r in rows if r[1] == s["embed_model"] and len(r[2]) == q.size * 2]
            other_model += len(rows) - len(ok)
            if not ok:
                continue
            searched += len(ok)
            with_text = [i for i, r in enumerate(ok) if r[3]]
            score = score_vectors(from_blobs([r[2] for r in ok]),
                                  from_blobs([ok[i][3] for i in with_text]) if with_text else None, with_text, q)
            paths += [(r[0], r[4]) for r in ok]
            scores.append(score)
    finally:
        db.close()
    if other_model:
        log.warning("%d indexed photos use a different embedding model; re-run `index` on their folders",
                    other_model)
    results = []
    if scores:
        flat = np.concatenate(scores)
        for i in ranked_indices(flat, top):
            path, caption = paths[i]
            results.append({"path": path, "score": round(float(flat[i]), 3), "exists": Path(path).exists(),
                            "caption": caption})
    return {"query": query, "results": results, "searched": searched, "skipped_other_model": other_model,
            "index_path": str(s["index_path"]), "elapsed_s": round(time.perf_counter() - t_start, 2)}


def update_index_paths(db_path: Path, moves: list[tuple[Path, Path]]) -> None:
    """Keep the index in step when sort/undo moves photos, so search results point at the new location."""
    if not moves or not Path(db_path).exists():
        return
    try:
        db = sqlite3.connect(db_path, timeout=60)
        try:
            with db:
                for src, dst in moves:
                    # Keep the indexed size/mtime: a move preserves them, and a photo edited since it was
                    # indexed must still look changed to the next `index` run.
                    db.execute("DELETE FROM photos WHERE path = ?", (str(dst),))
                    db.execute("UPDATE photos SET path = ? WHERE path = ?", (str(dst), str(src)))
        finally:
            db.close()
    except sqlite3.Error as e:
        log.warning("could not update the search index (re-run `index` to refresh it): %s", e)
