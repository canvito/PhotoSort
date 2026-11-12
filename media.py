"""Read photos and videos for the local models. Files are only read; nothing on disk is written or re-encoded.

Videos are decoded on this PC with PyAV (bundled FFmpeg), and models see sampled frames:
- bucket sorting and search captions: VIDEO_FRAMES frames spread evenly over the video, in one request;
- face tagging: every keyframe, plus extra frames wherever keyframes are more than ~1 s apart.
Frames are turned upright using the video's rotation flag, the way photos use EXIF orientation.
"""
from __future__ import annotations

import base64
import bisect
import io
import struct
import zlib
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import numpy as np
from PIL import Image

try:
    import av
except ImportError:  # optional, like HEIC support: without PyAV videos are left in place
    av = None

VIDEO_EXTS = ({".mov", ".mp4", ".m4v", ".3gp", ".avi", ".mkv", ".webm", ".wmv", ".mts", ".m2ts", ".mpg", ".mpeg"}
              if av else set())
# Each frame costs ~280 tokens on gemma4, so 8 frames fit the 4096-token context the cluster already serves;
# a larger context would make PAIR nodes reload the model.
VIDEO_FRAMES = 8
FACE_FRAME_SPACING_S = 1.0
# faces-discover writes this file into the folder of face crops it makes; every scan (sort --recursive, group,
# index, faces) leaves such a folder and everything under it alone.
PEOPLE_MARKER = "_photosort_people.json"
_TRANSPOSE = {90: Image.Transpose.ROTATE_90, 180: Image.Transpose.ROTATE_180, 270: Image.Transpose.ROTATE_270}


class VideoError(RuntimeError):
    pass


def is_video(path) -> bool:
    return Path(path).suffix.lower() in VIDEO_EXTS


def people_dirs(listing) -> set[Path]:
    """Folders of face crops among a scan's `listing` of paths: the ones that hold a PEOPLE_MARKER file."""
    return {Path(p).parent.resolve() for p in listing if Path(p).name == PEOPLE_MARKER}


def encode_pil(im: Image.Image, max_side: int) -> str:
    """Downscale to max_side, flatten transparency, and return a base64 JPEG for the model."""
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


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))


def png_bytes(im: Image.Image) -> bytes:
    """Lossless, full-resolution RGB PNG for face detection. Every row uses the PNG "Up" filter: on video
    frames that is ~25% smaller and a little faster than Pillow's encoder, with identical pixels."""
    rows = np.asarray(im.convert("RGB"))
    height, width = rows.shape[:2]
    rows = rows.reshape(height, width * 3)
    data = np.empty((height, width * 3 + 1), np.uint8)
    data[:, 0] = 2  # filter type Up: each byte minus the byte above it
    data[0, 1:] = rows[0]
    np.subtract(rows[1:], rows[:-1], out=data[1:, 1:])
    return (b"\x89PNG\r\n\x1a\n" + _png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + _png_chunk(b"IDAT", zlib.compress(data.tobytes(), 1)) + _png_chunk(b"IEND", b""))


def _upright(frame) -> Image.Image:
    im = frame.to_image()
    angle = round(frame.rotation or 0) % 360  # counterclockwise degrees from the display matrix
    if angle in _TRANSPOSE:
        return im.transpose(_TRANSPOSE[angle])
    return im.rotate(angle, expand=True) if angle else im


def _frame_pts(container, stream) -> tuple[list[int], set[int]]:
    """Presentation timestamps of all frames and of the keyframes, read from packets without decoding."""
    pts, keys = [], set()
    for packet in container.demux(stream):
        if packet.pts is None or not packet.size or packet.is_discard:
            continue
        pts.append(packet.pts)
        if packet.is_keyframe:
            keys.add(packet.pts)
    return sorted(pts), keys


