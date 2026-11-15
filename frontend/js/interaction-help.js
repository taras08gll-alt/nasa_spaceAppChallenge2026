// LUNA-DOC: Compact contextual help for Point, Zone, Advanced, Surface Settings, and the timeline.
// LUNA-DOC: Help appears only when the question-mark button is hovered or focused, not when the panel is hovered.
// A single floating, accessible explanation for the control currently hovered or focused.
// No event handlers change the Cesium camera or the selected Moon location.
const instructions = {
    point: {
        title: 'Point mode',
        text: 'When you select Point mode, the program proceeds directly to analyzing specific coordinates on the Moon. You can enter the latitude and longitude manually or obtain them by clicking the desired location on the Moon. To center the point on the screen, click “Go to point”.',
    },
    zone: {
        title: 'Zone mode',
        text: 'When you select Zone mode, the program focuses on wide-area analysis. Once you click the “Zone” button, specify the radius of the lunar surface you want to study. To center the zone on the screen, click “Go to zone”.',
    },
    advanced: {
        title: 'Advanced mode',
        text: 'Enabling Advanced mode provides a deeper analysis of the selected point or area. For a zone, “Open charts” offers a temperature distribution and a 3D graph of the selected parameter. Terrain relief remains available through Surface settings.',
    },
    timeline: {
        title: 'Simulation timeline',
        text: 'In the top menu, specify the target timeframe by choosing its start and end. Drag the slider to observe the movement of Earth and Sun and analyze parameter changes over time in both Point and Zone modes.',
    },
    surface: {
        title: 'Surface settings',
        text: 'In the Surface Settings panel, enable additional visual layers: lunar shadows, terrain relief, and markers for historical and planned landing sites.',
    },
    bodies: {
        title: 'Earth and Sun',
        text: 'Show or hide Earth and Sun in the scene. Use the Overview, Moon, Earth and Sun buttons to change the camera target. Showing Earth and Sun does not move the camera automatically.',
    },
    markers: {
        title: 'Lunar mission markers',
        text: 'Show or hide historical and planned lunar landing-site markers. Hover over a marker to inspect its mission details. If the live catalogue is unavailable, the built-in catalogue is displayed.',
    },
    team: {
        title: 'About our team',
        text: 'Open the About our team window to learn about the LUNA Spiculum project.',
    },
    charts: {
        title: 'Open charts',
        text: 'Examine a history chart in Point mode, or a distribution and an interactive 3D parameter graph in Zone mode.',
    },
};

// Only explicit question-mark controls can open a help popover.
// Never assign help to entire buttons, panels, text fields or labels.
// LUNA-DOC: Attach question-mark triggers, positioning, and display handlers.
export function initInteractionHelp() {
    const popup = document.getElementById('interaction-help');
    const title = document.getElementById('interaction-help-title');
    const description = document.getElementById('interaction-help-text');
    if (!popup || !title || !description) return;
    let active = null;
    let pinned = false;

    // LUNA-DOC: Position help beside its trigger and keep the popup within the viewport.
    function position(button) {
        const rect = button.getBoundingClientRect();
        const margin = 12;
        const gap = 12;
        const width = popup.offsetWidth;
        const height = popup.offsetHeight;
        let x = rect.left - width - gap;
        if (x < margin) x = rect.right + gap;
        x = Math.max(margin, Math.min(x, window.innerWidth - width - margin));
        let y = rect.top;
        y = Math.max(margin, Math.min(y, window.innerHeight - height - margin));
        popup.style.left = `${x}px`;
        popup.style.top = `${y}px`;
    }
    // LUNA-DOC: Display text only while the relevant question mark is hovered or focused.
    function show(button) {
        const content = instructions[button.dataset.help];
        if (!content) return;
        active = button;
        title.textContent = content.title;
        description.textContent = content.text;
        popup.hidden = false;
        position(button);
    }
    // LUNA-DOC: Hide the popup when the pointer leaves or focus is lost.
    function hide() {
        popup.hidden = true;
        active = null;
        pinned = false;
    }
    const buttons = [...document.querySelectorAll('.luna-help-button[data-help]')];
    for (const button of buttons) {
        // Prevent the browser's default title tooltip overlapping our help card.
        button.removeAttribute('title');
        button.setAttribute('aria-describedby', 'interaction-help');
        button.addEventListener('pointerenter', event => {
            if (event.pointerType !== 'touch' && !pinned) show(button);
        });
        button.addEventListener('pointerleave', () => {
            if (!pinned) hide();
        });
        button.addEventListener('focus', () => { if (!pinned) show(button); });
        button.addEventListener('blur', () => { if (!pinned) hide(); });
        button.addEventListener('click', event => {
            event.stopPropagation();
            if (pinned && active === button) hide();
            else { show(button); pinned = true; }
        });
    }
    document.addEventListener('pointerdown', event => {
        if (pinned && !event.target.closest?.('.luna-help-button')) hide();
    });
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', () => {
        if (active && !popup.hidden) position(active);
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') hide();
    });
}
