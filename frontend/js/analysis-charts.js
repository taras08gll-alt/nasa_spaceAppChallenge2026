// LUNA-DOC: Open charts dialog: 2D point history, zone charts, DEM surface, and time selection.
// LUNA-DOC: Data providers are lunar-ephemeris.js and lunar-zone.js; the Open charts button is hidden if providers are unavailable.
// LUNA-DOC: The zone time slider applies to dynamic metrics, not static DEM elevations or slope.
import { showZoneSurface } from './lunar-zone-3d.js';

const pointMetrics = {
    temperature_c: ['Surface temperature', '°C'],
    irradiance_w_m2: ['Solar irradiance', 'W/m²'],
    absorbed_w_m2: ['Absorbed sunlight', 'W/m²'],
    emitted_w_m2: ['Emitted thermal flux', 'W/m²'],
    net_radiation_w_m2: ['Net surface radiation', 'W/m²'],
    sun_elevation_deg: ['Sun elevation', '°'],
    sun_clearance_deg: ['Sun above local horizon', '°'],
    sun_above_horizon_percent: ['Solar disk above horizon', '%'],
    sun_visible_percent: ['Visible solar disk', '%'],
    sun_blocked_by_earth_percent: ['Solar disk blocked by Earth', '%'],
    dose_rate_usv_h: ['Estimated radiation dose rate', 'µSv/h'],
    link_margin_db: ['Earth link margin', 'dB'],
    panel_tilt_deg: ['Solar tracker tilt', '°'],
};
const dayMs = 86_400_000;
const signedMetrics = new Set([
    'temperature_c', 'net_radiation_w_m2', 'sun_elevation_deg', 'sun_clearance_deg', 'link_margin_db',
]);
const number = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
});
const timeTick = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
});
const dateTick = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
});

// LUNA-DOC: Create readable chart-axis tick values.
function niceTicks(low, high, wholeNumbers = false) {
    const interval = (high - low) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(interval));
    const factor = [1, 2, 2.5, 5].find(value => value >= interval / magnitude) ?? 10;
    const spacing = factor * magnitude;
    const step = wholeNumbers ? Math.ceil(spacing) : spacing;
    const first = Math.floor(low / step);
    const last = Math.ceil(high / step);
    return Array.from({ length: last - first + 1 }, (_, index) => (first + index) * step);
}

// LUNA-DOC: Choose appropriate formatting for axis labels.
function axisFormat(step) {
    if (step >= 0.05 || step === 0) return number;
    const digits = Math.min(7, Math.ceil(-Math.log10(step)) + 1);
    return new Intl.NumberFormat('en-GB', { maximumFractionDigits: digits });
}

// LUNA-DOC: Find the time frame closest to the cursor.
function nearestTimeIndex(times, time) {
    return times.reduce((nearest, sample, index) => (
        Math.abs(sample - time) < Math.abs(times[nearest] - time) ? index : nearest
    ), 0);
}

// LUNA-DOC: Prepare a 2D time-series chart for a point metric.
function historyPlot(history, metric) {
    const [label, unit] = pointMetrics[metric];
    const values = history.series[metric];
    const times = history.times;
    const samples = values.filter(Number.isFinite);
    if (!samples.length) return null;
    const low = Math.min(...samples);
    const high = Math.max(...samples);
    const margin = low === high ? Math.max(0.5, Math.abs(low) * 0.04) : (high - low) * 0.08;
    const yMin = signedMetrics.has(metric) ? low - margin : Math.max(0, low - margin);
    const yTicks = niceTicks(yMin, high + margin);
    return {
        label, unit, values, times, yTicks,
        xStart: times[0],
        xEnd: times.at(-1),
        yMin: yTicks[0],
        yMax: yTicks.at(-1),
    };
}

// LUNA-DOC: Prepare a spatial distribution of values across a zone.
function zoneHistogram({ label, unit, values }) {
    const samples = values.filter(Number.isFinite);
    if (!samples.length) return null;
    const xStart = Math.min(...samples);
    const xEnd = Math.max(...samples);
    const count = xStart === xEnd ? 1 : Math.min(18, Math.ceil(Math.sqrt(samples.length)));
    const binWidth = (xEnd - xStart) / count;
    const bins = Array(count).fill(0);
    for (const value of samples) {
        const index = binWidth ? Math.min(count - 1, Math.floor((value - xStart) / binWidth)) : 0;
        bins[index] += 1;
    }
    const peak = Math.max(...bins);
    const yTicks = niceTicks(0, peak, true);
    return {
        label, unit, xStart, xEnd, binWidth, yTicks,
        sampleCount: samples.length, formatBin: axisFormat(binWidth || Math.abs(xStart)),
        values: bins, yMin: 0, yMax: yTicks.at(-1),
    };
}

