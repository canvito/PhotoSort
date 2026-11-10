"""PhotoSort: sort photos and screenshots into bucket folders with local vision LLMs.

Inference goes only to the NVIDIA PAIR Ollama proxy on this machine (loopback), which
load-balances requests across the LAN cluster. Images are never sent to cloud services or cloud models.
"""
from __future__ import annotations

import argparse
import base64
import io
import itertools
import json
import logging
import os
import shutil
import stat
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import requests
from PIL import Image, ImageOps

from face_tagger import FaceTaggingError, format_face_report, setup_remote_worker, tag_people
from local_only import LocalOnlyError, require_local_models, require_loopback
from photo_search import (PairSearchClient, SearchError, index_folder, index_path, search_index, settings,
                          update_index_paths)

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_EXTS = {".heic", ".heif"}
except ImportError:
    HEIF_EXTS = set()

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"} | HEIF_EXTS
JOURNAL_NAME = "_photosort_journal.jsonl"

log = logging.getLogger("photosort")


class ClassifyError(RuntimeError):
    pass


def load_config(path: Path) -> dict:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    require_loopback(cfg["base_url"])
    s = settings(cfg)
    require_local_models([cfg["model"], s["caption_model"], s["embed_model"]])
    if "other" not in cfg["buckets"]:
        raise ValueError("config buckets must include 'other'")
    return cfg


