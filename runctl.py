"""Run control for long PhotoSort runs: a structured events file, safe cancel, and folder locks.

- Events (`--events FILE`): one JSON object per line, schema v1, flushed per line. The dashboard tails the file.
  Off unless the option is given, so terminal output never changes.
- Cancel (`--cancel-file FILE`, or Ctrl+C): a run stops at the next checkpoint, which every per-file loop calls
  before it touches a file. A file move and its journal line are one unit: Ctrl+C is held back until both are done,
  so a stopped run never leaves a moved file without a journal line.
- Locks: runs that move files refuse to start while another run uses an overlapping folder (and runs that only read
  refuse while one is moving files there). `--force` overrides. A lock whose process has ended is ignored.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import threading
import time
import uuid
from concurrent.futures import TimeoutError as FuturesTimeout, as_completed
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

SCHEMA = 1
POLL_S = 0.25
CANCEL = threading.Event()
STATUS = {0: "ok", 1: "errors", 2: "failed", 130: "cancelled"}

log = logging.getLogger("photosort")


class Cancelled(KeyboardInterrupt):
    """Raised at a checkpoint once a cancel was requested; handled like Ctrl+C."""


class LockError(RuntimeError):
    pass


# ---------- events ----------

class EventSink:
    """Appends schema-v1 events as JSON lines, flushed after each line. Thread-safe. Never raises: a write error
    turns it off with one warning, and the run carries on."""

    def __init__(self, path: Path | None = None):
        self._lock = threading.Lock()
        self._seq = 0
        self._f = None
        self.finished = False
        if path:
            try:
                self._f = open(path, "a", encoding="utf-8", errors="backslashreplace", newline="\n")
            except OSError as e:
                log.warning("events file disabled: %s", e)

    @property
    def enabled(self) -> bool:
        return self._f is not None

    def emit(self, type_: str, **fields) -> None:
        if self._f is None:
            return
        with self._lock:
            if self._f is None:
                return
            self._seq += 1
            record = {"v": SCHEMA, "seq": self._seq, "ts": datetime.now().isoformat(timespec="milliseconds"),
                      "type": type_, **fields}
            try:
                self._f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
                self._f.flush()
            except (OSError, ValueError, TypeError) as e:
                self._close()
                log.warning("events file disabled: %s", e)
            if type_ == "finish":
                self.finished = True

    def _close(self) -> None:
        f, self._f = self._f, None
        try:
            if f:
                f.close()
        except OSError:
            pass

    def close(self) -> None:
        with self._lock:
            self._close()


_sink = EventSink()


def configure(events: Path | None = None, cancel_file: Path | None = None) -> None:
    """Called once by the CLI. Without arguments everything stays off."""
    global _sink
    _sink.close()
    _sink = EventSink(events)
    CANCEL.clear()
    if cancel_file:
        watch_cancel_file(Path(cancel_file))


def emit(type_: str, **fields) -> None:
    _sink.emit(type_, **fields)


def finish(exit_code: int, summary: dict | None = None, report: str | None = None, **extra) -> None:
    """The run's last event (once)."""
    if _sink.finished:
        return
    fields = {"status": STATUS.get(exit_code, "failed"), "exit_code": exit_code, **extra}
    if summary is not None:
        fields["summary"] = summary
    if report is not None:
        fields["report"] = report
    _sink.emit("finish", **fields)


# ---------- cancel ----------

def watch_cancel_file(path: Path, interval: float = POLL_S) -> threading.Thread:
    """Sets CANCEL once `path` exists (the dashboard creates it)."""
    def run():
        while not CANCEL.is_set():
            if path.exists():
                CANCEL.set()
                log.warning("cancel requested: stopping after the files in progress")
                emit("warning", message="cancel requested: stopping after the files in progress")
                return
            time.sleep(interval)

    t = threading.Thread(target=run, name="cancel-watch", daemon=True)
    t.start()
    return t


def checkpoint() -> None:
    """Call at the top of every per-file step, before the file is touched."""
    if CANCEL.is_set():
        raise Cancelled()


def cancelled() -> bool:
    return CANCEL.is_set()


def sleep(seconds: float) -> None:
    """A retry pause that ends early on cancel."""
    CANCEL.wait(seconds)


@contextmanager
def no_interrupt():
    """Hold back Ctrl+C (SIGINT) until the block is done, then raise it. For a file move and its journal line."""
    if threading.current_thread() is not threading.main_thread():
        yield
        return
    hit = []
    try:
        previous = signal.signal(signal.SIGINT, lambda signum, frame: hit.append(signum))
    except (ValueError, OSError):
        yield
        return
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous if previous is not None else signal.default_int_handler)
        if hit:
            raise KeyboardInterrupt


