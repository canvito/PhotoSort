# PhotoSort model benchmark — NVIDIA PAIR cluster (2026-11-09)

> **Later changes.** This report is a snapshot from the first day. Since then this PC (ErsEv2Bb5) no longer
> runs models: its Ollama engine is off in PAIR. MinDvBb1, ErsDvDk1, ErsDvBb1 and ErsDvBb2 now serve
> requests. The current node list and the later measurements (videos, search indexing, `group`) are in
> [`../README.md`](../README.md).

Endpoint: local PAIR Ollama proxy `http://127.0.0.1:11434` (LAN only; remote plaintext is rejected, peers use mTLS).
Test set: 12 images (7 public stock photos + 5 synthetic screenshots), downscaled to 1024px JPEG. The images are
not committed; `bench.py` documents how to build your own labelled set.

## Nodes
| Node | Hardware | Vision models | Status |
|---|---|---|---|
| spark1 | DGX Spark GB10, 128 GB | all (25 models) | serving |
| AxiDvBb1 | RTX Spark N1X, 128 GB | 18 models | serving |
| CVPRISM2 | RTX 3090 24 GB, 64 GB RAM | gemma4:12b, qwen3.5:9b, qwen3-vl:8b-instruct | serving (fastest) |
| Canvitos-Mac-mini | Apple M4, 24 GB | gemma4:12b, qwen3.5:9b (different builds) | serving (slow) |
| ErsEv2Bb5 (this PC) | RTX 4060 Laptop 8 GB | gemma4:12b, qwen3.5:9b | serving (very slow) |
| MinDvBb1 | RTX Spark N1X, 64 GB | qwen3.5:9b, gemma4:31b, qwen3-vl:32b, qwen3.6:35b | node-info up, gets no proxy traffic |
| ErsDvBb1 | RTX 4050 Laptop 6 GB | none | PAIR misroutes /api/show here (404) |
| ErsDvBb2, ErsDvDk1, CheEv2Bb6 | — | — | offline |

## Results (think=false, JSON-schema output, temperature 0)
| Run | Model | Requests | Valid JSON | Correct | img/min | p50 s |
|---|---|---|---|---|---|---|
| cold, c=18 | gemma4:12b | 36 | 36 | 36 | 27.5 | 8.3 |
| cold, c=18 | qwen3.5:9b | 36 | 34 | 34 | 18.5 | 2.7 |
| warm, c=18 | gemma4:12b | 48 | 48 | 48 | 37.4 | 2.9 |
| warm, c=18 | qwen3.5:9b | 48 | 45 | 45 | 47.1 | 1.9 |
| warm, c=18 | qwen3.5:9b | 60 | 60 | 60 | 27.6 | 2.1 |
| sustained, c=12 | gemma4:12b | 120 | 120 | 120 | **102.5** | 2.2 |
| sustained, c=12 | qwen3.5:9b | 120 | 119 | 119 | 94.4 | 1.7 |

Traffic share (sustained gemma4:12b): CVPRISM2 47%, spark1 28%, AxiDvBb1 19%, Mac-mini 3%, this PC 3%.
qwen3.5:9b malformed (truncated) JSON traced to Mac-mini's build (digest d63f83 vs 56671c elsewhere).

## Recommendation
**gemma4:12b** — 0 malformed outputs in 205 calls, 100% correct, ~100 img/min sustained, served by 5 nodes.
Runner-up: qwen3.5:9b (slightly faster per image, but ~2-3% truncated JSON unless Mac-mini is re-pulled).

## Follow-ups
- Re-pull gemma4:12b and qwen3.5:9b on Mac-mini to match other nodes' digests.
- MinDvBb1: check PAIR/Ollama there (not in proxy routing pool since 2026-10-30).
- Don't rely on `/api/show` via proxy; use `/api/tags` or `inference-dispatcher -list-models` for capabilities.
- Re-run (utils conda env, labelled set in `images\`, see the `bench.py` docstring):
  `C:\Users\<you>\miniconda3\envs\utils\python.exe bench.py --models gemma4:12b qwen3.5:9b --repeat 10 --concurrency 12`