// LUNA-DOC: Draw guide lines, axes, and markers on the canvas.
function drawPlot(canvas, data, selected) {
    const { width, height } = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (!pixelWidth || !pixelHeight) return null;
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelWidth / width, 0, 0, pixelHeight / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.lineWidth = 1;

    const { label, unit, xStart, xEnd, yMin, yMax, times, values, yTicks } = data;
    const top = 27;
    const bottom = height - (times ? 31 : 44);
    const right = width - 13;
    const yFormat = axisFormat(yTicks[1] - yTicks[0]);
    const left = Math.ceil(Math.max(...yTicks.map(value => ctx.measureText(yFormat.format(value)).width))) + 15;
    const plotWidth = right - left;
    // LUNA-DOC: The y helper transforms coordinates; check callers before changing it.
    const y = value => bottom - (bottom - top) * (value - yMin) / (yMax - yMin);
    // LUNA-DOC: The x helper transforms coordinates; check callers before changing it.
    const x = value => xEnd === xStart ? left + plotWidth / 2 : left + plotWidth * (value - xStart) / (xEnd - xStart);

    ctx.fillStyle = '#e1dcd4';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(times ? `${label} (${unit})` : 'Grid samples', left, 11);
    ctx.strokeStyle = '#3b404b';
    ctx.textAlign = 'right';
    for (const value of yTicks) {
        const row = y(value);
        ctx.beginPath();
        ctx.moveTo(left, row);
        ctx.lineTo(right, row);
        ctx.stroke();
        ctx.fillText(yFormat.format(value), left - 7, row);
    }

    const span = xEnd - xStart;
    const xTickFormat = times ? (span > dayMs ? dateTick : timeTick) : data.formatBin;
    const maxTicks = width < 380 ? 3 : 5;
    const xTicks = times ? Math.max(1, Math.min(maxTicks, Math.floor(span / (span > dayMs ? dayMs : 60_000)))) : maxTicks;
    if (xStart === xEnd) {
        ctx.textAlign = 'center';
        ctx.fillText(xTickFormat.format(xStart), x(xStart), bottom + 14);
    } else {
        for (let tick = 0; tick <= xTicks; tick++) {
            const fraction = tick / xTicks;
            const value = xStart + (xEnd - xStart) * fraction;
            ctx.textAlign = tick === 0 ? 'left' : tick === xTicks ? 'right' : 'center';
            ctx.fillText(xTickFormat.format(value), left + fraction * plotWidth, bottom + 14);
        }
    }

    if (times) {
        ctx.beginPath();
        let contiguous = false;
        for (const [index, value] of values.entries()) {
            if (!Number.isFinite(value)) {
                contiguous = false;
                continue;
            }
            const method = contiguous ? 'lineTo' : 'moveTo';
            ctx[method](x(times[index]), y(value));
            contiguous = true;
        }
        ctx.strokeStyle = '#ffb54d';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#ffb54d';
        for (const [index, value] of values.entries()) {
            if (!Number.isFinite(value) || Number.isFinite(values[index - 1]) || Number.isFinite(values[index + 1])) continue;
            ctx.beginPath();
            ctx.arc(x(times[index]), y(value), 2.5, 0, 2 * Math.PI);
            ctx.fill();
        }
        const column = x(times[selected]);
        ctx.strokeStyle = '#a9aeb9';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(column, top);
        ctx.lineTo(column, bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        if (Number.isFinite(values[selected])) {
            ctx.beginPath();
            ctx.arc(column, y(values[selected]), 4, 0, 2 * Math.PI);
            ctx.fill();
        }
    } else {
        ctx.textAlign = 'center';
        ctx.fillText(`${label} (${unit})`, left + plotWidth / 2, bottom + 33);
        const barWidth = plotWidth / values.length;
        const inset = values.length === 1 ? barWidth * 0.28 : 1;
        for (const [index, count] of values.entries()) {
            ctx.fillStyle = index === selected ? '#ffb54d' : '#a97136';
            ctx.fillRect(left + index * barWidth + inset, y(count), barWidth - 2 * inset, bottom - y(count));
        }
    }
    return { left, width: plotWidth };
}

// LUNA-DOC: Initialize the Open charts dialog and data providers.
export function initAnalysisCharts({ loadHistory, zoneChart, getPointFrame }) {
    const dialog = document.getElementById('analysis-dialog');
    const title = document.getElementById('analysis-title');
    const period = document.getElementById('analysis-period');
    const metricField = document.getElementById('analysis-metric-field');
    const metric = document.getElementById('analysis-metric');
    const status = document.getElementById('analysis-status');
    const plot = document.getElementById('analysis-plot');
    const canvas = document.getElementById('analysis-canvas');
    const readout = document.getElementById('analysis-readout');
    const openButton = document.getElementById('advanced-chart-open');
    const zoneResults = document.getElementById('zone-results');
    const zoneStatus = document.getElementById('zone-map-status');
    const timelineSlider = document.getElementById('timeline-slider');
    const zoneView = document.getElementById('analysis-zone-view');
    const zoneViewField = document.getElementById('analysis-zone-view-field');
    const surface = document.getElementById('analysis-surface');
    const surfaceViewport = document.getElementById('analysis-surface-viewport');
    const surfaceReadout = document.getElementById('analysis-surface-readout');
    const surfaceScale = document.getElementById('analysis-surface-scale');
    const surfaceMin = document.getElementById('analysis-surface-min');
    const surfaceMax = document.getElementById('analysis-surface-max');

    let request;
    let history;
    let data;
    let zoneMode;
    let zone;
    let surfaceWidget;
    let waiting = false;
    let selected = 0;
    let bounds;

    for (const [key, [label, unit]] of Object.entries(pointMetrics)) {
        metric.append(new Option(`${label} (${unit})`, key));
    }

    // LUNA-DOC: Display the current chart state or an error message.
    function showStatus(message = '', { error = false, loading = false } = {}) {
        status.textContent = message;
        status.dataset.error = String(error);
        status.dataset.loading = String(loading);
    }

    // LUNA-DOC: Update the chart for the active mode and metric.
    function render() {
        if (!data || plot.hidden || !dialog.open) return;
        bounds = drawPlot(canvas, data, selected);
        if (data.times) {
            const value = data.values[selected];
            const text = Number.isFinite(value) ? `${number.format(value)} ${data.unit}` : 'No data';
            readout.value = `${date.format(data.times[selected])} UTC · ${text}`;
        } else {
            const start = data.formatBin.format(data.xStart + selected * data.binWidth);
            const end = data.formatBin.format(selected === data.values.length - 1
                ? data.xEnd : data.xStart + (selected + 1) * data.binWidth);
            const range = data.binWidth ? `${start} – ${end}` : start;
            readout.value = `${range} ${data.unit} · ${number.format(data.values[selected])} of ${number.format(data.sampleCount)} samples`;
        }
    }

    // LUNA-DOC: Show the 2D chart.
    function showPlot(next, index = 0) {
        data = next;
        selected = index;
        bounds = null;
        plot.hidden = !data;
        showStatus(data ? '' : 'No samples are available for this parameter.');
        if (data) {
            canvas.setAttribute('aria-label', `${data.label} chart. Use the arrow keys to inspect values.`);
            render();
        }
    }

    // LUNA-DOC: Dispose of the previous 3D renderer before changing charts.
    function clearSurface() {
        surfaceWidget = surfaceWidget?.destroy();
        surface.hidden = true;
    }

    // LUNA-DOC: Draw a 3D DEM surface colored by the selected parameter.
    async function showZoneView() {
        request?.abort();
        request = undefined;
        clearSurface();

        const mode = zoneView.value;
        if (mode === 'distribution') {
            title.textContent = `${zone.label} distribution`;
            showPlot(zoneHistogram(zone));
            return;
        }

        plot.hidden = true;
        title.textContent = `${zone.label} · 3D graph`;
        const controller = new AbortController();
        request = controller;
        try {
            surfaceViewport.setAttribute('aria-label', title.textContent);
            surfaceReadout.textContent = `Height · ${zone.label} (${number.format(zone.min)} to ${number.format(zone.max)} ${zone.unit})`;
            surfaceScale.style.backgroundImage = `linear-gradient(to right, ${zone.colourStops})`;
            surfaceMin.value = `${number.format(zone.range[0])} ${zone.unit}`;
            surfaceMax.value = `${number.format(zone.range[1])} ${zone.unit}`;
            surface.hidden = false;
            surfaceWidget = showZoneSurface(surfaceViewport, zone);
            showStatus();
        } catch (error) {
            if (!controller.signal.aborted && dialog.open) {
                clearSurface();
                showStatus(error.message, { error: true });
            }
        } finally {
            if (request === controller) request = undefined;
        }
    }

    new ResizeObserver(render).observe(canvas);
    zoneView.addEventListener('change', showZoneView);
    metric.addEventListener('change', () => {
        if (history) showPlot(historyPlot(history, metric.value), selected);
    });

    // LUNA-DOC: Retrieve point history for the 2D chart.
    async function loadPointChart() {
        const controller = new AbortController();
        request = controller;
        metricField.hidden = false;
        metric.disabled = true;
        showStatus('Loading point history…', { loading: true });
        try {
            const result = await loadHistory(controller.signal);
            if (controller.signal.aborted || !dialog.open) return;
            if (!result.timestamps?.length || !result.series?.[metric.value]) {
                throw new Error('Point history unavailable.');
            }
            history = { ...result, times: result.timestamps.map(value => Date.parse(value)) };
            const caption = history.day_window ? 'Selected UTC day · ' : '';
            period.textContent = `${caption}${date.formatRange(history.times[0], history.times.at(-1))} UTC`;
            metric.disabled = false;
            showPlot(historyPlot(history, metric.value), nearestTimeIndex(history.times, Date.parse(history.selected_utc)));
        } catch (error) {
            if (!controller.signal.aborted && dialog.open) showStatus(error.message, { error: true });
        } finally {
            if (request === controller) request = undefined;
        }
    }

    // LUNA-DOC: Synchronize chart loading indicators.
    function updatePending() {
        if (!dialog.open || !waiting) return;
        if (timelineSlider.disabled) {
            waiting = false;
            showStatus('Set a valid UTC date range.');
            return;
        }
        if (zoneMode) {
            waiting = zoneStatus.dataset.loading === 'true';
            if (waiting) {
                showStatus('Calculating the zone…', { loading: true });
                return;
            }
            zone = zoneChart();
            if (zone) {
                period.textContent = zone.caption;
                zoneViewField.hidden = false;
                showZoneView();
            } else {
                showStatus(zoneStatus.textContent || 'Choose the centre of a zone to view its distribution.', {
                    error: zoneStatus.dataset.error === 'true',
                });
            }
            return;
        }

        const frame = getPointFrame();
        waiting = Boolean(frame?.loading);
        if (waiting) {
            showStatus('Calculating the selected point…', { loading: true });
        } else if (frame?.results?.instant) {
            loadPointChart();
        } else {
            showStatus(frame?.results?.note || 'Select a point on the Moon to view its charts.');
        }
    }

    openButton.addEventListener('click', () => {
        request?.abort();
        clearSurface();
        history = null;
        data = null;
        zone = null;
        bounds = undefined;
        plot.hidden = true;
        period.textContent = '';
        metricField.hidden = true;
        zoneViewField.hidden = true;
        zoneView.value = 'distribution';
        zoneMode = !zoneResults.hidden;
        title.textContent = zoneMode ? 'Zone distribution' : 'Point charts';
        waiting = true;
        dialog.showModal();
        updatePending();
    });

    dialog.addEventListener('close', () => {
        if (!dialog.open) {
            waiting = false;
            request?.abort();
            clearSurface();
        }
    });

    // LUNA-DOC: Open or update charts for the selected metric and time.
    function inspect(index) {
        if (index === selected) return;
        selected = index;
        render();
    }

    canvas.addEventListener('pointermove', event => {
        if (!bounds) return;
        const fraction = Math.max(0, Math.min(1, (event.offsetX - bounds.left) / bounds.width));
        if (!data.times) {
            inspect(Math.min(data.values.length - 1, Math.floor(fraction * data.values.length)));
            return;
        }
        const time = data.xStart + (data.xEnd - data.xStart) * fraction;
        inspect(nearestTimeIndex(data.times, time));
    });
    canvas.addEventListener('keydown', event => {
        if (!data || !['Home', 'End', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const last = data.values.length - 1;
        switch (event.key) {
            case 'Home': inspect(0); break;
            case 'End': inspect(last); break;
            case 'ArrowLeft': inspect(Math.max(0, selected - 1)); break;
            case 'ArrowRight': inspect(Math.min(last, selected + 1)); break;
        }
    });

    return { updatePending };
}
