"""PhotoSort face worker: InsightFace face detection and embeddings served over stdin/stdout.

Runs on this PC or on a LAN node through SSH (`photosort faces --workers spark1:16`). Images arrive as
bytes and are decoded in memory; the worker writes nothing to disk and never downloads models. Matching
embeddings against reference people happens in the coordinator (face_tagger.py), not here.

Transport: stdin/stdout for a local worker; for SSH workers, a 127.0.0.1 port reached through `ssh -L`
and unlocked by a one-time token sent over SSH stdin.
Wire format, both directions: 8-byte header `>II` (JSON length, payload length), JSON, payload.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import io
import json
import os
import queue
import socket
import struct
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageOps

try:
    import pillow_heif

    pillow_heif.register_heif_opener()
except ImportError:
    pass

PROTOCOL = 1
_FRAME = struct.Struct(">II")
MAX_HEADER_BYTES = 1 << 20
MAX_PAYLOAD_BYTES = 512 << 20


class FaceTaggingError(RuntimeError):
    pass


class InsightFaceBackend:
    """Run InsightFace models that are already installed on this machine."""

    def __init__(self, model: str = "buffalo_l", model_dir: Path | None = None):
        root = Path(model_dir or Path.home() / ".insightface").expanduser().resolve()
        pack = root / "models" / model
        required = ("det_10g.onnx", "w600k_r50.onnx")
        if not pack.is_dir() or any(not (pack / name).is_file() for name in required):
            raise FaceTaggingError(
                f"local InsightFace model '{model}' is missing under {pack}. "
                "Install the model pack first; PhotoSort will not download models while tagging."
            )
        try:
            import onnxruntime as ort
            from insightface.app import FaceAnalysis
        except ImportError as e:
            raise FaceTaggingError(
                "face-tagging dependencies are missing; install PhotoSort/requirements-faces.txt"
            ) from e

        available = ort.get_available_providers()
        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in available]
        if not providers:
            raise FaceTaggingError(f"no supported ONNX Runtime provider found (available: {available})")
        self.provider = providers[0]
        self._np = __import__("numpy")
        self._app = FaceAnalysis(name=model, root=str(root), allowed_modules=["detection", "recognition"],
                                 providers=providers)
        self._app.prepare(ctx_id=0 if self.provider == "CUDAExecutionProvider" else -1, det_size=(640, 640))

    def detect(self, source) -> list[dict]:
        """Detect faces in an image path or in encoded image bytes."""
        stream = io.BytesIO(source) if isinstance(source, (bytes, bytearray, memoryview)) else source
        with Image.open(stream) as im:
            rgb = ImageOps.exif_transpose(im).convert("RGB")
            image = self._np.asarray(rgb)[:, :, ::-1].copy()
        observations = []
        for face in self._app.get(image):
            embedding = getattr(face, "normed_embedding", None)
            if embedding is None:
                embedding = face.embedding
            observations.append({
                "embedding": embedding,
                "bbox": [round(float(v), 1) for v in face.bbox],
            })
        return observations


def encode_embedding(values) -> str:
    floats = values.tolist() if hasattr(values, "tolist") else list(values)
    return base64.b64encode(struct.pack(f"<{len(floats)}f", *map(float, floats))).decode("ascii")


def decode_embedding(text: str) -> list[float]:
    raw = base64.b64decode(text, validate=True)
    if not raw or len(raw) % 4:
        raise ValueError("invalid embedding encoding")
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def write_frame(stream, header: dict, payload: bytes = b"") -> None:
    data = json.dumps(header, separators=(",", ":")).encode("utf-8")
    stream.write(_FRAME.pack(len(data), len(payload)))
    stream.write(data)
    if payload:
        stream.write(payload)
    stream.flush()


def _read_exact(stream, size: int, at_frame_start: bool = False) -> bytes | None:
    buf = bytearray()
    while len(buf) < size:
        chunk = stream.read(size - len(buf))
        if not chunk:
            if at_frame_start and not buf:
                return None
            raise EOFError("connection closed in the middle of a frame")
        buf += chunk
    return bytes(buf)


def read_frame(stream) -> tuple[dict, bytes] | None:
    """Read one frame; returns None on a clean end of stream."""
    head = _read_exact(stream, _FRAME.size, at_frame_start=True)
    if head is None:
        return None
    header_len, payload_len = _FRAME.unpack(head)
    if header_len > MAX_HEADER_BYTES or payload_len > MAX_PAYLOAD_BYTES:
        raise ValueError(f"frame too large ({header_len} + {payload_len} bytes)")
    header = json.loads(_read_exact(stream, header_len))
    payload = _read_exact(stream, payload_len) if payload_len else b""
    return header, payload


def source_sha256() -> str:
    """Hash of this file with LF line endings; the coordinator uses it to redeploy stale workers."""
    return hashlib.sha256(Path(__file__).read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def _load_backends(make_backend, sessions: int) -> list:
    with ThreadPoolExecutor(max_workers=sessions) as loader:
        return list(loader.map(lambda _: make_backend(), range(sessions)))


def _ready_header(threads: int, backends: list) -> dict:
    return {"type": "ready", "protocol": PROTOCOL, "host": socket.gethostname(), "threads": threads,
            "sessions": len(backends), "provider": getattr(backends[0], "provider", "unknown"),
            "sha256": source_sha256()}


def _fatal(out, error: Exception | str) -> int:
    message = error if isinstance(error, str) else f"{type(error).__name__}: {error}"
    write_frame(out, {"type": "fatal", "error": message})
    return 2


def _serve_requests(inp, out, threads: int, backends: list) -> None:
    write_lock = threading.Lock()
    idle = queue.Queue()
    for backend in backends:
        idle.put(backend)

    def handle(header: dict, payload: bytes) -> None:
        reply = {"type": "result", "id": header.get("id")}
        backend = idle.get()
        try:
            reply["faces"] = [{"bbox": f["bbox"], "embedding": encode_embedding(f["embedding"])}
                              for f in backend.detect(payload)]
        except Exception as e:  # one bad image must not stop the worker
            reply["error"] = f"{type(e).__name__}: {str(e)[:200]}"
        finally:
            idle.put(backend)
        try:
            with write_lock:
                write_frame(out, reply)
        except OSError:
            pass  # coordinator went away; the read loop ends on EOF

    with ThreadPoolExecutor(max_workers=threads) as pool:
        while (frame := read_frame(inp)) is not None:
            header, payload = frame
            if header.get("type") == "detect":
                pool.submit(handle, header, payload)


def serve(inp, out, threads: int, make_backend, sessions: int = 0) -> int:
    """Answer detect requests from `inp` on `threads` threads, sharing `sessions` model instances."""
    threads = max(1, threads)
    sessions = max(1, min(sessions or threads, threads))
    try:
        backends = _load_backends(make_backend, sessions)
    except Exception as e:  # report setup problems to the coordinator instead of dying silently
        return _fatal(out, e)
    write_frame(out, _ready_header(threads, backends))
    _serve_requests(inp, out, threads, backends)
    return 0


def _exit_when_closed(stream) -> None:
    while stream.read(65536):
        pass
    os._exit(0)  # the SSH session ended: stop instead of lingering with GPU memory held


def _recv_exact(conn: socket.socket, size: int) -> bytes:
    buf = bytearray()
    while len(buf) < size and (chunk := conn.recv(size - len(buf))):
        buf += chunk
    return bytes(buf)


def serve_socket(port: int, token: bytes, threads: int, make_backend, control_in, control_out,
                 sessions: int = 0) -> int:
    """Like serve(), but data flows over one 127.0.0.1:port connection that must present `token` first.

    The coordinator reaches the port through `ssh -L`, which is far faster than SSH stdin/stdout on Windows.
    Control messages (ready/fatal) still go to control_out; EOF on control_in (SSH gone) stops the worker.
    """
    threads = max(1, threads)
    sessions = max(1, min(sessions or threads, threads))
    if len(token) < 16:
        return _fatal(control_out, "missing or short session token")
    try:
        server = socket.create_server(("127.0.0.1", port))
    except OSError as e:
        return _fatal(control_out, f"cannot listen on 127.0.0.1:{port}: {e}")
    try:
        backends = _load_backends(make_backend, sessions)
    except Exception as e:
        return _fatal(control_out, e)
    write_frame(control_out, _ready_header(threads, backends))
    threading.Thread(target=_exit_when_closed, args=(control_in,), daemon=True).start()
    server.settimeout(60)
    try:
        for _ in range(5):
            conn, _ = server.accept()
            conn.settimeout(10)
            try:
                presented = _recv_exact(conn, len(token))
            except OSError:
                presented = b""
            if hmac.compare_digest(presented, token):
                break
            conn.close()
        else:
            return 2
    except OSError:
        return 2
    finally:
        server.close()
    conn.settimeout(None)
    conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    with conn, conn.makefile("rb") as inp, conn.makefile("wb") as out:
        _serve_requests(inp, out, threads, backends)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--threads", type=int, default=8, help="images processed concurrently")
    ap.add_argument("--sessions", type=int, default=0, help="model instances shared by the threads (0 = threads)")
    ap.add_argument("--model", default="buffalo_l")
    ap.add_argument("--model-dir", type=Path)
    ap.add_argument("--listen", type=int, default=0,
                    help="serve data on 127.0.0.1:PORT (token read from stdin) instead of stdin/stdout")
    a = ap.parse_args(argv)
    # stdout carries the binary protocol; route stray prints from libraries to stderr instead.
    out = os.fdopen(os.dup(sys.stdout.fileno()), "wb")
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    sys.stdout = sys.stderr

    def make_backend():
        return InsightFaceBackend(a.model, a.model_dir)

    if a.listen:
        token = sys.stdin.buffer.readline().strip()
        return serve_socket(a.listen, token, a.threads, make_backend, sys.stdin.buffer, out, a.sessions)
    return serve(sys.stdin.buffer, out, a.threads, make_backend, a.sessions)


if __name__ == "__main__":
    sys.exit(main())
