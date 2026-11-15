// LUNA-DOC: Render missions from the server catalog /api/mission-markers; completed missions are red and planned missions blue.
// LUNA-DOC: Clicking a historic marker selects its coordinates and, when available, its landing_utc timestamp.
// LUNA-DOC: Unconfirmed Artemis locations are illustrative; the UI must indicate coordinate uncertainty.
import { Cartesian2, Cartesian3, Color, HeightReference, NearFarScalar } from 'cesium';

// The Flask catalogue is authoritative. /mission-markers.json is an optional
// static fallback for offline demos. No hardcoded placeholder missions remain.

// LUNA-DOC: Configure backend marker loading, marker styles, and hover/click handlers.
export function initMissionMarkers(viewer) {
    const toggle = document.getElementById('mission-markers-toggle');
    const tooltip = document.getElementById('mission-marker-popup');
    if (!tooltip) return { inspect: () => false, reload: async () => {} };
    const markers = new Map();
    let visible = toggle?.checked ?? true;
    const ellipsoid = viewer.scene.globe.ellipsoid;

    // LUNA-DOC: Safely format one field in a mission info card.
    function field(label, value) {
        if (value === undefined || value === null || value === '') return;
        const line = document.createElement('div');
        const name = document.createElement('strong');
        name.textContent = `${label}: `;
        line.append(name, document.createTextNode(String(value)));
        tooltip.append(line);
    }

    // LUNA-DOC: Display the selected mission's details without changing physical calculations.
    function showPopup(item, x, y) {
        tooltip.replaceChildren();
        tooltip.dataset.status = item.status === 'planned' ? 'planned' : 'completed';
        const heading = document.createElement('h3');
        heading.textContent = item.name;
        const badge = document.createElement('span');
        badge.className = `mission-marker-status mission-marker-status--${tooltip.dataset.status}`;
        badge.textContent = item.status === 'planned' ? 'Future / planned' : 'Historical / completed';
        tooltip.append(heading, badge);
        field('Agency', item.agency);
        field('Country', item.country === '—' ? null : item.country);
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.date || '');
        field('Date', dateMatch ? `${dateMatch[3]}.${dateMatch[2]}.${dateMatch[1]}` : item.date || 'TBD');
        // Display the actual landing moment in UTC, including seconds.
        // Planned missions have no confirmed touchdown UTC and should not inherit a made-up time.
        if (item.status === 'completed' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(item.landing_utc || '')) {
            field('Touchdown (UTC)', `${item.landing_utc.slice(11, 19)} UTC`);
        }
        field('Landing site / region', item.location);
        if (item.region) field('Planned landing band', item.region);
        field(item.approximate ? 'Illustrative marker position' : 'Landing coordinates',
            `${item.latitude.toFixed(5)}°, ${item.longitude.toFixed(5)}°`);
        field('Coordinate accuracy', item.accuracy);
        if (item.approximate) {
            const notice = document.createElement('p');
            notice.className = 'mission-marker-approximate';
            notice.textContent = 'Illustrative map placement only — no confirmed landing coordinates.';
            tooltip.append(notice);
        }
        if (item.description) {
            const p = document.createElement('p');
            p.textContent = item.description;
            tooltip.append(p);
        }
        const clickTip = document.createElement('p');
        clickTip.className = 'mission-marker-click-tip';
        clickTip.textContent = item.status === 'completed' && item.landing_utc
            ? 'Click to analyze this location at the historical touchdown date and time (UTC).'
            : 'Click this marker to analyze the location on the Moon.';
        tooltip.append(clickTip);
        if (typeof item.source_url === 'string' && item.source_url.startsWith('https://')) {
            const source = document.createElement('small');
            source.className = 'mission-marker-source';
            source.textContent = item.source_url;
            tooltip.append(source);
        }
        tooltip.hidden = false;
        const margin = 12;
        const left = Math.max(margin, Math.min(window.innerWidth - tooltip.offsetWidth - margin, x + 16));
        const top = Math.max(margin, Math.min(window.innerHeight - tooltip.offsetHeight - margin, y + 16));
        tooltip.style.left = `${left}px`;
        tooltip.style.top = `${top}px`;
    }

    // LUNA-DOC: Hide the popup when the pointer leaves a marker.
    function hide() { tooltip.hidden = true; }
    // LUNA-DOC: Find a surface marker from pointer coordinates.
    function pick(screen) {
        if (!visible || !screen) return null;
        const picked = viewer.scene.pick(new Cartesian2(screen.x, screen.y));
        const id = picked?.id?.id ?? picked?.id;
        return markers.get(id) ?? null;
    }
    // LUNA-DOC: Connect marker clicks to coordinate and landing-time selection.
    function inspect(screen, clientX, clientY) {
        const item = pick(screen);
        if (!item) { hide(); return false; }
        showPopup(item, clientX, clientY);
        return true;
    }

    // LUNA-DOC: Update Cesium entities from the server mission catalog.
    function render(records) {
        for (const item of markers.values()) viewer.entities.remove(item.entity);
        markers.clear();
        for (const record of records) {
            const latitude = Number(record.latitude);
            const longitude = Number(record.longitude);
            if (!(latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180)) continue;
            const planned = record.status === 'planned';
            const color = planned ? '#359bff' : '#f44756';
            // A small circular dot, like the native Point marker. No permanent label.
            // Anchor to Cesium terrain instead of floating 8 km above the Moon.
            const entity = viewer.entities.add({
                name: record.name || 'Lunar mission', show: visible,
                position: Cartesian3.fromDegrees(longitude, latitude, 0, ellipsoid),
                point: {
                    pixelSize: 9,
                    color: Color.fromCssColorString(color),
                    outlineColor: Color.fromCssColorString('#101720'),
                    outlineWidth: 2,
                    heightReference: HeightReference.CLAMP_TO_GROUND,
                    scaleByDistance: new NearFarScalar(1_000_000, 1.2, 24_000_000, 0.9),
                },
                properties: { lunarMissionMarker: true },
            });
            markers.set(entity.id, { ...record, latitude, longitude, entity });
        }
        viewer.scene.requestRender();
    }

    // LUNA-DOC: Fetch the read-only JSON catalog over HTTP.
    async function catalogue(url, arrayDirect = false) {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const json = await response.json();
        const list = arrayDirect ? json : json.missions;
        if (!Array.isArray(list)) throw new Error(`${url}: missions are not an array`);
        return list;
    }
    // LUNA-DOC: Clear or restore markers after a catalog request.
    async function reload() {
        let records;
        try {
            records = await catalogue('/api/mission-markers');
        } catch (apiError) {
            console.warn('Mission backend unavailable; trying static catalogue', apiError);
            try {
                records = await catalogue(`${import.meta.env.BASE_URL}mission-markers.json`, true);
            } catch (staticError) {
                console.warn('Static mission catalogue unavailable; displaying no markers', staticError);
                records = [];
            }
        }
        render(records);
        return records.length;
    }
    toggle?.addEventListener('change', () => {
        visible = toggle.checked;
        for (const item of markers.values()) item.entity.show = visible;
        hide();
        viewer.scene.requestRender();
    });
    const canvas = viewer.scene.canvas;
    canvas.addEventListener('pointermove', event => {
        if (event.buttons || event.pointerType === 'touch') { hide(); return; }
        const rect = canvas.getBoundingClientRect();
        inspect({ x: event.clientX - rect.left, y: event.clientY - rect.top }, event.clientX, event.clientY);
    });
    canvas.addEventListener('pointerleave', hide);
    viewer.camera.moveStart.addEventListener(hide);
    // Show backend/static catalogue only; never reintroduce demo missions.
    render([]);
    reload().catch(error => console.error('Mission marker refresh failed', error));
    return { inspect, pick, reload };
}
