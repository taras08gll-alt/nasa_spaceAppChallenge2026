# LUNA-DOC: Physical parameters for a lunar point: DEM, Sun/Earth visibility, regolith temperature, radiation, and radio links.
# LUNA-DOC: Outputs are model estimates, not Diviner measurements or spacecraft telemetry.
# LUNA-DOC: Terrain and time-series caching improve efficiency; sampling resolution affects server load.
"""Calculations for the Simulation results panel, in the MOON_ME frame."""

import logging
import math
import os
from bisect import bisect_right
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

import numpy as np

from lunar_surface_pipeline import AU_M, S0, LunarDEM, horizon_at
from move_calculation import (
    EARTH_RADIUS_M, MAX_UTC, MIN_UTC, MOON_RADIUS_M, SUN_RADIUS_M,
    local_axes, lunar_vectors, parse_lunar_utc, sun_visibility,
)
from regolith_heat import EMISSION_COEFFICIENT, RegolithColumn, absorbed_solar_flux

logger = logging.getLogger(__name__)

REGOLITH = RegolithColumn()
STEP = timedelta(hours=3)
SHORT_STEP = timedelta(minutes=10)
THERMAL_STEP = timedelta(minutes=30)
SHADOW_STEP = timedelta(minutes=5)
WARM_UP = timedelta(days=90)
INITIAL_HISTORY = timedelta(days=30)
MAX_PERIOD = timedelta(days=90)
SUNLIGHT_BLOCK = timedelta(days=7)
SUNLIGHT_STEP = timedelta(minutes=30)
SUNLIGHT_LOOKAHEAD = timedelta(days=365)

# Workbook: Point_Calculation C33–C34 and Calculator B24, B35–B40.
GCR_DOSE_MSV_DAY = 1.10
SOLAR_WIND_DOSE_MSV_DAY = 0.12
LIGHT_SPEED_M_S = 299_792_458
RADIO_FREQUENCY_HZ = 2.2e9
RADIO_TX_DBM = 30
RADIO_TX_GAIN_DBI = 10
RADIO_RX_GAIN_DBI = 50
RADIO_RX_MIN_DBM = -120
RADIO_TARGET_MARGIN_DB = 3

SOLAR_FIELDS = (
    "sun_elevation_deg",
    "sun_azimuth_deg",
    "sun_above_horizon_percent",
    "sun_visible_percent",
    "sun_blocked_by_earth_percent",
)
AVERAGE_FIELDS = (
    "irradiance_w_m2", "dose_rate_usv_h", *SOLAR_FIELDS,
    "link_margin_db", "panel_tilt_deg",
)
HISTORY_FIELDS = (
    "temperature_c", "absorbed_w_m2", "emitted_w_m2",
    "net_radiation_w_m2", "sun_clearance_deg",
    *(key for key in AVERAGE_FIELDS if key != "sun_azimuth_deg"),
)


# LUNA-DOC: Absorbed energy flux and geometric context determine the thermal load.
class ThermalForcing(NamedTuple):
    time: datetime
    absorbed_w_m2: float
    irradiance_w_m2: float
    sun_visible_percent: float


# LUNA-DOC: Read the relevant DEM fragment or tile without loading the full lunar map.
@lru_cache(maxsize=256)
def read_tile(path):
    tile = np.fromfile(path, dtype="<u2")
    if tile.size != 65 * 65:
        raise ValueError(f"Invalid lunar heightmap: {path}")
    return tile.reshape(65, 65)


