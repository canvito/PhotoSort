"""Private dashboard RPC over stdio. No HTTP listener, inference, media or query logging on this PC."""
from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from dashboard_faces import Faces
from local_only import LocalOnlyError, under_onedrive
from photo_search import (PairSearchClient, SearchError, _folder_key, _is_under, from_blobs, index_path,
                          ranked_indices, score_vectors, settings)
from photosort import IMAGE_EXTS, config_problems, encode_image, journal_items, journal_runs, load_config
from media import VIDEO_EXTS, is_video
from thumbs import MediaUnavailable, ThumbCache, is_placeholder, media_stat, revision


JOURNAL_RE = re.compile(r"^_photosort_journal(-[^\\/]+)?\.jsonl$", re.IGNORECASE)


class Library:
    """A persistent read-only SQLite connection detects CLI writes without changing its journal mode."""
    MAX_EXTRAS = 50_000

    def __init__(self, cfg: dict, data_dir: Path, fixture_roots: list[Path] | None = None, notify=None):
        self.cfg, self.db_path = cfg, index_path(cfg).resolve()
        if under_onedrive(self.db_path) or str(self.db_path).startswith("\\\\"):
            raise LocalOnlyError("The index must be on a local drive outside OneDrive.")
        self.roots = [p.resolve() for p in fixture_roots] if fixture_roots is not None else None
        if self.roots is not None and not any(self.db_path.is_relative_to(r.parent) for r in self.roots):
            raise LocalOnlyError("Fixture index must stay beside the fixture library.")
        self.notify = notify or (lambda _event: None)
        self.secret = self._secret(data_dir)
        self.db = None
        self.file_id = None
        self.version = None
        # Starts from the clock so it keeps growing across sidecar restarts (pages compare it).
        self.generation = time.time_ns() // 1_000_000
        self.rows, self.by_id, self.orders = [], {}, {}
        self.extras: OrderedDict[str, dict] = OrderedDict()
        self._resolved_dirs = {}
        self.blocks = None
        self.lock = threading.RLock()
        self.client = PairSearchClient(cfg, encode_image)

    @staticmethod
    def _secret(data_dir):
        data_dir.mkdir(parents=True, exist_ok=True)
        p = data_dir / "media.key"
        try:
            with p.open("xb") as f:
                f.write(secrets.token_bytes(32))
        except FileExistsError:
            pass
        return p.read_bytes()

    def allowed(self, raw: str, check_link: bool = True) -> bool:
        p = Path(raw)
        if not p.is_absolute() or str(p).startswith("\\\\") or p.suffix.lower() not in IMAGE_EXTS | VIDEO_EXTS:
            return False
        if os.name == "nt" and ":" in str(p)[2:]:  # alternate data streams
            return False
        # Resolve junctions/symlinks too (folders once each; the file itself must not be a link): a row is never
        # authority to reach a network share, or to leave a fixture's synthetic root.
        parent = self._resolved_dirs.get(p.parent)
        if parent is None:
            parent = self._resolved_dirs[p.parent] = p.parent.resolve()
        if str(parent).startswith("\\\\") or (check_link and os.path.islink(p)):
            return False
        if self.roots is not None:
            return any(parent.is_relative_to(root) for root in self.roots)
        return True

    def sync(self) -> None:
        try:
            st = self.db_path.stat()
            identity = (st.st_dev, st.st_ino)
        except OSError:
            identity = None
        if identity != self.file_id:
            if self.db:
                self.db.close()
            self.db, self.version, self.file_id = None, None, identity
            if identity is not None:
                self.db = sqlite3.connect(self.db_path.as_uri() + "?mode=ro", uri=True, check_same_thread=False, timeout=5)
                self.db.row_factory = sqlite3.Row
            else:
                self.rows, self.by_id, self.orders, self.blocks = [], {}, {}, None
                self.generation += 1
        if not self.db:
            return
        version = self.db.execute("PRAGMA data_version").fetchone()[0]
        if version == self.version:
            return
        self.rows = []
        self._resolved_dirs = {}
        for raw in self.db.execute(
                "SELECT path,size,mtime_ns,sha256,embed_model,indexed_at,people_count FROM photos ORDER BY rowid"):
            row = dict(raw)
            if not self.allowed(row["path"], check_link=False):  # file links are refused when a file is opened
                continue
            row["id"] = self.row_id(row["path"])
            row["kind"] = "video" if is_video(row["path"]) else "photo"
            self.rows.append(row)
        self.by_id = {r["id"]: r for r in self.rows}
        self.orders, self.blocks = {}, None
        self.version = version
        self.generation += 1
        self.notify({"type": "changed", "generation": self.generation})

    def public(self, row: dict) -> dict:
        p = Path(row["path"])
        st = None
        if self.allowed(str(p)):
            try:
                st = media_stat(p, require_local=False)
            except MediaUnavailable:
                pass
        return {"id": row["id"], "name": p.name, "folder": str(p.parent), "kind": row["kind"],
                "size": st.st_size if st else row["size"], "indexed_at": row["indexed_at"],
                "people_count": row["people_count"], "exists": st is not None,
                "placeholder": bool(st and is_placeholder(st)),
                "revision": revision(st) if st else f'{row["size"]:x}-{row["mtime_ns"]:x}'}

    def row_id(self, path: str) -> str:
        return "m_" + hmac.new(self.secret, os.path.normcase(path).encode("utf-8"), "sha256").hexdigest()[:32]

    def remember(self, path: Path, people_count: int = 0) -> dict:
        """The row for a file shown outside the index (face results, people samples), so the media routes can serve
        it by id. Indexed files keep their index row; the rest are kept in a bounded LRU."""
        id = self.row_id(str(path))
        row = self.by_id.get(id)
        if row is not None:
            return row
        row = self.extras.pop(id, None) or {"id": id, "path": str(path), "size": 0, "mtime_ns": 0, "indexed_at": None,
                                            "kind": "video" if is_video(path) else "photo"}
        row["people_count"] = people_count
        self.extras[id] = row
        while len(self.extras) > self.MAX_EXTRAS:
            self.extras.popitem(last=False)
        return row

    def get_row(self, id: str) -> dict:
        self.sync()
        row = self.by_id.get(id) or self.extras.get(id)
        if row is None or not self.allowed(row["path"]):
            raise MediaUnavailable("missing")
        return row

    def stats(self) -> dict:
        self.sync()
        videos = sum(r["kind"] == "video" for r in self.rows)
        return {"ready": self.db is not None, "total": len(self.rows), "videos": videos,
                "photos": len(self.rows) - videos, "generation": self.generation,
                "matrix": {"loaded": self.blocks is not None, "rows": len(self.rows) if self.blocks is not None else 0,
                           "bytes": sum(b["visual"].nbytes + (b["text"].nbytes if b["text"] is not None else 0)
                                        for b in self.blocks or [])}}

    def listing(self, cursor=0, limit=200, sort="name", media="both", dir=None) -> dict:
        self.sync()
        if sort not in self.orders:
            key = {"name": lambda r: (Path(r["path"]).name.casefold(), r["path"]),
                   "folder": lambda r: r["path"].casefold(),
                   "indexed": lambda r: r["indexed_at"]}[sort]
            self.orders[sort] = sorted(self.rows, key=key, reverse=sort == "indexed")
        key = _folder_key(Path(dir)) if dir else None
        rows = [r for r in self.orders[sort] if self.matches_filter(r, key, media)]
        end = cursor + limit
        return {"items": [self.public(r) for r in rows[cursor:end]], "total": len(rows),
                "nextCursor": end if end < len(rows) else None, "generation": self.generation}

    @staticmethod
    def matches_filter(row, key, media):
        return (not key or _is_under(row["path"], key)) and (media == "both" or row["kind"] + "s" == media)

    def detail(self, id: str) -> dict:
        row = self.get_row(id)
        data = self.db.execute("SELECT caption,scene,objects,text,caption_model,embed_model FROM photos WHERE path=?",
                               (row["path"],)).fetchone()
        if data is None:
            raise MediaUnavailable("missing")
        extra = dict(data)
        extra["objects"] = json.loads(extra["objects"])
        return {**self.public(row), "path": row["path"], **extra}

    def warm(self) -> dict:
        start = time.perf_counter()
        self.sync()
        if not self.db:
            raise MediaUnavailable("no_index")
        if self.blocks is None:
            # Keep bounded float32 chunks, not a second copy of a whole 31k x 4096 matrix.
            blocks, by_path = [], {r["path"]: i for i, r in enumerate(self.rows)}
            cur = self.db.execute("SELECT path,embed_model,vec_visual,vec_text FROM photos ORDER BY rowid")
            done = 0
            self.notify({"type": "loading", "done": 0, "total": len(self.rows)})
            while raw := cur.fetchmany(2048):
                groups = {}
                for r in raw:
                    if r[0] in by_path:
                        groups.setdefault((r[1], len(r[2])), []).append(r)
                for (model, length), rows in groups.items():
                    if not length or length % 2:
                        continue
                    with_text = [i for i, r in enumerate(rows) if r[3]]
                    blocks.append({"model": model, "dimension": length // 2,
                                   "indices": np.array([by_path[r[0]] for r in rows]),
                                   "visual": from_blobs([r[2] for r in rows]),
                                   "with_text": np.array(with_text, dtype=np.intp),
                                   "text": from_blobs([rows[i][3] for i in with_text]) if with_text else None})
                    done += len(rows)
                self.notify({"type": "loading", "done": done, "total": len(self.rows)})
            self.blocks = blocks
        return {"rows": len(self.rows), "ms": round((time.perf_counter() - start) * 1000, 1)}

    def search(self, query: str, dir=None, top=100, media="both", minScore=-1) -> dict:
        start = time.perf_counter()
        if not query.strip():
            raise ValueError("empty query")
        self.warm()
        model = settings(self.cfg)["embed_model"]
        self.client.preflight([model])
        q = self.client.embed([query], query=True)[0]
        key = _folder_key(Path(dir)) if dir else None
        eligible = np.array([self.matches_filter(r, key, media) for r in self.rows], dtype=bool)
        scores = np.full(len(self.rows), -np.inf, dtype=np.float32)
        searched = 0
        for b in self.blocks:
            if b["model"] != model or b["dimension"] != q.size:
                continue
            select = eligible[b["indices"]]
            if not select.any():
                continue
            # Score whole cached blocks (no per-query copy of filtered rows), then keep the eligible ones;
            # each row's score is the CLI's max(visual, text) for that row.
            values = score_vectors(b["visual"], b["text"], b["with_text"], q)
            scores[b["indices"][select]] = values[select]
            searched += int(select.sum())
        matches = [i for i in ranked_indices(scores, top) if np.isfinite(scores[i]) and scores[i] >= minScore]
        return {"results": [{**self.public(self.rows[i]), "score": round(float(scores[i]), 3)} for i in matches],
                "searched": searched, "skipped_other_model": int(eligible.sum()) - searched,
                "elapsed_s": round(time.perf_counter() - start, 3), "generation": self.generation}

    def close(self):
        if self.db:
            self.db.close()


