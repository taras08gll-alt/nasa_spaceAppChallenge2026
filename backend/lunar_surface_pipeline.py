#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# LUNA-DOC: Standalone DEM and JPL Horizons calculator for lunar surface analysis; the CLI runs outside the website.
# LUNA-DOC: NASA ldem_64.tif stores elevations in kilometers relative to a 1737.4 km radius; convert these values to meters.
# LUNA-DOC: This is NOT a historical temperature archive for 1800-2100; temperature comes from the thermal model and ephemerides.
"""Lunar DEM + Horizons thermal model (educational/engineering prototype).

NASA SVS 4720 ldem_64.tif: float32 heights (km) above the 1737.4 km sphere.
Calculates a modelled (NOT directly observed) lunar surface temperature.
Python >=3.10; pip install numpy tifffile requests
"""
from __future__ import annotations
import argparse
import csv
import json
import math
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import numpy as np

R_M = 1_737_400.0
AU_M = 149_597_870_700.0
SIGMA = 5.670374419e-8
S0 = 1361.0
HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api'

# LUNA-DOC: Simplified thermal model parameters in SI units.
@dataclass
class ThermalParameters:
    albedo: float = 0.12
    emissivity: float = 0.95
    c_surface: float = 25000.0      # J m-2 K-1, illustrative
    c_subsurface: float = 400000.0  # J m-2 K-1, illustrative
    h_between: float = 0.03         # W m-2 K-1, illustrative
    h_to_base: float = 0.003        # W m-2 K-1, illustrative
    t_base: float = 210.0           # K, illustrative
    t_surface_initial: float = 180.0
    t_subsurface_initial: float = 210.0