# LUNA-DOC: Cached access to NASA elevation data for the requested coordinates.
class TerrainTiles(LunarDEM):
    """Read the same level-six heightmaps and encoding as the Cesium viewer."""

    # LUNA-DOC: The __init__ method initializes this class; refer to the implementation for its arguments and behavior.
    def __init__(self, directory):
        self.directory = directory

    # LUNA-DOC: Check whether the required cartographic tile is available.
    @lru_cache(maxsize=4096)
    def has_tile(self, tile_x, tile_y):
        return (self.directory / "6" / str(tile_x) / f"{tile_y}.bin").is_file()

    # LUNA-DOC: Return elevation at a point in meters relative to the reference sphere.
    def height_m(self, lat, lon):
        x = ((lon + 180) % 360) / 360 * 128
        y = (90 - lat) / 180 * 64
        tile_x, tile_y = int(x), min(63, int(y))
        tile = read_tile(self.directory / "6" / str(tile_x) / f"{tile_y}.bin")
        col = (x - tile_x) * 64
        row = (y - tile_y) * 64
        col0, row0 = min(63, int(col)), min(63, int(row))
        u, v = col - col0, row - row0
        north = (1 - u) * tile[row0, col0] + u * tile[row0, col0 + 1]
        south = (1 - u) * tile[row0 + 1, col0] + u * tile[row0 + 1, col0 + 1]
        return float(0.5 * ((1 - v) * north + v * south) - 10_000)

    # LUNA-DOC: Read elevations for many coordinates in a batch.
    def heights_m(self, lat, lon):
        if not lat.size:
            return np.empty(lat.shape)
        shape = lat.shape
        x = ((lon.ravel() + 180) % 360) / 360 * 128
        y = (90 - lat.ravel()) / 180 * 64
        tx, ty = x.astype(int), np.minimum(63, y.astype(int))
        tile_indices = tx * 64 + ty
        order = np.argsort(tile_indices)
        sorted_tiles = tile_indices[order]
        boundaries = np.r_[0, np.flatnonzero(np.diff(sorted_tiles)) + 1, order.size]
        heights = np.full(order.size, np.nan)
        for first, last in zip(boundaries, boundaries[1:]):
            indices = order[first:last]
            tile_x, tile_y = divmod(int(sorted_tiles[first]), 64)
            if not self.has_tile(tile_x, tile_y):
                continue
            try:
                tile = read_tile(self.directory / "6" / str(tile_x) / f"{tile_y}.bin")
            except FileNotFoundError:
                continue
            col, row = (x[indices] - tile_x) * 64, (y[indices] - tile_y) * 64
            col0, row0 = np.minimum(63, col.astype(int)), np.minimum(63, row.astype(int))
            u, v = col - col0, row - row0
            north = (1 - u) * tile[row0, col0] + u * tile[row0, col0 + 1]
            south = (1 - u) * tile[row0 + 1, col0] + u * tile[row0 + 1, col0 + 1]
            heights[indices] = 0.5 * ((1 - v) * north + v * south) - 10_000
        return heights.reshape(shape)

    # LUNA-DOC: Build a local set of slopes and horizon profiles from DEM data.
    def terrain(self, lat, lon, **options):
        terrain = super().terrain(lat, lon, **options)
        terrain["dem"] = "Cesium / LOLA terrain"
        return terrain


# LUNA-DOC: Connect to an available DEM data source.
@lru_cache(maxsize=2)
def open_dem(path):
    return LunarDEM(path)


# LUNA-DOC: Choose the location and format of the elevation source.
def terrain_source():
    default_dem = Path(__file__).parent / "data" / "ldem_64.tif"
    dem_path = Path(os.environ.get("LUNAR_DEM_PATH", default_dem))
    if dem_path.is_file():
        try:
            return open_dem(dem_path)
        except (ImportError, OSError, ValueError):
            logger.exception("Could not read lunar DEM %s", dem_path)

    tile_dir = Path(os.environ.get("LUNAR_TERRAIN_DIR", "/var/www/html/moon-terrain"))
    return TerrainTiles(tile_dir)


# LUNA-DOC: Retrieve terrain information for a specified lunar surface point.
@lru_cache(maxsize=32)
def terrain_at(lat, lon):
    try:
        return terrain_source().terrain(lat, lon)
    except FileNotFoundError:
        return None


# LUNA-DOC: Model-based radiation exposure estimate, not a direct particle-flux measurement.
def solar_radiation_dose(distance_factor, vertical_projection):
    dose_msv_day = GCR_DOSE_MSV_DAY + SOLAR_WIND_DOSE_MSV_DAY * distance_factor * vertical_projection
    return dose_msv_day * 1_000 / 24


# LUNA-DOC: Calculate free-space radio transmission loss from distance.
def radio_path_loss(distance):
    return 20 * np.log10(4 * math.pi * distance * RADIO_FREQUENCY_HZ / LIGHT_SPEED_M_S)


# LUNA-DOC: Estimate radio-link margin for the specified link parameters.
def radio_link_margin(distance):
    return RADIO_TX_DBM + RADIO_TX_GAIN_DBI + RADIO_RX_GAIN_DBI - radio_path_loss(distance) - RADIO_RX_MIN_DBM


