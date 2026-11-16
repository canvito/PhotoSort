# PhotoSort: agent instructions

Operator guide with full details: [`README.md`](README.md). Keep both files up to date in the same change
as any feature, config or procedure change.

## Hard rules (privacy)

- **Standing rule: no cloud model or cloud service ever reads the user's photos, screenshots or videos, or
  anything derived from them** (image bytes, video frames, faces, captions, visible text, embeddings, the
  search index). This applies to every command (`sort`, `group`, `index`, `search`, `faces`, `faces-discover`) and to you, the agent:
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
  running `index` again, or brought from another PC with `index-export`/`index-import` (see Search below).
- **File names and per-file results never reach you.** On the user's folders, `sort`, `group`, `index`,
  `faces`, `faces-discover`, `apply` and `undo` log one line per file (name plus bucket, MATCH/no or error) to
  stderr, and the finish
  report goes to stdout (counts only). Send stderr to a local log outside OneDrive and the repo, and show only
  the report. For example:
  `.\photosort.cmd sort "<folder>" 2> "$env:LOCALAPPDATA\PhotoSort\logs\sort-<yyyyMMdd-HHmm>.log"`
  (create the folder first). Never tail, view or grep-print that log, journals or face sidecars. Count
  matching lines instead, e.g. `(Select-String WARNING <log>).Count`. Send `search --paths-only` output to a
  local file and report the number of results. The 2026-11-10 privacy audit found 16 file names that got to
  the agent this way; see README "Privacy audit".

## Environment

- Run from the repo root, `$env:USERPROFILE\Documents\GitHub\canvito\PhotoSort` on the user's PCs.
- Python: `$env:USERPROFILE\miniconda3\envs\utils\python.exe` (plain `python` is the Windows Store shim).
  `.\photosort.cmd` wraps it.
- Tests: `& "$env:USERPROFILE\miniconda3\envs\utils\python.exe" -m pytest -q tests`
- This repo is **public**. Never commit personal data: no photos, file names from the user's folders, captions,
  journals, face results, logs, LAN IP addresses or the Windows user name (write `C:\Users\<you>` or
  `$env:USERPROFILE` in docs). Synthetic fixtures and public test images only.

## Sort photos and videos into buckets

```powershell
.\photosort.cmd check                                   # PAIR proxy up, gemma4:12b available, "Video support: yes"
.\photosort.cmd sort "<folder>" --action report          # dry run
.\photosort.cmd sort "<folder>"                          # move into bucket subfolders; prints finish report with duration
.\photosort.cmd apply "<folder>\_photosort_journal.jsonl" # move exactly what the latest preview found (no model calls)
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" --dry-run  # what undo would move back; changes nothing
.\photosort.cmd undo "<folder>\_photosort_journal.jsonl" # revert the latest run
```

Run control (`runctl.py`): `--events FILE` and `--cancel-file FILE` go before the command and are for the
dashboard. Without them no events file is written; keep the terminal report the same either way (the finish
event carries that same report). The `sort`, `group`, `apply`, `undo` and `index` loops call
`runctl.checkpoint()` before each file, and a move plus its journal line sit in `runctl.no_interrupt()`, so
Ctrl+C or a cancel never leaves a moved file unjournaled (exit 130). Runs take a folder lock (`move` or `read`)
in `%LOCALAPPDATA%\PhotoSort\locks`; if a run refuses because of another run, tell the user rather than adding
`--force`. `apply` moves only files unchanged since the preview (size, modified time, SHA-256); changed files
stay put and the exit code is 1.

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
- `group` looks in all subfolders, including bucket folders. It skips group folders (marker
  `_photosort_group.json`) and people folders made by `faces-discover` (marker `_photosort_people.json`);
  `sort --recursive` skips both kinds, and `index` and `faces` skip people folders. After a preview, `apply` on
  the folder's journal moves exactly the previewed matches without asking the model again. Undo with `undo` on
  the folder's journal.
- Report: what was understood, group folder, files scanned / in range / other dates / no capture date, checked
  (and asked about the same occasion), found (photos, videos), errors, duration, files/min (all in the finish
  report).
- OneDrive can make a `_photosort_journal-<PC>.jsonl` conflict copy while a run writes; merge its lines into the
  journal in time order and delete it.

## Search photos and videos in plain language

