# LUNA-DOC: Flask is the main HTTP entry point; routes are defined here while physics calculations live in separate modules.
# LUNA-DOC: Key URLs are /api/get_data, /api/health, /api/mission-markers, and the built frontend in frontend/dist.
# LUNA-DOC: The default server port is 5000; DEM and tile paths are configured through environment variables.
# LUNA-DOC: Request dispatch order matters: lighting, history, zone, ephemeris, then ordinary point selection.
from gzip import compress
import os
from pathlib import Path

from flask import Flask, jsonify, make_response, request, send_from_directory
from spiceypy.utils.exceptions import SpiceyError

from lunar_results import simulation_history, simulation_results
from move_calculation import ephemeris_response, lighting_response, motion_api
from zone_results import ZoneBusy, zone_field
from mission_markers import missions_api

# This single Flask process can serve both the compiled Vite site and /api/*.
# No production Vite proxy is required when deployed using the included Dockerfile.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = PROJECT_ROOT / "frontend" / "dist"
KERNEL_DIR = Path(__file__).resolve().parent / "kernels"
TILE_DIRS = {
    "moon-terrain": Path(os.getenv("LUNAR_TERRAIN_DIR", "/var/www/html/moon-terrain")),
    "moon-tiles-32k": Path(os.getenv("LUNAR_TILES_DIR", "/var/www/html/moon-tiles-32k")),
    "moon-hillshade": Path(os.getenv("LUNAR_HILLSHADE_DIR", "/var/www/html/moon-hillshade")),
}

app = Flask(__name__)
app.register_blueprint(motion_api)
app.register_blueprint(missions_api)


# LUNA-DOC: Compress large JSON responses with gzip when supported by the browser without modifying the response fields.
@app.after_request
def compress_large_json(response):
    if (request.method != "POST" or not response.is_json
            or (response.content_length or 0) < 16_384 or "Content-Encoding" in response.headers):
        return response

    response.vary.add("Accept-Encoding")
    if request.accept_encodings["gzip"] > 0:
        response.set_data(compress(response.get_data(), compresslevel=2, mtime=0))
        response.headers["Content-Encoding"] = "gzip"
    return response


# LUNA-DOC: Dispatch POST /api/get_data by request type and invoke the corresponding physical model.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
@app.post("/get_data")
@app.post("/api/get_data")
def get_data():
    data = request.get_json(silent=True)
    if isinstance(data, dict) and data.get("mode") == "lighting":
        return lighting_response(data)

    if isinstance(data, dict) and data.get("mode") == "history":
        try:
            return jsonify(simulation_history(data))
        except (TypeError, ValueError, OverflowError) as error:
            return jsonify(error=str(error)), 422
        except (OSError, SpiceyError, ArithmeticError, ImportError):
            app.logger.exception("Lunar point history failed")
            return jsonify(error="Point history unavailable. Check the backend logs."), 503

    if isinstance(data, dict) and data.get("mode") == "zone":
        try:
            return jsonify(zone_field(data))
        except ZoneBusy as error:
            return jsonify(error=str(error)), 429, {"Retry-After": "1"}
        except ValueError as error:
            return jsonify(error=str(error)), 400
        except (OSError, SpiceyError, ArithmeticError, ImportError):
            app.logger.exception("Lunar zone model failed")
            return jsonify(error="Zone model unavailable. Check the backend logs."), 503

    if isinstance(data, dict) and data.get("mode") == "ephemeris":
        values = data
    elif request.args.get("mode") == "ephemeris":
        values = request.args
    else:
        if not isinstance(data, dict) or "lat" not in data or "lon" not in data:
            return jsonify(error="Send lat and lon as JSON."), 400

        lat, lon = data["lat"], data["lon"]
        print(f"latitude: {lat}, longitude: {lon}", flush=True)
        return jsonify(status="ok", lat=lat, lon=lon)

    response = make_response(ephemeris_response(values))
    if response.status_code != 200:
        return response

    state = response.get_json()
    utc, earth_m, sun_m = state["utc"], state["earth_m"], state["sun_m"]
    lat, lon = values.get("lat"), values.get("lon")
    radius_m = values.get("radius_m")

    print(f"{utc} | Earth: {earth_m} | Sun: {sun_m}", flush=True)
    if lat is not None and lon is not None:
        print(f"latitude: {lat}, longitude: {lon}, radius_m: {radius_m}", flush=True)

    try:
        state["results"] = simulation_results(values, state)
    except (OSError, SpiceyError, ArithmeticError, ValueError, ImportError):
        app.logger.exception("Lunar surface model failed")
        state["results"] = {"note": "Surface model unavailable. Check the backend logs."}
    return jsonify(state)


# LUNA-DOC: Return the API status, built frontend readiness, and availability of essential SPICE kernels.
@app.get("/api/health")
def api_health():
    # Safe health check: distinguish routing issues from missing astronomical data.
    names = ("naif0012.tls", "de440.bsp", "moon_de440_250416.tf",
             "moon_pa_de440_200625.bpc", "pck00011.tpc")
    return jsonify(status="ok", api=True, frontend_ready=(DIST_DIR / "index.html").is_file(),
                   kernels_ready=all((KERNEL_DIR / name).is_file() for name in names))


# LUNA-DOC: Serve the built entry page, or return 503 when the Vite build is missing.
@app.get("/")
def index():
    if not (DIST_DIR / "index.html").is_file():
        return "Frontend not built: run 'cd frontend && npm ci && npm run build'", 503
    return send_from_directory(DIST_DIR, "index.html")


# LUNA-DOC: Serve static resources and large NASA tiles while reserving /api/* for Flask routes.
@app.get("/<path:filename>")
def public_file(filename):
    # Serve existing astronomical tiles if present on the VPS. They are not in
    # the submitted source archive; use the existing datasets or mounted dirs.
    for prefix, folder in TILE_DIRS.items():
        if filename.startswith(prefix + "/"):
            return send_from_directory(folder, filename[len(prefix) + 1:])
    if filename.startswith("api/"):
        return jsonify(error="API endpoint not found"), 404
    if (DIST_DIR / filename).is_file():
        return send_from_directory(DIST_DIR, filename)
    return "Not found", 404


# LUNA-DOC: Return a clear JSON error for unknown API routes.
@app.errorhandler(404)
def json_api_404(error):
    if request.path.startswith("/api/"):
        return jsonify(error="API endpoint not found", path=request.path), 404
    return error


if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")))
