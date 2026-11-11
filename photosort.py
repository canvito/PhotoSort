"""PhotoSort: sort photos, screenshots and videos into bucket folders with local vision LLMs.

Inference goes only to the NVIDIA PAIR Ollama proxy on this machine (loopback), which
load-balances requests across the LAN cluster. Images are never sent to cloud services or cloud models.
"""
from __future__ import annotations

import argparse
import itertools
import json
import logging
import os
import re
import shutil
import stat
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path

import requests
from PIL import Image, ImageOps

import group
import runctl
from face_tagger import FaceTaggingError, format_face_report, parse_workers, setup_remote_worker, tag_people
from index_transfer import export_index, format_export_report, format_import_report, import_index
from local_only import LocalOnlyError, require_local_models, require_loopback, under_onedrive
from media import VIDEO_EXTS, VideoError, encode_pil, is_video, video_jpegs
from photo_search import (PairSearchClient, SearchError, index_folder, index_path, search_index, settings,
                          sha256_file, update_index_paths)
from runctl import LockError

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    HEIF_EXTS = {".heic", ".heif"}
except ImportError:
    HEIF_EXTS = set()

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "config.json"
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"} | HEIF_EXTS
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS
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


BUCKET_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,47}$")
RESERVED_NAMES = {"con", "prn", "aux", "nul"} | {f"{p}{i}" for p in ("com", "lpt") for i in range(1, 10)}
CONFIG_INTS = {"concurrency": (1, 64), "index_concurrency": (1, 64), "max_side": (256, 4096), "retries": (1, 10)}


def config_problems(cfg) -> dict:
    """Why a config cannot be saved (`errors`) and what deserves a second look (`warnings`). Stricter than
    load_config, which keeps accepting older hand-edited files: the dashboard's Settings page saves only clean ones."""
    if not isinstance(cfg, dict):
        return {"errors": ["The config must be a JSON object."], "warnings": []}
    errors, warnings = [], []
    try:
        require_loopback(str(cfg.get("base_url") or ""))
    except LocalOnlyError as e:
        errors.append(str(e))
    for key in ("model", "caption_model", "embed_model"):
        name = cfg.get(key)
        if name is None and key != "model":
            continue
        if not isinstance(name, str) or not name.strip():
            errors.append(f"{key} must be a model name.")
            continue
        try:
            require_local_models([name])
        except LocalOnlyError as e:
            errors.append(str(e))
    for key, (lo, hi) in CONFIG_INTS.items():
        value = cfg.get(key)
        if value is None and key == "index_concurrency":
            continue
        if type(value) is not int or not lo <= value <= hi:
            errors.append(f"{key} must be a whole number from {lo} to {hi}.")
    timeout = cfg.get("timeout_s")
    if type(timeout) not in (int, float) or not 5 <= timeout <= 3600:
        errors.append("timeout_s must be a number of seconds from 5 to 3600.")
    if cfg.get("action") not in ("move", "copy"):
        errors.append("action must be move or copy.")
    workers = cfg.get("face_workers", [])
    if not isinstance(workers, list) or not all(isinstance(w, str) for w in workers):
        errors.append("face_workers must be a list such as [\"gpu-box:16\"].")
    elif workers:
        try:
            parse_workers(workers)
        except ValueError as e:
            errors.append(str(e))
    raw_index = cfg.get("index_path")
    if raw_index is not None:
        if not isinstance(raw_index, str) or not raw_index.strip():
            errors.append("index_path must be a file path (or left out for the default).")
        else:
            p = index_path(cfg)
            if "%" in str(p) or not p.is_absolute():
                errors.append("index_path must be a full path; %VARIABLES% must exist.")
            elif str(p).startswith("\\\\"):
                errors.append("index_path must be on a local drive, not a network share.")
            elif under_onedrive(p):
                errors.append("index_path is inside OneDrive, which would upload the index (captions, visible text "
                              "and embeddings of your photos) to the cloud.")
            elif not p.parent.is_dir():
                warnings.append("index_path's folder does not exist yet; the first index run creates it.")
    buckets = cfg.get("buckets")
    if not isinstance(buckets, dict) or not buckets:
        errors.append("buckets must list at least one bucket besides 'other'.")
        return {"errors": errors, "warnings": warnings}
    if "other" not in buckets:
        errors.append("buckets must include 'other'.")
    if len(buckets) < 2:
        errors.append("Add at least one bucket besides 'other'.")
    if len(buckets) > 60:
        errors.append("Use at most 60 buckets.")
    for name, desc in buckets.items():
        if name in RESERVED_NAMES:
            errors.append(f"Bucket name {name!r} is reserved by Windows and cannot be a folder name.")
        elif not BUCKET_NAME_RE.match(name):
            errors.append(f"Bucket name {name!r}: use lowercase letters, digits, _ and - (it becomes a folder name).")
        if not isinstance(desc, str) or not desc.strip():
            errors.append(f"Bucket {name!r} needs a description: the model sorts by it.")
        elif len(desc) > 500:
            errors.append(f"Bucket {name!r}: keep the description under 500 characters.")
    return {"errors": errors, "warnings": warnings}


def encode_image(path: Path, max_side: int) -> str:
    """Downscale to max_side (EXIF-rotated, RGB JPEG) and return base64; the original file is untouched."""
    with Image.open(path) as im:
        return encode_pil(ImageOps.exif_transpose(im), max_side)


