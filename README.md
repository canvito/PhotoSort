# PhotoSort

Sorts photos, screenshots and videos into bucket folders (people, food, screenshot_chat, …), gathers the ones
that match a plain-language request ("birthday party last Sunday") into one folder, finds them by
plain-language search, and tags faces, using **local models only**. Model requests go to the NVIDIA PAIR
(Personal AI Router) Ollama proxy on this PC (`http://127.0.0.1:11434`), which spreads them across the PAIR
cluster on the LAN. This PC itself does not run models (its Ollama engine is off in PAIR; see
[Cluster nodes](#model-choice-benchmark-2026-11-09)).

**Privacy (standing rule):** photos, screenshots, videos and anything derived from them (video frames, faces,
captions, visible text, embeddings, the search index) never go to a cloud LLM or cloud service. This covers sorting, grouping, search
indexing, search queries and face tagging. A `group` request is your own text, and it too goes only to the local models. It is enforced in code (`local_only.py`): PhotoSort refuses any
non-loopback `base_url`, ignores system/env HTTP proxies, and refuses Ollama cloud models (names ending
`-cloud`/`:cloud`, or models that PAIR lists with `remote_host`/`remote_model`), both when the config or
`--model` names one and at preflight before any photo is sent. OneDrive is the one cloud service involved, and
only as storage: the photos already live there, so OneDrive syncs what PhotoSort does inside a synced folder,
namely the bucket and group folders, the moved files, `_photosort_journal.jsonl` (file paths, bucket and
confidence) and a group folder's `_photosort_group.json` (your request). The search index stays outside OneDrive.
See [Privacy audit](#privacy-audit) for the last check and how to repeat it.

The [Dashboard](#dashboard-dashboardps1), a desktop window, runs sort, group, index, apply and undo for you, with
live progress, and searches and browses the index with thumbnails (faces come in a later phase). Start it with
`.\dashboard.ps1` and stop it with `.\dashboard.ps1 stop`.

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

# Gather the files that match a plain-language request into one folder; everything else stays put
.\photosort.cmd group "<folder>" "birthday party on last Sunday" --action report
.\photosort.cmd group "<folder>" "birthday party on last Sunday"

# Preview, then move exactly what the preview found (the model is not asked again)
.\photosort.cmd sort "<folder>" --action report
.\photosort.cmd apply "<folder>\_photosort_journal.jsonl"

# Undo the latest sort, group or apply run in a folder (moves files back, removes empty bucket or group folders)
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" --dry-run   # list what would move back; changes nothing
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
  the root buckets. Group folders made by `group` (they hold a `_photosort_group.json` marker) are always
  skipped. Other files stay in their subfolders; emptied subfolders are kept.
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
- Exit code: 0 = all sorted, 1 = some files failed, 2 = setup/config error, 130 = stopped (Ctrl+C).
- **Stopping safely:** Ctrl+C stops a run at the next file. A file move and its journal line always finish
  together, so a stopped run never leaves a file half-moved or moved without a journal line; `undo` reverts what
  was done, and the rest stay where they were.
- **`apply`** takes a preview (`sort` or `group` with `--action report`; the latest one in the journal not yet
  applied, or `--run-id`) and moves (or `--action copy`) exactly the files it listed into the folders it chose,
  without asking the model again. A preview records each file's size, modified time and SHA-256; a file that
  changed or is gone since then is left alone and counted as `changed` (exit code 1). `undo` reverts an apply
  like any other run.
- **One run per folder:** a run that moves or copies files (`sort`, `group`, `apply`, `undo`) refuses to start while
  another PhotoSort run uses an overlapping folder, and runs that only read (`--action report`, `index`, `faces`,
  `undo --dry-run`) refuse while one is moving files there. The message names the other run; `--force` runs
  anyway. Lock files live in `%LOCALAPPDATA%\PhotoSort\locks` and are ignored once their process has ended.
- `--events FILE` and `--cancel-file FILE` (before the command) are for the dashboard: progress as JSON lines,
  and a safe stop once the file exists. Without them nothing changes in the output.

## Videos

`sort`, `group`, `index`/`search` and `faces` all handle videos. Videos are decoded **on this PC** (PyAV); the models
see still frames, never the video file, and the video file is only read: never modified or re-encoded.

| Command | Frames used | Notes |
|---|---|---|
| `sort` | 8 frames spread evenly over the video, in time order, in **one** request | The model picks one bucket for the whole video |
| `group` | the same 8 frames, in one request | The model says whether the video shows the request's topic |
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

## Group photos and videos by a plain-language request

`group` gathers the photos and videos that match a request such as "birthday party on last Sunday" into one
folder and leaves everything else where it is.

```powershell
# Preview: prints what it understood and the files it would gather; changes nothing
.\photosort.cmd group "C:\Users\<you>\OneDrive\Pictures\Camera Roll\2026" "sort group photo and video by birthday party on last Sunday. Leave everything else where they are" --action report

# Move them (or --action copy)
.\photosort.cmd group "<folder>" "birthday party on last Sunday"

# When the request is read wrongly or refused, say the dates, kind of file or folder name yourself
.\photosort.cmd group "<folder>" "birthday party" --from 2026-11-07 --to 2026-11-08 --media videos --name "Mia turns 5"

# Undo the latest run (moves the files back and removes the emptied group folder)
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl"
```

How it works:

1. **Reading the request** (text only; no photo is sent). The local model (`model`) reads the request 3 times
   in parallel, and the PAIR proxy spreads the readings over the nodes. Each reading gives a topic ("a birthday
   party"), the kind of files (photos, videos or both) and the dates. The model gets a calendar of the last 9
   weeks and a table of named days worked out in code, so "last Sunday" is a lookup, not arithmetic. The table
   covers today, yesterday, this/last week, this/last weekend, last <weekday> (also "on Sunday"), the <weekday>
   before last, this/last month, and 13 US holidays (the most recent of each). A month or season without a year
   is the most recent one; 11/8 is month/day.
   - The 3 readings must agree on the dates, the kind of files and whether there is a topic. If they don't,
     `group` stops and asks you to reword the request or to give `--from`/`--to` (and `--media`). Stopping is
     safer than gathering the wrong files.
   - The kind of files comes from the request's own words when they are plain ("photos", "pictures",
     "screenshots", "videos", "clips"; both or neither means both). With a negation ("everything except the
     videos") the model's reading must agree with the words; if not, `group` stops and suggests the `--media`
     to add.
   - Future dates are refused, and a range that ends after today ends today. A request with neither a topic nor
     dates is refused.
   - Names of people are not recognized (that is what `faces` is for). A request with only names ("photos of
     mom") is refused; with a topic, the names are ignored and the report says so.
2. **Dates** come from each file's capture time, read in parallel from metadata (nothing is decoded):
   - Photos: EXIF DateTimeOriginal, then DateTimeDigitized, then DateTime.
   - Videos: Apple's `com.apple.quicktime.creationdate` (local time when filmed), then the file name, then
     `creation_time` (edited or exported clips set it to the export time).
   - Without metadata, the date in the file name: OneDrive camera-upload names (`20261108_190000000_iOS.jpg`)
     are UTC and are converted to this PC's time zone; `IMG_`/`VID_`/`PXL_` names are local time;
     `Screenshot 2026-11-08` gives the day.
   - The file's modified time is never used (copying and syncing change it). Files whose OneDrive name is more
     than 2 days outside the dates are not even opened.
   - With a topic, a day runs until 4 am the next day (a party that goes past midnight).
3. **Matching.** Each file in the date range goes to the local vision model (`model`, `concurrency` 12 in
   flight across the PAIR nodes; a video as 8 frames, as in `sort`). The model is first asked whether the file
   "shows" the topic, strictly: a similar but different occasion, such as a baby shower for "a birthday party",
   is a no. If it says no, it is asked a second wording: does the file show the topic, or was it clearly taken
   at one (its guests, food, decorations or activities)? The file matches if either answer is yes. Without a
   topic ("everything from Saturday"), every file in the date range matches and no model is needed.
4. **Same occasion.** A file that did not match but was taken within 10 minutes (`EVENT_NEAR` in `group.py`) of
   a match, or of a file already in the group folder, is asked once more, and told so: was it taken at that same
   occasion (its people, place, food, decorations or activities)? For a thing rather than an event ("a dog"),
   it must still show the topic. Files that match this way don't widen the window (no chaining), and files with
   no capture time are not asked. This pass also runs for a request with no dates (capture times are read for
   it).
5. **Gathering.** Nothing moves until every check is done. Then matches are moved (the default `action`) or
   copied into one folder inside the source folder, named from the request and its dates, e.g.
   `Birthday party 2026-11-08` (`--name` sets it). That folder holds a `_photosort_group.json` marker. If a group
   folder with that name already exists, matches are added to it, so running the same request again adds files
   taken near the ones already gathered. A folder of your own with the same name is never used; a ` (1)` folder
   is made instead.

Behavior:
- `group` looks in the folder and all its subfolders, including bucket folders from `sort`. It skips group
  folders, and `sort --recursive` skips them too.
- Every checked file is journaled in `_photosort_journal.jsonl` in the folder: capture time and where it came
  from, match and confidence, `matched_by` (`topic`, `same event` or `dates`) and `near_match` (asked the
  same-occasion question). `undo` moves the files back and removes the emptied group folder. Moves update the
  search index paths. Ctrl+C during the checks moves nothing.
- The finish report shows what was understood (topic, kind of files, dates), the group folder, files scanned,
  in range, at other dates and with no capture date, files checked (and how many taken near a match were asked
  about the same occasion, and how many were), files found (photos, videos), errors, the **duration** and
  files/min. With `--action report` it also lists the matching files.
- Exit code: 0 = done, 1 = some files failed (they stay in place), 2 = request not understood or setup error.

Accuracy and speed (2026-11-10, `gemma4:12b` through PAIR; public images and made-up requests only):
- **Reading requests:** 39 test requests ("birthday party last Sunday", "pictures from Halloween", "the trip
  to the lake from Oct 20 to Oct 25", "the party last Sunday but not the videos", …), each read 6 times:
  217/234 single readings right. With 3 readings that must agree: 36 requests right, 0 wrong, 3 refused (all
  with "not"/"except"; each refusal names the `--media` to add).
- **Matching** "a birthday party" on 132 public Wikimedia Commons photos: 22 birthday parties and 110
  look-alikes (dinner parties, wedding receptions and cakes, picnics, Halloween, Christmas and Thanksgiving
  dinners, baby showers, graduations, business meetings, cupcakes). Found 22/22, with 2 false matches (a
  display of pink cupcakes, baby-shower balloons). The "shows" wording alone found 20/22; the "taken at"
  wording alone 18/22; a single lenient wording found 22/22 but with 10 false matches. 8 short videos made from
  those photos: 8/8 right. 8 other topics (a dog, a receipt, a bridge, source code, food, mountains, a stock
  chart, a chat) on 12 photos: 8/8 found, 1 false match (a receipt for "food").
- **Same-occasion question** (each photo asked as if taken within 10 minutes of a match): the 22 birthday
  parties 22/22 yes; 8 unrelated photos (4 screenshots, a receipt, a mountain, a bridge, a street) 8/8 no; for
  7 thing topics, 7/7 targets yes and 77/77 other photos no. Other events (Halloween, weddings, dinners…) get
  yes 75/110 times, which is why only files taken within 10 minutes of a match are asked. 247 checks in 50 s.
- **Speed:** 255 checks in 89 s (172 files/min; most files need both wordings), spread over 7 nodes. Reading
  a request takes about 2–9 s. Real preview on Camera Roll 2026: 768 files scanned, 17 from that Sunday,
  37.6 s in all.
- **Limits:** a photo taken at an event that shows nothing of it and was taken more than 10 minutes from any
  match can be left behind; preview with `--action report`. Answers on borderline files can differ between runs
  (different nodes answer them). Times of day ("Sunday afternoon") are not used; the whole day is.

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

## Dashboard (`dashboard.ps1`)

A desktop window for PhotoSort, built in phases. **Now (v1 = P0–P2):** the window, its local server, PAIR
health, the privacy checks, **jobs** (sort, group, index, apply and undo with live progress) and **search and
gallery** (plain-language search, browsing the whole index, thumbnails, previews and video playback). Later
phases: P3 the full runs history, the cluster view and live privacy checks; P4 faces and settings. Until then
those pages show the matching CLI command.

```powershell
cd C:\Users\<you>\Documents\GitHub\canvito\utils\PhotoSort
.\dashboard.ps1            # start: installs what is missing (asks first), starts the server, opens the window
.\dashboard.ps1 stop       # closes the window and stops the server
.\dashboard.ps1 status     # running or not, versions, PAIR and model state (no file names or paths)
.\dashboard.ps1 open       # reopens the window of a running dashboard
.\dashboard.ps1 restart
.\dashboard.ps1 setup      # installs or updates without starting
```

It works in PowerShell 7 and Windows PowerShell 5.1. If scripts are blocked, run
`powershell -ExecutionPolicy Bypass -File .\dashboard.ps1`.

| Flag | Meaning |
|---|---|
| `-NoOpen` | start the server without the window |
| `-Gpu auto\|rtx\|igpu` | `auto` (default): the RTX GPU on AC power, Iris Xe on battery |
| `-Port N` | use this port (default 47615, else the next free one up to 47625) |
| `-Yes` | allow installs without asking (needed when nobody can answer, e.g. scripts) |
| `-Force` | `stop`: end the server if it doesn't stop within 10 s (never while a job runs) |
| `-LeaveJobRunning` | `stop`: stop the dashboard but let a running job finish |
| `-Rebuild`, `-Update` | rebuild the web app; update Electron |
| `-UseSystemNode`, `-Python PATH` | use the installed Node.js 24–26; use another Python |
| `-Fixture` | synthetic test library, fake PAIR, own data folder and port 47616 (for tests and agents) |

Exit codes: 0 done, 1 failed, 2 a needed install is missing or was declined, 3 not running.

### Jobs

Each page fills in a form and starts the same `photosort.py` command you would type; **Copy CLI command** shows
it. Folders come from a picker (Pictures, Videos, OneDrive Pictures, Desktop, Downloads and each drive) or a
pasted path. It refuses whole drives, your whole user folder, system and app-data folders, network paths and
PhotoSort's own folders.

| Page | What it does |
|---|---|
| **Sort** | Preview, move or copy into buckets; optional destination, subfolders, and advanced limit, parallel requests, model and `--force` |
| **Group** | A plain-language request (up to 500 characters, with examples); advanced folder name, From/To dates (To empty = today), photos/videos/both |
| **Index** | Builds or refreshes the search index (unchanged files are skipped). It is the third tab of the Search page; results show up in Search and Browse as soon as the job finishes |
| **Runs** | Every job with its result, filtered by kind; **Undo a folder's last run** previews undoing the latest run in that folder's journal |
| **Job** (`/jobs/<id>`) | Live progress, the per-file list (virtualized), what a group request understood, the finish report and its duration, and the next step: **Move these N files** or **Copy instead** after a preview, **Undo this run…** (a preview), then **Move N files back now**, or **Edit and run again**. A refused group request or a locked folder offers fixes (**Retry with photos only**, **Set the dates…**, **Run anyway…**) |

- **One heavy job at a time.** Jobs that read many files or move them wait in a queue (a dock at the bottom
  shows it, and toasts report each finish); **Remove from queue** drops a waiting one. Undo previews run at once.
- **Moves always go preview first:** move or copy asks for confirmation; applying a preview moves exactly what it
  listed without asking the model again; undo is offered as a preview, then a move.
- **Stopping a job:** **Stop safely** asks the run to stop at the next file (the safe stop described in
  [Usage](#usage)). **Force stop** is offered only 10 s later, because it ends the process at once.
- **Survives restarts:** the job's Python process runs on its own, so closing the window or stopping the server
  (`stop -LeaveJobRunning`) doesn't end it; the next start reattaches. `stop` while a job runs asks first:
  `-Yes` stops the job safely, then the dashboard (up to 180 s). A job whose process vanished is shown as
  *interrupted*.
- Each job lives in `<data folder>\jobs\<id>\`: `job.json` (status, counts, summary), `events.jsonl` (the
  `--events` stream), `stdout.txt`/`stderr.txt` (the CLI's own output, with file names, as in a terminal) and
  `cancel` (the stop request). Jobs are kept for 90 days, at most 1,000.
- The Python must be PhotoSort's env (`photosort.cmd`'s `PY`, or `-Python`). The Overview page shows whether it
  has HEIC (`pillow-heif`) and video (`av`) support.

**What setup installs** (it asks first; each step re-runs only when its input changed):
- Node.js 26 LTS, a private copy in `%LOCALAPPDATA%\PhotoSort\runtime` (zip from nodejs.org, checked against
  its SHA-256 list). Your installed Node.js, if any, is not used or changed.
- npm packages in `dashboard\node_modules` (`npm ci --ignore-scripts`, pinned by `package-lock.json`) and
  Electron 45.
- The web app build (`dashboard\web\dist`).
- A check that PhotoSort's Python env has its packages (it offers `pip install -r requirements.txt`).

**How it keeps your photos private:**
- The server is Node.js on `127.0.0.1` only, with a new random token per start. It refuses other host names,
  other sites' pages and unknown request fields.
- Its only outbound connection is the PAIR proxy on `127.0.0.1`: read-only model list and status, refusing
  cloud models. A test fails if any other server file opens a connection.
- The window (Electron) is the only client. It adds the token itself, so the page never sees it.
- The window blocks every request that is not to its own server, internet and LAN alike, and resolves no
  host names. It also turns off proxies, WebRTC UDP, navigation, new windows, downloads, permissions and
  spell-check downloads.
- Content protection is on: screenshots and screen sharing see a black window. The shield chip in the top bar
  turns it off, e.g. to share the screen. The Blur chip (Ctrl+Shift+B) blurs thumbnails and text.
- The page has no access to Node.js or files.
- Check it with `.\dashboard.ps1 start -Fixture -NoOpen`, then `.\dashboard.ps1 selftest -Fixture` (8 checks),
  then `.\dashboard.ps1 stop -Fixture`.

**Graphics:** the window draws with the GPU. Chromium can't choose the GPU on Windows, so `dashboard.ps1` sets
Windows' per-app graphics preference for the dashboard's own `electron.exe` before each launch. The value is
in `HKCU\Software\Microsoft\DirectX\UserGpuPreferences`: `GpuPreference=2` is the RTX 4060, `1` is the Iris
Xe. To remove it, use Settings > System > Display > Graphics, or delete that value. This is drawing only; no
model runs on this PC.

**Where its data lives** (outside the repo and OneDrive; it refuses a data folder inside OneDrive):
- `%LOCALAPPDATA%\PhotoSort\runtime`: Node.js and the Python-check cache.
- `%LOCALAPPDATA%\PhotoSort\dashboard`:
  - `state.json`: the port, process id and this run's token;
  - `shell.json`: the window's process;
  - `logs\`: `server-*`, `shell-*` and `setup-*` logs, which hold events and counts, no file names;
  - `jobs\<id>\`: each job's record, events and CLI output (these do hold file names, like a terminal would);
  - `thumbs\`: the thumbnail and preview cache (metadata-free WebP, at most 3 GB); `media.key`: the secret for
    item ids;
  - `shell\`: the window's browser cache.
- `%LOCALAPPDATA%\PhotoSort\dashboard-fixture`: the same for `-Fixture`, plus the synthetic `library\`.
- `%LOCALAPPDATA%\PhotoSort\locks`: the CLI's folder locks (see [Usage](#usage)), shared by both modes.
- `dashboard\node_modules` and `dashboard\web\dist` are git-ignored.

### Search and gallery

The **Search** page has three tabs: **Search** (default), **Browse** and **Index** (the index job form).

- **Search:** type a plain-language request; it runs after a 250 ms pause or on Enter, and a newer search
  cancels an older one. Filters: photos/videos/both, folder (from the picker, subfolders included), minimum
  score and number of results (up to 500). The status line shows the search time, how many items were searched
  and how many were skipped because they were indexed with another embedding model. `/` jumps to the box.
- **Browse:** every indexed photo and video, by name, folder or index date, loaded 200 at a time as you scroll.
- **Grid:** only visible rows are drawn; arrows, Page Up/Down, Home/End move, Enter opens, Escape closes.
- **Detail pane:** the caption, scene, objects and visible text (fetched only when you open an item), a large
  preview, video playback with seeking (or an 8-frame strip when the format can't play in the window, or with
  **Show frames**), **Reveal in Explorer** and **Find similar** (searches with the caption).
- **Refresh** reloads the lists; **Clear cache** deletes the thumbnail cache. Index changes made by jobs or the
  CLI (index, sort, undo) show up automatically.

How it works:
- Search uses the **same scoring as `photosort.cmd search`** (the best of the caption and visible-text matches,
  ties in index order); a test checks the two give identical results. The query is embedded by
  `qwen3-embedding:8b` through PAIR on `127.0.0.1` (same local-only guard); nothing runs on this PC's GPU.
- A private Python helper (`dashboard_sidecar.py`, started by the server, talking over a pipe, no network
  port) keeps the vectors in memory after the first search (~1 GB for 31,000 items), and rereads the index only
  when it changes. The index is opened read-only.
- Thumbnails (256 px) and previews (1,600 px) are made on this PC by up to 3 low-priority processes, as WebP
  **with all metadata removed** (no EXIF, GPS or ICC). They are cached in
  `%LOCALAPPDATA%\PhotoSort\dashboard\thumbs` (at most 3 GB, oldest removed first) and remade when a file
  changes. Videos use their own frames, decoded locally with PyAV.
- **Cloud-only OneDrive files are never downloaded:** they show "Cloud-only file". To see them, choose **Always
  keep on this device** in Explorer, then **Refresh**.
- The page sees items by opaque ids, never paths it could choose; the server only serves files that are in the
  index. Query text, captions and file names are not logged.
- **Blur** (Ctrl+Shift+B) blurs thumbnails and text, e.g. when someone is looking.

**Measured on this PC (2026-11-10):**

| Step | Time |
|---|---|
| First setup, including the npm and Electron downloads | 27.3 s |
| Setup when nothing changed | 1.1 s |
| Start | 2.5–3.7 s (target ≤ 4 s) |
| Stop | 1.3–2.9 s (target ≤ 5 s) |
| Opening the window | ~3.5 s |
| `status` | 2.4 s (PowerShell 7), 3.5 s (5.1) |
| Window self-test | 3.5–4.3 s |
| A file's progress reaching the window (CLI event to page, fixture run) | median 191 ms, p95 285 ms (target ≤ 500 ms) |
| Fixture sort preview, 50 files, fake PAIR | 1.9 s |
| `stop` while a job runs, with `-Yes` (stops the job safely first) | 1.0 s |
| Search, 31,000 synthetic items × 4,096 dimensions: first load of the list / vectors (once) | 1.7 s / 1.6 s |
| Search over those 31,000, vectors in memory (without the embedding call) | median 89 ms, p95 137 ms |
| First page of Browse (200 items, 31,000 indexed) | 0.23 s |
| Fixture search through the server, 50 items, fake PAIR (round trip) | 57 ms |
| First thumbnail (starts the worker processes) / next ones | 1.1 s / ~20 ms |

**Troubleshooting:**
- "The server did not start": read `logs\server-crash.log` or `logs\server-<date>.log` in the data folder.
- The window doesn't open or stays blank: check `.\dashboard.ps1 status`, then `logs\shell-<date>.log` (window
  events only).
- Port in use: it takes the next free port; or pass `-Port`.
- The window runs on the wrong GPU: pass `-Gpu rtx` or `-Gpu igpu`, or check Windows' graphics settings for
  `electron.exe`.
- Offline: once set up, start, stop and status need no internet. First setup needs nodejs.org, the npm
  registry and GitHub (the Electron download).
- "The dashboard is running; stop it before …" during setup: packages are never replaced while a dashboard runs.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `base_url` | `http://127.0.0.1:11434` | PAIR Ollama proxy; must be loopback |
| `model` | `gemma4:12b` | Vision model for `sort` and `group` (see below) |
| `concurrency` | `12` | Parallel requests (workers) sent to the cluster |
| `max_side` | `1024` | Images are downscaled in memory before sending; originals untouched |
| `timeout_s`, `retries` | `300`, `3` | Per-request timeout and retry count |
| `action` | `move` | Default action for `sort` and `group`: `move`, `copy` or `report` |
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

## Privacy audit

**Last audit: 2026-11-10.** It covered all PhotoSort work to date (sort, group, index and search, faces, and
videos) and found **no photo, video, frame, face or caption sent to a cloud model or service**:

- **Code:** every model request goes to `127.0.0.1:11434` only (`local_only.py`), ignores HTTP proxy settings and
  refuses cloud models. Face workers must resolve to LAN addresses (spark1 has a 192.168.x.x LAN address). A face worker
  listens on its own `127.0.0.1` only and never downloads models while tagging.
- **PAIR routing:** all 7,537 requests in the PAIR log (2026-10-28 to 2026-11-10) went to `192.168.x.x` nodes or
  to this PC (before its Ollama was turned off), and none to a public address. All of PAIR's live connections were
  LAN or loopback. The PAIR log holds no images or prompts. `cluster\members.json` still lists 10.x.x.x
  addresses for CheEv2Bb6 and ErsDvBb2. Those addresses are private, can't be reached past the home router, and
  were never used: ErsDvBb2 was served at its 192.168.x.x address.
- **Models:** none of PAIR's 30 models is a cloud model. `gemma4:12b` (8.0 GB) and `qwen3-embedding:8b`
  (4.7 GB) are full local weights.
- **Git:** the repo is private, and its history has no user media, file names, index, journal or captions.
- **Copilot CLI agent** (a cloud model): it never viewed or attached user media. The only images it saw were
  contact sheets of the public Wikimedia benchmark images, and its subagents never touched user folders. It
  did see 16 file names out of 31,253 (no image content), in tailed progress lines, error lines and
  `search --paths-only` output. Agents now keep those lines in a local log (see `AGENTS.md`).

**Since the audit, the dashboard** (see [Dashboard](#dashboard-dashboardps1)) keeps its data in
`%LOCALAPPDATA%\PhotoSort\dashboard`: state, logs without file names, job records and the window's cache. Its
server connects only to PAIR on `127.0.0.1`, and its window only to that server. Its jobs run the same
`photosort.py` with the same `local_only.py` guard, so their model requests go to PAIR on `127.0.0.1` only and
refuse cloud models (the server refuses a cloud model name before starting a job, too).
`.\dashboard.ps1 selftest -Fixture` rechecks the window's guard.

To recheck PAIR routing at any time, count requests by target. Every target should be a `192.168.x.x` node,
`cluster` (PAIR's own model list) or blank (a request that was never routed):

```powershell
Get-Content "$env:LOCALAPPDATA\NVIDIA Corporation\Personal AI Router\logs\nvpair*.jsonl" |
  Where-Object { $_ -match '"message":"ollama-proxy:proxy/request"' } |
  ForEach-Object { ($_ | ConvertFrom-Json).data.target } | Group-Object | Select-Object Count, Name
```

## Troubleshooting

- `check` fails: make sure PAIR is running on this PC and `gemma4:12b` is installed on at least one node.
  `check` also reports whether the search models (`caption_model`, `embed_model`) are available.
- `check` says `Video support: no`: install PyAV (`...\python.exe -m pip install av`). Until then videos
  are left in place. A video that can't be decoded is reported as an error and left in place.
- This PC's GPU is busy again during a run: its Ollama engine was turned back on in PAIR. Turn it off there.
- `search` says "no search index": run `index` on a folder first.
- `group` says "the request was read in different ways": the 3 readings disagreed. Reword it (say the day, e.g.
  "on Sunday 11/8"), or give `--from`/`--to` and `--media`. "the request could mean … or …": add the `--media`
  it suggests. "cannot pick out specific people": describe what the photos show instead of who is in them.
- `group` found fewer files than expected: check the report's "with no capture date" and "other dates" counts
  (the dates come from metadata, not the modified time), and preview with `--action report`.
- A `_photosort_journal-<PC name>.jsonl` file appears next to the journal: OneDrive made a conflict copy while
  a run was writing. Append its lines to `_photosort_journal.jsonl` (in time order) and delete it, so `undo`
  sees every run.
- First requests are slow (up to ~60 s): nodes are loading the model; it stays loaded for 30 min.
- A run's last few files take longer: slow nodes (e.g. the Mac-mini) finish their last request.
- PAIR quirks seen: `/api/show` through the proxy can hit a node without models (404) — PhotoSort only
  uses `/api/tags` and `/api/chat`. Nodes that served requests on 2026-11-10 (from the PAIR log): CVPRISM2,
  spark1, MinDvBb1, AxiDvBb1, ErsDvBb2, the Mac-mini and ErsDvBb1 (ErsDvDk1 served on 2026-11-09).
- Mac-mini runs different builds of `gemma4:12b`/`qwen3.5:9b`; re-pull them there for consistent results.
- `faces`: "face worker environment not found" means the host was never set up: run
  `.\photosort.cmd faces-setup HOST`. Check SSH itself with `ssh -o BatchMode=yes HOST hostname`
  (it must not prompt). If one of several workers fails, the run continues on the others and the report
  lists it as failed. Workers stop when their SSH session ends, so nothing keeps GPU memory after a run.

## Tests

```powershell
C:\Users\<you>\miniconda3\envs\utils\python.exe -m pytest -q tests   # or: python -m pytest -q tests (env activated)
```

Dashboard (after `.\dashboard.ps1 setup -Fixture -Yes`), with its private Node.js:

```powershell
cd dashboard
$env:PATH = (Get-ChildItem "$env:LOCALAPPDATA\PhotoSort\runtime\node-v*-win-x64" | Select-Object -Last 1).FullName + ";$env:PATH"
npm run typecheck; npm test; npm run build   # 50 tests, ~20 s; the build also scans the bundle for outside URLs
cd ..
.\dashboard.ps1 start -Fixture -NoOpen; .\dashboard.ps1 selftest -Fixture; .\dashboard.ps1 stop -Fixture
```

`npm test` runs the security suite, the job runner against a stand-in CLI (`server\test\fake_cli.py`), and an
end-to-end suite (`server\test\e2e.test.ts`). The end-to-end suite builds a fresh synthetic library in `%TEMP%`
(`dashboard\fixtures\make_fixtures.py`), starts `tests\fake_pair.py` (a fake PAIR on a free loopback port; no
model) and runs the real `photosort.py` through the server. It covers preview, apply, undo preview and undo for
sort and group; index and the skip on re-index; a safe stop in the middle of a move (every moved file is
journaled, none lost); and the time from a CLI event to the page (p95 ≤ 500 ms). The tests find Python through
`PHOTOSORT_PYTHON`, else `photosort.cmd`'s `PY`. `make_fixtures.py --reset` rebuilds the fixture library of
fixture mode. `server\test\gallery.test.ts` builds a synthetic indexed library
(`dashboard\fixtures\make_search_fixture.py`) and checks search, browsing, thumbnails, video ranges, live index
refresh and that forged ids and paths are refused; `tests\test_dashboard_sidecar.py` checks that cached search
equals the CLI's, metadata stripping, the cache limit and that cloud-only files are never opened. For the 31,000
item measurement: `make_search_fixture.py --out <new folder in %TEMP%> --count 31000`.
