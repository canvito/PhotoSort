"""Face detection and reference-photo matching for PhotoSort.

Detection and embeddings run in face workers (face_worker.py): on this PC (`local`) and/or on LAN nodes
over SSH (e.g. `spark1:16`). Photos travel only inside the encrypted SSH stream, are decoded in the
worker's memory and are never stored there. Matching against the reference people happens here.
"""
from __future__ import annotations

import hashlib
import ipaddress
import itertools
import json
import logging
import math
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter, deque
from concurrent.futures import Future, ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from face_worker import PROTOCOL, FaceTaggingError, InsightFaceBackend, decode_embedding, read_frame, write_frame

__all__ = ["FaceTaggingError", "InsightFaceBackend", "WorkerPool", "format_face_report", "parse_workers",
           "setup_remote_worker", "tag_people"]

HERE = Path(__file__).resolve().parent
WORKER_FILE = HERE / "face_worker.py"
SETUP_SCRIPT = HERE / "face_worker_setup.sh"
REMOTE_PYTHON = "~/.photosort/venv/bin/python"
REMOTE_WORKER = "~/.photosort/face_worker.py"
DEFAULT_THREADS = 8
READY_TIMEOUT_S = 180
REQUEST_TIMEOUT_S = 300
SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
               "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]
_HOST_RE = re.compile(r"^[A-Za-z0-9_.@-]+$")

log = logging.getLogger("photosort")


class WorkerDied(FaceTaggingError):
    pass


class NoWorkersLeft(FaceTaggingError):
    pass


@dataclass(frozen=True)
class WorkerSpec:
    host: str
    threads: int

    @property
    def is_local(self) -> bool:
        return self.host == "local"


def parse_workers(value) -> list[WorkerSpec]:
    """Parse `spark1:16,local:2` (or a list of such items) into worker specs."""
    items = value.split(",") if isinstance(value, str) else list(value)
    specs = []
    for item in (str(i).strip() for i in items):
        if not item:
            continue
        host, sep, count = item.partition(":")
        if not _HOST_RE.match(host) or host.startswith("-"):
            raise ValueError(f"invalid face worker {item!r}; use HOST or HOST:THREADS, e.g. spark1:16 or local:2")
        try:
            threads = int(count) if sep else DEFAULT_THREADS
        except ValueError:
            raise ValueError(f"invalid thread count in face worker {item!r}") from None
        if not 1 <= threads <= 256:
            raise ValueError(f"face worker threads must be 1..256: {item!r}")
        specs.append(WorkerSpec(host, threads))
    if not specs:
        raise ValueError("no face workers given")
    if len({s.host for s in specs}) != len(specs):
        raise ValueError("list each face worker host once")
    return specs


def check_private_addresses(host: str, target: str, resolve=socket.getaddrinfo) -> list[str]:
    try:
        addresses = sorted({info[4][0] for info in resolve(target, 22)})
    except OSError as e:
        raise FaceTaggingError(f"cannot resolve face worker {host} ({target}): {e}") from e
    public = [a for a in addresses if ipaddress.ip_address(a.split("%")[0]).is_global]
    if not addresses or public:
        raise FaceTaggingError(f"refusing face worker {host}: {target} resolves to public address(es) "
                               f"{', '.join(public) or '(none)'}; photos may only go to LAN/VPN machines")
    return addresses


def ensure_lan_host(host: str) -> list[str]:
    """Refuse SSH workers whose address is on the public Internet, so photos stay on the user's network."""
    try:
        config = subprocess.run(["ssh", "-G", host], capture_output=True, text=True, timeout=15, check=True).stdout
    except (OSError, subprocess.SubprocessError) as e:
        raise FaceTaggingError(f"cannot read SSH config for {host}: {e}") from e
    target = next((line.split(None, 1)[1].strip() for line in config.splitlines()
                   if line.lower().startswith("hostname ")), host)
    return check_private_addresses(host, target)


def _free_local_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _popen(label: str, command: list[str]) -> subprocess.Popen:
    try:
        return subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        raise WorkerDied(f"{label}: cannot start {command[0]}: {e}") from e


