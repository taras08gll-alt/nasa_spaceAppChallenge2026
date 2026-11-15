// LUNA-DOC: Main Cesium 3D scene module: Moon, camera, elevation tiles, Point/Zone modes, and user interaction.
// LUNA-DOC: Integrate Ephemeris, Zone, Markers, and Simulation UI; optional modules must not block scene initialization.
// LUNA-DOC: Point coordinates use latitude and longitude in degrees; Cesium geometry may use radians internally.
import { initSimulationUi } from './script.js';
import { initLunarEphemeris } from './lunar-ephemeris.js';
import { initLunarZone } from './lunar-zone.js';
import { initMissionMarkers } from './mission-markers.js';
import {
    BoundingSphere,
    CameraEventAggregator,
    CameraEventType,
    Cartesian2,
    Cartesian3,
    Cartographic,
    ClassificationType,
    Color,
    Credit,
    CreditDisplay,
    Ellipsoid,
    EllipsoidTerrainProvider,
    GeographicTilingScheme,
    Globe,
    HeadingPitchRange,
    HeightmapTerrainData,
    HeightReference,
    KeyboardEventModifier,
    Resource,
    SkyBox,
    TileAvailability,
    UrlTemplateImageryProvider,
    Viewer,
    Math as CesiumMath,
    ScreenSpaceEventType,
    buildModuleUrl,
    sampleTerrain,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';

CreditDisplay.cesiumCredit = new Credit('');
buildModuleUrl.setBaseUrl(new URL(import.meta.env.BASE_URL + 'cesium/', document.baseURI).href);

const ellipsoid = Ellipsoid.MOON;
const radius = ellipsoid.maximumRadius;
const tilingScheme = new GeographicTilingScheme({ ellipsoid });

const terrainSize = 65;
const maxTerrainLevel = 6;

const terrainStructure = {
    heightScale: 0.5,
    heightOffset: -10000,
    elementsPerHeight: 2,
    stride: 2,
    elementMultiplier: 256,
    isBigEndian: false,
    lowestEncodedHeight: 0,
    highestEncodedHeight: 65535,
};
const terrainHeightmaps = new Map();

// LUNA-DOC: Adapt numerical lunar tiles to Cesium's TerrainProvider interface.
class MoonTerrainProvider extends EllipsoidTerrainProvider {
    // LUNA-DOC: Configure DEM tile dimensions, level-of-detail limits, and provider settings.
    constructor() {
        super({ tilingScheme });
        this.moonCredit = new Credit('NASA LRO / LOLA');
        this.moonAvailability = new TileAvailability(tilingScheme, maxTerrainLevel);

        for (let level = 0; level <= maxTerrainLevel; level++) {
            this.moonAvailability.addAvailableTileRange(
                level, 0, 0,
                tilingScheme.getNumberOfXTilesAtLevel(level) - 1,
                tilingScheme.getNumberOfYTilesAtLevel(level) - 1,
            );
        }
    }

    get credit() {
        return this.moonCredit;
    }

    get availability() {
        return this.moonAvailability;
    }

    // LUNA-DOC: Report whether a tile level of detail is available to Cesium.
    getTileDataAvailable(x, y, level) {
        return level <= maxTerrainLevel;
    }

    // LUNA-DOC: Fetch a binary tile asynchronously and convert it into Cesium HeightmapTerrainData.
    requestTileGeometry(x, y, level, request) {
        const url = `/moon-terrain/${level}/${x}/${y}.bin`;
        const pending = Resource.fetchArrayBuffer({ url, request });

        return pending?.then((buffer) => {
            if (buffer.byteLength !== terrainSize * terrainSize * 2) {
                throw new Error(`Invalid lunar terrain tile: ${url}`);
            }

            const options = {
                buffer: new Uint8Array(buffer),
                width: terrainSize,
                height: terrainSize,
                structure: terrainStructure,
                childTileMask: level < maxTerrainLevel ? 15 : 0,
            };

            terrainHeightmaps.set(`${level}/${x}/${y}`, new HeightmapTerrainData(options));
            if (terrainHeightmaps.size > 128) {
                terrainHeightmaps.delete(terrainHeightmaps.keys().next().value);
            }

            return new HeightmapTerrainData(options);
        });
    }
}

const viewer = new Viewer('cesiumContainer', {
    globe: new Globe(ellipsoid),
    ellipsoid,
    terrainProvider: new MoonTerrainProvider(),
    baseLayer: false,
    baseLayerPicker: false,
    skyBox: SkyBox.createEarthSkyBox(),
    skyAtmosphere: false,
    geocoder: false,
    sceneModePicker: false,
    homeButton: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    animation: false,
    timeline: false,
    infoBox: false,
    selectionIndicator: false,
    shouldAnimate: false,
    requestRenderMode: true,
    maximumRenderTimeChange: Infinity,
});

const { scene, camera } = viewer;
viewer.screenSpaceEventHandler.removeInputAction(ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

viewer.resolutionScale = 0.9;
scene.globe.showGroundAtmosphere = false;
scene.globe.preloadAncestors = false;
scene.globe.tileCacheSize = 160;

const terrainToggle = document.querySelector('#terrain-toggle');
const terrainScale = 1.0001;

// LUNA-DOC: Enable or disable terrain rendering or change the scene's elevation source.
function updateTerrain() {
    const enabled = terrainToggle?.checked ?? true;
    scene.verticalExaggeration = enabled ? terrainScale : 0;
    scene.requestRender();
}

terrainToggle?.addEventListener('change', updateTerrain);
updateTerrain();

viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({
        url: '/moon-tiles-32k/{z}/{x}/{y}.webp',
        tilingScheme,
        tileWidth: 512,
        tileHeight: 512,
        maximumLevel: 5,
        credit: 'NASA SVS / LRO',
    }),
);

const hillshadeLayer = viewer.imageryLayers.addImageryProvider(
    new UrlTemplateImageryProvider({
        url: '/moon-hillshade/{z}/{x}/{y}.webp',
        tilingScheme,
        tileWidth: 512,
        tileHeight: 512,
        maximumLevel: 4,
        credit: 'NASA LRO / LOLA',
    }),
);

hillshadeLayer.alpha = 0.55;
const overviewError = 3;
const closeupError = 2;

const controller = scene.screenSpaceCameraController;
const groundClearance = 30;

camera.constrainedAxis = undefined;
controller.enableLook = false;
controller.enableZoom = false;
controller.enableRotate = false;
controller.enableTilt = false;
controller.enableCollisionDetection = true;
controller.minimumCollisionTerrainHeight = 35_000;
controller.minimumZoomDistance = groundClearance;
controller.maximumZoomDistance = 40 * radius;
controller.inertiaSpin = 0;

const modifiers = [
    undefined,
    KeyboardEventModifier.CTRL,
    KeyboardEventModifier.SHIFT,
    KeyboardEventModifier.ALT,
    [KeyboardEventModifier.CTRL, KeyboardEventModifier.SHIFT],
    [KeyboardEventModifier.CTRL, KeyboardEventModifier.ALT],
    [KeyboardEventModifier.SHIFT, KeyboardEventModifier.ALT],
    [KeyboardEventModifier.CTRL, KeyboardEventModifier.SHIFT, KeyboardEventModifier.ALT],
];

// LUNA-DOC: List mouse interaction events used for rotation and panning.
function cameraEvents(...eventTypes) {
    return eventTypes.flatMap(eventType => modifiers.map(modifier => ({ eventType, modifier })));
}

const cameraInput = new CameraEventAggregator(scene.canvas);
const leftDragEvents = cameraEvents(CameraEventType.LEFT_DRAG);
// LUNA-DOC: The hasShift helper checks modifier input; verify its call sites before changing it.
const hasShift = ({ modifier }) => [modifier].flat().includes(KeyboardEventModifier.SHIFT);
const leftOrbitEvents = leftDragEvents.filter(event => !hasShift(event));
const tiltEvents = [...leftDragEvents.filter(hasShift), ...cameraEvents(CameraEventType.RIGHT_DRAG)];
const zoomEvents = cameraEvents(CameraEventType.WHEEL, CameraEventType.PINCH);

scene.canvas.addEventListener('contextmenu', event => event.preventDefault());

let middlePointer;
let middlePan;

scene.canvas.addEventListener('pointerdown', event => {
    if (event.button !== 1 || !controller.enableInputs || middlePointer) return;
    event.preventDefault();
    scene.canvas.setPointerCapture(event.pointerId);
    middlePointer = {
        id: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        dragged: false,
    };
});

scene.canvas.addEventListener('pointermove', event => {
    const pointer = middlePointer;
    if (event.pointerId !== pointer?.id) return;
    if (!pointer.dragged) {
        if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) < 4) return;
        camera.cancelFlight();
        const rect = scene.canvas.getBoundingClientRect();
        const start = new Cartesian2(pointer.startX - rect.left, pointer.startY - rect.top);
        pointer.metresPerPixel = panScale(start);
        pointer.dragged = true;
    }

    middlePan ??= { right: 0, up: 0 };
    middlePan.right -= (event.clientX - pointer.x) * pointer.metresPerPixel;
    middlePan.up += (event.clientY - pointer.y) * pointer.metresPerPixel;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    scene.requestRender();
});

