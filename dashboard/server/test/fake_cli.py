"""Stand-in for photosort.py in the job-runner tests. Speaks the same events file and cancel file protocol.

Arguments after the global options are the job's own; these extra flags steer the fake:
  --items=N         items to report (default 5)
  --delay=S         seconds per item (default 0.02)
  --ignore-cancel   keep going after a cancel request (to test a forced stop)
  --crash           write to stderr and exit 2 without any events
"""
import argparse
import datetime
import json
import os
import sys
import time

seq = 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config")
    ap.add_argument("--events")
    ap.add_argument("--cancel-file")
    ap.add_argument("rest", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    rest = a.rest
    items, delay = 5, 0.02
    for r in rest:
        if r.startswith("--items="):
            items = int(r.split("=", 1)[1])
        elif r.startswith("--delay="):
            delay = float(r.split("=", 1)[1])
    print(json.dumps({"argv": rest}), flush=True)
    if "--crash" in rest:
        print("Traceback (most recent call last):\nValueError: the fake crashed", file=sys.stderr, flush=True)
        return 2
    ev = open(a.events, "a", encoding="utf-8")

    def emit(kind: str, **fields) -> None:
        global seq
        seq += 1
        ts = datetime.datetime.now().isoformat(timespec="milliseconds")
        ev.write(json.dumps({"v": 1, "seq": seq, "ts": ts, "type": kind, **fields}) + "\n")
        ev.flush()

    folder = os.path.dirname(a.events)
    journal = os.path.join(folder, "_photosort_journal.jsonl")
    open(journal, "a").close()
    emit("run_start", cmd=rest[0] if rest else "", params={}, pid=os.getpid())
    emit("phase", name="sort", total=items, run_id="20261110-120000-abcdef", journal=journal)
    for n in range(1, items + 1):
        if os.path.exists(a.cancel_file) and "--ignore-cancel" not in rest:
            emit("finish", status="cancelled", exit_code=130, summary={"done": n - 1})
            return 130
        time.sleep(delay)
        if n == 3:
            emit("item", phase="sort", n=n, total=items, path=f"C:\\x\\img{n}.jpg", error="unreadable")
        else:
            emit("item", phase="sort", n=n, total=items, path=f"C:\\x\\img{n}.jpg",
                 result={"bucket": "food" if n % 2 else "people", "confidence": 0.9})
    emit("warning", message="one file was unreadable")
    emit("finish", status="errors" if items >= 3 else "ok", exit_code=1 if items >= 3 else 0,
         summary={"done": items}, report="REPORT TEXT")
    return 1 if items >= 3 else 0


if __name__ == "__main__":
    sys.exit(main())
