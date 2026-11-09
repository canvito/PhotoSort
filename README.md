# PhotoSort

Sorts photos and screenshots into bucket folders (people, food, screenshot_chat, …) using **local vision
LLMs only**. Classification requests go to the NVIDIA PAIR (Personal AI Router) Ollama proxy on this PC
(`http://127.0.0.1:11434`), which spreads them across the PAIR cluster on the LAN.

**Privacy:** images never go to a cloud LLM. `photosort.py` refuses any non-loopback `base_url`
and ignores system/env HTTP proxies.

## Setup (once)

```powershell
# Dependencies live in the `utils` conda env (already installed). To reinstall:
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pip install -r requirements.txt
```

`photosort.cmd` runs `photosort.py` with that env's Python, so it works from any shell and any folder
(no `conda activate`; plain `python` on this PC is the Windows Store shim and does not work). If the
env moves, edit `PY` at the top of `photosort.cmd`.

PAIR must be running on this PC (it provides the proxy on port 11434).

## Usage

```powershell
cd C:\Users\<you>\Documents\GitHub\canvito\utils\PhotoSort

# 1. Is the PAIR proxy up and the model available?
.\photosort.cmd check

# 2. Preview without touching files (writes only the journal)
.\photosort.cmd sort "<folder>" --action report

# 3. Sort a month of the camera roll (moves files into bucket subfolders of the source)
.\photosort.cmd sort "C:\Users\<you>\OneDrive\Pictures\Camera Roll\2026\11"

# Other options
.\photosort.cmd sort "<folder>" --action copy --dest "D:\Sorted" --recursive --limit 20 --concurrency 16

# Undo the latest sort run in a folder (moves files back, removes empty bucket folders)
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl"
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" --run-id 20261109-111724-591f86
```

From another folder, use the full path: `C:\Users\<you>\Documents\GitHub\canvito\utils\PhotoSort\photosort.cmd`.
With the env activated (`conda activate utils`), `python photosort.py ...` works the same way.

Behavior:
- Buckets are created as subfolders of `--dest` (default: the source folder). Re-running is safe: files
  already in bucket folders are skipped.
- Only images are sorted (`.jpg .jpeg .png .webp .bmp .gif .tif .tiff .heic .heif`); videos and other
  files stay where they are.
- Name collisions get a ` (1)` suffix; nothing is overwritten.
- If a file can't be classified (after 3 retries) it stays in place and the error is journaled.
- Every run appends to `_photosort_journal.jsonl` in the destination folder: run id, source, destination,
  bucket, confidence, errors. `undo` uses it.
- When the run ends, `sort` prints a **finish report**: how many images were sorted, errors, non-image files
  left in place, the **duration** (whole run: start, preflight, scan, classify, move; with start/finish
  times), speed in images/min, the journal path and a per-bucket count. `-v` also logs the raw JSON summary.
- Exit code: 0 = all sorted, 1 = some files failed, 2 = setup/config error.

## Local face tagging

`faces` uses InsightFace (`buffalo_l`: SCRFD face detection + ArcFace embeddings) to find faces and
match them to named reference photos. It does **not** train or fine-tune a model: adding a person means
adding reference photos. No photo is sent to PAIR, Google Colab, or a cloud service. Workers refuse to
run unless the model files are already on disk; they never download models while tagging.

### Where detection runs: face workers

Detection runs in **face workers** (`face_worker.py`), listed in `face_workers` in `config.json`
(default `["spark1:16"]`) or with `--workers`:

| Worker | Meaning |
|---|---|
| `spark1:16` | SSH host alias `spark1`, 16 images in flight (GB10 GPU, CUDA) |
| `local:4` | A worker on this PC (needs the local install below) |
| `spark1:16,local:2` | Both; work is balanced by load and a request is retried on another worker if one dies |

PAIR cannot run InsightFace (it only routes LLM engines), so workers use plain SSH. On each run the
coordinator (this PC) starts the worker over SSH, checks its code hash and redeploys
`~/.photosort/face_worker.py` automatically when it is missing or stale.

**Privacy and transport:** photos are read on this PC and sent only through the encrypted SSH connection,
via an `ssh -L` tunnel to a port that the worker opens on its own `127.0.0.1` and unlocks with a one-time
token. The worker decodes images in memory, writes nothing to disk and exits when the SSH session ends.
Hosts that resolve to a public Internet address are refused (LAN, VPN and Tailscale addresses are fine).
Reference photos, person embeddings and name matching stay on this PC; the sidecar stores no embeddings.

**One-time worker setup** (spark1 is already set up). Requirements: Linux or macOS, `bash`, Python 3.10+,
key-based SSH (the alias must work with `ssh HOST` and no password prompt). No `sudo` needed:

