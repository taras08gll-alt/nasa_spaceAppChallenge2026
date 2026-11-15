// LUNA-DOC: Control Sun/Earth positioning, 3D Moon lighting, and the history of calculated parameters.
// LUNA-DOC: Fetch backend data; frame timestamps and point/zone results must refer to the same UTC instant.
// LUNA-DOC: The overview camera scales displayed celestial bodies for clarity; visual separation is not physical distance.
import {
    Cartesian3,
    Color,
    DirectionalLight,
    EllipsoidGeometry,
    GeometryInstance,
    Material,
    MaterialAppearance,
    Matrix3,
    Matrix4,
    Primitive,
    Resource,
    ShadowMode,
    buildModuleUrl,
} from 'cesium';

const shadowMaterialSource = `
float discSegmentArea(float cosine)
{
    float x = clamp(cosine, -1.0, 1.0);
    return acos(x) - x * sqrt(max(0.0, 1.0 - x * x));
}

float solarDiscCoverage(float separation, float sunAngle, float earthAngle)
{
    // Use the Sun's apparent radius as the unit of length for the discs.
    float earthRadius = earthAngle / sunAngle;
    float earthArea = earthRadius * earthRadius;
    if (separation <= abs(earthAngle - sunAngle)) return min(1.0, earthArea);

    float distance = separation / sunAngle;
    float distanceSquared = distance * distance;
    float sunCosine = (distanceSquared + 1.0 - earthArea) / (2.0 * distance);
    float earthCosine = (distanceSquared + earthArea - 1.0) / (2.0 * distance * earthRadius);
    float overlap = discSegmentArea(sunCosine) + earthArea * discSegmentArea(earthCosine);
    return clamp(overlap / czm_pi, 0.0, 1.0);
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = vec3(0.0);
    material.alpha = 0.0;
    if (lightingActive < 0.5) return material;

    const float nightOpacity = 0.7;
    vec3 surface = czm_viewerPositionWC - czm_inverseViewRotation * materialInput.positionToEyeEC;
    vec3 toSun = lunarSun - surface;
    if (dot(surface, toSun) <= 0.0) {
        material.alpha = nightOpacity;
        return material;
    }
    if (eclipseActive < 0.5) return material;

    vec3 toEarth = eclipseEarth - surface;
    float sunDistance = length(toSun);
    float earthDistance = length(toEarth);
    if (earthDistance >= sunDistance) return material;

    vec3 sunDirection = toSun / sunDistance;
    vec3 earthDirection = toEarth / earthDistance;
    float sunAngle = asin(clamp(eclipseSunRadius / sunDistance, 0.0, 1.0));
    float earthAngle = asin(clamp(eclipseEarthRadius / earthDistance, 0.0, 1.0));
    float separation = atan(length(cross(sunDirection, earthDirection)), dot(sunDirection, earthDirection));
    if (separation >= sunAngle + earthAngle) return material;

    float covered = solarDiscCoverage(separation, sunAngle, earthAngle);
    // A small opacity at first contact keeps the outer edge visible at overview scale.
    const float firstContactOpacity = 0.1;
    material.alpha = mix(firstContactOpacity, nightOpacity, covered);
    return material;
}
`;

// LUNA-DOC: Quickly reject geometrically impossible eclipses.
function shadowMayReachMoon(earth, sun, earthRadius, sunRadius, surfaceRadius) {
    const axis = Cartesian3.subtract(earth, sun, new Cartesian3());
    const separation = Cartesian3.magnitude(axis);
    Cartesian3.divideByScalar(axis, separation, axis);
    const behindEarth = -Cartesian3.dot(earth, axis);
    if (behindEarth < -surfaceRadius) return false;

    // The outer shadow cone includes both the umbra and penumbra.
    const sinHalfAngle = Math.min(1, (earthRadius + sunRadius) / separation);
    const cosHalfAngle = Math.sqrt(1 - sinHalfAngle ** 2);
    const offset = Cartesian3.magnitude(Cartesian3.cross(earth, axis, new Cartesian3()));
    const distanceToCone = offset * cosHalfAngle - behindEarth * sinHalfAngle - earthRadius;
    return distanceToCone <= surfaceRadius;
}

