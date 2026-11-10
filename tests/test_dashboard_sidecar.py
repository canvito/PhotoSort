import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from PIL import Image

from dashboard_sidecar import Library, Service
from local_only import LocalOnlyError
from photo_search import COLUMNS, TABLE, from_blobs, search_index, to_blob, unit_rows, update_index_paths
from thumbs import MediaUnavailable, ThumbCache, is_placeholder, make_thumb, media_stat, revision


class QueryClient:
    def __init__(self, q):
        self.q = q

    def preflight(self, _models):
        pass

    def embed(self, _texts, query=False):
        return self.q[None, :]


def fixture_index(tmp_path, count=12, dims=32):
    root = tmp_path / "library"
    root.mkdir()
    cfg = json.loads((Path(__file__).parents[1] / "config.json").read_text())
    cfg["index_path"] = str(tmp_path / "search_index.sqlite")
    rng = np.random.default_rng(4)
    with closing(sqlite3.connect(cfg["index_path"])) as db, db:
        db.executescript(TABLE)
        for i in range(count):
            folder = root / ("subset" if i % 3 else "elsewhere")
            folder.mkdir(exist_ok=True)
            path = folder / f"sample_{i:05}.jpg"
            if i < 12:
                Image.new("RGB", (90, 60), (10 * i, 60, 90)).save(path)
            visual, text = unit_rows(rng.normal(size=(2, dims)))
            if i < 2:  # stable tie
                visual = np.ones(dims, dtype=np.float32) / np.sqrt(dims)
            row = [str(path), path.stat().st_size if path.exists() else 123,
                   path.stat().st_mtime_ns if path.exists() else 456, f"hash-{i}", cfg["caption_model"],
                   "other:8b" if i == 5 else cfg["embed_model"], 1,
                   "Synthetic caption", "Synthetic scene", '["shape"]', "Synthetic text", 0,
                   to_blob(visual if i != 6 else visual[:3]), to_blob(text) if i > 1 and i % 2 else None, str(i)]
            db.execute(f"INSERT INTO photos ({','.join(COLUMNS)}) VALUES ({','.join('?' * len(COLUMNS))})", row)
    return cfg, root


def frozen_ranking(cfg, q, folder=None, top=10):
    # The pre-P2 CLI's scorer, independent of the refactored helper.
    paths, scores, other, searched = [], [], 0, 0
    with closing(sqlite3.connect(cfg["index_path"])) as db:
        cur = db.execute("SELECT path,embed_model,vec_visual,vec_text,caption FROM photos")
        while rows := cur.fetchmany(2048):
            if folder:
                rows = [r for r in rows if Path(r[0]).is_relative_to(folder)]
            ok = [r for r in rows if r[1] == cfg["embed_model"] and len(r[2]) == q.size * 2]
            other += len(rows) - len(ok)
            if not ok:
                continue
            searched += len(ok)
            score = from_blobs([r[2] for r in ok]) @ q
            with_text = [i for i, r in enumerate(ok) if r[3]]
            if with_text:
                score[with_text] = np.maximum(score[with_text], from_blobs([ok[i][3] for i in with_text]) @ q)
            paths += [r[0] for r in ok]
            scores.append(score)
    flat = np.concatenate(scores)
    result = [(paths[i], round(float(flat[i]), 3)) for i in np.argsort(-flat, kind="stable")[:top]]
    return result, searched, other


@pytest.mark.parametrize("filtered", [False, True])
def test_cached_search_and_cli_keep_original_scores_and_stable_order(tmp_path, filtered):
    cfg, root = fixture_index(tmp_path, count=2055)
    q = np.ones(32, dtype=np.float32) / np.sqrt(32)
    folder = root / "subset" if filtered else None
    expected, searched, other = frozen_ranking(cfg, q, folder, top=500)
    lib = Library(cfg, tmp_path / "data", [root])
    lib.client = QueryClient(q)
    try:
        cached = lib.search("synthetic", dir=str(folder) if folder else None, top=500)
        actual = [(str(Path(r["folder"]) / r["name"]), r["score"]) for r in cached["results"]]
        assert actual == expected
        assert (cached["searched"], cached["skipped_other_model"]) == (searched, other)
        blocks = lib.blocks
        assert lib.search("second query")["searched"] == 2053
        assert lib.blocks is blocks  # no SQLite vector reload on another query
        cli = search_index(cfg, "synthetic", QueryClient(q), folder=folder, top=500)
        assert [(r["path"], r["score"]) for r in cli["results"]] == expected
    finally:
        lib.close()


def test_live_refresh_after_index_write_and_moves_without_wal(tmp_path):
    cfg, root = fixture_index(tmp_path)
    lib = Library(cfg, tmp_path / "data", [root])
    try:
        lib.warm()
        first = lib.generation
        old_blocks = lib.blocks
        src = root / "subset" / "sample_00001.jpg"
        dst = root / "subset" / "renamed.jpg"
        src.rename(dst)
        update_index_paths(Path(cfg["index_path"]), [(src, dst)])
        assert any(r["name"] == dst.name for r in lib.listing()["items"])
        assert lib.generation > first and lib.blocks is None
        lib.warm()
        assert lib.blocks is not old_blocks
        # In-place recaptioning updates vectors, even if the file's size and path did not change.
        with closing(sqlite3.connect(cfg["index_path"])) as db, db:
            db.execute("UPDATE photos SET caption='Updated fixture', indexed_at='later' WHERE path=?", (str(dst),))
        row = next(r for r in lib.listing()["items"] if r["name"] == dst.name)
        assert lib.detail(row["id"])["caption"] == "Updated fixture"
        with closing(sqlite3.connect(cfg["index_path"])) as db:
            assert db.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    finally:
        lib.close()


