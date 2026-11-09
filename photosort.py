"""PhotoSort: sort photos and screenshots into bucket folders with local vision LLMs.

Inference goes only to the NVIDIA PAIR Ollama proxy on this machine (loopback), which
load-balances requests across the LAN cluster. Images are never sent to cloud services.
"""
from __future__ import annotations

import argparse
import base64
import io
import ipaddress
import itertools
import json
import logging
import shutil
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import requests
from PIL import Image, ImageOps

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


class LocalOnlyError(RuntimeError):
    pass


class ClassifyError(RuntimeError):
    pass


def require_loopback(url: str) -> None:
    """Refuse any endpoint that is not on this machine, so images cannot leave via a misconfiguration."""
    host = urlparse(url).hostname or ""
    if host == "localhost":
        return
    try:
        if ipaddress.ip_address(host).is_loopback:
            return
    except ValueError:
        pass
    raise LocalOnlyError(f"Refusing non-loopback endpoint {url!r}; PhotoSort only talks to the local PAIR proxy.")


def load_config(path: Path) -> dict:
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    require_loopback(cfg["base_url"])
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
        names = [m["name"] for m in r.json().get("models", [])]
        if self.cfg["model"] not in names:
            raise ClassifyError(f"model {self.cfg['model']!r} is not available in the PAIR cluster")
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
    run_id = datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    journal = dest / JOURNAL_NAME
    dest.mkdir(parents=True, exist_ok=True)
    counts, errors = Counter(), 0
    log.info("run %s: %d images, %d non-image files left in place, action=%s, model=%s, workers=%d",
             run_id, len(images), skipped, action, cfg["model"], cfg["concurrency"])
    t0 = time.perf_counter()
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
    elapsed = time.perf_counter() - t0
    summary = {"run_id": run_id, "journal": str(journal), "sorted": sum(counts.values()), "errors": errors,
               "skipped_non_images": skipped, "elapsed_s": round(elapsed, 1),
               "per_min": round(sum(counts.values()) / elapsed * 60, 1) if elapsed else 0.0,
               "buckets": dict(counts.most_common())}
    log.info("summary: %s", json.dumps(summary))
    return summary


def undo(journal: Path, run_id: str | None = None) -> dict:
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
    restored, problems = 0, 0
    for e in reversed([e for e in moves if e["run_id"] == run_id]):
        src, dst = Path(e["src"]), Path(e["dst"])
        if not dst.exists() or src.exists():
            problems += 1
            log.warning("cannot restore %s (%s)", dst, "missing" if not dst.exists() else "original path occupied")
            continue
        src.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dst), str(src))
        restored += 1
        try:
            dst.parent.rmdir()  # drop bucket folder once empty
        except OSError:
            pass
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
    s.add_argument("--recursive", action="store_true", help="include subfolders (bucket folders are skipped)")
    s.add_argument("--limit", type=int, default=0, help="only process the first N images")
    s.add_argument("--concurrency", type=int, help="parallel requests to the PAIR cluster")
    s.add_argument("--model", help="override the configured model")
    u = sub.add_parser("undo", help="move files from a sort run back to their original location")
    u.add_argument("journal", type=Path, help=f"path to {JOURNAL_NAME}")
    u.add_argument("--run-id", help="run to undo (default: latest run not yet undone)")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    try:
        if a.cmd == "undo":
            undo(a.journal, a.run_id)
            return 0
        cfg = load_config(a.config)
        if a.cmd == "check":
            names = Classifier(cfg).preflight()
            print(f"OK: {cfg['base_url']} reachable, {len(names)} models, '{cfg['model']}' available. "
                  f"HEIC support: {'yes' if HEIF_EXTS else 'no (pip install pillow-heif)'}")
            return 0
        if a.model:
            cfg["model"] = a.model
        if a.concurrency:
            cfg["concurrency"] = a.concurrency
        summary = sort_folder(cfg, a.source, a.dest, a.action or cfg["action"], a.recursive, a.limit)
        return 1 if summary["errors"] else 0
    except (LocalOnlyError, ClassifyError, FileNotFoundError, ValueError, requests.RequestException) as e:
        log.error("%s", e)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
