"""Benchmark local vision models through the NVIDIA PAIR Ollama proxy (127.0.0.1:11434).

Everything stays on the LAN: requests go to the local PAIR proxy on this PC, which routes them to
cluster nodes. Nothing is sent to a cloud LLM, and system/env HTTP proxies are ignored.

Test set: a folder of .jpg files named "<category>__<name>.jpg" (default: ./images, git-ignored).
<category> is the expected label and must be one of CATS below; screenshot_* files count as screenshots.
Use a small labelled set (about 12 images, <= 1024 px) and never commit personal photos.

Usage (from any folder, with the utils conda env's Python):
    python bench.py --models gemma4:12b qwen3.5:9b --repeat 10 --concurrency 12
Appends one JSON summary per model to results.jsonl (git-ignored); REPORT.md holds the curated results.
"""
import argparse, base64, collections, json, os, statistics, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import requests

HERE = Path(__file__).parent
PROXY = "http://127.0.0.1:11434"
LOG = Path(os.path.expandvars(r"%LOCALAPPDATA%\NVIDIA Corporation\Personal AI Router\logs\nvpair.jsonl"))
CATS = ["people", "animals", "food", "nature", "city_travel", "document_receipt",
        "screenshot_code", "screenshot_chat", "screenshot_chart", "screenshot_other", "other"]
# PAIR node id -> name for this cluster (see PAIR's members.json); unknown ids show the target address.
NODES = {
    "4df9a439-781e-4f57-ac50-a632f5ed12bf": "spark1", "98b18f7a-9bfa-4ec4-acd1-e00619bd027b": "AxiDvBb1",
    "cd567106-0b80-4d43-8939-cf9b3f7f6d3a": "MinDvBb1", "5aeb1be8-97e2-4c9c-9409-17c287d9a669": "CVPRISM2",
    "4fbf8646-fdbf-4063-8d07-adeaad750603": "Mac-mini", "2e3c5a48-f8cb-452d-a519-69a3a5e37efc": "ErsEv2Bb5(local)",
    "4a7cdfac-35a7-4408-9419-81a6cfbf1e0a": "ErsDvBb1", "635dbffe-4bd4-48c0-ae87-959a5a6d3b5d": "ErsDvBb2",
    "27c393d3-1da2-446d-855c-bc7bdcee5354": "ErsDvDk1", "a2d525dd-425b-4959-94ec-38b402efb13e": "CheEv2Bb6",
}
PROMPT = ("Classify this image into exactly one category: " + ", ".join(CATS) +
          ". Screenshots of apps/websites/phones go in a screenshot_* category; photos of paper documents or "
          "receipts go in document_receipt. Reply with JSON only.")
SCHEMA = {"type": "object", "properties": {
    "category": {"type": "string", "enum": CATS}, "is_screenshot": {"type": "boolean"},
    "confidence": {"type": "number"}}, "required": ["category", "is_screenshot", "confidence"]}

_tls = threading.local()


def _session():
    s = getattr(_tls, "session", None)
    if s is None:
        s = _tls.session = requests.Session()
        s.trust_env = False  # never route through system/env HTTP proxies
    return s


def classify(model, img_path, think):
    r = _classify(model, img_path, think)
    r["end"] = datetime.now(timezone.utc)
    return r


def _classify(model, img_path, think):
    body = {"model": model, "stream": False, "format": SCHEMA, "keep_alive": "30m",
            "options": {"temperature": 0, "num_predict": 200, "num_ctx": 4096},
            "messages": [{"role": "user", "content": PROMPT,
                          "images": [base64.b64encode(img_path.read_bytes()).decode()]}]}
    if think is not None:
        body["think"] = think
    t0 = time.perf_counter()
    try:
        r = _session().post(f"{PROXY}/api/chat", json=body, timeout=600)
        dt = time.perf_counter() - t0
        if r.status_code != 200:
            return {"ok": False, "err": f"HTTP {r.status_code} {r.text[:120]}", "lat": dt}
        j = r.json()
        content = j.get("message", {}).get("content", "")
        try:
            pred = json.loads(content)
        except Exception:
            return {"ok": False, "err": f"bad json: {content[:80]!r}", "lat": dt}
        return {"ok": True, "lat": dt, "pred": pred.get("category"), "is_ss": pred.get("is_screenshot"),
                "eval_count": j.get("eval_count"), "prompt_eval_count": j.get("prompt_eval_count"),
                "load_s": (j.get("load_duration") or 0) / 1e9}
    except Exception as e:
        return {"ok": False, "err": f"{type(e).__name__}: {str(e)[:120]}", "lat": time.perf_counter() - t0}