scene.canvas.addEventListener('pointerup', event => {
    if (event.pointerId !== middlePointer?.id || event.button !== 1) return;
    const isClick = !middlePointer.dragged;
    middlePointer = undefined;
    if (!isClick || !controller.enableInputs) return;

    const rect = scene.canvas.getBoundingClientRect();
    const position = new Cartesian2(event.clientX - rect.left, event.clientY - rect.top);
    if (!zoneMap.inspect(position)) selectMoonAt(position);
});

scene.canvas.addEventListener('lostpointercapture', event => {
    if (event.pointerId !== middlePointer?.id) return;
    middlePointer = undefined;
    middlePan = undefined;
});

scene.canvas.addEventListener('auxclick', event => {
    if (event.button === 1) event.preventDefault();
});

// LUNA-DOC: Accumulate cursor movements for one camera frame.
function readCameraMovement(events) {
    let dx = 0;
    let dy = 0;
    let position;

    for (const { eventType, modifier } of events) {
        if (!cameraInput.isMoving(eventType, modifier)) continue;

        const movement = cameraInput.getMovement(eventType, modifier);
        const { startPosition, endPosition } = movement.distance ?? movement;
        dx += endPosition.x - startPosition.x;
        dy += endPosition.y - startPosition.y;
        position = cameraInput.getStartMousePosition(eventType, modifier);
    }

    return dx || dy ? { dx, dy, position } : undefined;
}

