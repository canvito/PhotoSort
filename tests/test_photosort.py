import io
import json
import os
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import zlib
from datetime import date, datetime
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import photosort  # noqa: E402
import photo_search  # noqa: E402
import face_tagger  # noqa: E402
import face_worker  # noqa: E402
import group  # noqa: E402
import index_transfer  # noqa: E402
import media  # noqa: E402
import runctl  # noqa: E402
from local_only import LocalOnlyError  # noqa: E402

BUCKETS = {"people": "", "food": "", "screenshot_chat": "", "other": ""}
CFG = {"model": "fake", "concurrency": 4, "buckets": BUCKETS}


@pytest.fixture(autouse=True)
def private_search_index(tmp_path_factory, monkeypatch):
    """Point the default search index (and the folder locks) at a temp folder so tests never touch the real ones."""
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path_factory.mktemp("appdata")))
    yield
    runctl.configure()  # events off and no cancel left over for the next test


@pytest.mark.parametrize("url", ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"])
def test_loopback_endpoints_allowed(url):
    photosort.require_loopback(url)


@pytest.mark.parametrize("url", ["http://192.168.7.20:11434", "http://spark1:11434", "https://api.openai.com/v1"])
def test_non_loopback_endpoints_refused(url):
    with pytest.raises(photosort.LocalOnlyError):
        photosort.require_loopback(url)


@pytest.mark.parametrize("name", ["gpt-oss:120b-cloud", "glm-4.6:cloud", "minimax-m2-cloud"])
def test_cloud_models_refused_for_sort_index_and_search(name):
    cfg = {"base_url": "http://127.0.0.1:11434", "model": name, "caption_model": name,
           "max_side": 1024, "timeout_s": 1, "retries": 1, "buckets": BUCKETS}
    with pytest.raises(photosort.LocalOnlyError):
        photosort.Classifier(cfg)
    with pytest.raises(photosort.LocalOnlyError):
        photo_search.PairSearchClient(cfg, photosort.encode_image)


def test_preflight_refuses_model_the_cluster_reports_as_remote():
    tags = {"models": [{"name": "gemma4:12b"},
                       {"name": "qwen3-embedding:8b", "remote_host": "https://ollama.com:443"}]}

    class Tags:
        def raise_for_status(self):
            pass

        def json(self):
            return tags

    class Session:
        def get(self, url, timeout):
            return Tags()

    cfg = {"base_url": "http://127.0.0.1:11434", "max_side": 1024, "timeout_s": 1, "retries": 1}
    client = photo_search.PairSearchClient(cfg, photosort.encode_image)
    client._session = Session
    with pytest.raises(photosort.LocalOnlyError):
        client.preflight([client.s["embed_model"]])
    client.preflight([client.s["caption_model"]])


def test_parse_reply():
    assert photosort.parse_reply('{"bucket": "food", "confidence": 0.9}', BUCKETS) == ("food", 0.9)
    with pytest.raises(ValueError):
        photosort.parse_reply('{"bucket": "cars", "confidence": 1}', BUCKETS)
    with pytest.raises(ValueError):  # truncated output seen from mismatched model builds
        photosort.parse_reply('{\n  "bucket": "food"', BUCKETS)


class FakeClassifier:
    def classify(self, path):
        if path.stem == "broken":
            raise photosort.ClassifyError("model unavailable")
        return {"selfie": "people", "lunch": "food", "chat": "screenshot_chat"}[path.stem], 0.8


def test_sort_move_then_undo(tmp_path):
    for name in ["selfie.jpg", "lunch.JPG", "chat.png", "broken.jpg", "notes.txt"]:
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "selfie.jpg").write_bytes(b"already sorted")

    s = photosort.sort_folder(CFG, tmp_path, action="move", recursive=True, classifier=FakeClassifier())

    assert s["sorted"] == 3 and s["errors"] == 1 and s["skipped_non_images"] == 1
    assert (tmp_path / "people" / "selfie (1).jpg").exists()  # name collision does not overwrite
    assert (tmp_path / "people" / "selfie.jpg").read_bytes() == b"already sorted"
    assert (tmp_path / "food" / "lunch.JPG").exists()
    assert (tmp_path / "screenshot_chat" / "chat.png").exists()
    assert (tmp_path / "broken.jpg").exists() and (tmp_path / "notes.txt").exists()
    entries = [json.loads(x) for x in (tmp_path / photosort.JOURNAL_NAME).read_text().splitlines()]
    assert sum(1 for e in entries if e.get("error")) == 1

    u = photosort.undo(tmp_path / photosort.JOURNAL_NAME)

    assert u == {"run_id": s["run_id"], "restored": 3, "problems": 0}
    for name in ["selfie.jpg", "lunch.JPG", "chat.png"]:
        assert (tmp_path / name).exists()
    assert not (tmp_path / "food").exists()  # empty bucket folders are removed
    assert (tmp_path / "people" / "selfie.jpg").exists()  # pre-existing file untouched
    with pytest.raises(ValueError):
        photosort.undo(tmp_path / photosort.JOURNAL_NAME)


@pytest.mark.skipif(os.name != "nt", reason="the read-only folder flag only blocks rmdir on Windows")
def test_undo_removes_read_only_bucket_folders(tmp_path):
    (tmp_path / "lunch.jpg").write_bytes(b"x")
    photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    os.chmod(tmp_path / "food", stat.S_IREAD)  # what OneDrive does to synced folders

    assert photosort.undo(tmp_path / photosort.JOURNAL_NAME)["restored"] == 1
    assert (tmp_path / "lunch.jpg").exists() and not (tmp_path / "food").exists()


def test_report_action_moves_nothing(tmp_path):
    (tmp_path / "lunch.jpg").write_bytes(b"x")
    s = photosort.sort_folder(CFG, tmp_path, action="report", classifier=FakeClassifier())
    assert s["buckets"] == {"food": 1}
    assert (tmp_path / "lunch.jpg").exists() and not (tmp_path / "food").exists()


def test_recursive_moves_subfolder_photos_into_root_buckets_unchanged(tmp_path):
    files = {
        "selfie.jpg": b"root selfie",
        "06/lunch.jpg": b"june lunch",
        "07/selfie.jpg": b"july selfie",
        "07/people/chat.png": b"left in an old per-folder bucket",
    }
    for relative, content in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    s = photosort.sort_folder(CFG, tmp_path, action="move", recursive=True, classifier=FakeClassifier())

    assert s["sorted"] == 4 and s["errors"] == 0
    entries = [json.loads(x) for x in (tmp_path / photosort.JOURNAL_NAME).read_text().splitlines()]
    moved = {Path(e["src"]).relative_to(tmp_path).as_posix(): Path(e["dst"]).relative_to(tmp_path).as_posix()
             for e in entries}
    assert sorted(moved.values()) == ["food/lunch.jpg", "people/selfie (1).jpg", "people/selfie.jpg",
                                      "screenshot_chat/chat.png"]
    for src, dst in moved.items():
        assert (tmp_path / dst).read_bytes() == files[src]

    assert photosort.undo(tmp_path / photosort.JOURNAL_NAME)["restored"] == 4
    for relative, content in files.items():
        assert (tmp_path / relative).read_bytes() == content


@pytest.mark.parametrize("seconds,expected", [(0.4, "0.4s"), (42.34, "42.3s"), (59.97, "1m 00s"),
                                              (65.2, "1m 05s"), (3723, "1h 02m 03s")])
def test_format_duration(seconds, expected):
    assert photosort.format_duration(seconds) == expected


def test_finish_report_shows_duration(tmp_path):
    for name in ["selfie.jpg", "lunch.jpg", "notes.txt"]:
        (tmp_path / name).write_bytes(b"x")
    s = photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    text = photosort.format_report(s)
    assert f"Duration    : {photosort.format_duration(s['elapsed_s'])}" in text
    assert s["started_at"].replace("T", " ") in text and s["finished_at"].replace("T", " ") in text
    assert "2 files moved (2 photos, 0 videos); 0 errors; 1 other files left in place" in text
    assert "files/min" in text and "people" in text and "food" in text
    assert photosort.format_report({**s, "action": "report"}).count("no files changed") == 1


