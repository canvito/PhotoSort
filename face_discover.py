"""Find the distinct people in a folder of photos and write one folder of face crops per person.

Faces are found and embedded by the face workers (face_tagger.py: LAN machines over SSH, never a cloud service),
and grouped here by average-linkage clustering of the embeddings (numpy only). The embeddings exist only in memory.
Each person with enough photos gets a folder of crops; rename the folders to names and the result is the
`--people` folder of `faces`. `faces` refuses a reference picture without exactly one detectable face, so a crop is
written only after a worker has looked at that very picture and found exactly one face in it, the same one.
"""
from __future__ import annotations

import io
import json
import logging
import shutil
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

import runctl
from face_tagger import NoWorkersLeft, WorkerPool, _detect_all, _Progress, _run_all, parse_workers
from face_worker import FaceTaggingError
from media import PEOPLE_MARKER, people_dirs

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

__all__ = ["discover_people", "format_discover_report"]

log = logging.getLogger("photosort")

FORMAT = "photosort-people-v1"
DEFAULT_SIMILARITY = 0.35  # two groups of faces are one person when their faces are this alike on average
DEFAULT_MIN_PHOTOS = 3
DEFAULT_MAX_PER_PERSON = 16
# Which faces are clear enough to compare. Others are not assigned to anybody (a stranger in the background).
MIN_SCORE = 0.6  # detector confidence
DEFAULT_SCORE = 0.8  # for a worker that does not send one
MIN_FACE_PX = 64  # shorter side of the face box in the photo
MAX_YAW = 0.5  # see yaw(): about 45 degrees; profiles match badly
MAX_CLUSTERED = 10_000  # the distance matrix is n x n float32 (400 MB at this size); the clearest faces are kept
MAX_PEOPLE = 200
DETECT_CHUNK = 2000  # photos per batch, so embeddings are packed into numpy arrays as the run goes
SWEEP = (0.25, 0.30, 0.35, 0.40, 0.45, 0.50)  # the report shows how many people each similarity would give
HINT_SIMILARITY = 0.40  # people whose average faces are this alike are listed as maybe the same person
MAX_HINTS = 10
# Choosing crops: clear, front-facing, typical of the person, and unlike the ones already chosen.
MMR_PENALTY = 0.5
RANK_POOL = 400
CROP_MARGINS = (0.40, 0.20, 0.60)  # each side's share of the face box; the next is tried when a crop fails
CROP_MAX_SIDE = 512
JPEG_QUALITY = 95
VERIFY_SIMILARITY = 0.75  # the face found in a crop must be this close to the face it was cut from
RENDER_THREADS = 8
MAX_ROUNDS = 4  # candidates that fail the check are replaced by the next best, this many times at most


@dataclass
class Face:
    photo: int  # index into the list of photos
    box: tuple[float, float, float, float]
    vector: np.ndarray  # unit length
    quality: float


@dataclass
class Person:
    name: str
    members: list[int]  # indices into the clustered faces
    photos: int
    centroid: np.ndarray
    ranked: list[int]  # candidate faces for crops, best first, at most one per photo


def yaw(kps) -> float | None:
    """How far the nose is from the middle between the eyes along the line of the eyes, as a share of the distance
    between the eyes: about 0 for a face looking at the camera, 0.5 at roughly 45 degrees, more in profile."""
    try:
        (lx, ly), (rx, ry), (nx, ny) = kps[0], kps[1], kps[2]
        ex, ey = rx - lx, ry - ly
    except (TypeError, IndexError, ValueError):
        return None
    span = ex * ex + ey * ey
    if not span > 0:
        return None
    value = ((nx - (lx + rx) / 2) * ex + (ny - (ly + ry) / 2) * ey) / span
    return float(value) if np.isfinite(value) else None