const orbitAxis = new Cartesian3();
const verticalOrbitAxis = new Cartesian3();

// LUNA-DOC: Rotate the camera around the Moon without changing the object's coordinates.
function orbitMoon({ dx, dy }, heightAboveSurface) {
    // The rotation axis follows the screen, including after crossing a pole.
    Cartesian3.multiplyByScalar(camera.up, dx, orbitAxis);
    Cartesian3.multiplyByScalar(camera.right, dy, verticalOrbitAxis);
    Cartesian3.add(orbitAxis, verticalOrbitAxis, orbitAxis);
    Cartesian3.normalize(orbitAxis, orbitAxis);

    const viewportHeight = Math.max(1, scene.canvas.clientHeight);
    const radiansPerPixel = 2 * Math.tan(camera.frustum.fovy / 2) / viewportHeight;
    const sensitivity = Math.min(2.4, Math.max(groundClearance, heightAboveSurface) / radius);
    const angle = Math.hypot(dx, dy) * radiansPerPixel * sensitivity;
    camera.rotate(orbitAxis, angle);
}

// LUNA-DOC: Find a cached DEM elevation where available.
function getCachedTerrainHeight(position) {
    for (let level = maxTerrainLevel; level >= 0; level--) {
        const { x, y } = tilingScheme.positionToTileXY(position, level);
        const tile = terrainHeightmaps.get(`${level}/${x}/${y}`);
        if (!tile) continue;

        const rectangle = tilingScheme.tileXYToRectangle(x, y, level);
        return tile.interpolateHeight(rectangle, position.longitude, position.latitude);
    }
}

const maximumTerrainHeight =
    terrainStructure.highestEncodedHeight * terrainStructure.heightScale +
    terrainStructure.heightOffset;
const groundNormal = new Cartesian3();
const tiltDirection = new Cartesian3();
const tiltRight = new Cartesian3();
const tiltUp = new Cartesian3();
const tiltPosition = new Cartesian3();
const tiltCartographic = new Cartographic();
let tiltView;
const minimumHorizonRange = 600;
const zoomInward = new Cartesian3();
const zoomCenter = new Cartesian2();