def proxy_log_since(ts_iso):
    """Return /api/chat proxy completion events written after ts_iso (empty if the PAIR log is missing)."""
    out = []
    if not LOG.exists():
        return out
    size = LOG.stat().st_size
    with LOG.open("rb") as fh:
        fh.seek(max(0, size - 8_000_000)); fh.readline()
        for line in fh.read().decode("utf-8", "replace").splitlines():
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("time", "") < ts_iso or '"ollama-proxy:proxy/request"' not in o.get("message", ""):
                continue
            p = json.loads(o["message"])["params"]
            if p.get("path") == "/api/chat":
                p["_t"] = datetime.fromisoformat(o["time"].replace("Z", "+00:00"))
                out.append(p)
    return out


def run(model, images, repeat, conc, think):
    jobs = [img for _ in range(repeat) for img in images]
    start_iso = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    t0 = time.perf_counter()
    with ThreadPoolExecutor(conc) as ex:
        res = list(ex.map(lambda p: (p, classify(model, p, think)), jobs))
    wall = time.perf_counter() - t0
    time.sleep(1.5)
    ok = [r for _, r in res if r["ok"]]
    correct = sum(1 for p, r in res if r["ok"] and r["pred"] == p.stem.split("__")[0])
    ss_ok = sum(1 for p, r in res if r["ok"] and bool(r["is_ss"]) == p.stem.startswith("screenshot"))
    lats = [r["lat"] for r in ok]
    per_node = collections.defaultdict(list)
    events = proxy_log_since(start_iso)
    for p in events:
        per_node[NODES.get(p.get("node_id"), p.get("target"))].append((p.get("status"), p.get("duration_ms", 0)))
    # Attribute each client result to the proxy completion event closest in time.
    bad_by_node, unused = collections.Counter(), list(events)
    for _, r in res:
        if unused:
            best = min(unused, key=lambda e: abs((e["_t"] - r["end"]).total_seconds()))
            unused.remove(best)
            if not r["ok"]:
                bad_by_node[NODES.get(best.get("node_id"), "?")] += 1
    summary = {
        "model": model, "think": think, "requests": len(jobs), "ok": len(ok), "wall_s": round(wall, 1),
        "img_per_min": round(len(ok) / wall * 60, 1) if wall else 0,
        "accuracy": f"{correct}/{len(jobs)}", "screenshot_flag_acc": f"{ss_ok}/{len(jobs)}",
        "lat_p50": round(statistics.median(lats), 1) if lats else None, "lat_max": round(max(lats), 1) if lats else None,
        "nodes": {n: {"n": len(v), "ok": sum(1 for s, _ in v if s == 200),
                      "avg_s": round(sum(d for _, d in v) / len(v) / 1000, 1)} for n, v in per_node.items()},
        "bad_by_node": dict(bad_by_node),
        "errors": collections.Counter(r["err"][:90] for _, r in res if not r["ok"]).most_common(3),
        "misses": [f"{p.stem}->{r['pred']}" for p, r in res if r["ok"] and r["pred"] != p.stem.split("__")[0]],
    }
    print(json.dumps(summary), flush=True)
    return summary


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Benchmark local vision models via the PAIR proxy.")
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--concurrency", type=int, default=12)
    ap.add_argument("--think", choices=["true", "false", "omit"], default="false")
    ap.add_argument("--images", default=str(HERE / "images"), help="folder of <category>__<name>.jpg files")
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args()
    imgs = sorted(Path(a.images).glob("*.jpg"))[: a.limit or None]
    if not imgs:
        ap.error(f"no .jpg test images in {a.images} (name them <category>__<name>.jpg; see the docstring)")
    bad = [p.name for p in imgs if p.stem.split("__")[0] not in CATS]
    if bad:
        ap.error(f"file names must start with <category>__ where category is one of {CATS}; got: {bad}")
    if not LOG.exists():
        print(f"note: PAIR log not found at {LOG}; per-node stats will be empty", file=sys.stderr)
    think = None if a.think == "omit" else a.think == "true"
    results = [run(m, imgs, a.repeat, a.concurrency, think) for m in a.models]
    with (HERE / "results.jsonl").open("a") as fh:
        for r in results:
            fh.write(json.dumps({"at": datetime.now().isoformat(), **r}) + "\n")