def test_fixture_rows_cannot_expose_other_folders_and_unknown_ids(tmp_path):
    cfg, root = fixture_index(tmp_path)
    with closing(sqlite3.connect(cfg["index_path"])) as db, db:
        db.execute("UPDATE photos SET path=? WHERE path LIKE '%00001.jpg'", (str(tmp_path / "outside.jpg"),))
    lib = Library(cfg, tmp_path / "data", [root])
    try:
        assert lib.stats()["total"] == 11
        with pytest.raises(MediaUnavailable, match="missing"):
            lib.detail("m_" + "a" * 32)
        if os.name != "nt":
            (root / "linked.jpg").symlink_to(tmp_path / "outside.jpg")
            assert not lib.allowed(str(root / "linked.jpg"))
    finally:
        lib.close()


def test_missing_index_can_appear_after_sidecar_start(tmp_path):
    cfg, root = fixture_index(tmp_path)
    path = Path(cfg["index_path"])
    saved = path.read_bytes()
    path.unlink()
    lib = Library(cfg, tmp_path / "data", [root])
    try:
        assert lib.stats()["ready"] is False
        path.write_bytes(saved)
        assert lib.stats()["total"] == 12
    finally:
        lib.close()


def test_index_inside_onedrive_is_refused(tmp_path, monkeypatch):
    cfg, root = fixture_index(tmp_path)
    monkeypatch.setenv("OneDrive", str(tmp_path))
    with pytest.raises(LocalOnlyError):
        Library(cfg, tmp_path / "data", [root])


@pytest.mark.parametrize("flag", [0x1000, 0x40000, 0x400000])
def test_placeholder_gate_runs_before_any_decoder_or_cache(flag, tmp_path, monkeypatch):
    cfg, root = fixture_index(tmp_path)
    config = tmp_path / "config.json"
    config.write_text(json.dumps(cfg))
    svc = Service(config, tmp_path / "data", [root])
    item = svc.call("index.list", {})["items"][0]
    assert is_placeholder(SimpleNamespace(st_file_attributes=flag))
    monkeypatch.setattr("dashboard_sidecar.media_stat",
                        lambda *a, **k: (_ for _ in ()).throw(MediaUnavailable("placeholder")))
    try:
        for method in ("media.make", "media.original"):
            with pytest.raises(MediaUnavailable, match="placeholder"):
                svc.call(method, {"id": item["id"], "kind": "thumb"})
        monkeypatch.setattr("thumbs.media_stat",
                            lambda *a, **k: (_ for _ in ()).throw(MediaUnavailable("placeholder")))
        with pytest.raises(MediaUnavailable, match="placeholder"):
            make_thumb(str(root / "anything.jpg"), "thumb", str(tmp_path / "out.webp"), "1-2")
        assert not (tmp_path / "out.webp").exists()
    finally:
        svc.close()


def test_preview_strips_metadata_rotates_and_flattens_alpha(tmp_path):
    src, out = tmp_path / "test.jpg", tmp_path / "test.webp"
    exif = Image.Exif()
    exif[274], exif[270] = 6, "private description"
    Image.new("RGB", (120, 60), "red").save(src, exif=exif)
    make_thumb(str(src), "thumb", str(out), revision(media_stat(src)))
    with Image.open(out) as image:
        assert image.size == (60, 120)
        assert not image.getexif()
        assert not set(image.info) & {"exif", "xmp", "icc_profile"}
    src = tmp_path / "alpha.png"
    Image.new("RGBA", (20, 20), (0, 0, 0, 0)).save(src)
    make_thumb(str(src), "thumb", str(out), revision(media_stat(src)))
    with Image.open(out) as image:
        assert image.convert("RGB").getpixel((0, 0)) == (255, 255, 255)


def test_cache_changed_files_clear_and_lru_budget(tmp_path):
    src = tmp_path / "synthetic.jpg"
    Image.new("RGB", (100, 80), "green").save(src)
    cache = ThumbCache(tmp_path / "cache", limit_bytes=1, workers=1)
    try:
        ver = revision(media_stat(src))
        out = cache.get(src, "thumb", ver)
        assert out.read_bytes() == cache.get(src, "thumb", ver).read_bytes()
        assert cache.info()["files"] == 1
        cache.maintain()
        assert not out.exists() and cache.info()["bytes"] == 0
        Image.new("RGB", (120, 80), "blue").save(src)
        with pytest.raises(MediaUnavailable, match="changed"):
            cache.get(src, "thumb", ver)
        cache.get(src, "thumb", revision(media_stat(src)))
        cache.clear()
        assert cache.info()["files"] == 0
    finally:
        cache.close()


def test_video_preview_and_strip_decode_locally(tmp_path):
    from dashboard.fixtures.make_fixtures import make_video
    from datetime import datetime
    source = tmp_path / "fixture.mp4"
    make_video(source, ["red", "green"], datetime(2026, 1, 1), "sunset")
    for kind in ("thumb", "strip"):
        out = tmp_path / f"{kind}.webp"
        make_thumb(str(source), kind, str(out), revision(media_stat(source)))
        with Image.open(out) as image:
            assert image.width > 0 and not image.getexif()
            if kind == "strip":
                assert image.width == 1280
