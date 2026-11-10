"""Tests for the dashboard's fixture harness: the fake PAIR proxy and the synthetic media library."""
import json
import sys
import threading
import urllib.error
import urllib.request
from datetime import datetime
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


@pytest.fixture
def pair():
    server = fake_pair.make_server(0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()
    server.server_close()


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
    for method in ("GET", "POST"):
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(urllib.request.Request(pair + "/api/chat", data=b"{}" if method == "POST" else None,
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


def test_fixture_library_refuses_onedrive(tmp_path, monkeypatch):
    monkeypatch.setenv("OneDrive", str(tmp_path))
    assert make_fixtures.main(["--out", str(tmp_path / "lib"), "--count", "1"]) == 2
    assert not (tmp_path / "lib").exists()
