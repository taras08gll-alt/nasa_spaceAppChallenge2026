// LUNA-DOC: Interface controller: time inputs, timeline slider, parameter panels, Advanced mode, and Open charts.
// LUNA-DOC: The luna-mission-time-select event sets the timeline to a historic landing time in UTC.
// LUNA-DOC: Physical model data arrive via the moon-results custom event and ephemeris/zone services.
import '../css/advanced-mode.css';
import { initAnalysisCharts } from './analysis-charts.js';
import { initInteractionHelp } from './interaction-help.js';

// LUNA-DOC: Create the timeline, synchronize result displays, and initialize modal charts.
export function initSimulationUi(viewer, onTimeChange = () => { }, chartSources) {
    initInteractionHelp();
    const teamDialog = document.getElementById('about-team-dialog');
    document.getElementById('about-team-open')?.addEventListener('click', () => teamDialog?.showModal());

    const timelineStart = document.getElementById('timeline-start');
    const timelineEnd = document.getElementById('timeline-end');
    const timelineSlider = document.getElementById('timeline-slider');
    const timelineCurrent = document.getElementById('timeline-current');

    if (!timelineStart || !timelineEnd || !timelineSlider || !timelineCurrent) return;

    const minuteMs = 60_000;
    let timelineStepMs = 10 * minuteMs;
    const timelineCamera = viewer.scene.screenSpaceCameraController;
    const timelineFormat = new Intl.DateTimeFormat('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'medium',
        timeZone: 'UTC',
    });

    // LUNA-DOC: Convert slider position to an absolute UTC timestamp and request updates.
    function showTimelineTime() {
        if (timelineSlider.disabled) return;

        const selectedMs = Math.min(
            timelineStart.valueAsNumber + timelineSlider.valueAsNumber * timelineStepMs,
            timelineEnd.valueAsNumber,
        );
        const text = timelineFormat.format(selectedMs) + ' UTC';

        timelineCurrent.value = text;
        timelineSlider.setAttribute('aria-valuetext', text);
        const progress = 100 * timelineSlider.valueAsNumber / Number(timelineSlider.max);
        timelineSlider.style.setProperty('--timeline-progress', `${progress}%`);
        onTimeChange(new Date(selectedMs).toISOString(), false, {
            start_utc: new Date(timelineStart.valueAsNumber).toISOString(),
            end_utc: new Date(timelineEnd.valueAsNumber).toISOString(),
            step_minutes: timelineStepMs / minuteMs,
        });
    }

    // LUNA-DOC: Validate interval bounds and slider step and set the exact cursor position.
    function refreshTimeline(targetMs = null) {
        const startMs = timelineStart.valueAsNumber;
        const endMs = timelineEnd.valueAsNumber;
        timelineSlider.disabled = !timelineStart.validity.valid
            || !timelineEnd.validity.valid
            || !Number.isFinite(startMs)
            || !(endMs > startMs);

        if (timelineSlider.disabled) {
            timelineCurrent.value = 'Set a valid date range';
            timelineSlider.removeAttribute('aria-valuetext');
            timelineSlider.style.setProperty('--timeline-progress', '0%');
            onTimeChange(null);
            return;
        }

        const spanMs = endMs - startMs;
        const maxSteps = 1440;
        timelineStepMs = Math.max(10, Math.ceil(spanMs / minuteMs / maxSteps)) * minuteMs;
        timelineSlider.max = String(Math.ceil(spanMs / timelineStepMs));
        // Keep an exact requested mission touchdown at the timeline cursor.
        const requestedIndex = typeof targetMs === 'number' && Number.isFinite(targetMs)
            ? Math.round((targetMs - startMs) / timelineStepMs) : 0;
        timelineSlider.value = String(Math.min(Number(timelineSlider.max), Math.max(0, requestedIndex)));
        showTimelineTime();
    }

    let activePointerId = null;
    let previousCameraInputs = true;

    timelineSlider.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || activePointerId !== null) return;

        activePointerId = event.pointerId;
        previousCameraInputs = timelineCamera.enableInputs;
        timelineCamera.enableInputs = false;
    });

    // LUNA-DOC: Restore camera controls after dragging the timeline slider.
    function releaseTimelineCamera(event) {
        if (activePointerId === null) return;
        if (event.type !== 'blur' && event.pointerId !== activePointerId) return;

        activePointerId = null;
        timelineCamera.enableInputs = previousCameraInputs;
    }

    window.addEventListener('pointerup', releaseTimelineCamera, true);
    window.addEventListener('pointercancel', releaseTimelineCamera, true);
    window.addEventListener('blur', releaseTimelineCamera);

    timelineStart.addEventListener('input', refreshTimeline);
    timelineEnd.addEventListener('input', refreshTimeline);
    timelineSlider.addEventListener('input', () => showTimelineTime());
    if (!timelineStart.value && !timelineEnd.value) {
        const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
        timelineStart.valueAsNumber = currentMinute;
        timelineEnd.valueAsNumber = currentMinute + 24 * 60 * 60_000;
    }

    const resultsPanel = document.querySelector('.simulation-results');
    const pointResults = document.getElementById('point-results');
    const resultTime = resultsPanel?.querySelector('#results-time');
    if (!resultTime) {
        refreshTimeline();
        return;
    }

    const resultRows = Array.from(resultsPanel.querySelectorAll('[data-metric]'), row => {
        const average = row.querySelector('[data-average]');
        return {
            metric: row.dataset.metric,
            fallback: row.dataset.instantFallback,
            averageMetric: average?.dataset.average || row.dataset.metric,
            instant: row.querySelector('[data-instant]'),
            average,
        };
    });
    const resultFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });
    const advanced = document.getElementById('advanced-mode');
    const details = document.getElementById('advanced-results');
    const detailRows = details.querySelectorAll('[data-detail]');
    const chartButton = document.getElementById('advanced-chart-open');
    const loading = document.getElementById('simulation-loading');
    const lightingStatus = document.getElementById('ephemeris-status');
    const zoneStatus = document.getElementById('zone-map-status');
    let resultData = null;
    let frameData = null;
    const charts = chartSources && initAnalysisCharts({ ...chartSources, getPointFrame: () => frameData });

    // LUNA-DOC: Show advanced metrics and Open charts only when its module is ready.
    function setAdvanced() {
        details.hidden = !advanced.checked;
        chartButton.hidden = !advanced.checked || !charts;
    }
    advanced.addEventListener('change', setAdvanced);
    setAdvanced();

    // LUNA-DOC: Update the loading indicator using ephemeris and zone status.
    function updateLoading() {
        let message = '';
        if (zoneStatus.dataset.loading === 'true') message = 'Calculating the zone…';
        else if (!pointResults.hidden && frameData?.loading) message = 'Calculating the selected point…';
        else if (lightingStatus.dataset.loading === 'true') message = 'Loading lunar lighting…';
        if (message && loading.textContent !== message) loading.textContent = message;
        loading.hidden = !message;
        charts?.updatePending();
    }

    const statusObserver = new MutationObserver(updateLoading);
    for (const source of [zoneStatus, lightingStatus]) {
        statusObserver.observe(source, { attributes: true, attributeFilter: ['data-loading'] });
    }

    viewer.container.addEventListener('moon-results', ({ detail }) => {
        frameData = detail;
        renderSimulationResults();
        updateLoading();
    });

    // LUNA-DOC: Format numeric and Boolean values for the results panel.
    function formatResult(value) {
        if (typeof value === 'boolean') return value ? 'Yes' : 'No';
        if (typeof value === 'string' && value) return value;
        return Number.isFinite(value) ? resultFormat.format(value) : '—';
    }

    // LUNA-DOC: Populate the table of instantaneous and average values.
    function renderSimulationResults() {
        if (pointResults.hidden) return;
        const instant = timelineSlider.disabled
            ? null
            : resultData?.frames?.[timelineSlider.valueAsNumber];
        const frame = timelineSlider.disabled ? null : frameData;
        const averages = timelineSlider.disabled ? null : resultData?.averages;
        const results = frame?.results;
        const note = results?.note;
        resultTime.dataset.loading = String(Boolean(frame?.loading));
        resultTime.textContent = instant || results || frame?.sunlight
            ? [timelineCurrent.value, note].filter(Boolean).join(' · ')
            : 'Select a point on the Moon.';

        for (const row of resultRows) {
            const key = row.metric;
            const value = instant?.[key] ?? results?.instant?.[key] ?? frame?.sunlight?.[key]
                ?? results?.instant?.[row.fallback];
            const average = averages?.[row.averageMetric] ?? results?.averages?.[row.averageMetric];
            if (row.instant) row.instant.textContent = formatResult(value);
            if (row.average) row.average.textContent = formatResult(average);
        }
        for (const row of detailRows) {
            const value = results?.details?.[row.dataset.detail];
            row.textContent = formatResult(value) + (Number.isFinite(value) && row.dataset.unit ? ` ${row.dataset.unit}` : '');
        }
    }

    window.setSimulationResults = (data) => {
        resultData = data;
        renderSimulationResults();
    };

    // LUNA-DOC: Clear stale values after the period changes.
    function clearSimulationResults() {
        resultData = null;
        renderSimulationResults();
    }

    timelineSlider.addEventListener('input', renderSimulationResults);
    timelineStart.addEventListener('input', clearSimulationResults);
    timelineEnd.addEventListener('input', clearSimulationResults);

    // One authoritative route for historical missions to change the entire
    // simulation (Earth/Sun positions, computed results, timeline and charts).
    // Keep a 24-hour span centered on the landing, and retain the exact second.
    viewer.container.addEventListener('luna-mission-time-select', ({ detail }) => {
        const utc = detail?.utc;
        if (typeof utc !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(utc)) return;
        const selectedMs = Date.parse(utc);
        if (!Number.isFinite(selectedMs)) return;
        const halfDay = 12 * 60 * 60_000;
        const startMs = selectedMs - halfDay;
        const endMs = selectedMs + halfDay;
        // LUNA-DOC: The encodeUtcInput helper formats time input; verify its call sites before editing it.
        const encodeUtcInput = value => new Date(value).toISOString().slice(0, 19);
        timelineStart.value = encodeUtcInput(startMs);
        timelineEnd.value = encodeUtcInput(endMs);
        // The main slider already drives the ephemerides and the zone model.
        // Changing this interval updates both and keeps the selected timestamp.
        clearSimulationResults();
        refreshTimeline(selectedMs);
    });
    refreshTimeline();
    updateLoading();
}
