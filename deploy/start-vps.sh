#!/usr/bin/env bash
# Run from the root folder after extracting this ZIP on a Linux VPS.
set -euo pipefail
cd "$(dirname "$0")/.."
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
python backend/download_kernels.py
cd frontend
npm ci
npm run build
cd ..
echo "Ready. Launch with: .venv/bin/gunicorn --chdir backend --bind 127.0.0.1:8000 --workers 1 --threads 4 --timeout 180 calculation:app"