def build_prompt(buckets: dict[str, str], frames: int = 0) -> str:
    lines = "\n".join(f"- {name}: {desc}" for name, desc in buckets.items())
    subject = (f"Here are {frames} frame{'s' if frames > 1 else ''}, in time order, from one video in a personal "
               "camera roll. Sort the whole video" if frames else "Sort this image from a personal camera roll")
    return (f"{subject} into exactly one bucket. Buckets:\n"
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

    def media_images(self, path: Path) -> tuple[list[str], int]:
        """(base64 JPEGs for the model, number of video frames; 0 for a photo)."""
        if is_video(path):
            images = video_jpegs(path, self.cfg["max_side"])
            return images, len(images)
        return [encode_image(path, self.cfg["max_side"])], 0

    def chat(self, prompt: str, images: list[str], schema: dict, parse, num_predict: int = 128, label: str = ""):
        """One JSON-schema chat request to the local PAIR proxy, with retries; returns parse(reply text)."""
        message = {"role": "user", "content": prompt, **({"images": images} if images else {})}
        body = {
            "model": self.cfg["model"], "stream": False, "think": False, "format": schema,
            "keep_alive": "30m", "options": {"temperature": 0, "num_predict": num_predict, "num_ctx": 4096},
            "messages": [message],
        }
        err = "no attempts"
        for attempt in range(self.cfg["retries"]):
            if runctl.cancelled():
                raise ClassifyError("cancelled")
            try:
                r = self._session().post(f"{self.url}/api/chat", json=body, timeout=self.cfg["timeout_s"])
                r.raise_for_status()
                return parse(r.json()["message"]["content"])
            except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log.debug("retry %d for %s: %s", attempt + 1, label, err)
                runctl.sleep(min(2 ** attempt, 10))
        raise ClassifyError(err)

    def classify(self, path: Path) -> tuple[str, float]:
        images, frames = self.media_images(path)
        prompt = build_prompt(self.buckets, frames) if frames else self.prompt
        return self.chat(prompt, images, self.schema, lambda c: parse_reply(c, self.buckets), label=path.name)

    def matches(self, path: Path, topic: str) -> tuple[bool, float]:
        """Does this photo or video show `topic`? (group) Asked in each of group.MATCH_WORDINGS until one says yes;
        the file is decoded and encoded once."""
        images, frames = self.media_images(path)
        for wording in group.MATCH_WORDINGS:
            found, confidence = self.chat(group.match_prompt(topic, frames, wording), images, group.MATCH_SCHEMA,
                                          group.parse_match, label=path.name)
            if found:
                break
        return found, confidence

    def same_event(self, path: Path, topic: str) -> tuple[bool, float]:
        """Was this file, taken near files that show `topic`, taken at that same occasion? (group)"""
        images, frames = self.media_images(path)
        return self.chat(group.same_event_prompt(topic, frames), images, group.MATCH_SCHEMA, group.parse_match,
                         label=path.name)

    def read_request(self, request: str, today: date) -> dict:
        """The user's group request (text only, no photo) as topic, media and dates."""
        return self.chat(group.request_prompt(request, today), [], group.REQUEST_SCHEMA,
                         lambda c: group.parse_request_reply(c, today), num_predict=256, label="request")


def scan(source: Path, dest: Path, buckets, recursive: bool) -> tuple[list[Path], int]:
    """Return (photos and videos to sort, count of other files). Files already in bucket folders, and everything
    in group folders, are ignored."""
    skip_dirs = {(dest / b).resolve() for b in buckets} | (group.group_dirs(source) if recursive else set())
    images, skipped = [], 0
    for p in sorted(source.rglob("*") if recursive else source.iterdir()):
        if not p.is_file() or p.name in (JOURNAL_NAME, group.GROUP_MARKER):
            continue
        if skip_dirs.intersection(p.resolve().parents):
            continue
        if p.suffix.lower() in MEDIA_EXTS:
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


def fingerprint(path: Path) -> dict:
    """What a preview records about a file, so applying it later can tell the file has not changed."""
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns, "sha256": sha256_file(path)}


def _try_fingerprint(path: Path) -> dict | None:
    try:
        return fingerprint(path)
    except OSError as e:
        log.warning("cannot read %s: %s", path.name, e)
        return None


def _classify(clf, path: Path, with_fingerprint: bool):
    fp = fingerprint(path) if with_fingerprint else None
    bucket, conf = clf.classify(path)
    return bucket, conf, fp


def _journal(jf, entry: dict) -> None:
    jf.write(json.dumps(entry) + "\n")
    jf.flush()


def sort_folder(cfg: dict, source: Path, dest: Path | None = None, action: str = "move",
                recursive: bool = False, limit: int = 0, classifier=None) -> dict:
    started, t_start = datetime.now(), time.perf_counter()
    source = Path(source).resolve()
    dest = Path(dest).resolve() if dest else source
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    clf = classifier
    if clf is None:
        runctl.emit("phase", name="preflight")
        clf = Classifier(cfg)
        clf.preflight()
    runctl.emit("phase", name="scan")
    images, skipped = scan(source, dest, cfg["buckets"], recursive)
    images = images[: limit or None]
    run_id = started.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    journal = dest / JOURNAL_NAME
    dest.mkdir(parents=True, exist_ok=True)
    counts, errors, moves, videos = Counter(), 0, [], 0
    log.info("run %s: %d files (%d videos), %d other files left in place, action=%s, model=%s, workers=%d",
             run_id, len(images), sum(map(is_video, images)), skipped, action, cfg["model"], cfg["concurrency"])
    runctl.emit("phase", name="sort", total=len(images), run_id=run_id, journal=str(journal), action=action,
                other_files=skipped)
    ex = ThreadPoolExecutor(max_workers=cfg["concurrency"], thread_name_prefix="photosort")
    with journal.open("a", encoding="utf-8") as jf:
        futures = {ex.submit(_classify, clf, p, action == "report"): p for p in images}
        try:
            for n, fut in enumerate(runctl.completed(futures), 1):
                runctl.checkpoint()
                src = futures[fut]
                entry = {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id, "action": action,
                         "model": cfg["model"], "src": str(src), "dst": None}
                conf = None
                with runctl.no_interrupt():  # the move and its journal line happen together
                    try:
                        bucket, conf, fp = fut.result()
                        entry.update(bucket=bucket, confidence=round(conf, 3))
                        if fp:
                            entry["fp"] = fp
                        if action in ("move", "copy"):
                            target = unique_path(dest / bucket / src.name)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            (shutil.move if action == "move" else shutil.copy2)(str(src), str(target))
                            entry["dst"] = str(target)
                            if action == "move":
                                moves.append((src, target))
                        counts[bucket] += 1
                        videos += is_video(src)
                    except Exception as e:  # leave the file where it is and keep going
                        errors += 1
                        entry["error"] = f"{type(e).__name__}: {str(e)[:200]}"
                    _journal(jf, entry)
                if "error" in entry:
                    log.warning("[%d/%d] FAILED %s: %s", n, len(images), src.name, entry["error"])
                    runctl.emit("item", phase="sort", n=n, total=len(images), path=str(src), error=entry["error"])
                else:
                    log.info("[%d/%d] %-26s %.2f  %s", n, len(images), entry["bucket"], conf, src.name)
                    runctl.emit("item", phase="sort", n=n, total=len(images), path=str(src),
                                result={"bucket": entry["bucket"], "confidence": entry["confidence"],
                                        "dst": entry["dst"]})
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
               "sorted": n_sorted, "videos": videos, "errors": errors, "skipped_non_images": skipped,
               "started_at": started.isoformat(timespec="seconds"),
               "finished_at": datetime.now().isoformat(timespec="seconds"),
               "elapsed_s": round(elapsed, 1),
               "per_min": round(n_sorted / elapsed * 60, 1) if elapsed else 0.0,
               "buckets": dict(counts.most_common())}
    log.debug("summary: %s", json.dumps(summary))
    return summary


def understand_request(clf, request: str, today: date, overrides: dict | None = None) -> dict:
    """Read the request UNDERSTAND_VOTES times in parallel (the PAIR proxy spreads them over the nodes) and
    return the plan they agree on."""
    if not request.strip():
        raise group.GroupError("the request is empty")
    ex = ThreadPoolExecutor(max_workers=group.UNDERSTAND_VOTES, thread_name_prefix="request")
    try:
        futures = [ex.submit(clf.read_request, request, today) for _ in range(group.UNDERSTAND_VOTES)]
        for _ in runctl.completed(futures):
            pass
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    readings, failures = [], []
    for fut in futures:
        try:
            readings.append(fut.result())
        except ClassifyError as e:
            failures.append(str(e))
    if len(readings) < 2:
        raise ClassifyError(f"the request could not be read: {'; '.join(failures) or 'no readings'}")
    return group.plan_request(readings, request, today, overrides)


