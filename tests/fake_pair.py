"""A deterministic stand-in for the NVIDIA PAIR proxy, used by the dashboard's fixture mode and its tests.

It binds to 127.0.0.1 only, never forwards anything, and answers the read-only Ollama endpoints the dashboard
uses. One cloud model is listed on purpose, so the dashboard's cloud-model checks have something to catch.

    python tests\\fake_pair.py --port 47617 [--parent-pid PID]
"""
import argparse
import ctypes
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


class Handler(BaseHTTPRequestHandler):
    server_version = "fake-pair/1"

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
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        self._json(404, {"error": "fake PAIR serves read-only endpoints only"})


def exit_with_parent(pid):
    """Exit when the dashboard server that started us exits, so a crashed server leaves no orphan behind."""
    synchronize, infinite = 0x00100000, 0xFFFFFFFF
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        os._exit(0)
    kernel32.WaitForSingleObject(handle, infinite)
    os._exit(0)


def make_server(port):
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--parent-pid", type=int)
    args = ap.parse_args(argv)
    server = make_server(args.port)
    if args.parent_pid and os.name == "nt":
        threading.Thread(target=exit_with_parent, args=(args.parent_pid,), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
