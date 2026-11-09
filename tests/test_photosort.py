import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import photosort  # noqa: E402

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


def test_report_action_moves_nothing(tmp_path):
    (tmp_path / "lunch.jpg").write_bytes(b"x")
    s = photosort.sort_folder(CFG, tmp_path, action="report", classifier=FakeClassifier())
    assert s["buckets"] == {"food": 1}
    assert (tmp_path / "lunch.jpg").exists() and not (tmp_path / "food").exists()
