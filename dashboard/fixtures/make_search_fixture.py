"""Synthetic indexed library for gallery/31k performance checks. Never reads user media or calls a model."""
import argparse
import json
import os
import sys
import time
from contextlib import closing
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from photo_search import COLUMNS, open_index, to_blob, unit_rows  # noqa: E402
from dashboard.fixtures.make_fixtures import build, under_onedrive  # noqa: E402


def build_search(root: Path, count=31000, dims=4096):
    if under_onedrive(root):
        raise ValueError("Fixture data must stay outside OneDrive.")
    if root.exists() and any(root.iterdir()):
        raise ValueError("Use a new, empty fixture folder.")
    root.mkdir(parents=True, exist_ok=True)
    lib = root / "library"
    build(lib, 12)
    base = root / "synthetic.jpg"
    Image.new("RGB", (320, 240), "#53749c").save(base)
    rng = np.random.default_rng(42)
    vectors = [to_blob(v) for v in unit_rows(rng.normal(size=(32, dims)))]
    cfg = json.loads((Path(__file__).parents[2] / "config.json").read_text())
    cfg["index_path"] = str(root / "search_index.sqlite")
    cfg["base_url"] = "http://127.0.0.1:47617"
    cfg_path = root / "config.json"
    cfg_path.write_text(json.dumps(cfg), encoding="utf-8")
    files = sorted(lib.glob("*.jpg")) + sorted(lib.glob("*.png")) + sorted(lib.glob("*.mp4"))
    with closing(open_index(Path(cfg["index_path"]))) as db, db:
        for i in range(count):
            if i < len(files):
                p = files[i]
            else:
                p = lib / f"generated_{i:05}.jpg"
                if i % 1000 == 0:  # NTFS allows at most 1023 hard links per file
                    base = root / f"synthetic_{i // 1000}.jpg"
                    Image.new("RGB", (320, 240), "#53749c").save(base)
                os.link(base, p)
            st = p.stat()
            row = [str(p), st.st_size, st.st_mtime_ns, f"synthetic-{i}", cfg["caption_model"], cfg["embed_model"], 1,
                   f"Synthetic geometric shapes {i}", "Synthetic scene", '["shapes"]', "Fixture text", 0,
                   vectors[i % 32], vectors[(i + 1) % 32], "2026-11-10T12:00:00"]
            db.execute(f"INSERT INTO photos ({','.join(COLUMNS)}) VALUES ({','.join('?' * len(COLUMNS))})", row)
    return cfg_path


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--count", type=int, default=31000)
    ap.add_argument("--dims", type=int, default=4096)
    args = ap.parse_args()
    started = time.perf_counter()
    build_search(args.out.resolve(), args.count, args.dims)
    print(f"Search fixture: {args.count} rows, {args.dims} dimensions; {time.perf_counter() - started:.1f} s")