class Service:
    def __init__(self, config_path: Path, data_dir: Path, roots=None, notify=None):
        if under_onedrive(data_dir):
            raise LocalOnlyError("Dashboard data must stay outside OneDrive.")
        self.library = Library(load_config(config_path), data_dir, roots, notify)
        self.faces = Faces(self.library, config_path)
        self.cache = ThumbCache(data_dir / "thumbs")
        self._journals: dict[str, tuple] = {}
        self._journal_lock = threading.Lock()

    def _journal_path(self, raw: str) -> Path:
        p = Path(raw)
        if (not p.is_absolute() or str(p).startswith("\\\\") or not JOURNAL_RE.match(p.name)
                or os.path.islink(p)):
            raise LocalOnlyError("not a PhotoSort journal")
        if self.library.roots is not None and not any(p.parent.resolve().is_relative_to(r) for r in self.library.roots):
            raise LocalOnlyError("outside the fixture library")
        return p

    def journal_entries(self, raw: str) -> list[dict]:
        """A journal's lines, cached by size and modified time. A line that does not parse (a run is writing it, or
        OneDrive mangled the file) is skipped, never fatal."""
        p = self._journal_path(raw)
        st = p.stat()
        key = (st.st_size, st.st_mtime_ns)
        with self._journal_lock:
            hit = self._journals.get(str(p))
            if hit and hit[0] == key:
                return hit[1]
        entries = []
        with p.open(encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if isinstance(e, dict):
                    entries.append(e)
        with self._journal_lock:
            if len(self._journals) > 32:
                self._journals.clear()
            self._journals[str(p)] = (key, entries)
        return entries

    def journal_runs(self, journal: str) -> dict:
        p = self._journal_path(journal)
        out = {"runs": journal_runs(self.journal_entries(journal)) if p.is_file() else [], "conflicts": []}
        for copy in sorted(p.parent.glob("_photosort_journal-*.jsonl")):
            try:
                out["conflicts"].append({"name": copy.name, "runs": len(journal_runs(self.journal_entries(str(copy))))})
            except (OSError, LocalOnlyError):
                continue
        return out

    def call(self, method: str, params: dict):
        if method == "journal.runs":
            return self.journal_runs(str(params["journal"]))
        if method == "journal.items":
            return journal_items(self.journal_entries(str(params["journal"])), str(params["runId"]),
                                 max(0, int(params.get("offset", 0))), min(5000, max(1, int(params.get("limit", 500)))))
        if method == "faces.workers":
            return self.faces.workers()
        if method == "faces.check_workers":
            return self.faces.check_workers(params.get("workers"))
        lib = self.library
        with lib.lock:
            if method == "faces.read":
                return self.faces.read(params["folder"])
            if method == "faces.items":
                return self.faces.items(**params)
            if method == "faces.item":
                return self.faces.item(**params)
            if method == "faces.people":
                return self.faces.people(params["dir"])
            if method == "index.stats":
                self.cache.maintain()
                return {**lib.stats(), "cache": self.cache.info()}
            if method == "index.list":
                return lib.listing(**params)
            if method == "index.get":
                return lib.detail(**params)
            if method == "search.warm":
                return lib.warm()
            if method == "search.query":
                return lib.search(**params)
            if method == "cache.clear":
                self.cache.clear()
                return {"ok": True}
            if method in ("media.make", "media.original", "media.reveal"):
                row = lib.get_row(params["id"])
                path = Path(row["path"])
                if method == "media.reveal":
                    media_stat(path, require_local=False)
                    return {"path": str(path)}
                st = media_stat(path)
                current = revision(st)
                if params.get("revision") and params["revision"] != current:
                    raise MediaUnavailable("changed")
                if method == "media.original":
                    if not is_video(path):
                        raise MediaUnavailable("unsupported")
                    return {"path": str(path), "size": st.st_size, "extension": path.suffix.lower()}
                kind = params["kind"]
                if kind not in ("thumb", "preview", "strip"):
                    raise ValueError("unknown size")
            else:
                raise ValueError("unknown method")
        # Generation happens outside the SQLite lock so browsing/search do not wait for image decoders.
        result = self.cache.get(path, kind, current)
        return {"path": str(result), "revision": current}

    def close(self):
        self.cache.close()
        self.library.close()


def check_config() -> int:
    """`--check-config`: read a config from stdin and print its problems. Needs no index or PAIR, so a config the
    sidecar cannot start with can still be checked and fixed."""
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        result = config_problems(json.loads(sys.stdin.buffer.read().decode("utf-8")))
    except ValueError:
        result = {"errors": ["The config is not valid JSON."], "warnings": []}
    print(json.dumps(result, ensure_ascii=True))
    return 0


def main():
    if sys.argv[1:] == ["--check-config"]:
        return check_config()
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=Path, required=True)
    ap.add_argument("--data-dir", type=Path, required=True)
    ap.add_argument("--fixture-root", type=Path, action="append")
    args = ap.parse_args()
    # Windows: creating thumbnail worker processes queries the std handles, which blocks while the main thread
    # has a pending read on the stdin pipe. Read requests from a private duplicate; children get NUL as stdin.
    requests_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
    null = os.open(os.devnull, os.O_RDONLY)
    os.dup2(null, 0)
    os.close(null)
    sys.stdout.reconfigure(encoding="utf-8")
    logging.disable(logging.CRITICAL)  # dependency diagnostics may contain paths or queries
    write_lock = threading.Lock()

    def send(data):
        with write_lock:
            print(json.dumps(data, ensure_ascii=True, allow_nan=False), flush=True)

    try:
        service = Service(args.config, args.data_dir, args.fixture_root,
                          lambda data: send({"jsonrpc": "2.0", "method": "index", "params": data}))
    except Exception:
        return 2  # no exception text (config can hold private paths)

    def handle(req):
        id = req.get("id")
        try:
            result = service.call(req["method"], req.get("params", {}))
            send({"jsonrpc": "2.0", "id": id, "result": result})
        except MediaUnavailable as e:
            send({"jsonrpc": "2.0", "id": id, "error": {"code": e.code}})
        except LocalOnlyError:
            send({"jsonrpc": "2.0", "id": id, "error": {"code": "local_only"}})
        except SearchError:
            send({"jsonrpc": "2.0", "id": id, "error": {"code": "model_unavailable"}})
        except Exception:
            send({"jsonrpc": "2.0", "id": id, "error": {"code": "failed"}})

    with ThreadPoolExecutor(max_workers=8) as pool:
        for line in requests_in:
            try:
                req = json.loads(line)
                if req.get("method") == "sys.shutdown":
                    break
                pool.submit(handle, req)
            except (ValueError, TypeError):
                send({"jsonrpc": "2.0", "id": None, "error": {"code": "invalid_request"}})
    service.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