def completed(futures, poll: float = 0.5):
    """Like as_completed, but wakes at least every `poll` seconds so a cancel (or Ctrl+C, which Windows delivers only
    between waits) is noticed while slow requests are in flight."""
    pending = set(futures)
    while pending:
        checkpoint()
        try:
            for fut in as_completed(pending, timeout=poll):
                pending.discard(fut)
                yield fut
        except FuturesTimeout:
            pass


# ---------- folder locks ----------

def locks_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or str(Path.home() / ".local" / "share")
    return Path(base) / "PhotoSort" / "locks"


def _norm(folder) -> str:
    return os.path.normcase(str(Path(folder).resolve())).rstrip("\\/")


def overlaps(a: str, b: str) -> bool:
    return a == b or a.startswith(b + os.sep) or b.startswith(a + os.sep)


def minimal_folders(folders) -> list[str]:
    """The given folders without any that sit inside another one."""
    out = []
    for f in sorted({_norm(f) for f in folders}, key=len):
        if not any(f == o or f.startswith(o + os.sep) for o in out):
            out.append(f)
    return out


def _process_start(pid: int) -> int | None:
    """Creation time of a running process (None if it is not running), so a reused PID is not mistaken for it."""
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return 0
        except OSError:
            return None
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return None
    try:
        code = wintypes.DWORD()
        if not k32.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value != 259:  # STILL_ACTIVE
            return None
        times = [wintypes.FILETIME() for _ in range(4)]
        if not k32.GetProcessTimes(handle, *map(ctypes.byref, times)):
            return None
        return (times[0].dwHighDateTime << 32) | times[0].dwLowDateTime
    finally:
        k32.CloseHandle(handle)


@contextmanager
def _registry(root: Path, wait_s: float = 10.0):
    """Serializes lock checks between processes (a short-lived exclusive file)."""
    root.mkdir(parents=True, exist_ok=True)
    gate = root / ".registry"
    deadline = time.monotonic() + wait_s
    while True:
        try:
            fd = os.open(gate, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.close(fd)
            break
        except FileExistsError:
            try:
                if time.time() - gate.stat().st_mtime > 5:  # held for milliseconds; older means a crash left it
                    gate.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() > deadline:
                raise LockError(f"the PhotoSort lock registry is busy ({gate})")
            time.sleep(0.05)
    try:
        yield
    finally:
        gate.unlink(missing_ok=True)


def active_locks(root: Path | None = None) -> list[dict]:
    """Locks held by running processes; stale lock files are removed."""
    root = root or locks_dir()
    out = []
    for f in root.glob("*.json"):
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
            alive = _process_start(int(rec["pid"])) == rec["pid_started"]
        except (OSError, ValueError, KeyError, TypeError):
            alive = False
        if alive:
            out.append({**rec, "file": f})
        else:
            f.unlink(missing_ok=True)
    return out


@contextmanager
def folder_lock(cmd: str, mode: str, folders, force: bool = False):
    """Hold a lock on `folders` for this run. mode "move" conflicts with any overlapping run; "read" conflicts only
    with runs that move files. Raises LockError on a conflict unless force."""
    assert mode in ("move", "read")
    root = locks_dir()
    mine = {"id": uuid.uuid4().hex, "pid": os.getpid(), "pid_started": _process_start(os.getpid()), "cmd": cmd,
            "mode": mode, "folders": minimal_folders(folders), "since": datetime.now().isoformat(timespec="seconds")}
    path = root / f"{mine['id']}.json"
    with _registry(root):
        for other in active_locks(root):
            if other["pid"] == mine["pid"] or "move" not in (mode, other["mode"]):
                continue
            clash = next(((a, b) for a in mine["folders"] for b in other["folders"] if overlaps(a, b)), None)
            if not clash:
                continue
            what = (f"another PhotoSort run ({other['cmd']}, process {other['pid']}, since "
                    f"{other['since'].replace('T', ' ')}) is using {clash[1]}")
            if not force:
                raise LockError(f"{what}; wait for it to finish, or add --force to run anyway")
            log.warning("%s; running anyway (--force)", what)
            emit("warning", message=f"{what}; running anyway (--force)")
        path.write_text(json.dumps(mine), encoding="utf-8")
    try:
        yield mine
    finally:
        path.unlink(missing_ok=True)
