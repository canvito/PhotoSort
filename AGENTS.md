# PhotoSort: agent instructions

Operator guide with full details: [`README.md`](README.md). Keep both files up to date in the same change
as any feature, config or procedure change.

## Hard rules (privacy)

- **Standing rule: no cloud model or cloud service ever reads the user's photos, screenshots or videos, or
  anything derived from them** (image bytes, video frames, faces, captions, visible text, embeddings, the
  search index). This applies to every command (`sort`, `group`, `index`, `search`, `faces`) and to you, the agent:
  do not view/attach personal images, videos or frames; when inspecting them, print numbers only. Bucket sorting, group request reading and matching, search captioning/embedding and search queries go only to the local PAIR
  Ollama proxy at `http://127.0.0.1:11434`, using models running on the user's own machines; face detection
  only to `local` or LAN SSH face workers. Never weaken or bypass the code guard (`local_only.py`): it
  refuses non-loopback endpoints and Ollama cloud models (names ending `-cloud`/`:cloud`, or listed by PAIR
  with `remote_host`/`remote_model`). If a task seems to need a cloud model, stop and ask the user.
- Training/fine-tuning may use Google Colab only with data the user explicitly provides for that; inference
  stays local. Never commit personal photos (`benchmarks/images/` and results are git-ignored).
- `sort` moves files by default. Preview with `--action report` or `--limit` when unsure; `undo` reverts.
- **No inference on this PC (ErsEv2Bb5).** Its GPU (RTX 4060 Laptop 8 GB) is weak and the PC bogs down, so the
  user turned its Ollama engine off in PAIR; the proxy on this PC still routes to the other nodes. Never turn
  it back on, never start Ollama/llama.cpp/LM Studio here, and never use `local` face workers. If this PC's
  GPU is busy during a run, tell the user.
- The search index holds descriptions of private photos. Run `search` only with `--paths-only`, and never
  read the index file (`%LOCALAPPDATA%\PhotoSort\search_index.sqlite`) or print captions. The user can run
  `search` without `--paths-only` to see captions. The index is a local, per-PC file outside the repo at
  `%LOCALAPPDATA%\PhotoSort\search_index.sqlite`; keep it out of OneDrive and git. It can be rebuilt by
  running `index` again.

## Environment

- Run from `C:\Users\<you>\Documents\GitHub\canvito\utils\PhotoSort`.
- Python: `C:\Users\<you>\miniconda3\envs\utils\python.exe` (plain `python` is the Windows Store shim).
  `.\photosort.cmd` wraps it.
- Tests: `C:\Users\<you>\miniconda3\envs\utils\python.exe -m pytest -q tests`

## Sort photos and videos into buckets

```powershell
.\photosort.cmd check                                   # PAIR proxy up, gemma4:12b available, "Video support: yes"
.\photosort.cmd sort "<folder>" --action report          # dry run
.\photosort.cmd sort "<folder>"                          # move into bucket subfolders; prints finish report with duration
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" # revert the latest run
```

When the user asks to sort a folder "with subfolders", run `sort "<root>" --recursive`: every photo and video
from every subfolder goes into one flat set of bucket folders at the root. That is what the user wants; never
create buckets inside each subfolder. Bucket folders left inside subfolders by older per-month sorts are
pulled into the root buckets too; other files stay in their subfolders. Videos go into the same buckets as
photos (the user chose this). Sort moves files without changing their bytes or re-encoding them.

Videos (PyAV decodes them on this PC; `pip install av` if `check` says `Video support: no`): sort and index
send 8 evenly spread, upright keyframes in one request (fits `num_ctx` 4096; do not raise it, PAIR nodes would
reload the model); faces checks every keyframe plus gap fill to ~1 s. Audio/speech is not used.

Report to the user: files sorted (photos, videos), errors, duration, files/min, per-bucket counts (all in the
finish report).

## Group photos and videos by a plain-language request

```powershell
.\photosort.cmd group "<folder>" "<request>" --action report   # preview; prints what it understood and counts
.\photosort.cmd group "<folder>" "<request>"                   # move matches into one group folder in <folder>
.\photosort.cmd group "<folder>" "<topic>" --from 2026-11-07 --to 2026-11-08 --media photos --name "<name>"
```

- Use it when the user asks to sort/group/gather files "by" an event, topic or day and leave everything else
  where it is (e.g. "sort group photo and video by birthday party on last Sunday"). Pass the user's words as
  the request, unchanged. Preview with `--action report` first unless the user clearly asked to move them. In
  report mode the output lists matching paths; show the user counts and the duration, and paths only if they
  ask.
