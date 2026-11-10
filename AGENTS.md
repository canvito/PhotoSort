# PhotoSort: agent instructions

Operator guide with full details: [`README.md`](README.md). Keep both files up to date in the same change
as any feature, config or procedure change.

## Hard rules (privacy)

- **Standing rule: no cloud model or cloud service ever reads the user's photos or screenshots, or anything
  derived from them** (image bytes, faces, captions, visible text, embeddings, the search index). This
  applies to every command (`sort`, `index`, `search`, `faces`) and to you, the agent: do not view/attach
  personal images. Bucket sorting, search captioning/embedding and search queries go only to the local PAIR
  Ollama proxy at `http://127.0.0.1:11434`, using models running on the user's own machines; face detection
  only to `local` or LAN SSH face workers. Never weaken or bypass the code guard (`local_only.py`): it
  refuses non-loopback endpoints and Ollama cloud models (names ending `-cloud`/`:cloud`, or listed by PAIR
  with `remote_host`/`remote_model`). If a task seems to need a cloud model, stop and ask the user.
- Training/fine-tuning may use Google Colab only with data the user explicitly provides for that; inference
  stays local. Never commit personal photos (`benchmarks/images/` and results are git-ignored).
- `sort` moves files by default. Preview with `--action report` or `--limit` when unsure; `undo` reverts.
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

## Sort photos into buckets

```powershell
.\photosort.cmd check                                   # PAIR proxy up, gemma4:12b available
.\photosort.cmd sort "<folder>" --action report          # dry run
.\photosort.cmd sort "<folder>"                          # move into bucket subfolders; prints finish report with duration
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" # revert the latest run
```

When the user asks to sort a folder "with subfolders", run `sort "<root>" --recursive`: every image from
every subfolder goes into one flat set of bucket folders at the root. That is what the user wants; never
create buckets inside each subfolder. Bucket folders left inside subfolders by older per-month sorts are
pulled into the root buckets too, and videos stay in their subfolders. Sort moves files without changing
image bytes or re-encoding them.

Report to the user: images sorted, errors, duration, images/min, per-bucket counts (all in the finish report).

## Search photos in plain language

```powershell
.\photosort.cmd index "<folder>"                          # caption + embed, always recursive; finish report with duration
.\photosort.cmd search "<query>" --paths-only             # optional: --folder "<folder>" --top 20
```

- `index` is the slow, parallel part: 12 caption requests in flight across the PAIR nodes (`index_concurrency`,
  measured fastest; do not raise it for speed). Re-runs only process new or changed photos, so after
  `sort` or new photos, just run `index` again on the same folder. `sort` and `undo` keep index paths current.
- Search is a single local embedding call (~0.05 s); it needs no cluster parallelism.
- Report from the index finish report: images found, captioned, reused, unchanged, removed, errors,
  duration, images/min. For a search, give the user the paths (or the command to run themselves).

## Tag faces (InsightFace buffalo_l, reference-photo matching, no training)

Workers come from `face_workers` in `config.json` (default `["spark1:16"]`) or `--workers spark1:16,local:2`.
spark1 is already set up (`~/.photosort/venv`, model in `~/.insightface/models/buffalo_l`).

1. Check SSH (must not prompt): `ssh -o BatchMode=yes spark1 hostname`. If it fails, spark1 is off or
   the NVIDIA Sync SSH config is missing; ask the user. Do not fall back to a cloud service.
2. Need a people folder from the user: one subfolder per person, each image with exactly one clear face,
   e.g. `D:\PhotoSort\people\Alice\alice-1.jpg`. Ask for its path if unknown; never guess names.
3. Trial: `.\photosort.cmd faces "<folder>" --people "<people>" --recursive --limit 20`
4. Full run: same without `--limit`. Output: `<folder>\photosort_faces.json` (originals never modified).
   Wrong matches: raise `--threshold` (default 0.45) or `--margin` (default 0.05).
5. Report: images, faces, matched/unknown, errors, duration, images/min, per-worker counts (finish report).

New worker host (Linux/macOS with SSH enabled + key alias): `.\photosort.cmd faces-setup HOST`.
"face worker environment not found" also means: run `faces-setup HOST`. Worker code is redeployed
automatically when it changes; no manual copy needed.

## Known facts (2026-11-09)

- Only spark1 accepts SSH. AxiDvBb1, CVPRISM2, MinDvBb1, ErsDvBb1 have port 22 closed; the Mac-mini has
  Remote Login off. Windows workers (e.g. CVPRISM2) are not supported by the code yet.
- spark1:16 does ~3,660 images/min; the limit is this PC's gigabit link, so more workers add little.
- Do not shrink or re-encode photos before sending them to gain speed: tested, it changes results (lost
  1–2% of faces, flipped some matches). Full-resolution results are exactly repeatable. Faster networking
  is the only speed-up the user accepts (no speed-for-accuracy trades).
- PAIR cannot run InsightFace (it only routes LLM engines); that is why face workers use SSH.
- Search indexing with gemma4:12b at 12 in flight: 261 real photos in 3m 30s (74.6 images/min); ~27/min
  when the cluster is busy. 24 in flight was slower (57.1/min) and caused a truncated reply. Captions are
  ~150 tokens, so indexing is slower than sorting. `qwen3-vl:8b` returned empty/invalid JSON for captions;
  do not use it. `qwen3-embedding:8b` runs on spark1.
