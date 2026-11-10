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
import shutil
import stat
import sys
import threading
import time
import uuid
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import requests
from PIL import Image, ImageOps

import group
from face_tagger import FaceTaggingError, format_face_report, setup_remote_worker, tag_people
from local_only import LocalOnlyError, require_local_models, require_loopback
from media import VIDEO_EXTS, VideoError, encode_pil, is_video, video_jpegs
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
            try:
                r = self._session().post(f"{self.url}/api/chat", json=body, timeout=self.cfg["timeout_s"])
                r.raise_for_status()
                return parse(r.json()["message"]["content"])
            except (requests.RequestException, ValueError, KeyError, TypeError) as e:
                err = f"{type(e).__name__}: {str(e)[:200]}"
                log.debug("retry %d for %s: %s", attempt + 1, label, err)
                time.sleep(min(2 ** attempt, 10))
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
    counts, errors, moves, videos = Counter(), 0, [], 0
    log.info("run %s: %d files (%d videos), %d other files left in place, action=%s, model=%s, workers=%d",
             run_id, len(images), sum(map(is_video, images)), skipped, action, cfg["model"], cfg["concurrency"])
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
                    videos += is_video(src)
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
    with ThreadPoolExecutor(max_workers=group.UNDERSTAND_VOTES, thread_name_prefix="request") as ex:
        futures = [ex.submit(clf.read_request, request, today) for _ in range(group.UNDERSTAND_VOTES)]
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
    with ThreadPoolExecutor(max_workers=min(16, (os.cpu_count() or 4) * 2), thread_name_prefix="dates") as ex:
        for p, found in zip(todo, ex.map(lambda q: group.capture_time(q, is_video(q)), todo)):
            out[p] = found
    return out