# LUNA-DOC: Point context combines terrain, body visibility, and physical parameters.
class SurfacePoint:
    # LUNA-DOC: The __init__ method initializes this class; refer to the implementation for its arguments and behavior.
    def __init__(self, lat, lon, height, horizon):
        self.lat, self.lon = lat, lon
        self.axes = np.array(local_axes(lat, lon))
        self.terrain = terrain_at(lat, lon)
        self.height = self.terrain["center_m"] if self.terrain else height
        self.position = (MOON_RADIUS_M + self.height) * self.axes[2]
        self.normal = self.terrain["normal_enu"] if self.terrain else (0, 0, 1)
        self.profile = self.terrain["horizon_profile_az_deg_elev_deg"] if self.terrain else None
        self.flat_horizon = horizon

    # LUNA-DOC: Return the local DEM horizon profile.
    def horizon(self, azimuth):
        return horizon_at(self.profile, azimuth) if self.profile else self.flat_horizon

    # LUNA-DOC: Calculate Sun direction and illumination at a point.
    def sunlight(self, state):
        return sun_visibility(
            state, self.lat, self.lon, self.height, self.flat_horizon,
            terrain_horizon=self.horizon if self.profile else None,
        )

    # LUNA-DOC: Account for direct solar illumination and local terrain.
    def illumination(self, state):
        sunlight = self.sunlight(state)
        to_sun = np.asarray(state["sun_m"]) - self.position
        sun_distance = math.hypot(*to_sun)
        direction = self.axes @ (to_sun / sun_distance)
        cos_incidence = max(-1.0, min(1.0, float(np.dot(self.normal, direction))))
        distance_factor = (AU_M / sun_distance) ** 2
        visible = sunlight["sun_visible_percent"] / 100
        irradiance = S0 * distance_factor * max(0.0, cos_incidence) * visible
        return sunlight, irradiance, distance_factor, cos_incidence

    # LUNA-DOC: Calculate Earth's direction relative to the local horizon.
    def earth_direction(self, earth_m):
        to_earth = np.asarray(earth_m) - self.position
        distance = math.hypot(*to_earth)
        east, north, up = self.axes @ (to_earth / distance)
        elevation = math.degrees(math.atan2(up, math.hypot(east, north)))
        azimuth = math.degrees(math.atan2(east, north)) % 360
        return distance, elevation, azimuth

    # LUNA-DOC: Calculate model outputs for the radio link to Earth.
    def earth_link(self, earth_m):
        distance, elevation, azimuth = self.earth_direction(earth_m)
        if elevation <= 0:
            return None, "Below horizon"
        if not self.profile:
            return None, "DEM required"

        if elevation <= self.horizon(azimuth):
            return None, "Terrain blocks link"

        margin = float(radio_link_margin(distance))
        return margin, "Meets target" if margin >= RADIO_TARGET_MARGIN_DB else "Low margin"

    # LUNA-DOC: Assemble the physical parameters of a point into a single response object.
    def metrics(self, earth_m, sunlight, irradiance, distance_factor):
        sun_elevation = sunlight["sun_elevation_deg"]
        sun_projection = max(0.0, math.sin(math.radians(sun_elevation)))
        tilt = 90 - sun_elevation if sun_elevation >= 0 and sunlight["sun_visible_percent"] > 0 else None
        margin, link_status = self.earth_link(earth_m)
        return {
            **{key: sunlight[key] for key in SOLAR_FIELDS},
            "irradiance_w_m2": irradiance,
            "dose_rate_usv_h": solar_radiation_dose(distance_factor, sun_projection),
            "panel_tilt_deg": tilt,
            "link_margin_db": margin,
            "earth_direct_link": link_status,
        }


# LUNA-DOC: Construct a time grid for integration and averaging.
def time_grid(start, end, step=STEP):
    count = (end - start) // step
    times = [start + step * index for index in range(count + 1)]
    if times[-1] < end:
        times.append(end)
    return times


# LUNA-DOC: Build an array of illumination flags for selected times.
@lru_cache(maxsize=256)
def sunlit_samples(lat, lon, height, horizon, block):
    point = SurfacePoint(lat, lon, height, horizon)
    times = time_grid(max(block, MIN_UTC), min(block + SUNLIGHT_BLOCK, MAX_UTC), SUNLIGHT_STEP)
    suns, earths = lunar_vectors(times)
    return tuple(
        time for time, sun, earth in zip(times, suns, earths)
        if point.sunlight({"sun_m": sun, "earth_m": earth})["sun_visible_percent"] > 0
    )