const earthFragmentShader = `
in vec3 v_normalEC;
in vec2 v_st;

void main()
{
    vec3 normal = normalize(v_normalEC);
    czm_materialInput inputMaterial;
    inputMaterial.st = v_st;
    inputMaterial.normalEC = normal;
    czm_material material = czm_getMaterial(inputMaterial);
    float illumination = max(dot(normal, normalize(czm_lightDirectionEC)), 0.0);
    out_FragColor = vec4(material.diffuse * (0.10 + 0.90 * illumination), 1.0);
}
`;

const sunFragmentShader = `
in vec3 v_positionEC;
in vec3 v_normalEC;

void main()
{
    float limb = max(dot(normalize(v_normalEC), normalize(-v_positionEC)), 0.0);
    vec3 colour = mix(vec3(0.98, 0.60, 0.19), vec3(1.0, 0.90, 0.60), sqrt(limb));
    out_FragColor = vec4(colour, 1.0);
}
`;

// LUNA-DOC: Create a visual Earth or Sun object in the scene.
function addBody(scene, radii, appearance) {
    return scene.primitives.add(new Primitive({
        geometryInstances: new GeometryInstance({
            geometry: new EllipsoidGeometry({
                radii,
                vertexFormat: appearance.vertexFormat,
                stackPartitions: 48,
                slicePartitions: 64,
            }),
        }),
        appearance,
        show: false,
        asynchronous: false,
        allowPicking: false,
        shadows: ShadowMode.DISABLED,
    }));
}

// LUNA-DOC: Load Earth's texture asynchronously with a fallback.
function loadEarthTexture(scene, material) {
    const textureRoot = 'Assets/Textures/NaturalEarthII/0';
    Promise.all([
        Resource.fetchImage({ url: buildModuleUrl(textureRoot + '/0/0.jpg') }),
        Resource.fetchImage({ url: buildModuleUrl(textureRoot + '/1/0.jpg') }),
    ]).then(([west, east]) => {
        const canvas = document.createElement('canvas');
        canvas.width = west.width + east.width;
        canvas.height = west.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // EllipsoidGeometry wraps its texture at the positive X axis.
        ctx.drawImage(east, 0, 0);
        ctx.drawImage(west, east.width, 0);
        material.uniforms.image = canvas;
        material.uniforms.color = Color.WHITE;
        scene.requestRender();
    }).catch(error => console.warn('Earth texture:', error));
}

