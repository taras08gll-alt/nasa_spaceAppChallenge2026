# LUNA-DOC: SPICE ephemerides: Sun/Earth positions, illumination, and geometry in the MOON_ME reference frame.
# LUNA-DOC: External SPICE kernels are downloaded separately; missing kernel files can cause HTTP 503.
# LUNA-DOC: All timestamps from the frontend are treated as UTC; keep coordinate frames, vectors, and distance units consistent.
from base64 import b64encode
from datetime import UTC, datetime, timedelta
from math import asin, atan2, degrees, hypot, isfinite, pi, sqrt
from pathlib import Path
from struct import pack
from threading import Lock
from zlib import compress, crc32

import numpy as np
import spiceypy as spice
from flask import Blueprint, current_app, jsonify, request
from spiceypy.utils.exceptions import SpiceyError

FRAME = "MOON_ME"
MOON_RADIUS_M = 1_737_400.0
SUN_RADIUS_M = 695_700_000.0
EARTH_RADIUS_M = 6_371_000.0
MIN_UTC = datetime(1550, 1, 1, tzinfo=UTC)
MAX_UTC = datetime(2650, 1, 24, tzinfo=UTC)

KERNEL_DIR = Path(__file__).resolve().parent / "kernels"
KERNEL_NAMES = (
    "naif0012.tls",
    "de440.bsp",
    "moon_de440_250416.tf",
    "moon_pa_de440_200625.bpc",
    "pck00011.tpc",
)

ECLIPSE_WIDTH, ECLIPSE_HEIGHT = 512, 256
_LON = (np.arange(ECLIPSE_WIDTH) + 0.5) * 2 * pi / ECLIPSE_WIDTH - pi
_LAT = pi / 2 - (np.arange(ECLIPSE_HEIGHT) + 0.5) * pi / ECLIPSE_HEIGHT
_SURFACE_NORMALS = np.stack((
    np.cos(_LAT[:, None]) * np.cos(_LON),
    np.cos(_LAT[:, None]) * np.sin(_LON),
    np.broadcast_to(np.sin(_LAT[:, None]), (ECLIPSE_HEIGHT, ECLIPSE_WIDTH)),
), axis=-1)
_QUAD_POINTS, _QUAD_WEIGHTS = np.polynomial.legendre.leggauss(24)

motion_api = Blueprint("motion", __name__)
_spice_lock = Lock()
_kernels_loaded = False