// LUNA-DOC: Calculate camera viewing geometry near the surface at an oblique angle.
function findTiltView() {
    const screenCenter = new Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    const ray = camera.getPickRay(screenCenter);
    const position = camera.positionWC;
    let target = pickMoonPosition(screenCenter, ray);
    const normal = ellipsoid.geodeticSurfaceNormal(target ?? position, new Cartesian3());
    if (!target) {
        // Keep the focus on the current sight line when the view points beside the Moon.
        const depth = Math.max(groundClearance, camera.positionCartographic.height);
        target = Cartesian3.multiplyByScalar(camera.directionWC, depth, new Cartesian3());
        Cartesian3.add(position, target, target);
    }

    const forward = Cartesian3.subtract(target, position, new Cartesian3());
    const range = Math.max(groundClearance, Cartesian3.magnitude(forward));
    const rise = -Cartesian3.dot(forward, normal);
    Cartesian3.cross(forward, normal, tiltRight);
    Cartesian3.cross(normal, tiltRight, forward);
    const tangentRange = Cartesian3.magnitude(forward);
    const angle = CesiumMath.toDegrees(Math.atan2(rise, tangentRange));
    if (tangentRange < range * CesiumMath.EPSILON6) {
        // Use the camera's heading when its sight line is nearly vertical.
        Cartesian3.cross(normal, camera.rightWC, forward);
        if (Cartesian3.magnitudeSquared(forward) < 1e-6) {
            Cartesian3.cross(normal, camera.upWC, forward);
        }
    }
    Cartesian3.normalize(forward, forward);
    return { target, normal, forward, range, angle };
}

// LUNA-DOC: Zoom and tilt safely while respecting terrain clearance.
function tiltCamera({ dx, dy }) {
    camera.cancelFlight();
    tiltView ??= findTiltView();
    const { target, normal, forward, range } = tiltView;
    const degreesPerPixel = 180 / Math.max(1, scene.canvas.clientHeight);

    if (dx) {
        const headingChange = CesiumMath.toRadians(dx * degreesPerPixel);
        Cartesian3.cross(forward, normal, tiltRight);
        Cartesian3.multiplyByScalar(forward, Math.cos(headingChange), forward);
        Cartesian3.multiplyByScalar(tiltRight, Math.sin(headingChange), tiltRight);
        Cartesian3.normalize(Cartesian3.add(forward, tiltRight, forward), forward);
    }
    if (dy) {
        tiltView.angle = CesiumMath.clamp(tiltView.angle + dy * degreesPerPixel, 0, 90);
    }

    const angle = CesiumMath.toRadians(tiltView.angle);
    const elevation = Math.sin(angle);
    // Leave room to see along the horizon even when a small zone fills the screen.
    const distance = dy
        ? Math.max(range, minimumHorizonRange * (1 - elevation))
        : Cartesian3.distance(camera.positionWC, target);
    Cartesian3.multiplyByScalar(forward, -distance * Math.cos(angle), tiltDirection);
    Cartesian3.multiplyByScalar(normal, distance * elevation, tiltUp);
    Cartesian3.add(target, tiltDirection, tiltPosition);
    Cartesian3.add(tiltPosition, tiltUp, tiltPosition);
    const position = ellipsoid.cartesianToCartographic(tiltPosition, tiltCartographic);
    const minimumHeight = minimumCameraHeight(position, highestRenderedSurface());
    if (position.height < minimumHeight) {
        position.height = minimumHeight;
        ellipsoid.cartographicToCartesian(position, tiltPosition);
    }
    Cartesian3.normalize(Cartesian3.subtract(target, tiltPosition, tiltDirection), tiltDirection);
    Cartesian3.cross(forward, normal, tiltRight);
    Cartesian3.cross(tiltRight, tiltDirection, tiltUp);
    camera.setView({ destination: tiltPosition, orientation: { direction: tiltDirection, up: tiltUp } });
}

// LUNA-DOC: Get terrain height from the provider or use a fallback value.
function getSurfaceHeight(position, highestSurface) {
    const scale = scene.verticalExaggeration;
    const reference = scene.verticalExaggerationRelativeHeight;
    if (scale === 0) return reference;

    const renderedHeight = scene.globe.getHeight(position);
    const rawHeight = getCachedTerrainHeight(position);
    if (rawHeight === undefined) return renderedHeight ?? highestSurface;

    const cachedSurface = reference + (rawHeight - reference) * scale;
    return Math.max(cachedSurface, renderedHeight ?? cachedSurface);
}

// LUNA-DOC: Compute the maximum visible terrain elevation to constrain the camera.
function highestRenderedSurface() {
    const scale = scene.verticalExaggeration;
    const reference = scene.verticalExaggerationRelativeHeight;
    return reference + (maximumTerrainHeight - reference) * scale;
}

