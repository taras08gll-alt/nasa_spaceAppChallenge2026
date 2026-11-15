# LUNA-DOC: Utility for retrieving NAIF SPICE kernels required by astronomical ephemerides.
# LUNA-DOC: Do not download kernels for each user request; downloading is part of server provisioning.
"""Download the five NAIF SPICE kernels required by move_calculation.py.

Usage: python backend/download_kernels.py [--check]
Source: NASA/JPL Navigation and Ancillary Information Facility (NAIF).
The original ZIP did not contain these datasets; internet access is needed.
"""

import argparse
from pathlib import Path
import shutil
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent / "kernels"
BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels/"
SOURCES = {
    "naif0012.tls": "lsk/naif0012.tls",
    "de440.bsp": "spk/planets/de440.bsp",
    "moon_de440_250416.tf": "fk/satellites/moon_de440_250416.tf",
    "moon_pa_de440_200625.bpc": "pck/moon_pa_de440_200625.bpc",
    "pck00011.tpc": "pck/pck00011.tpc",
}


# LUNA-DOC: Check for, or download, the required NAIF files into backend/kernels.
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="show missing files without downloading")
    args = parser.parse_args()
    missing = [name for name in SOURCES if not (ROOT / name).is_file() or (ROOT / name).stat().st_size == 0]
    if args.check:
        print("Missing SPICE kernels: " + (", ".join(missing) if missing else "none"))
        return 1 if missing else 0
    if not missing:
        print("All SPICE kernels already available.")
        return 0
    ROOT.mkdir(parents=True, exist_ok=True)
    for name in missing:
        target = ROOT / name
        part = ROOT / (name + ".part")
        url = BASE + SOURCES[name]
        print(f"Downloading {name} from NASA/JPL NAIF...", flush=True)
        try:
            request = Request(url, headers={"User-Agent": "LUNA-Spiculum/1.0"})
            with urlopen(request, timeout=120) as response, part.open("wb") as output:
                shutil.copyfileobj(response, output, 1024 * 1024)
            if part.stat().st_size == 0:
                raise RuntimeError(f"Empty download: {name}")
            part.replace(target)
            print(f"Saved {name} ({target.stat().st_size:,} bytes)", flush=True)
        finally:
            part.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
