#!/usr/bin/env bash
# Installs the PhotoSort face worker environment on a Linux/macOS LAN node.
# Run from Windows with:  photosort.cmd faces-setup HOST
# Everything goes under ~/.photosort and ~/.insightface: no sudo, no system packages. The only downloads
# are Python packages and the public InsightFace model pack; no photos are uploaded.
set -euo pipefail
MODEL="${PHOTOSORT_MODEL:-buffalo_l}"
ROOT="$HOME/.photosort"
mkdir -p "$ROOT"
command -v python3 >/dev/null || { echo "python3 is required on $(hostname)" >&2; exit 3; }
[ -x "$ROOT/venv/bin/python" ] || python3 -m venv "$ROOT/venv"
PY="$ROOT/venv/bin/python"
"$PY" -m pip install -q --upgrade pip
if command -v nvidia-smi >/dev/null 2>&1; then ORT="onnxruntime-gpu[cuda,cudnn]"; else ORT="onnxruntime"; fi
echo "$(hostname): installing $ORT, InsightFace and image libraries into $ROOT/venv ..."
"$PY" -m pip install -q "$ORT" numpy pillow pillow-heif opencv-python-headless scipy scikit-image onnx tqdm requests
# InsightFace's dependency list pulls CPU-only onnxruntime and GUI OpenCV, which conflict with the above.
"$PY" -m pip install -q --no-deps "insightface>=0.7.3"
echo "$(hostname): ensuring model pack $MODEL ..."
"$PY" -c "import sys; from insightface.utils import ensure_available; print(ensure_available('models', sys.argv[1], root='~/.insightface'))" "$MODEL"
"$PY" -c "import onnxruntime as o; print('ONNX Runtime', o.__version__, o.get_available_providers())"
