#!/usr/bin/env python3
# LUNA-DOC: Static self-check of the release structure without launching Flask or Cesium.
# LUNA-DOC: This does NOT replace npm run build, HTTP API checks, or browser interaction tests.
"""Static QA of the LUNA Spiculum mission release; no dependencies beyond stdlib."""
import ast
import json
import pathlib
import re
import sys

root = pathlib.Path(__file__).resolve().parent
frontend = root / 'frontend'
backend = root / 'backend'
check = lambda condition, why: condition or (_ for _ in ()).throw(AssertionError(why))

catalogue = json.loads((backend / 'mission_markers.json').read_text(encoding='utf-8'))
static = json.loads((frontend / 'public/mission-markers.json').read_text(encoding='utf-8'))
check(catalogue == static, 'backend and frontend catalogues differ')
check(len(catalogue) == 9, 'expected nine missions')
check(len({x['id'] for x in catalogue}) == len(catalogue), 'duplicate mission ids')
for mission in catalogue:
    check(mission['status'] in ('completed', 'planned'), mission['id'] + ' status')
    check(-90 <= mission['latitude'] <= 90 and -180 <= mission['longitude'] <= 180, mission['id']+' coords')
    if mission['status'] == 'planned':
        check(mission.get('approximate') is True, mission['id']+' must be marked approximate')
check(sum(x['status'] == 'completed' for x in catalogue) == 6, 'six Apollo required')
check(sum(x['status'] == 'planned' for x in catalogue) == 3, 'three Artemis required')

html = (frontend / 'index.html').read_text(encoding='utf-8')
check(html.count('class="luna-team-card"') == 6, 'six team cards required')
check('id="point-continuous-sunlight"' not in html and 'id="zone-continuous-sunlight"' not in html, 'old daylight cards remain')
check('luna-logo.svg' in html and 'luna-favicon.svg' in html, 'SVG not linked in HTML')
for svg in ('luna-logo.svg', 'luna-favicon.svg'):
    check((frontend / 'public' / svg).is_file(), 'missing '+svg)
    check('<svg' in (frontend / 'public' / svg).read_text(encoding='utf-8'), 'invalid SVG '+svg)

js = (frontend / 'js/cesium.js').read_text(encoding='utf-8')
check('setPoint(mission.latitude, mission.longitude)' in js, 'mission click does not set point')
js = (frontend / 'js/mission-markers.js').read_text(encoding='utf-8')
check('function pick(screen)' in js and 'return { inspect, pick, reload }' in js, 'marker pick interface absent')
check('future-demo' not in js and 'DEMO_MARKERS' not in js, 'old demo markers remain')
check('sunlight-duration' not in (frontend / 'js/script.js').read_text(), 'obsolete daylight requests remain')
check('sunlight_duration_summary' not in (backend / 'calculation.py').read_text(), 'obsolete daylight endpoint remains')
for p in backend.glob('*.py'):
    ast.parse(p.read_text(encoding='utf-8'), filename=str(p))
print('PASS: 9 missions (6 Apollo + 3 Artemis), two SVGs, 6 team cards, same data, click selection, no extra daylight feature, Python syntax.')
print('IMPORTANT: this is static verification; run npm ci && npm run build and browser tests on the server.')