// LUNA-DOC: Constrain the camera so it cannot move through the DEM surface.
function minimumCameraHeight(position, highestSurface) {
    if (position.height >= highestSurface + groundClearance) return Number.NEGATIVE_INFINITY;
    return getSurfaceHeight(position, highestSurface) + groundClearance;
}

// LUNA-DOC: Determine the coordinates clicked by the user in the scene.
function pickMoonPosition(position, ray) {
    if (!ray) return;

    let hit = scene.globe.pick(ray, scene);
    if (!hit && scene.pickPositionSupported) {
        const depthPosition = scene.pickPosition(position);
        if (depthPosition && Cartesian3.magnitude(depthPosition) < radius + maximumTerrainHeight + 1) {
            hit = depthPosition;
        }
    }

    return hit ?? camera.pickEllipsoid(position, ellipsoid);
}

// LUNA-DOC: Select the zoom focal point for a mouse-wheel event.
function findZoomTarget(position) {
    if (!position) return;

    const ray = camera.getPickRay(position);
    const point = pickMoonPosition(position, ray);
    if (point) return { ray, point };
}

// LUNA-DOC: Calculate pan displacement based on camera altitude.
function panScale(position) {
    const target = findZoomTarget(position);
    let depth = camera.positionCartographic.height;
    if (target) {
        const toTarget = Cartesian3.subtract(target.point, camera.positionWC, new Cartesian3());
        depth = Cartesian3.dot(toTarget, camera.directionWC);
    }
    const viewportHeight = Math.max(1, scene.canvas.clientHeight);
    return 2 * Math.max(groundClearance, depth) * Math.tan(camera.frustum.fovy / 2) / viewportHeight;
}

// LUNA-DOC: Move the camera toward the selected zoom target.
function zoomToward(input, heightAboveSurface) {
    const { canvas } = scene;
    zoomCenter.x = canvas.clientWidth / 2;
    zoomCenter.y = canvas.clientHeight / 2;

    const target = findZoomTarget(input.position) ?? findZoomTarget(zoomCenter);
    ellipsoid.geodeticSurfaceNormal(camera.positionWC, groundNormal);

    const direction = target
        ? target.ray.direction
        : Cartesian3.negate(groundNormal, zoomInward);
    const distance = target
        ? Cartesian3.distance(target.ray.origin, target.point)
        : Math.max(groundClearance, heightAboveSurface);
    const exponent = CesiumMath.clamp(
        6 * input.dy / Math.max(1, canvas.clientHeight),
        -0.6,
        0.6,
    );
    let travel = -distance * Math.expm1(-exponent);

    if (travel > 0) {
        const inwardRate = -Cartesian3.dot(direction, groundNormal);
        const availableHeight = Math.max(0, heightAboveSurface - groundClearance);
        const heightLimit = inwardRate > 0
            ? availableHeight / inwardRate
            : Number.POSITIVE_INFINITY;

        travel = Math.min(travel, Math.max(0, distance - groundClearance), heightLimit);
    }

    if (Math.abs(travel) <= 0.001) return false;

    camera.move(direction, travel);
    return true;
}

scene.postUpdate.addEventListener(() => {
    const pan = middlePan;
    middlePan = undefined;
    const orbit = readCameraMovement(leftOrbitEvents);
    const tilt = readCameraMovement(tiltEvents);
    const zoom = readCameraMovement(zoomEvents);
    cameraInput.reset();
    if (!controller.enableInputs) return;

    let position = camera.positionCartographic;
    if (!position) return;

    const highestSurface = highestRenderedSurface();

    if (!pan && !orbit && !tilt && !zoom?.dy && position.height >= highestSurface + groundClearance) return;

    let moved = false;
    if (pan) {
        tiltView = undefined;
        camera.moveRight(pan.right);
        camera.moveUp(pan.up);
        position = camera.positionCartographic;
        moved = true;
    }
    if (tilt) {
        tiltCamera(tilt);
        position = camera.positionCartographic;
        moved = true;
    }
    if (orbit) {
        tiltView = undefined;
        orbitMoon(orbit, position.height - getSurfaceHeight(position, highestSurface));
        position = camera.positionCartographic;
        moved = true;
    }
    if (zoom?.dy) {
        tiltView = undefined;
        const surfaceHeight = getSurfaceHeight(position, highestSurface);
        moved = zoomToward(zoom, position.height - surfaceHeight) || moved;
        position = camera.positionCartographic;
    }

    const minHeight = minimumCameraHeight(position, highestSurface);
    const maxHeight = (pan || tilt?.dx) && !zoom?.dy ? Number.POSITIVE_INFINITY : controller.maximumZoomDistance;
    const nextHeight = CesiumMath.clamp(position.height, minHeight, maxHeight);
    const correction = nextHeight - position.height;

    if (Math.abs(correction) > 0.001) {
        ellipsoid.geodeticSurfaceNormal(camera.positionWC, groundNormal);
        camera.move(groundNormal, correction);
        moved = true;
    }

    if (moved) {
        // Use fewer tiles during a gesture and refine the stationary view.
        if (pan || orbit || tilt || zoom?.dy) scene.globe.maximumScreenSpaceError = overviewError;
        scene.requestRender();
    }
});