class FakeFaceBackend:
    provider = "CPUExecutionProvider"

    def detect(self, path):
        vectors = {
            "alice_ref.jpg": [[1.0, 0.0]],
            "bob_ref.jpg": [[0.0, 1.0]],
            "alice.jpg": [[0.98, 0.2], [0.0, 1.0]],
            "ambiguous.jpg": [[1.0, 1.0]],
            "unknown.jpg": [[-1.0, 0.0]],
            "empty_ref.jpg": [],
            "multiple_ref.jpg": [[1.0, 0.0], [0.0, 1.0]],
        }
        return [{"embedding": v, "bbox": [1, 2, 30, 40]} for v in vectors[path.name]]


def _face_fixture(tmp_path):
    source = tmp_path / "source"
    people = tmp_path / "people"
    source.mkdir()
    for person in ("Alice", "Bob"):
        folder = people / person
        folder.mkdir(parents=True)
        name = "alice_ref.jpg" if person == "Alice" else "bob_ref.jpg"
        (folder / name).write_bytes(b"reference")
    for name in ("alice.jpg", "ambiguous.jpg", "unknown.jpg"):
        (source / name).write_bytes(b"original")
    (source / "clip.mov").write_bytes(b"video")
    return source, people


def test_face_tagger_matches_locally_and_writes_sidecar(tmp_path):
    source, people = _face_fixture(tmp_path)
    output = source / "faces.json"
    result = face_tagger.tag_people(source, people, output, {".jpg"}, backend=FakeFaceBackend())

    assert result["provider"] == "CPUExecutionProvider"
    assert result["summary"] == {"images": 3, "videos": 0, "video_frames": 0, "faces": 4, "matched": 2,
                                 "unknown": 2, "errors": 0}
    data = json.loads(output.read_text(encoding="utf-8"))
    assert data["format"] == "photosort-faces-v1"
    by_file = {item["file"]: item for item in data["images"]}
    assert [face["person"] for face in by_file["alice.jpg"]["faces"]] == ["Alice", "Bob"]
    assert by_file["ambiguous.jpg"]["faces"][0]["person"] is None
    assert by_file["unknown.jpg"]["faces"][0]["person"] is None
    assert by_file["alice.jpg"]["faces"][0]["bbox"] == [1, 2, 30, 40]
    assert (source / "alice.jpg").read_bytes() == b"original"
    assert not (source / "Alice").exists()
    assert "clip.mov" not in by_file


def test_face_tagger_excludes_people_and_output_from_recursive_scan(tmp_path):
    source, people = _face_fixture(tmp_path)
    (source / "nested").mkdir()
    (source / "nested" / "alice.jpg").write_bytes(b"original")
    result = face_tagger.tag_people(source, people, None, {".jpg"}, recursive=True, backend=FakeFaceBackend())
    assert result["summary"]["images"] == 4
    assert result["output"].endswith("photosort_faces.json")
    again = face_tagger.tag_people(source, people, None, {".jpg"}, recursive=True, backend=FakeFaceBackend())
    assert again["summary"]["images"] == 4


@pytest.mark.parametrize("filename,count", [("empty_ref.jpg", 0), ("multiple_ref.jpg", 2)])
def test_face_tagger_rejects_bad_reference_photos(tmp_path, filename, count):
    source = tmp_path / "source"
    people = tmp_path / "people"
    source.mkdir()
    folder = people / "Alice"
    folder.mkdir(parents=True)
    (folder / filename).write_bytes(b"bad reference")
    with pytest.raises(face_tagger.FaceTaggingError, match=f"found {count}"):
        face_tagger.tag_people(source, people, None, {".jpg"}, backend=FakeFaceBackend())


def test_face_tagger_refuses_to_download_missing_model(tmp_path):
    with pytest.raises(face_tagger.FaceTaggingError, match="will not download models"):
        face_tagger.InsightFaceBackend(model_dir=tmp_path)


def test_parse_workers():
    assert face_tagger.parse_workers("spark1:16, local:2") == [
        face_tagger.WorkerSpec("spark1", 16), face_tagger.WorkerSpec("local", 2)]
    assert face_tagger.parse_workers(["admin@spark1"])[0].threads == face_tagger.DEFAULT_THREADS
    for bad in ("-oProxyCommand=calc", "spark1;rm", "spark1:0", "spark1:x", "spark1,spark1:4", ""):
        with pytest.raises(ValueError):
            face_tagger.parse_workers(bad)


@pytest.mark.parametrize("address,allowed", [
    ("192.168.7.20", True), ("100.64.1.2", True), ("fe80::1%3", True), ("8.8.8.8", False)])
def test_face_workers_must_be_on_the_lan(address, allowed):
    def resolve(target, port):
        return [(None, None, None, None, (address, port))]

    if allowed:
        assert face_tagger.check_private_addresses("node", "node", resolve) == [address]
    else:
        with pytest.raises(face_tagger.FaceTaggingError, match="public"):
            face_tagger.check_private_addresses("node", "node", resolve)


class FakeWorkerBackend:
    provider = "FakeProvider"

    def detect(self, payload):
        if payload == b"corrupt":
            raise ValueError("cannot identify image")
        return [{"bbox": [1, 2, 3, 4], "embedding": [0.6, 0.8]}]


def _run_in_thread(target, *args):
    box = {}
    thread = threading.Thread(target=lambda: box.setdefault("result", target(*args)), daemon=True)
    thread.start()
    return thread, box


def test_worker_protocol_round_trip_over_pipes():
    to_worker, from_coordinator = os.pipe()
    to_coordinator, from_worker = os.pipe()
    worker_in, worker_out = open(to_worker, "rb"), open(from_worker, "wb")

    def worker():
        with worker_in, worker_out:
            return face_worker.serve(worker_in, worker_out, 2, FakeWorkerBackend)

    thread, box = _run_in_thread(worker)
    with open(to_coordinator, "rb") as reader:
        conn = face_tagger.WorkerConnection.over_streams("test", open(from_coordinator, "wb"), reader, 2,
                                                         ready_timeout=10)
        assert conn.provider == "FakeProvider" and conn.info["threads"] == 2
        faces = conn.detect(b"jpeg bytes")
        assert faces[0]["bbox"] == [1, 2, 3, 4]
        assert faces[0]["embedding"] == pytest.approx([0.6, 0.8])
        with pytest.raises(face_tagger.FaceTaggingError, match="cannot identify image"):
            conn.detect(b"corrupt")
        assert conn.alive  # one bad image does not take the worker down
        conn.close()
        thread.join(10)
    assert box["result"] == 0 and conn.error == "closed"


def test_worker_setup_failure_is_reported_to_coordinator():
    def broken_backend():
        raise face_worker.FaceTaggingError("face-tagging dependencies are missing")

    writer = io.BytesIO()
    assert face_worker.serve(io.BytesIO(), writer, 1, broken_backend) == 2
    reader = io.BytesIO(writer.getvalue())
    with pytest.raises(face_tagger.WorkerDied, match="dependencies are missing"):
        face_tagger.WorkerConnection.over_streams("spark1", io.BytesIO(), reader, 1, ready_timeout=10)


def test_socket_worker_requires_the_session_token(monkeypatch):
    monkeypatch.setattr(face_worker, "_exit_when_closed", lambda stream: None)
    port, token = face_tagger._free_local_port(), b"t" * 32
    control_r, control_w = os.pipe()
    control_out = open(control_w, "wb")

    def worker():
        with control_out:
            return face_worker.serve_socket(port, token, 2, FakeWorkerBackend, None, control_out)

    thread, box = _run_in_thread(worker)
    conn = face_tagger.WorkerConnection("spark1", 2)
    with open(control_r, "rb") as control_in:
        conn.handshake(control_in, 10)
    with socket.create_connection(("127.0.0.1", port), timeout=10) as intruder:
        intruder.sendall(b"x" * 32)
        assert intruder.recv(1) == b""  # wrong token: disconnected without being served
    sock = socket.create_connection(("127.0.0.1", port), timeout=10)
    sock.sendall(token)
    conn.attach(sock.makefile("wb"), sock.makefile("rb"), sock)
    assert conn.detect(b"jpeg bytes")[0]["bbox"] == [1, 2, 3, 4]
    conn.close()
    thread.join(10)
    assert box["result"] == 0


