"""A deterministic stand-in for the NVIDIA PAIR proxy, used by the dashboard's fixture mode and its tests.

It binds to 127.0.0.1 only, never forwards anything and runs no model. Besides the read-only Ollama endpoints it
answers the /api/chat and /api/embed requests PhotoSort makes: every fixture picture carries its kind as a colour
code in its top-left corner (dashboard\\fixtures\\make_fixtures.py), and requests are read by keyword, so sort,
group, index and search give predictable results. One cloud model is listed on purpose, so the cloud-model checks
have something to catch. GET /fake/stats counts the requests (tests check that `apply` asks nothing).

With --pair-dir it also keeps a synthetic PAIR log (logs\\nvpair.jsonl, rotated to nvpair.1.jsonl) and member list
(cluster\\members.json) there, in PAIR's formats, for the dashboard's Cluster page: 36 hours of made-up history on
start, then one routing entry per request it answers. Every address is a made-up private 192.168.50.x one.

    python tests\\fake_pair.py --port 47617 [--parent-pid PID] [--delay-ms N] [--fail-rate F] [--pair-dir DIR]
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
import uuid
import zlib
from collections import Counter
from datetime import datetime, timedelta, timezone
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


# Synthetic PAIR cluster: three LAN nodes that serve models, this PC (a member that serves nothing) and a member
# that left long ago.
FAKE_NODES = [
    {"name": "fixture-node-a", "ip": "192.168.50.11", "uuid": "a0000000-0000-4000-8000-00000000000a", "speed": 1.0},
    {"name": "fixture-node-b", "ip": "192.168.50.12", "uuid": "b0000000-0000-4000-8000-00000000000b", "speed": 1.4},
    {"name": "fixture-node-c", "ip": "192.168.50.13", "uuid": "c0000000-0000-4000-8000-00000000000c", "speed": 2.2},
]
FAKE_SELF = {"name": "this-pc", "ip": "192.168.50.10", "uuid": "d0000000-0000-4000-8000-00000000000d"}
FAKE_STALE = {"name": "fixture-old-node", "ip": "10.99.0.7", "uuid": "e0000000-0000-4000-8000-00000000000e"}


def _iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class FakePairLog:
    """Writes routing entries the way PAIR does: each request as a `proxy/request-started` line, then a
    `proxy/request` line, plus the same request again in the older JSON-RPC form."""

    def __init__(self, root: Path, now: datetime | None = None, seed: int = 7):
        self.root, self.lock, self.turn = Path(root), threading.Lock(), 0
        self.rng = random.Random(seed)
        self.last_poll = 0.0
        (self.root / "logs").mkdir(parents=True, exist_ok=True)
        (self.root / "cluster").mkdir(parents=True, exist_ok=True)
        now = now or datetime.now(timezone.utc)
        self.write_members(now)
        self.write_history(now)

    @property
    def file(self) -> Path:
        return self.root / "logs" / "nvpair.jsonl"

    def write_members(self, now: datetime) -> None:
        def member(n, seen, state="member"):
            return {"admissionEpoch": 1, "clusterId": "fixture-cluster", "id": "peer-" + n["uuid"][:8], "ipAddress": n["ip"],
                    "joinedAt": _iso(now - timedelta(days=30)), "lastSeen": _iso(seen), "name": n["name"],
                    "nodeUuid": n["uuid"], "port": 47800, "state": state}
        members = [member(n, now) for n in FAKE_NODES] + [member(FAKE_SELF, now), member(FAKE_STALE, now - timedelta(days=9))]
        (self.root / "cluster" / "members.json").write_text(json.dumps(members, indent=2), encoding="utf-8")

    def lines_for(self, t: datetime, path: str, node: dict | None, status: int, ms: float) -> list[str]:
        rid = str(uuid.UUID(int=self.rng.getrandbits(128), version=4))
        target = f"{node['ip']}:11434" if node else "cluster"
        params = {"duration_ms": round(ms, 1), "id": rid, "method": "POST" if node else "GET",
                  "node_id": node["uuid"] if node else "", "path": path, "status": status, "target": target,
                  "ttfb_ms": round(ms * 0.35, 1)}
        started = {k: params[k] for k in ("id", "method", "node_id", "path", "target")}
        legacy = json.dumps({"jsonrpc": "2.0", "method": "ollama-proxy:proxy/request", "params": params})
        start_t = t - timedelta(milliseconds=ms)
        return [
            json.dumps({"time": _iso(start_t), "level": "debug", "message": "ollama-proxy:proxy/request-started",
                        "source": "pair", "sublevel": "proxy", "data": started}),
            json.dumps({"time": _iso(t), "level": "info", "message": "ollama-proxy:proxy/request", "source": "pair",
                        "sublevel": "proxy", "data": params}),
            json.dumps({"time": _iso(t), "level": "info", "message": legacy, "source": "pair", "sublevel": "rpc"}),
        ]

    def poll_lines(self, t: datetime) -> list[str]:
        out = []
        for n in FAKE_NODES:
            engines = [{"display_name": "Ollama", "engine": "ollama", "healthy": True, "installed": True, "port": 11434,
                        "running": True}]
            out.append(json.dumps({"time": _iso(t), "level": "debug", "message": f"remote engine status polled for {n['uuid']}",
                                   "source": "pair", "sublevel": "engine", "data": {"engines": engines}}))
        return out

    def write_history(self, now: datetime) -> None:
        """36 hours of busy and quiet periods; the older 24 hours go to the rotated file."""
        rotated, current = [], []
        t = now - timedelta(hours=36)
        while t < now - timedelta(seconds=30):
            busy = (t.hour % 6) in (1, 2)
            gap = self.rng.uniform(4, 12) if busy else self.rng.uniform(60, 240)
            t += timedelta(seconds=gap)
            node = self.pick()
            path = "/api/embed" if self.rng.random() < 0.25 else "/api/chat"
            status = 503 if self.rng.random() < 0.02 else 200
            ms = self.rng.uniform(900, 2600) * node["speed"] * (0.15 if path == "/api/embed" else 1)
            lines = self.lines_for(t, path, node, status, ms)
            if self.rng.random() < 0.05:
                lines += self.lines_for(t, "/api/tags", None, 200, self.rng.uniform(20, 80))
            if self.rng.random() < 0.1:
                lines += self.poll_lines(t)
            (rotated if t < now - timedelta(hours=12) else current).extend(lines)
        for name, lines in (("nvpair.1.jsonl", rotated), ("nvpair.jsonl", current + self.poll_lines(now))):
            (self.root / "logs" / name).write_text("".join(line + "\n" for line in lines), encoding="utf-8")

    def pick(self) -> dict:
        self.turn += 1
        return FAKE_NODES[self.turn % len(FAKE_NODES)]

    def record(self, path: str, status: int, ms: float) -> None:
        with self.lock:
            now = datetime.now(timezone.utc)
            lines = self.lines_for(now, path, self.pick(), status, ms)
            if time.monotonic() - self.last_poll > 30:
                self.last_poll = time.monotonic()
                lines += self.poll_lines(now)
            with self.file.open("a", encoding="utf-8") as f:
                f.write("".join(line + "\n" for line in lines))


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
        began = time.monotonic()
        if srv.delay_s:
            time.sleep(srv.delay_s)
        with srv.lock:
            srv.stats[kind] += 1
            fail = srv.fail_rate and srv.rng.random() < srv.fail_rate
            if fail:
                srv.stats["failed"] += 1
        if fail:
            self._json(500, {"error": "fake PAIR: injected failure"})
            self._log(500, began)
            return
        try:
            if kind == "embed":
                inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
                self._json(200, {"model": body.get("model"), "embeddings": embed(inputs)})
            else:
                self._json(200, {"model": body.get("model"), "done": True, "done_reason": "stop",
                                 "message": {"role": "assistant", "content": json.dumps(answer_chat(body))}})
            self._log(200, began)
        except (KeyError, IndexError, TypeError, ValueError) as e:
            self._json(400, {"error": f"fake PAIR cannot answer this: {e}"})
            self._log(400, began)

    def _log(self, status, began):
        if self.server.pair_log:
            try:
                self.server.pair_log.record(self.path, status, (time.monotonic() - began) * 1000 + 1)
            except OSError:
                pass


def exit_with_parent(pid):
    """Exit when the dashboard server that started us exits, so a crashed server leaves no orphan behind."""
    synchronize, infinite = 0x00100000, 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        os._exit(0)
    kernel32.WaitForSingleObject(handle, infinite)
    os._exit(0)


def make_server(port, delay_ms=0, fail_rate=0.0, seed=1, pair_dir=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    server.delay_s, server.fail_rate, server.rng = delay_ms / 1000, fail_rate, random.Random(seed)
    server.lock, server.stats = threading.Lock(), Counter(chat=0, embed=0, failed=0)
    server.pair_log = FakePairLog(Path(pair_dir)) if pair_dir else None
    return server


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--parent-pid", type=int)
    ap.add_argument("--delay-ms", type=int, default=0, help="wait this long before each chat or embed answer")
    ap.add_argument("--fail-rate", type=float, default=0.0, help="fraction of chat and embed requests that fail")
    ap.add_argument("--pair-dir", help="keep a synthetic PAIR log and member list in this folder")
    args = ap.parse_args(argv)
    server = make_server(args.port, args.delay_ms, args.fail_rate, pair_dir=args.pair_dir)
    if args.parent_pid and os.name == "nt":
        threading.Thread(target=exit_with_parent, args=(args.parent_pid,), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()