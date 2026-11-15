# LUNA-DOC: Separate experimental or fallback calculation of continuous sunlight intervals.
# LUNA-DOC: This indicator is disabled in the final UI; the module remains available for future research without changing other calculations.
# LUNA-DOC: Results depend on time-specific ephemerides and the DEM horizon profile; 354 hours is not a universal constant.
"""Mean duration of complete uninterrupted sunlit periods for a Moon point/zone.

Input: Moon_ME latitude, longitude, UTC; optional zone radius in metres.
Output: sampled/approximate interval duration (hours), never a universal constant.

Performance: gather the local DEM horizon using ONE vectorized height query
per site. The earlier implementation called the full multi-layer terrain()
method for each of nine sites, which could exceed the Gunicorn timeout.
An absent DEM is reported explicitly and the astronomical/geometric result
uses a zero-degree local horizon, never pretending DEM was read.
"""
from datetime import timedelta
from functools import lru_cache
import math
import logging

import numpy as np

from lunar_results import terrain_source, time_grid
from move_calculation import (
    MAX_UTC, MIN_UTC, MOON_RADIUS_M, SUN_RADIUS_M,
    earth_occlusion_fraction, eclipse_possible, local_axes,
    lunar_vectors, parse_lunar_utc,
)

logger = logging.getLogger(__name__)
WINDOW_DAYS = 90
STEP_H = 3
MAX_ZONE_RADIUS_M = math.pi * MOON_RADIUS_M / 2


# LUNA-DOC: Build representative sample positions for zone illumination analysis.
def _sample_positions(lat, lon, radius):
    positions = [(float(lat), float(lon))]
    if radius is None:
        return positions
    east, north, up = (np.asarray(a) for a in local_axes(lat, lon))
    angle = 0.70 * radius / MOON_RADIUS_M
    for bearing in np.arange(0, 2 * math.pi, math.pi / 4):
        unit = (math.cos(angle) * up + math.sin(angle) *
                (math.sin(bearing) * east + math.cos(bearing) * north))
        la = math.degrees(math.atan2(unit[2], math.hypot(unit[0], unit[1])))
        lo = (math.degrees(math.atan2(unit[1], unit[0])) + 180) % 360 - 180
        positions.append((round(la, 6), round(lo, 6)))
    return positions


# LUNA-DOC: Find completed contiguous intervals of solar illumination.
def _complete_intervals_hours(bright, step_h):
    """Drop light intervals that touch either limit of the observation window."""
    runs = []
    start = None
    for index, is_bright in enumerate(bright):
        if is_bright and start is None:
            start = index
        elif not is_bright and start is not None:
            if start > 0:
                runs.append((index - start) * step_h)
            start = None
    return runs


# LUNA-DOC: Evaluate horizon profiles from DEM elevations in batches.
def _fast_horizon(lat, lon):
    """Vectorized 72-azimuth local-horizon estimate from server NASA DEM.

    5-degree azimuth sampling and 0.5/2 km radial sampling to 200 km.
    Unlike the former point.terrain() call this does not loop through
    thousands of Python-level GeoTIFF pixel reads per azimuth.
    """
    try:
        dem = terrain_source()
        center = float(dem.height_m(lat, lon))
        if not math.isfinite(center):
            raise ValueError('DEM center height is not finite')
        az = np.deg2rad(np.arange(0, 360, 5, dtype=float))[:, None]
        distance = 1000.0 * np.r_[np.arange(0.5, 25.5, 0.5),
                                  np.arange(26, 200.1, 2.0)]
        delta = distance[None, :] / MOON_RADIUS_M
        phi = math.radians(lat)
        lam = math.radians(lon)
        phi2 = np.arcsin(np.clip(math.sin(phi)*np.cos(delta)
                                + math.cos(phi)*np.sin(delta)*np.cos(az), -1, 1))
        lam2 = lam + np.arctan2(np.sin(az)*np.sin(delta)*math.cos(phi),
                               np.cos(delta)-math.sin(phi)*np.sin(phi2))
        h = np.asarray(dem.heights_m(np.rad2deg(phi2), np.rad2deg(lam2)), dtype=float)
        if h.shape != phi2.shape or not np.isfinite(h).all():
            raise ValueError('Incomplete local DEM samples')
        vertical = (MOON_RADIUS_M+h)*np.cos(delta)-(MOON_RADIUS_M+center)
        horizontal = (MOON_RADIUS_M+h)*np.sin(delta)
        profile = np.rad2deg(np.arctan2(vertical, horizontal)).max(axis=1)
        if not np.isfinite(profile).all():
            raise ValueError('Invalid DEM horizon')
        return center, profile, True
    except (FileNotFoundError, OSError, ImportError, ValueError, IndexError) as error:
        logger.warning('Daylight DEM fallback at %.4f,%.4f: %s', lat, lon, error)
        return 0.0, np.zeros(72, dtype=float), False