# LUNA-DOC: Access the large NASA TIFF without loading the entire map into memory.
class LunarDEM:
    """Memory-map the *actual* NASA ldem_64.tif, not a JPG screenshot."""
    # LUNA-DOC: The __init__ method initializes this class; refer to the implementation for its arguments and behavior.
    def __init__(self, path: str | Path):
        import tifffile
        self.path = Path(path)
        if not self.path.exists():
            raise FileNotFoundError(f'DEM not found: {self.path}')
        with tifffile.TiffFile(self.path) as tf:
            page = tf.pages[0]
            shp, dtype = page.shape, page.dtype
            if shp != (11520, 23040) or dtype != np.float32:
                raise ValueError(f'Expected NASA ldem_64.tif 11520x23040 float32, got {shp}, {dtype}. '
                                 'ldem_64_uint.tif uses a DIFFERENT scale!')
            if page.compression != 1:
                raise ValueError('Expected uncompressed NASA ldem_64.tif; tiled/compressed TIFF needs a different reader.')
        self.data = tifffile.memmap(self.path)
        self.height, self.width = self.data.shape

    # LUNA-DOC: Read one elevation value and convert kilometers to meters.
    def height_m(self, lat: float, lon: float) -> float:
        """Bilinear sampling: 0 lon at map center, west -180 at left; rows north->south.
        Pixel centers are offset by half a pixel. Longitude wraps at +/-180.
        """
        if not -90 <= lat <= 90:
            raise ValueError('Latitude must be between -90 and +90 degrees.')
        lon = ((lon + 180.0) % 360.0)
        x = lon / 360.0 * self.width - 0.5
        y = (90.0 - lat) / 180.0 * self.height - 0.5
        y = float(np.clip(y, 0, self.height - 1))
        x0 = math.floor(x); y0 = math.floor(y)
        fx, fy = x - x0, y - y0
        x0 %= self.width; x1 = (x0 + 1) % self.width
        y1 = min(y0 + 1, self.height - 1)
        h00 = float(self.data[y0, x0]); h10 = float(self.data[y0, x1])
        h01 = float(self.data[y1, x0]); h11 = float(self.data[y1, x1])
        return (h00 * (1-fx)*(1-fy) + h10*fx*(1-fy) + h01*(1-fx)*fy + h11*fx*fy) * 1000.0

    # LUNA-DOC: Read elevation values for an array of points using vectorized operations.
    def heights_m(self, lat, lon):
        """Bilinear height lookup for arrays of geographic coordinates."""
        x = (lon + 180) % 360 / 360 * self.width - 0.5
        y = np.clip((90 - lat) / 180 * self.height - 0.5, 0, self.height - 1)
        x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
        fx, fy = x - x0, y - y0
        x0 %= self.width
        x1 = (x0 + 1) % self.width
        y1 = np.minimum(y0 + 1, self.height - 1)
        north = (1 - fx) * self.data[y0, x0] + fx * self.data[y0, x1]
        south = (1 - fx) * self.data[y1, x0] + fx * self.data[y1, x1]
        return 1000 * ((1 - fy) * north + fy * south)

    # LUNA-DOC: Calculate a neighboring point at a specified distance and azimuth.
    @staticmethod
    def destination(lat: float, lon: float, bearing_deg: float, distance_m: float):
        """Spherical great-circle forward calculation. Bearing clockwise from north."""
        lat1, lon1, az = map(math.radians, (lat, lon, bearing_deg))
        delta = distance_m / R_M
        radial = math.cos(lat1) * math.cos(delta) - math.sin(lat1) * math.sin(delta) * math.cos(az)
        east = math.sin(delta) * math.sin(az)
        z = math.sin(lat1) * math.cos(delta) + math.cos(lat1) * math.sin(delta) * math.cos(az)
        lat2 = math.atan2(z, math.hypot(radial, east))
        lon2 = lon1 + math.atan2(east, radial)
        return math.degrees(lat2), (math.degrees(lon2) + 180) % 360 - 180

    # LUNA-DOC: Calculate slope and surface normal from neighboring elevations.
    def terrain(self, lat: float, lon: float, slope_spacing_m=1000.0,
                horizon_max_km=200.0, horizon_az_step_deg=5.0):
        hc = self.height_m(lat, lon)
        heights = {'center_m': hc}
        for name, az in [('north_m',0), ('east_m',90), ('south_m',180), ('west_m',270)]:
            la, lo = self.destination(lat, lon, az, slope_spacing_m)
            heights[name] = self.height_m(la, lo)
        grad_e = (heights['east_m']-heights['west_m'])/(2*slope_spacing_m)
        grad_n = (heights['north_m']-heights['south_m'])/(2*slope_spacing_m)
        slope = math.degrees(math.atan(math.hypot(grad_e, grad_n)))
        # normal in local ENU coordinates
        n = np.array([-grad_e, -grad_n, 1.0]); n /= np.linalg.norm(n)
        # dense near-field, coarser far-field; DEM ~0.5km per pixel at equator
        distances = np.r_[np.arange(0.5, min(horizon_max_km, 25)+0.1, 0.5),
                          np.arange(26.0, horizon_max_km+0.1, 2.0)] * 1000.0
        horizons = []
        for az in np.arange(0.0, 360.0, horizon_az_step_deg):
            best = -90.0
            for dist in distances:
                la, lo = self.destination(lat, lon, float(az), float(dist))
                h = self.height_m(la, lo)
                angle = dist / R_M
                vertical = (R_M+h)*math.cos(angle)-(R_M+hc)
                tangent = (R_M+h)*math.sin(angle)
                best = max(best, math.degrees(math.atan2(vertical,tangent)))
            horizons.append([round(float(az),4), round(best,6)])
        return {**heights,'slope_deg':slope, 'gradient_e':grad_e,'gradient_n':grad_n,
                'normal_enu':n.tolist(), 'spacing_m':slope_spacing_m,
                'horizon_profile_az_deg_elev_deg':horizons,
                'horizon_max_km':horizon_max_km,'dem':'NASA SVS ldem_64.tif'}


# LUNA-DOC: Read a horizon profile around the selected point.
def horizon_at(profile, az_deg):
    az = az_deg%360.0
    step=360.0/len(profile)
    k=az/step
    i0=int(math.floor(k))%len(profile)
    i1=(i0+1)%len(profile)
    frac=k-math.floor(k)
    return profile[i0][1]*(1-frac)+profile[i1][1]*frac


