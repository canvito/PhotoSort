"""Bring the search index to another PC: `index-export` writes a snapshot file, `index-import` merges one in.

The index rows (captions, visible text and vectors of private photos) are copied file to file: no model, PAIR or
network call. Import keeps only files that exist on this PC, and for each one whose size and modified time match
it records this PC's modified time, so the next `index` skips the file without reading it (reading would download
OneDrive online-only files). Reports show counts and top folders only, never file names or captions.
"""
from __future__ import annotations

import os
import sqlite3
import stat
import time
from collections import Counter
from contextlib import closing
from pathlib import Path

from local_only import LocalOnlyError, under_onedrive
from photo_search import COLUMNS, SearchError, index_path, open_index, prompt_version, settings

# OneDrive may keep only whole seconds of a modified time, and FAT drives two-second steps.
MTIME_SLACK_NS = 2_000_000_000


def _open_ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"{Path(path).resolve().as_uri()}?mode=ro", uri=True, timeout=60)


def _check_index(db: sqlite3.Connection, path: Path) -> None:
    try:
        cols = {row[1] for row in db.execute("PRAGMA table_info(photos)")}
    except sqlite3.DatabaseError as e:
        raise SearchError(f"{path} is not a PhotoSort search index ({e})") from None
    if not set(COLUMNS) <= cols:
        raise SearchError(f"{path} is not a PhotoSort search index (no complete photos table)")


def _snapshot(src: Path, dst: Path) -> int:
    """Consistent copy of the index (even while the dashboard or an `index` run uses it); returns the row count."""
    partial = dst.with_name(dst.name + ".partial")
    partial.unlink(missing_ok=True)
    try:
        with closing(_open_ro(src)) as s, closing(sqlite3.connect(partial)) as d:
            _check_index(s, src)
            s.backup(d)
            rows = d.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        os.replace(partial, dst)  # an interrupted copy never leaves a half-written file under the real name
    finally:
        partial.unlink(missing_ok=True)
    return rows


def _top_folders(paths, n: int = 5) -> list[tuple[str, int]]:
    """Top folders (drive and three levels, e.g. C:\\Users\\name\\OneDrive) with file counts: enough to write --map."""
    roots = Counter(str(Path(*Path(p).parent.parts[:4])) for p in paths)
    return roots.most_common(n)


def export_index(cfg: dict, out: Path, allow_onedrive: bool = False) -> dict:
    t0 = time.perf_counter()
    db_path = index_path(cfg).resolve()
    if not db_path.exists():
        raise SearchError(f"no search index at {db_path}; run `photosort index <folder>` first")
    out = Path(out).expanduser().resolve()
    if out.exists():
        raise ValueError(f"{out} already exists; choose a new file name or delete it first")
    if not out.parent.is_dir():
        raise FileNotFoundError(f"folder not found: {out.parent}")
    if under_onedrive(out) and not allow_onedrive:
        raise LocalOnlyError(f"{out} is in OneDrive, which would upload the captions and visible text of your photos "
                             "to the cloud. Export to a USB drive or another local folder, or add --allow-onedrive.")
    rows = _snapshot(db_path, out)
    with closing(_open_ro(out)) as db:
        folders = _top_folders(p for (p,) in db.execute("SELECT path FROM photos"))
    return {"index_path": str(db_path), "out": str(out), "files": rows, "bytes": out.stat().st_size,
            "folders": folders, "elapsed_s": round(time.perf_counter() - t0, 1)}


def _parse_maps(maps) -> list[tuple[str, str, str]]:
    """(--map OLD as a case-insensitive prefix ending in a separator, NEW folder on this PC, OLD as given),
    longest OLD first so a nested folder wins over its parent."""
    out, seen = [], set()
    for old, new in maps or []:
        if not os.path.isabs(old):
            raise ValueError(f"--map: {old!r} must be a full path from the other PC, e.g. C:\\Users\\name")
        key = os.path.normcase(os.path.normpath(old))
        key = key if key.endswith(os.sep) else key + os.sep
        if key in seen:
            raise ValueError(f"--map: {old} is given twice")
        seen.add(key)
        here = Path(new).expanduser()
        if not here.is_dir():
            raise FileNotFoundError(f"--map: folder not found on this PC: {new}")
        out.append((key, str(here.resolve()), old))
    return sorted(out, key=lambda m: -len(m[0]))


class _Finder:
    """Finds a file the way `index` lists it (the folder's real path, the name's real case) without opening it."""

    def __init__(self):
        self.dirs: dict[str, tuple[str | None, dict[str, str]]] = {}

    def find(self, path: str) -> tuple[str, os.stat_result] | None:
        parent, name = os.path.split(path)
        key = os.path.normcase(parent)
        if key not in self.dirs:
            try:
                real = str(Path(parent).resolve(strict=True))
                with os.scandir(real) as it:
                    self.dirs[key] = (real, {os.path.normcase(e.name): e.name for e in it})
            except OSError:
                self.dirs[key] = (None, {})
        real, names = self.dirs[key]
        actual = names.get(os.path.normcase(name))
        if not real or not actual:
            return None
        full = os.path.join(real, actual)
        try:
            st = os.stat(full)  # metadata only: does not download a OneDrive online-only file
        except OSError:
            return None
        return (full, st) if stat.S_ISREG(st.st_mode) else None