# LUNA-DOC: Initialize SPICE kernels once per process under a lock.
def _load_kernels_locked():
    global _kernels_loaded
    if _kernels_loaded:
        return

    paths = [KERNEL_DIR / name for name in KERNEL_NAMES]
    missing = [path.name for path in paths if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing SPICE kernels: " + ", ".join(missing))

    loaded = []
    try:
        for path in paths:
            spice.furnsh(str(path))
            loaded.append(path)
    except SpiceyError:
        for path in reversed(loaded):
            spice.unload(str(path))
        raise

    _kernels_loaded = True


# LUNA-DOC: Parse timestamps as UTC and enforce the supported time range.
def parse_lunar_utc(utc: str | datetime) -> datetime:
    if isinstance(utc, str):
        try:
            utc = datetime.fromisoformat(utc)
        except ValueError:
            raise ValueError("Use an ISO timestamp such as 2026-11-13T12:00:00Z.") from None
    if not isinstance(utc, datetime) or utc.utcoffset() is None:
        raise ValueError("Include a timezone such as Z for UTC.")

    utc = utc.astimezone(UTC)
    if not MIN_UTC <= utc <= MAX_UTC:
        raise ValueError("Use dates from 1550-01-01 to 2650-01-24 00:00 UTC.")
    return utc


# LUNA-DOC: Retrieve celestial-body positions for scene rendering and insolation calculations.
def _observed_positions(epochs):
    sun, _ = spice.spkpos("SUN", epochs, FRAME, "CN", "MOON")
    earth, earth_light_time = spice.spkpos("EARTH", epochs, FRAME, "CN", "MOON")
    return sun * 1000, earth * 1000, earth_light_time


# LUNA-DOC: Prepare ephemeris vectors for a UTC instant in the lunar reference frame.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
def lunar_ephemeris(utc: str | datetime, *, include_eclipse_mask=False) -> dict:
    """Positions in metres at the selected time."""
    utc = parse_lunar_utc(utc)

    with _spice_lock:
        _load_kernels_locked()
        et = spice.utc2et(utc.strftime("%Y-%m-%dT%H:%M:%S.%f"))
        sun, earth, earth_light_time = _observed_positions(et)
        rotation = spice.pxfrm2("IAU_EARTH", FRAME, et - earth_light_time, et)
        barycentric = {}
        for body in ("SUN", "EARTH", "MOON"):
            position, _ = spice.spkpos(body, et, "J2000", "NONE", "0")
            barycentric[body.lower()] = (position * 1000).tolist()

    state = {
        "utc": utc.isoformat().replace("+00:00", "Z"),
        "frame": FRAME,
        "moon_m": [0, 0, 0],
        "sun_m": sun.tolist(),
        "earth_m": earth.tolist(),
        "earth_rotation": rotation.ravel().tolist(),
        "barycentric_j2000_m": barycentric,
    }
    if include_eclipse_mask:
        state["eclipse"] = eclipse_png(state)
    return state


# LUNA-DOC: Calculate directions toward Earth and Sun for lunar geometry.
def lunar_vectors(times):
    """Apparent Moon-fixed positions in metres for a UTC time series."""
    with _spice_lock:
        _load_kernels_locked()
        epochs = [spice.utc2et(utc.strftime("%Y-%m-%dT%H:%M:%S.%f")) for utc in times]
        sun, earth, _ = _observed_positions(epochs)
    return sun, earth


# LUNA-DOC: Prepare illumination responses for the frontend.
def lighting_response(values):
    """Return [Sun, Earth, Earth rotation] for every discrete slider position."""
    try:
        start = parse_lunar_utc(values.get("start_utc"))
        end = parse_lunar_utc(values.get("end_utc"))
        step_minutes = values.get("step_minutes")
        if start >= end or type(step_minutes) is not int or step_minutes <= 0:
            raise ValueError("Send increasing UTC dates and a positive timeline step in minutes.")

        step = timedelta(minutes=step_minutes)
        whole_steps, remainder = divmod(end - start, step)
        if whole_steps + bool(remainder) > 1440:
            raise ValueError("Use up to 1440 timeline intervals.")
        times = [start + step * index for index in range(whole_steps + 1)]
        if remainder:
            times.append(end)

        with _spice_lock:
            _load_kernels_locked()
            epochs = [spice.utc2et(utc.strftime("%Y-%m-%dT%H:%M:%S.%f")) for utc in times]
            sun, earth, light_times = _observed_positions(epochs)
            rotations = [
                spice.pxfrm2("IAU_EARTH", FRAME, et - light_time, et).ravel().tolist()
                for et, light_time in zip(epochs, light_times, strict=True)
            ]
    except (OSError, SpiceyError):
        current_app.logger.exception("Lunar lighting unavailable")
        return jsonify(error="Lunar lighting unavailable. Check the server's SPICE kernels."), 503
    except (TypeError, ValueError, OverflowError) as error:
        return jsonify(error=str(error)), 422

    return jsonify(frame=FRAME, frames=list(zip(sun.tolist(), earth.tolist(), rotations, strict=True)))


# LUNA-DOC: Calculate geometric relationships from a specified observer's viewpoint.
def _observer_vectors(state, surface_m):
    sun = np.asarray(state["sun_m"]) - surface_m
    earth = np.asarray(state["earth_m"]) - surface_m
    return sun, earth


# LUNA-DOC: Estimate the fraction of the solar disk occulted by Earth.
def earth_occlusion_fraction(to_sun, to_earth):
    """The apparent fraction of a uniform solar disc behind a spherical Earth."""
    sun_range = np.linalg.norm(to_sun, axis=-1)
    earth_range = np.linalg.norm(to_earth, axis=-1)
    sun_radius = np.arcsin(np.minimum(1.0, SUN_RADIUS_M / np.maximum(sun_range, SUN_RADIUS_M)))
    earth_radius = np.arcsin(np.minimum(1.0, EARTH_RADIUS_M / np.maximum(earth_range, EARTH_RADIUS_M)))
    separation = np.arctan2(
        np.linalg.norm(np.cross(to_sun, to_earth), axis=-1),
        np.sum(to_sun * to_earth, axis=-1),
    )
    sd, er, sr = np.broadcast_arrays(separation, earth_radius, sun_radius)
    covered = np.zeros_like(sd)
    overlaps = (earth_range < sun_range) & (sd < er + sr)
    nested = overlaps & (sd <= np.abs(er - sr))
    covered[nested] = np.minimum(1.0, (er[nested] / sr[nested])**2)

    partial = overlaps & ~nested
    d, e, s = sd[partial], er[partial], sr[partial]
    sun_cos = np.clip((d**2 + s**2 - e**2) / (2 * d * s), -1.0, 1.0)
    earth_cos = np.clip((d**2 + e**2 - s**2) / (2 * d * e), -1.0, 1.0)
    triangle = np.maximum(0.0, (-d + e + s) * (d + e - s) * (d - e + s) * (d + e + s))
    overlap = s**2 * np.arccos(sun_cos) + e**2 * np.arccos(earth_cos) - 0.5 * np.sqrt(triangle)
    covered[partial] = np.clip(overlap / (pi * s**2), 0.0, 1.0)
    return covered


# LUNA-DOC: Quickly reject configurations where a solar occultation is impossible.
def eclipse_possible(sun, earth, observer_radius_m=MOON_RADIUS_M + 20_000):
    """Conservative overlap test for observers anywhere on or near the Moon."""
    separation = np.arctan2(
        np.linalg.norm(np.cross(sun, earth), axis=-1),
        np.sum(sun * earth, axis=-1),
    )
    outer_angle = (
        np.arcsin((SUN_RADIUS_M + observer_radius_m) / np.linalg.norm(sun, axis=-1))
        + np.arcsin((EARTH_RADIUS_M + observer_radius_m) / np.linalg.norm(earth, axis=-1))
    )
    return separation < outer_angle


# LUNA-DOC: Generate a PNG occultation mask or visualization from body geometry.
def eclipse_png(state):
    """A geographic PNG alpha mask of Earth's shadow in MOON_ME."""
    sun = np.asarray(state["sun_m"])
    earth = np.asarray(state["earth_m"])
    if not eclipse_possible(sun, earth, MOON_RADIUS_M):
        return None

    normals = _SURFACE_NORMALS
    to_sun, to_earth = _observer_vectors(state, MOON_RADIUS_M * normals)
    blocked = earth_occlusion_fraction(to_sun, to_earth)
    horizon = np.clip(np.sum(normals * to_sun, axis=-1) / SUN_RADIUS_M, -1.0, 1.0)
    above_horizon = 0.5 + (np.arcsin(horizon) + horizon * np.sqrt(1.0 - horizon**2)) / pi
    alpha = np.rint(blocked * above_horizon * 255).astype(np.uint8)
    if not alpha.any():
        return None

    # A copper tint approximates the light filtered through Earth's atmosphere.
    rows = np.zeros((ECLIPSE_HEIGHT, 1 + 4 * ECLIPSE_WIDTH), dtype=np.uint8)
    rgba = rows[:, 1:].reshape(ECLIPSE_HEIGHT, ECLIPSE_WIDTH, 4)
    rgba[..., :3] = (40, 12, 7)
    rgba[..., 3] = alpha

    # LUNA-DOC: The chunk helper partitions a sequence; consult the implementation for details.
    def chunk(kind, data):
        return pack(">I", len(data)) + kind + data + pack(">I", crc32(kind + data))

    header = pack(">IIBBBBB", ECLIPSE_WIDTH, ECLIPSE_HEIGHT, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", compress(rows.tobytes(), level=3))
        + chunk(b"IEND", b"")
    )
    return b64encode(png).decode("ascii")


# LUNA-DOC: Integrate the visible disk segment geometrically.
def _visible_width_integral(cutoff, earth_x, earth_y, earth_radius):
    """Area of a unit solar disc above a horizon and outside Earth's disc."""
    d = hypot(earth_x, earth_y)
    limits = [cutoff, 1.0, earth_y - earth_radius, earth_y + earth_radius]
    if abs(1.0 - earth_radius) < d < 1.0 + earth_radius:
        along = (d**2 + 1.0 - earth_radius**2) / (2.0 * d)
        across = sqrt(max(0.0, 1.0 - along**2))
        limits.extend([
            (along * earth_y - across * earth_x) / d,
            (along * earth_y + across * earth_x) / d,
        ])
    limits = np.sort(np.clip(limits, cutoff, 1.0))
    half_widths = np.diff(limits) / 2.0
    centres = (limits[1:] + limits[:-1]) / 2.0
    y = centres[:, None] + half_widths[:, None] * _QUAD_POINTS
    sun_width = np.sqrt(np.maximum(0.0, 1.0 - y**2))
    earth_width = np.sqrt(np.maximum(0.0, earth_radius**2 - (y - earth_y)**2))
    blocked_width = np.maximum(
        0.0, np.minimum(sun_width, earth_x + earth_width)
        - np.maximum(-sun_width, earth_x - earth_width),
    )
    area = np.sum(((2.0 * sun_width - blocked_width) @ _QUAD_WEIGHTS) * half_widths)
    return float(area / pi)


# LUNA-DOC: Calculate local east, north, and zenith vectors for a point.
def local_axes(lat, lon):
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("Use latitude in [-90, 90] and longitude in [-180, 180].")
    phi, lam = np.radians([lat, lon])
    cos_lat, sin_lat = np.cos(phi), np.sin(phi)
    cos_lon, sin_lon = np.cos(lam), np.sin(lam)
    up = np.array([cos_lat * cos_lon, cos_lat * sin_lon, sin_lat])
    east = np.array([-sin_lon, cos_lon, 0.0])
    north = np.cross(up, east)
    return east, north, up


# LUNA-DOC: Calculate the visible fraction of the Sun above the horizon.
def sun_visibility(state, lat, lon, height_m=0.0, horizon_deg=0.0, *, terrain_horizon=None):
    """Estimate the visible solar disc above the horizon at one lunar point."""
    if not isfinite(height_m) or height_m <= -MOON_RADIUS_M:
        raise ValueError("Use a finite height above the Moon's centre.")
    if not -90 <= horizon_deg <= 90:
        raise ValueError("Use a horizon angle in [-90, 90].")

    east, north, up = local_axes(lat, lon)
    to_sun, to_earth = _observer_vectors(state, (MOON_RADIUS_M + height_m) * up)
    distance = hypot(*to_sun)
    if not isfinite(distance) or distance <= SUN_RADIUS_M:
        raise ValueError("The point must be outside the Sun.")
    earth_distance = hypot(*to_earth)
    if not isfinite(earth_distance) or earth_distance <= EARTH_RADIUS_M:
        raise ValueError("The point must be outside the Earth.")

    e, n, u = np.array([east, north, up]) @ (to_sun / distance)
    horizontal = hypot(e, n)
    azimuth = degrees(atan2(e, n)) % 360 if horizontal > 1e-12 else None
    elevation = degrees(atan2(u, horizontal))
    if terrain_horizon is not None and azimuth is not None:
        horizon_deg = terrain_horizon(azimuth)

    angular_radius = degrees(asin(SUN_RADIUS_M / distance))
    offset = max(-1.0, min(1.0, (elevation - horizon_deg) / angular_radius))
    above_horizon = 0.5 + (asin(offset) + offset * sqrt(1 - offset**2)) / pi
    blocked = float(earth_occlusion_fraction(to_sun, to_earth))
    if above_horizon == 0.0 or blocked == 1.0:
        visible = 0.0
    elif above_horizon == 1.0 or blocked == 0.0:
        visible = above_horizon - blocked
    else:
        sunward = to_sun / distance
        earthward = to_earth / earth_distance
        along = np.dot(earthward, sunward)
        offset_vector = earthward - along * sunward
        offset_length = hypot(*offset_vector)
        separation = degrees(atan2(offset_length, along)) / angular_radius
        screen_up = (up - u * sunward) / horizontal if horizontal > 1e-12 else north
        earth_y = separation * np.dot(offset_vector, screen_up) / offset_length if offset_length else 0.0
        earth_x = sqrt(max(0.0, separation**2 - earth_y**2))
        earth_radius = degrees(asin(EARTH_RADIUS_M / earth_distance)) / angular_radius
        visible = _visible_width_integral(-offset, earth_x, earth_y, earth_radius)
        visible = min(above_horizon, 1.0 - blocked, max(0.0, visible))

    return {
        "sun_azimuth_deg": azimuth,
        "sun_elevation_deg": elevation,
        "horizon_deg": horizon_deg,
        "sun_visible_percent": 100 * visible,
        "sun_above_horizon_percent": 100 * above_horizon,
        "sun_blocked_by_earth_percent": 100 * blocked,
    }


# LUNA-DOC: Return JSON containing celestial vectors and UTC time for the website.
def ephemeris_response(values):
    try:
        lat = values.get("lat")
        lon = values.get("lon")
        if (lat is None) != (lon is None):
            raise ValueError("Send lat and lon together.")

        state = lunar_ephemeris(
            values.get("utc", ""),
            include_eclipse_mask=values.get("eclipse") in ("1", True),
        )
        if lat is not None:
            state["sunlight"] = sun_visibility(
                state,
                float(lat),
                float(lon),
                float(values.get("height_m", 0)),
                float(values.get("horizon_deg", 0)),
            )
    except (OSError, SpiceyError):
        current_app.logger.exception("Lunar ephemeris unavailable")
        return jsonify(error="Lunar ephemeris unavailable. Check the server's SPICE kernels."), 503
    except (TypeError, ValueError, OverflowError) as error:
        return jsonify(error=str(error)), 422

    return jsonify(state)


# LUNA-DOC: HTTP endpoint for retrieving ephemerides.
@motion_api.get("/api/ephemeris")
def read_ephemeris():
    return ephemeris_response(request.args)
