# LUNA-DOC: Read-only mission catalog: administrators edit JSON on the server, but visitors cannot change it.
# LUNA-DOC: The status values completed and planned control styles for historic and future mission markers.
# LUNA-DOC: landing_utc is permitted only for completed missions; clicking a marker changes the simulation date and time.
"""Backend-owned marker catalogue. No public editing endpoint."""
import json
import os
from pathlib import Path

from flask import Blueprint, jsonify

missions_api = Blueprint("missions_api", __name__)
_DEFAULT_FILE = Path(__file__).with_name("mission_markers.json")


# LUNA-DOC: Read the server catalog, validate unique IDs, coordinates, and field types, and return safe entries.
# LUNA-DOC: Preserve the existing function contract; changing arguments can break frontend/backend compatibility.
def read_missions():
    path = Path(os.environ.get("LUNAR_MISSIONS_FILE", str(_DEFAULT_FILE)))
    with path.open(encoding="utf-8") as stream:
        data = json.load(stream)
    if not isinstance(data, list) or len(data) > 5000:
        raise ValueError("Mission catalogue must be an array of at most 5000 records")
    ids = set()
    sanitized = []
    for row in data:
        if not isinstance(row, dict):
            raise ValueError("Mission must be a JSON object")
        identifier = str(row.get("id", ""))
        name = str(row.get("name", ""))
        if not identifier or len(identifier) > 90 or not name or len(name) > 160 or identifier in ids:
            raise ValueError("Mission id must be unique; name required")
        ids.add(identifier)
        latitude, longitude = float(row["latitude"]), float(row["longitude"])
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            raise ValueError("Invalid marker coordinates")
        record = {"id": identifier, "name": name, "latitude": latitude, "longitude": longitude}
        for key in ("date", "agency", "country", "description", "status", "category", "location", "accuracy", "source_url", "region"):
            value = row.get(key)
            record[key] = None if value is None else str(value)[:1200 if key == "description" else 256]
        # Historical touchdown time is an optional ISO-8601 UTC field.
        # Never force a date/time for planned missions that have no confirmed landing time.
        landing_utc = row.get("landing_utc")
        if landing_utc is not None:
            from datetime import datetime, timezone
            if not isinstance(landing_utc, str) or len(landing_utc) != 20 or not landing_utc.endswith("Z"):
                raise ValueError("landing_utc must be YYYY-MM-DDTHH:MM:SSZ")
            try:
                parsed = datetime.fromisoformat(landing_utc.replace("Z", "+00:00"))
            except ValueError as exc:
                raise ValueError("Invalid landing_utc") from exc
            if parsed.tzinfo != timezone.utc or row.get("status") != "completed":
                raise ValueError("Only completed missions can have confirmed landing_utc")
            record["landing_utc"] = landing_utc
        record["approximate"] = row.get("approximate") is True
        sanitized.append(record)
    return sanitized


# LUNA-DOC: Read-only markers API: invalid JSON returns 503 rather than crashing Flask.
@missions_api.get("/api/mission-markers")
def mission_markers():
    try:
        return jsonify({"missions": read_missions()})
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        from flask import current_app
        current_app.logger.exception("Invalid lunar mission catalogue")
        return jsonify(error="Mission catalogue unavailable"), 503
