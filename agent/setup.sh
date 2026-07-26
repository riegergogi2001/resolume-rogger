#!/bin/bash
# One-shot setup for the ROGGER AI VJ agent sidecar (macOS).
# Verified working combo: Python 3.11 + BeatNet 1.1.1 + madmom git master
# + torch/librosa/pyaudio on numpy 2.x.
set -euo pipefail
cd "$(dirname "$0")"

PY=python3.11
command -v "$PY" >/dev/null || { echo "python3.11 required (brew install python@3.11)"; exit 1; }
command -v brew >/dev/null && ! brew list --versions portaudio >/dev/null 2>&1 && brew install portaudio

[ -d .venv ] || "$PY" -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install cython numpy sounddevice
pip install BeatNet librosa pyaudio
pip install --no-build-isolation "git+https://github.com/CPJKU/madmom.git"

python -c "from BeatNet.BeatNet import BeatNet; print('BeatNet OK')" \
  || echo "BeatNet unavailable — the sidecar will use its DSP fallback."
echo "done. run:  source .venv/bin/activate && python3 rogger_agent.py --list-devices"