def _capture_times(paths: list[Path], span=None) -> dict[Path, tuple[datetime | None, str]]:
    """Capture time of each file, read in parallel (metadata only, nothing is decoded); files whose OneDrive name
    is days away from the span are not opened."""
    out, todo = {}, []
    for p in paths:
        if span and group.far_by_name(p.name, span):
            out[p] = (None, "far by file name")
        else:
            todo.append(p)
    ex = ThreadPoolExecutor(max_workers=min(16, (os.cpu_count() or 4) * 2), thread_name_prefix="dates")
    try:
        for p, found in zip(todo, ex.map(lambda q: group.capture_time(q, is_video(q)), todo)):
            runctl.checkpoint()
            out[p] = found
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    return out


def _check_files(ask, paths: list[Path], topic: str, workers: int, label: str, phase: str = "check"
                 ) -> dict[Path, tuple]:
    """Ask the model about each file in parallel: {path: (match, confidence, error)}. Nothing is moved here."""
    out = {}
    runctl.emit("phase", name=phase, total=len(paths))
    ex = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="group")
    futures = {ex.submit(ask, p, topic): p for p in paths}
    try:
        for n, fut in enumerate(runctl.completed(futures), 1):
            runctl.checkpoint()
            src = futures[fut]
            try:
                is_match, conf = fut.result()
                out[src] = (is_match, conf, None)
                log.info("[%s %d/%d] %-5s %s  %s", label, n, len(paths), "MATCH" if is_match else "no",
                         "" if conf is None else f"{conf:.2f}", src.name)
                runctl.emit("item", phase=phase, n=n, total=len(paths), path=str(src),
                            result={"match": is_match, "confidence": None if conf is None else round(conf, 3)})
            except Exception as e:  # leave the file where it is and keep going
                out[src] = (False, None, f"{type(e).__name__}: {str(e)[:200]}")
                log.warning("[%s %d/%d] FAILED %s: %s", label, n, len(paths), src.name, out[src][2])
                runctl.emit("item", phase=phase, n=n, total=len(paths), path=str(src), error=out[src][2])
    except KeyboardInterrupt:
        log.warning("interrupted while checking; no files were moved")
        raise
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    return out