// LUNA-DOC: Update the level of detail of visible lunar tiles.
function updateTileDetail() {
    const height = camera.positionCartographic.height;

    scene.globe.maximumScreenSpaceError = height > 750_000 ? overviewError : closeupError;
    hillshadeLayer.alpha = CesiumMath.lerp(0.6, 0.4, CesiumMath.clamp(height / 750_000, 0, 1));

    scene.requestRender();
}

camera.moveEnd.addEventListener(updateTileDetail);

const ephemeris = initLunarEphemeris(viewer, ellipsoid, hillshadeLayer, terrainToggle);
const missionMarkers = initMissionMarkers(viewer);
document.querySelector('.body-view-buttons').addEventListener('click', event => {
    if (event.target.closest('button')) tiltView = undefined;
});
const locationPanel = document.getElementById('location_panel');
const coordinateForm = document.getElementById('coordinate-form');
const latitudeCoordinate = document.querySelector('#latitude-coordinate');
const longitudeCoordinate = document.querySelector('#longitude-coordinate');
const coordinateStatus = document.getElementById('coordinate-status');
const pointModeButton = document.getElementById('location-mode-point');
const zoneModeButton = document.getElementById('location-mode-zone');
const radiusField = document.getElementById('zone-radius-field');
const radiusInput = document.getElementById('zone-radius-km');
const coordinateSubmit = coordinateForm.querySelector('button[type="submit"]');
const maxZoneRadiusKm = Math.floor(Math.PI * radius / 2 / 1000);
radiusInput.max = String(maxZoneRadiusKm);
let zoneMode = false;
let selectedPoint;
let zoneOutline;

const marker = viewer.entities.add({
    show: false,
    point: {
        pixelSize: 10,
        color: Color.ORANGE,
        outlineColor: Color.BLACK,
        outlineWidth: 1,
        heightReference: HeightReference.CLAMP_TO_TERRAIN,
    },
});

const zoneColor = Color.fromCssColorString('#ffb54d');
const zone = viewer.entities.add({
    show: false,
    polyline: {
        material: zoneColor,
        width: 2,
        clampToGround: true,
        classificationType: ClassificationType.TERRAIN,
    },
});
const zoneMap = initLunarZone(viewer, ellipsoid,
    position => pickMoonPosition(position, camera.getPickRay(position)),
    visible => {
        zone.show = visible;
    },
);

// LUNA-DOC: Update latitude and longitude status in the interface.
function setCoordinateStatus(message, isError = false) {
    coordinateStatus.textContent = message;
    coordinateStatus.dataset.error = String(isError);
}

// LUNA-DOC: Validate zone radius input and convert units.
function readZoneRadius() {
    if (!zoneMode) return null;
    const value = radiusInput.valueAsNumber;
    if (value >= 0.001 && value <= maxZoneRadiusKm) {
        radiusInput.removeAttribute('aria-invalid');
        return value * 1000;
    }
    radiusInput.setAttribute('aria-invalid', 'true');
    setCoordinateStatus(`Enter a radius from 0.001 to ${maxZoneRadiusKm} km.`, true);
    return undefined;
}

// LUNA-DOC: Send selected coordinates to the calculation modules.
function publishLocation() {
    const radiusMeters = readZoneRadius();
    if (!selectedPoint || radiusMeters === undefined) {
        ephemeris.setPoint(null);
        zoneMap.setLocation(null, zoneMode);
        return;
    }
    const { lat, lon, height_m } = selectedPoint;
    const selection = { lat, lon, height_m };
    if (radiusMeters !== null) selection.radius_m = radiusMeters;
    zoneMap.setLocation(selection, zoneMode);
    ephemeris.setPoint(zoneMode ? null : selection);
    viewer.container.dispatchEvent(new CustomEvent('moon-location-change', { detail: selection }));
}

