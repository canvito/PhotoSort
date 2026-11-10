"""Build the synthetic media library the dashboard's fixture mode and tests use. No real photos are involved:
every image and video is drawn from scratch, with synthetic names and fixed capture dates.

    python dashboard\\fixtures\\make_fixtures.py [--out DIR] [--count N]

The default output is %LOCALAPPDATA%\\PhotoSort\\dashboard-fixture\\library (never inside OneDrive). Running it
again with the same options leaves an up-to-date library alone.
"""
import argparse
import json
import os
import random
import sys
import time
from datetime import datetime, timedelta
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageDraw

VERSION = 1
EXIF_IFD, DATETIME_ORIGINAL, OFFSET_TIME_ORIGINAL, ORIENTATION = 0x8769, 0x9003, 0x9011, 0x0112
KINDS = ["sunset", "receipt", "screenshot", "food", "portrait", "forest"]
PALETTES = {
    "sunset": [(255, 140, 60), (200, 60, 90), (40, 30, 80)],
    "receipt": [(250, 250, 245), (30, 30, 30), (200, 200, 200)],
    "screenshot": [(30, 32, 40), (90, 160, 255), (230, 230, 230)],
    "food": [(240, 220, 180), (200, 60, 40), (90, 160, 60)],
    "portrait": [(120, 160, 200), (230, 190, 160), (60, 40, 30)],
    "forest": [(30, 90, 40), (90, 150, 70), (170, 200, 120)],
}
START = datetime(2026, 10, 1, 9, 0, 0)


def default_out():
    return Path(os.path.expandvars(r"%LOCALAPPDATA%\PhotoSort\dashboard-fixture\library"))


def under_onedrive(path):
    target = str(Path(path).resolve()).lower().rstrip("\\/") + os.sep
    for key in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
        root = os.environ.get(key)
        if root and target.startswith(str(Path(root).resolve()).lower().rstrip("\\/") + os.sep):
            return True
    return False


def draw(kind, rng, size):
    bg, fg, accent = PALETTES[kind]
    im = Image.new("RGB", size, bg)
    d = ImageDraw.Draw(im)
    w, h = size
    if kind in ("sunset", "forest"):
        for y in range(0, h, 4):
            t = y / h
            d.line([(0, y), (w, y)], fill=tuple(int(a * (1 - t) + b * t) for a, b in zip(bg, accent)), width=4)
        d.ellipse([w * 0.6, h * 0.2, w * 0.8, h * 0.2 + w * 0.2], fill=fg)
    elif kind in ("receipt", "screenshot"):
        for i in range(12):
            y = 20 + i * (h - 40) // 12
            d.rectangle([20, y, 20 + rng.randint(w // 4, w - 40), y + 8], fill=fg if i % 3 else accent)
    elif kind == "food":
        d.ellipse([w * 0.2, h * 0.2, w * 0.8, h * 0.8], fill=accent)
        d.ellipse([w * 0.35, h * 0.35, w * 0.65, h * 0.65], fill=fg)
    else:
        d.ellipse([w * 0.35, h * 0.15, w * 0.65, h * 0.55], fill=fg)
        d.rectangle([w * 0.3, h * 0.55, w * 0.7, h], fill=accent)
    return im


def exif_for(when, orientation=1):
    exif = Image.Exif()
    exif[ORIENTATION] = orientation
    ifd = exif.get_ifd(EXIF_IFD)
    ifd[DATETIME_ORIGINAL] = when.strftime("%Y:%m:%d %H:%M:%S")
    ifd[OFFSET_TIME_ORIGINAL] = "-07:00"
    return exif


def make_video(path, colors, when, fps=10, size=(160, 120)):
    import av

    meta = {"com.apple.quicktime.creationdate": when.strftime("%Y-%m-%dT%H:%M:%S-0700")}
    with av.open(str(path), "w", options={"movflags": "use_metadata_tags"}) as out:
        out.metadata.update(meta)
        stream = out.add_stream("mpeg4", rate=fps)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        for i in range(len(colors) * fps):
            frame = av.VideoFrame.from_image(Image.new("RGB", size, colors[i // fps]))
            frame.pts, frame.time_base = i, Fraction(1, fps)
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)


def build(out, count, seed=7):
    """Create the library; returns the manifest. Names are synthetic: <kind>_<nnn>.<ext>."""
    rng = random.Random(seed)
    out.mkdir(parents=True, exist_ok=True)
    files = []
    for i in range(count):
        kind = KINDS[i % len(KINDS)]
        when = START + timedelta(days=i // 6, minutes=17 * i)
        size = (640, 480) if kind != "portrait" else (480, 640)
        im = draw(kind, rng, size)
        if kind == "screenshot":
            name = f"screenshot_{i:03d}.png"
            im.save(out / name)
        else:
            name = f"{kind}_{i:03d}.jpg"
            orientation = 6 if i % 11 == 5 else 1
            if orientation == 6:
                im = im.rotate(90, expand=True)
            im.save(out / name, quality=85, exif=exif_for(when, orientation))
        files.append({"name": name, "kind": kind, "taken": when.isoformat()})
    for j, colors in enumerate([[(255, 140, 60), (40, 30, 80)], [(30, 90, 40), (170, 200, 120), (250, 250, 245)]]):
        name = f"clip_{j:03d}.mp4"
        when = START + timedelta(days=j * 3, hours=5)
        make_video(out / name, colors, when)
        files.append({"name": name, "kind": "video", "taken": when.isoformat()})
    manifest = {"version": VERSION, "seed": seed, "count": count, "files": files}
    (out / "fixture_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build the dashboard's synthetic fixture library.")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--count", type=int, default=48)
    args = ap.parse_args(argv)
    out = args.out or default_out()
    if under_onedrive(out):
        print("refusing: the fixture library must not be inside OneDrive", file=sys.stderr)
        return 2
    started = time.perf_counter()
    manifest_path = out / "fixture_manifest.json"
    try:
        current = json.loads(manifest_path.read_text(encoding="utf-8"))
        if (current.get("version"), current.get("count")) == (VERSION, args.count) and all(
                (out / f["name"]).is_file() for f in current["files"]):
            print(f"fixture library up to date: {len(current['files'])} files")
            return 0
    except (OSError, ValueError, KeyError):
        pass
    manifest = build(out, args.count)
    print(f"fixture library built: {len(manifest['files'])} files in {time.perf_counter() - started:.1f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