def encode_image(path: Path, max_side: int) -> str:
    """Downscale to max_side (EXIF-rotated, RGB JPEG) and return base64; the original file is untouched."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, "white")
            bg.paste(im, mask=im.getchannel("A"))
            im = bg
        else:
            im = im.convert("RGB")
        im.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def build_prompt(buckets: dict[str, str]) -> str:
    lines = "\n".join(f"- {name}: {desc}" for name, desc in buckets.items())
    return ("Sort this image from a personal camera roll into exactly one bucket. Buckets:\n"
            f"{lines}\nPick the single best bucket and a confidence from 0 to 1. Reply with JSON only.")


def parse_reply(content: str, buckets: dict[str, str]) -> tuple[str, float]:
    data = json.loads(content)
    bucket = data.get("bucket")
    if bucket not in buckets:
        raise ValueError(f"model returned unknown bucket {bucket!r}")
    return bucket, float(data.get("confidence") or 0.0)


class Classifier:
    """Thread-safe client for the local PAIR Ollama proxy."""

    def __init__(self, cfg: dict):
        require_loopback(cfg["base_url"])
        require_local_models([cfg["model"]])
        self.cfg = cfg
        self.url = cfg["base_url"].rstrip("/")
        self.buckets = cfg["buckets"]
        self.prompt = build_prompt(self.buckets)
        self.schema = {"type": "object", "required": ["bucket", "confidence"], "properties": {
            "bucket": {"type": "string", "enum": list(self.buckets)},
            "confidence": {"type": "number"}}}
        self._tls = threading.local()

    def _session(self) -> requests.Session:
        s = getattr(self._tls, "s", None)
        if s is None:
            s = requests.Session()
            s.trust_env = False  # never route through system/env HTTP proxies
            self._tls.s = s
        return s

    def preflight(self) -> list[str]:
        r = self._session().get(f"{self.url}/api/tags", timeout=30)
        r.raise_for_status()
        self.models = r.json().get("models", [])
        names = [m["name"] for m in self.models]
        if self.cfg["model"] not in names:
            raise ClassifyError(f"model {self.cfg['model']!r} is not available in the PAIR cluster")
        require_local_models([self.cfg["model"]], self.models)
        return names

    def classify(self, path: Path) -> tuple[str, float]:
        body = {
            "model": self.cfg["model"], "stream": False, "think": False, "format": self.schema,
            "keep_alive": "30m", "options": {"temperature": 0, "num_predict": 128, "num_ctx": 4096},
            "messages": [{"role": "user", "content": self.prompt,
                          "images": [encode_image(path, self.cfg["max_side"])]}],
        }
        err = "no attempts"
        for attempt in range(self.cfg["retries"]):
            try:
                r = self._session().post(f"{self.url}/api/chat", json=body, timeout=self.cfg["timeout_s"])
                r.raise_for_status()
                return parse_reply(r.json()["message"]["content"], self.buckets)
            except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log.debug("retry %d for %s: %s", attempt + 1, path.name, err)
                time.sleep(min(2 ** attempt, 10))
        raise ClassifyError(err)


def scan(source: Path, dest: Path, buckets, recursive: bool) -> tuple[list[Path], int]:
    """Return (images to sort, count of skipped non-image files). Files already in bucket folders are ignored."""
    bucket_dirs = {(dest / b).resolve() for b in buckets}
    images, skipped = [], 0
    for p in sorted(source.rglob("*") if recursive else source.iterdir()):
        if not p.is_file() or p.name == JOURNAL_NAME:
            continue
        if bucket_dirs.intersection(p.resolve().parents):
            continue
        if p.suffix.lower() in IMAGE_EXTS:
            images.append(p)
        else:
            skipped += 1
    return images, skipped


def unique_path(target: Path) -> Path:
    if not target.exists():
        return target
    for i in itertools.count(1):
        cand = target.with_name(f"{target.stem} ({i}){target.suffix}")
        if not cand.exists():
            return cand


def sort_folder(cfg: dict, source: Path, dest: Path | None = None, action: str = "move",
                recursive: bool = False, limit: int = 0, classifier=None) -> dict:
    started, t_start = datetime.now(), time.perf_counter()
    source = Path(source).resolve()
    dest = Path(dest).resolve() if dest else source
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    clf = classifier
    if clf is None:
        clf = Classifier(cfg)
        clf.preflight()
    images, skipped = scan(source, dest, cfg["buckets"], recursive)
    images = images[: limit or None]
    run_id = started.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    journal = dest / JOURNAL_NAME
    dest.mkdir(parents=True, exist_ok=True)
    counts, errors, moves = Counter(), 0, []
    log.info("run %s: %d images, %d non-image files left in place, action=%s, model=%s, workers=%d",
             run_id, len(images), skipped, action, cfg["model"], cfg["concurrency"])
    ex = ThreadPoolExecutor(max_workers=cfg["concurrency"], thread_name_prefix="photosort")
    with journal.open("a", encoding="utf-8") as jf:
        futures = {ex.submit(clf.classify, p): p for p in images}
        try:
            for n, fut in enumerate(as_completed(futures), 1):
                src = futures[fut]
                entry = {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id, "action": action,
                         "model": cfg["model"], "src": str(src), "dst": None}
                try:
                    bucket, conf = fut.result()
                    entry.update(bucket=bucket, confidence=round(conf, 3))
                    if action in ("move", "copy"):
                        target = unique_path(dest / bucket / src.name)
                        target.parent.mkdir(parents=True, exist_ok=True)
                        (shutil.move if action == "move" else shutil.copy2)(str(src), str(target))
                        entry["dst"] = str(target)
                        if action == "move":
                            moves.append((src, target))
                    counts[bucket] += 1
                    log.info("[%d/%d] %-26s %.2f  %s", n, len(images), bucket, conf, src.name)
                except Exception as e:  # leave the file where it is and keep going
                    errors += 1
                    entry["error"] = f"{type(e).__name__}: {str(e)[:200]}"
                    log.warning("[%d/%d] FAILED %s: %s", n, len(images), src.name, entry["error"])
                jf.write(json.dumps(entry) + "\n")
                jf.flush()
        except KeyboardInterrupt:
            log.warning("interrupted; finished files are journaled, the rest stay in place")
            raise
        finally:
            ex.shutdown(wait=False, cancel_futures=True)
            update_index_paths(index_path(cfg), moves)
    elapsed = time.perf_counter() - t_start
    n_sorted = sum(counts.values())
    summary = {"run_id": run_id, "action": action, "model": cfg["model"], "workers": cfg["concurrency"],
               "source": str(source), "dest": str(dest), "journal": str(journal),
               "sorted": n_sorted, "errors": errors, "skipped_non_images": skipped,
               "started_at": started.isoformat(timespec="seconds"),
               "finished_at": datetime.now().isoformat(timespec="seconds"),
               "elapsed_s": round(elapsed, 1),
               "per_min": round(n_sorted / elapsed * 60, 1) if elapsed else 0.0,
               "buckets": dict(counts.most_common())}
    log.debug("summary: %s", json.dumps(summary))
    return summary


def format_duration(seconds: float) -> str:
    if seconds < 59.95:
        return f"{seconds:.1f}s"
    hours, rest = divmod(int(round(seconds)), 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}h {minutes:02d}m {secs:02d}s" if hours else f"{minutes}m {secs:02d}s"


def format_report(s: dict) -> str:
    """Plain-ASCII finish report for a sort run (the dict returned by sort_folder)."""
    done = {"move": "moved", "copy": "copied"}.get(s["action"], "classified (no files changed)")
    rows = [("Run", s["run_id"]), ("Source", s["source"])]
    if s["dest"] != s["source"]:
        rows.append(("Destination", s["dest"]))
    rows += [
        ("Model", f"{s['model']}, {s['workers']} parallel workers"),
        ("Result", f"{s['sorted']} images {done}; {s['errors']} errors; "
                   f"{s['skipped_non_images']} non-image files left in place"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
        ("Speed", f"{s['per_min']} images/min"),
        ("Journal", s["journal"]),
    ]
    lines = ["", "=== PhotoSort finish report ==="] + [f"{k:<12}: {v}" for k, v in rows]
    if s["buckets"]:
        width = max(len(name) for name in s["buckets"])
        lines += ["", "Buckets"] + [f"  {name:<{width}}  {n:>4}" for name, n in s["buckets"].items()]
    return "\n".join(lines)


def format_index_report(s: dict) -> str:
    """Plain-ASCII finish report for an index run. Captions are never printed here."""
    rows = [
        ("Source", s["source"]),
        ("Models", f"{s['caption_model']} captions + {s['embed_model']} vectors, {s['workers']} parallel workers"),
        ("Result", f"{s['images']} images found: {s['captioned']} captioned, {s['reused']} reused (moved or "
                   f"duplicate), {s['unchanged']} unchanged; {s['errors']} errors"),
        ("Removed", f"{s['removed']} entries for files no longer in this folder"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
        ("Speed", f"{s['per_min']} images/min captioned"),
        ("Index", f"{s['index_path']} ({s['total_indexed']} photos total)"),
    ]
    return "\n".join(["", "=== PhotoSort index report ==="] + [f"{k:<12}: {v}" for k, v in rows])


def format_search_results(r: dict, paths_only: bool = False) -> str:
    if paths_only:
        return "\n".join(x["path"] for x in r["results"])
    lines = [f'Search: "{r["query"]}"  ({len(r["results"])} of {r["searched"]} indexed photos, '
             f'{format_duration(r["elapsed_s"])})']
    for n, x in enumerate(r["results"], 1):
        lines.append(f"{n:>3}. {x['score']:.3f}  {x['path']}{'' if x['exists'] else '  [missing on disk]'}")
        caption = " ".join(x["caption"].split())
        lines.append(f"     {caption[:157] + '...' if len(caption) > 160 else caption}")
    if not r["results"]:
        lines.append("No indexed photos match this folder; run `photosort index <folder>` first.")
    return "\n".join(lines)


def remove_empty_folder(folder: Path) -> None:
    """Delete a bucket folder once it is empty. OneDrive can mark synced folders read-only,
    which makes rmdir fail with 'Access is denied' on Windows, so clear that flag first."""
    try:
        if any(folder.iterdir()):
            return
        try:
            folder.rmdir()
        except PermissionError:
            os.chmod(folder, stat.S_IWRITE)
            folder.rmdir()
    except OSError:
        pass


def undo(journal: Path, run_id: str | None = None, index_db: Path | None = None) -> dict:
    """Move files from a sort run back to where they came from (default: latest run not yet undone)."""
    journal = Path(journal)
    entries = [json.loads(line) for line in journal.read_text(encoding="utf-8").splitlines() if line.strip()]
    undone = {e["run_id"] for e in entries if e.get("action") == "undo"}
    moves = [e for e in entries if e.get("action") == "move" and e.get("dst")]
    if run_id is None:
        pending = [e["run_id"] for e in moves if e["run_id"] not in undone]
        if not pending:
            raise ValueError("no move runs left to undo in this journal")
        run_id = pending[-1]
    restored, problems, back = 0, 0, []
    for e in reversed([e for e in moves if e["run_id"] == run_id]):
        src, dst = Path(e["src"]), Path(e["dst"])
        if not dst.exists() or src.exists():
            problems += 1
            log.warning("cannot restore %s (%s)", dst, "missing" if not dst.exists() else "original path occupied")
            continue
        src.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dst), str(src))
        restored += 1
        back.append((dst, src))
        remove_empty_folder(dst.parent)
    if index_db:
        update_index_paths(index_db, back)
    with journal.open("a", encoding="utf-8") as jf:
        jf.write(json.dumps({"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id,
                             "action": "undo", "restored": restored, "problems": problems}) + "\n")
    log.info("undo %s: restored %d, problems %d", run_id, restored, problems)
    return {"run_id": run_id, "restored": restored, "problems": problems}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="photosort", description=__doc__.splitlines()[0])
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="verify the local PAIR proxy and model are available")
    s = sub.add_parser("sort", help="classify images in a folder and sort them into bucket folders")
    s.add_argument("source", type=Path)
    s.add_argument("--dest", type=Path, help="where bucket folders are created (default: source)")
    s.add_argument("--action", choices=["move", "copy", "report"], help="default from config")
    s.add_argument("--recursive", action="store_true",
                   help="include subfolders; all their images go into the top-level buckets "
                        "(bucket folders there are skipped)")
    s.add_argument("--limit", type=int, default=0, help="only process the first N images")
    s.add_argument("--concurrency", type=int, help="parallel requests to the PAIR cluster")
    s.add_argument("--model", help="override the configured model")
    u = sub.add_parser("undo", help="move files from a sort run back to their original location")
    u.add_argument("journal", type=Path, help=f"path to {JOURNAL_NAME}")
    u.add_argument("--run-id", help="run to undo (default: latest run not yet undone)")
    f = sub.add_parser("faces", help="detect and locally tag faces using named reference-photo folders")
    f.add_argument("source", type=Path, help="folder of photos to analyze; originals are not modified")
    f.add_argument("--people", type=Path, required=True,
                   help="folder containing one subfolder per person, with clear reference photos")
    f.add_argument("--output", type=Path, help="JSON sidecar path (default: <source>\\photosort_faces.json)")
    f.add_argument("--model", choices=["buffalo_l"], default="buffalo_l")
    f.add_argument("--model-dir", type=Path, help="InsightFace root for a `local` worker (default: ~/.insightface)")
    f.add_argument("--workers", help="where detection runs: comma-separated HOST[:THREADS] SSH hosts and/or "
                                     "local[:THREADS] (default: face_workers in config.json)")
    f.add_argument("--threshold", type=float, default=0.45, help="minimum cosine similarity to assign a name")
    f.add_argument("--margin", type=float, default=0.05,
                   help="minimum lead over the second-best person; ambiguous matches remain unknown")
    f.add_argument("--recursive", action="store_true", help="include subfolders")
    f.add_argument("--limit", type=int, default=0, help="only process the first N images")
    fs = sub.add_parser("faces-setup", help="install the face worker environment and model on SSH hosts")
    fs.add_argument("hosts", nargs="+", help="SSH host aliases, e.g. spark1")
    fs.add_argument("--model", choices=["buffalo_l"], default="buffalo_l")
    i = sub.add_parser("index", help="caption and embed photos (always including subfolders) for search")
    i.add_argument("source", type=Path, help="folder to index; photos are only read, never modified")
    i.add_argument("--limit", type=int, default=0, help="only index the first N images")
    i.add_argument("--concurrency", type=int, help="parallel caption requests to the PAIR cluster")
    q = sub.add_parser("search", help="find indexed photos by describing them in plain language")
    q.add_argument("query", help='e.g. "receipt from the hardware store" or "kids at the beach"')
    q.add_argument("--folder", type=Path, help="only return photos under this folder")
    q.add_argument("--top", type=int, default=10, help="number of results (default 10)")
    q.add_argument("--paths-only", action="store_true", help="print only file paths, no captions")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(errors="replace")  # odd characters in a path must not crash a report
        if a.cmd == "undo":
            undo(a.journal, a.run_id, index_path(load_config(a.config)))
            return 0
        if a.cmd == "faces-setup":
            for host in a.hosts:
                info = setup_remote_worker(host, a.model)
                print(f"OK: {host} ({info.get('host')}) face worker ready: {info.get('provider')}", flush=True)
            return 0
        if a.cmd == "faces":
            workers = a.workers or load_config(a.config).get("face_workers") or ["local"]
            result = tag_people(a.source, a.people, a.output, IMAGE_EXTS, a.recursive, a.limit,
                                a.threshold, a.margin, a.model, a.model_dir, workers=workers)
            print(format_face_report(result), flush=True)
            return 1 if result["summary"]["errors"] else 0
        cfg = load_config(a.config)
        if a.cmd == "check":
            clf = Classifier(cfg)
            names = clf.preflight()
            s = settings(cfg)
            require_local_models([s["caption_model"], s["embed_model"]], clf.models)
            missing = [m for m in (s["caption_model"], s["embed_model"]) if m not in names]
            print(f"OK: {cfg['base_url']} reachable, {len(names)} models, '{cfg['model']}' available. "
                  f"HEIC support: {'yes' if HEIF_EXTS else 'no (pip install pillow-heif)'}. "
                  f"Search models: {'available' if not missing else 'MISSING ' + ', '.join(missing)}")
            return 0
        if a.cmd in ("index", "search"):
            client = PairSearchClient(cfg, encode_image)
            if a.cmd == "search":
                client.preflight([settings(cfg)["embed_model"]])
                print(format_search_results(search_index(cfg, a.query, client, a.folder, a.top), a.paths_only),
                      flush=True)
                return 0
            client.preflight()
            result = index_folder(cfg, a.source, client, IMAGE_EXTS, a.limit, a.concurrency)
            print(format_index_report(result), flush=True)
            return 1 if result["errors"] else 0
        if a.model:
            cfg["model"] = a.model
        if a.concurrency:
            cfg["concurrency"] = a.concurrency
        summary = sort_folder(cfg, a.source, a.dest, a.action or cfg["action"], a.recursive, a.limit)
        print(format_report(summary), flush=True)
        return 1 if summary["errors"] else 0
    except (LocalOnlyError, ClassifyError, FaceTaggingError, SearchError, FileNotFoundError,
            ValueError, requests.RequestException) as e:
        log.error("%s", e)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
