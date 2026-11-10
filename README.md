# PhotoSort

Sorts photos, screenshots and videos into bucket folders (people, food, screenshot_chat, …), finds them by
plain-language search, and tags faces, using **local models only**. Model requests go to the NVIDIA PAIR
(Personal AI Router) Ollama proxy on this PC (`http://127.0.0.1:11434`), which spreads them across the PAIR
cluster on the LAN. This PC itself does not run models (its Ollama engine is off in PAIR; see
[Cluster nodes](#model-choice-benchmark-2026-11-09)).

**Privacy (standing rule):** photos, screenshots, videos and anything derived from them (video frames, faces,
captions, visible text, embeddings, the search index) never go to a cloud LLM or cloud service. This covers sorting, search
indexing, search queries and face tagging. It is enforced in code (`local_only.py`): PhotoSort refuses any
non-loopback `base_url`, ignores system/env HTTP proxies, and refuses Ollama cloud models (names ending
`-cloud`/`:cloud`, or models that PAIR lists with `remote_host`/`remote_model`), both when the config or
`--model` names one and at preflight before any photo is sent.

## Setup (once)

```powershell
# Dependencies live in the `utils` conda env (already installed). To reinstall:
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pip install -r requirements.txt
```

Video support comes from PyAV (`av`, with FFmpeg bundled; no separate FFmpeg install). `check` prints
`Video support: yes`; without PyAV, videos are left in place like other non-image files.

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

# Sort a folder with its subfolders: every photo and video goes into one set of buckets at the top folder
.\photosort.cmd sort "<folder>" --recursive --action report
.\photosort.cmd sort "<folder>" --recursive

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
- Photos and videos are sorted into the **same** buckets (a beach video goes to `nature`/`travel_places` next
  to the beach photos). See [Videos](#videos) for how a video is classified.
- `--recursive` takes the photos and videos from every subfolder and moves them into the one set of buckets
  at the source (or `--dest`) root; subfolders do not get buckets of their own. Only bucket folders at that
  root are skipped, so bucket folders left inside subfolders by earlier per-folder sorts are re-sorted into
  the root buckets. Other files stay in their subfolders; emptied subfolders are kept.
- Sorting moves/copies files without opening or re-encoding their content; photo and video bytes,
  including EXIF and video metadata, are preserved. A cross-volume move may have normal filesystem-metadata
  differences.
- Sorted types: images `.jpg .jpeg .png .webp .bmp .gif .tif .tiff .heic .heif` and videos `.mov .mp4 .m4v
  .3gp .avi .mkv .webm .wmv .mts .m2ts .mpg .mpeg`; other files stay where they are.
- Name collisions get a ` (1)` suffix; nothing is overwritten.
- If a file can't be classified (after 3 retries) it stays in place and the error is journaled.
- Every run appends to `_photosort_journal.jsonl` in the destination folder: run id, source, destination,
  bucket, confidence, errors. `undo` uses it.
- When the run ends, `sort` prints a **finish report**: how many files were sorted (photos and videos),
  errors, other files left in place, the **duration** (whole run: start, preflight, scan, classify, move;
  with start/finish times), speed in files/min, the journal path and a per-bucket count. `-v` also logs the
  raw JSON summary.
- Exit code: 0 = all sorted, 1 = some files failed, 2 = setup/config error.

## Videos

`sort`, `index`/`search` and `faces` all handle videos. Videos are decoded **on this PC** (PyAV); the models
see still frames, never the video file, and the video file is only read: never modified or re-encoded.

| Command | Frames used | Notes |
|---|---|---|
| `sort` | 8 frames spread evenly over the video, in time order, in **one** request | The model picks one bucket for the whole video |
| `index` | the same 8 frames, in one request | The caption describes the whole video; search finds it like a photo |
| `faces` | every keyframe, plus extra frames wherever keyframes are more than ~1 s apart | Full-resolution, lossless frames |

- Frames are taken at the nearest keyframes (fast to seek and decode) and turned
  upright from the video's rotation flag, as photos are from EXIF. Checked on 15 rotated phone videos: the
  local model judged all 15 corrected frames upright.
- 8 frames (about 280 tokens each) fit the 4,096-token context the cluster nodes already use; a larger
  context would make every PAIR node reload the model.
- Sound is not used: speech and music in a video are not searchable.
- Speed (56 real phone videos, 4.9 GB, 2026-11-09): `sort --action report` 2m 17s (24.5 files/min,
  0 errors); the real `sort --recursive` move 1m 08s (49.2 files/min, 0 errors, total size unchanged
  after the move). Face detection on `spark1:16`: 1,511 frames in 85.7 s (**1,058 frames/min**; 2,479 faces).

## Search photos and videos in plain language

`index` has a local vision model (`gemma4:12b`) describe every photo and video: a short caption, objects,
scene, visible text and a people count (a video is described from 8 frames as a whole). A local embedding
model (`qwen3-embedding:8b`) turns that description into vectors. `search` embeds your query the same way
and ranks files by similarity. Both talk only to the local PAIR proxy, and files are only read, never
modified.

```powershell
# Build or refresh the index (always includes subfolders; re-runs only process new or changed photos)
.\photosort.cmd index "C:\Users\<you>\OneDrive\Pictures\Camera Roll\2026"

# Search everything indexed, or only one folder
.\photosort.cmd search "receipt from the hardware store"
.\photosort.cmd search "kids playing at the beach" --folder "C:\Users\<you>\OneDrive\Pictures" --top 20
.\photosort.cmd search "stock price chart" --paths-only   # file paths only, no captions
```

**Index location:** by default, the SQLite database is
`%LOCALAPPDATA%\PhotoSort\search_index.sqlite` (for example,
`C:\Users\<you>\AppData\Local\PhotoSort\search_index.sqlite`). It is generated locally on each PC;
it is not in the PhotoSort repository or OneDrive, and is not shared with another PC. The database
contains captions and visible text derived from your photos. `index_path` in `config.json` can change
its location; keep it on a local, non-synced drive. Deleting the database is safe—run `index` again
to rebuild it. Your photos are not affected.

Behavior:
- **Speed:** indexing is the slow part (one caption per photo), so it runs in parallel across the PAIR
  nodes, with `index_concurrency` (12) requests in flight. A real 261-photo folder took 3m 30s (74.6
  images/min, 0 errors); a busy cluster without CVPRISM2 gave ~27 images/min. 12 measured fastest: 24 in
  flight on the same folder was slower (57.1 images/min) and produced a truncated reply, because requests
  queue on the slow nodes. Captions are about 150 tokens, versus a few for a bucket name, so indexing is
  slower than `sort`. Search is one embedding call (about 0.05 s) plus local math over the index (0.1 s
  for 261 photos), so it needs no cluster parallelism.
- **Accuracy:** on the 12 labelled public benchmark images with paraphrased queries ("my kitty", "how much
  did I pay at the store", "programming code in an editor"), the right photo ranked first 12/12. On the
  real folder, querying 5 words of a photo's visible text put that photo in the top 5 90% of the time.
- Each photo gets two vectors: one for what it shows and one for its raw visible text. A photo scores by
  whichever matches better, so a screenshot is found by its content or by the words in it. (Labelling the
  text "Visible text: …" made photos with a little text match queries like "text message conversation",
  and one merged vector let long screenshot text drown out the description; both measured worse.)
- Re-running `index` skips unchanged photos. Moved, renamed or duplicated photos are recognized by SHA-256
  and reuse their entry without a model call. Entries for files no longer under the folder are removed.
  `sort` and `undo` update the index for the files they move, so results keep pointing at the right place.
- The index is a SQLite file at `%LOCALAPPDATA%\PhotoSort\search_index.sqlite` (`index_path`), outside
  the repo and OneDrive. It is local to this PC and contains descriptions of private photos. Delete it
  to start over; no photo files are deleted or changed.
- The index finish report shows files found (and how many are videos), captioned, reused, unchanged,
  removed, errors, **duration** and files/min. It never prints captions. Exit code 1 if some files failed;
  re-run `index` to retry them.
- Videos take longer than photos: each request carries 8 frames, and each video is decoded on this PC first.
  56 real phone videos: 1m 45s–3m 19s (16.6–32.1 files/min, without CVPRISM2); the real index run took
  1m 55s (29.2 files/min, 0 errors) with the text-cap fix below.
- On some nodes `gemma4:12b` repeats one video's visible text without end until the reply hits its length
  limit. Such a reply is re-requested (remaining retries) with the `text` field capped at 300 characters in
  the JSON schema, the same limit PhotoSort keeps anyway. The caption, objects and scene come before the text in
  the reply, so they are what the normal request gives; only the runaway text is cut. Every other caption
  is requested exactly as before. Tested on 6 parallel requests across the nodes: 6/6 valid with the cap,
  2/6 with a repeat penalty instead (some nodes ignore it). Re-sending the same request does not help: at
  temperature 0 it loops the same way.
- Search prints score, path and a short caption per result. `[missing on disk]` marks files moved outside
  PhotoSort; re-run `index` on the folder. `--paths-only` prints only paths (for scripts and agents).
- Changing `caption_model` or `embed_model` re-describes photos on the next `index` run; `search` warns
  about entries made with a different embedding model.

## Local face tagging

`faces` uses InsightFace (`buffalo_l`: SCRFD face detection + ArcFace embeddings) to find faces in photos
and video frames and match them to named reference photos. It does **not** train or fine-tune a model: adding a person means
adding reference photos. No photo is sent to PAIR, Google Colab, or a cloud service. Workers refuse to
run unless the model files are already on disk; they never download models while tagging.

### Where detection runs: face workers

Detection runs in **face workers** (`face_worker.py`), listed in `face_workers` in `config.json`
(default `["spark1:16"]`) or with `--workers`:

| Worker | Meaning |
|---|---|
| `spark1:16` | SSH host alias `spark1`, 16 images in flight (GB10 GPU, CUDA) |
| `local:4` | A worker on the PC running PhotoSort (needs the local install below; not used on this PC) |
| `spark1:16,HOST2:8` | Both; work is balanced by load and a request is retried on another worker if one dies |

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

Not used on this PC: its RTX 4060 Laptop GPU is weak and the PC bogs down under inference, so model work
stays on the other machines (`face_workers` is `["spark1:16"]`). The steps below are for another Windows PC
with a capable GPU.

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
.\photosort.cmd faces "<folder>" --people "D:\PhotoSort\people" --workers spark1:16,HOST2:8
```

This writes/replaces `<folder>\photosort_faces.json`; original photos and videos are never modified. The
JSON sidecar records each image's relative path and each detected face's person name (or `null` when
unknown/ambiguous), cosine similarity, and face bounding box in pixels, plus the workers used. Raise
`--threshold` (default `0.45`) or `--margin` (default `0.05`) to be more conservative. Start with
`--limit 20` and check the sidecar before processing a full library. Reference photos should be
representative; use several different clear photos per person. The sidecar is a tagging manifest, not
embedded XMP metadata. The finish report shows the duration, speed (images + video frames per minute),
the number of videos and frames, and images/frames handled per worker.

**Videos:** every keyframe, plus extra frames wherever keyframes are more than ~1 s apart, goes to the face
workers at full resolution as lossless PNG (decoded on this PC; frames are never written to disk). A video's
record has `"type": "video"`, `"frames"` (frames checked), `"people"` (`{name: frames the person was seen
in}`) and `faces` entries with `time_s` (seconds into the video) besides the usual fields; reference
photos must be photos. Measured on `spark1:16` with 56 real phone videos (1,511 frames): 85.7 s,
1,058 frames/min. Frame preparation runs in parallel processes on this PC (decoding 4K video is the slow
part); the first version, one thread per video, managed 405 frames/min. If a video crashes its decoding
process (a damaged file, or out of memory), the pool is restarted and the affected frames are redone one at a
time, so only that video is reported as an error.

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
| `caption_model` | `gemma4:12b` | Vision model that describes photos for `index` |
| `embed_model` | `qwen3-embedding:8b` | Embedding model for photo descriptions and search queries |
| `index_concurrency` | `12` | Parallel caption requests for `index` (measured fastest); `--concurrency` overrides |
| `index_path` | `%LOCALAPPDATA%\PhotoSort\search_index.sqlite` | Search index file; keep it out of OneDrive |
| `buckets` | 13 buckets | `name: description`. Descriptions are sent to the model, so make them specific. `other` is required. |

To add/rename a bucket, edit `buckets` in `config.json` and add a one-line description.

## How it works

1. Scan the folder, downscale each image to 1024 px JPEG in memory (EXIF rotation applied). A video becomes
   8 upright frames (1024 px JPEG each) in one request.
2. A pool of `concurrency` workers posts `/api/chat` requests to the local PAIR proxy with a JSON
   schema that forces `{"bucket": <one of the buckets>, "confidence": 0-1}` (`think` off, temperature 0).
3. PAIR routes each request to a cluster node that has the model, favouring idle/fast nodes (not this PC:
   its Ollama engine is off).
4. As each result arrives the file is moved/copied and the journal line is written.
5. After the last file, the finish report (counts, duration, files/min, per-bucket totals) is printed.

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

Cluster nodes (as of 2026-11-09) and share of PhotoSort traffic in the original benchmark:

| Node | Hardware | Share | ~s/image (loaded) |
|---|---|---|---|
| CVPRISM2 | RTX 3090 24 GB | ~47% | 0.5–2 |
| spark1 | DGX Spark GB10 128 GB | ~28% | 2 |
| AxiDvBb1 | RTX Spark N1X 128 GB | ~19% | 3–10 |
| Canvitos-Mac-mini | Apple M4 24 GB | ~3% | 20 |
| ErsEv2Bb5 (this PC) | RTX 4060 Laptop 8 GB | ~3% | 35–60 |

**This PC does not run models any more.** Its GPU is weak and the whole PC slowed down while it served
requests, so its Ollama engine is turned off in PAIR (2026-11-09). The PAIR proxy on this PC keeps working
and sends every request to the other nodes. Checked after the change: 36 caption requests were served by
spark1, AxiDvBb1, ErsDvDk1 (RTX 2000 Ada Laptop 8 GB, now serving) and the Mac-mini, and a video index run
also used MinDvBb1; none went to this PC (GPU stayed at 0%). To keep it that way, leave Ollama off for this node in the PAIR app. CVPRISM2 did not answer
at that time (asleep or off); when it is down, sorting and indexing are slower.

Larger vision models (gemma4:31b, qwen3-vl:32b, qwen3.6:35b, …) exist only on spark1/AxiDvBb1/MinDvBb1,
so they can't use the whole cluster; switch `model` only if 12b accuracy isn't good enough.

## Troubleshooting

- `check` fails: make sure PAIR is running on this PC and `gemma4:12b` is installed on at least one node.
  `check` also reports whether the search models (`caption_model`, `embed_model`) are available.
- `check` says `Video support: no`: install PyAV (`...\python.exe -m pip install av`). Until then videos
  are left in place. A video that can't be decoded is reported as an error and left in place.
- This PC's GPU is busy again during a run: its Ollama engine was turned back on in PAIR. Turn it off there.
- `search` says "no search index": run `index` on a folder first.
- First requests are slow (up to ~60 s): nodes are loading the model; it stays loaded for 30 min.
- A run's last few files take longer: slow nodes (e.g. the Mac-mini) finish their last request.
- PAIR quirks seen: `/api/show` through the proxy can hit a node without models (404) — PhotoSort only
  uses `/api/tags` and `/api/chat`. ErsDvBb1 has no models. MinDvBb1 and ErsDvDk1 serve requests too
  (seen 2026-11-09).
- Mac-mini runs different builds of `gemma4:12b`/`qwen3.5:9b`; re-pull them there for consistent results.
- `faces`: "face worker environment not found" means the host was never set up: run
  `.\photosort.cmd faces-setup HOST`. Check SSH itself with `ssh -o BatchMode=yes HOST hostname`
  (it must not prompt). If one of several workers fails, the run continues on the others and the report
  lists it as failed. Workers stop when their SSH session ends, so nothing keeps GPU memory after a run.

## Tests

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pytest -q tests   # or: python -m pytest -q tests (env activated)
```