def usable_faces(photo: int, detections: list[dict], skipped: Counter) -> list[Face]:
    """The faces of one photo that are clear enough to tell people apart; the others are counted in `skipped`."""
    faces = []
    for d in detections:
        try:
            vector = np.asarray(d["embedding"], np.float32)
            x0, y0, x1, y1 = (float(v) for v in d["bbox"])
            score = float(d.get("score", DEFAULT_SCORE))
            norm = float(np.linalg.norm(vector)) if vector.ndim == 1 else 0.0
            readable = norm > 0 and bool(np.isfinite([norm, x0, y0, x1, y1, score]).all())
        except (KeyError, TypeError, ValueError):
            readable = False
        if not readable:
            skipped["unreadable"] += 1
            continue
        size, tilt = min(x1 - x0, y1 - y0), yaw(d.get("kps"))
        reason = ("low detector confidence" if score < MIN_SCORE else "too small" if size < MIN_FACE_PX
                  else "turned away" if tilt is not None and abs(tilt) > MAX_YAW else None)
        if reason:
            skipped[reason] += 1
            continue
        quality = min(1.0, size / 200) * score * (1 - min(abs(tilt or 0.0), 0.5))
        faces.append(Face(photo, (x0, y0, x1, y1), vector / norm, quality))
    return faces


def average_linkage(vectors: np.ndarray) -> list[tuple[int, int, float]]:
    """Exact average-linkage (UPGMA) clustering of unit vectors by cosine similarity, with nearest-neighbour chains.

    Returns the n-1 merges as (slot, slot, similarity). The merged group keeps the second slot. Merges are not in
    similarity order; cut() applies those at or above a similarity, which is the same as cutting the tree there."""
    n = len(vectors)
    if n < 2:
        return []
    data = np.asarray(vectors, np.float32)
    sim = data @ data.T
    np.fill_diagonal(sim, -np.inf)  # retired slots are -inf too, so argmax only ever finds live groups
    size = [1] * n
    merges, chain, first = [], [], 0
    for _ in range(n - 1):
        while True:
            if not chain:
                while size[first] == 0:
                    first += 1
                chain.append(first)
            x = chain[-1]
            row = sim[x]
            y = int(row.argmax())
            if len(chain) > 1 and row[chain[-2]] >= row[y]:  # a tie goes to the previous one: no cycles
                y = chain[-2]
                break
            chain.append(y)
        chain.pop()
        chain.pop()
        merged = (size[x] * sim[x] + size[y] * sim[y]) / (size[x] + size[y])
        merges.append((x, y, float(sim[x, y])))
        sim[y, :] = merged
        sim[:, y] = merged
        sim[y, y] = -np.inf
        sim[x, :] = -np.inf
        sim[:, x] = -np.inf
        size[y], size[x] = size[x] + size[y], 0
    return merges


def cut(merges: list[tuple[int, int, float]], n: int, similarity: float) -> list[list[int]]:
    """The groups of points that average linkage has joined at a similarity of at least `similarity`."""
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b, s in merges:
        if s >= similarity:
            parent[find(a)] = find(b)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return list(groups.values())


def rank_faces(faces: list[Face], members: list[int], centroid: np.ndarray, limit: int) -> list[int]:
    """One face per photo, best reference first: clear, front-facing and typical of the person, but unlike the
    faces already chosen, so the folder shows the person in different light, angles and ages."""
    best: dict[int, tuple[float, int]] = {}
    for i in members:
        base = faces[i].quality * max(float(faces[i].vector @ centroid), 0.0)
        if faces[i].photo not in best or base > best[faces[i].photo][0]:
            best[faces[i].photo] = (base, i)
    candidates = sorted(best.values(), key=lambda t: (-t[0], t[1]))
    if not limit:
        return [i for _, i in candidates]
    candidates = candidates[: max(RANK_POOL, 5 * limit)]
    ids = [i for _, i in candidates]
    base = np.array([b for b, _ in candidates])
    stack = np.stack([faces[i].vector for i in ids])
    alike = stack @ stack.T
    penalty, taken, order = np.zeros(len(ids)), np.zeros(len(ids), bool), []
    for _ in ids:
        pick = int(np.where(taken, -np.inf, base - penalty).argmax())
        order.append(ids[pick])
        taken[pick] = True
        penalty = np.maximum(penalty, MMR_PENALTY * alike[pick])
    return order