def _check_files(ask, paths: list[Path], topic: str, workers: int, label: str) -> dict[Path, tuple]:
    """Ask the model about each file in parallel: {path: (match, confidence, error)}. Nothing is moved here."""
    out = {}
    ex = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="group")
    futures = {ex.submit(ask, p, topic): p for p in paths}
    try:
        for n, fut in enumerate(as_completed(futures), 1):
            src = futures[fut]
            try:
                is_match, conf = fut.result()
                out[src] = (is_match, conf, None)
                log.info("[%s %d/%d] %-5s %s  %s", label, n, len(paths), "MATCH" if is_match else "no",
                         "" if conf is None else f"{conf:.2f}", src.name)
            except Exception as e:  # leave the file where it is and keep going
                out[src] = (False, None, f"{type(e).__name__}: {str(e)[:200]}")
                log.warning("[%s %d/%d] FAILED %s: %s", label, n, len(paths), src.name, out[src][2])
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
        clf = Classifier(cfg)
        clf.preflight()
    plan = understand_request(clf, request, today, overrides)
    title = group.folder_name(plan, name, cfg["buckets"])
    target = source / title
    if target.exists() and not (target / group.GROUP_MARKER).exists():
        target = unique_path(target)  # never pour files into a folder of the user's own
    held = [p for p in target.rglob("*") if p.is_file() and p.suffix.lower() in MEDIA_EXTS] \
        if target.is_dir() else []
    files, skipped = scan(source, source, {}, recursive=True)
    wanted = {"photos": lambda p: not is_video(p), "videos": is_video, "both": lambda p: True}[plan["media"]]
    files = [p for p in files if wanted(p)]
    span = group.window(plan)
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
            for p, r in _check_files(clf.same_event, near, plan["topic"], cfg["concurrency"], "same event").items():
                results[p] = r + ("same event",) if r[2] is None else (False, results[p][1], f"same event: {r[2]}",
                                                                       "topic")
    else:  # dates only: every file in range belongs to the group
        results = {p: (True, None, None, "dates") for p in in_range}
    found, videos, errors, moves, near_set = [], 0, 0, [], set(near)
    try:
        with journal.open("a", encoding="utf-8") as jf:
            for src in in_range:
                is_match, conf, error, how = results[src]
                taken, source_of_date = times.get(src, (None, "none"))
                entry = {"ts": datetime.now().isoformat(timespec="seconds"), "run_id": run_id, "action": action,
                         "model": cfg["model"], "src": str(src), "dst": None, "group": target.name,
                         "request": request, "taken": taken.isoformat() if taken else None,
                         "date_source": source_of_date, "match": is_match,
                         "confidence": None if conf is None else round(conf, 3),
                         "matched_by": how if is_match else None, "near_match": src in near_set}
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
                        found.append(src)
                        videos += is_video(src)
                except Exception as e:  # leave the file where it is and keep going
                    errors += 1
                    entry["error"] = error or f"{type(e).__name__}: {str(e)[:200]}"
                    if not error:
                        log.warning("could not %s %s: %s", action, src.name, entry["error"])
                jf.write(json.dumps(entry) + "\n")
                jf.flush()
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
    s = sub.add_parser("sort", help="classify photos and videos in a folder and sort them into bucket folders")
    s.add_argument("source", type=Path)
    s.add_argument("--dest", type=Path, help="where bucket folders are created (default: source)")
    s.add_argument("--action", choices=["move", "copy", "report"], help="default from config")
    s.add_argument("--recursive", action="store_true",
                   help="include subfolders; all their photos and videos go into the top-level buckets "
                        "(bucket folders there are skipped)")
    s.add_argument("--limit", type=int, default=0, help="only process the first N files")
    s.add_argument("--concurrency", type=int, help="parallel requests to the PAIR cluster")
    s.add_argument("--model", help="override the configured model")
    u = sub.add_parser("undo", help="move files from a sort or group run back to their original location")
    u.add_argument("journal", type=Path, help=f"path to {JOURNAL_NAME}")
    u.add_argument("--run-id", help="run to undo (default: latest run not yet undone)")
    g = sub.add_parser("group", help="gather the photos and videos that match a plain-language request into one "
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
    f = sub.add_parser("faces", help="detect and locally tag faces using named reference-photo folders")
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
    i = sub.add_parser("index", help="caption and embed photos and videos (always including subfolders) for search")
    i.add_argument("source", type=Path, help="folder to index; files are only read, never modified")
    i.add_argument("--limit", type=int, default=0, help="only index the first N files")
    i.add_argument("--concurrency", type=int, help="parallel caption requests to the PAIR cluster")
    q = sub.add_parser("search", help="find indexed photos and videos by describing them in plain language")
    q.add_argument("query", help='e.g. "receipt from the hardware store" or "kids at the beach"')
    q.add_argument("--folder", type=Path, help="only return files under this folder")
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
                                a.threshold, a.margin, a.model, a.model_dir, workers=workers, video_exts=VIDEO_EXTS)
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
                  f"Video support: {'yes' if VIDEO_EXTS else 'no (pip install av)'}. "
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
            result = index_folder(cfg, a.source, client, MEDIA_EXTS, a.limit, a.concurrency)
            print(format_index_report(result), flush=True)
            return 1 if result["errors"] else 0
        if a.model:
            cfg["model"] = a.model
        if a.concurrency:
            cfg["concurrency"] = a.concurrency
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
            summary = group_folder(cfg, a.source, a.request, a.action or cfg["action"], a.name, overrides, a.limit)
            print(format_group_report(summary), flush=True)
            return 1 if summary["errors"] else 0
        summary = sort_folder(cfg, a.source, a.dest, a.action or cfg["action"], a.recursive, a.limit)
        print(format_report(summary), flush=True)
        return 1 if summary["errors"] else 0
    except (LocalOnlyError, ClassifyError, FaceTaggingError, SearchError, VideoError, FileNotFoundError,
            ValueError, requests.RequestException) as e:
        log.error("%s", e)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
