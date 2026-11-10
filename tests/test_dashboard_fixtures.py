"""Tests for the dashboard's fixture harness: the fake PAIR proxy and the synthetic media library."""
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "dashboard" / "fixtures"))
import fake_pair  # noqa: E402
import group  # noqa: E402
import local_only  # noqa: E402
import make_fixtures  # noqa: E402
import photo_search  # noqa: E402
import photosort  # noqa: E402


@pytest.fixture
def pair():
    server = fake_pair.make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    out = tmp_path_factory.mktemp("fixture") / "library"
    assert make_fixtures.main(["--out", str(out), "--count", "12"]) == 0
    return out, json.loads((out / "fixture_manifest.json").read_text(encoding="utf-8"))["files"]


def get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def test_fake_pair_lists_local_and_one_cloud_model_and_serves_nothing_else(pair):
    names = {m["name"]: m for m in get(pair + "/api/tags")["models"]}
    assert [n for n in names if local_only.is_cloud_model(n)] == ["gpt-oss:120b-cloud"]
    local_only.require_local_models(["gemma4:12b", "qwen3-embedding:8b"], list(names.values()))
    with pytest.raises(local_only.LocalOnlyError):
        local_only.require_local_models(["gpt-oss:120b-cloud"], list(names.values()))
    assert {"gemma4:12b", "qwen3-embedding:8b"} <= set(names)
    assert get(pair + "/api/ps")["models"][0]["name"] == "gemma4:12b"
    for method, path in (("GET", "/api/chat"), ("POST", "/api/pull"), ("POST", "/api/generate")):
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(urllib.request.Request(pair + path, data=b"{}" if method == "POST" else None,
                                                          method=method), timeout=5)
        assert e.value.code == 404


def test_fake_pair_listens_on_loopback_only():
    server = fake_pair.make_server(0)
    try:
        assert server.server_address[0] == "127.0.0.1"
    finally:
        server.server_close()


def test_fixture_config_is_local_and_matches_the_fake_models():
    cfg = json.loads((ROOT / "dashboard" / "fixtures" / "config.fixture.json").read_text(encoding="utf-8"))
    local_only.require_loopback(cfg["base_url"])
    names = {m["name"] for m in fake_pair.MODELS}
    assert {cfg["model"], cfg["caption_model"], cfg["embed_model"]} <= names
    assert "other" in cfg["buckets"] and cfg["face_workers"] == []
    assert "dashboard-fixture" in cfg["index_path"]


def test_fixture_library_has_capture_dates_and_is_rebuilt_only_when_needed(tmp_path, capsys):
    out = tmp_path / "library"
    assert make_fixtures.main(["--out", str(out), "--count", "12"]) == 0
    manifest = json.loads((out / "fixture_manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["files"]) == 14
    for f in manifest["files"]:
        video = f["kind"] == "video"
        taken, source = group.capture_time(out / f["name"], video=video)
        if f["name"].endswith(".png"):
            assert taken is None  # screenshots carry no date, like real ones without a dated name
        else:
            assert (taken, source) == (datetime.fromisoformat(f["taken"]), "video metadata" if video else "photo metadata")
    capsys.readouterr()
    assert make_fixtures.main(["--out", str(out), "--count", "12"]) == 0
    assert "up to date" in capsys.readouterr().out


def test_fixture_library_is_rebuilt_clean_after_files_were_sorted_away(tmp_path):
    out = tmp_path / "library"
    assert make_fixtures.main(["--out", str(out), "--count", "6"]) == 0
    (out / "food").mkdir()
    first = json.loads((out / "fixture_manifest.json").read_text(encoding="utf-8"))["files"][0]["name"]
    (out / first).rename(out / "food" / first)
    (out / "food" / "_photosort_journal.jsonl").write_text("{}\n", encoding="utf-8")
    assert make_fixtures.main(["--out", str(out), "--count", "6"]) == 0
    assert not (out / "food").exists()
    assert (out / first).is_file()

    stranger = tmp_path / "not-a-library"
    stranger.mkdir()
    (stranger / "keep.jpg").write_bytes(b"x")
    assert make_fixtures.main(["--out", str(stranger), "--count", "1"]) == 2
    assert (stranger / "keep.jpg").read_bytes() == b"x"


def test_fixture_library_refuses_onedrive(tmp_path, monkeypatch):
    monkeypatch.setenv("OneDrive", str(tmp_path))
    assert make_fixtures.main(["--out", str(tmp_path / "lib"), "--count", "1"]) == 2
    assert not (tmp_path / "lib").exists()


def test_fake_pair_answers_photosort_as_a_model_would_from_the_fixture_colour_codes(pair, library, tmp_path,
                                                                                     monkeypatch):
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    out, files = library
    cfg = {**json.loads((ROOT / "dashboard" / "fixtures" / "config.fixture.json").read_text(encoding="utf-8")),
           "base_url": pair, "index_path": str(tmp_path / "index.sqlite")}
    clf = photosort.Classifier(cfg)
    clf.preflight()
    for f in files:  # includes EXIF-rotated photos and both clips
        kind = f.get("label") or f["kind"]
        assert clf.classify(out / f["name"])[0] == fake_pair.BUCKETS[kind], f["name"]
        assert clf.matches(out / f["name"], "a sunset")[0] == (kind == "sunset"), f["name"]

    today = date(2026, 11, 10)
    plan = photosort.understand_request(clf, "receipt photos from 2026-10-01 to 2026-10-02", today)
    assert (plan["topic"], plan["media"], group.dates_text(plan)) == ("a receipt", "photos",
                                                                      "Thu 2026-10-01 to Fri 2026-10-02")

    search = photo_search.PairSearchClient(cfg, photosort.encode_image)
    s = photo_search.index_folder(cfg, out, search, photosort.MEDIA_EXTS)
    assert (s["captioned"], s["errors"]) == (len(files), 0)
    top = photo_search.search_index(cfg, "store receipt total", search, top=2)["results"]
    assert {Path(r["path"]).name.split("_")[0] for r in top} == {"receipt"}
    assert get(pair + "/fake/stats")["embed"] >= 2


def test_fake_pair_can_be_slow_or_fail_so_retries_and_cancel_can_be_tested():
    server = fake_pair.make_server(0, delay_ms=200, fail_rate=1.0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        started = time.perf_counter()
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(urllib.request.Request(url + "/api/embed", data=b'{"input": ["x"]}',
                                                          method="POST"), timeout=5)
        assert e.value.code == 500 and time.perf_counter() - started >= 0.2
        assert get(url + "/fake/stats") == {"chat": 0, "embed": 1, "failed": 1}
    finally:
        server.shutdown()
        server.server_close()