class WorkerConnection:
    """One face worker process; detect requests are multiplexed by id over its data stream.

    The handshake (ready/fatal) always arrives on the process's stdout. Data then flows over the same
    pipes (local worker, tests) or over an `ssh -L` tunnel (SSH workers): Windows OpenSSH moves only
    ~10 MB/s through stdin/stdout but saturates gigabit Ethernet through a forwarded port.
    """

    def __init__(self, label: str, threads: int, process=None):
        self.label = label
        self.threads = threads
        self.process = process
        self.info: dict = {}
        self.error: str | None = None
        self._closing = False
        self._writer = self._reader = self._sock = None
        self._write_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._pending: dict[int, Future] = {}
        self._ids = itertools.count(1)
        self._stderr_tail: deque[str] = deque(maxlen=12)
        self._stderr_thread = None
        if process is not None and process.stderr is not None:
            self._stderr_thread = threading.Thread(target=self._drain_stderr, args=(process.stderr,), daemon=True)
            self._stderr_thread.start()

    @classmethod
    def over_streams(cls, label: str, writer, reader, threads: int, process=None,
                     ready_timeout: float = READY_TIMEOUT_S) -> "WorkerConnection":
        conn = cls(label, threads, process)
        conn.handshake(reader, ready_timeout)
        conn.attach(writer, reader)
        return conn

    @classmethod
    def spawn(cls, label: str, command: list[str], threads: int,
              ready_timeout: float = READY_TIMEOUT_S) -> "WorkerConnection":
        proc = _popen(label, command)
        return cls.over_streams(label, proc.stdin, proc.stdout, threads, proc, ready_timeout)

    @classmethod
    def spawn_tunneled(cls, host: str, remote_command: str, threads: int,
                       ready_timeout: float = READY_TIMEOUT_S) -> "WorkerConnection":
        token = secrets.token_hex(16).encode("ascii")
        local_port, remote_port = _free_local_port(), 20000 + secrets.randbelow(40000)
        proc = _popen(host, ["ssh", *SSH_OPTIONS, "-o", "ExitOnForwardFailure=yes",
                             "-L", f"127.0.0.1:{local_port}:127.0.0.1:{remote_port}", host,
                             f"{remote_command} --listen {remote_port}"])
        conn = cls(host, threads, proc)
        try:
            proc.stdin.write(token + b"\n")  # via SSH stdin, so the token never shows up in `ps`
            proc.stdin.flush()
        except OSError:
            pass  # the handshake below reports why the process went away
        conn.handshake(proc.stdout, ready_timeout)
        try:
            sock = socket.create_connection(("127.0.0.1", local_port), timeout=15)
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.sendall(token)
            sock.settimeout(None)
        except OSError as e:
            conn.error = f"cannot open the SSH tunnel: {e}"
            conn.terminate()
            raise WorkerDied(conn.describe_error()) from e
        conn.attach(sock.makefile("wb"), sock.makefile("rb"), sock)
        return conn

    @property
    def alive(self) -> bool:
        return self.error is None

    @property
    def provider(self) -> str:
        return str(self.info.get("provider", "unknown"))

    def describe_error(self) -> str:
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=2)
        tail = " | ".join(self._stderr_tail)
        return f"{self.label}: {self.error}" + (f" (stderr: {tail[-600:]})" if tail else "")

    def _drain_stderr(self, stream) -> None:
        for line in iter(stream.readline, b""):
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                self._stderr_tail.append(text)
                log.debug("%s: %s", self.label, text)

    def handshake(self, reader, timeout: float = READY_TIMEOUT_S) -> dict:
        box: dict = {}

        def read() -> None:
            try:
                box["frame"] = read_frame(reader)
            except Exception as e:  # reported below
                box["error"] = e

        thread = threading.Thread(target=read, daemon=True)
        thread.start()
        thread.join(timeout)
        header = (box.get("frame") or ({}, b""))[0]
        if thread.is_alive():
            problem = f"no ready message within {timeout:.0f}s"
        elif "error" in box:
            problem = f"{type(box['error']).__name__}: {box['error']}"
        elif not header:
            problem = "worker exited before it was ready"
        elif header.get("type") == "fatal":
            problem = str(header.get("error", "worker setup failed"))
        elif header.get("type") != "ready" or header.get("protocol") != PROTOCOL:
            problem = f"unexpected worker handshake: {str(header)[:200]}"
        else:
            self.info = header
            return header
        self.error = problem
        self.terminate()
        raise WorkerDied(self.describe_error())

    def attach(self, writer, reader, sock: socket.socket | None = None) -> None:
        self._writer, self._reader, self._sock = writer, reader, sock
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _read_loop(self) -> None:
        try:
            while (frame := read_frame(self._reader)) is not None:
                with self._state_lock:
                    future = self._pending.pop(frame[0].get("id"), None)
                if future is not None:
                    future.set_result(frame[0])
            raise EOFError("worker closed the connection")
        except Exception as e:  # any read problem means this worker is gone
            self._fail(f"{type(e).__name__}: {e}")

    def _fail(self, message: str) -> None:
        with self._state_lock:
            if self.error is None:
                self.error = "closed" if self._closing else message
            pending = list(self._pending.values())
            self._pending.clear()
        for future in pending:
            if not future.done():
                future.set_exception(WorkerDied(f"{self.label}: {message}"))

    def detect(self, data: bytes, timeout: float = REQUEST_TIMEOUT_S) -> list[dict]:
        future: Future = Future()
        with self._state_lock:
            if self.error is not None or self._writer is None:
                raise WorkerDied(f"{self.label}: {self.error or 'not connected'}")
            request_id = next(self._ids)
            self._pending[request_id] = future
        try:
            with self._write_lock:
                write_frame(self._writer, {"type": "detect", "id": request_id}, data)
        except (OSError, ValueError) as e:  # ValueError: stream already closed
            self._fail(f"{type(e).__name__}: {e}")
            raise WorkerDied(f"{self.label}: {e}") from e
        try:
            reply = future.result(timeout)
        except FutureTimeout:
            with self._state_lock:
                self._pending.pop(request_id, None)
            raise FaceTaggingError(f"{self.label}: no reply within {timeout:.0f}s") from None
        if "error" in reply:
            raise FaceTaggingError(f"{self.label}: {reply['error']}")
        return [{"embedding": decode_embedding(f["embedding"]), "bbox": f["bbox"]} for f in reply.get("faces", [])]

    def terminate(self) -> None:
        if self.process is not None and self.process.poll() is None:
            self.process.kill()
            try:
                self.process.wait(5)
            except subprocess.TimeoutExpired:
                pass
        if self._sock is not None:
            self._sock.close()

    def close(self, timeout: float = 10) -> None:
        """Signal EOF so the worker finishes and exits; kill it if it does not."""
        self._closing = True
        for close in ((lambda: self._sock.shutdown(socket.SHUT_WR)) if self._sock is not None else None,
                      getattr(self._writer, "close", None),
                      getattr(getattr(self.process, "stdin", None), "close", None)):
            try:
                if close is not None:
                    close()
            except (OSError, ValueError):
                pass
        if self.process is not None:
            try:
                self.process.wait(timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(5)
        if self._sock is not None:
            self._sock.close()
        self._fail("closed")


def _worker_source() -> bytes:
    return WORKER_FILE.read_bytes().replace(b"\r\n", b"\n")


def _ssh(host: str, remote_command: str, **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(["ssh", *SSH_OPTIONS, host, remote_command], **kwargs)


def deploy_worker(host: str) -> None:
    """Copy face_worker.py to HOST; its Python environment must already exist (see faces-setup)."""
    remote = (f"test -x {REMOTE_PYTHON} || exit 3; "
              f"cat > {REMOTE_WORKER}.tmp && mv {REMOTE_WORKER}.tmp {REMOTE_WORKER}")
    try:
        done = _ssh(host, remote, input=_worker_source(), capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise FaceTaggingError(f"{host}: cannot copy the face worker: {e}") from e
    if done.returncode == 3:
        raise FaceTaggingError(f"{host}: face worker environment not found; run: photosort.cmd faces-setup {host}")
    if done.returncode:
        detail = done.stderr.decode("utf-8", "replace").strip()[-300:]
        raise FaceTaggingError(f"{host}: cannot copy the face worker: {detail}")


def start_worker(spec: WorkerSpec, model: str = "buffalo_l", model_dir: Path | None = None,
                 ready_timeout: float = READY_TIMEOUT_S) -> WorkerConnection:
    """Start a worker; SSH workers get the current face_worker.py deployed when theirs is missing or stale."""
    if spec.is_local:
        command = [sys.executable, "-u", str(WORKER_FILE), "--threads", str(spec.threads), "--model", model]
        if model_dir:
            command += ["--model-dir", str(model_dir)]
        return WorkerConnection.spawn("local", command, spec.threads, ready_timeout)
    ensure_lan_host(spec.host)
    remote_command = f"{REMOTE_PYTHON} -u {REMOTE_WORKER} --threads {spec.threads} --model {model}"

    def launch() -> WorkerConnection:
        for attempt in range(3):
            try:
                return WorkerConnection.spawn_tunneled(spec.host, remote_command, spec.threads, ready_timeout)
            except WorkerDied as e:  # a random remote port can be taken; pick another
                if "cannot listen on" not in str(e) or attempt == 2:
                    raise
        raise AssertionError("unreachable")

    expected = hashlib.sha256(_worker_source()).hexdigest()
    try:
        conn = launch()
        if conn.info.get("sha256") == expected:
            return conn
        conn.close()
        log.info("%s: updating the face worker code", spec.host)
    except WorkerDied as e:
        log.info("deploying the face worker after: %s", e)
    deploy_worker(spec.host)
    return launch()


class WorkerPool:
    """Spread detect calls over workers, favouring the least busy; a request whose worker dies is retried."""

    def __init__(self, connections: list[WorkerConnection], prefetch: int = 2):
        if not connections:
            raise NoWorkersLeft("no face workers available")
        self.connections = connections
        self.prefetch = prefetch
        self.concurrency = sum(c.threads for c in connections) * prefetch
        self.provider = ", ".join(f"{c.label}: {c.provider} x{c.threads}" for c in connections)
        self._cond = threading.Condition()
        self._inflight = Counter()
        self._images = Counter()

    @classmethod
    def start(cls, specs: list[WorkerSpec], model: str = "buffalo_l", model_dir: Path | None = None):
        connections, failures = [], []
        with ThreadPoolExecutor(len(specs)) as ex:
            futures = [ex.submit(start_worker, spec, model, model_dir) for spec in specs]
            for future in futures:
                try:
                    connections.append(future.result())
                except FaceTaggingError as e:
                    failures.append(str(e))
        if not connections:
            raise NoWorkersLeft("no face worker could start: " + "; ".join(failures))
        for failure in failures:
            log.warning("continuing without face worker: %s", failure)
        for conn in connections:
            log.info("face worker %s ready: %s (%s), %d threads", conn.label, conn.info.get("host"),
                     conn.provider, conn.threads)
        return cls(connections)

    def _acquire(self) -> WorkerConnection:
        with self._cond:
            while True:
                live = [c for c in self.connections if c.alive]
                if not live:
                    raise NoWorkersLeft("all face workers failed: " +
                                        "; ".join(f"{c.label}: {c.error}" for c in self.connections))
                free = [c for c in live if self._inflight[c.label] < c.threads * self.prefetch]
                if free:
                    conn = min(free, key=lambda c: self._inflight[c.label] / c.threads)
                    self._inflight[conn.label] += 1
                    return conn
                self._cond.wait(1.0)

    def _release(self, conn: WorkerConnection, done: bool) -> None:
        with self._cond:
            self._inflight[conn.label] -= 1
            self._images[conn.label] += done
            self._cond.notify_all()

    def detect(self, path: Path) -> list[dict]:
        data = Path(path).read_bytes()
        while True:
            conn = self._acquire()
            done = False
            try:
                faces = conn.detect(data)
                done = True
                return faces
            except WorkerDied as e:
                log.warning("%s; retrying %s on another worker", e, Path(path).name)
            finally:
                self._release(conn, done)

    def summary(self) -> list[dict]:
        return [{"worker": c.label, "host": c.info.get("host"), "provider": c.provider, "threads": c.threads,
                 "images": self._images[c.label], "failed": c.error if c.error and c.error != "closed" else None}
                for c in self.connections]

    def close(self) -> None:
        with ThreadPoolExecutor(len(self.connections)) as ex:
            list(ex.map(lambda c: c.close(), self.connections))


def setup_remote_worker(host: str, model: str = "buffalo_l") -> dict:
    """Install the worker environment and model on an SSH host, deploy the worker, and test-start it."""
    spec = parse_workers(host)[0]
    if spec.is_local:
        raise ValueError("faces-setup is for SSH hosts; see the README to set up this PC")
    ensure_lan_host(spec.host)
    script = SETUP_SCRIPT.read_bytes().replace(b"\r\n", b"\n")
    try:
        done = _ssh(spec.host, f"PHOTOSORT_MODEL={model} bash -s", input=script, timeout=3600)
    except (OSError, subprocess.SubprocessError) as e:
        raise FaceTaggingError(f"{spec.host}: setup failed: {e}") from e
    if done.returncode:
        raise FaceTaggingError(f"{spec.host}: setup failed (exit {done.returncode}); see output above")
    deploy_worker(spec.host)
    conn = start_worker(WorkerSpec(spec.host, 1), model)
    info = dict(conn.info)
    conn.close()
    return info


def _unit_vector(values, context: str) -> list[float]:
    try:
        vector = values.tolist() if hasattr(values, "tolist") else list(values)
        vector = [float(v) for v in vector]
    except (TypeError, ValueError) as e:
        raise FaceTaggingError(f"invalid face embedding for {context}") from e
    norm = math.sqrt(sum(v * v for v in vector))
    if not vector or not math.isfinite(norm) or norm == 0 or not all(math.isfinite(v) for v in vector):
        raise FaceTaggingError(f"invalid face embedding for {context}")
    return [v / norm for v in vector]


def _detect_all(backend, paths: list[Path], label: str = "") -> list[tuple[list | None, Exception | None]]:
    """Run backend.detect on every path, in parallel when the backend supports it; keeps input order."""
    def one(path):
        try:
            return backend.detect(path), None
        except NoWorkersLeft:
            raise
        except (OSError, RuntimeError, ValueError, TypeError) as e:
            return None, e

    workers = max(1, int(getattr(backend, "concurrency", 1)))
    if workers == 1 or len(paths) < 2:
        return [one(path) for path in paths]
    results: list = [None] * len(paths)
    step = max(25, len(paths) // 10)
    ex = ThreadPoolExecutor(min(workers, len(paths)))
    futures = {ex.submit(one, path): i for i, path in enumerate(paths)}
    try:
        for count, future in enumerate(as_completed(futures), 1):
            results[futures[future]] = future.result()
            if label and (count % step == 0 or count == len(paths)):
                log.info("%s: %d/%d images", label, count, len(paths))
    except BaseException:
        ex.shutdown(wait=False, cancel_futures=True)
        raise
    ex.shutdown()
    return results


def _reference_people(people_dir: Path, image_exts: set[str], backend) -> dict[str, list[float]]:
    if not people_dir.is_dir():
        raise FileNotFoundError(f"people reference folder not found: {people_dir}")
    references = []
    for folder in sorted(p for p in people_dir.iterdir() if p.is_dir()):
        images = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in image_exts)
        if not images:
            raise FaceTaggingError(f"person folder has no supported reference images: {folder}")
        references += [(folder, path) for path in images]
    if not references:
        raise FaceTaggingError(f"no person subfolders found under {people_dir}")
    vectors: dict[Path, list[list[float]]] = {}
    for (folder, path), (faces, error) in zip(references, _detect_all(backend, [p for _, p in references])):
        if error is not None:
            raise FaceTaggingError(f"cannot read reference image {path}: {error}") from error
        if len(faces) != 1:
            raise FaceTaggingError(
                f"reference image must contain exactly one detectable face: {path} (found {len(faces)})"
            )
        vectors.setdefault(folder, []).append(_unit_vector(faces[0]["embedding"], str(path)))
    people = {}
    for folder, folder_vectors in vectors.items():
        if len({len(v) for v in folder_vectors}) != 1:
            raise FaceTaggingError(f"reference embeddings have inconsistent dimensions for {folder.name}")
        centroid = [sum(v[i] for v in folder_vectors) for i in range(len(folder_vectors[0]))]
        people[folder.name] = _unit_vector(centroid, str(folder))
    return people


def _image_paths(source: Path, image_exts: set[str], recursive: bool, output: Path, people_dir: Path,
                 limit: int) -> list[Path]:
    paths = source.rglob("*") if recursive else source.iterdir()
    result = []
    for path in sorted(paths):
        if not path.is_file() or path.suffix.lower() not in image_exts or path.resolve() == output:
            continue
        resolved = path.resolve()
        if resolved == people_dir or people_dir in resolved.parents:
            continue
        result.append(path)
    return result[:limit or None]


def _match(embedding, people: dict[str, list[float]], threshold: float, margin: float, path: str) -> dict:
    vector = _unit_vector(embedding, path)
    scores = []
    for name, reference in people.items():
        if len(vector) != len(reference):
            raise FaceTaggingError(f"face embedding dimensions do not match reference for {name}")
        scores.append((sum(a * b for a, b in zip(vector, reference)), name))
    scores.sort(reverse=True)
    best_score, best_name = scores[0]
    second_score = scores[1][0] if len(scores) > 1 else -1.0
    matched = best_score >= threshold and best_score - second_score >= margin
    return {"person": best_name if matched else None, "similarity": round(best_score, 4)}


def tag_people(source: Path, people_dir: Path, output: Path | None, image_exts: set[str],
               recursive: bool = False, limit: int = 0, threshold: float = 0.45, margin: float = 0.05,
               model: str = "buffalo_l", model_dir: Path | None = None, backend=None,
               workers=("local",)) -> dict:
    """Detect faces and match them to enrolled reference-photo folders; originals are never modified."""
    started_at = datetime.now()
    t0 = time.perf_counter()
    source = Path(source).expanduser().resolve()
    people_dir = Path(people_dir).expanduser().resolve()
    if not source.is_dir():
        raise FileNotFoundError(f"source folder not found: {source}")
    if not people_dir.is_dir():
        raise FileNotFoundError(f"people reference folder not found: {people_dir}")
    if not any(path.is_dir() for path in people_dir.iterdir()):
        raise FaceTaggingError(f"no person subfolders found under {people_dir}")
    if limit < 0:
        raise ValueError("--limit must be zero or a positive integer")
    if not 0 <= threshold <= 1 or not 0 <= margin <= 2:
        raise ValueError("--threshold must be 0..1 and --margin must be 0..2")
    output = Path(output).expanduser().resolve() if output else source / "photosort_faces.json"
    if output == source or output.is_relative_to(people_dir):
        raise ValueError("output must be a file outside the people reference folder")
    paths = _image_paths(source, image_exts, recursive, output, people_dir, limit)
    specs = parse_workers(workers)
    owned = backend is None
    if owned:
        backend = WorkerPool.start(specs, model, model_dir)
    try:
        people = _reference_people(people_dir, image_exts, backend)
        detected = _detect_all(backend, paths, "faces")
    finally:
        if owned:
            backend.close()

    records, face_count, matched_count, unknown_count, errors = [], 0, 0, 0, 0
    for path, (faces, error) in zip(paths, detected):
        record = {"file": str(path.relative_to(source))}
        try:
            if error is not None:
                raise error
            tagged = []
            for face in faces:
                match = _match(face["embedding"], people, threshold, margin, str(path))
                tagged.append({"person": match["person"], "similarity": match["similarity"], "bbox": face["bbox"]})
        except (OSError, RuntimeError, ValueError, TypeError) as e:
            errors += 1
            records.append({**record, "error": f"{type(e).__name__}: {str(e)[:200]}"})
            continue
        face_count += len(tagged)
        matched_count += sum(face["person"] is not None for face in tagged)
        unknown_count += sum(face["person"] is None for face in tagged)
        records.append({**record, "faces": tagged})

    finished_at = datetime.now()
    elapsed = time.perf_counter() - t0
    result = {
        "format": "photosort-faces-v1",
        "model": model,
        "provider": getattr(backend, "provider", "local"),
        "workers": backend.summary() if hasattr(backend, "summary") else [],
        "threshold": threshold,
        "margin": margin,
        "people": sorted(people),
        "started_at": started_at.isoformat(timespec="seconds"),
        "finished_at": finished_at.isoformat(timespec="seconds"),
        "duration_s": round(elapsed, 1),
        "summary": {
            "images": len(paths), "faces": face_count, "matched": matched_count,
            "unknown": unknown_count, "errors": errors,
        },
        "images": records,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=output.parent,
                                         suffix=".tmp", delete=False) as temp:
            temp_path = Path(temp.name)
            json.dump(result, temp, ensure_ascii=False, indent=2)
            temp.write("\n")
        temp_path.replace(output)
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink()
    result["output"] = str(output)
    return result


def format_face_report(result: dict) -> str:
    summary = result["summary"]
    duration = result["duration_s"]
    speed = summary["images"] / duration * 60 if duration > 0 else 0.0
    lines = [
        "",
        "=== PhotoSort face-tagging report ===",
        f"Model       : {result['model']} ({result.get('provider', 'local')})",
        f"People      : {', '.join(result['people'])}",
        f"Result      : {summary['images']} images; {summary['faces']} faces; "
        f"{summary['matched']} matched; {summary['unknown']} unknown; {summary['errors']} errors",
        f"Duration    : {duration:.1f}s  "
        f"(started {result['started_at'].replace('T', ' ')}, "
        f"finished {result['finished_at'].replace('T', ' ')})",
        f"Speed       : {speed:.0f} images/min",
    ]
    for worker in result.get("workers", []):
        status = f"  FAILED: {worker['failed']}" if worker.get("failed") else ""
        lines.append(f"Worker      : {worker['worker']} ({worker.get('host') or '?'}, {worker['provider']}, "
                     f"{worker['threads']} threads): {worker['images']} images{status}")
    lines.append(f"Output      : {result['output']}")
    return "\n".join(lines)