# LUNA-DOC: Estimate the waiting time until the next sunlight interval.
def hours_until_sunlight(point, model_inputs, utc):
    # LUNA-DOC: The is_sunlit helper determines illumination status; consult its implementation for details.
    def is_sunlit(time):
        (sun,), (earth,) = lunar_vectors([time])
        return point.sunlight({"sun_m": sun, "earth_m": earth})["sun_visible_percent"] > 0

    requested_end = utc + SUNLIGHT_LOOKAHEAD
    end = min(requested_end, MAX_UTC)
    block = utc.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=utc.weekday())
    bright = None
    while block < end:
        bright = next((time for time in sunlit_samples(*model_inputs, block) if utc < time <= end), None)
        if bright is not None:
            break
        block += SUNLIGHT_BLOCK

    if bright is None:
        if end <= utc or not is_sunlit(end):
            return None, "Ephemeris limit" if end < requested_end else "None in 1 yr"
        bright = end

    dark = max(utc, bright - SUNLIGHT_STEP)
    while bright - dark > timedelta(minutes=1):
        middle = dark + (bright - dark) / 2
        if is_sunlit(middle):
            bright = middle
        else:
            dark = middle
    return (bright - utc).total_seconds() / 3600, None


# LUNA-DOC: Choose the time step appropriate for the requested interval.
def period_sample_step(start, end):
    return SHORT_STEP if end - start <= timedelta(days=1) else STEP


# LUNA-DOC: Prepare thermal model parameters and absorbed energy flux.
def temperature_inputs(point, times):
    suns, earths = lunar_vectors(times)
    for time, sun, earth in zip(times, suns, earths):
        state = {"sun_m": sun, "earth_m": earth}
        sunlight, irradiance, distance_factor, incidence = point.illumination(state)
        forcing = ThermalForcing(
            time, absorbed_solar_flux(irradiance, incidence), irradiance, sunlight["sun_visible_percent"],
        )
        yield forcing, earth, sunlight, distance_factor


# LUNA-DOC: Advance the thermal solver by one time step.
def advance_temperature(profile, previous, current, point):
    earlier, later = previous.time, current.time
    # Resolve rapid changes in terrain shadows and eclipses within the thermal grid.
    shadow_changed = abs(current.sun_visible_percent - previous.sun_visible_percent) > 1
    if shadow_changed and max(previous.irradiance_w_m2, current.irradiance_w_m2) > 10 and later - earlier > SHADOW_STEP:
        for forcing, _, _, _ in temperature_inputs(point, time_grid(earlier, later, SHADOW_STEP)[1:-1]):
            profile = REGOLITH.advance(profile, forcing.absorbed_w_m2, (forcing.time - earlier).total_seconds())
            earlier = forcing.time
    return REGOLITH.advance(profile, current.absorbed_w_m2, (later - earlier).total_seconds())


# LUNA-DOC: Produce summary thermal indicators.
def thermal_metrics(temperature_c, forcing):
    emitted = EMISSION_COEFFICIENT * (temperature_c + 273.15)**4
    return {
        "temperature_c": temperature_c,
        "absorbed_w_m2": forcing.absorbed_w_m2,
        "emitted_w_m2": emitted,
        "net_radiation_w_m2": forcing.absorbed_w_m2 - emitted,
    }


# LUNA-DOC: Build one timestamped sample for a point chart.
def history_sample(point, earth, sunlight, distance_factor, forcing, temperature_c):
    return {
        **point.metrics(earth, sunlight, forcing.irradiance_w_m2, distance_factor),
        **thermal_metrics(temperature_c, forcing),
        "sun_clearance_deg": sunlight["sun_elevation_deg"] - sunlight["horizon_deg"],
    }


# LUNA-DOC: Generate the temperature series while accounting for thermal history.
@lru_cache(maxsize=10)
def thermal_series(lat, lon, height, horizon, start, end, collect_metrics):
    point = SurfacePoint(lat, lon, height, horizon)
    warm_start = max(MIN_UTC, start - WARM_UP)
    output_times = set(time_grid(start, end, period_sample_step(start, end))) if collect_metrics else {start, end}
    model_times = sorted(output_times.union(time_grid(warm_start, end, THERMAL_STEP)))
    history_times = time_grid(warm_start, min(warm_start + INITIAL_HISTORY, MAX_UTC), STEP)
    history = [forcing.absorbed_w_m2 for forcing, _, _, _ in temperature_inputs(point, history_times)]
    previous = None
    rows = []
    profiles = []
    for forcing, earth, sunlight, distance_factor in temperature_inputs(point, model_times):
        utc, absorbed, _, _ = forcing
        if previous is None:
            profile = REGOLITH.initial_profile(absorbed, history)
        else:
            profile = advance_temperature(profile, previous, forcing, point)
        previous = forcing
        if utc >= start:
            profiles.append((forcing, profile))
        if collect_metrics and utc in output_times:
            row = history_sample(point, earth, sunlight, distance_factor, forcing, float(profile[0] - 273.15))
            rows.append((utc, row))
    if not collect_metrics:
        return profiles, {}, rows

    averages = period_metrics(rows)
    temperature_integral = math.fsum(
        (right.time - left.time).total_seconds() * (first[0] + last[0]) / 2
        for (left, first), (right, last) in zip(profiles, profiles[1:])
    )
    averages["temperature_c"] = temperature_integral / (end - start).total_seconds() - 273.15
    return profiles, averages, rows


