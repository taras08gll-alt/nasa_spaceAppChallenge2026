// LUNA-DOC: Zone data: colored metric raster, frame cache, backend requests, and point selection within the zone.
// LUNA-DOC: Missing or invalid samples must not be interpreted as zero temperature or zero elevation.
// LUNA-DOC: Dynamic metrics change over time; static DEM and slope fields do not need animation.
import { Rectangle, SingleTileImageryProvider } from 'cesium';

const radians = Math.PI / 180;
// LUNA-DOC: The longitude helper normalizes longitude values; verify call sites before editing it.
const longitude = value => ((value + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
// LUNA-DOC: The clamp helper constrains values; verify call sites before editing it.
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
const percentRange = [0, 100];
const metrics = {
    temperature_c: { label: 'Temperature', unit: '°C', range: [-250, 135] },
    irradiance_w_m2: { label: 'Solar irradiance', unit: 'W/m²', range: [0, 1500] },
    sun_visible_percent: { label: 'Visible Sun', unit: '%', range: percentRange },
    terrain_elevation_m: { label: 'Elevation', unit: 'm', range: [-11_000, 11_000] },
    terrain_slope_deg: { label: 'Slope', unit: '°', range: [0, 90] },
    sun_elevation_deg: { label: 'Sun elevation', unit: '°', range: [-90, 90] },
    sun_above_horizon_percent: { label: 'Solar disk above horizon', unit: '%', range: percentRange },
    sun_blocked_by_earth_percent: { label: 'Solar disk obscured by Earth', unit: '%', range: percentRange },
    dose_rate_usv_h: { label: 'Estimated radiation dose rate', unit: 'µSv/h', range: [45, 52] },
    link_margin_db: { label: 'Earth link margin', unit: 'dB', range: [-2, 3] },
    panel_tilt_deg: { label: 'Optimal solar panel tilt', unit: '°', range: [0, 90] },
};
const advancedMetrics = Object.keys(metrics).slice(5);
const staticMetrics = new Set(['terrain_elevation_m', 'terrain_slope_deg']);
const palette = [
    { percent: 0, rgb: [52, 26, 242] },
    { percent: 17, rgb: [0, 74, 255] },
    { percent: 34, rgb: [0, 158, 255] },
    { percent: 49, rgb: [0, 232, 255] },
    { percent: 61, rgb: [0, 234, 116] },
    { percent: 72, rgb: [242, 249, 0] },
    { percent: 86, rgb: [255, 128, 0] },
    { percent: 100, rgb: [247, 16, 43] },
];
const overlayAlpha = 0.6 * 255;
const colourStops = palette.map(({ percent, rgb }) => `rgb(${rgb.join(',')}) ${percent}%`).join(', ');

const paletteSteps = 256;
const colourLookup = Array.from({ length: paletteSteps + 1 }, (_, step) => {
    const percent = (100 * step) / paletteSteps;
    const last = palette.findIndex((stop, index) => index > 0 && percent <= stop.percent);
    const [start, end] = [palette[last - 1], palette[last]];
    const weight = (percent - start.percent) / (end.percent - start.percent);
    return start.rgb.map((component, channel) => component * (1 - weight) + end.rgb[channel] * weight);
});

// LUNA-DOC: Determine zone orientation relative to its center.
function centerAngles(data) {
    const latitude = data.center.lat * radians;
    return { longitude: data.center.lon * radians, sin: Math.sin(latitude), cos: Math.cos(latitude) };
}

// LUNA-DOC: Choose geodesic zone sample nodes for display.
function sampleZone(data, field, center, lat, lon) {
    const dLon = lon - center.longitude;
    return projectSample(data, field, center,
        Math.sin(lat), Math.cos(lat), Math.sin(dLon), Math.cos(dLon));
}

// LUNA-DOC: Project a single zone node onto the raster plane.
function projectSample(data, field, center, sinLat, cosLat, sinDLon, cosDLon) {
    const east = cosLat * sinDLon;
    const north = center.cos * sinLat - center.sin * cosLat * cosDLon;
    const up = center.sin * sinLat + center.cos * cosLat * cosDLon;
    const sinDistance = Math.hypot(east, north);
    const distance = data.moon_radius_m * Math.atan2(sinDistance, up);
    if (distance > data.radius_m) return null;
    const scale = sinDistance > 1e-12 ? distance / sinDistance : data.moon_radius_m;
    const edge = data.grid_size - 1;
    const column = clamp(edge / 2 + east * scale / data.step_m, 0, edge);
    const row = clamp(edge / 2 - north * scale / data.step_m, 0, edge);
    const x = Math.floor(column);
    const y = Math.floor(row);
    const right = Math.min(x + 1, edge);
    const bottom = Math.min(y + 1, edge);
    const dx = column - x;
    const dy = row - y;
    const values = field.values;
    const width = data.grid_size;
    const nw = values[y * width + x];
    const ne = values[y * width + right];
    const sw = values[bottom * width + x];
    const se = values[bottom * width + right];
    const wNW = nw === null ? 0 : (1 - dx) * (1 - dy);
    const wNE = ne === null ? 0 : dx * (1 - dy);
    const wSW = sw === null ? 0 : (1 - dx) * dy;
    const wSE = se === null ? 0 : dx * dy;
    const total = wNW + wNE + wSW + wSE;
    const sum = nw * wNW + ne * wNE + sw * wSW + se * wSE;
    return total > 1e-10 ? sum / total : null;
}

// LUNA-DOC: Calculate the geographic bounds of the zone.
function coverZone(data) {
    const lat = data.center.lat * radians;
    const lon = data.center.lon * radians;
    const angularRadius = data.radius_m / data.moon_radius_m;
    const south = Math.max(-Math.PI / 2, lat - angularRadius);
    const north = Math.min(Math.PI / 2, lat + angularRadius);
    if (Math.abs(lat) + angularRadius >= Math.PI / 2) {
        return [
            new Rectangle(-Math.PI, south, 0, north),
            new Rectangle(0, south, Math.PI, north),
        ];
    }
    const delta = Math.asin(clamp(Math.sin(angularRadius) / Math.cos(lat), -1, 1));
    const west = longitude(lon - delta);
    const east = longitude(lon + delta);
    return east < west
        ? [new Rectangle(west, south, Math.PI, north), new Rectangle(-Math.PI, south, east, north)]
            .filter(rectangle => rectangle.width > 1e-14)
        : [new Rectangle(west, south, east, north)];
}

// LUNA-DOC: Render a colored raster from API values.
function renderRaster(data, field, center, rectangle, range) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = Math.max(192, Math.min(384, data.grid_size * 3));
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);
    const [lower, upper] = range;
    const colourStep = paletteSteps / (upper - lower);
    const sinLongitude = new Float64Array(canvas.width);
    const cosLongitude = new Float64Array(canvas.width);
    for (let x = 0; x < canvas.width; x++) {
        const dLon = rectangle.west + (x + 0.5) * rectangle.width / canvas.width - center.longitude;
        sinLongitude[x] = Math.sin(dLon);
        cosLongitude[x] = Math.cos(dLon);
    }
    for (let y = 0; y < canvas.height; y++) {
        const lat = rectangle.north - (y + 0.5) * rectangle.height / canvas.height;
        const sinLat = Math.sin(lat);
        const cosLat = Math.cos(lat);
        for (let x = 0; x < canvas.width; x++) {
            const sample = projectSample(data, field, center, sinLat, cosLat, sinLongitude[x], cosLongitude[x]);
            if (sample === null) continue;
            const index = 4 * (y * canvas.width + x);
            const colourIndex = clamp(Math.round((sample - lower) * colourStep), 0, paletteSteps);
            const [red, green, blue] = colourLookup[colourIndex];
            image.data[index] = red;
            image.data[index + 1] = green;
            image.data[index + 2] = blue;
            image.data[index + 3] = overlayAlpha;
        }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
}

// LUNA-DOC: Format a numeric value with its units.
function formatted(value, metric, field) {
    // Keep within-zone differences legible when a close-up spans a fraction of a unit.
    const span = field.max - field.min;
    const decimals = span > 0 ? clamp(1 - Math.floor(Math.log10(span)), 2, 6) : 2;
    return `${value.toLocaleString('en-GB', { maximumFractionDigits: decimals })} ${metrics[metric].unit}`;
}

// LUNA-DOC: Prepare an HTTP request for the entire zone calculation.
function requestZone({ lat, lon, radius_m }, utc, metric, signal) {
    return fetch('/api/get_data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'zone', lat, lon, radius_m, utc, metric }),
        signal,
    });
}

