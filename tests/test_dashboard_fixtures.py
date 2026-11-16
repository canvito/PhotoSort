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
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "dashboard" / "fixtures"))
import face_tagger  # noqa: E402
import fake_pair  # noqa: E402
import group  # noqa: E402
import local_only  # noqa: E402
import make_fixtures  # noqa: E402
import media  # noqa: E402
import photo_search  # noqa: E402
import photosort  # noqa: E402
import runctl  # noqa: E402
from dashboard_sidecar import Service  # noqa: E402


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


@pytest.fixture(scope="module")
def face_library(tmp_path_factory):
    """A library with every face set (36 pictures: six portraits) and its people folder beside it."""
    base = tmp_path_factory.mktemp("faces")
    assert make_fixtures.main(["--out", str(base / "library"), "--count", "36"]) == 0
    return base, json.loads((base / "library" / "fixture_manifest.json").read_text(encoding="utf-8"))["files"]


def test_fixture_pictures_say_who_is_in_them_and_the_people_folder_is_built(face_library):
    base, files = face_library
    people = base / "people"
    refs = sorted(people.glob("*/*.jpg"))
    assert sorted((p.parent.name, p.name) for p in refs) == sorted(make_fixtures.REFERENCES)
    for p in refs:
        with Image.open(p) as im:
            assert make_fixtures.faces_of(im) == [p.parent.name]
    assert [f["faces"] for f in files if f["kind"] == "portrait" and "faces" in f] == make_fixtures.FACE_SETS[:-1]
    turned = next(f for f in files if f["name"] == "portrait_016.jpg")
    with Image.open(base / "library" / turned["name"]) as im:
        assert im.size == (640, 480) and turned["faces"] == ["Alice", "Bob"]  # stored on its side (EXIF 6)
    for f in files:
        if f["kind"] != "video":  # no false faces in sunsets, receipts or screenshots
            with Image.open(base / "library" / f["name"]) as im:
                assert make_fixtures.faces_of(ImageOps.exif_transpose(im)) == f.get("faces", []), f["name"]
    assert next(f for f in files if f.get("label") == "forest")["faces"] == {"1": ["Alice"]}

    stranger = base / "not-people"
    stranger.mkdir()
    (stranger / "keep.txt").write_text("x")
    assert make_fixtures.main(["--out", str(base / "library"), "--people", str(stranger), "--count", "36"]) == 2
    assert [p.name for p in stranger.iterdir()] == ["keep.txt"]


def test_stand_in_face_worker_runs_the_real_pipeline_and_the_dashboard_reads_its_results(face_library, tmp_path,
                                                                                         monkeypatch):
    base, files = face_library
    library, people = base / "library", base / "people"
    monkeypatch.setenv(face_tagger.WORKER_ENV, str(ROOT / "tests" / "fake_face_worker.py"))
    runctl.configure(tmp_path / "events.jsonl")
    try:
        result = face_tagger.tag_people(library, people, None, photosort.IMAGE_EXTS, workers=["local:2"],
                                        video_exts=media.VIDEO_EXTS)
    finally:
        runctl.configure()
    records = {r["file"]: r for r in result["images"]}
    assert set(records) == {f["name"] for f in files} and result["summary"]["errors"] == 0
    for f in files:
        if f["kind"] == "video":
            continue
        faces = records[f["name"]]["faces"]
        expected = f.get("faces", [])
        assert [x["person"] for x in faces] == [None if n == "stranger" else n for n in expected], f["name"]
        assert all(x["similarity"] > 0.9 for x in faces if x["person"])
        assert all(x["similarity"] < 0.2 for x in faces if not x["person"])
    upright = records["portrait_016.jpg"]["faces"]
    assert [x["bbox"] for x in upright] == make_fixtures.face_boxes((480, 640), 2)  # in the upright picture
    forest = records[next(f["name"] for f in files if f.get("label") == "forest")]
    assert forest["people"] == {"Alice": len(forest["faces"])} and forest["faces"]
    assert 1.0 in {x["time_s"] for x in forest["faces"]} and all(1 <= x["time_s"] < 2 for x in forest["faces"])
    sunset = records[next(f["name"] for f in files if f.get("label") == "sunset")]
    assert (sunset["faces"], sunset["people"]) == ([], {})

    events = [json.loads(line) for line in (tmp_path / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    phases = [e["name"] for e in events if e["type"] == "phase"]
    assert phases == ["workers", "references", "videos", "detect", "match"]
    for phase in phases[1:4]:
        last = [e for e in events if e["type"] == "progress" and e["phase"] == phase][-1]
        assert last["done"] == last["total"] > 0
    items = [e for e in events if e["type"] == "item"]
    assert [e["n"] for e in items] == list(range(1, len(files) + 1))
    by_name = {Path(e["path"]).name: e["result"] for e in items}
    assert by_name["portrait_016.jpg"] == {"status": "named", "faces": 2, "people": ["Alice", "Bob"]}
    assert by_name["sunset_000.jpg"]["status"] == "no faces"

    config = tmp_path / "config.json"
    cfg = json.loads((ROOT / "dashboard" / "fixtures" / "config.fixture.json").read_text(encoding="utf-8"))
    config.write_text(json.dumps({**cfg, "index_path": str(base / "index.sqlite")}), encoding="utf-8")
    svc = Service(config, tmp_path / "data", [library, people])
    try:
        read = svc.call("faces.read", {"folder": str(library)})
        portraits = [f.get("faces", []) for f in files if f["kind"] == "portrait"]
        assert read["counts"]["people"] == {"Alice": sum("Alice" in p for p in portraits) + 1,
                                            "Bob": sum("Bob" in p for p in portraits)}
        assert read["counts"]["unknown"] == sum("stranger" in p for p in portraits)
        page = svc.call("faces.items", {"folder": str(library), "filter": "person:Alice"})
        assert {i["kind"] for i in page["items"]} == {"photo", "video"}
        turned = next(i for i in svc.call("faces.items", {"folder": str(library)})["items"]
                      if i["name"] == "portrait_016.jpg")
        detail = svc.call("faces.item", {"folder": str(library), "id": turned["id"]})
        assert (detail["width"], detail["height"]) == (480, 640)
        assert Path(svc.call("media.make", {"id": turned["id"], "kind": "preview"})["path"]).is_file()
    finally:
        svc.close()


def test_a_cancelled_face_run_stops_before_the_next_picture_and_writes_nothing(face_library, tmp_path, monkeypatch):
    base, _ = face_library
    monkeypatch.setenv(face_tagger.WORKER_ENV, str(ROOT / "tests" / "fake_face_worker.py"))
    runctl.configure()
    runctl.CANCEL.set()
    try:
        with pytest.raises(runctl.Cancelled):
            face_tagger.tag_people(base / "library", base / "people", tmp_path / "faces.json", photosort.IMAGE_EXTS,
                                   workers=["local:2"], video_exts=media.VIDEO_EXTS)
    finally:
        runctl.configure()
    assert not (tmp_path / "faces.json").exists()
