#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"
if [[ ! -s frontend/dist/index.html ]]; then
    echo "ERROR: frontend/dist/index.html missing. Run: cd frontend && npm ci && npm run build" >&2
    exit 1
fi
if ! find frontend/dist/assets -name '*.js' -type f -print -quit | grep -q .; then
    echo "ERROR: compiled JavaScript not found in frontend/dist/assets" >&2
    exit 1
fi
check_in_compiled_js() {
    local phrase="$1"
    if ! grep -RlF --include='*.js' -- "$phrase" frontend/dist/assets | grep -q .; then
        echo "ERROR: new bundle does not contain '$phrase'. Build may be stale" >&2
        exit 1
    fi
}
check_in_compiled_js 'sunlight-duration'
check_in_compiled_js 'mission-markers'
check_in_compiled_js 'luna-help-button'
if [[ ! -s frontend/dist/mission-markers.json ]]; then
    echo 'ERROR: frontend/dist/mission-markers.json missing. Vite did not copy public/' >&2
    exit 1
fi
python3 - <<'PY'
import json
with open('backend/mission_markers.json',encoding='utf-8') as f: missions=json.load(f)
assert len(missions)>=2
assert {'planned','completed'} <= {m['status'] for m in missions}
print('Marker JSON valid:',len(missions),'records')
PY
echo 'OK: rebuilt UI, daylight route reference, markers, and help icons detected.'