# LUNA-DOC: Calculate the visible fraction of the solar disk above the local horizon.
def sun_fraction(elev_deg, horizon_deg):
    # Approximate partial solar disk using a linear transition of +/-0.266 deg.
    # NOT exact circle-segment integration; adequate away from terminator.
    return max(0.0,min(1.0,(elev_deg-horizon_deg+0.266)/0.532))


# LUNA-DOC: Solve the nonlinear thermal balance for one step using Newton's method.
def newton_thermal_step(ts_old,td_old,absorbed, dt_seconds, p:ThermalParameters):
    """Unconditionally stable backward-Euler two-node heat model.
    Subsurface node algebraically eliminated; solve monotonic quartic with Newton.
    Capacities / conduction numbers are *tunable example parameters*, not calibrated lunar constants.
    """
    cs, cd, h, hb = p.c_surface, p.c_subsurface, p.h_between, p.h_to_base
    den = cd/dt_seconds+h+hb
    a = (cd/dt_seconds*td_old+hb*p.t_base)/den
    b = h/den
    coeff = cs/dt_seconds + h*(1-b)
    rhs = cs/dt_seconds*ts_old + h*a + absorbed
    x = max(25.0,ts_old)
    for _ in range(12):
        f = coeff*x + p.emissivity*SIGMA*x**4 - rhs
        deriv = coeff + 4*p.emissivity*SIGMA*x**3
        x_new = max(25.0, x-f/deriv)
        if abs(x_new-x) < 1e-8:
            x=x_new; break
        x=x_new
    td_new=a+b*x
    if not (math.isfinite(x) and math.isfinite(td_new)):
        raise ArithmeticError('Thermal solver failed')
    return x,td_new


# LUNA-DOC: Fetch JPL Horizons API data with error handling.
def _get_horizons(params: dict, retries=3):
    import requests
    last=None
    for attempt in range(retries):
        try:
            r=requests.get(HORIZONS_URL,params=params,timeout=120,
                           headers={'User-Agent':'LunarResearchPrototype/1.0'})
            r.raise_for_status()
            body=r.text
            if '$$SOE' not in body or '$$EOE' not in body:
                raise RuntimeError('No ephemeris in Horizons reply:\n'+body[:1300])
            return body
        except Exception as exc:
            last=exc
            if attempt+1<retries: time.sleep(2*(attempt+1))
    raise RuntimeError(f'Horizons query failed: {last}')


# LUNA-DOC: Parse the ephemeris table from an API response.
def _ephem_rows(payload):
    text=payload.split('$$SOE',1)[1].split('$$EOE',1)[0]
    return [r for r in csv.reader(text.splitlines(), skipinitialspace=True) if r and r[0].strip()]


# LUNA-DOC: Extract numeric components from API messages.
def _numeric_tail(row, n):
    vals=[]
    for s in row[1:]:
        try: vals.append(float(s.strip()))
        except ValueError: pass
    if len(vals)<n:
        raise ValueError('Unexpected Horizons columns: '+repr(row))
    return vals[-n:]


# LUNA-DOC: Split a long time series into safe request batches.
def _chunks(start, finish, step_h, days_per_chunk=12):
    t=start
    while t<finish:
        end=min(finish,t+timedelta(days=days_per_chunk))
        yield t,end
        t=end


