# LUNA-DOC: ZONE calculations: geodesic grid and DEM data produce temperature, illumination, and slope fields.
# LUNA-DOC: Return data for the colored raster and 3D graph; changing grid dimensions requires matching frontend changes.
# LUNA-DOC: ZoneBusy and HTTP 429 protect the server from too many simultaneous expensive requests.
"""Sample a lunar geodesic circle in azimuthal equidistant coordinates."""

from bisect import bisect_right
from datetime import timedelta
from functools import lru_cache
import math
from threading import BoundedSemaphore
from typing import NamedTuple

import numpy as np

from lunar_results import (
    INITIAL_HISTORY, REGOLITH, SHADOW_STEP, STEP, THERMAL_STEP, WARM_UP, TerrainTiles,
    radio_link_margin, solar_radiation_dose, terrain_source, time_grid,
)
from lunar_surface_pipeline import AU_M, S0
from move_calculation import (
    MAX_UTC, MIN_UTC, MOON_RADIUS_M, SUN_RADIUS_M, earth_occlusion_fraction,
    eclipse_possible, local_axes, lunar_vectors, parse_lunar_utc,
)
from regolith_heat import solar_albedo

MAX_RADIUS_M = math.pi * MOON_RADIUS_M / 2
MAX_GRID_SIZE = 129
THERMAL_GRID_SIZE = 9
ZONE_STEP_M = 1
MIN_THERMAL_STEP_M = 0.001
THERMAL_BLOCK_DAYS = 7
STATIC_METRICS = {"terrain_elevation_m", "terrain_slope_deg"}
ZONE_METRICS = STATIC_METRICS | {
    "temperature_c", "irradiance_w_m2", "sun_visible_percent", "sun_elevation_deg",
    "sun_above_horizon_percent", "sun_blocked_by_earth_percent", "dose_rate_usv_h",
    "link_margin_db", "panel_tilt_deg",
}
_thermal_slot = BoundedSemaphore(1)
_horizon_angles = np.radians(np.arange(0, 360, 5))
_horizon_distances = 1000 * np.r_[np.arange(0.5, 25.1, 0.5), np.arange(26, 201, 2)]


# LUNA-DOC: Signal an overloaded calculation and convert it into HTTP 429.
class ZoneBusy(RuntimeError):
    pass


# LUNA-DOC: Describe zone sampling geometry and coordinate axes.
class Grid(NamedTuple):
    axis: np.ndarray
    east_m: np.ndarray
    north_m: np.ndarray
    up: np.ndarray
    inside: np.ndarray
    spacing_m: float


# LUNA-DOC: Collect topographic values for the entire sample grid.
class Terrain(NamedTuple):
    positions: np.ndarray
    east: np.ndarray
    north: np.ndarray
    up: np.ndarray
    height: np.ndarray
    normal: np.ndarray
    slope: np.ndarray


# LUNA-DOC: Convert sample positions to directions on the lunar sphere.
def sphere_directions(east, north, up, bearings, angles):
    tangent = np.sin(bearings)[..., None] * east + np.cos(bearings)[..., None] * north
    return np.cos(angles)[..., None] * up + np.sin(angles)[..., None] * tangent


# LUNA-DOC: Convert spherical directions to latitude and longitude.
def lat_lon(up):
    x, y, z = np.moveaxis(up, -1, 0)
    return np.degrees(np.arctan2(z, np.hypot(x, y))), np.degrees(np.arctan2(y, x))


