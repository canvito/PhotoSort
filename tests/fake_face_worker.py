"""A stand-in for face_worker.py that answers as InsightFace would, without a model.

The dashboard's fixture mode and the tests start it as the `local` face worker (face_tagger reads its path from
PHOTOSORT_FACE_WORKER). It speaks the real worker protocol (face_worker.serve), so everything except the model is
the code that runs for real: worker start-up, the pool, video frame sampling, matching and the report.

The synthetic pictures (dashboard\\fixtures\\make_fixtures.py) say who is in them with colour codes along the
top-right edge. Each face gets an 8-number embedding: one axis per identity (Alice, Bob, a stranger) plus a little
of a per-position axis, so the same person matches across pictures (similarity ~0.94) and different people do not.
It only reads the synthetic pictures; nothing is downloaded and nothing leaves this PC.
"""
from __future__ import annotations

import argparse
import io
import math
import os
import sys
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "dashboard" / "fixtures"))
from face_worker import serve  # noqa: E402
from make_fixtures import FACE_CODES, face_boxes, faces_of  # noqa: E402

DIMS = 8
IDENTITY_AXIS = {name: i for i, name in enumerate(FACE_CODES)}


def embedding(name: str, slot: int) -> list[float]:
    v = [0.0] * DIMS
    v[IDENTITY_AXIS[name]] = 1.0
    v[len(IDENTITY_AXIS) + slot % (DIMS - len(IDENTITY_AXIS))] = 0.25
    norm = math.sqrt(sum(x * x for x in v))
    return [x / norm for x in v]


class ColourFaceBackend:
    provider = "FakeColour"

    def detect(self, source) -> list[dict]:
        stream = io.BytesIO(source) if isinstance(source, (bytes, bytearray, memoryview)) else source
        with Image.open(stream) as im:
            rgb = ImageOps.exif_transpose(im).convert("RGB")
        names = faces_of(rgb)
        return [{"embedding": embedding(name, k), "bbox": box}
                for k, (name, box) in enumerate(zip(names, face_boxes(rgb.size, len(names))))]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--sessions", type=int, default=0)
    ap.add_argument("--model", default="buffalo_l")
    ap.add_argument("--model-dir", type=Path)
    a = ap.parse_args(argv)
    out = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr
    return serve(sys.stdin.buffer, out, a.threads, ColourFaceBackend, a.sessions)


if __name__ == "__main__":
    sys.exit(main())