def _spread(pts: list[int], keys: set[int], count: int) -> list[int]:
    """`count` frames nearest to evenly spaced times; keyframes (complete, sharpest frames) when there are enough."""
    def nearest(pool: list[int]) -> list[int]:
        chosen = []
        for i in range(count):
            t = pts[0] + (i + 0.5) * (pts[-1] - pts[0]) / count
            j = bisect.bisect_left(pool, t)
            best = min(pool[max(j - 1, 0):j + 1], key=lambda p: abs(p - t))
            if best not in chosen:
                chosen.append(best)
        return chosen

    picked = nearest(sorted(keys)) if len(keys) >= count else []
    return picked if len(picked) == count else nearest(pts)


def _face_targets(pts: list[int], keys: set[int], step: int) -> list[int]:
    """Every keyframe, plus a frame wherever the previous pick is `step` old and no keyframe is coming soon."""
    keylist = sorted(keys)
    chosen, last = [], None
    for p in pts:
        if p in keys:
            chosen.append(p)
            last = p
            continue
        i = bisect.bisect_right(keylist, p)
        next_key = keylist[i] if i < len(keylist) else None
        if (last is None or p - last >= step) and (next_key is None or next_key - p > step // 2):
            chosen.append(p)
            last = p
    return chosen


def _decode_at(container, stream, target: int):
    container.seek(target, stream=stream, backward=True)  # lands on the keyframe at or before target
    for frame in container.decode(stream):
        if frame.pts is not None and frame.pts >= target:
            return frame
    return None


@contextmanager
def _open_video(path, decoder_threads: int = 0):
    if av is None:
        raise VideoError("video support needs PyAV: pip install av")
    try:
        with av.open(str(path)) as container:
            if not container.streams.video:
                raise VideoError("no video stream")
            stream = container.streams.video[0]
            stream.thread_count = decoder_threads  # 0 = FFmpeg decides
            yield container, stream
    except av.FFmpegError as e:
        raise VideoError(f"cannot decode video: {e}") from e


def video_tags(path) -> dict[str, str]:
    """The video's metadata tags (e.g. creation_time, com.apple.quicktime.creationdate); container tags win over
    the video stream's. Nothing is decoded."""
    with _open_video(path) as (container, stream):
        return {**stream.metadata, **container.metadata}


def video_targets(path, count: int | None = VIDEO_FRAMES) -> list[tuple[int, float]]:
    """(timestamp, seconds from start) of the frames to sample, in time order. count=None: face-tagging frames."""
    with _open_video(path) as (container, stream):
        pts, keys = _frame_pts(container, stream)
        if not pts:
            raise VideoError("no video frames")
        tb = stream.time_base
        targets = (_spread(pts, keys, count) if count
                   else _face_targets(pts, keys, max(1, round(FACE_FRAME_SPACING_S / tb))))
        return [(t, float((t - pts[0]) * tb)) for t in targets]


def frames_at(path, picks: list[tuple[int, float]], decoder_threads: int = 0) -> Iterator[tuple[float, Image.Image]]:
    """Decode the picked frames (from video_targets) and yield (seconds, upright RGB frame)."""
    with _open_video(path, decoder_threads) as (container, stream):
        for target, seconds in picks:
            frame = _decode_at(container, stream, target)
            if frame is not None:
                yield seconds, _upright(frame)


def video_frames(path, count: int | None = VIDEO_FRAMES) -> Iterator[tuple[float, Image.Image]]:
    """Yield (seconds, upright RGB frame) in time order. count=None samples for face tagging."""
    yield from frames_at(path, video_targets(path, count))


def frame_pngs(path, picks: list[tuple[int, float]]) -> list[tuple[float, bytes]]:
    """(seconds, lossless PNG) for the picked frames. Runs in a worker process during face tagging, so the
    decoder gets one thread: parallelism comes from the processes."""
    return [(seconds, png_bytes(im)) for seconds, im in frames_at(path, picks, decoder_threads=1)]


def video_jpegs(path, max_side: int, count: int = VIDEO_FRAMES) -> list[str]:
    frames = [encode_pil(im, max_side) for _, im in video_frames(path, count)]
    if not frames:
        raise VideoError("no decodable frames")
    return frames