# LUNA-DOC: Calculate modeled surface temperature at the requested date and time.
def surface_temperature(point, instant, profiles):
    # A slider time can fall between output samples. Resume from the last thermal step.
    index = bisect_right(profiles, instant.time, key=lambda sample: sample[0].time) - 1
    previous, profile = profiles[index]
    if previous.time != instant.time:
        profile = advance_temperature(profile, previous, instant, point)
    return float(profile[0] - 273.15)


# LUNA-DOC: Aggregate time-dependent indicators across the selected interval.
def period_metrics(rows):
    # Each interval gives half its duration to each endpoint (trapezoidal weights).
    samples = [(sample, (end - start).total_seconds() / 7200)
               for (start, first), (end, last) in zip(rows, rows[1:])
               for sample in (first, last)]
    average = {}
    for key in AVERAGE_FIELDS:
        weighted = [(sample[key], hours) for sample, hours in samples if sample[key] is not None]
        total = sum(hours for _, hours in weighted)
        if not total:
            continue
        if key == "sun_azimuth_deg":
            sine = sum(hours * math.sin(math.radians(value)) for value, hours in weighted)
            cosine = sum(hours * math.cos(math.radians(value)) for value, hours in weighted)
            average[key] = math.degrees(math.atan2(sine, cosine)) % 360 if math.hypot(sine, cosine) > 1e-9 else None
        else:
            average[key] = sum(value * hours for value, hours in weighted) / total

    average["sunlight_hours"] = sum(hours for sample, hours in samples if sample["sun_visible_percent"] > 0)
    return average


# LUNA-DOC: Validate and normalize UTC interval boundaries.
def selected_period(values):
    try:
        start = datetime.fromisoformat(values.get("start_utc", ""))
        end = datetime.fromisoformat(values.get("end_utc", ""))
        if start.utcoffset() is not None and end.utcoffset() is not None:
            start, end = start.astimezone(UTC), end.astimezone(UTC)
            if MIN_UTC <= start < end <= MAX_UTC:
                return start, end
    except (TypeError, ValueError, OverflowError):
        pass
    return None


# LUNA-DOC: Convert request coordinates into a surface-point representation.
def requested_surface(values):
    lat, lon, height = (float(values.get(key, 0)) for key in ("lat", "lon", "height_m"))
    flat_horizon = float(values.get("horizon_deg", 0))
    if not math.isfinite(height) or height <= -MOON_RADIUS_M:
        raise ValueError("Use a finite height above the Moon's centre.")
    if not -90 <= flat_horizon <= 90:
        raise ValueError("Use a horizon angle in [-90, 90].")
    point = SurfacePoint(lat, lon, height, flat_horizon)
    # Once the source DEM supplies height/horizon, ignore browser-side terrain refinements in the cache key.
    model_inputs = lat, lon, point.height, 0.0 if point.terrain else flat_horizon
    return point, model_inputs


# LUNA-DOC: Normalize the UTC timestamp for caching.
def utc_day(utc):
    start = utc.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, min(start + timedelta(days=1), MAX_UTC)