// LUNA-DOC: Render the selected zone boundary geometry.
function drawZone() {
    const radiusMeters = readZoneRadius();
    zoneOutline = undefined;
    if (selectedPoint && radiusMeters) {
        const { lat, lon } = selectedPoint;
        const latitude = CesiumMath.toRadians(lat);
        const longitude = CesiumMath.toRadians(lon);
        const center = Cartesian3.fromRadians(longitude, latitude, 0, ellipsoid);
        Cartesian3.normalize(center, center);
        const east = new Cartesian3(-Math.sin(longitude), Math.cos(longitude), 0);
        const north = Cartesian3.cross(center, east, new Cartesian3());
        const angle = radiusMeters / radius;
        const centerPart = Cartesian3.multiplyByScalar(center, Math.cos(angle), new Cartesian3());
        const ring = [];

        for (let i = 0; i < 96; i++) {
            const bearing = i * 2 * Math.PI / 96;
            const position = Cartesian3.multiplyByScalar(north, Math.sin(angle) * Math.cos(bearing), new Cartesian3());
            Cartesian3.add(position, Cartesian3.multiplyByScalar(east, Math.sin(angle) * Math.sin(bearing), new Cartesian3()), position);
            Cartesian3.add(position, centerPart, position);
            ring.push(Cartesian3.multiplyByScalar(position, radius, position));
        }

        zone.polyline.positions = [...ring, ring[0]];
        zoneOutline = ring;
    }
    scene.requestRender();
}

// LUNA-DOC: Switch between Point and Zone modes and their inputs.
function setLocationMode(useZone) {
    zoneMode = useZone;
    pointModeButton.setAttribute('aria-pressed', String(!zoneMode));
    zoneModeButton.setAttribute('aria-pressed', String(zoneMode));
    radiusField.hidden = !zoneMode;
    radiusInput.disabled = !zoneMode;
    coordinateSubmit.textContent = zoneMode ? 'Go to zone' : 'Go to point';
    setCoordinateStatus('');
    drawZone();
    publishLocation();
}

pointModeButton.addEventListener('click', () => setLocationMode(false));
zoneModeButton.addEventListener('click', () => setLocationMode(true));
radiusInput.addEventListener('input', () => {
    setCoordinateStatus('');
    drawZone();
    publishLocation();
});

// LUNA-DOC: Move the camera toward the selected location.
function focusLocation(point) {
    const radiusMeters = readZoneRadius();
    if (radiusMeters === undefined) return;
    tiltView = undefined;
    if (radiusMeters >= 400_000 && zoneOutline) {
        const extent = BoundingSphere.fromPoints(zoneOutline);
        camera.flyToBoundingSphere(extent, {
            offset: new HeadingPitchRange(0, -Math.PI / 2, 3.4 * extent.radius),
            duration: 0.75,
        });
        return;
    }
    const ground = scene.verticalExaggeration * point.height_m;
    const altitude = radiusMeters === null ? radius * 0.85 : ground + Math.max(40, radiusMeters * 4.1);
    const destination = Cartesian3.fromDegrees(point.lon, point.lat, altitude, ellipsoid);
    camera.flyTo({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        duration: 0.75,
    });
}

// LUNA-DOC: Centralized point selection, also used when clicking mission markers.
function setPoint(latitude, longitude, height, flyToPoint = false) {
    if (readZoneRadius() === undefined) {
        radiusInput.focus();
        return;
    }
    const coordinates = Cartographic.fromDegrees(longitude, latitude);
    const cachedHeight = getCachedTerrainHeight(coordinates);
    const point = { lat: latitude, lon: longitude, height_m: cachedHeight ?? height ?? 0 };
    selectedPoint = point;

    marker.position = ellipsoid.cartographicToCartesian(coordinates);
    marker.show = true;
    latitudeCoordinate.value = latitude.toFixed(6);
    longitudeCoordinate.value = longitude.toFixed(6);
    latitudeCoordinate.removeAttribute('aria-invalid');
    longitudeCoordinate.removeAttribute('aria-invalid');
    setCoordinateStatus('');
    drawZone();
    publishLocation();

    const waitForHeight = flyToPoint && zoneMode && cachedHeight === undefined;
    if (flyToPoint && !waitForHeight) focusLocation(point);

    if (cachedHeight === undefined) {
        sampleTerrain(viewer.terrainProvider, maxTerrainLevel, [coordinates])
            .then(([sample]) => {
                if (selectedPoint !== point) return;
                if (Number.isFinite(sample.height) && sample.height !== point.height_m) {
                    point.height_m = sample.height;
                    publishLocation();
                }
            })
            .catch(() => {})
            .finally(() => {
                if (waitForHeight && zoneMode && selectedPoint === point) focusLocation(point);
            });
    }
    scene.requestRender();
}