def group_folder(cfg: dict, source: Path, request: str, action: str = "move", name: str | None = None,
                 overrides: dict | None = None, limit: int = 0, classifier=None, today: date | None = None) -> dict:
    """Move (or copy, or only report) the photos and videos under `source` that match a plain-language request
    into one group folder in `source`. Everything else stays where it is.

    Every file in range is checked first; then files with no match taken within group.EVENT_NEAR of a match (or of
    a file already in the group folder) are asked whether they are from that same occasion; then files move."""
    started, t_start = datetime.now(), time.perf_counter()
    source = Path(source).resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    today = today or date.today()
    clf = classifier
    if clf is None:
        runctl.emit("phase", name="preflight")
        clf = Classifier(cfg)
        clf.preflight()
    runctl.emit("phase", name="understand")
    plan = understand_request(clf, request, today, overrides)
    title = group.folder_name(plan, name, cfg["buckets"])
    target = source / title
    if target.exists() and not (target / group.GROUP_MARKER).exists():
        target = unique_path(target)  # never pour files into a folder of the user's own
    runctl.emit("understood", topic=plan["topic"], media=plan["media"], dates=group.dates_text(plan),
                people_ignored=plan["people"], group=str(target))
    runctl.emit("phase", name="scan")
    held = [p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in MEDIA_EXTS] \
        if target.is_dir() else []
    files, skipped = scan(source, source, {}, recursive=True)
    wanted = {"photos": lambda p: not is_video(p), "videos": is_video, "both": lambda p: True}[plan["media"]]
    files = [p for p in files if wanted(p)]
    span = group.window(plan)
    if span:
        runctl.emit("phase", name="dates", total=len(files))
    times = _capture_times(files, span) if span else {}
    in_range, other_dates, no_date = [], 0, 0
    for p in files:
        taken, _ = times.get(p, (None, "not needed"))
        if span is None or (taken and span[0] <= taken < span[1]):
            in_range.append(p)
        elif taken or times[p][1] == "far by file name":
            other_dates += 1
        else:
            no_date += 1
    in_range = in_range[: limit or None]
    run_id = started.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    journal = source / JOURNAL_NAME
    log.info("run %s: %d files, %d in range (%s), topic=%r, action=%s, model=%s, workers=%d", run_id, len(files),
             len(in_range), group.dates_text(plan), plan["topic"], action, cfg["model"], cfg["concurrency"])
    near = []
    if plan["topic"]:
        if span is None:  # dates were not needed to pick the files, but the same-occasion check needs them
            times = _capture_times(in_range)
        results = {p: r + ("topic",) for p, r in
                   _check_files(clf.matches, in_range, plan["topic"], cfg["concurrency"], "check").items()}
        anchors = [times[p][0] for p, r in results.items() if r[0] and times.get(p, (None,))[0]]
        anchors += [t for t, _ in _capture_times(held).values() if t]
        near = [p for p in in_range
                if not results[p][0] and not results[p][2] and group.near_matches(times.get(p, (None,))[0], anchors)]
        if near:
            log.info("%d files with no match were taken within %d minutes of a match; asking if they are from the "
                     "same occasion", len(near), group.EVENT_NEAR.total_seconds() // 60)
            for p, r in _check_files(clf.same_event, near, plan["topic"], cfg["concurrency"], "same event",
                                     "same_event").items():
                results[p] = r + ("same event",) if r[2] is None else (False, results[p][1], f"same event: {r[2]}",
                                                                       "topic")
    else:  # dates only: every file in range belongs to the group
        results = {p: (True, None, None, "dates") for p in in_range}
    fps = {}
    if action == "report":  # a preview records each match's fingerprint, so `apply` can move exactly these files
        matched = [p for p in in_range if results[p][0] and not results[p][2]]
        ex = ThreadPoolExecutor(max_workers=8, thread_name_prefix="fingerprint")
        try:
            for p, fp in zip(matched, ex.map(_try_fingerprint, matched)):
                runctl.checkpoint()
                fps[p] = fp
        finally:
            ex.shutdown(wait=False, cancel_futures=True)
    plan_info = {"topic": plan["topic"], "media": plan["media"],
                 "date_from": plan["date_from"].isoformat() if plan["date_from"] else None,
                 "date_to": plan["date_to"].isoformat() if plan["date_to"] else None}
    found, videos, errors, moves, near_set = [], 0, 0, [], set(near)
    runctl.emit("phase", name="move", total=len(in_range), run_id=run_id, journal=str(journal), action=action)
    try:
        with journal.open("a", encoding="utf-8") as jf:
            for n, src in enumerate(in_range, 1):
                runctl.checkpoint()
                is_match, conf, error, how = results[src]
                taken, source_of_date = times.get(src, (None, "none"))
                entry = {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id, "action": action,
                         "model": cfg["model"], "src": str(src), "dst": None, "group": target.name,
                         "request": request, "taken": taken.isoformat() if taken else None,
                         "date_source": source_of_date, "match": is_match,
                         "confidence": None if conf is None else round(conf, 3),
                         "matched_by": how if is_match else None, "near_match": src in near_set}
                with runctl.no_interrupt():  # the move and its journal line happen together
                    try:
                        if error:
                            raise ClassifyError(error)
                        if is_match:
                            if action in ("move", "copy"):
                                dst = unique_path(target / src.name)
                                if not target.exists():
                                    target.mkdir(parents=True)
                                    group.write_marker(target, request, plan, run_id)
                                (shutil.move if action == "move" else shutil.copy2)(str(src), str(dst))
                                entry["dst"] = str(dst)
                                if action == "move":
                                    moves.append((src, dst))
                            elif src in fps:
                                if fps[src] is None:
                                    raise OSError("could not read the file to record its fingerprint")
                                entry.update(fp=fps[src], plan=plan_info)
                            found.append(src)
                            videos += is_video(src)
                    except Exception as e:  # leave the file where it is and keep going
                        errors += 1
                        entry["error"] = error or f"{type(e).__name__}: {str(e)[:200]}"
                    _journal(jf, entry)
                if "error" in entry and not error:
                    log.warning("could not %s %s: %s", action, src.name, entry["error"])
                runctl.emit("item", phase="move", n=n, total=len(in_range), path=str(src),
                            **({"error": entry["error"]} if "error" in entry else
                               {"result": {"match": is_match, "confidence": entry["confidence"],
                                           "matched_by": entry["matched_by"], "dst": entry["dst"]}}))
    except KeyboardInterrupt:
        log.warning("interrupted; moved files are journaled, the rest stay in place")
        raise
    finally:
        update_index_paths(index_path(cfg), moves)
    elapsed = time.perf_counter() - t_start
    summary = {"run_id": run_id, "action": action, "model": cfg["model"], "workers": cfg["concurrency"],
               "source": str(source), "request": request, "topic": plan["topic"], "media": plan["media"],
               "dates": group.dates_text(plan), "people_ignored": plan["people"], "group": str(target),
               "journal": str(journal), "scanned": len(files), "other_files": skipped, "in_range": len(in_range),
               "other_dates": other_dates, "no_date": no_date, "already_in_group": len(held),
               "checked": len(in_range) if plan["topic"] else 0, "same_event_checked": len(near),
               "same_event_found": sum(1 for p in found if results[p][3] == "same event"),
               "matched": len(found), "videos": videos, "errors": errors, "matched_paths": sorted(map(str, found)),
               "started_at": started.isoformat(timespec="seconds"),
               "finished_at": datetime.now().isoformat(timespec="seconds"), "elapsed_s": round(elapsed, 1),
               "per_min": round(len(in_range) / elapsed * 60, 1) if elapsed and plan["topic"] else 0.0}
    log.debug("summary: %s", json.dumps({k: v for k, v in summary.items() if k != "matched_paths"}))
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
        ("Result", f"{s['sorted']} files {done} ({s['sorted'] - s['videos']} photos, {s['videos']} videos); "
                   f"{s['errors']} errors; {s['skipped_non_images']} other files left in place"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
        ("Speed", f"{s['per_min']} files/min"),
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
        ("Result", f"{s['images']} files found ({s['videos']} videos): {s['captioned']} captioned, {s['reused']} "
                   f"reused (moved or duplicate), {s['unchanged']} unchanged; {s['errors']} errors"),
        ("Removed", f"{s['removed']} entries for files no longer in this folder"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
        ("Speed", f"{s['per_min']} files/min captioned"),
        ("Index", f"{s['index_path']} ({s['total_indexed']} files total)"),
    ]
    return "\n".join(["", "=== PhotoSort index report ==="] + [f"{k:<12}: {v}" for k, v in rows])


def format_search_results(r: dict, paths_only: bool = False) -> str:
    if paths_only:
        return "\n".join(x["path"] for x in r["results"])
    lines = [f'Search: "{r["query"]}"  ({len(r["results"])} of {r["searched"]} indexed files, '
             f'{format_duration(r["elapsed_s"])})']
    for n, x in enumerate(r["results"], 1):
        lines.append(f"{n:>3}. {x['score']:.3f}  {x['path']}{'' if x['exists'] else '  [missing on disk]'}")
        caption = " ".join(x["caption"].split())
        lines.append(f"     {caption[:157] + '...' if len(caption) > 160 else caption}")
    if not r["results"]:
        lines.append("No indexed files match this folder; run `photosort index <folder>` first.")
    return "\n".join(lines)


def format_group_report(s: dict) -> str:
    """Plain-ASCII finish report for a group run (the dict returned by group_folder)."""
    done = {"move": "moved", "copy": "copied"}.get(s["action"], "found (no files changed)")
    media = {"photos": "photos only", "videos": "videos only", "both": "photos and videos"}[s["media"]]
    topic = f'topic "{s["topic"]}"' if s["topic"] else "any content"
    understood = f"{topic}; {media}; {s['dates']}"
    rows = [("Run", s["run_id"]), ("Folder", s["source"]), ("Request", s["request"]),
            ("Understood", understood)]
    if s["people_ignored"]:
        rows.append(("Note", f"names are not recognized and were ignored: {', '.join(s['people_ignored'])}"))
    rows += [
        ("Group folder", s["group"] + (f"  (already held {s['already_in_group']} files)"
                                       if s["already_in_group"] else "")),
        ("Model", f"{s['model']}, {s['workers']} parallel workers"),
        ("Files", f"{s['scanned']} {media} scanned: {s['in_range']} in range, {s['other_dates']} other dates, "
                  f"{s['no_date']} with no capture date"),
        ("Checked", (f"{s['checked']} files by the model" + (
            f"; {s['same_event_checked']} more taken near a match asked if from the same occasion, "
            f"{s['same_event_found']} were" if s.get("same_event_checked") else ""))
            if s["topic"] else "not needed (dates only)"),
        ("Result", f"{s['matched']} files {done} ({s['matched'] - s['videos']} photos, {s['videos']} videos); "
                   f"{s['errors']} errors; everything else left where it was"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
    ]
    if s["topic"]:
        rows.append(("Speed", f"{s['per_min']} files/min checked"))
    rows.append(("Journal", s["journal"]))
    lines = ["", "=== PhotoSort group report ==="] + [f"{k:<12}: {v}" for k, v in rows]
    if s["action"] == "report" and s["matched_paths"]:
        lines += ["", "Matches"] + [f"  {p}" for p in s["matched_paths"]]
    return "\n".join(lines)


def remove_empty_folder(folder: Path) -> None:
    """Delete a bucket or group folder once it is empty (a group folder's marker file does not count). OneDrive
    can mark synced folders read-only, which makes rmdir fail with 'Access is denied' on Windows, so clear that
    flag first."""
    try:
        if any(p.name != group.GROUP_MARKER for p in folder.iterdir()):
            return
        (folder / group.GROUP_MARKER).unlink(missing_ok=True)
        try:
            folder.rmdir()
        except PermissionError:
            os.chmod(folder, stat.S_IWRITE)
            folder.rmdir()
    except OSError:
        pass


def read_journal(journal: Path) -> list[dict]:
    return [json.loads(line) for line in Path(journal).read_text(encoding="utf-8").splitlines() if line.strip()]


def _seconds_between(a: str | None, b: str | None) -> float | None:
    try:
        return max(0.0, (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds())
    except (TypeError, ValueError):
        return None


def journal_runs(entries: list[dict]) -> list[dict]:
    """One summary per run of a journal, newest first. Pure: reads no files and changes nothing.

    A run's own lines are its per-file results; the "restore" and "undo" lines an undo writes under the same run id
    count as that run's undo. `duration_s` comes from the journal's timestamps (one-second resolution), so it is an
    estimate. `can_undo` and `can_apply` say whether `undo` or `apply` would find something to do."""
    runs: dict[str, dict] = {}
    restored: Counter = Counter()
    undone: dict[str, dict] = {}
    for e in entries:
        rid, action, ts = e.get("run_id"), e.get("action"), e.get("ts")
        if not isinstance(rid, str):
            continue
        if action == "restore":
            restored[rid] += 1
            continue
        if action == "undo":
            undone[rid] = {"ts": ts, "restored": e.get("restored"), "problems": e.get("problems")}
            continue
        r = runs.get(rid)
        if r is None:
            r = runs[rid] = {"run_id": rid, "kind": "sort", "of": None, "action": action, "model": e.get("model"),
                             "started": ts, "ended": ts, "files": 0, "done": 0, "errors": 0, "matched": 0,
                             "buckets": Counter(), "group": None, "request": None, "applied_from": None,
                             "_picked": 0, "_fp": 0}
        if isinstance(ts, str):
            r["started"] = min(r["started"] or ts, ts)
            r["ended"] = max(r["ended"] or ts, ts)
        r["files"] += 1
        error = bool(e.get("error"))
        r["errors"] += error
        r["done"] += bool(e.get("dst"))
        if "group" in e:
            r["group"], r["request"] = e.get("group"), e.get("request")
            r["matched"] += bool(e.get("match")) and not error
            picked = bool(e.get("match")) and not error
        else:
            picked = bool(e.get("bucket")) and not error
            if picked:
                r["buckets"][e["bucket"]] += 1
        r["_picked"] += picked
        r["_fp"] += picked and bool(e.get("fp"))
        if e.get("applied_from"):
            r["applied_from"] = e["applied_from"]
    out = []
    for rid, r in runs.items():
        kind = "group" if r["group"] is not None else "sort"
        if r["applied_from"]:
            r["kind"], r["of"] = "apply", kind
        else:
            r["kind"] = kind
        r["restored"] = restored.get(rid, 0)
        r["undone"] = undone.get(rid)
        r["applied_by"] = [o for o, x in runs.items() if x["applied_from"] == rid]
        live_apply = [o for o in r["applied_by"] if o not in undone]
        r["can_undo"] = r["action"] == "move" and r["done"] > r["restored"] and r["undone"] is None
        r["can_apply"] = (r["action"] == "report" and not live_apply and r["_picked"] > 0
                          and r["_fp"] == r["_picked"])
        r["duration_s"] = _seconds_between(r["started"], r["ended"])
        r["buckets"] = dict(r["buckets"].most_common())
        del r["_picked"], r["_fp"]
        out.append(r)
    return sorted(out, key=lambda r: (r["started"] or "", r["run_id"]), reverse=True)


def journal_items(entries: list[dict], run_id: str, offset: int = 0, limit: int = 500) -> dict:
    """The per-file results of one run (without its undo lines), in journal order. Pure."""
    back = {(e.get("src"), e.get("dst")) for e in entries if e.get("action") == "restore" and e.get("run_id") == run_id}
    rows = [e for e in entries if e.get("run_id") == run_id and e.get("action") not in ("restore", "undo")]
    items = []
    for n, e in enumerate(rows[offset:offset + limit], offset + 1):
        src = e.get("src") or ""
        items.append({"n": n, "src": src, "name": Path(src).name, "dst": e.get("dst"), "bucket": e.get("bucket"),
                      "group": e.get("group"), "match": e.get("match"), "confidence": e.get("confidence"),
                      "error": e.get("error"), "restored": bool(e.get("dst")) and (src, e.get("dst")) in back})
    return {"run_id": run_id, "total": len(rows), "offset": offset, "items": items}


def plan_undo(entries: list[dict], run_id: str | None = None) -> dict:
    """What undoing a run would do; changes nothing. Default run: the latest move run not yet undone. Files an
    interrupted undo already moved back (its "restore" lines) are left out."""
    undone = {e["run_id"] for e in entries if e.get("action") == "undo"}
    moves = [e for e in entries if e.get("action") == "move" and e.get("dst")]
    if run_id is None:
        pending = [e["run_id"] for e in moves if e["run_id"] not in undone]
        if not pending:
            raise ValueError("no move runs left to undo in this journal")
        run_id = pending[-1]
    done_before = {(e["src"], e["dst"]) for e in entries if e.get("action") == "restore" and e["run_id"] == run_id}
    restore, problems = [], []
    for e in reversed([e for e in moves if e["run_id"] == run_id]):
        if (e["src"], e["dst"]) in done_before:
            continue
        src, dst = Path(e["src"]), Path(e["dst"])
        reason = "missing" if not dst.exists() else "original path occupied" if src.exists() else None
        if reason:
            problems.append((src, dst, reason))
        else:
            restore.append((src, dst))
    return {"run_id": run_id, "restore": restore, "problems": problems, "already_restored": len(done_before)}


def undo_folders(journal: Path, run_id: str | None = None) -> list[Path]:
    """Folders an undo touches: the journal's folder and those the files go back to."""
    plan = plan_undo(read_journal(journal), run_id)
    return [Path(journal).resolve().parent] + [s.parent for s, *_ in plan["restore"] + plan["problems"]]


def undo_run(journal: Path, run_id: str | None = None, index_db: Path | None = None, dry_run: bool = False) -> dict:
    """Move the files of a sort, group or apply run back to where they came from (default: the latest run not yet
    undone). dry_run lists what would happen and moves nothing. Each file moved back is journaled as it happens,
    so an interrupted undo is finished by running undo again."""
    started, t_start = datetime.now(), time.perf_counter()
    journal = Path(journal)
    plan = plan_undo(read_journal(journal), run_id)
    run_id = plan["run_id"]
    problems = [(str(s), str(d), reason) for s, d, reason in plan["problems"]]
    for _, d, reason in problems:
        log.warning("cannot restore %s (%s)", d, reason)
    restored = []
    if dry_run:
        restored = [(str(s), str(d)) for s, d in plan["restore"]]
    else:
        total, back = len(plan["restore"]), []
        runctl.emit("phase", name="undo", total=total, run_id=run_id, journal=str(journal))
        try:
            with journal.open("a", encoding="utf-8") as jf:
                for n, (src, dst) in enumerate(plan["restore"], 1):
                    runctl.checkpoint()
                    reason = "missing" if not dst.exists() else "original path occupied" if src.exists() else None
                    if not reason:
                        with runctl.no_interrupt():  # the move and its journal line happen together
                            try:
                                src.parent.mkdir(parents=True, exist_ok=True)
                                shutil.move(str(dst), str(src))
                                _journal(jf, {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id,
                                              "action": "restore", "src": str(src), "dst": str(dst)})
                            except OSError as e:
                                reason = f"{type(e).__name__}: {str(e)[:200]}"
                    if reason:
                        problems.append((str(src), str(dst), reason))
                        log.warning("cannot restore %s (%s)", dst, reason)
                        runctl.emit("item", phase="undo", n=n, total=total, path=str(src), error=reason)
                        continue
                    restored.append((str(src), str(dst)))
                    back.append((dst, src))
                    remove_empty_folder(dst.parent)
                    runctl.emit("item", phase="undo", n=n, total=total, path=str(src), result={"from": str(dst)})
                _journal(jf, {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id,
                              "action": "undo", "restored": len(restored), "problems": len(problems)})
        except KeyboardInterrupt:
            log.warning("interrupted; files moved back so far are journaled, run undo again to finish")
            raise
        finally:
            if index_db:
                update_index_paths(index_db, back)
        log.info("undo %s: restored %d, problems %d", run_id, len(restored), len(problems))
    elapsed = time.perf_counter() - t_start
    return {"run_id": run_id, "journal": str(journal), "dry_run": dry_run, "restored": len(restored),
            "problems": len(problems), "already_restored": plan["already_restored"], "restored_files": restored,
            "problem_files": problems, "started_at": started.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"), "elapsed_s": round(elapsed, 1)}


def undo(journal: Path, run_id: str | None = None, index_db: Path | None = None) -> dict:
    """Move files from a sort run back to where they came from (default: latest run not yet undone)."""
    r = undo_run(journal, run_id, index_db)
    return {"run_id": r["run_id"], "restored": r["restored"], "problems": r["problems"]}


def format_undo_report(r: dict) -> str:
    """Plain-ASCII finish report for an undo (the dict returned by undo_run)."""
    if r["dry_run"]:
        result = (f"{r['restored']} files would be moved back; {r['problems']} cannot be "
                  "(dry run: nothing was moved)")
    else:
        result = f"{r['restored']} files moved back to where they were; {r['problems']} problems"
    rows = [("Run", r["run_id"]), ("Journal", r["journal"]), ("Result", result)]
    if r["already_restored"]:
        rows.append(("Earlier", f"{r['already_restored']} files were moved back by an earlier, interrupted undo"))
    rows.append(("Duration", f"{format_duration(r['elapsed_s'])}  (started {r['started_at'].replace('T', ' ')}, "
                             f"finished {r['finished_at'].replace('T', ' ')})"))
    lines = ["", "=== PhotoSort undo report ==="] + [f"{k:<12}: {v}" for k, v in rows]
    if r["dry_run"] and r["restored_files"]:
        lines += ["", "Would move back"] + [f"  {dst}  ->  {src}" for src, dst in r["restored_files"]]
    if r["problem_files"]:
        lines += ["", "Problems"] + [f"  {dst}: {reason}" for _, dst, reason in r["problem_files"]]
    return "\n".join(lines)


def _preview_entries(entries: list[dict], run_id: str | None) -> tuple[str, list[dict]]:
    """(run_id, journal entries of that preview), default: the latest preview not yet applied."""
    previews = [e for e in entries if e.get("action") == "report"]
    undone = {e["run_id"] for e in entries if e.get("action") == "undo"}
    applied = {e["applied_from"] for e in entries if e.get("applied_from") and e["run_id"] not in undone}
    if run_id is None:
        pending = [e["run_id"] for e in previews if e["run_id"] not in applied]
        if not pending:
            raise ValueError("no previews left to apply in this journal; preview first with --action report")
        run_id = pending[-1]
    run = [e for e in previews if e["run_id"] == run_id]
    if not run:
        raise ValueError(f"run {run_id} is not a preview (--action report) in this journal")
    if run_id in applied:
        raise ValueError(f"preview {run_id} was already applied; undo that run first to apply it again")
    return run_id, run


def apply_folders(journal: Path, run_id: str | None = None) -> list[Path]:
    """Folders an apply touches: the journal's folder (where the buckets or group folder go) and the files' own."""
    _, run = _preview_entries(read_journal(journal), run_id)
    return [Path(journal).resolve().parent] + [Path(e["src"]).parent for e in run]


def _changed_since(e: dict) -> str | None:
    """Why a previewed file can no longer be applied (None: unchanged)."""
    src, fp = Path(e["src"]), e["fp"]
    try:
        st = src.stat()
        if (st.st_size, st.st_mtime_ns) != (fp["size"], fp["mtime_ns"]) or sha256_file(src) != fp["sha256"]:
            return "changed since the preview"
    except FileNotFoundError:
        return "no longer there"
    except OSError as err:
        return f"cannot read: {err}"
    return None


def apply_preview(cfg: dict, journal: Path, run_id: str | None = None, action: str = "move") -> dict:
    """Move (or copy) exactly the files a preview (`sort` or `group` with --action report) found, to where it said,
    without asking the model again. A file that changed since the preview (size, modified time or SHA-256) or is
    gone is left alone and reported. The new run is journaled like any other, so `undo` reverses it."""
    started, t_start = datetime.now(), time.perf_counter()
    journal = Path(journal).resolve()
    preview_id, run = _preview_entries(read_journal(journal), run_id)
    kind = "group" if "group" in run[0] else "sort"
    picked = [e for e in run if not e.get("error") and (e.get("match") if kind == "group" else e.get("bucket"))]
    if any(not e.get("fp") for e in picked):
        raise ValueError(f"preview {preview_id} was made before PhotoSort recorded file fingerprints; preview again")
    root = journal.parent
    target = None
    if kind == "group":
        target = root / run[0]["group"]
        if target.exists() and not (target / group.GROUP_MARKER).exists():
            target = unique_path(target)  # never pour files into a folder of the user's own
    new_id = started.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
    log.info("apply %s: %d files from preview %s (%s), action=%s", new_id, len(picked), preview_id, kind, action)
    runctl.emit("phase", name="verify", total=len(picked))
    ex = ThreadPoolExecutor(max_workers=8, thread_name_prefix="verify")
    try:
        checks = []
        for reason in ex.map(_changed_since, picked):
            runctl.checkpoint()
            checks.append(reason)
    finally:
        ex.shutdown(wait=False, cancel_futures=True)
    counts, moves, done, videos, changed, errors, skipped = Counter(), [], 0, 0, 0, 0, []
    runctl.emit("phase", name="apply", total=len(picked), run_id=new_id, journal=str(journal),
                applied_from=preview_id, action=action)
    keep = ("bucket", "confidence") if kind == "sort" else (
        "group", "request", "taken", "date_source", "match", "confidence", "matched_by", "near_match")
    try:
        with journal.open("a", encoding="utf-8") as jf:
            for n, (e, reason) in enumerate(zip(picked, checks), 1):
                runctl.checkpoint()
                src = Path(e["src"])
                entry = {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": new_id, "action": action,
                         "model": e.get("model"), "src": str(src), "dst": None, "applied_from": preview_id,
                         **{k: e.get(k) for k in keep}}
                if target is not None:
                    entry["group"] = target.name
                with runctl.no_interrupt():  # the move and its journal line happen together
                    try:
                        if reason:
                            changed += 1
                        else:
                            folder = target if kind == "group" else root / e["bucket"]
                            dst = unique_path(folder / src.name)
                            if kind == "group" and not folder.exists():
                                folder.mkdir(parents=True)
                                p = e["plan"]
                                group.write_marker(folder, e["request"], {
                                    "topic": p["topic"], "media": p["media"],
                                    "date_from": date.fromisoformat(p["date_from"]) if p["date_from"] else None,
                                    "date_to": date.fromisoformat(p["date_to"]) if p["date_to"] else None}, new_id)
                            else:
                                dst.parent.mkdir(parents=True, exist_ok=True)
                            (shutil.move if action == "move" else shutil.copy2)(str(src), str(dst))
                            entry["dst"] = str(dst)
                            if action == "move":
                                moves.append((src, dst))
                            done += 1
                            videos += is_video(src)
                            counts[e.get("bucket") or target.name] += 1
                    except Exception as err:  # leave the file where it is and keep going
                        errors += 1
                        reason = f"{type(err).__name__}: {str(err)[:200]}"
                    if reason:
                        entry["error"] = reason
                    _journal(jf, entry)
                if reason:
                    skipped.append((str(src), reason))
                    log.warning("[%d/%d] SKIPPED %s: %s", n, len(picked), src.name, reason)
                    runctl.emit("item", phase="apply", n=n, total=len(picked), path=str(src), error=reason)
                else:
                    log.info("[%d/%d] %s  %s", n, len(picked), Path(entry["dst"]).parent.name, src.name)
                    runctl.emit("item", phase="apply", n=n, total=len(picked), path=str(src),
                                result={"dst": entry["dst"], **({"bucket": e["bucket"]} if kind == "sort" else {})})
    except KeyboardInterrupt:
        log.warning("interrupted; moved files are journaled, the rest stay in place")
        raise
    finally:
        update_index_paths(index_path(cfg), moves)
    elapsed = time.perf_counter() - t_start
    return {"run_id": new_id, "applied_from": preview_id, "kind": kind, "action": action, "folder": str(root),
            "journal": str(journal), "group": str(target) if target else None, "planned": len(picked),
            "applied": done, "videos": videos, "changed": changed, "errors": errors, "skipped_files": skipped,
            "buckets": dict(counts.most_common()), "started_at": started.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"), "elapsed_s": round(elapsed, 1)}


def format_apply_report(s: dict) -> str:
    """Plain-ASCII finish report for an apply run (the dict returned by apply_preview)."""
    done = {"move": "moved", "copy": "copied"}[s["action"]]
    rows = [("Run", s["run_id"]), ("Preview", f"{s['applied_from']} ({s['kind']}): {s['planned']} files found"),
            ("Folder", s["folder"])]
    if s["group"]:
        rows.append(("Group folder", s["group"]))
    rows += [
        ("Result", f"{s['applied']} files {done} ({s['applied'] - s['videos']} photos, {s['videos']} videos), "
                   f"exactly as previewed; {s['changed']} changed or gone since the preview, left alone; "
                   f"{s['errors']} errors"),
        ("Duration", f"{format_duration(s['elapsed_s'])}  (started {s['started_at'].replace('T', ' ')}, "
                     f"finished {s['finished_at'].replace('T', ' ')})"),
        ("Journal", s["journal"]),
    ]
    lines = ["", "=== PhotoSort apply report ==="] + [f"{k:<12}: {v}" for k, v in rows]
    if s["kind"] == "sort" and s["buckets"]:
        width = max(len(name) for name in s["buckets"])
        lines += ["", "Buckets"] + [f"  {name:<{width}}  {n:>4}" for name, n in s["buckets"].items()]
    if s["skipped_files"]:
        lines += ["", "Left alone"] + [f"  {path}: {reason}" for path, reason in s["skipped_files"]]
    return "\n".join(lines)


def _params(a: argparse.Namespace) -> dict:
    return {k: v for k, v in vars(a).items() if k not in ("cmd", "events", "cancel_file", "verbose", "config")}


def _run(a: argparse.Namespace) -> tuple[int, dict | None, str | None]:
    """Run one command: (exit code, summary, report). Reports are printed here, as before."""
    if a.cmd == "undo":
        index_db = index_path(load_config(a.config))
        with runctl.folder_lock("undo", "read" if a.dry_run else "move", undo_folders(a.journal, a.run_id), a.force):
            result = undo_run(a.journal, a.run_id, index_db, dry_run=a.dry_run)
        report = format_undo_report(result)
        print(report, flush=True)
        return 0, result, report
    if a.cmd == "faces-setup":
        runctl.emit("phase", name="setup", total=len(a.hosts))
        for n, host in enumerate(a.hosts, 1):
            runctl.checkpoint()
            info = setup_remote_worker(host, a.model)
            print(f"OK: {host} ({info.get('host')}) face worker ready: {info.get('provider')}", flush=True)
            runctl.emit("item", phase="setup", n=n, total=len(a.hosts), path=host,
                        result={"status": "ready", "provider": info.get("provider")})
        return 0, {"hosts": len(a.hosts), "ready": len(a.hosts)}, None
    if a.cmd == "faces":
        workers = a.workers or load_config(a.config).get("face_workers") or ["local"]
        with runctl.folder_lock("faces", "read", [a.source], a.force):
            result = tag_people(a.source, a.people, a.output, IMAGE_EXTS, a.recursive, a.limit,
                                a.threshold, a.margin, a.model, a.model_dir, workers=workers, video_exts=VIDEO_EXTS)
        report = format_face_report(result)
        print(report, flush=True)
        return (1 if result["summary"]["errors"] else 0), result["summary"], report
    cfg = load_config(a.config)
    if a.cmd in ("index-export", "index-import"):
        if a.cmd == "index-export":
            result = export_index(cfg, a.out, a.allow_onedrive)
            report = format_export_report(result)
            code = 0
        else:
            result = import_index(cfg, a.file, a.map, a.dry_run)
            report = format_import_report(result)
            # Nothing found here at all almost always means a missing or wrong --map.
            code = 1 if result["files"] and result["missing"] == result["files"] else 0
        print(report, flush=True)
        return code, result, report
    if a.cmd == "check":
        clf = Classifier(cfg)
        names = clf.preflight()
        s = settings(cfg)
        require_local_models([s["caption_model"], s["embed_model"]], clf.models)
        missing = [m for m in (s["caption_model"], s["embed_model"]) if m not in names]
        print(f"OK: {cfg['base_url']} reachable, {len(names)} models, '{cfg['model']}' available. "
              f"HEIC support: {'yes' if HEIF_EXTS else 'no (pip install pillow-heif)'}. "
              f"Video support: {'yes' if VIDEO_EXTS else 'no (pip install av)'}. "
              f"Search models: {'available' if not missing else 'MISSING ' + ', '.join(missing)}")
        return 0, None, None
    if a.cmd in ("index", "search"):
        client = PairSearchClient(cfg, encode_image)
        if a.cmd == "search":
            client.preflight([settings(cfg)["embed_model"]])
            print(format_search_results(search_index(cfg, a.query, client, a.folder, a.top), a.paths_only),
                  flush=True)
            return 0, None, None
        with runctl.folder_lock("index", "read", [a.source], a.force):
            runctl.emit("phase", name="preflight")
            client.preflight()
            result = index_folder(cfg, a.source, client, MEDIA_EXTS, a.limit, a.concurrency)
        report = format_index_report(result)
        print(report, flush=True)
        return (1 if result["errors"] else 0), result, report
    if a.cmd == "apply":
        with runctl.folder_lock("apply", "move", apply_folders(a.journal, a.run_id), a.force):
            summary = apply_preview(cfg, a.journal, a.run_id, a.action)
        report = format_apply_report(summary)
        print(report, flush=True)
        return (1 if summary["errors"] or summary["changed"] else 0), summary, report
    if a.model:
        cfg["model"] = a.model
    if a.concurrency:
        cfg["concurrency"] = a.concurrency
    action = a.action or cfg["action"]
    mode = "read" if action == "report" else "move"
    if a.cmd == "group":
        overrides = {}
        if a.date_to and not a.date_from:
            raise group.GroupError("--to needs --from")
        if a.date_from:
            overrides.update(date_from=a.date_from, date_to=a.date_to or date.today())
            if overrides["date_from"] > overrides["date_to"]:
                raise group.GroupError("--from is after --to")
        if a.media:
            overrides["media"] = a.media
        with runctl.folder_lock("group", mode, [a.source], a.force):
            summary = group_folder(cfg, a.source, a.request, action, a.name, overrides, a.limit)
        report = format_group_report(summary)
        print(report, flush=True)
        return (1 if summary["errors"] else 0), summary, report
    with runctl.folder_lock("sort", mode, [a.source, a.dest or a.source], a.force):
        summary = sort_folder(cfg, a.source, a.dest, action, a.recursive, a.limit)
    report = format_report(summary)
    print(report, flush=True)
    return (1 if summary["errors"] else 0), summary, report


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="photosort", description=__doc__.splitlines()[0])
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("-v", "--verbose", action="store_true")
    ap.add_argument("--events", type=Path, metavar="FILE",
                    help="also write progress as JSON lines to FILE (used by the dashboard)")
    ap.add_argument("--cancel-file", type=Path, metavar="FILE",
                    help="stop safely, as with Ctrl+C, once FILE exists (used by the dashboard)")
    locked = argparse.ArgumentParser(add_help=False)
    locked.add_argument("--force", action="store_true",
                        help="run even if another PhotoSort run is using an overlapping folder")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="verify the local PAIR proxy and model are available")
    s = sub.add_parser("sort", parents=[locked],
                       help="classify photos and videos in a folder and sort them into bucket folders")
    s.add_argument("source", type=Path)
    s.add_argument("--dest", type=Path, help="where bucket folders are created (default: source)")
    s.add_argument("--action", choices=["move", "copy", "report"], help="default from config")
    s.add_argument("--recursive", action="store_true",
                   help="include subfolders; all their photos and videos go into the top-level buckets "
                        "(bucket folders there are skipped)")
    s.add_argument("--limit", type=int, default=0, help="only process the first N files")
    s.add_argument("--concurrency", type=int, help="parallel requests to the PAIR cluster")
    s.add_argument("--model", help="override the configured model")
    u = sub.add_parser("undo", parents=[locked],
                       help="move files from a sort, group or apply run back to their original location")
    u.add_argument("journal", type=Path, help=f"path to {JOURNAL_NAME}")
    u.add_argument("--run-id", help="run to undo (default: latest run not yet undone)")
    u.add_argument("--dry-run", action="store_true", help="only list what would be moved back")
    g = sub.add_parser("group", parents=[locked],
                       help="gather the photos and videos that match a plain-language request into one "
                            "folder; everything else stays where it is")
    g.add_argument("source", type=Path, help="folder to look in (always including subfolders and bucket folders)")
    g.add_argument("request", help='e.g. "birthday party last Sunday" or "videos of the beach from last weekend"')
    g.add_argument("--action", choices=["move", "copy", "report"], help="default from config")
    g.add_argument("--name", help="group folder name (default: from the request, with its dates)")
    g.add_argument("--from", dest="date_from", type=date.fromisoformat, metavar="YYYY-MM-DD",
                   help="first day, instead of the dates in the request")
    g.add_argument("--to", dest="date_to", type=date.fromisoformat, metavar="YYYY-MM-DD",
                   help="last day (default with --from: today)")
    g.add_argument("--media", choices=group.MEDIA, help="instead of what the request says")
    g.add_argument("--limit", type=int, default=0, help="only check the first N files in range")
    g.add_argument("--concurrency", type=int, help="parallel requests to the PAIR cluster")
    g.add_argument("--model", help="override the configured model")
    p = sub.add_parser("apply", parents=[locked],
                       help="move exactly the files a preview (sort or group with --action report) found, "
                            "without asking the model again; files changed since the preview are left alone")
    p.add_argument("journal", type=Path, help=f"path to the preview's {JOURNAL_NAME}")
    p.add_argument("--run-id", help="preview run to apply (default: the latest one not yet applied)")
    p.add_argument("--action", choices=["move", "copy"], default="move")
    f = sub.add_parser("faces", parents=[locked], help="detect and locally tag faces using named reference-photo folders")
    f.add_argument("source", type=Path, help="folder of photos and videos to analyze; originals are not modified")
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
    f.add_argument("--limit", type=int, default=0, help="only process the first N files")
    fs = sub.add_parser("faces-setup", help="install the face worker environment and model on SSH hosts")
    fs.add_argument("hosts", nargs="+", help="SSH host aliases, e.g. spark1")
    fs.add_argument("--model", choices=["buffalo_l"], default="buffalo_l")
    i = sub.add_parser("index", parents=[locked],
                       help="caption and embed photos and videos (always including subfolders) for search")
    i.add_argument("source", type=Path, help="folder to index; files are only read, never modified")
    i.add_argument("--limit", type=int, default=0, help="only index the first N files")
    i.add_argument("--concurrency", type=int, help="parallel caption requests to the PAIR cluster")
    q = sub.add_parser("search", help="find indexed photos and videos by describing them in plain language")
    q.add_argument("query", help='e.g. "receipt from the hardware store" or "kids at the beach"')
    q.add_argument("--folder", type=Path, help="only return files under this folder")
    q.add_argument("--top", type=int, default=10, help="number of results (default 10)")
    q.add_argument("--paths-only", action="store_true", help="print only file paths, no captions")
    e = sub.add_parser("index-export",
                       help="copy the search index into one file to bring to another PC (no model calls)")
    e.add_argument("out", type=Path, help="new file to write, e.g. on a USB drive: E:\\photosort-index.sqlite")
    e.add_argument("--allow-onedrive", action="store_true",
                   help="allow writing into OneDrive, which uploads your photos' captions and visible text")
    m = sub.add_parser("index-import",
                       help="merge an index exported on another PC, so `index` does not describe those files again")
    m.add_argument("file", type=Path, help="file written by index-export")
    m.add_argument("--map", nargs=2, action="append", default=[], metavar=("OLD", "NEW"),
                   help="files under the other PC's folder OLD are under NEW here, e.g. "
                        "--map C:\\Users\\bob C:\\Users\\<you> (repeat for more folders)")
    m.add_argument("--dry-run", action="store_true", help="only report what would be imported; change nothing")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    runctl.configure(a.events, a.cancel_file)
    runctl.emit("run_start", cmd=a.cmd, params=_params(a), pid=os.getpid())
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(errors="replace")  # odd characters in a path must not crash a report
        code, summary, report = _run(a)
        runctl.finish(code, summary, report)
        return code
    except (LocalOnlyError, ClassifyError, FaceTaggingError, SearchError, VideoError, FileNotFoundError,
            ValueError, LockError, requests.RequestException) as e:
        log.error("%s", e)
        runctl.emit("error", message=str(e), kind="locked" if isinstance(e, LockError) else type(e).__name__)
        runctl.finish(2)
        return 2
    except KeyboardInterrupt:
        runctl.finish(130)
        return 130
    except BaseException as e:
        runctl.emit("error", message=f"{type(e).__name__}: {str(e)[:500]}", kind="crash")
        runctl.finish(1)
        raise


if __name__ == "__main__":
    sys.exit(main())