// LUNA-DOC: Main controller for celestial bodies, lighting, and point data.
export function initLunarEphemeris(viewer, ellipsoid, hillshadeLayer, terrainToggle) {
    const { scene, camera } = viewer;
    const status = document.getElementById('ephemeris-status');
    const shadowToggle = document.getElementById('shadow-toggle');
    const showBodies = document.getElementById('show-bodies');
    const viewMoon = document.getElementById('view-moon');
    const viewEarth = document.getElementById('view-earth');
    const viewSun = document.getElementById('view-sun');
    const header = document.querySelector('.top-menu');
    const resultsPanel = document.querySelector('.simulation-results');
    const settingsPanel = document.querySelector('.setting');
    const moonRadius = ellipsoid.maximumRadius;
    const terrainShadowDistance = 80_000;
    const earthRadius = 1.2 * moonRadius;
    const sunRadius = 1.5 * moonRadius;
    const sunlight = new DirectionalLight({ direction: new Cartesian3(-1, 0, 0) });
    const shadowMaterial = new Material({
        fabric: {
            uniforms: {
                lightingActive: 0.0,
                eclipseActive: 0.0,
                eclipseEarth: new Cartesian3(),
                lunarSun: new Cartesian3(),
                eclipseEarthRadius: earthRadius,
                eclipseSunRadius: sunRadius,
            },
            source: shadowMaterialSource,
        },
    });
    scene.globe.material = shadowMaterial;

    // Map each orbit to its own display scale and keep changes in distance.
    const earthScale = 8 * moonRadius / 384_400_000;
    const sunScale = 15 * moonRadius / 149_597_870_700;
    const earthPosition = new Cartesian3();
    const sunPosition = new Cartesian3();
    const surfaceRadius = moonRadius * 1.02;
    const earthMaterial = Material.fromType(Material.ImageType, { color: Color.ROYALBLUE });
    const earth = addBody(
        scene,
        new Cartesian3(earthRadius, earthRadius, earthRadius * 0.996647),
        new MaterialAppearance({
            material: earthMaterial,
            fragmentShaderSource: earthFragmentShader,
            closed: true,
            translucent: false,
        }),
    );
    const sun = addBody(
        scene,
        new Cartesian3(sunRadius, sunRadius, sunRadius),
        new MaterialAppearance({
            materialSupport: MaterialAppearance.MaterialSupport.BASIC,
            fragmentShaderSource: sunFragmentShader,
            closed: true,
            translucent: false,
        }),
    );
    loadEarthTexture(scene, earthMaterial);

    scene.light = sunlight;
    scene.globe.enableLighting = false;
    scene.shadowMap.maximumDistance = terrainShadowDistance;
    scene.shadowMap.fadingEnabled = false;
    scene.globe.shadows = ShadowMode.DISABLED;
    if (scene.sun) scene.sun.show = false;

    let utc;
    let period;
    let point;
    let resultsTimer;
    let resultsRequest;
    let lightingRequest;
    let lightingFrames;
    let frameReady = false;
    let startupViewPending = true;
    let appliedUtc = null;
    const overviewOffset = Cartesian3.normalize(new Cartesian3(0.28, -0.48, 0.83), new Cartesian3());

    // LUNA-DOC: Construct the camera orientation frame for the lunar scene.
    function cameraFrame() {
        viewer.resize();
        const canvas = scene.canvas.getBoundingClientRect();
        const results = resultsPanel.getBoundingClientRect();
        const settings = settingsPanel.getBoundingClientRect();
        const desktop = canvas.width > 1000;
        const padding = desktop ? 24 : 12;
        const left = desktop ? results.right - canvas.left + padding : padding;
        const rightEdge = desktop ? settings.left - canvas.left - padding : canvas.width - padding;
        const top = header.getBoundingClientRect().bottom - canvas.top + padding;
        const panelTop = Math.min(results.top, settings.top) - canvas.top;
        const bottom = Math.max(top + canvas.height * 0.15, (desktop ? canvas.height : panelTop) - padding);
        return { canvas, left, rightEdge, top, bottom };
    }

    // LUNA-DOC: Calculate a view that includes the required celestial bodies.
    function frameBodies(bodies, eyeOffset, right, up, frame, minDistance, duration) {
        const { canvas, left, rightEdge, top, bottom } = frame;
        const tanY = Math.tan(camera.frustum.fovy / 2);
        const tanX = tanY * camera.frustum.aspectRatio;

        // Fit each spherical silhouette between the two relevant frustum edges.
        // LUNA-DOC: Estimate the bounding-sphere radius needed to fit objects in the frame.
        function fit(axis, low, high) {
            let first = Infinity;
            let last = -Infinity;
            const lowerLength = Math.hypot(1, low);
            const upperLength = Math.hypot(1, high);
            for (const { position, radius } of bodies) {
                const center = Cartesian3.dot(position, axis);
                const depth = Cartesian3.dot(position, eyeOffset);
                first = Math.min(first, center + low * depth - radius * lowerLength);
                last = Math.max(last, center + high * depth + radius * upperLength);
            }
            return {
                distance: (last - first) / (high - low),
                offset: distance => (first + last - (low + high) * distance) / 2,
            };
        }

        const horizontal = fit(right, (2 * left / canvas.width - 1) * tanX, (2 * rightEdge / canvas.width - 1) * tanX);
        const vertical = fit(up, (1 - 2 * bottom / canvas.height) * tanY, (1 - 2 * top / canvas.height) * tanY);
        const distance = Math.max(minDistance, horizontal.distance, vertical.distance);
        const destination = Cartesian3.multiplyByScalar(eyeOffset, distance, new Cartesian3());
        Cartesian3.add(destination, Cartesian3.multiplyByScalar(right, horizontal.offset(distance), new Cartesian3()), destination);
        Cartesian3.add(destination, Cartesian3.multiplyByScalar(up, vertical.offset(distance), new Cartesian3()), destination);
        const direction = Cartesian3.negate(eyeOffset, new Cartesian3());
        camera.flyTo({ destination, orientation: { direction, up }, duration });
        scene.requestRender();
    }

    // LUNA-DOC: Focus the camera on the Moon.
    function showMoon(duration = 0) {
        const frame = cameraFrame();
        const margin = 0.14 * Math.min(frame.rightEdge - frame.left, frame.bottom - frame.top);
        frame.left += margin;
        frame.rightEdge -= margin;
        frame.top += margin;
        frame.bottom -= margin;

        let heading = -Math.atan(0.5);
        if (frameReady) {
            const sunHeading = Math.atan2(sunPosition.y, sunPosition.x);
            const earthHeading = Math.atan2(earthPosition.y, earthPosition.x);
            const side = Math.sin(sunHeading - earthHeading) < 0 ? -1 : 1;
            // Expose the illuminated relief while keeping the Sun away from the viewing axis.
            heading = sunHeading + side * Math.PI / 5;
        }
        const eyeOffset = Cartesian3.normalize(
            new Cartesian3(Math.cos(heading), Math.sin(heading), 0.13), new Cartesian3(),
        );
        const right = Cartesian3.normalize(
            Cartesian3.cross(Cartesian3.UNIT_Z, eyeOffset, new Cartesian3()), new Cartesian3(),
        );
        const up = Cartesian3.cross(eyeOffset, right, new Cartesian3());
        frameBodies([{ position: Cartesian3.ZERO, radius: surfaceRadius }],
            eyeOffset, right, up, frame, 2.5 * moonRadius, duration);
    }

    // LUNA-DOC: Enable the overview composition of Moon, Earth, and Sun.
    function showOverview(duration = 0.8) {
        const frame = cameraFrame();
        const width = frame.rightEdge - frame.left;
        const height = frame.bottom - frame.top;
        const bodies = [{ position: Cartesian3.ZERO, radius: surfaceRadius }];
        const includeBodies = frameReady && showBodies.checked;
        let eyeOffset = overviewOffset;
        let upReference = Cartesian3.UNIT_Z;
        if (includeBodies) {
            bodies.push({ position: earthPosition, radius: earthRadius }, { position: sunPosition, radius: sunRadius });
            // Look across the orbits from lunar north, tilted toward the lit hemisphere.
            const sunward = Cartesian3.normalize(sunPosition, new Cartesian3());
            const earthToSun = Cartesian3.subtract(sunPosition, earthPosition, new Cartesian3());
            upReference = Cartesian3.magnitudeSquared(earthToSun) > Cartesian3.magnitudeSquared(sunPosition)
                ? earthToSun : sunPosition;
            eyeOffset = Cartesian3.multiplyByScalar(sunward, 0.55, new Cartesian3());
            Cartesian3.add(Cartesian3.UNIT_Z, eyeOffset, eyeOffset);
            if (width > 4 * height) {
                // Reduce the vertical spread when the controls leave a short, wide view.
                const side = Cartesian3.cross(Cartesian3.UNIT_Z, upReference, new Cartesian3());
                Cartesian3.normalize(side, side);
                Cartesian3.multiplyByScalar(side, Cartesian3.dot(earthPosition, side) > 0 ? -1.9 : 1.9, side);
                Cartesian3.add(eyeOffset, side, eyeOffset);
            }
            Cartesian3.normalize(eyeOffset, eyeOffset);
        }

        const direction = Cartesian3.negate(eyeOffset, new Cartesian3());
        let right = Cartesian3.normalize(Cartesian3.cross(direction, upReference, new Cartesian3()), new Cartesian3());
        let up = Cartesian3.cross(right, direction, new Cartesian3());
        if (includeBodies && width >= height) {
            [right, up] = [up, Cartesian3.negate(right, new Cartesian3())];
        }
        frameBodies(bodies, eyeOffset, right, up, frame, 5 * moonRadius, duration);
    }

    // LUNA-DOC: Focus the camera on the selected celestial body.
    function lookAtBody(position, bodyRadius) {
        startupViewPending = false;
        const offsetDirection = Cartesian3.normalize(Cartesian3.add(
            Cartesian3.normalize(position, new Cartesian3()),
            new Cartesian3(0.1, 0.4, 0.5),
            new Cartesian3(),
        ), new Cartesian3());
        const destination = Cartesian3.add(
            position,
            Cartesian3.multiplyByScalar(offsetDirection, 4.5 * bodyRadius, new Cartesian3()),
            new Cartesian3(),
        );
        const direction = Cartesian3.negate(offsetDirection, new Cartesian3());
        const pole = Math.abs(direction.z) > 0.98 ? Cartesian3.UNIT_Y : Cartesian3.UNIT_Z;
        const right = Cartesian3.normalize(Cartesian3.cross(direction, pole, new Cartesian3()), new Cartesian3());
        const up = Cartesian3.cross(right, direction, new Cartesian3());
        camera.flyTo({ destination, orientation: { direction, up }, duration: 0.8 });
    }

    // LUNA-DOC: Display the current loading stage or an error.
    function setStatus(message, isError = false, isLoading = false) {
        status.textContent = message;
        status.dataset.error = String(isError);
        status.dataset.loading = String(isLoading);
        status.dataset.utc = appliedUtc ?? '';
    }

    // LUNA-DOC: Synchronize terrain-shadow rendering with UI switches.
    function syncTerrainShadows() {
        const enabled = shadowMaterial.uniforms.lightingActive === 1 && terrainToggle.checked
            && camera.positionCartographic.height < terrainShadowDistance;
        if (viewer.shadows === enabled) return;
        viewer.shadows = enabled;
        viewer.terrainShadows = enabled ? ShadowMode.ENABLED : ShadowMode.DISABLED;
        scene.requestRender();
    }

    // LUNA-DOC: Apply Show Earth and Sun, Shadow, and Terrain checkboxes.
    function applyDisplayOptions() {
        const shadowsOn = frameReady && shadowToggle.checked;
        const eclipseOn = shadowsOn && shadowMayReachMoon(
            earthPosition, sunPosition, earthRadius, sunRadius, surfaceRadius,
        );
        hillshadeLayer.show = terrainToggle.checked;
        const uniforms = shadowMaterial.uniforms;
        uniforms.lightingActive = shadowsOn ? 1 : 0;
        uniforms.eclipseActive = eclipseOn ? 1 : 0;
        if (shadowsOn) Cartesian3.clone(sunPosition, uniforms.lunarSun);
        if (eclipseOn) Cartesian3.clone(earthPosition, uniforms.eclipseEarth);
        earth.show = sun.show = frameReady && showBodies.checked;
        viewEarth.disabled = viewSun.disabled = !earth.show;
        syncTerrainShadows();
        scene.requestRender();
    }

    // LUNA-DOC: Show frame UTC time and calculation status in the panel.
    function showFrameStatus() {
        const displayedTime = appliedUtc.slice(0, 16).replace('T', ' ') + ' UTC';
        const label = shadowMaterial.uniforms.eclipseActive
            ? 'Earth’s shadow (scene scale)'
            : (shadowToggle.checked ? 'Sunlight' : 'Shadows off');
        setStatus(`${label} · ${displayedTime}${lightingFrames ? '' : ' · updating…'}`, false, Boolean(lightingRequest && !lightingFrames));
    }

    // LUNA-DOC: Pass the current frame and results to the main interface.
    function publishResults(detail) {
        viewer.container.dispatchEvent(new CustomEvent('moon-results', { detail }));
    }

    // LUNA-DOC: Issue an HTTP request and handle backend errors.
    async function requestData(body, signal) {
        const response = await fetch('/api/get_data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!response.headers.get('content-type')?.includes('application/json')) {
            throw new Error(`/api/get_data returned HTTP ${response.status} without JSON`);
        }
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
        return data;
    }

    // LUNA-DOC: Update scene illumination, body directions, and visibility.
    function applyLighting() {
        const stepMs = period.step_minutes * 60_000;
        const index = Math.ceil((Date.parse(utc) - Date.parse(period.start_utc)) / stepMs);
        const [sunMetres, earthMetres, rotation] = lightingFrames[index];
        Cartesian3.fromArray(earthMetres, 0, earthPosition);
        Cartesian3.fromArray(sunMetres, 0, sunPosition);
        Cartesian3.multiplyByScalar(earthPosition, earthScale, earthPosition);
        Cartesian3.multiplyByScalar(sunPosition, sunScale, sunPosition);
        Cartesian3.normalize(sunPosition, sunlight.direction);
        Cartesian3.negate(sunlight.direction, sunlight.direction);
        const earthRotation = Matrix3.fromRowMajorArray(rotation);
        earth.modelMatrix = Matrix4.fromRotationTranslation(earthRotation, earthPosition);
        sun.modelMatrix = Matrix4.fromTranslation(sunPosition);
        appliedUtc = utc;
        frameReady = true;
        applyDisplayOptions();
        showFrameStatus();
        if (startupViewPending) {
            startupViewPending = false;
            showMoon();
        }
    }

    // LUNA-DOC: Fetch illumination history from the API.
    async function loadLighting() {
        const request = new AbortController();
        lightingRequest = request;
        setStatus('Loading lunar lighting…', false, true);
        try {
            const data = await requestData({ mode: 'lighting', ...period }, request.signal);
            if (request.signal.aborted) return;
            const intervalCount = Math.ceil(
                (Date.parse(period.end_utc) - Date.parse(period.start_utc)) / (period.step_minutes * 60_000),
            );
            if (data.frame !== 'MOON_ME' || data.frames?.length !== intervalCount + 1) {
                throw new Error('Invalid lunar lighting frames');
            }
            lightingFrames = data.frames;
            applyLighting();
        } catch (error) {
            if (request.signal.aborted) return;
            lightingFrames = undefined;
            setStatus(`Lighting: ${error.message}`, true);
            console.error('Moon lighting:', error);
        } finally {
            if (lightingRequest === request) lightingRequest = undefined;
        }
    }

    // LUNA-DOC: Load physical indicators for the active point.
    async function loadResults() {
        const request = new AbortController();
        resultsRequest = request;
        const time = utc;
        const requestedPeriod = period;
        const requestedPoint = point;

        try {
            const { start_utc, end_utc } = requestedPeriod;
            const data = await requestData({
                mode: 'ephemeris', utc: time, start_utc, end_utc, ...requestedPoint,
            }, request.signal);
            if (request.signal.aborted) return;
            if (time === utc && requestedPeriod === period && requestedPoint === point) {
                publishResults({ sunlight: data.sunlight, results: data.results });
            }
        } catch (error) {
            if (request.signal.aborted) return;
            if (time === utc && requestedPeriod === period && requestedPoint === point) {
                publishResults({ results: { note: 'Calculation request failed.' } });
            }
            console.error('Moon results:', error);
        } finally {
            if (resultsRequest === request) {
                resultsRequest = undefined;
                if (utc && point && (time !== utc || requestedPeriod !== period || requestedPoint !== point)) {
                    scheduleResults(65);
                }
            }
        }
    }

    // LUNA-DOC: Schedule an update without excessive repeated requests.
    function scheduleResults(delay) {
        if (resultsRequest) return;
        clearTimeout(resultsTimer);
        resultsTimer = setTimeout(() => {
            resultsTimer = undefined;
            loadResults();
        }, delay);
    }

    // LUNA-DOC: Queue data loading for the selected time and coordinates.
    function queueResults(delay) {
        if (!utc || !point) {
            clearTimeout(resultsTimer);
            resultsTimer = undefined;
            resultsRequest?.abort();
            resultsRequest = undefined;
            publishResults(null);
            return;
        }
        publishResults({ loading: true, results: { note: 'Calculating selected location…' } });
        scheduleResults(delay);
    }

    // LUNA-DOC: Check whether shadow settings are available.
    function updateShadowOptions() {
        applyDisplayOptions();
        if (frameReady && status.dataset.error !== 'true') showFrameStatus();
    }
    shadowToggle.addEventListener('change', updateShadowOptions);
    showBodies.addEventListener('change', applyDisplayOptions);
    terrainToggle.addEventListener('change', applyDisplayOptions);
    scene.preUpdate.addEventListener(syncTerrainShadows);
    // LUNA-DOC: Preserve the selected view while changing simulation time.
    function keepCameraView() {
        startupViewPending = false;
    }
    scene.canvas.addEventListener('pointerdown', keepCameraView, { once: true });
    scene.canvas.addEventListener('wheel', keepCameraView, { once: true, passive: true });
    viewer.container.addEventListener('moon-location-change', keepCameraView, { once: true });
    document.getElementById('view-overview').addEventListener('click', () => {
        keepCameraView();
        showOverview();
    });
    viewMoon.addEventListener('click', () => {
        keepCameraView();
        showMoon(0.8);
    });
    viewEarth.addEventListener('click', () => lookAtBody(earthPosition, earthRadius));
    viewSun.addEventListener('click', () => lookAtBody(sunPosition, sunRadius));
    requestAnimationFrame(() => {
        if (startupViewPending) showMoon();
    });
    applyDisplayOptions();

    return {
        // LUNA-DOC: The setTime method changes frame time; verify its call sites before editing it.
        setTime(value, overview = false, range) {
            if (overview && value) {
                keepCameraView();
                showOverview(0);
            }
            const samePeriod = period?.start_utc === range?.start_utc
                && period?.end_utc === range?.end_utc
                && period?.step_minutes === range?.step_minutes;
            if (utc === value && samePeriod) return;
            utc = value;
            if (!samePeriod) {
                period = range;
                lightingRequest?.abort();
                lightingRequest = undefined;
                lightingFrames = undefined;
            }

            if (!utc) {
                frameReady = false;
                appliedUtc = null;
                applyDisplayOptions();
                setStatus('Set a valid UTC date range.', true);
            } else if (lightingFrames) {
                applyLighting();
            } else if (!lightingRequest) {
                loadLighting();
            }
            if (point) queueResults(90);
        },
        // LUNA-DOC: The setPoint method changes the selected point; verify its call sites before editing it.
        setPoint(value) {
            if (point?.lat === value?.lat && point?.lon === value?.lon
                && point?.height_m === value?.height_m && point?.radius_m === value?.radius_m) return;
            point = value;
            queueResults(0);
        },
        // LUNA-DOC: The loadHistory method retrieves history; verify its call sites before editing it.
        loadHistory(signal) {
            return requestData({ mode: 'history', utc, ...period, ...point }, signal);
        },
    };
}