```powershell
.\photosort.cmd index "<folder>"                          # caption + embed, always recursive; finish report with duration
.\photosort.cmd search "<query>" --paths-only             # optional: --folder "<folder>" --top 20
.\photosort.cmd index-export "E:\photosort-index.sqlite"  # copy the index to bring to another PC
.\photosort.cmd index-import "E:\photosort-index.sqlite" --map "<old folder>" "<folder here>" --dry-run
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
- Another PC (`index_transfer.py`): `index-export <new file>` writes a consistent snapshot (SQLite backup API);
  `index-import <file> [--map OLD NEW]... [--dry-run]` merges it in one transaction, after saving the old index
  as `search_index.before-import.sqlite`. No model, PAIR or network call. Import keeps only files that exist
  here, and gives a file with the same size and modified time (±2 s) this PC's `mtime_ns`, so the next `index`
  skips it without reading it (reading hydrates OneDrive online-only files). An entry this PC already has is
  kept unless it is out of date and the imported one matches the file. Invariants: export refuses OneDrive
  (`local_only.under_onedrive`) without `--allow-onedrive`; reports print counts and top folders (drive + 3
  levels), never file names or captions; exit 1 when no file was found (a wrong or missing `--map`).
  The export file holds captions: never read or open it, as with the index.

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

### Find the different people in a folder (`faces-discover`)

Builds the `--people` folder for `faces`: one folder of face crops per person, for the user to rename. Photos
only (videos skipped), always recursive, same workers as `faces` (spark1 over SSH; never `local`). The detector
(SCRFD) gives boxes and landmarks and Pillow does the cropping, so no vision LLM is involved.

```powershell
.\photosort.cmd faces-discover "<photos>" --people "<new folder>" --dry-run   # counts only, writes nothing
.\photosort.cmd faces-discover "<photos>" --people "<new folder>"             # --similarity 0.35 --min-photos 3 --max-per-person 16 --limit N
```

- Agent rules: run `--dry-run` first, then the real run into a folder the user named (it must be new or empty
  and separate from the photos; ask, never guess). Stderr goes to a local log as above (`cannot read <name>` lines
  hold file names: count them, never print them). Show only the stdout report (counts: photos, faces, clear
  enough, people per similarity under `Cut-offs`, crops, `May be the same person` pairs with their folder
  names, duration). **Never view, attach, list or print the crops or their names**: they are faces cut out of the
  user's photos. Count folders and files only, e.g. `(Get-ChildItem <people> -Directory).Count`.
- Calibrate `--similarity` (default 0.35, lower merges people, higher splits one person) from the `Cut-offs`
  line and the `May be the same person` hints; do not guess from the images. Changing it means a new or empty
  folder: a run never writes into a non-empty folder, so renamed folders are never overwritten. Do not
  delete or empty a people folder yourself; the user renames and prunes it.
- Each crop is sent back to a worker before it is written and kept only if it holds exactly one face, the same
  one it was cut from (cosine ≥ 0.75): `faces` (`_reference_people`) aborts a whole run when any reference
  picture has no face or more than one. The write is all or nothing, with `_photosort_people.json` written last.
  That marker keeps `sort --recursive`, `group`, `index` and `faces` away from the folder (they treat it as
  crops, not photos); do not delete it, and keep the folder outside the photos folder.
- The people folder may be inside OneDrive (the user chose that for `_faces`), and then the crops sync like the
  photos. Say so in the final message; recommend a local folder if the user would rather not sync them.
- Verify a real run with `faces` using the new folder as `--people` (`--recursive`, `--output` a local file outside
  OneDrive and the repo) and read only its finish-report counts.
- Not in the dashboard yet (CLI only). Exit codes: 0 done, 1 unreadable photos or nobody found, 2 setup or
  option error (not new or empty, inside the photos, bad value), 130 stopped.

## Dashboard (`dashboard.ps1`, phases P0–P4 done)

Plan and phases: README "Dashboard". Code: `dashboard\server` (Node.js + Fastify; jobs in `jobs.ts`, routes in
`routes.ts`, folder picker in `dirs.ts`, search/gallery routes in `gallery.ts`, its Python helper in
`sidecar.ts`, runs history in `runs.ts`, PAIR log reader in `pairlog.ts` with its routes in `cluster.ts`,
privacy checks and the connection list in `privacy.ts`, face results and worker checks in `faces.ts`, the
config editor in `settings.ts`), `dashboard_sidecar.py` and `thumbs.py` (cached search, index browsing,
metadata-free thumbnails, journal reading), `dashboard_faces.py` (face results, people folder and worker checks
for the sidecar), `dashboard\shell` (Electron window), `dashboard\web` (React SPA; pages in `web\src\pages`, grid
in `components\Gallery.tsx`, shared controls in `components\ui.tsx`), `dashboard\fixtures`, `tests\fake_pair.py`
(fixture mode; with `--pair-dir` it also writes a synthetic PAIR log and member list) and
`tests\fake_face_worker.py` (a stand-in for the InsightFace worker; fixture mode's `local` face worker).

- **Agents use fixture mode only:** `.\dashboard.ps1 <command> -Fixture -Yes`. Fixture mode has a synthetic
  library, a fake PAIR on `127.0.0.1:47617` (the server starts it and it exits with the server), its own data
  folder (`%LOCALAPPDATA%\PhotoSort\dashboard-fixture`) and port 47616. Never start, open, restart or screenshot
  real mode (no `-Fixture`); the user does that.
- In real mode, the only output you may read is `.\dashboard.ps1 status`, which shows counts and versions, no
  paths. Never read `%LOCALAPPDATA%\PhotoSort\dashboard`: its `state.json` holds the token, the logs and window
  cache are the user's, `jobs\<id>\` (`job.json`, `events.jsonl`, `stdout.txt`, `stderr.txt`) holds file names
  and per-file results, and `thumbs\` holds pictures of the user's photos. Never call the search or media API
  in real mode: results hold file names, captions and pictures. The same goes for `/api/runs` (file names),
  `/api/faces*` (people names, file names, face boxes; the face results file `photosort_faces.json` in the user's
  folders is just as private) and `folders.json`. Never read the real PAIR log beyond its structure (counts, field
  names); the Cluster page and `/api/pair/*` are fixture-only for agents.
- Pass `-Yes` whenever nobody can answer. Without it, steps that need consent are skipped and the exit code is 2;
  `stop` with a running job refuses (exit 1), and `stop -Yes` stops the job safely first.
- Smoke test after changes:
  - `setup -Fixture -Yes`, `start -Fixture -NoOpen`, `status -Fixture`, `selftest -Fixture` (9 PASS; it also
    draws all 9 pages and a run's page and fails on the error boundary, an empty page or a console error),
    `stop -Fixture`;
  - after job changes, also start a fixture sort preview through the API (token and port from the fixture
    `state.json`; folder id from `GET /api/fs/roots`), wait for `ok`, then `stop -Fixture` while one runs;
  - after search/gallery changes, run a fixture index job (`{"kind":"index","params":{"source":<dirId>}}`), then
    `GET /api/index/stats`, `POST /api/search`, a `/media/<id>/thumb?v=<revision>` and a video `/original` with
    a `Range` header; after `stop -Fixture` no `dashboard_sidecar` python may remain;
  - after faces changes, run a fixture faces job (`{"kind":"faces","params":{"source":<library id>,"people":
    <people id>,"workers":"local:2"}}`; both ids from `GET /api/fs/roots`), wait for `ok`, then
    `GET /api/faces?folder=<library id>`; after settings changes, `PUT /api/config` with `save` false returns the
    review without writing (only the fixture copy is ever written);
  - after changing `dashboard.ps1`, run it in both `pwsh` and `powershell` (5.1);
  - keep `dashboard.ps1` ASCII-only, because 5.1 reads BOM-less files as ANSI.
- Unit tests: in `dashboard\`, put the private Node.js on PATH, then run `npm run typecheck`, `npm test`
  (including `server\test\e2e.test.ts` with the real CLI and `fake_pair.py`) and `npm run build`
  (README "Tests"). Python is found through `PHOTOSORT_PYTHON`, else `photosort.cmd`. The fixture and CLI tests
  are in pytest. `server\test\fixture-window.test.ts` builds the current UI and uses a separate fixture Electron
  window with empty synthetic folders and mocked index replies; it never attaches to the user's window. It also
  fails when a page has a control with no accessible name, so give every new control a label or an `aria-label`.
- Invariants, all tested:
  - only `server\src\localfetch.ts` opens connections: loopback, read-only PAIR paths, cloud models refused;
  - every route declares an auth class;
  - request bodies with unknown fields are refused (ajv `removeAdditional:false`); each job kind has a strict
    parameter schema, folders travel as ids from the picker, and a cloud model name is refused;
  - the folder picker lives inside job forms: its pasted-path row must not be a nested form. Go is a
    non-submit button, and Enter is handled locally; neither may submit the surrounding job form;
  - `api()` in `web\src\api.ts` never turns a cancelled or unreadable 2xx reply into data (it rethrows the
    abort, or raises `ApiError`), and `usePoll` ignores replies to cancelled requests; pages render inside
    `PageErrorBoundary`, so a page that fails to draw shows a message instead of blanking the window;
  - the built web app holds no outside URLs;
  - jobs run `photosort.py` with `--events` and `--cancel-file`, detached, output to files, no shell; one heavy
    job at a time; a cancel is a request, and a forced stop is allowed only 10 s later;
  - a stopped move job leaves exactly one journal line per moved file (e2e test);
  - dashboard search scores exactly like `photosort.cmd search` (shared `score_vectors`; pytest compares them);
  - media are reached only by HMAC ids of indexed rows, never by a path from the page; the sidecar opens the
    index read-only, never opens cloud-only (placeholder) files, writes thumbnails without metadata, and logs
    no query text, captions or paths (its stderr is discarded);
  - on Windows the sidecar reads requests from a duplicate of stdin and points fd 0 at NUL: spawning the
    thumbnail processes otherwise hangs while a read is pending on the stdin pipe;
  - the PAIR log is only read (`pairlog.ts` opens no connection); folder ids and run keys (`d_<id>~<runId>`)
    last one server session, so the UI treats a 404 as "reload the list"; `/api/privacy/connections` passes only
    validated integer pids to PowerShell;
  - settings: `PUT /api/config` takes only `config`, `etag` and `save`; cloud model names are refused even when
    typed (`isCloudModel`); a change is validated by `dashboard_sidecar.py --check-config` (the CLI's own
    `config_problems()` plus stricter bucket-name checks); a stale `etag` gets 409; a save copies
    `config.json.bak`, writes a temp file and renames it, keeps the file's line endings and restarts only the
    sidecar; fixture mode edits a copy and locks `base_url` and `index_path`;
  - faces: results are read only from `photosort_faces.json` in a registered folder, with the same HMAC media
    ids as the index; a worker check only runs `test -x` over SSH after the LAN-only check and sends no media;
    fixture mode runs only the `local` stand-in worker, refuses `faces-setup`, and a job never inherits
    `PHOTOSORT_FACE_WORKER` from the environment;
  - every control has an accessible name (the form `Field` in `web\src\components\ui.tsx` links its label; a
    control on its own needs `aria-label`), each page has one `main` and one `h1`, and the light theme's text
    colors keep 4.5:1 contrast; the fixture-window test checks the names and landmarks on all 9 pages.
  Never loosen the CSP, the window's request guard or the token handling. Do not add a browser shell (Edge or
  any browser as a fallback window) without asking: it can't block its own cloud features, and it needs a second
  sign-in path to the server (README "Not built: Edge as a fallback window").
- Stop processes only through `dashboard.ps1 stop` (`-Force` if needed) or a job's cancel. They end only process
  ids they have verified; never stop node, electron or python by name.
- Electron facts:
  - the ESM entry must not top-level-await `app.whenReady()`, or the window hangs before `ready`;
  - Chromium's `force_*_gpu` switches do nothing on Windows; the GPU comes from the per-app preference
    `dashboard.ps1` writes (README "Graphics");
  - this PC: NVIDIA RTX 4060 on AC, Intel Iris Xe on battery. That is drawing only, not inference.

## Project website (`site\`, https://PhotoSort.canvo.com/)

- Static page published by `.github\workflows\pages.yml` on push to `main` (README "Website"). Keep it in step
  with README when features, requirements or measured numbers change.
- It lives on its own subdomain (Pages custom domain `PhotoSort.canvo.com`, DNS CNAME `photosort`). Never move it back under
  `canvo.com/PhotoSort/`: that is the same browser origin as the owner's journal at `canvo.com`.
- It is public: never put the user's photos, screenshots of the real dashboard, file names, LAN addresses or
  machine names on it. Illustrations must be drawn (CSS/SVG) or come from fixture mode or public images.
- Keep it script-free with no outside requests except links (the page's CSP allows only its own CSS and images).
  Preview on `127.0.0.1` (README "Website"); after pushing, check the Pages run and a `HEAD` of the live URL.

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