# LUNA-DOC: Build a sample grid within the specified radius around a point.
def zone_grid(lat, lon, radius, max_size, minimum_spacing):
    half = min((max_size - 1) // 2, math.ceil(radius / minimum_spacing))
    spacing = max(minimum_spacing, radius / half)
    axis = np.arange(-half, half + 1) * spacing
    east_m, north_m = np.meshgrid(axis, axis[::-1])
    range_m = np.hypot(east_m, north_m)
    bearings = np.arctan2(east_m, north_m)
    up = sphere_directions(*local_axes(lat, lon), bearings, range_m / MOON_RADIUS_M)
    return Grid(axis, east_m, north_m, up, range_m <= radius * (1 + 1e-12), spacing)


# LUNA-DOC: Read DEM elevations and the derivatives needed for the grid.
def sample_terrain(source, up, *, slopes=False):
    lat, lon = lat_lon(up)
    lam = np.radians(lon)
    east = np.stack((-np.sin(lam), np.cos(lam), np.zeros_like(lam)), axis=-1)
    north = np.cross(up, east)
    height = source.heights_m(lat, lon)
    normal, slope = up, None
    if slopes:
        neighbours = sphere_directions(
            east[:, None], north[:, None], up[:, None], np.radians([0, 90, 180, 270]), 1000 / MOON_RADIUS_M,
        )
        h_n, h_e, h_s, h_w = source.heights_m(*lat_lon(neighbours)).T
        grad_e, grad_n = (h_e - h_w) / 2000, (h_n - h_s) / 2000
        slope = np.degrees(np.arctan(np.hypot(grad_e, grad_n)))
        normal = up - np.nan_to_num(grad_e)[:, None] * east - np.nan_to_num(grad_n)[:, None] * north
        normal /= np.linalg.norm(normal, axis=-1, keepdims=True)
    positions = (MOON_RADIUS_M + np.nan_to_num(height))[:, None] * up
    return Terrain(positions, east, north, up, height, normal, slope)


# LUNA-DOC: Evaluate local horizons for a set of directions.
def terrain_horizons(source, terrain):
    profiles = np.full((len(terrain.height), len(_horizon_angles)), np.nan)
    known = np.isfinite(terrain.height)
    if not np.any(known):
        return profiles
    directions = sphere_directions(
        terrain.east[known, None, None], terrain.north[known, None, None], terrain.up[known, None, None],
        _horizon_angles[None, :, None], _horizon_distances[None, None, :] / MOON_RADIUS_M,
    )
    heights = source.heights_m(*lat_lon(directions))
    distances = _horizon_distances / MOON_RADIUS_M
    vertical = (MOON_RADIUS_M + heights) * np.cos(distances) - (MOON_RADIUS_M + terrain.height[known, None, None])
    tangent = (MOON_RADIUS_M + heights) * np.sin(distances)
    angles = np.degrees(np.arctan2(vertical, tangent))
    profiles[known] = np.max(angles, axis=-1)
    return profiles


# LUNA-DOC: Interpolate one field across grid nodes.
def interpolate(coarse, columns, rows):
    """Bilinear interpolation, retaining gaps where no input samples exist."""
    limit = coarse.shape[0] - 1
    columns, rows = np.clip(columns, 0, limit), np.clip(rows, 0, limit)
    col, row = np.floor(columns).astype(int), np.floor(rows).astype(int)
    right, bottom = np.minimum(col + 1, limit), np.minimum(row + 1, limit)
    x, y = columns - col, rows - row
    values = np.array([coarse[row, col], coarse[row, right], coarse[bottom, col], coarse[bottom, right]])
    weights = np.array([(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y]) * np.isfinite(values)
    total = weights.sum(axis=0)
    result = np.full(total.shape, np.nan)
    np.divide(np.sum(np.nan_to_num(values) * weights, axis=0), total, out=result, where=total > 1e-12)
    return result


# LUNA-DOC: Convert node indices to terrain coordinates.
def grid_coordinates(east_m, north_m, grid):
    return (east_m - grid.axis[0]) / grid.spacing_m, (grid.axis[-1] - north_m) / grid.spacing_m


# LUNA-DOC: Find horizon elevation for a specified azimuth within the zone.
def zone_horizon(azimuth, profiles):
    index = azimuth / (360 / profiles.shape[1])
    first = np.floor(index).astype(int) % profiles.shape[1]
    weight = index - np.floor(index)
    columns = np.arange(profiles.shape[0])
    return profiles[columns, first] * (1 - weight) + profiles[columns, (first + 1) % profiles.shape[1]] * weight


# LUNA-DOC: Calculate elevation and azimuth of celestial bodies for every node.
def body_angles(vector, terrain):
    distance = np.linalg.norm(vector, axis=-1)
    direction = vector / distance[..., None]
    east = np.sum(direction * terrain.east, axis=-1)
    north = np.sum(direction * terrain.north, axis=-1)
    up = np.sum(direction * terrain.up, axis=-1)
    elevation = np.degrees(np.arctan2(up, np.hypot(east, north)))
    azimuth = np.degrees(np.arctan2(east, north)) % 360
    return direction, distance, up, elevation, azimuth


# LUNA-DOC: Calculate the visible fraction of sunlight throughout the zone.
def zone_sunlight(sun, earth, terrain, horizon, may_eclipse):
    to_sun = sun - terrain.positions
    direction, distance, _, elevation, azimuth = body_angles(to_sun, terrain)
    above = disk_above_horizon(elevation, distance, horizon(azimuth))
    blocked = np.zeros_like(above)
    if np.any(may_eclipse):
        blocked[may_eclipse] = earth_occlusion_fraction(
            to_sun[may_eclipse], earth[may_eclipse] - terrain.positions,
        )
    incidence = np.maximum(0, np.sum(direction * terrain.normal, axis=-1))
    irradiance = S0 * (AU_M / distance)**2 * incidence * above * (1 - blocked)
    return irradiance, incidence


# LUNA-DOC: Calculate the solar disk portion above the horizon boundary.
def disk_above_horizon(elevation, distance, horizon):
    angle = np.degrees(np.arcsin(SUN_RADIUS_M / distance))
    offset = np.clip((elevation - np.nan_to_num(horizon)) / angle, -1, 1)
    return 0.5 + (np.arcsin(offset) + offset * np.sqrt(1 - offset**2)) / math.pi


# LUNA-DOC: Evaluate the horizon toward a celestial body for every node.
def directional_horizon(source, terrain, azimuth):
    """Ray-sample the actual Sun/Earth bearing at every map grid point."""
    horizons = np.full(len(azimuth), np.nan)
    angles = _horizon_distances / MOON_RADIUS_M
    cosine, sine = np.cos(angles), np.sin(angles)
    indices = np.flatnonzero(np.isfinite(terrain.height))
    for start in range(0, indices.size, 2048):
        sample = indices[start:start + 2048]
        directions = sphere_directions(
            terrain.east[sample, None], terrain.north[sample, None], terrain.up[sample, None],
            np.radians(azimuth[sample, None]), angles,
        )
        heights = source.heights_m(*lat_lon(directions))
        vertical = (MOON_RADIUS_M + heights) * cosine - (MOON_RADIUS_M + terrain.height[sample, None])
        tangent = (MOON_RADIUS_M + heights) * sine
        horizons[sample] = np.max(np.degrees(np.arctan2(vertical, tangent)), axis=-1)
    return horizons


# LUNA-DOC: Build a value grid for the colored layer.
@lru_cache(maxsize=8)
def map_grid(lat, lon, radius):
    return zone_grid(lat, lon, radius, MAX_GRID_SIZE, ZONE_STEP_M)


# LUNA-DOC: Retrieve the topographic fields for the zone.
@lru_cache(maxsize=6)
def map_terrain(lat, lon, radius, slopes):
    grid = map_grid(lat, lon, radius)
    source = terrain_source()
    return source, sample_terrain(source, grid.up[grid.inside], slopes=slopes)


# LUNA-DOC: Prepare local geometry for the thermal calculation.
@lru_cache(maxsize=6)
def thermal_geometry(lat, lon, radius):
    source = terrain_source()
    thermal_grid = zone_grid(lat, lon, radius, THERMAL_GRID_SIZE, MIN_THERMAL_STEP_M)
    samples = sample_terrain(source, thermal_grid.up[thermal_grid.inside], slopes=True)
    profiles = terrain_horizons(source, samples)
    return source, thermal_grid, samples, profiles


# LUNA-DOC: Calculate node thermal histories from ephemerides.
@lru_cache(maxsize=4)
def thermal_history(block_start):
    start = max(MIN_UTC, block_start - WARM_UP)
    end = min(MAX_UTC, block_start + timedelta(days=THERMAL_BLOCK_DAYS))
    base_times = time_grid(start, end, THERMAL_STEP)
    sun, earth = lunar_vectors(base_times)
    eclipses = eclipse_possible(sun, earth)
    times = [base_times[0]]
    for i in range(1, len(base_times)):
        if eclipses[i - 1] or eclipses[i]:
            times.extend(time_grid(base_times[i - 1], base_times[i], SHADOW_STEP)[1:-1])
        times.append(base_times[i])
    history = time_grid(start, min(start + INITIAL_HISTORY, MAX_UTC), STEP)
    vectors = (sun, earth) if len(times) == len(base_times) else lunar_vectors(times)
    return times, vectors, lunar_vectors(history)


# LUNA-DOC: Calculate absorbed flux at nodes accounting for slope orientation.
def heating(suns, earths, terrain, horizons):
    irradiance, incidence = zone_sunlight(
        suns[:, None], earths[:, None], terrain, lambda az: zone_horizon(az, horizons), eclipse_possible(suns, earths),
    )
    return irradiance * (1 - solar_albedo(np.arccos(np.clip(incidence, 0, 1))))


# LUNA-DOC: Integrate vertical temperature profiles over time.
@lru_cache(maxsize=4)
def thermal_profiles(lat, lon, radius, block_start):
    if not _thermal_slot.acquire(blocking=False):
        raise ZoneBusy("A temperature map is being calculated. Retrying…")
    try:
        _, _, terrain, horizons = thermal_geometry(lat, lon, radius)
        times, (suns, earths), (history_sun, history_earth) = thermal_history(block_start)
        absorbed = heating(suns, earths, terrain, horizons)
        history = heating(history_sun, history_earth, terrain, horizons)
        profile = REGOLITH.initial_profile(absorbed[0], history.T)
        first = bisect_right(times, block_start) - 1
        profiles = []
        for i, time in enumerate(times):
            if i:
                profile = REGOLITH.advance(profile, absorbed[i], (time - times[i - 1]).total_seconds())
            if i >= first:
                profiles.append(profile)
        return times[first:], profiles
    finally:
        _thermal_slot.release()


# LUNA-DOC: Calculate surface temperature for every pixel in the zone.
def surface_temperatures(lat, lon, radius, utc):
    day = utc.replace(hour=0, minute=0, second=0, microsecond=0)
    block_start = max(MIN_UTC, day - timedelta(days=day.weekday()))
    times, profiles = thermal_profiles(lat, lon, radius, block_start)
    source, thermal_grid, terrain, horizons = thermal_geometry(lat, lon, radius)
    index = bisect_right(times, utc) - 1
    profile = profiles[index]
    if times[index] < utc:
        suns, earths = lunar_vectors([utc])
        absorbed = heating(suns, earths, terrain, horizons)[0]
        profile = REGOLITH.advance(profile, absorbed, (utc - times[index]).total_seconds())
    return source, thermal_grid, terrain, profile[:, 0] - 273.15


# LUNA-DOC: Main public Flask function for zone field calculations.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
def zone_field(values):
    try:
        lat, lon, radius = (float(values[key]) for key in ("lat", "lon", "radius_m"))
    except (KeyError, TypeError, ValueError):
        raise ValueError("Send latitude, longitude and radius_m.") from None
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise ValueError("Latitude and longitude must be within lunar coordinate bounds.")
    if not 1 <= radius <= MAX_RADIUS_M:
        raise ValueError(f"Radius must be between 1 m and {int(MAX_RADIUS_M / 1000)} km.")
    timestamp = values.get("utc")
    if not isinstance(timestamp, str) or len(timestamp) > 64:
        raise ValueError("Send an ISO UTC timestamp for the zone.")
    utc = parse_lunar_utc(timestamp)
    metric = values.get("metric", "temperature_c")
    if not isinstance(metric, str) or metric not in ZONE_METRICS:
        raise ValueError("Select one available zone metric.")
    result = calculate_zone(lat, lon, radius, metric, None if metric in STATIC_METRICS else utc)
    # The geometry of a 3D field uses true DEM elevations even when the displayed
    # metric is temperature/irradiance. It is static and separately cached.
    if values.get("include_elevation") is True:
        result = dict(result)
        if metric == "terrain_elevation_m":
            result["terrain_height_values"] = result["fields"][metric]["values"]
        else:
            static = calculate_zone(lat, lon, radius, "terrain_elevation_m", None)
            result["terrain_height_values"] = static["fields"]["terrain_elevation_m"]["values"]
    return {"utc": utc.isoformat().replace("+00:00", "Z"), **result}


# LUNA-DOC: Estimate temperature inside a grid cell.
def interpolate_temperature(grid, thermal_grid, temperatures):
    coarse_temperatures = np.full(thermal_grid.inside.shape, np.nan)
    coarse_temperatures[thermal_grid.inside] = temperatures
    columns, rows = grid_coordinates(grid.east_m[grid.inside], grid.north_m[grid.inside], thermal_grid)
    temperatures = interpolate(coarse_temperatures, columns, rows)
    missing = ~np.isfinite(temperatures)
    if np.any(missing):
        nodes = np.argwhere(thermal_grid.inside)
        distance = (rows[missing, None] - nodes[:, 0])**2 + (columns[missing, None] - nodes[:, 1])**2
        nearest = nodes[np.argmin(distance, axis=1)]
        temperatures[missing] = coarse_temperatures[nearest[:, 0], nearest[:, 1]]
    return temperatures


# LUNA-DOC: Calculate numeric zone flux and insolation indicators.
def solar_metric(metric, source, terrain, sun, earth):
    to_sun = sun - terrain.positions
    direction, distance, up, elevation, azimuth = body_angles(to_sun, terrain)
    if metric == "sun_elevation_deg":
        return elevation
    if metric == "dose_rate_usv_h":
        return solar_radiation_dose((AU_M / distance)**2, np.maximum(0, up))
    if metric != "sun_blocked_by_earth_percent":
        horizon = directional_horizon(source, terrain, azimuth)
        above = disk_above_horizon(elevation, distance, horizon)
        if metric == "sun_above_horizon_percent":
            return above * 100

    blocked = earth_occlusion_fraction(to_sun, earth - terrain.positions) if eclipse_possible(sun, earth) else 0.0
    if metric == "sun_blocked_by_earth_percent":
        return np.broadcast_to(blocked, distance.shape) * 100

    visible = above * (1 - blocked)
    if metric == "sun_visible_percent":
        return visible * 100
    if metric == "panel_tilt_deg":
        return np.where((elevation >= 0) & (visible > 0), 90 - elevation, np.nan)
    incidence = np.maximum(0, np.sum(direction * terrain.normal, axis=-1))
    return S0 * (AU_M / distance)**2 * incidence * visible


# LUNA-DOC: Calculate Earth radio-link availability parameters.
def earth_link_metric(source, terrain, earth):
    _, distance, _, elevation, azimuth = body_angles(earth - terrain.positions, terrain)
    horizon = directional_horizon(source, terrain, azimuth)
    return np.where((elevation > 0) & (elevation > horizon), radio_link_margin(distance), np.nan)


# LUNA-DOC: Combine all physical models and construct the result.
@lru_cache(maxsize=12)
def calculate_zone(lat, lon, radius, metric, utc):
    grid = map_grid(lat, lon, radius)
    thermal_metadata = {}
    if metric == "temperature_c":
        source, thermal_grid, terrain, temperatures = surface_temperatures(lat, lon, radius, utc)
        values = interpolate_temperature(grid, thermal_grid, temperatures)
        thermal_metadata = {
            "thermal_step_m": thermal_grid.spacing_m,
            "thermal_samples": int(thermal_grid.inside.sum()),
        }
    else:
        source, terrain = map_terrain(lat, lon, radius, metric in {"terrain_slope_deg", "irradiance_w_m2"})
        if metric == "terrain_elevation_m":
            values = terrain.height
        elif metric == "terrain_slope_deg":
            values = terrain.slope
        else:
            suns, earths = lunar_vectors([utc])
            sun, earth = suns[0], earths[0]
            if metric == "link_margin_db":
                values = earth_link_metric(source, terrain, earth)
            else:
                values = solar_metric(metric, source, terrain, sun, earth)

    coverage = float(np.isfinite(terrain.height).mean())
    dem_name = "Cesium / LOLA tiles" if isinstance(source, TerrainTiles) else "LOLA GeoTIFF"
    spacing = 64 if isinstance(source, TerrainTiles) else source.width / 360
    return {
        "center": {"lat": lat, "lon": lon},
        "radius_m": radius,
        "moon_radius_m": MOON_RADIUS_M,
        "grid_size": len(grid.axis),
        "step_m": grid.spacing_m,
        "samples": int(grid.inside.sum()),
        "dem": dem_name if coverage else None,
        "terrain_coverage": coverage,
        "dem_equator_spacing_m": MOON_RADIUS_M * math.pi / (180 * spacing),
        "fields": {metric: serialize_field(values, grid)},
        **thermal_metadata,
    }


# LUNA-DOC: Serialize zone results into a JSON structure for the frontend.
def serialize_field(values, grid):
    raster = np.full(grid.inside.shape, np.nan)
    raster[grid.inside] = values
    valid = np.isfinite(values)
    samples = values[valid]
    distance = np.hypot(grid.east_m, grid.north_m)[grid.inside][valid]
    # Equal projected cells cover less surface area farther from the zone centre.
    area_weights = np.sinc(distance / (math.pi * MOON_RADIUS_M))
    return {
        "min": float(samples.min()) if samples.size else None,
        "max": float(samples.max()) if samples.size else None,
        "mean": float(np.average(samples, weights=area_weights)) if samples.size else None,
        "valid_samples": int(samples.size),
        "values": [value if math.isfinite(value) else None for value in np.round(raster.ravel(), 6).tolist()],
    }