// LUNA-DOC: Read and validate latitude and longitude input fields.
function readCoordinate(value, limit, positiveHemisphere, negativeHemisphere) {
    const text = value.trim().replace('−', '-').replace(',', '.');
    const parts = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*°?\s*([NSEW])?$/i.exec(text);
    if (!parts) return undefined;

    const [, number, direction] = parts;
    const coordinate = Number(number);
    if (Math.abs(coordinate) > limit) return undefined;
    if (!direction) return coordinate;

    const hemisphere = direction.toUpperCase();
    if (hemisphere === negativeHemisphere && !number.startsWith('+')) return -Math.abs(coordinate);
    if (hemisphere === positiveHemisphere && !number.startsWith('-')) return coordinate;
    return undefined;
}

coordinateForm.addEventListener('input', event => {
    if (event.target === radiusInput && radiusInput.getAttribute('aria-invalid') === 'true') return;
    event.target.removeAttribute('aria-invalid');
    setCoordinateStatus('');
});

coordinateForm.addEventListener('submit', event => {
    event.preventDefault();
    const latitude = readCoordinate(latitudeCoordinate.value, 90, 'N', 'S');
    const longitude = readCoordinate(longitudeCoordinate.value, 180, 'E', 'W');
    if (latitude === undefined || longitude === undefined) {
        latitudeCoordinate.setAttribute('aria-invalid', String(latitude === undefined));
        longitudeCoordinate.setAttribute('aria-invalid', String(longitude === undefined));
        setCoordinateStatus(
            latitude === undefined ? 'Enter latitude from −90° to 90°.' : 'Enter longitude from −180° to 180°.',
            true,
        );
        (latitude === undefined ? latitudeCoordinate : longitudeCoordinate).focus();
        return;
    }
    setPoint(latitude, longitude, undefined, true);
});

// LUNA-DOC: Handle location selection on the 3D Moon.
function selectMoonAt(position) {
    if (!locationPanel.open) return;
    const hit = pickMoonPosition(position, camera.getPickRay(position));
    if (!hit) return;

    const coordinates = ellipsoid.cartesianToCartographic(hit);
    setPoint(
        CesiumMath.toDegrees(coordinates.latitude),
        CesiumMath.toDegrees(coordinates.longitude),
        coordinates.height,
    );
}

viewer.screenSpaceEventHandler.setInputAction(({ position }) => {
    const canvasRect = scene.canvas.getBoundingClientRect();
    // A mission click has the same effect as choosing a lunar point: it uses
    // the existing setPoint() -> publishLocation() -> backend calculation flow.
    const mission = missionMarkers.pick(position);
    if (mission) {
        setLocationMode(false);
        // The timeline owns the selected instant: send one event rather than
        // modifying the UTC controls and the physics engine independently.
        // Future/illustrative missions must preserve the user's chosen time.
        if (mission.status === 'completed' && typeof mission.landing_utc === 'string') {
            viewer.container.dispatchEvent(new CustomEvent('luna-mission-time-select', {
                detail: { utc: mission.landing_utc },
            }));
        }
        setPoint(mission.latitude, mission.longitude);
        missionMarkers.inspect(position, canvasRect.left + position.x, canvasRect.top + position.y);
        return;
    }
    if (!zoneMap.inspect(position)) selectMoonAt(position);
}, ScreenSpaceEventType.LEFT_CLICK);

updateTileDetail();
// Charts need both real data providers; omitting the third argument kept
// Open charts permanently hidden even with Advanced mode enabled.
initSimulationUi(viewer, (utc, overview, range) => {
    ephemeris.setTime(utc, overview, range);
    zoneMap.setTime(utc);
}, {
    loadHistory: (signal) => ephemeris.loadHistory(signal),
    zoneChart: () => zoneMap.getChart(),
});