- The request (the user's text, no media) is read 3 times in parallel by the local model; dates, kind of files
  and whether there is a topic must agree, or `group` stops (exit 2) with what to add. Do not retry with your own
  guess of the dates: pass the user's dates with `--from`/`--to`, or ask the user. Dates come from code-computed
  named days (`group.named_days`), not model arithmetic. Names of people are not recognized.
- Capture dates: EXIF / Apple `com.apple.quicktime.creationdate` / file name (OneDrive camera-upload names are
  UTC) / video `creation_time` last; never the modified time. A topic day runs to 4 am the next day.
- Matching: two wordings (`group.MATCH_WORDINGS`: strict "shows", then "taken at"), the second only when the
  first says no; a match if either is yes. Measured on public photos: birthday parties 22/22 found, 2 false
  matches in 110 look-alikes; one lenient wording gave 10 false matches. Do not change the wordings without
  re-measuring both found and false matches.
- Same occasion: after all files are checked, a non-matching file taken within `group.EVENT_NEAR` (10 min) of a
  match or of a file already in the group folder is asked `group.same_event_prompt` (no chaining; undated files
  are not asked). Nothing moves until both passes finish. That prompt says yes to most other events too (75/110),
  so it must stay limited to files near a match. Measured: 22/22 parties yes, 8/8 unrelated photos no, thing
  topics 7/7 targets yes and 77/77 others no. Journal entries carry `matched_by` and `near_match`.
- `group` looks in all subfolders, including bucket folders, and skips group folders (marker
  `_photosort_group.json`); `sort --recursive` skips them too. Undo with `undo` on the folder's journal.
- Report: what was understood, group folder, files scanned / in range / other dates / no capture date, checked
  (and asked about the same occasion), found (photos, videos), errors, duration, files/min (all in the finish
  report).
- OneDrive can make a `_photosort_journal-<PC>.jsonl` conflict copy while a run writes; merge its lines into the
  journal in time order and delete it.

## Search photos and videos in plain language

```powershell
.\photosort.cmd index "<folder>"                          # caption + embed, always recursive; finish report with duration
.\photosort.cmd search "<query>" --paths-only             # optional: --folder "<folder>" --top 20
```

- `index` is the slow, parallel part: 12 caption requests in flight across the PAIR nodes (`index_concurrency`,
  measured fastest; do not raise it for speed). Re-runs only process new or changed files, so after
  `sort` or new files, just run `index` again on the same folder. `sort` and `undo` keep index paths current.
  Videos are slower (8 frames per request).
- A caption reply that runs to the length limit (on some nodes gemma4 repeats a video's visible text) is redone
  with the schema's `text` field capped at 300 chars (`TEXT_CAPPED_SCHEMA`; 6/6 valid across nodes, a
  repeat penalty only 2/6). Normal requests stay uncapped so existing captions don't change. If a file still
  fails, re-running `index` retries it.
- Search is a single local embedding call (~0.05 s); it needs no cluster parallelism.
- Report from the index finish report: files found (videos), captioned, reused, unchanged, removed, errors,
  duration, files/min. For a search, give the user the paths (or the command to run themselves).

## Tag faces (InsightFace buffalo_l, reference-photo matching, no training)

Workers come from `face_workers` in `config.json` (default `["spark1:16"]`) or `--workers spark1:16,HOST2:8`
(no `local` worker: this PC is excluded from inference).
spark1 is already set up (`~/.photosort/venv`, model in `~/.insightface/models/buffalo_l`).

1. Check SSH (must not prompt): `ssh -o BatchMode=yes spark1 hostname`. If it fails, spark1 is off or
   the NVIDIA Sync SSH config is missing; ask the user. Do not fall back to a cloud service.
2. Need a people folder from the user: one subfolder per person, each image with exactly one clear face,
   e.g. `D:\PhotoSort\people\Alice\alice-1.jpg`. Ask for its path if unknown; never guess names.
3. Trial: `.\photosort.cmd faces "<folder>" --people "<people>" --recursive --limit 20`
4. Full run: same without `--limit`. Output: `<folder>\photosort_faces.json` (originals never modified).
   Video records have `type: "video"`, `frames`, `people` ({name: frames seen}) and per-face `time_s`.
   Wrong matches: raise `--threshold` (default 0.45) or `--margin` (default 0.05).
5. Report: images, videos (frames), faces, matched/unknown, errors, duration, images+frames/min, per-worker
   counts (finish report).

New worker host (Linux/macOS with SSH enabled + key alias): `.\photosort.cmd faces-setup HOST`.
"face worker environment not found" also means: run `faces-setup HOST`. Worker code is redeployed
automatically when it changes; no manual copy needed.

## Known facts (as of 2026-11-10)

- Only spark1 accepts SSH. AxiDvBb1, CVPRISM2, MinDvBb1, ErsDvBb1 have port 22 closed; the Mac-mini has
  Remote Login off. Windows workers (e.g. CVPRISM2) are not supported by the code yet.
- spark1:16 does ~3,660 images/min; the limit is this PC's gigabit link, so more workers add little.
  Video frames: ~1,060 frames/min (56 videos, 1,511 frames in 85.7 s); 4K decoding on this PC is the limit,
  done in a process pool with 1 decoder thread per process (FFmpeg frame threading made seeking slower).
  A dead process breaks the whole pool (`BrokenProcessPool`), so `_FramePool` replaces it and redoes each
  failed chunk in a process of its own; only the video that really crashes gets an error.
- Do not shrink or re-encode photos or video frames before sending them to gain speed: tested, it changes results (lost
  1–2% of faces, flipped some matches). Full-resolution results are exactly repeatable. Faster networking
  is the only speed-up the user accepts (no speed-for-accuracy trades). Video frames go as lossless PNG.
- PAIR nodes serving models: CVPRISM2 (fastest, RTX 3090; back online on 2026-11-10, it served most requests that day),
  spark1, MinDvBb1, AxiDvBb1, ErsDvBb2, the Mac-mini, ErsDvBb1 and ErsDvDk1. Without CVPRISM2 indexing ran ~27
  instead of ~75 images/min. Not this PC (Ollama off, see Hard rules). To see which node served a request, read
  the PAIR log `%LOCALAPPDATA%\NVIDIA Corporation\Personal AI Router\logs\nvpair.jsonl` (`data.path`
  `/api/chat`, `data.node_id`) and map ids to names with `cluster\members.json` (`nodeUuid`, `name`).
- PAIR cannot run InsightFace (it only routes LLM engines); that is why face workers use SSH.
- Search indexing with gemma4:12b at 12 in flight: 261 real photos in 3m 30s (74.6 images/min); ~27/min
  when the cluster is busy. 24 in flight was slower (57.1/min) and caused a truncated reply. Captions are
  ~150 tokens, so indexing is slower than sorting. `qwen3-vl:8b` returned empty/invalid JSON for captions;
  do not use it. `qwen3-embedding:8b` runs on spark1.
