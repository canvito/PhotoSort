import io
import json
import os
import socket
import stat
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import photosort  # noqa: E402
import face_tagger  # noqa: E402
import face_worker  # noqa: E402

BUCKETS = {"people": "", "food": "", "screenshot_chat": "", "other": ""}
CFG = {"model": "fake", "concurrency": 4, "buckets": BUCKETS}


@pytest.mark.parametrize("url", ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"])
def test_loopback_endpoints_allowed(url):
    photosort.require_loopback(url)


@pytest.mark.parametrize("url", ["http://192.168.7.20:11434", "http://spark1:11434", "https://api.openai.com/v1"])
def test_non_loopback_endpoints_refused(url):
    with pytest.raises(photosort.LocalOnlyError):
        photosort.require_loopback(url)


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
    for name in ["selfie.jpg", "lunch.JPG", "chat.png", "broken.jpg", "clip.mov"]:
        (tmp_path / name).write_bytes(b"x")
    (tmp_path / "people").mkdir()
    (tmp_path / "people" / "selfie.jpg").write_bytes(b"already sorted")

    s = photosort.sort_folder(CFG, tmp_path, action="move", recursive=True, classifier=FakeClassifier())

    assert s["sorted"] == 3 and s["errors"] == 1 and s["skipped_non_images"] == 1
    assert (tmp_path / "people" / "selfie (1).jpg").exists()  # name collision does not overwrite
    assert (tmp_path / "people" / "selfie.jpg").read_bytes() == b"already sorted"
    assert (tmp_path / "food" / "lunch.JPG").exists()
    assert (tmp_path / "screenshot_chat" / "chat.png").exists()
    assert (tmp_path / "broken.jpg").exists() and (tmp_path / "clip.mov").exists()
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
    for name in ["selfie.jpg", "lunch.jpg", "clip.mov"]:
        (tmp_path / name).write_bytes(b"x")
    s = photosort.sort_folder(CFG, tmp_path, action="move", classifier=FakeClassifier())
    text = photosort.format_report(s)
    assert f"Duration    : {photosort.format_duration(s['elapsed_s'])}" in text
    assert s["started_at"].replace("T", " ") in text and s["finished_at"].replace("T", " ") in text
    assert "2 images moved; 0 errors; 1 non-image files left in place" in text
    assert "images/min" in text and "people" in text and "food" in text
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
    assert result["summary"] == {"images": 3, "faces": 4, "matched": 2, "unknown": 2, "errors": 0}
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