class FakeConnection:
    def __init__(self, label, dies=False):
        self.label, self.threads, self.dies = label, 1, dies
        self.info, self.provider, self.error = {"host": label}, "FakeProvider", None

    @property
    def alive(self):
        return self.error is None

    def detect(self, data):
        if self.dies:
            self.error = "connection lost"
            raise face_tagger.WorkerDied(f"{self.label}: connection lost")
        return [{"bbox": [0, 0, 1, 1], "embedding": [1.0, 0.0], "data": data}]


def test_worker_pool_retries_on_another_worker_and_preserves_order(tmp_path):
    paths = []
    for i in range(6):
        paths.append(tmp_path / f"{i}.jpg")
        paths[-1].write_bytes(f"image {i}".encode())
    pool = face_tagger.WorkerPool([FakeConnection("spark1", dies=True), FakeConnection("local")])
    results = face_tagger._detect_all(pool, paths)
    assert [faces[0]["data"] for faces, error in results] == [f"image {i}".encode() for i in range(6)]
    summary = {row["worker"]: row for row in pool.summary()}
    assert summary["local"]["images"] == 6 and summary["spark1"]["failed"] == "connection lost"
    with pytest.raises(face_tagger.NoWorkersLeft):
        face_tagger.WorkerPool([FakeConnection("spark1", dies=True)]).detect(paths[0])


FAKE_CAPTIONS = {
    "cat": {"caption": "A fluffy cat sleeping on a sofa.", "scene": "indoor living room",
            "objects": ["cat", "sofa"], "text": "", "people_count": 0},
    "beach": {"caption": "Kids playing in the sand at the beach.", "scene": "outdoor beach",
              "objects": ["sand", "ocean"], "text": "", "people_count": 2},
    "receipt": {"caption": "A paper document lying on a table.", "scene": "indoor table",
                "objects": ["paper"], "text": "SAFEWAY TOTAL 42.17", "people_count": 0},
    "lunch": {"caption": "A plate of noodles.", "scene": "indoor restaurant",
              "objects": ["noodles", "plate"], "text": "", "people_count": 0},
}


class FakeSearchClient:
    """Captions from a lookup table and bag-of-words vectors, so ranking is predictable."""

    def __init__(self):
        self.captioned = []

    def caption(self, path):
        self.captioned.append(path.name)
        return FAKE_CAPTIONS[path.stem]

    def embed(self, texts, query=False):
        v = np.zeros((len(texts), 256), dtype=np.float32)
        for row, text in zip(v, texts):
            for word in re.findall(r"[a-z]+", text.lower()):
                row[zlib.crc32(word.encode()) % 256] += 1
        return photo_search.unit_rows(v)


def make_photos(folder, names):
    for name in names:
        (folder / name).write_bytes(f"pixels of {name}".encode())


def top_hit(query, client):
    return photo_search.search_index(CFG, query, client, top=1)["results"][0]


def test_index_and_search_match_caption_or_visible_text(tmp_path):
    make_photos(tmp_path, ["cat.jpg", "beach.jpg", "receipt.png"])
    (tmp_path / "notes.txt").write_text("not a photo")
    client = FakeSearchClient()

    s = photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)

    assert (s["images"], s["captioned"], s["reused"], s["unchanged"], s["errors"]) == (3, 3, 0, 0, 0)
    assert Path(top_hit("sleeping cat", client)["path"]).name == "cat.jpg"
    assert Path(top_hit("kids at the beach", client)["path"]).name == "beach.jpg"
    assert Path(top_hit("safeway receipt", client)["path"]).name == "receipt.png"  # via the text vector

    again = photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)
    assert (again["captioned"], again["unchanged"]) == (0, 3) and len(client.captioned) == 3


def test_index_reuses_moved_photo_by_content_and_drops_old_path(tmp_path):
    make_photos(tmp_path, ["cat.jpg", "beach.jpg"])
    client = FakeSearchClient()
    photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)
    (tmp_path / "2026").mkdir()
    (tmp_path / "cat.jpg").rename(tmp_path / "2026" / "kitty.jpg")

    s = photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)

    assert (s["captioned"], s["reused"], s["unchanged"], s["removed"]) == (0, 1, 1, 1)
    assert len(client.captioned) == 2  # no model call for the moved photo
    r = photo_search.search_index(CFG, "cat", client)
    assert r["searched"] == 2 and r["results"][0]["path"] == str(tmp_path.resolve() / "2026" / "kitty.jpg")


def test_sort_and_undo_keep_search_index_paths_current(tmp_path):
    make_photos(tmp_path, ["lunch.jpg"])
    client = FakeSearchClient()
    photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)

    photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    hit = top_hit("noodles", client)
    assert hit["path"] == str(tmp_path.resolve() / "food" / "lunch.jpg") and hit["exists"]

    photosort.undo(tmp_path / photosort.JOURNAL_NAME, index_db=photo_search.index_path(CFG))
    hit = top_hit("noodles", client)
    assert hit["path"] == str(tmp_path.resolve() / "lunch.jpg") and hit["exists"]
    assert photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)["unchanged"] == 1


def test_photo_edited_before_sort_is_described_again(tmp_path):
    make_photos(tmp_path, ["lunch.jpg"])
    client = FakeSearchClient()
    photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)
    (tmp_path / "lunch.jpg").write_bytes(b"cropped in the Photos app")

    photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    s = photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)

    assert (s["captioned"], s["unchanged"]) == (1, 0) and client.captioned == ["lunch.jpg", "lunch.jpg"]


def test_case_only_rename_leaves_one_index_entry(tmp_path):
    make_photos(tmp_path, ["cat.jpg"])
    client = FakeSearchClient()
    photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)
    (tmp_path / "cat.jpg").rename(tmp_path / "CAT.jpg")

    s = photo_search.index_folder(CFG, tmp_path, client, photosort.IMAGE_EXTS)

    assert (s["reused"], s["removed"], s["total_indexed"]) == (1, 1, 1)
    assert [Path(x["path"]).name for x in photo_search.search_index(CFG, "cat", client)["results"]] == ["CAT.jpg"]


def pc_config(tmp_path, name):
    return {**CFG, "index_path": str(tmp_path / name / "search_index.sqlite")}