def find_people(faces: list[Face], merges: list, similarity: float, min_photos: int, limit: int):
    """(people, groups with too few photos, people left out beyond MAX_PEOPLE), biggest first and named
    person-001, person-002, ..."""
    groups, small = [], 0
    for members in cut(merges, len(faces), similarity):
        photos = len({faces[i].photo for i in members})
        if photos < min_photos:
            small += 1
        else:
            groups.append((photos, members))
    groups.sort(key=lambda g: (-g[0], -len(g[1]), g[1][0]))
    over = max(0, len(groups) - MAX_PEOPLE)
    width = max(3, len(str(min(len(groups), MAX_PEOPLE))))
    people = []
    for n, (photos, members) in enumerate(groups[:MAX_PEOPLE], 1):
        centroid = np.sum([faces[i].vector for i in members], axis=0)
        centroid = centroid / np.linalg.norm(centroid)
        people.append(Person(f"person-{n:0{width}d}", members, photos, centroid,
                             rank_faces(faces, members, centroid, limit)))
    return people, small, over


def similar_people(people: list[Person]) -> list[tuple[str, str, float]]:
    """Pairs of people whose faces are so alike that they may be one person split in two (glasses, age, light)."""
    if len(people) < 2:
        return []
    stack = np.stack([p.centroid for p in people])
    alike = stack @ stack.T
    pairs = [(people[i].name, people[j].name, round(float(alike[i, j]), 2))
             for i in range(len(people)) for j in range(i + 1, len(people)) if alike[i, j] >= HINT_SIMILARITY]
    return sorted(pairs, key=lambda t: -t[2])[:MAX_HINTS]


def crop_box(box, size: tuple[int, int], margin: float) -> tuple[int, int, int, int]:
    """A square around the face box: its longer side plus `margin` of it on every side. It is moved to stay inside
    the picture, and shrinks when the picture is smaller than that."""
    x0, y0, x1, y1 = box
    width, height = size
    side = min(max(1, round(max(x1 - x0, y1 - y0) * (1 + 2 * margin))), width, height)
    left = min(max(round((x0 + x1) / 2 - side / 2), 0), width - side)
    top = min(max(round((y0 + y1) / 2 - side / 2), 0), height - side)
    return left, top, left + side, top + side