# LUNA-DOC: Return a sequence of values for charting.
def simulation_history(values):
    bounds = selected_period(values)
    utc = parse_lunar_utc(values.get("utc"))
    if not bounds or not bounds[0] <= utc <= bounds[1]:
        raise ValueError("Choose a valid UTC period containing the selected time.")
    if values.get("lat") is None or values.get("lon") is None:
        raise ValueError("Choose a point on the Moon.")
    point, model_inputs = requested_surface(values)
    day_window = bounds[1] - bounds[0] > MAX_PERIOD
    if day_window:
        # The slider can be exactly at the end of a period that ends at midnight.
        start, end = utc_day(min(utc, bounds[1] - timedelta(microseconds=1)))
        profiles, _, _ = thermal_series(*model_inputs, start, end, False)
        times = time_grid(max(start, bounds[0]), min(end, bounds[1]), SHORT_STEP)
        rows = []
        for forcing, earth, sunlight, distance_factor in temperature_inputs(point, times):
            temperature = surface_temperature(point, forcing, profiles)
            row = history_sample(point, earth, sunlight, distance_factor, forcing, temperature)
            rows.append((forcing.time, row))
    else:
        _, _, rows = thermal_series(*model_inputs, *bounds, True)
    return {
        "selected_utc": utc.isoformat(),
        "timestamps": [time.isoformat() for time, _ in rows],
        "series": {key: [row[key] for _, row in rows] for key in HISTORY_FIELDS},
        "day_window": day_window,
    }


# LUNA-DOC: Combine instantaneous and averaged parameters into one API result.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
def simulation_results(values, state):
    if values.get("lat") is None or values.get("lon") is None:
        return None
    utc = datetime.fromisoformat(state["utc"])
    point, model_inputs = requested_surface(values)
    sunlight, irradiance, distance_factor, incidence = point.illumination(state)
    instant = point.metrics(state["earth_m"], sunlight, irradiance, distance_factor)
    bounds = selected_period(values)
    if bounds and bounds[0] <= utc <= bounds[1] and bounds[1] - bounds[0] <= MAX_PERIOD:
        profiles, averages, _ = thermal_series(*model_inputs, *bounds, True)
    else:
        profiles, _, _ = thermal_series(*model_inputs, *utc_day(utc), False)
        averages = {}

    thermal_input = ThermalForcing(
        utc, absorbed_solar_flux(irradiance, incidence), irradiance, sunlight["sun_visible_percent"],
    )
    wait_h, wait_status = (0.0, None) if sunlight["sun_visible_percent"] > 0 else hours_until_sunlight(
        point, model_inputs, utc,
    )
    heat = thermal_metrics(surface_temperature(point, thermal_input, profiles), thermal_input)
    instant.update(
        temperature_c=heat["temperature_c"],
        terrain_elevation_m=point.terrain["center_m"] if point.terrain else None,
        terrain_slope_deg=point.terrain["slope_deg"] if point.terrain else None,
        next_sunlight_h=wait_h,
        sunlight_wait_status=wait_status,
    )

    note = point.terrain["dem"] if point.terrain else "Flat horizon estimate · DEM unavailable"
    if values.get("radius_m") is not None:
        note += " · Zone centre"
    if bounds:
        if bounds[1] - bounds[0] > MAX_PERIOD:
            note += " · Period model available up to 90 days"
        else:
            step = period_sample_step(*bounds)
            note += " · 10 min samples" if step == SHORT_STEP else " · 3 h samples"
    earth_distance, earth_elevation, earth_azimuth = point.earth_direction(state["earth_m"])
    earth_horizon = point.horizon(earth_azimuth)
    sun_distance = math.hypot(*(np.asarray(state["sun_m"]) - point.position))
    return {"instant": instant, "averages": {
        key: averages.get(key) for key in ("temperature_c", *AVERAGE_FIELDS, "sunlight_hours")
    }, "details": {
        "earth_elevation_deg": earth_elevation,
        "earth_azimuth_deg": earth_azimuth,
        "earth_horizon_deg": earth_horizon,
        "earth_clearance_deg": earth_elevation - earth_horizon,
        "horizon_deg": sunlight["horizon_deg"],
        "sun_clearance_deg": sunlight["sun_elevation_deg"] - sunlight["horizon_deg"],
        "sun_incidence_deg": math.degrees(math.acos(incidence)),
        "solar_normal_w_m2": S0 * distance_factor,
        "absorbed_w_m2": heat["absorbed_w_m2"],
        "emitted_w_m2": heat["emitted_w_m2"],
        "net_radiation_w_m2": heat["net_radiation_w_m2"],
        "sun_distance_km": sun_distance / 1000,
        "sun_diameter_arcmin": 120 * math.degrees(math.asin(SUN_RADIUS_M / sun_distance)),
        "earth_distance_km": earth_distance / 1000,
        "earth_diameter_deg": 2 * math.degrees(math.asin(EARTH_RADIUS_M / earth_distance)),
        "earth_signal_delay_s": earth_distance / LIGHT_SPEED_M_S,
        "earth_path_loss_db": float(radio_path_loss(earth_distance)),
        "earth_direct_link": instant["earth_direct_link"],
    }, "note": note}