// LUNA-DOC: Read, validate, and unpack a zone API response.
async function readZoneResponse(response) {
    if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new Error(`Zone request failed (HTTP ${response.status}).`);
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Zone data unavailable.');
    return result;
}

// LUNA-DOC: Main controller for zone sampling in the lunar scene.
export function initLunarZone(viewer, ellipsoid, pickSurface, setOutlineVisible) {
    const { scene } = viewer;
    const preloadAncestors = scene.globe.preloadAncestors;
    const controls = document.getElementById('zone-map-controls');
    const toggle = document.getElementById('zone-toggle');
    const select = document.getElementById('zone-map-metric');
    const legend = document.getElementById('zone-map-legend');
    const scaleBar = legend.querySelector('.zone-map-scale');
    scaleBar.style.backgroundImage = `linear-gradient(to right, ${colourStops})`;
    const min = document.getElementById('zone-map-min');
    const max = document.getElementById('zone-map-max');
    const status = document.getElementById('zone-map-status');
    const probe = document.getElementById('zone-probe');
    const probeValue = document.getElementById('zone-probe-value');
    const probeCoordinates = document.getElementById('zone-probe-coordinates');
    const resultsTitle = document.getElementById('results-title');
    const pointResults = document.getElementById('point-results');
    const zoneResults = document.getElementById('zone-results');
    const resultsTime = document.getElementById('zone-result-time');
    const average = document.getElementById('zone-average');
    const metricOutput = document.getElementById('zone-result-metric');
    const advanced = document.getElementById('advanced-mode');
    const details = document.getElementById('zone-map-details');
    const meanOutput = document.getElementById('zone-map-mean');
    const samplesOutput = document.getElementById('zone-map-samples');
    const rangeOutput = document.getElementById('zone-map-range');
    const areaOutput = document.getElementById('zone-map-area');
    const spacingOutput = document.getElementById('zone-map-spacing');
    const coverageOutput = document.getElementById('zone-map-coverage');

    let utc;
    let selection;
    let map;
    let controller;
    let timer;
    const cachedMaps = new Map();
    let layers = [];
    let requestVersion = 0;
    let pendingPointer;
    let pointerFrame;

    // LUNA-DOC: Clear the previous raster and supporting layers.
    function removeLayers() {
        if (!layers.length) return;
        for (const layer of layers) viewer.imageryLayers.remove(layer);
        layers = [];
        scene.globe.preloadAncestors = preloadAncestors;
        scene.requestRender();
    }

    // LUNA-DOC: Display zone loading or error state.
    function showStatus(text, { error = false, loading = false } = {}) {
        status.textContent = text;
        status.dataset.error = String(error);
        status.dataset.loading = String(loading);
    }

    // LUNA-DOC: Display the UTC timestamp used to calculate the zone.
    function showResultTime(text, loading = false) {
        if (resultsTime.textContent !== text) resultsTime.textContent = text;
        resultsTime.dataset.loading = String(loading);
    }

    // LUNA-DOC: Map global timeline time to zone-specific time.
    function mapTime(data, metric) {
        return staticMetrics.has(metric) ? 'Independent of time' : `${dateTime.format(new Date(data.utc))} UTC`;
    }

    // LUNA-DOC: Enable additional zone fields and modes.
    function setAdvanced() {
        if (advanced.checked) {
            for (const key of advancedMetrics) {
                const { label, unit } = metrics[key];
                select.append(new Option(`${label} (${unit})`, key));
            }
        } else {
            const fallback = advancedMetrics.includes(select.value);
            for (const option of Array.from(select.options)) {
                if (advancedMetrics.includes(option.value)) option.remove();
            }
            if (fallback) refresh(0);
        }
        details.hidden = !advanced.checked || !map;
        probeCoordinates.hidden = !advanced.checked;
    }

    // LUNA-DOC: Remove the selected zone-pixel indicator.
    function clearProbe() {
        if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
        pointerFrame = undefined;
        pendingPointer = undefined;
        probe.hidden = true;
    }

    // LUNA-DOC: Update the legend and description from the retrieved field.
    function updateMapInfo(data, metric, field) {
        const { label, unit, range } = metrics[metric];
        const hasSamples = field.valid_samples > 0;
        legend.hidden = !hasSamples;
        details.hidden = !advanced.checked;
        average.hidden = false;
        metricOutput.textContent = `Area average · ${label}`;
        meanOutput.textContent = hasSamples ? formatted(field.mean, metric, field) : '—';
        samplesOutput.textContent = `${number.format(field.valid_samples)} / ${number.format(data.samples)}`;
        const radiusKm = data.moon_radius_m / 1000;
        const area = 4 * Math.PI * (radiusKm * Math.sin(data.radius_m / (2 * data.moon_radius_m))) ** 2;
        areaOutput.textContent = `${area < 0.01 ? '< 0.01' : number.format(area)} km²`;
        spacingOutput.textContent = `${number.format(data.step_m)} m`;
        coverageOutput.textContent = `${number.format(data.terrain_coverage * 100)} %`;
        const resolution = `Grid ${number.format(data.step_m)} m`;
        status.title = mapTime(data, metric);
        showResultTime(hasSamples ? status.title : 'No data for this parameter in the selected zone.');
        if (!hasSamples) {
            rangeOutput.textContent = '—';
            showStatus(`No ${label.toLowerCase()} data inside this zone.`);
            return;
        }
        showStatus(resolution + (data.dem ? '' : ' · smooth terrain'));
        min.textContent = `${number.format(range[0])} ${unit}`;
        max.textContent = `${number.format(range[1])} ${unit}`;
        const localMin = formatted(field.min, metric, field);
        rangeOutput.textContent = field.min === field.max
            ? localMin
            : `${localMin} – ${formatted(field.max, metric, field)}`;
    }

    // LUNA-DOC: Build a colored map from the calculated grid.
    async function createMap(data, metric) {
        const field = data.fields?.[metric];
        if (!field) throw new Error('Zone data unavailable for the selected parameter.');
        const center = centerAngles(data);
        const providers = field.valid_samples
            ? await Promise.all(coverZone(data).map(rectangle => {
                const canvas = renderRaster(data, field, center, rectangle, metrics[metric].range);
                return new Promise((resolve, reject) => {
                    canvas.toBlob(blob => {
                        if (!blob) {
                            reject(new Error('Could not encode the zone map.'));
                            return;
                        }
                        const url = URL.createObjectURL(blob);
                        SingleTileImageryProvider.fromUrl(url, { rectangle, ellipsoid })
                            .then(resolve, reject)
                            .finally(() => URL.revokeObjectURL(url));
                    });
                });
            }))
            : [];
        return { data, field, center, metric, providers };
    }

    // LUNA-DOC: Display the prepared raster on the Moon's surface.
    function showMap(nextMap) {
        removeLayers();
        map = nextMap;
        const { data, field, metric, providers } = map;
        layers = providers.map(provider => viewer.imageryLayers.addImageryProvider(provider));
        // Load the zone texture on fallback terrain tiles while the finer tiles are loading.
        if (layers.length) scene.globe.preloadAncestors = true;
        updateMapInfo(data, metric, field);
        scene.requestRender();
    }

    // LUNA-DOC: Keep the map synchronized with zone, time, and metric selections.
    function refresh(delay = 180, { keepMap = false } = {}) {
        const version = ++requestVersion;
        clearTimeout(timer);
        controller?.abort();
        status.removeAttribute('title');
        const canLoad = toggle.checked && utc && selection;
        const retainMap = Boolean(canLoad && keepMap && map);
        const metric = select.value;
        select.disabled = !toggle.checked;
        setOutlineVisible(Boolean(toggle.checked && selection));
        clearProbe();
        if (!retainMap) {
            map = undefined;
            legend.hidden = details.hidden = average.hidden = true;
            removeLayers();
        }
        if (!canLoad) {
            const message = !toggle.checked ? 'Zone hidden.' : selection ? 'Select a valid time.' : 'Choose the centre of the zone.';
            showStatus(message);
            showResultTime(message);
            return;
        }
        const { lat, lon, radius_m } = selection;
        const key = JSON.stringify([lat, lon, radius_m, metric, staticMetrics.has(metric) ? null : utc]);
        const cached = cachedMaps.get(key);
        if (cached) {
            cachedMaps.delete(key);
            cachedMaps.set(key, cached);
            showMap(cached);
            return;
        }
        showStatus('Calculating the zone…', { loading: true });
        showResultTime(retainMap ? `Updating… · ${mapTime(map.data, map.metric)}` : 'Calculating zone average…', true);
        timer = setTimeout(() => loadZone(version, metric, key, 0), delay);
    }

    // LUNA-DOC: Load a new frame asynchronously from the API and handle HTTP 429 or cancellation.
    async function loadZone(version, metric, key, retries) {
        if (version !== requestVersion) return;
        const request = new AbortController();
        controller = request;
        try {
            const response = await requestZone(selection, utc, metric, request.signal);
            if (request.signal.aborted || version !== requestVersion) return;
            if (response.status === 429 && retries < 12) {
                const retryDelay = Math.min(750, 250 * (retries + 1));
                timer = setTimeout(() => loadZone(version, metric, key, retries + 1), retryDelay);
                return;
            }
            const result = await readZoneResponse(response);
            if (request.signal.aborted || version !== requestVersion) return;
            const nextMap = await createMap(result, metric);
            if (request.signal.aborted || version !== requestVersion) return;
            cachedMaps.delete(key);
            cachedMaps.set(key, nextMap);
            if (cachedMaps.size > 8) cachedMaps.delete(cachedMaps.keys().next().value);
            showMap(nextMap);
        } catch (error) {
            if (!request.signal.aborted && version === requestVersion) {
                showStatus(error.message, { error: true });
                showResultTime(map ? `Update failed · ${mapTime(map.data, map.metric)}` : error.message);
            }
        } finally {
            if (controller === request) controller = undefined;
        }
    }

    // LUNA-DOC: Check whether zone grid values can be read.
    function canInspect() {
        return map && layers.length && map.metric === select.value
            && (staticMetrics.has(map.metric) || Date.parse(map.data.utc) === Date.parse(utc));
    }

    // LUNA-DOC: Display a probe point inside the zone.
    function placeProbe(clientX, clientY) {
        const edge = 8;
        const offset = 14;
        const { clientWidth, clientHeight } = document.documentElement;
        const maxX = clientWidth - probe.offsetWidth - edge;
        const maxY = clientHeight - probe.offsetHeight - edge;
        const x = clientX + offset <= maxX ? clientX + offset : clientX - probe.offsetWidth - offset;
        const y = clientY + offset <= maxY ? clientY + offset : clientY - probe.offsetHeight - offset;
        probe.style.transform = `translate(${clamp(x, edge, maxX)}px, ${clamp(y, edge, maxY)}px)`;
    }

    // LUNA-DOC: Return sample data for a point clicked inside the zone.
    function inspect(position) {
        const hit = canInspect() && pickSurface(position);
        if (hit) {
            const { data, field, center, metric } = map;
            const { latitude, longitude } = ellipsoid.cartesianToCartographic(hit);
            const sample = sampleZone(data, field, center, latitude, longitude);
            if (sample !== null) {
                const value = `${metrics[metric].label} · ${formatted(sample, metric, field)}`;
                if (probeValue.value !== value) probeValue.value = value;
                if (advanced.checked) {
                    probeCoordinates.textContent = `${(latitude / radians).toFixed(6)}°, ${(longitude / radians).toFixed(6)}°`;
                }
                probe.hidden = false;
                const bounds = scene.canvas.getBoundingClientRect();
                placeProbe(bounds.left + position.x, bounds.top + position.y);
                return true;
            }
        }
        probe.hidden = true;
        return false;
    }

    scene.canvas.addEventListener('pointermove', event => {
        if (!canInspect() || event.buttons || event.pointerType === 'touch') return;
        pendingPointer = { x: event.clientX, y: event.clientY };
        if (pointerFrame === undefined) {
            pointerFrame = requestAnimationFrame(() => {
                pointerFrame = undefined;
                const bounds = scene.canvas.getBoundingClientRect();
                inspect({ x: pendingPointer.x - bounds.left, y: pendingPointer.y - bounds.top });
                pendingPointer = undefined;
            });
        }
    });
    scene.canvas.addEventListener('pointerleave', event => {
        if (event.pointerType !== 'touch') clearProbe();
    });
    scene.canvas.addEventListener('wheel', clearProbe, { passive: true });
    document.addEventListener('pointerdown', clearProbe);
    viewer.camera.moveStart.addEventListener(clearProbe);
    toggle.addEventListener('change', () => refresh(0));
    select.addEventListener('change', () => refresh(0));
    advanced.addEventListener('change', setAdvanced);
    setAdvanced();

    return {
        // LUNA-DOC: The setTime method updates zone time; verify its callers before editing it.
        setTime(value) {
            if (utc === value) return;
            utc = value;
            if (selection && (!value || !map || !staticMetrics.has(select.value))) refresh(220, { keepMap: true });
        },
        // LUNA-DOC: The setLocation method updates zone coordinates; verify its callers before editing it.
        setLocation(value, zoneMode) {
            const changedMode = controls.hidden === zoneMode;
            controls.hidden = !zoneMode;
            if (changedMode) {
                pointResults.hidden = zoneMode;
                zoneResults.hidden = !zoneMode;
                resultsTitle.textContent = zoneMode ? 'Zone results' : 'Simulation results';
            }
            const selected = value?.radius_m ? value : null;
            if (!changedMode && selected?.lat === selection?.lat && selected?.lon === selection?.lon
                && selected?.radius_m === selection?.radius_m) return;
            selection = selected;
            refresh();
        },
        // LUNA-DOC: The getChart method provides zone charts; verify its callers before editing it.
        getChart() {
            if (!canInspect() || status.dataset.loading === 'true') return null;
            const { data, field, metric } = map;
            const description = metrics[metric];
            const [lower, upper] = description.range;
            const colourStep = paletteSteps / (upper - lower);
            return {
                ...description,
                grid: data,
                values: field.values,
                min: field.min,
                max: field.max,
                caption: mapTime(data, metric),
                colourStops,
                // LUNA-DOC: The colourAt method samples raster color; verify its callers before editing it.
                colourAt(value) {
                    const index = clamp(Math.round((value - lower) * colourStep), 0, paletteSteps);
                    return colourLookup[index];
                },
                // LUNA-DOC: The loadElevation method loads terrain elevations; verify its callers before editing it.
                async loadElevation(signal) {
                    if (metric === 'terrain_elevation_m') return field.values;
                    const request = { ...data.center, radius_m: data.radius_m };
                    const response = await requestZone(request, data.utc, 'terrain_elevation_m', signal);
                    const elevation = await readZoneResponse(response);
                    if (elevation.grid_size !== data.grid_size || elevation.step_m !== data.step_m) {
                        throw new Error('The elevation grid does not match this zone.');
                    }
                    return elevation.fields?.terrain_elevation_m?.values;
                },
            };
        },
        inspect,
    };
}
