"""A deterministic stand-in for the NVIDIA PAIR proxy, used by the dashboard's fixture mode and its tests.

It binds to 127.0.0.1 only, never forwards anything and runs no model. Besides the read-only Ollama endpoints it
answers the /api/chat and /api/embed requests PhotoSort makes: every fixture picture carries its kind as a colour
code in its top-left corner (dashboard\\fixtures\\make_fixtures.py), and requests are read by keyword, so sort,
group, index and search give predictable results. One cloud model is listed on purpose, so the cloud-model checks
have something to catch. GET /fake/stats counts the requests (tests check that `apply` asks nothing).

    python tests\\fake_pair.py --port 47617 [--parent-pid PID] [--delay-ms N] [--fail-rate F]
"""
import argparse
import base64
import ctypes
import io
import json
import os
import random
import re
import sys
import threading
import time
import zlib
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dashboard" / "fixtures"))
from make_fixtures import label_of  # noqa: E402

MODELS = [
    {"name": "gemma4:12b", "model": "gemma4:12b", "size": 8_100_000_000,
     "details": {"family": "gemma4", "parameter_size": "12B", "quantization_level": "Q4_K_M"}},
    {"name": "qwen3-embedding:8b", "model": "qwen3-embedding:8b", "size": 4_700_000_000,
     "details": {"family": "qwen3", "parameter_size": "8B", "quantization_level": "Q4_K_M"}},
    {"name": "gpt-oss:120b-cloud", "model": "gpt-oss:120b-cloud", "size": 384,
     "remote_model": "gpt-oss:120b", "remote_host": "https://ollama.com:443",
     "details": {"family": "gptoss", "parameter_size": "116.8B", "quantization_level": "MXFP4"}},
]
RUNNING = [{"name": "gemma4:12b", "model": "gemma4:12b", "size_vram": 9_800_000_000}]

# request words -> (kind, topic, folder name)
TOPICS = [
    ({"sunset", "sunsets", "sky"}, "sunset", "a sunset", "Sunsets"),
    ({"receipt", "receipts", "document", "documents"}, "receipt", "a receipt", "Receipts"),
    ({"screenshot", "screenshots"}, "screenshot", "a screenshot", "Screenshots"),
    ({"food", "meal", "meals", "lunch", "dinner"}, "food", "food", "Food"),
    ({"portrait", "portraits", "person", "people", "selfie", "selfies"}, "portrait", "a person", "People"),
    ({"forest", "forests", "tree", "trees", "woods"}, "forest", "a forest", "Forest"),
]
BUCKETS = {"sunset": "nature", "forest": "nature", "receipt": "documents_receipts", "screenshot": "screenshot_other",
           "food": "food", "portrait": "people"}
CAPTIONS = {
    "sunset": ("An orange and purple sunset sky with the sun low over the horizon.", ["sun", "sky"], "outdoor sky",
               "", 0),
    "receipt": ("A printed paper store receipt lying flat on a table.", ["receipt", "paper"], "indoor table",
                "STORE TOTAL 42.17 THANK YOU", 0),
    "screenshot": ("A screenshot of a dark phone settings screen with blue switches.", ["phone", "switches"],
                   "screen", "Settings Wi-Fi Bluetooth", 0),
    "food": ("A plate of food with tomato sauce and green herbs.", ["plate", "food", "sauce"], "indoor table", "", 0),
    "portrait": ("A portrait of one person standing in front of a blue wall.", ["person", "wall"], "indoor studio",
                 "", 1),
    "forest": ("A green forest with tall trees under a bright sky.", ["trees", "forest"], "outdoor forest", "", 0),
    None: ("A plain picture with nothing recognizable in it.", [], "unknown", "", 0),
}
STOP = {"a", "an", "the", "of", "with", "in", "on", "and", "or", "to", "for", "from", "at", "by", "is", "my", "me",
        "photo", "photos", "picture", "pictures", "image", "images", "show", "find", "under", "over", "one"}
VIDEO_WORDS = {"video", "videos", "clip", "clips"}
PHOTO_WORDS = {"photo", "photos", "picture", "pictures", "pics", "images", "screenshots"}
DIMS = 256


def kinds_in(images):
    """The colour-coded kind of each picture (None where there is no code)."""
    out = []
    for b64 in images or []:
        try:
            with Image.open(io.BytesIO(base64.b64decode(b64))) as im:
                out.append(label_of(im))
        except Exception:
            out.append(None)
    return out


def topic_of(words):
    return next((t for t in TOPICS if t[0] & set(words)), None)