def render_crop(image: Image.Image, box, margin: float) -> bytes:
    """The crop as a JPEG with no metadata (no location, no dates), at most CROP_MAX_SIDE pixels."""
    crop = image.crop(crop_box(box, image.size, margin)).convert("RGB")
    if max(crop.size) > CROP_MAX_SIDE:
        crop.thumbnail((CROP_MAX_SIDE, CROP_MAX_SIDE), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    crop.save(out, "JPEG", quality=JPEG_QUALITY)
    return out.getvalue()


def _verified_crop(pool, path: Path, face: Face) -> tuple[bytes | None, float | None, str]:
    """(jpeg, margin, "ok") for the first margin whose crop a worker sees as exactly this face, else
    (None, None, why not)."""
    try:
        with Image.open(path) as im:
            image = ImageOps.exif_transpose(im)  # the boxes are in upright coordinates, as the worker saw it
        why = "no face in the crop"
        for margin in CROP_MARGINS:
            data = render_crop(image, face.box, margin)
            found = pool.detect(data)
            if len(found) != 1:
                why = "no face in the crop" if not found else "other faces in the crop"
                continue
            vector = np.asarray(found[0]["embedding"], np.float32)
            norm = float(np.linalg.norm(vector))
            if norm > 0 and float(vector @ face.vector) / norm >= VERIFY_SIMILARITY:
                return data, margin, "ok"
            why = "another face in the crop"
        return None, None, why
    except NoWorkersLeft:
        raise
    except Exception as e:  # one bad photo must not stop the run: the next candidate takes its place
        return None, None, "photo not readable" if isinstance(e, (OSError, ValueError)) else type(e).__name__


def make_crops(pool, people: list[Person], faces: list[Face], paths: list[Path], max_per_person: int) -> dict:
    """Verified crops for every person, in rounds: candidates that fail are replaced by the next best ones."""
    kept: dict[str, list[tuple[int, bytes]]] = {p.name: [] for p in people}
    used, retried, rejected = Counter(), 0, Counter()
    for _ in range(MAX_ROUNDS):
        jobs = []
        for p in people:
            want = (max_per_person or len(p.ranked)) - len(kept[p.name])
            take = p.ranked[used[p.name]: used[p.name] + max(want, 0)]
            used[p.name] += len(take)
            jobs += [(p.name, i) for i in take]
        if not jobs:
            break
        results = _run_all(jobs, RENDER_THREADS, lambda job: _verified_crop(pool, paths[faces[job[1]].photo],
                                                                            faces[job[1]]),
                           None, "crops", _Progress("crops", len(jobs)))
        for (name, i), (outcome, _) in zip(jobs, results):
            data, margin, why = outcome
            if data is None:
                rejected[why] += 1
                continue
            retried += margin != CROP_MARGINS[0]
            kept[name].append((i, data))
    return {"kept": kept, "retried": retried, "rejected": dict(rejected)}


def photo_paths(source: Path, image_exts, limit: int) -> list[Path]:
    """Every photo under `source`, including subfolders, except in folders of face crops from an earlier run."""
    listing = sorted(source.rglob("*"))
    crops = people_dirs(listing)
    paths = [p for p in listing if p.is_file() and p.suffix.lower() in image_exts]
    if crops:
        paths = [p for p in paths if not crops.intersection(p.resolve().parents)]
    return paths[:limit or None]


def check_output(source: Path, output: Path) -> Path:
    output = Path(output).expanduser().resolve()
    if output == source or output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError(f"the people folder and the photos folder must be separate folders: {output}")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError(f"the people folder must be new or empty, so that nothing you renamed is overwritten: "
                         f"{output}")
    return output


def write_people(output: Path, people: list[Person], kept: dict, paths: list[Path], faces: list[Face],
                 details: dict) -> int:
    """Write the folders and, last, the marker; all or nothing (a failure removes what this run made). A folder that
    is already there is never written into. Returns the number of crops written."""
    runctl.checkpoint()
    made_output, created, count = not output.exists(), [], 0
    with runctl.no_interrupt():
        try:
            output.mkdir(parents=True, exist_ok=True)
            for person in people:
                if not kept[person.name]:
                    continue
                folder = output / person.name
                folder.mkdir()
                created.append(folder)
                names = set()
                for i, data in kept[person.name]:
                    stem = paths[faces[i].photo].stem
                    name, n = f"{stem}.jpg", 1
                    while name.lower() in names:
                        n += 1
                        name = f"{stem}-{n}.jpg"
                    names.add(name.lower())
                    (folder / name).write_bytes(data)
                    count += 1
            marker = output / PEOPLE_MARKER
            created.append(marker)
            marker.write_text(json.dumps({
                "note": "PhotoSort people folder (faces-discover): sort --recursive, group, index and faces leave "
                        "the pictures in it alone. Keep this file.",
                "format": FORMAT, "created": datetime.now().isoformat(timespec="seconds"), **details,
                "people": len(created) - 1}, indent=2), encoding="utf-8")
        except BaseException:
            for item in created:
                if item.is_dir():
                    shutil.rmtree(item, ignore_errors=True)
                else:
                    item.unlink(missing_ok=True)
            if made_output:
                try:
                    output.rmdir()
                except OSError:
                    pass
            raise
    return count


def _detect_photos(pool, paths: list[Path]) -> tuple[list[Face], Counter, dict]:
    faces, skipped, counts = [], Counter(), Counter()
    progress = _Progress("detect", len(paths))
    for start in range(0, len(paths), DETECT_CHUNK):
        part = paths[start:start + DETECT_CHUNK]
        results = _detect_all(pool, part, "faces", lambda done, base=start: progress(base + done))
        for n, (path, (found, error)) in enumerate(zip(part, results), start):
            if error is not None:
                counts["errors"] += 1
                log.warning("cannot read %s: %s", path.name, error)
                continue
            counts["found"] += len(found)
            counts["with_faces"] += bool(found)
            faces += usable_faces(n, found, skipped)
    return faces, skipped, counts


def discover_people(source: Path, output: Path, image_exts, similarity: float = DEFAULT_SIMILARITY,
                    min_photos: int = DEFAULT_MIN_PHOTOS, max_per_person: int = DEFAULT_MAX_PER_PERSON,
                    limit: int = 0, dry_run: bool = False, model: str = "buffalo_l", model_dir: Path | None = None,
                    backend=None, workers=("local",)) -> dict:
    """Find the people in the photos under `source` and write a folder of face crops for each into `output`
    (which must be new or empty). With dry_run, find them and report, and write nothing. Photos are only read."""
    started_at, t0 = datetime.now(), time.perf_counter()
    source = Path(source).expanduser().resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    if limit < 0 or max_per_person < 0 or min_photos < 1 or not 0 < similarity < 1:
        raise ValueError("--limit and --max-per-person must be 0 or more, --min-photos at least 1, "
                         "and --similarity between 0 and 1")
    output = check_output(source, output)
    specs = parse_workers(workers)
    runctl.emit("phase", name="scan")
    paths = photo_paths(source, set(image_exts), limit)
    if not paths:
        raise FaceTaggingError(f"no photos found under {source}")
    owned = backend is None
    if owned:
        runctl.emit("phase", name="workers")
        backend = WorkerPool.start(specs, model, model_dir)
    try:
        faces, skipped, counts = _detect_photos(backend, paths)
        left_out = max(0, len(faces) - MAX_CLUSTERED)
        if left_out:  # keep the clearest faces; the others are not compared
            keep = sorted(sorted(range(len(faces)), key=lambda i: -faces[i].quality)[:MAX_CLUSTERED])
            faces = [faces[i] for i in keep]
        runctl.checkpoint()
        runctl.emit("phase", name="cluster", total=len(faces))
        merges = average_linkage(np.stack([f.vector for f in faces])) if faces else []
        photo_of = [f.photo for f in faces]
        sweep = [(level, sum(len({photo_of[i] for i in g}) >= min_photos for g in cut(merges, len(faces), level)))
                 for level in SWEEP]
        people, small, over = find_people(faces, merges, similarity, min_photos, max_per_person)
        log.info("%d photos, %d faces (%d compared): %d people, %d smaller groups left out", len(paths),
                 counts["found"], len(faces), len(people), small)
        made = {"kept": {}, "retried": 0, "rejected": {}}
        if people and not dry_run:
            made = make_crops(backend, people, faces, paths, max_per_person)
        provider, workers_used = getattr(backend, "provider", "local"), (
            backend.summary() if hasattr(backend, "summary") else [])
    finally:
        if owned:
            backend.close()

    written = 0
    kept = made["kept"]
    folders = [p for p in people if kept.get(p.name)]
    if folders and not dry_run:
        runctl.emit("phase", name="write", total=len(folders))
        output = check_output(source, output)
        written = write_people(output, folders, kept, paths, faces, {
            "model": model, "similarity": similarity, "min_photos": min_photos, "max_per_person": max_per_person})
    finished_at = datetime.now()
    return {
        "model": model, "provider": provider, "workers": workers_used,
        "similarity": similarity, "min_photos": min_photos, "max_per_person": max_per_person, "dry_run": dry_run,
        "photos": len(paths), "with_faces": counts["with_faces"], "errors": counts["errors"],
        "faces": counts["found"], "compared": len(faces), "skipped": dict(skipped), "not_compared": left_out,
        "small_groups": small, "over_limit": over, "sweep": sweep, "similar": similar_people(people),
        "people": [{"name": p.name, "photos": p.photos, "faces": len(p.members), "crops": len(kept.get(p.name, []))}
                   for p in people],
        "folders": len(folders), "crops": written, "retried": made["retried"], "rejected": made["rejected"],
        "started_at": started_at.isoformat(timespec="seconds"),
        "finished_at": finished_at.isoformat(timespec="seconds"),
        "duration_s": round(time.perf_counter() - t0, 1), "output": str(output),
    }


def format_discover_report(result: dict) -> str:
    r = result
    speed = r["photos"] / r["duration_s"] * 60 if r["duration_s"] > 0 else 0.0
    left_out = ", ".join(f"{n} {why}" for why, n in sorted(r["skipped"].items(), key=lambda t: -t[1]))
    lines = [
        "",
        "=== PhotoSort face-discovery report ===",
        f"Model       : {r['model']} ({r['provider']})",
        f"Photos      : {r['photos']} scanned; {r['with_faces']} with faces; {r['errors']} errors",
        f"Faces       : {r['faces']} found; {r['compared']} clear enough to compare"
        + (f" (left out: {left_out})" if left_out else "")
        + (f"; {r['not_compared']} more not compared (the clearest {r['compared']} were kept)"
           if r["not_compared"] else ""),
        f"People      : {len(r['people'])} with at least {r['min_photos']} photos, at similarity "
        f"{r['similarity']:g}; {r['small_groups']} smaller groups left out"
        + (f"; {r['over_limit']} more people not written (limit {MAX_PEOPLE})" if r["over_limit"] else ""),
        "Cut-offs    : " + "   ".join(f"{level:.2f} -> {n}" for level, n in r["sweep"]) + "   (people per similarity)",
    ]
    if r["dry_run"]:
        lines.append("Crops       : none (dry run: nothing was written)")
    else:
        failed = ", ".join(f"{n} {why}" for why, n in sorted(r["rejected"].items(), key=lambda t: -t[1]))
        no_folder = len(r["people"]) - r["folders"]
        lines.append(f"Crops       : {r['crops']} in {r['folders']} folders (up to {r['max_per_person'] or 'all'} "
                     f"per person); {r['retried']} cut with another margin"
                     + (f"; failed the one-face check, so replaced or left out: {failed}" if failed else "")
                     + (f"; {no_folder} {'person' if no_folder == 1 else 'people'} got no folder "
                        "because no crop passed (listed below with 0 crops)" if no_folder else ""))
    lines += [f"Duration    : {r['duration_s']:.1f}s  (started {r['started_at'].replace('T', ' ')}, "
                              f"finished {r['finished_at'].replace('T', ' ')})",
              f"Speed       : {speed:.0f} photos/min"]
    for worker in r["workers"]:
        failed = f"  FAILED: {worker['failed']}" if worker.get("failed") else ""
        lines.append(f"Worker      : {worker['worker']} ({worker.get('host') or '?'}, {worker['provider']}, "
                     f"{worker['threads']} threads): {worker['images']} images{failed}")
    lines.append(f"Output      : {r['output']}")
    if r["people"]:
        lines += ["", "People" + ("" if r["dry_run"] else " (folder, photos, crops)")]
        lines += [f"  {p['name']}  {p['photos']:>5} photos" + ("" if r["dry_run"] else f"  {p['crops']:>3} crops")
                  for p in r["people"]]
    if r["similar"]:
        lines += ["", "May be the same person (merge the folders if so)"]
        lines += [f"  {a} + {b}  {s:.2f}" for a, b, s in r["similar"]]
    if r["people"] and not r["dry_run"]:
        lines += ["", "Next: rename the folders to the people's names (delete any that are not people you want), "
                      "then run: photosort.cmd faces <folder> --people \"" + r["output"] + "\" --recursive"]
    return "\n".join(lines)