def import_index(cfg: dict, src: Path, maps=None, dry_run: bool = False) -> dict:
    """Merge an exported index into this PC's index in one transaction. A file this PC already indexed keeps its
    entry unless that entry is out of date and the imported one matches the file."""
    t0 = time.perf_counter()
    src = Path(src).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(f"export file not found: {src}")
    db_path = index_path(cfg).resolve()
    if db_path.exists() and os.path.samefile(src, db_path):
        raise ValueError(f"{src} is this PC's own index; import a file written by `index-export`")
    prefixes = _parse_maps(maps)
    s = settings(cfg)
    models = (s["caption_model"], s["embed_model"])
    counts = {"files": 0, "ready": 0, "changed": 0, "kept": 0, "missing": 0, "other_models": 0}
    used = [0] * len(prefixes)
    missing_paths: list[str] = []
    backup = None
    with closing(_open_ro(src)) as inc:
        _check_index(inc, src)
        if dry_run:
            local = _open_ro(db_path) if db_path.exists() else None
        else:
            if db_path.exists():
                backup = db_path.with_name(f"{db_path.stem}.before-import{db_path.suffix}")
                _snapshot(db_path, backup)
            local = open_index(db_path)
        try:
            existing = {}
            if local:
                _check_index(local, db_path)
                existing = {os.path.normcase(p): (p, size, mtime) for p, size, mtime in
                            local.execute("SELECT path, size, mtime_ns FROM photos")}
            before = len(existing)
            added = 0
            finder = _Finder()
            insert = f"INSERT OR REPLACE INTO photos ({', '.join(COLUMNS)}) VALUES ({', '.join('?' * len(COLUMNS))})"
            for values in inc.execute(f"SELECT {', '.join(COLUMNS)} FROM photos"):
                row = dict(zip(COLUMNS, values))
                counts["files"] += 1
                path = row["path"]
                folded = os.path.normcase(path)
                for i, (key, here, _) in enumerate(prefixes):
                    if folded.startswith(key):
                        path = os.path.join(here, path[len(key):])
                        used[i] += 1
                        break
                found = finder.find(path)
                if not found:
                    counts["missing"] += 1
                    missing_paths.append(row["path"])
                    continue
                full, st = found
                fresh = row["size"] == st.st_size and abs(row["mtime_ns"] - st.st_mtime_ns) <= MTIME_SLACK_NS
                old = existing.get(os.path.normcase(full))
                if old and (not fresh or (old[1], old[2]) == (st.st_size, st.st_mtime_ns)):
                    counts["kept"] += 1
                    continue
                if fresh:
                    row["mtime_ns"] = st.st_mtime_ns  # so `index` sees this PC's file as unchanged
                row["path"] = full
                counts["ready" if fresh else "changed"] += 1
                if (row["caption_model"], row["embed_model"], row["prompt_version"]) != (
                        *models, prompt_version(Path(full))):
                    counts["other_models"] += 1
                if not dry_run:
                    if old:
                        local.execute("DELETE FROM photos WHERE path = ?", (old[0],))
                    local.execute(insert, [row[c] for c in COLUMNS])
                added += old is None
                existing[os.path.normcase(full)] = (full, st.st_size, row["mtime_ns"])
            if dry_run:
                total = before + added
            else:
                local.commit()
                total = local.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
        except BaseException:
            if local and not dry_run:
                local.rollback()
            raise
        finally:
            if local:
                local.close()
    return {"file": str(src), "index_path": str(db_path), "dry_run": dry_run, **counts, "total_indexed": total,
            "backup": str(backup) if backup else None,
            "unused_maps": [old for (_, _, old), n in zip(prefixes, used) if not n],
            "missing_folders": _top_folders(missing_paths) if counts["missing"] else [],
            "elapsed_s": round(time.perf_counter() - t0, 1)}


def _folders_line(folders) -> str:
    return ", ".join(f"{f} ({n:,})" for f, n in folders)


def format_export_report(r: dict) -> str:
    return "\n".join([
        f"Exported the search index: {r['files']:,} files ({r['bytes'] / 1e6:,.1f} MB) in {r['elapsed_s']} s",
        f"  File:     {r['out']}",
        f"  Folders:  {_folders_line(r['folders']) or '(none)'}",
        "  The file holds captions and visible text from your photos: keep it private, delete it after importing.",
        "On the other PC (add --map OLD NEW when its folders are elsewhere):",
        f'  .\\photosort.cmd index-import "{r["out"]}" --dry-run'])


def format_import_report(r: dict) -> str:
    def row(label: str, value, note: str = "") -> str:
        return f"  {label:<24}{value:>8}{'   ' + note if note else ''}"

    lines = [f"Index import{' (dry run: nothing written)' if r['dry_run'] else ''} from {r['file']}",
             row("Files in the export", f"{r['files']:,}"),
             row("Ready to search here", f"{r['ready']:,}", "same size and modified time; `index` skips them"),
             row("Changed here", f"{r['changed']:,}", "`index` reads them again; same content keeps its caption"),
             row("Already indexed here", f"{r['kept']:,}", "this PC's entries are kept"),
             row("Not found on this PC", f"{r['missing']:,}", "not imported")]
    if r["other_models"]:
        lines.append(row("Made with other models", f"{r['other_models']:,}",
                         "`index` describes them again (caption_model, embed_model)"))
    lines.append(row("Index would hold" if r["dry_run"] else "Index now holds", f"{r['total_indexed']:,}", "files"))
    lines.append(row("Duration", f"{r['elapsed_s']} s"))
    if r["backup"]:
        lines.append(f"  Previous index saved as {r['backup']} (delete it once you are happy)")
    for old in r["unused_maps"]:
        lines.append(f"Warning: no file in the export is under --map {old}; check the spelling.")
    if r["missing"] and r["missing"] * 2 >= r["files"]:
        lines.append(f"Warning: {r['missing']:,} files were not found here. Paths in the export start with "
                     f"{_folders_line(r['missing_folders'])}; add --map OLD NEW for each, e.g. "
                     "--map C:\\Users\\otherName C:\\Users\\yourName.")
    return "\n".join(lines)