def test_index_moves_to_another_pc_without_reading_or_describing_its_files_again(tmp_path, capsys):
    pc_a, pc_b = pc_config(tmp_path, "pc_a"), pc_config(tmp_path, "pc_b")
    home_a, home_b = tmp_path / "a" / "Users" / "bob", tmp_path / "b" / "Users" / "carol"
    pics_a, pics_b = home_a / "Pictures", home_b / "Pictures"
    pics_a.mkdir(parents=True)
    pics_b.mkdir(parents=True)
    make_photos(pics_a, ["cat.jpg", "beach.jpg", "receipt.png", "lunch.jpg"])
    photo_search.index_folder(pc_a, pics_a, FakeSearchClient(), photosort.IMAGE_EXTS)
    export = tmp_path / "usb" / "index.sqlite"
    export.parent.mkdir()
    assert index_transfer.export_index(pc_a, export)["files"] == 4

    for name in ["cat.jpg", "beach.jpg", "receipt.png"]:  # lunch.jpg is not on this PC
        shutil.copy2(pics_a / name, pics_b / name)
    st = (pics_b / "cat.jpg").stat()
    os.utime(pics_b / "cat.jpg", ns=(st.st_atime_ns, st.st_mtime_ns // 10**9 * 10**9))  # synced in whole seconds
    (pics_b / "receipt.png").write_bytes(b"edited on this PC")
    maps = [(str(home_a).upper(), str(home_b))]

    dry = index_transfer.import_index(pc_b, export, maps, dry_run=True)
    assert (dry["ready"], dry["changed"], dry["missing"], dry["total_indexed"]) == (2, 1, 1, 3)
    assert not Path(pc_b["index_path"]).exists()

    config = cli_config(tmp_path, index_path=pc_b["index_path"])
    assert photosort.main(["--config", str(config), "index-import", str(export), "--map", *maps[0]]) == 0
    out = capsys.readouterr().out
    assert "Ready to search here" in out and "cat.jpg" not in out and "SAFEWAY" not in out

    client = FakeSearchClient()
    s = photo_search.index_folder(pc_b, pics_b, client, photosort.IMAGE_EXTS)
    assert (s["unchanged"], s["captioned"], s["total_indexed"]) == (2, 1, 3) and client.captioned == ["receipt.png"]
    hit = photo_search.search_index(pc_b, "kids at the beach", client, top=1)["results"][0]
    assert hit["path"] == str(pics_b.resolve() / "beach.jpg")

    again = index_transfer.import_index(pc_b, export, maps)
    assert (again["kept"], again["ready"], again["changed"], again["missing"]) == (3, 0, 0, 1)
    assert Path(again["backup"]).is_file()


def test_index_export_stays_out_of_onedrive_and_import_checks_its_inputs(tmp_path, monkeypatch):
    pc = pc_config(tmp_path, "pc")
    pics = tmp_path / "pics"
    pics.mkdir()
    make_photos(pics, ["cat.jpg"])
    photo_search.index_folder(pc, pics, FakeSearchClient(), photosort.IMAGE_EXTS)
    onedrive = tmp_path / "OneDrive"
    onedrive.mkdir()
    monkeypatch.setenv("OneDrive", str(onedrive))

    with pytest.raises(LocalOnlyError):
        index_transfer.export_index(pc, onedrive / "index.sqlite")
    assert not any(onedrive.iterdir())
    assert index_transfer.export_index(pc, onedrive / "index.sqlite", allow_onedrive=True)["files"] == 1
    with pytest.raises(ValueError, match="already exists"):
        index_transfer.export_index(pc, onedrive / "index.sqlite", allow_onedrive=True)

    not_index = tmp_path / "notes.sqlite"
    not_index.write_text("not a database")
    with pytest.raises(photo_search.SearchError):
        index_transfer.import_index(pc, not_index)
    with pytest.raises(FileNotFoundError, match="not found on this PC"):
        index_transfer.import_index(pc, onedrive / "index.sqlite", [("C:\\Users\\bob", str(tmp_path / "nope"))])
    with pytest.raises(ValueError, match="own index"):
        index_transfer.import_index(pc, Path(pc["index_path"]))


COLORS = {"red": (255, 0, 0), "blue": (0, 0, 255), "green": (0, 128, 0), "yellow": (255, 255, 0),
          "white": (255, 255, 255)}


def make_video(path, colors, fps=10, gop=10, size=(64, 48), metadata=None):
    """A small mpeg4 video showing one solid color per second, with a keyframe every `gop` frames."""
    av = pytest.importorskip("av")
    with av.open(str(path), "w", options={"movflags": "use_metadata_tags"} if metadata else {}) as out:
        out.metadata.update(metadata or {})
        stream = out.add_stream("mpeg4", rate=fps)
        stream.width, stream.height = size
        stream.pix_fmt = "yuv420p"
        stream.codec_context.gop_size = gop
        stream.codec_context.options = {"sc_threshold": "1000000000"}  # no extra keyframes at color changes
        for i in range(len(colors) * fps):
            frame = av.VideoFrame.from_image(Image.new("RGB", size, colors[i // fps]))
            frame.pts, frame.time_base = i, Fraction(1, fps)
            for packet in stream.encode(frame):
                out.mux(packet)
        for packet in stream.encode():
            out.mux(packet)
    return path.read_bytes()


def color_of(im):
    pixel = im.convert("RGB").getpixel((im.width // 2, im.height // 2))
    return min(COLORS, key=lambda name: sum((a - b) ** 2 for a, b in zip(COLORS[name], pixel)))


def test_video_frames_are_spread_over_time_and_face_mode_fills_keyframe_gaps(tmp_path):
    colors = ["red", "red", "blue", "green", "yellow", "white"]
    make_video(tmp_path / "keyframe_every_second.mp4", colors * 2)
    make_video(tmp_path / "keyframes_3s_apart.mp4", colors, gop=30)

    frames = list(media.video_frames(tmp_path / "keyframe_every_second.mp4"))
    times = [t for t, _ in frames]
    assert len(frames) == media.VIDEO_FRAMES and times == sorted(times) and times[-1] - times[0] > 8
    assert all(t == int(t) for t in times)  # whole keyframes when there are enough of them
    assert [color_of(im) for _, im in frames] == [(colors * 2)[int(t)] for t in times]

    sparse = list(media.video_frames(tmp_path / "keyframes_3s_apart.mp4"))
    assert len(sparse) == media.VIDEO_FRAMES  # frames between keyframes decode to the right picture
    assert [color_of(im) for _, im in sparse] == [colors[int(t)] for t, _ in sparse]
    faces = [t for t, _ in media.video_frames(tmp_path / "keyframes_3s_apart.mp4", count=None)]
    assert faces == pytest.approx([0, 1, 2, 3, 4, 5])


@pytest.mark.parametrize("rotation,size,top_left", [(0, (2, 1), "red"), (-90, (1, 2), "red"),
                                                    (90, (1, 2), "blue"), (180, (2, 1), "blue")])
def test_rotated_video_frames_are_turned_upright(rotation, size, top_left):
    class Frame:  # stored picture: red left half, blue right half
        def __init__(self):
            self.rotation = rotation

        def to_image(self):
            im = Image.new("RGB", (2, 1), "red")
            im.putpixel((1, 0), COLORS["blue"])
            return im

    im = media._upright(Frame())  # -90 = phone portrait video: turn 90 degrees clockwise for display
    assert im.size == size and im.getpixel((0, 0)) == COLORS[top_left]


class FakeChat:
    """Stands in for the PAIR proxy: records each request and answers with the next reply (the last one repeats).
    A reply is the message text, or (text, done_reason)."""

    def __init__(self, *replies):
        self.replies, self.bodies = replies, []

    def post(self, url, json, timeout):
        self.bodies.append(json)
        reply = self.replies[min(len(self.bodies), len(self.replies)) - 1]
        content, done = reply if isinstance(reply, tuple) else (reply, "stop")

        class Response:
            def raise_for_status(self):
                pass

            def json(self):
                return {"message": {"content": content}, "done_reason": done}

        return Response()


LOCAL = {"base_url": "http://127.0.0.1:11434", "max_side": 256, "timeout_s": 5, "retries": 1}


def test_video_is_sorted_from_frames_in_time_order_and_moved_unchanged(tmp_path):
    original = make_video(tmp_path / "clip.mov", ["red", "blue", "green"])
    Image.new("RGB", (40, 30), "red").save(tmp_path / "photo.jpg")
    cfg = {**CFG, **LOCAL, "model": "gemma4:12b"}
    chat = FakeChat('{"bucket": "people", "confidence": 0.9}')
    clf = photosort.Classifier(cfg)
    clf._session = lambda: chat

    s = photosort.sort_folder(cfg, tmp_path, action="move", classifier=clf)

    assert (s["sorted"], s["videos"], s["errors"]) == (2, 1, 0)
    assert (tmp_path / "people" / "clip.mov").read_bytes() == original
    prompts = {len(b["messages"][0]["images"]): b["messages"][0]["content"] for b in chat.bodies}
    assert prompts[8].startswith("Here are 8 frames, in time order, from one video")
    assert prompts[1].startswith("Sort this image")
    assert all(b["options"]["num_ctx"] == 4096 for b in chat.bodies)


def test_video_is_captioned_from_frames_and_found_by_search(tmp_path):
    make_video(tmp_path / "beach.mov", ["yellow", "blue"])
    make_photos(tmp_path, ["cat.jpg"])
    pair = photo_search.PairSearchClient({**CFG, **LOCAL}, photosort.encode_image)
    chat = FakeChat(json.dumps(FAKE_CAPTIONS["beach"]))
    pair._session = lambda: chat
    assert pair.caption(tmp_path / "beach.mov")["caption"] == FAKE_CAPTIONS["beach"]["caption"]
    message = chat.bodies[0]["messages"][0]
    assert len(message["images"]) == 8 and message["content"] == photo_search.VIDEO_PROMPT

    client = FakeSearchClient()
    s = photo_search.index_folder(CFG, tmp_path, client, photosort.MEDIA_EXTS)
    assert (s["images"], s["videos"], s["captioned"]) == (2, 1, 2)
    assert Path(top_hit("video of kids at the beach", client)["path"]).name == "beach.mov"
    again = photo_search.index_folder(CFG, tmp_path, client, photosort.MEDIA_EXTS)
    assert (again["captioned"], again["unchanged"]) == (0, 2)


def test_caption_cut_off_by_a_repetition_loop_is_redone_with_the_text_field_capped(tmp_path):
    Image.new("RGB", (40, 30), "red").save(tmp_path / "cat.jpg")
    pair = photo_search.PairSearchClient({**CFG, **LOCAL, "retries": 3}, photosort.encode_image)
    chat = FakeChat(('{"caption": "a sign", "text": "SALE SALE SALE SALE', "length"), json.dumps(FAKE_CAPTIONS["beach"]))
    pair._session = lambda: chat
    assert pair.caption(tmp_path / "cat.jpg")["caption"] == FAKE_CAPTIONS["beach"]["caption"]
    caps = [b["format"]["properties"]["text"].get("maxLength") for b in chat.bodies]
    assert caps == [None, photo_search.TEXT_LIMIT]
    assert chat.bodies[0]["format"] == photo_search.SCHEMA  # normal captions are requested exactly as before

    looping = FakeChat(('{"caption": "a sign", "text": "SALE SALE', "length"))
    pair._session = lambda: looping
    with pytest.raises(photo_search.SearchError, match="length limit"):
        pair.caption(tmp_path / "cat.jpg")
    # the looping request is never resent as is; the other attempts may reach a node that does not loop
    assert [b["format"]["properties"]["text"].get("maxLength") for b in looping.bodies] == [None, 300, 300]


class ColorFaceBackend(FakeFaceBackend):
    """Reference photos by file name; in video frames red shows Alice, blue shows Bob and green shows nobody."""
    concurrency = 2  # parallel path: video frames are prepared in worker processes

    def detect(self, source):
        if isinstance(source, Path):
            return super().detect(source)
        vector = {"red": [1.0, 0.0], "blue": [0.0, 1.0]}.get(color_of(Image.open(io.BytesIO(source))))
        return [{"embedding": vector, "bbox": [1, 2, 30, 40]}] if vector else []


def test_face_tagger_samples_video_frames_and_records_when_people_appear(tmp_path):
    source, people = _face_fixture(tmp_path)  # includes clip.mov, which is not a real video
    original = make_video(source / "party.mp4", ["red", "red", "blue", "green", "green", "red"])

    result = face_tagger.tag_people(source, people, None, {".jpg"}, backend=ColorFaceBackend(),
                                    video_exts=media.VIDEO_EXTS)

    s = result["summary"]
    assert (s["images"], s["videos"], s["video_frames"], s["errors"]) == (3, 2, 6, 1)
    by_file = {r["file"]: r for r in json.loads(Path(result["output"]).read_text(encoding="utf-8"))["images"]}
    party = by_file["party.mp4"]  # 6 frames = 2 jobs, merged back in time order
    assert party["type"] == "video" and party["frames"] == 6 and party["people"] == {"Alice": 3, "Bob": 1}
    assert [(f["time_s"], f["person"]) for f in party["faces"]] == [
        (0.0, "Alice"), (1.0, "Alice"), (2.0, "Bob"), (5.0, "Alice")]
    assert by_file["clip.mov"]["type"] == "video" and "error" in by_file["clip.mov"]
    assert "time_s" not in by_file["alice.jpg"]["faces"][0]
    assert (source / "party.mp4").read_bytes() == original
    assert "3 images, 2 videos (6 frames)" in face_tagger.format_face_report(result)


def test_video_frame_png_is_lossless():
    pixels = np.random.default_rng(0).integers(0, 256, (37, 53, 3), dtype=np.uint8)
    with Image.open(io.BytesIO(media.png_bytes(Image.fromarray(pixels)))) as back:
        assert back.mode == "RGB" and np.array_equal(np.asarray(back), pixels)


def frames_or_crash(path, picks):
    """Runs in a frame pool process; a file named crash* kills its process like a decoder crash would."""
    if Path(path).name.startswith("crash"):
        os._exit(3)
    return [(seconds, b"png") for seconds in picks]


def test_a_crashed_frame_process_fails_only_its_own_video():
    from concurrent.futures import ThreadPoolExecutor
    from concurrent.futures.process import BrokenProcessPool

    pool = face_tagger._FramePool(2, frames_or_crash)
    try:
        names = ["a.mov", "crash.mov", "b.mov", "c.mov", "d.mov"]
        with ThreadPoolExecutor(len(names)) as threads:
            futures = {name: threads.submit(pool.frames, name, [1.0]) for name in names}
        assert isinstance(futures["crash.mov"].exception(), BrokenProcessPool)
        assert {n: f.result() for n, f in futures.items() if n != "crash.mov"} == {
            n: [(1.0, b"png")] for n in names if n != "crash.mov"}
        assert pool.frames("e.mov", [2.0]) == [(2.0, b"png")]
    finally:
        pool.shutdown()


# ---------- group by plain-language request ----------

TODAY = date(2026, 11, 10)  # a Tuesday; "last Sunday" is 2026-11-08
APPLE_DATE = "com.apple.quicktime.creationdate"


def photo_taken(path, when=None):
    """A small photo with EXIF DateTimeOriginal `when` ("YYYY:MM:DD HH:MM:SS"), or with no EXIF at all."""
    exif = Image.Exif()
    exif[0x8769] = {0x9003: when}
    Image.new("RGB", (32, 24), "red").save(path, **({"exif": exif.tobytes()} if when else {}))
    return path


def reading(**changes):
    """One reading of a request as the model would return it (default: birthday party last Sunday)."""
    reply = {"topic": "a birthday party", "media": "both", "date_from": "2026-11-08", "date_to": "2026-11-08",
             "people_named": [], "folder_name": "Birthday party", **changes}
    return json.dumps(reply)


def test_capture_time_prefers_metadata_and_reads_onedrive_names_as_utc(tmp_path):
    photo = photo_taken(tmp_path / "20261109_030000000_iOS.jpg", "2026:11:08 19:00:00")
    assert group.capture_time(photo, False) == (datetime(2026, 11, 8, 19), "photo metadata")
    named = photo_taken(tmp_path / "20261108_120000000_iOS.png")
    assert group.capture_time(named, False) == (group._local(datetime(2026, 11, 8, 12)), "file name")
    assert group.capture_time(photo_taken(tmp_path / "scan.jpg"), False) == (None, "none")

    make_video(tmp_path / "edited.mov", ["red"], metadata={  # an edited clip: creation_time is the export
        APPLE_DATE: "2026-11-08T18:00:00-0800", "creation_time": "2026-11-20T00:00:00.000000Z"})
    assert group.capture_time(tmp_path / "edited.mov", True) == (datetime(2026, 11, 8, 18), "video metadata")
    make_video(tmp_path / "export.mov", ["red"], metadata={"creation_time": "2026-11-08T20:00:00.000000Z"})
    assert group.capture_time(tmp_path / "export.mov", True) == (group._local(datetime(2026, 11, 8, 20)),
                                                                 "video metadata")

    span = group.window(group.parse_request_reply(reading(), TODAY))
    assert span == (datetime(2026, 11, 8), datetime(2026, 11, 9, 4))  # a party can run past midnight
    assert group.far_by_name("20261020_120000000_iOS.jpg", span)
    assert not group.far_by_name("20261109_070000000_iOS.jpg", span) and not group.far_by_name("IMG_1.jpg", span)


def test_request_readings_must_agree_and_name_something_to_find():
    def plan(*replies, overrides=None):
        return group.agree([group.parse_request_reply(r, TODAY) for r in replies], TODAY, overrides)

    p = plan(reading(), reading(topic="birthday party"), reading())
    assert (p["topic"], p["media"], group.dates_text(p)) == ("a birthday party", "both", "Sun 2026-11-08")
    sunday_or_saturday = (reading(), reading(date_from="2026-11-07", date_to="2026-11-07"))
    with pytest.raises(group.GroupError, match="different ways"):
        plan(*sunday_or_saturday)
    fixed = plan(*sunday_or_saturday, overrides={"date_from": date(2026, 11, 7), "date_to": date(2026, 11, 8)})
    assert group.dates_text(fixed) == "Sat 2026-11-07 to Sun 2026-11-08"
    with pytest.raises(group.GroupError, match="different ways"):
        plan(reading(), reading(topic=""))
    with pytest.raises(group.GroupError, match="future"):
        plan(reading(date_from="2026-11-15", date_to="2026-11-15"))
    assert plan(reading(date_from="2026-11-09", date_to="2026-11-15"))["date_to"] == TODAY
    with pytest.raises(group.GroupError, match="neither"):
        plan(reading(topic="", date_from="", date_to=""))
    with pytest.raises(group.GroupError, match="specific people"):
        plan(reading(topic="", people_named=["mom"]))
    assert plan(reading(people_named=["mom"]))["people"] == ["mom"]  # the topic is used; the report says so

    assert group.folder_name(p, None, BUCKETS) == "Birthday party 2026-11-08"
    assert group.folder_name({**p, "folder_name": 'Food: "best" <of>?'}, None, BUCKETS) == "Food best of 2026-11-08"
    assert group.folder_name(p, "food", BUCKETS) == "food group" and group.folder_name(p, "CON", {}) == "CON group"


def test_named_days_are_worked_out_in_code():
    sunday = {name: (a, b) for name, a, b in group.named_days(date(2026, 11, 8))}
    assert sunday["this weekend"] == (date(2026, 11, 7), date(2026, 11, 8))
    assert sunday["last weekend"] == (date(2026, 10, 31), date(2026, 11, 1))
    assert sunday['last Sunday (also "on Sunday")'] == (date(2026, 11, 1),) * 2
    days = {name: a for name, a, _ in group.named_days(TODAY)}
    assert days["Thanksgiving"] == date(2025, 11, 27) and days["Halloween"] == date(2026, 10, 31)
    assert days["the Sunday before last (two Sundays ago)"] == date(2026, 11, 1) and "this weekend" not in days


def test_media_comes_from_the_requests_own_words_and_a_negated_request_must_be_confirmed():
    def plan(request, *replies, overrides=None):
        return group.plan_request([group.parse_request_reply(r, TODAY) for r in replies], request, TODAY, overrides)

    assert plan("the snow photos last Sunday", reading(media="both"))["media"] == "photos"
    assert plan("photo and video of the party", reading(media="photos"))["media"] == "both"
    assert plan("party last Sunday", reading(media="videos"), overrides={"media": "videos"})["media"] == "videos"
    assert group.media_from_words("everything except the videos") == ("photos", False)
    assert plan("everything except the videos", reading(media="photos"))["media"] == "photos"
    with pytest.raises(group.GroupError, match="--media photos"):
        plan("everything except the videos", reading(media="both"))


def test_request_is_read_three_times_as_text_only_with_a_dated_calendar():
    chat = FakeChat(reading())
    clf = photosort.Classifier({**CFG, **LOCAL})
    clf._session = lambda: chat

    p = photosort.understand_request(clf, "birthday party on last Sunday", TODAY)

    assert group.dates_text(p) == "Sun 2026-11-08" and len(chat.bodies) == group.UNDERSTAND_VOTES
    message = chat.bodies[0]["messages"][0]
    assert "images" not in message and chat.bodies[0]["format"] == group.REQUEST_SCHEMA
    assert "2026-11-08 Sunday\n" in message["content"] and "2026-11-10 Tuesday  <- today" in message["content"]
    assert "<<<birthday party on last Sunday>>>" in message["content"]


def test_a_file_is_asked_the_second_wording_only_when_the_first_says_no(tmp_path):
    photo = photo_taken(tmp_path / "a.jpg")
    clf = photosort.Classifier({**CFG, **LOCAL})
    no, yes = '{"match": false, "confidence": 0.9}', '{"match": true, "confidence": 0.8}'
    for replies, want, asked in (((yes,), (True, 0.8), 1), ((no, yes), (True, 0.8), 2), ((no, no), (False, 0.9), 2)):
        chat = FakeChat(*replies)
        clf._session = lambda: chat
        assert clf.matches(photo, "a birthday party") == want and len(chat.bodies) == asked
    first, second = (b["messages"][0] for b in chat.bodies)
    assert "shows that itself" in first["content"] and "clearly taken at one" in second["content"]
    assert first["images"] == second["images"] and '"a birthday party"' in second["content"]


class FakeGrouper:
    """Reads every request as `reply`; a file shows the topic when 'party' is in its name, and is from the same
    occasion when 'guests' or 'friends' is."""

    def __init__(self, reply):
        self.reply, self.checked, self.same_event_checked = reply, [], []

    def read_request(self, request, today):
        return group.parse_request_reply(self.reply, today)

    def matches(self, path, topic):
        self.checked.append(path.name)
        if path.stem == "broken":
            raise photosort.ClassifyError("model unavailable")
        return "party" in path.stem, 0.9

    def same_event(self, path, topic):
        self.same_event_checked.append(path.name)
        return "guests" in path.stem or "friends" in path.stem, 0.7


def test_group_moves_only_matching_files_from_that_day_and_undo_restores_them(tmp_path):
    (tmp_path / "food").mkdir()
    (tmp_path / "Old group").mkdir()
    (tmp_path / "Old group" / group.GROUP_MARKER).write_text("{}")
    sunday = {"party_afternoon.jpg": "2026:11:08 15:00:00", "party_after_midnight.jpg": "2026:11:09 01:30:00",
              "cake.jpg": "2026:11:08 16:00:00", "food/party_snacks.jpg": "2026:11:08 17:00:00",
              "broken.jpg": "2026:11:08 12:00:00", "Old group/party_before.jpg": "2026:11:08 14:00:00"}
    other = {"party_next_morning.jpg": "2026:11:09 09:00:00", "party_october.jpg": "2026:10:01 12:00:00",
             "20261020_120000000_iOS_party.jpg": None, "party_undated.jpg": None}
    for name, when in {**sunday, **other}.items():
        photo_taken(tmp_path / name, when)
    make_video(tmp_path / "party_clip.mov", ["red"], metadata={APPLE_DATE: "2026-11-08T18:00:00-0800"})
    (tmp_path / "notes.txt").write_text("x")
    fake = FakeGrouper(reading())

    s = photosort.group_folder(CFG, tmp_path, "birthday party on last Sunday", "move", classifier=fake, today=TODAY)

    target = tmp_path / "Birthday party 2026-11-08"
    moved = {"party_afternoon.jpg", "party_after_midnight.jpg", "party_snacks.jpg", "party_clip.mov"}
    assert {p.name for p in target.iterdir()} == moved | {group.GROUP_MARKER}
    assert (s["scanned"], s["in_range"], s["other_dates"], s["no_date"]) == (10, 6, 3, 1)
    assert (s["checked"], s["matched"], s["videos"], s["errors"], s["other_files"]) == (6, 4, 1, 1, 1)
    assert "20261020_120000000_iOS_party.jpg" not in fake.checked  # days away by name: not even opened
    for name in ["cake.jpg", "broken.jpg", "Old group/party_before.jpg", "notes.txt", *other]:
        assert (tmp_path / name).exists()
    rest = photosort.scan(tmp_path, tmp_path, BUCKETS, recursive=True)[0]  # what sort --recursive would take
    assert rest and not any(target in p.parents or tmp_path / "Old group" in p.parents for p in rest)
    report = photosort.format_group_report(s)
    assert 'topic "a birthday party"; photos and videos; Sun 2026-11-08' in report and "Duration" in report

    assert photosort.undo(tmp_path / photosort.JOURNAL_NAME)["restored"] == 4
    assert not target.exists() and (tmp_path / "food" / "party_snacks.jpg").exists()

    fake.checked.clear()
    dates_only = FakeGrouper(reading(topic="", media="photos", folder_name="Sunday"))
    r = photosort.group_folder(CFG, tmp_path, "photos from last Sunday", "report", classifier=dates_only,
                               today=TODAY)
    assert {Path(p).name for p in r["matched_paths"]} == {"party_afternoon.jpg", "cake.jpg", "party_snacks.jpg",
                                                          "broken.jpg"}  # the day only; photos only
    assert not dates_only.checked and r["checked"] == 0 and not (tmp_path / "Sunday 2026-11-08").exists()


def test_files_taken_near_a_match_or_the_existing_group_are_asked_if_from_the_same_occasion(tmp_path):
    held = tmp_path / "Birthday party 2026-11-08"  # from an earlier run of the same request
    held.mkdir()
    (held / group.GROUP_MARKER).write_text("{}")
    photo_taken(held / "party_earlier_run.jpg", "2026:11:08 16:00:00")
    for name, when in {"party_cake.jpg": "2026:11:08 11:16:00", "guests.jpg": "2026:11:08 11:20:00",
                       "screenshot.jpg": "2026:11:08 11:24:00", "more_guests.jpg": "2026:11:08 11:29:00",
                       "guests_later.jpg": "2026:11:08 14:30:00", "friends.jpg": "2026:11:08 16:05:00"}.items():
        photo_taken(tmp_path / name, when)
    fake = FakeGrouper(reading())

    s = photosort.group_folder(CFG, tmp_path, "birthday party on last Sunday", "move", classifier=fake, today=TODAY)

    # more_guests is 9 minutes from guests but 13 from the match: a same-occasion answer does not reach further
    assert sorted(fake.same_event_checked) == ["friends.jpg", "guests.jpg", "screenshot.jpg"]
    assert {p.name for p in held.iterdir()} == {"party_earlier_run.jpg", "party_cake.jpg", "guests.jpg",
                                                "friends.jpg", group.GROUP_MARKER}
    assert (s["already_in_group"], s["checked"], s["same_event_checked"], s["same_event_found"], s["matched"]) == \
        (1, 6, 3, 2, 3)
    entries = {Path(e["src"]).name: e for e in map(json.loads, (tmp_path / photosort.JOURNAL_NAME).open())}
    assert (entries["party_cake.jpg"]["matched_by"], entries["guests.jpg"]["matched_by"]) == ("topic", "same event")
    assert entries["screenshot.jpg"]["near_match"] and entries["screenshot.jpg"]["matched_by"] is None
    assert "3 more taken near a match" in photosort.format_group_report(s)

    photo_taken(tmp_path / "party_dated.jpg", "2026:11:08 14:25:00")  # a request with no dates still reads
    photo_taken(tmp_path / "party_undated.jpg")  # capture times; undated files are not asked
    photo_taken(tmp_path / "guests_undated.jpg")
    any_day = FakeGrouper(reading(date_from="", date_to=""))
    r = photosort.group_folder(CFG, tmp_path, "birthday parties", "report", classifier=any_day, today=TODAY)
    assert any_day.same_event_checked == ["guests_later.jpg"] and r["same_event_found"] == 1

# ---------- run control: events, cancel, preview then apply, locks (what the dashboard relies on) ----------

def events_in(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]


def test_events_report_each_file_only_after_its_journal_line(tmp_path, monkeypatch):
    photos = tmp_path / "photos"
    photos.mkdir()
    make_photos(photos, ["selfie.jpg", "lunch.jpg", "chat.png", "broken.jpg"])
    runctl.configure(tmp_path / "events.jsonl")
    journal = photos / photosort.JOURNAL_NAME
    lines_when_reported = []
    real_emit = runctl.emit

    def spy(type_, **fields):
        if type_ == "item":
            lines_when_reported.append((fields["n"], len(journal.read_text().splitlines())))
        real_emit(type_, **fields)

    monkeypatch.setattr(runctl, "emit", spy)
    s = photosort.sort_folder(CFG, photos, action="move", classifier=FakeClassifier())
    monkeypatch.setattr(runctl, "emit", real_emit)
    more = tmp_path / "more"
    more.mkdir()
    make_photos(more, ["cat.jpg", "beach.jpg"])
    photo_search.index_folder(CFG, more, FakeSearchClient(), photosort.IMAGE_EXTS)

    assert lines_when_reported == [(n, n) for n in range(1, 5)]
    ev = events_in(tmp_path / "events.jsonl")
    assert [e["seq"] for e in ev] == list(range(1, len(ev) + 1)) and {e["v"] for e in ev} == {runctl.SCHEMA}
    sort_ev, index_ev = ev[:6], ev[6:]
    assert [(e["type"], e.get("name")) for e in sort_ev[:2]] == [("phase", "scan"), ("phase", "sort")]
    assert (sort_ev[1]["total"], sort_ev[1]["run_id"], sort_ev[1]["journal"]) == (4, s["run_id"], str(journal))
    items = {Path(e["path"]).name: e for e in sort_ev[2:]}
    assert items["lunch.jpg"]["result"] == {"bucket": "food", "confidence": 0.8,
                                            "dst": str(photos / "food" / "lunch.jpg")}
    assert "model unavailable" in items["broken.jpg"]["error"]
    assert [(e["type"], e.get("name")) for e in index_ev] == [
        ("phase", "scan"), ("phase", "hash"), ("phase", "caption"), ("item", None), ("item", None)]
    assert {e["result"]["status"] for e in index_ev[3:]} == {"captioned"} and index_ev[2]["total"] == 2


class CliClassifier:
    """What `photosort sort` builds instead of the PAIR client: the third file asks to cancel, as the dashboard's
    Cancel button does, while its own request is still running."""

    def __init__(self, cfg):
        self.calls, self.cancel_file = 0, cfg["test_cancel_file"]

    def preflight(self):
        return ["fake"]

    def classify(self, path):
        self.calls += 1
        if self.calls == 3:
            time.sleep(0.3)
            Path(self.cancel_file).write_text("cancel")
            time.sleep(1.0)
        return "other", 0.5


def cli_config(tmp_path, **extra):
    cfg = {"base_url": "http://127.0.0.1:11434", "model": "gemma4:12b", "concurrency": 1, "action": "move",
           "buckets": BUCKETS, **extra}
    path = tmp_path / "config.json"
    path.write_text(json.dumps(cfg))
    return path


def test_cancel_stops_before_the_next_file_and_every_moved_file_is_journaled(tmp_path, monkeypatch, capsys):
    photos = tmp_path / "photos"
    photos.mkdir()
    names = [f"img{i}.jpg" for i in range(6)]
    make_photos(photos, names)
    cancel = tmp_path / "job" / "cancel"
    cancel.parent.mkdir()
    monkeypatch.setattr(photosort, "Classifier", CliClassifier)
    config = cli_config(tmp_path, test_cancel_file=str(cancel))

    code = photosort.main(["--config", str(config), "--events", str(tmp_path / "events.jsonl"),
                           "--cancel-file", str(cancel), "sort", str(photos)])

    assert code == 130
    moved = sorted(p.name for p in (photos / "other").iterdir())
    assert moved == names[:2] and sorted(p.name for p in photos.glob("*.jpg")) == names[2:]
    journaled = [e for e in map(json.loads, (photos / photosort.JOURNAL_NAME).open()) if e["dst"]]
    assert sorted(Path(e["dst"]).name for e in journaled) == moved
    ev = events_in(tmp_path / "events.jsonl")
    assert ev[0]["type"] == "run_start" and ev[0]["cmd"] == "sort" and ev[0]["params"]["source"] == str(photos)
    assert any(e["type"] == "warning" and "cancel requested" in e["message"] for e in ev)
    assert (ev[-1]["type"], ev[-1]["status"], ev[-1]["exit_code"]) == ("finish", "cancelled", 130)
    assert "summary" not in ev[-1] and "=== PhotoSort" not in capsys.readouterr().out
    runctl.configure()  # a new process in real use
    assert photosort.undo(photos / photosort.JOURNAL_NAME)["restored"] == 2


def test_cli_finish_event_carries_the_summary_and_the_same_report_the_terminal_shows(tmp_path, monkeypatch,
                                                                                       capsys):
    photos = tmp_path / "photos"
    photos.mkdir()
    make_photos(photos, ["a.jpg", "b.jpg"])
    monkeypatch.setattr(photosort, "Classifier", CliClassifier)
    config = cli_config(tmp_path, test_cancel_file=str(tmp_path / "unused"))

    assert photosort.main(["--config", str(config), "sort", str(photos), "--action", "report"]) == 0
    plain = capsys.readouterr().out
    assert photosort.main(["--config", str(config), "--events", str(tmp_path / "ev.jsonl"),
                           "sort", str(photos), "--action", "report"]) == 0
    finish = events_in(tmp_path / "ev.jsonl")[-1]
    assert (finish["status"], finish["summary"]["sorted"]) == ("ok", 2) and finish["report"] in capsys.readouterr().out
    assert "Duration" in plain and [p.name for p in tmp_path.glob("*.jsonl")] == ["ev.jsonl"]


def test_ctrl_c_during_a_move_waits_until_its_journal_line_is_written():
    before, steps = signal.getsignal(signal.SIGINT), []
    with pytest.raises(KeyboardInterrupt):
        with runctl.no_interrupt():
            signal.raise_signal(signal.SIGINT)
            steps.append("moved and journaled")
    assert steps == ["moved and journaled"] and signal.getsignal(signal.SIGINT) is before


def test_undo_dry_run_lists_what_undo_does_and_an_interrupted_undo_finishes_next_time(tmp_path, monkeypatch):
    names = ["selfie.jpg", "lunch.jpg", "chat.png"]
    make_photos(tmp_path, names)
    s = photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    journal = tmp_path / photosort.JOURNAL_NAME
    before = journal.read_text()

    dry = photosort.undo_run(journal, dry_run=True)

    assert journal.read_text() == before and not any((tmp_path / n).exists() for n in names)
    assert sorted(Path(src).name for src, _ in dry["restored_files"]) == sorted(names)
    report = photosort.format_undo_report(dry)
    assert "3 files would be moved back" in report and "Would move back" in report and "Duration" in report

    real_checkpoint, calls = runctl.checkpoint, []

    def cancel_on_second_file():
        calls.append(1)
        if len(calls) == 2:
            raise runctl.Cancelled()

    monkeypatch.setattr(runctl, "checkpoint", cancel_on_second_file)
    with pytest.raises(KeyboardInterrupt):
        photosort.undo_run(journal)
    monkeypatch.setattr(runctl, "checkpoint", real_checkpoint)
    assert sum((tmp_path / n).exists() for n in names) == 1

    rest = photosort.undo_run(journal)

    assert (rest["run_id"], rest["restored"], rest["already_restored"], rest["problems"]) == (s["run_id"], 2, 1, 0)
    assert all((tmp_path / n).exists() for n in names) and not (tmp_path / "food").exists()
    assert "1 files were moved back by an earlier, interrupted undo" in photosort.format_undo_report(rest)
    with pytest.raises(ValueError):
        photosort.undo(journal)


def test_apply_moves_exactly_the_previewed_files_and_leaves_changed_ones_alone(tmp_path):
    make_photos(tmp_path, ["selfie.jpg", "lunch.jpg", "chat.png", "broken.jpg"])
    preview = photosort.sort_folder(CFG, tmp_path, action="report", classifier=FakeClassifier())
    (tmp_path / "chat.png").write_bytes(b"edited after the preview")
    (tmp_path / "late.jpg").write_bytes(b"added after the preview")
    journal = tmp_path / photosort.JOURNAL_NAME

    s = photosort.apply_preview(CFG, journal)

    assert (s["applied_from"], s["kind"], s["planned"], s["applied"], s["changed"], s["errors"]) == \
        (preview["run_id"], "sort", 3, 2, 1, 0)
    assert (tmp_path / "people" / "selfie.jpg").exists() and (tmp_path / "food" / "lunch.jpg").exists()
    assert all((tmp_path / n).exists() for n in ["chat.png", "broken.jpg", "late.jpg"])
    report = photosort.format_apply_report(s)
    assert "chat.png: changed since the preview" in report and "Duration" in report
    with pytest.raises(ValueError, match="already applied"):
        photosort.apply_preview(CFG, journal, preview["run_id"])

    assert photosort.undo(journal)["restored"] == 2  # an apply is undone like any other run
    assert photosort.apply_preview(CFG, journal)["applied"] == 2  # and then the preview can be applied again


def test_journal_runs_summarizes_previews_applies_and_undos(tmp_path):
    make_photos(tmp_path, ["selfie.jpg", "lunch.jpg", "chat.png"])
    preview = photosort.sort_folder(CFG, tmp_path, action="report", classifier=FakeClassifier())
    journal = tmp_path / photosort.JOURNAL_NAME
    first = photosort.journal_runs(photosort.read_journal(journal))
    assert [(r["run_id"], r["kind"], r["action"], r["files"], r["can_apply"], r["can_undo"]) for r in first] == \
        [(preview["run_id"], "sort", "report", 3, True, False)]
    assert first[0]["buckets"] == {"people": 1, "food": 1, "screenshot_chat": 1} and first[0]["duration_s"] >= 0

    applied = photosort.apply_preview(CFG, journal)
    photosort.undo(journal)
    entries = photosort.read_journal(journal)
    runs = {r["run_id"]: r for r in photosort.journal_runs(entries)}

    a = runs[applied["run_id"]]
    assert (a["kind"], a["of"], a["action"], a["done"], a["restored"], a["can_undo"]) == ("apply", "sort", "move", 3, 3, False)
    assert a["undone"] == {"ts": a["undone"]["ts"], "restored": 3, "problems": 0}
    p = runs[preview["run_id"]]
    assert p["applied_by"] == [applied["run_id"]] and p["can_apply"]  # its apply was undone: it can be applied again
    items = photosort.journal_items(entries, applied["run_id"], offset=1, limit=5)
    assert (items["total"], [i["n"] for i in items["items"]]) == (3, [2, 3])
    assert all(i["restored"] and i["bucket"] for i in items["items"])


def test_apply_a_group_preview_makes_the_group_folder_without_asking_the_model_again(tmp_path):
    for name, when in {"party_cake.jpg": "2026:11:08 15:00:00", "party_games.jpg": "2026:11:08 15:10:00",
                       "cake.jpg": "2026:11:08 16:00:00"}.items():
        photo_taken(tmp_path / name, when)
    fake = FakeGrouper(reading())
    r = photosort.group_folder(CFG, tmp_path, "birthday party on last Sunday", "report", classifier=fake, today=TODAY)
    target = tmp_path / "Birthday party 2026-11-08"
    assert r["matched"] == 2 and not target.exists()
    asked = len(fake.checked)

    s = photosort.apply_preview(CFG, tmp_path / photosort.JOURNAL_NAME)

    assert (s["kind"], s["applied"], s["group"], len(fake.checked)) == ("group", 2, str(target), asked)
    assert {p.name for p in target.iterdir()} == {"party_cake.jpg", "party_games.jpg", group.GROUP_MARKER}
    marker = json.loads((target / group.GROUP_MARKER).read_text())
    assert (marker["topic"], marker["dates"], marker["run_id"]) == ("a birthday party", ["2026-11-08"] * 2,
                                                                    s["run_id"])
    assert photosort.undo(tmp_path / photosort.JOURNAL_NAME)["restored"] == 2 and not target.exists()


def test_runs_that_move_files_refuse_overlapping_folders_unless_forced(tmp_path, capsys):
    photos = tmp_path / "photos"
    (photos / "2026").mkdir(parents=True)
    root = runctl.locks_dir()
    root.mkdir(parents=True, exist_ok=True)
    other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        def held_by_other(mode):
            (root / "other.json").write_text(json.dumps({
                "id": "other", "pid": other.pid, "pid_started": runctl._process_start(other.pid), "cmd": "sort",
                "mode": mode, "folders": runctl.minimal_folders([photos]), "since": "2026-11-10T09:00:00"}))

        held_by_other("move")
        with pytest.raises(runctl.LockError, match="another PhotoSort run .sort, process"):
            with runctl.folder_lock("index", "read", [photos / "2026"]):
                pass
        with runctl.folder_lock("sort", "move", [tmp_path / "elsewhere"]):
            pass
        with runctl.folder_lock("sort", "move", [photos], force=True) as mine:
            assert (root / f"{mine['id']}.json").exists()
        assert not (root / f"{mine['id']}.json").exists()

        held_by_other("read")
        with runctl.folder_lock("index", "read", [photos]):
            pass  # two runs that only read are fine
        with pytest.raises(runctl.LockError):
            with runctl.folder_lock("group", "move", [tmp_path]):  # a parent folder overlaps too
                pass
        config = cli_config(tmp_path)
        assert photosort.main(["--config", str(config), "--events", str(tmp_path / "ev.jsonl"),
                               "group", str(tmp_path), "party"]) == 2
        ev = events_in(tmp_path / "ev.jsonl")
        assert [e["kind"] for e in ev if e["type"] == "error"] == ["locked"] and ev[-1]["status"] == "failed"
    finally:
        other.kill()
        other.wait()
    with runctl.folder_lock("sort", "move", [photos]):
        pass  # the lock of a process that has ended is ignored
    assert not (root / "other.json").exists()