# LUNA-DOC: Check Sun visibility above the local horizon.
def _sun_visible(lat, lon, suns, earths, may_eclipse):
    height, profile, has_dem = _fast_horizon(lat, lon)
    east_axis, north_axis, up_axis = (np.asarray(a, dtype=float) for a in local_axes(lat, lon))
    observer = (MOON_RADIUS_M + height) * up_axis
    to_sun = suns - observer
    distances = np.linalg.norm(to_sun, axis=1)
    direction = to_sun / distances[:, None]
    east = direction @ east_axis
    north = direction @ north_axis
    up = direction @ up_axis
    elevation = np.degrees(np.arctan2(up, np.hypot(east, north)))
    azimuth = np.degrees(np.arctan2(east, north)) % 360
    angles = azimuth / 5.0
    lower = np.floor(angles).astype(int)
    weight = angles - lower
    horizon = profile[lower % 72] * (1 - weight) + profile[(lower+1) % 72] * weight
    solar_radius = np.degrees(np.arcsin(np.clip(SUN_RADIUS_M / distances, 0, 1)))
    bright = elevation > horizon - solar_radius
    eclipsed = may_eclipse & bright
    if np.any(eclipsed):
        blocked = earth_occlusion_fraction(to_sun[eclipsed], earths[eclipsed] - observer)
        bright[eclipsed] &= blocked < 0.9999
    return bright, has_dem


# LUNA-DOC: Cache estimated durations of sunlit intervals.
@lru_cache(maxsize=36)
def _cached_estimate(lat, lon, radius, utc_midday):
    utc = parse_lunar_utc(utc_midday)
    start = max(MIN_UTC, utc - timedelta(days=WINDOW_DAYS//2))
    end = min(MAX_UTC, utc + timedelta(days=WINDOW_DAYS//2))
    times = time_grid(start, end, timedelta(hours=STEP_H))
    suns, earths = lunar_vectors(times)
    may_eclipse = eclipse_possible(suns, earths)
    points = _sample_positions(lat, lon, radius)
    durations = []
    total_events = 0
    dem_count = 0
    for latitude, longitude in points:
        flags, dem = _sun_visible(latitude, longitude, suns, earths, may_eclipse)
        lengths = _complete_intervals_hours(flags, STEP_H)
        if lengths:
            durations.append(sum(lengths)/len(lengths))
            total_events += len(lengths)
        dem_count += int(dem)
    return {
        'mean_continuous_sunlight_hours': round(sum(durations)/len(durations), 2) if durations else None,
        'sampled_sites': len(points),
        'sites_with_completed_intervals': len(durations),
        'dem_sites': dem_count,
        'completed_intervals': total_events,
        'window_start_utc': times[0].isoformat().replace('+00:00','Z'),
        'window_end_utc': times[-1].isoformat().replace('+00:00','Z'),
        'sample_step_hours': STEP_H,
        'status': ('ok' if dem_count == len(points) else 'geometry_only') if durations else 'no_complete_daylight_intervals',
        'note': ('Mean of nine representative samples; not a full-area integral. '
                 if radius is not None else 'Single point. ')
                + ('DEM terrain-horizon estimate used for all sites. ' if dem_count == len(points)
                   else 'DEM unavailable for some sites: zero-degree (spherical) horizon fallback used. ')
                + 'Intervals touching the 90-day window boundary are excluded; precision ~3 h.',
    }


# LUNA-DOC: Prepare a point or zone summary when the experimental feature is enabled.
def sunlight_duration_summary(payload):
    try:
        lat, lon = float(payload['lat']), float(payload['lon'])
        utc = parse_lunar_utc(payload['utc'])
        radius = payload.get('radius_m')
        if radius is not None:
            radius = float(radius)
            if not math.isfinite(radius) or not 1 <= radius <= MAX_ZONE_RADIUS_M:
                raise ValueError('Invalid zone radius')
            radius = round(radius, 1)
        if not all(math.isfinite(x) for x in (lat, lon)) or not -90 <= lat <= 90 or not -180 <= lon <= 180:
            raise ValueError('Invalid lunar latitude/longitude')
    except (KeyError, TypeError, OverflowError) as error:
        raise ValueError('Send lat, lon and utc (optional radius_m).') from error
    day = utc.replace(hour=12, minute=0, second=0, microsecond=0)
    return {
        'mode': 'zone' if radius is not None else 'point',
        'sampled_utc': utc.isoformat().replace('+00:00', 'Z'),
        **_cached_estimate(round(lat, 5), round(lon, 5), radius, day),
    }