def read_request(prompt):
    m = re.search(r"<<<(.*?)>>>", prompt, re.S)
    request = m.group(1) if m else ""
    words = re.findall(r"[a-z]+", request.lower())
    hit = topic_of(words)
    dates = re.findall(r"\d{4}-\d{2}-\d{2}", request)
    video, photo = bool(VIDEO_WORDS & set(words)), bool(PHOTO_WORDS & set(words))
    return {"file_words": " ".join(w for w in words if w in VIDEO_WORDS | PHOTO_WORDS),
            "when_words": " ".join(dates), "what_words": next(iter(hit[0] & set(words))) if hit else "",
            "topic": hit[2] if hit else "", "media": "both" if video == photo else "videos" if video else "photos",
            "date_from": dates[0] if dates else "", "date_to": dates[-1] if dates else "", "people_named": [],
            "folder_name": hit[3] if hit else "Photos"}


def answer_chat(body):
    """What a model would reply to one of PhotoSort's chat requests, told apart by the JSON schema it asks for."""
    props = (body.get("format") or {}).get("properties") or {}
    message = body["messages"][-1]
    prompt, images = message.get("content", ""), message.get("images") or []
    if "bucket" in props:
        kind = next((k for k in kinds_in(images) if k), None)
        bucket = BUCKETS.get(kind)
        return {"bucket": bucket if bucket in props["bucket"]["enum"] else "other",
                "confidence": 0.9 if kind else 0.4}
    if "when_words" in props:
        return read_request(prompt)
    if "match" in props:
        m = re.search(r'show(?: this:)? "([^"]+)"', prompt)
        hit = topic_of(re.findall(r"[a-z]+", m.group(1).lower())) if m else None
        found = bool(hit) and hit[1] in kinds_in(images)
        return {"match": found, "confidence": 0.9 if found else 0.8}
    if "caption" in props:
        kind = next((k for k in kinds_in(images) if k), None)
        caption, objects, scene, text, people = CAPTIONS[kind]
        if len(images) > 1:
            caption = f"A short video. {caption}"
        return {"caption": caption, "objects": objects, "scene": scene, "text": text, "people_count": people}
    raise ValueError("not a request PhotoSort makes")


def embed(texts):
    """Hashed bag-of-words vectors: a query finds the captions that share its words."""
    rows = []
    for text in texts:
        row = [0.0] * DIMS
        for w in re.findall(r"[a-z0-9]+", text.split("\nQuery: ", 1)[-1].lower()):
            if w in STOP:
                continue
            w = w[:-1] if len(w) > 3 and w.endswith("s") else w
            row[zlib.crc32(w.encode()) % DIMS] += 1.0
        rows.append(row)
    return rows


class Handler(BaseHTTPRequestHandler):
    server_version = "fake-pair/2"

    def log_message(self, *args):
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/api/tags":
            self._json(200, {"models": MODELS})
        elif self.path == "/api/ps":
            self._json(200, {"models": RUNNING})
        elif self.path == "/api/version":
            self._json(200, {"version": "0.0.0-fixture"})
        elif self.path == "/fake/stats":
            with self.server.lock:
                self._json(200, dict(self.server.stats))
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path not in ("/api/chat", "/api/embed"):
            self._json(404, {"error": "fake PAIR serves only what PhotoSort uses"})
            return
        kind = self.path.rsplit("/", 1)[-1]
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            self._json(400, {"error": "invalid JSON"})
            return
        srv = self.server
        if srv.delay_s:
            time.sleep(srv.delay_s)
        with srv.lock:
            srv.stats[kind] += 1
            fail = srv.fail_rate and srv.rng.random() < srv.fail_rate
            if fail:
                srv.stats["failed"] += 1
        if fail:
            self._json(500, {"error": "fake PAIR: injected failure"})
            return
        try:
            if kind == "embed":
                inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
                self._json(200, {"model": body.get("model"), "embeddings": embed(inputs)})
            else:
                self._json(200, {"model": body.get("model"), "done": True, "done_reason": "stop",
                                 "message": {"role": "assistant", "content": json.dumps(answer_chat(body))}})
        except (KeyError, IndexError, TypeError, ValueError) as e:
            self._json(400, {"error": f"fake PAIR cannot answer this: {e}"})


def exit_with_parent(pid):
    """Exit when the dashboard server that started us exits, so a crashed server leaves no orphan behind."""
    synchronize, infinite = 0x00100000, 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        os._exit(0)
    kernel32.WaitForSingleObject(handle, infinite)
    os._exit(0)


def make_server(port, delay_ms=0, fail_rate=0.0, seed=1):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.delay_s, server.fail_rate, server.rng = delay_ms / 1000, fail_rate, random.Random(seed)
    server.lock, server.stats = threading.Lock(), Counter(chat=0, embed=0, failed=0)
    return server


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--parent-pid", type=int)
    ap.add_argument("--delay-ms", type=int, default=0, help="wait this long before each chat or embed answer")
    ap.add_argument("--fail-rate", type=float, default=0.0, help="fraction of chat and embed requests that fail")
    args = ap.parse_args(argv)
    server = make_server(args.port, args.delay_ms, args.fail_rate)
    if args.parent_pid and os.name == "nt":
        threading.Thread(target=exit_with_parent, args=(args.parent_pid,), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()