```powershell
.\photosort.cmd faces-setup spark1
```

This creates `~/.photosort/venv` on the host (ONNX Runtime GPU build with bundled CUDA/cuDNN when
`nvidia-smi` exists, else CPU), installs InsightFace, downloads `buffalo_l` to `~/.insightface/models`
on that host, deploys the worker and test-starts it. If a run says to run `faces-setup HOST`, do so.

**Speed** (578 Camera Roll images, 814 MB, wired gigabit Ethernet, 2026-11-09):

| Workers | Transport | Detect time | Throughput |
|---|---|---:|---:|
| `spark1:16` | SSH stdin/stdout (first version) | 70.0 s | 496 images/min, 11.6 MB/s |
| `spark1:8` | `ssh -L` tunnel | 10.4 s | 3,347 images/min, 78.6 MB/s |
| `spark1:16` | `ssh -L` tunnel | 9.5 s | **3,659 images/min**, 85.9 MB/s |
| `spark1:32` | `ssh -L` tunnel | 10.2 s | 3,389 images/min, 79.6 MB/s |

Worker startup adds ~7–9 s per run. The GB10 is not the limit: with the tunnel, this PC's gigabit link
is (Windows OpenSSH moves only ~10 MB/s through a single session's stdin/stdout, hence the tunnel). Use
wired Ethernet; more threads or more GPU nodes will not make it much faster while the link is saturated.

Shrinking photos on this PC before sending was tested and is **not used**, because it changes results. On
the same 578 photos (268 faces), shrinking to 3000/2048/1600 px sent 1.8–4.4× less data, but lost 3–5 faces
and changed 24–53 of ~35,000 same/different-person decisions at the 0.45 threshold. Full-resolution runs
are exactly repeatable. To go faster without changing results, use faster networking (2.5/10 GbE).

**Other nodes:** only spark1 accepts SSH today. AxiDvBb1, CVPRISM2, MinDvBb1 and ErsDvBb1 have port 22
closed, and the Mac-mini refuses it (Remote Login off). A Linux/macOS node becomes a worker after enabling
its SSH server, adding a key-based alias, and running `faces-setup HOST`. Windows nodes (e.g. CVPRISM2) are
not supported yet: the setup script and remote paths assume `bash` and `~`.

### Optional: a worker on this PC (`local`)

Install the optional dependencies once, then download the public model pack once. This setup step
downloads model weights only; it does not upload photos:

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pip install -r requirements-faces.txt
C:\Users\<you>\miniconda3\envs\utils\python.exe -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_l')"
```

By default the model pack is stored under `%USERPROFILE%\.insightface\models\buffalo_l` (`--model-dir`
changes it for a `local` worker). On an NVIDIA GPU, install the CUDA runtime after the dependencies (the
default CPU runtime also works, but is slower):

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pip uninstall -y onnxruntime
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pip install onnxruntime-gpu
```

The worker uses CUDA when ONNX Runtime exposes it and otherwise uses CPU.

### Reference people and running

Create one reference subfolder per person; each reference image must contain exactly one clear face:

```text
D:\PhotoSort\people\
  Alice\
    alice-1.jpg
    alice-2.jpg
  Bob\
    bob-1.jpg
```

Then analyze a folder. `--recursive` is useful for month folders already sorted into bucket subfolders:

```powershell
.\photosort.cmd faces "C:\Users\<you>\OneDrive\Pictures\Camera Roll\2026\10" --people "D:\PhotoSort\people" --recursive --limit 20
.\photosort.cmd faces "<folder>" --people "D:\PhotoSort\people" --recursive
.\photosort.cmd faces "<folder>" --people "D:\PhotoSort\people" --workers spark1:16,local:2
```

This writes/replaces `<folder>\photosort_faces.json`; original photos are never modified. The JSON
sidecar records each image's relative path and each detected face's person name (or `null` when
unknown/ambiguous), cosine similarity, and face bounding box in pixels, plus the workers used. Raise
`--threshold` (default `0.45`) or `--margin` (default `0.05`) to be more conservative. Start with
`--limit 20` and check the sidecar before processing a full library. Reference photos should be
representative; use several different clear photos per person. The sidecar is a tagging manifest, not
embedded XMP metadata. The finish report shows the duration, speed and images handled per worker.

**Model terms:** [InsightFace's Python library is MIT-licensed](https://github.com/deepinsight/insightface/blob/master/python-package/README.md#license),
but its provided pretrained model weights are restricted to non-commercial research use. This model
pack is intended for personal/non-commercial use; review the model license before commercial use.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `base_url` | `http://127.0.0.1:11434` | PAIR Ollama proxy; must be loopback |
| `model` | `gemma4:12b` | Vision model (see below) |
| `concurrency` | `12` | Parallel requests (workers) sent to the cluster |
| `max_side` | `1024` | Images are downscaled in memory before sending; originals untouched |
| `timeout_s`, `retries` | `300`, `3` | Per-request timeout and retry count |
| `action` | `move` | Default action: `move`, `copy` or `report` |
| `face_workers` | `["spark1:16"]` | Where `faces` runs detection: SSH `HOST[:THREADS]` and/or `local[:THREADS]`; `--workers` overrides |
| `buckets` | 13 buckets | `name: description`. Descriptions are sent to the model, so make them specific. `other` is required. |

To add/rename a bucket, edit `buckets` in `config.json` and add a one-line description.

## How it works

1. Scan the folder, downscale each image to 1024 px JPEG in memory (EXIF rotation applied).
2. A pool of `concurrency` workers posts `/api/chat` requests to the local PAIR proxy with a JSON
   schema that forces `{"bucket": <one of the buckets>, "confidence": 0-1}` (`think` off, temperature 0).
3. PAIR routes each request to a cluster node that has the model, favouring idle/fast nodes.
4. As each result arrives the file is moved/copied and the journal line is written.
5. After the last file, the finish report (counts, duration, images/min, per-bucket totals) is printed.

## Model choice (benchmark 2026-11-09)

Tested all vision models reachable through PAIR with 12 labelled images, up to 120 requests per model.

| Model | Nodes serving | Valid JSON | Correct | Sustained (12 workers) |
|---|---|---|---|---|
| **gemma4:12b** | 5 | 205/205 | 100% | **~100 img/min** |
| qwen3.5:9b | 5 (+MinDvBb1 idle) | 259/265 | 100% of valid | ~94 img/min |

gemma4:12b is the default: same accuracy, no malformed replies. qwen3.5:9b truncated ~2% of replies,
traced to the Mac-mini's different build of the model.

Full report: [`benchmarks/REPORT.md`](benchmarks/REPORT.md). To re-test after PAIR gets new models or nodes,
put a small labelled set in `benchmarks\images\` (`<category>__<name>.jpg`, categories listed in
[`benchmarks/bench.py`](benchmarks/bench.py); git-ignored so personal photos are never committed) and run:

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe benchmarks\bench.py --models gemma4:12b qwen3.5:9b --repeat 10 --concurrency 12
```

It talks only to the local PAIR proxy, prints one JSON summary per model (accuracy, img/min, per-node
share) and appends it to `benchmarks\results.jsonl` (git-ignored).

Cluster nodes (as of 2026-11-09) and share of PhotoSort traffic:

| Node | Hardware | Share | ~s/image (loaded) |
|---|---|---|---|
| CVPRISM2 | RTX 3090 24 GB | ~47% | 0.5–2 |
| spark1 | DGX Spark GB10 128 GB | ~28% | 2 |
| AxiDvBb1 | RTX Spark N1X 128 GB | ~19% | 3–10 |
| Canvitos-Mac-mini | Apple M4 24 GB | ~3% | 20 |
| ErsEv2Bb5 (this PC) | RTX 4060 Laptop 8 GB | ~3% | 35–60 |

Larger vision models (gemma4:31b, qwen3-vl:32b, qwen3.6:35b, …) exist only on spark1/AxiDvBb1/MinDvBb1,
so they can't use the whole cluster; switch `model` only if 12b accuracy isn't good enough.

## Troubleshooting

- `check` fails: make sure PAIR is running on this PC and `gemma4:12b` is installed on at least one node.
- First requests are slow (up to ~60 s): nodes are loading the model; it stays loaded for 30 min.
- A run's last few images take longer: slow nodes (this laptop, Mac-mini) finish their last request.
- PAIR quirks seen: `/api/show` through the proxy can hit a node without models (404) — PhotoSort only
  uses `/api/tags` and `/api/chat`. MinDvBb1 receives no proxy traffic; ErsDvBb1 has no models.
- Mac-mini runs different builds of `gemma4:12b`/`qwen3.5:9b`; re-pull them there for consistent results.
- `faces`: "face worker environment not found" means the host was never set up: run
  `.\photosort.cmd faces-setup HOST`. Check SSH itself with `ssh -o BatchMode=yes HOST hostname`
  (it must not prompt). If one of several workers fails, the run continues on the others and the report
  lists it as failed. Workers stop when their SSH session ends, so nothing keeps GPU memory after a run.

## Tests

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pytest -q tests   # or: python -m pytest -q tests (env activated)
```
