"""Local, metadata-free display previews. These never replace media sent to inference."""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

from PIL import Image, ImageOps

from media import frames_at, is_video, video_targets

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:
    pass

PLACEHOLDER_FLAGS = 0x1000 | 0x40000 | 0x400000  # OFFLINE, RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS


class MediaUnavailable(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def media_stat(path: Path, require_local: bool = True):
    try:
        st = path.stat()
    except OSError:
        raise MediaUnavailable("missing") from None
    if not path.is_file():
        raise MediaUnavailable("missing")
    if require_local and is_placeholder(st):
        raise MediaUnavailable("placeholder")
    return st


def is_placeholder(st) -> bool:
    return bool(getattr(st, "st_file_attributes", 0) & PLACEHOLDER_FLAGS)


def revision(st) -> str:
    return f"{st.st_size:x}-{st.st_mtime_ns:x}"


def low_priority() -> None:
    if os.name == "nt":
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x4000)
    else:
        os.nice(10)


def _rgb(im: Image.Image, size: int) -> Image.Image:
    im.thumbnail((size, size), Image.Resampling.LANCZOS)
    rgba = im.convert("RGBA")
    clean = Image.new("RGB", rgba.size, "white")
    clean.paste(rgba, mask=rgba.getchannel("A"))
    return clean


def make_thumb(path: str, kind: str, out: str, expected: str) -> dict:
    source, target = Path(path), Path(out)
    st = media_stat(source)  # recheck after waiting for a worker; never hydrate placeholders
    if revision(st) != expected:
        raise MediaUnavailable("changed")
    size = 256 if kind == "thumb" else 1600
    if is_video(source):
        picks = video_targets(source, 8 if kind == "strip" else 1)
        images = [_rgb(im, 320 if kind == "strip" else size)
                  for _, im in frames_at(source, picks, decoder_threads=1)]
        if not images:
            raise MediaUnavailable("undecodable")
        if kind == "strip":
            clean = Image.new("RGB", (320 * min(4, len(images)), 240 * ((len(images) + 3) // 4)), "#171923")
            for i, im in enumerate(images):
                clean.paste(im, ((i % 4) * 320, (i // 4) * 240))
        else:
            clean = images[0]
    else:
        with Image.open(source) as im:
            im.draft("RGB", (size, size))
            clean = _rgb(ImageOps.exif_transpose(im), size)
    if revision(media_stat(source)) != expected:
        raise MediaUnavailable("changed")
    temp = target.with_suffix(f".{secrets.token_hex(4)}.tmp")
    try:
        # `clean` is a fresh image: EXIF, GPS, XMP and ICC are not copied.
        clean.save(temp, "WEBP", quality=80 if kind == "thumb" else 82)
        os.replace(temp, target)
    finally:
        temp.unlink(missing_ok=True)
    return {"width": clean.width, "height": clean.height}


class ThumbCache:
    def __init__(self, root: Path, limit_bytes: int = 3 * 1024 ** 3, workers: int = 3):
        self.root, self.limit = Path(root), limit_bytes
        self.root.mkdir(parents=True, exist_ok=True)
        self.workers = min(3, workers)
        self.pool = None
        self.lock = threading.RLock()
        self.pending = {}
        self.last_sweep = 0.0
        self.bytes = self.files = 0
        self.sweep()

    def sweep(self) -> None:
        with self.lock:
            files = []
            for p in self.root.glob("*.webp"):
                try:
                    st = p.stat()
                    files.append((st.st_mtime, st.st_size, p))
                except OSError:
                    continue
            self.bytes, self.files = sum(s for _, s, _ in files), len(files)
            if self.bytes > self.limit:
                for _, size, p in sorted(files):
                    try:
                        p.unlink()
                        self.bytes -= size
                        self.files -= 1
                    except OSError:
                        pass
                    if self.bytes <= self.limit * .8:
                        break
            self.last_sweep = time.monotonic()

    def info(self) -> dict:
        return {"bytes": self.bytes, "files": self.files, "limitBytes": self.limit}

    def get(self, path: Path, kind: str, expected: str) -> Path:
        if revision(media_stat(path)) != expected:
            raise MediaUnavailable("changed")
        self.maintain()
        key = hashlib.sha256(f"{os.path.normcase(str(path))}|{expected}|{kind}|v1".encode()).hexdigest()
        out = self.root / f"{key}.webp"
        with self.lock:
            if out.exists():
                if time.time() - out.stat().st_mtime > 3600:
                    out.touch()
                return out
            future = self.pending.get(key)
            if future is None:
                if self.pool is None:
                    self.pool = ProcessPoolExecutor(self.workers, initializer=low_priority)
                future = self.pool.submit(make_thumb, str(path), kind, str(out), expected)
                self.pending[key] = future
        try:
            future.result()
        except BrokenProcessPool:
            with self.lock:
                if self.pool:
                    self.pool.shutdown(wait=False, cancel_futures=True)
                    self.pool = None
            raise MediaUnavailable("undecodable") from None
        finally:
            with self.lock:
                owner = self.pending.pop(key, None) is not None
        with self.lock:
            if owner and out.exists():
                self.bytes += out.stat().st_size
                self.files += 1
            # A sweep cannot evict the response being served; trim on the next request/stats tick.
        return out

    def clear(self) -> None:
        with self.lock:
            if self.pending:
                raise MediaUnavailable("busy")
            for p in self.root.glob("*.webp"):
                p.unlink(missing_ok=True)
            self.sweep()

    def maintain(self) -> None:
        if not self.pending and (self.bytes > self.limit or time.monotonic() - self.last_sweep > 3600):
            self.sweep()

    def close(self) -> None:
        if self.pool:
            self.pool.shutdown(wait=True, cancel_futures=True)