# LUNA-DOC: Build a sequence of Sun vectors over a UTC interval.
def horizons_sun_series(lat,lon,height_m,start,finish,step_h):
    """Horizons observer Sun az/elevation + Moon->Sun range vectors for same UTC grid.
    Az/el are at sphere-tangent site (lunar geodetic lat/lon) in the Horizons frame.
    IMPORTANT: verify site frame matches the DEM definition; no blind ICRF XYZ mixing.
    """
    lon_east=lon%360.0
    entries=[]
    for chunk_start,chunk_end in _chunks(start,finish,step_h):
        base={
            'format':'text','MAKE_EPHEM':'YES','OBJ_DATA':'NO',
            'CSV_FORMAT':'YES','CAL_FORMAT':'JD','TIME_TYPE':'UT',
            'START_TIME':chunk_start.strftime('%Y-%m-%d %H:%M:%S'),
            'STOP_TIME':chunk_end.strftime('%Y-%m-%d %H:%M:%S'),
            'STEP_SIZE':f'{step_h} h',
        }
        obs={**base,'COMMAND':'10','EPHEM_TYPE':'OBSERVER','CENTER':'coord@301',
             'COORD_TYPE':'GEODETIC','SITE_COORD':f'{lon_east:.10f},{lat:.10f},{height_m/1000:.8f}',
             'QUANTITIES':'4','ANG_FORMAT':'DEG','APPARENT':'AIRLESS',
             'SKIP_DAYLT':'NO','EXTRA_PREC':'YES'}
        vec={**base,'COMMAND':'10','EPHEM_TYPE':'VECTORS','CENTER':'500@301',
             'VEC_TABLE':'1','REF_PLANE':'FRAME','REF_SYSTEM':'ICRF',
             'VEC_CORR':'NONE','OUT_UNITS':'KM-S'}
        obs_rows=_ephem_rows(_get_horizons(obs))
        vec_rows=_ephem_rows(_get_horizons(vec))
        # Parse observer quantities: JD + solar/lunar flag fields + azimuth/elevation.
        # Parse vector-table 1: JD + x,y,z (km). Do not use the inertial
        # XYZ directly for local normals; observer az/el is already local.
        if len(obs_rows)!=len(vec_rows):
            raise RuntimeError(f'Horizons output count mismatch: {len(obs_rows)} vs {len(vec_rows)}')
        for rowo,rowv in zip(obs_rows,vec_rows):
            jdo=float(rowo[0]); jdv=float(rowv[0])
            if abs(jdo-jdv)>1e-5:
                raise RuntimeError(f'Horizons JD mismatch {jdo} vs {jdv}')
            az,alt = _numeric_tail(rowo,2)
            xyz = _numeric_tail(rowv,3)
            dist=math.sqrt(sum(v*v for v in xyz))
            if not (0<=az<=360 and -90<=alt<=90 and 1.3e8<dist<1.6e8):
                raise RuntimeError(f'Implausible Horizons data: az={az}, elev={alt}, Sun range={dist}km')
            entries.append((jdo,az,alt,dist))
    # handle inclusive overlapping chunks
    by_jd={round(jd,7): (jd,az,alt,dist) for jd,az,alt,dist in entries}
    rows=[by_jd[key] for key in sorted(by_jd)]
    expected=int(round((finish-start).total_seconds()/(step_h*3600)))+1
    if len(rows)!=expected:
        raise RuntimeError(f'Expected {expected} Horizons records, got {len(rows)}. '
                           'Check TIME_TYPE, chunk alignment and records near target date.')
    return rows


# LUNA-DOC: Alternatively import a precomputed time series.
def read_sun_csv(path):
    """For an existing backend: UTC,azimuth_deg,elevation_deg,sun_distance_km.
    All points must be spaced at --step-hours on a continuous interval.
    """
    records=[]
    with open(path,newline='',encoding='utf-8-sig') as f:
        for r in csv.DictReader(f):
            dt=datetime.fromisoformat(r['utc'].replace('Z','+00:00'))
            if dt.tzinfo is None: raise ValueError('CSV UTC needs timezone Z or +00:00')
            records.append((dt.astimezone(timezone.utc),float(r['azimuth_deg']),
                            float(r['elevation_deg']),float(r['sun_distance_km'])))
    return records


