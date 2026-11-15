// LUNA-DOC: Zone 3D surface geometry in Cesium: vertices, triangles, colors, and camera placement.
// LUNA-DOC: DEM elevation and physical metric value are distinct quantities with different units.
import {
    BoundingSphere, Cartesian3, CesiumWidget, Color, ComponentDatatype, DirectionalLight, Ellipsoid,
    Geometry, GeometryAttribute, GeometryInstance, GeometryPipeline, HeadingPitchRange, Material,
    MaterialAppearance, Matrix4, Primitive, PrimitiveType, Transforms,
} from 'cesium';

// LUNA-DOC: Build 3D surface vertices and triangles from the geodesic grid.
function createSurface(zone) {
    const { center, grid_size: size, step_m: step, radius_m: radius } = zone.grid;
    const samples = size * size;
    if (!Number.isInteger(size) || size < 2 || zone.values.length !== samples) return null;

    const positions = new Float64Array(samples * 3);
    const coordinates = new Float32Array(samples * 2);
    const vertexIndices = new Int32Array(samples).fill(-1);
    const image = document.createElement('canvas');
    image.width = image.height = size;
    const context = image.getContext('2d');
    const pixels = context.createImageData(size, size);
    const middle = (size - 1) / 2;
    const heightScale = radius * 0.4 / (zone.max - zone.min || 1);
    let vertices = 0;

    for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
            const sample = row * size + column;
            const value = zone.values[sample];
            const height = (value - zone.min) * heightScale;
            if (!Number.isFinite(value) || !Number.isFinite(height)) continue;

            const east = (column - middle) * step;
            const north = (middle - row) * step;
            const vertex = vertices++;
            vertexIndices[sample] = vertex;
            positions.set([east, north, height], vertex * 3);
            coordinates.set([column / (size - 1), 1 - row / (size - 1)], vertex * 2);
            pixels.data.set([...zone.colourAt(value), 255], sample * 4);
        }
    }

    const indices = [];
    for (let row = 0; row < size - 1; row++) {
        for (let column = 0; column < size - 1; column++) {
            const top = row * size + column;
            const a = vertexIndices[top], b = vertexIndices[top + 1];
            const c = vertexIndices[top + size], d = vertexIndices[top + size + 1];
            if (a >= 0 && c >= 0 && b >= 0) indices.push(a, c, b);
            if (b >= 0 && c >= 0 && d >= 0) indices.push(b, c, d);
        }
    }
    if (!indices.length) return null;
    context.putImageData(pixels, 0, 0);

    const surfacePositions = positions.subarray(0, vertices * 3);
    const geometry = GeometryPipeline.computeNormal(new Geometry({
        attributes: {
            position: new GeometryAttribute({
                componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: surfacePositions,
            }),
            st: new GeometryAttribute({
                componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2,
                values: coordinates.subarray(0, vertices * 2),
            }),
        },
        indices: vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(surfacePositions),
    }));

    const origin = Cartesian3.fromDegrees(center.lon, center.lat, 0, Ellipsoid.MOON);
    const modelMatrix = Transforms.eastNorthUpToFixedFrame(origin, Ellipsoid.MOON);
    return {
        image,
        instance: new GeometryInstance({ geometry, modelMatrix }),
        bounds: BoundingSphere.transform(geometry.boundingSphere, modelMatrix),
    };
}

// LUNA-DOC: Create a temporary 3D view of the zone with a defined camera position.
export function showZoneSurface(container, zone) {
    const surface = createSurface(zone);
    if (!surface) throw new Error('There are insufficient samples for a 3D surface in this zone.');

    const widget = new CesiumWidget(container, {
        ellipsoid: Ellipsoid.MOON,
        globe: false,
        skyBox: false,
        skyAtmosphere: false,
        scene3DOnly: true,
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
    });
    try {
        const { scene, camera } = widget;
        scene.backgroundColor = Color.fromCssColorString('#11141a');
        const light = Matrix4.multiplyByPointAsVector(
            surface.instance.modelMatrix, new Cartesian3(0.6, -0.45, -0.8), new Cartesian3(),
        );
        scene.light = new DirectionalLight({ direction: Cartesian3.normalize(light, light) });
        scene.primitives.add(new Primitive({
            geometryInstances: surface.instance,
            appearance: new MaterialAppearance({
                material: Material.fromType(Material.ImageType, { image: surface.image }),
                translucent: false,
                faceForward: true,
            }),
            asynchronous: false,
            allowPicking: false,
        }));

        widget.resize();
        const frustum = camera.frustum;
        const halfAngle = Math.atan(Math.tan(frustum.fovy / 2) * Math.min(1, frustum.aspectRatio));
        const distance = Math.max(4, 1.15 * surface.bounds.radius / Math.sin(halfAngle));
        camera.lookAt(surface.bounds.center, new HeadingPitchRange(-Math.PI / 5, -Math.PI / 4, distance));
        const controls = scene.screenSpaceCameraController;
        controls.enableCollisionDetection = false;
        controls.enableTranslate = false;
        controls.enableTilt = false;
        controls.enableLook = false;
        controls.minimumZoomDistance = Math.max(2, surface.bounds.radius * 0.3);
        controls.maximumZoomDistance = distance * 8;
        scene.requestRender();
    } catch (error) {
        widget.destroy();
        throw error;
    }
    return widget;
}