# LUNA-DOC: Run the full DEM, solar illumination, and temperature pipeline and prepare Excel output.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
def calculate(dem_path,lat,lon,utc,days=90,step_hours=3,source='horizons',
              sun_csv=None,output_dir='lunar_output',slope_spacing_m=1000,
              max_horizon_km=200, param=None):
    if not (-90 <= lat <=90): raise ValueError('Latitude out of range')
    if not (1800<=utc.year<=2100): raise ValueError('Supported application range: 1800–2100')
    if days<=0 or step_hours<=0 or days*24%step_hours!=0:
        raise ValueError('days*24 must be divisible by step-hours')
    p=param or ThermalParameters()
    out=Path(output_dir);out.mkdir(parents=True,exist_ok=True)
    dem=LunarDEM(dem_path)
    terrain=dem.terrain(lat,lon,slope_spacing_m,max_horizon_km)
    start=utc-timedelta(days=days)
    if source=='horizons':
        src=horizons_sun_series(lat,lon,terrain['center_m'],start,utc,step_hours)
        dat=[(start+timedelta(hours=i*step_hours), az,el,range_km)
             for i,(_,az,el,range_km) in enumerate(src)]
    elif source=='csv':
        if not sun_csv: raise ValueError('Use --sun-csv for CSV source')
        dat=read_sun_csv(sun_csv)
        expected=int(days*24/step_hours)+1
        if len(dat)!=expected: raise ValueError(f'CSV must include {expected} samples from start to end; got {len(dat)}')
        for i,(dt,_,_,_) in enumerate(dat):
            should=start+timedelta(hours=i*step_hours)
            if abs((dt-should).total_seconds())>1:
                raise ValueError(f'CSV timestamp mismatch at {i}: {dt} != {should}')
    else: raise ValueError('unknown source')
    normal=terrain['normal_enu']; profile=terrain['horizon_profile_az_deg_elev_deg']
    ts, td=p.t_surface_initial,p.t_subsurface_initial
    rows=[]
    for i,(dt,az,elev,range_km) in enumerate(dat):
        hr=horizon_at(profile,az)
        visible=sun_fraction(elev,hr)
        azr,er=map(math.radians,(az,elev))
        sun_enu=(math.cos(er)*math.sin(azr),math.cos(er)*math.cos(azr),math.sin(er))
        cosi=max(0.0,sum(a*b for a,b in zip(normal,sun_enu)))
        incident=S0*(AU_M/(range_km*1000.0))**2 *cosi*visible
        absorbed=(1-p.albedo)*incident
        if i>0: ts,td=newton_thermal_step(ts,td,absorbed,step_hours*3600,p)
        rows.append({
            'utc':dt.isoformat(timespec='milliseconds').replace('+00:00','Z'),
            'azimuth_deg':round(az,8),'elevation_deg':round(elev,8),
            'sun_distance_km':round(range_km,3),'horizon_deg':round(hr,6),
            'visible_fraction':round(visible,8),'cos_incidence':round(cosi,8),
            'incident_w_m2':round(incident,4),'absorbed_w_m2':round(absorbed,4),
            'surface_K':round(ts,5),'subsurface_K':round(td,5),
            'surface_C':round(ts-273.15,5)
        })
    summary={
        'status':'modelled_not_measured',
        'method':'implicit_two_node_regolith_illustrative_v1',
        'time_utc':utc.isoformat(timespec='milliseconds').replace('+00:00','Z'),
        'latitude_deg':lat,'longitude_deg':lon,
        'temperature_surface_C':rows[-1]['surface_C'],
        'temperature_surface_K':rows[-1]['surface_K'],
        'temperature_subsurface_K':rows[-1]['subsurface_K'],
        'sun_elevation_deg':rows[-1]['elevation_deg'],
        'sun_azimuth_deg':rows[-1]['azimuth_deg'],
        'surface_incident_w_m2':rows[-1]['incident_w_m2'],
        'sun_visible_fraction':rows[-1]['visible_fraction'],
        'terrain':terrain, 'parameters':asdict(p),
        'time_series':{'days':days,'step_hours':step_hours,'samples':len(rows)},
        'warnings':['This is NOT a direct Diviner measurement and not a validated temperature forecast.',
                    'Thermal parameters are prototypes; calibrate with Diviner and check other local times.',
                    f'Horizon considers terrain only within {max_horizon_km:g} km and uses {terrain["dem"]}.',
                    'Solar ephemeris does not provide solar storms or non-solar thermal sources.'],
        'sources':[
            'https://svs.gsfc.nasa.gov/4720/',
            'https://pds-geosciences.wustl.edu/missions/lro/diviner.htm',
            'https://ssd-api.jpl.nasa.gov/doc/horizons.html'
        ]
    }
    (out/'lunar_result.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    with (out/'temperature_timeseries.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0].keys()));writer.writeheader();writer.writerows(rows)
    # Excel uses cols B:G; rows are already at uniform steps and include t0.
    with (out/'excel_time_inputs.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.writer(f)
        for item in rows:
            writer.writerow([item['utc'],item['azimuth_deg'],item['elevation_deg'],
                             item['sun_distance_km'],item['horizon_deg'],item['visible_fraction']])
    with (out/'excel_dem_inputs.csv').open('w',newline='',encoding='utf-8-sig') as f:
        writer=csv.writer(f)
        for v in ['center_m','north_m','south_m','east_m','west_m']:
            writer.writerow([terrain[v]])
    return summary


# LUNA-DOC: Parse CLI arguments and execute the requested operation.
def main(argv=None):
    arg=argparse.ArgumentParser(description='NASA LOLA DEM + Horizons lunar model. Estimates not measurements.')
    sub=arg.add_subparsers(dest='command',required=True)
    ins=sub.add_parser('inspect-dem',help='check the actual NASA float32 TIFF and a sample height')
    ins.add_argument('--dem',required=True)
    ins.add_argument('--lat',type=float,default=43.34786624043)
    ins.add_argument('--lon',type=float,default=-132.52819036146)
    calc=sub.add_parser('calculate',help='calculate model temperature and output CSV for Excel')
    calc.add_argument('--dem',required=True)
    calc.add_argument('--lat',required=True,type=float)
    calc.add_argument('--lon',required=True,type=float)
    calc.add_argument('--utc',required=True,help='e.g. 2026-11-14T20:43:00Z')
    calc.add_argument('--days',type=int,default=90)
    calc.add_argument('--step-hours',type=int,default=3)
    calc.add_argument('--source',choices=['horizons','csv'],default='horizons')
    calc.add_argument('--sun-csv',help='if source=csv; headings UTC,azimuth_deg,elevation_deg,sun_distance_km')
    calc.add_argument('--output-dir',default='lunar_output')
    calc.add_argument('--slope-spacing-m',type=float,default=1000)
    calc.add_argument('--horizon-max-km',type=float,default=200)
    for name, default in [('albedo',0.12),('emissivity',0.95),('c-surface',25000),
                          ('c-subsurface',400000),('h-between',0.03),('h-to-base',0.003),
                          ('t-base',210),('t-surface-initial',180),('t-subsurface-initial',210)]:
        calc.add_argument('--'+name,type=float,default=default)
    args=arg.parse_args(argv)
    if args.command=='inspect-dem':
        dem=LunarDEM(args.dem)
        print(json.dumps({'path':str(dem.path),'shape':[dem.height,dem.width],
                          'height_m':dem.height_m(args.lat,args.lon),
                          'latitude':args.lat,'longitude':args.lon},ensure_ascii=False,indent=2))
    else:
        dt=datetime.fromisoformat(args.utc.replace('Z','+00:00'))
        if dt.tzinfo is None: raise ValueError('UTC timestamp requires Z or timezone offset')
        dt=dt.astimezone(timezone.utc)
        p=ThermalParameters(albedo=args.albedo,emissivity=args.emissivity,
            c_surface=args.c_surface,c_subsurface=args.c_subsurface,
            h_between=args.h_between,h_to_base=args.h_to_base,t_base=args.t_base,
            t_surface_initial=args.t_surface_initial,
            t_subsurface_initial=args.t_subsurface_initial)
        if not (0<=p.albedo<1 and 0<p.emissivity<=1 and min(p.c_surface,p.c_subsurface)>0
                and min(p.h_between,p.h_to_base)>=0 and min(p.t_surface_initial,p.t_subsurface_initial)>0):
            raise ValueError('Invalid thermal coefficients')
        result=calculate(args.dem,args.lat,args.lon,dt,args.days,args.step_hours,
                         args.source,args.sun_csv,args.output_dir,args.slope_spacing_m,
                         args.horizon_max_km,p)
        print(json.dumps({k:result[k] for k in ('status','time_utc','temperature_surface_C',
                    'sun_elevation_deg','sun_visible_fraction','surface_incident_w_m2')},
                    ensure_ascii=False,indent=2))
        print('Files saved under:',args.output_dir)

if __name__=='__main__':
    try: main()
    except Exception as e:
        print('ERROR:',e,file=sys.stderr)
        sys.exit(1)
