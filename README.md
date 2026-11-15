# LUNA Spiculum

**Lunar Unified Navigational Atlas**  
*Interactive lunar exploration, environmental analysis, and mission visualization*

LUNA Spiculum is an interactive web-based lunar atlas developed for **NASA Space Apps Challenge 2026**. It combines a 3D representation of the Moon with astronomical ephemerides and numerical models to help users explore conditions at selected locations and across wider lunar regions.

> **Project mission:** Six space enthusiasts committed to advancing humanity’s sustainable return to the Moon and inspiring a passion for science.

## Features

- **Interactive 3D Moon** — explore the lunar surface using CesiumJS and lunar imagery/terrain layers.
- **Point mode** — select a position on the globe or enter lunar latitude and longitude directly.
- **Zone mode** — analyze a wider surface area using a selectable radius and parameter maps.
- **Time navigation** — choose a start and end time and explore simulated changes along the timeline.
- **Sun–Earth geometry** — visualize the positions and apparent motion of the Sun and Earth using SPICE ephemerides.
- **Surface environment estimates** — explore modeled temperature, illumination, solar incidence and other parameters.
- **Advanced analysis** — inspect charts, zone distributions, and three-dimensional parameter plots.
- **Mission markers** — view lunar mission locations and associated information.

Numerical outputs are **model-based estimates**, not direct in-situ measurements or mission-certified predictions. Accuracy depends on the underlying scientific models, ephemerides, and available terrain datasets.

## Technology stack

| Area | Technologies |
| --- | --- |
| Frontend | JavaScript, HTML, CSS, Vite |
| 3D visualization | CesiumJS |
| Backend / API | Python, Flask, JSON |
| Astronomy | NASA/JPL NAIF SPICE kernels, SpiceyPy |
| Numerical modeling | NumPy, thermal/regolith modeling code |
| Optional terrain and data processing | Lunar DEM datasets, tifffile, requests |
| Deployment | Ubuntu Linux, Nginx, SSH, SCP, rsync |

## Project structure

```text
LUNA-Spiculum/
├── backend/
│   ├── calculation.py            # Flask app and API endpoints
│   ├── move_calculation.py       # SPICE-based geometry
│   ├── lunar_results.py         # Point and time-period calculations
│   ├── lunar_surface_pipeline.py # DEM and data-processing utilities
│   ├── regolith_heat.py          # Thermal model
│   ├── zone_results.py          # Zone analysis
│   ├── mission_markers.py       # Mission marker API
│   └── download_kernels.py      # Download required NAIF datasets
├── frontend/
│   ├── index.html
│   ├── js/                    # Application and Cesium modules
│   ├── css/                   # UI styling
│   ├── img/                   # Selected lunar imagery
│   ├── public/                # Static public assets
│   ├── package.json
│   └── vite.config.mjs
├── README.md
├── .gitignore
└── requirements.txt
```

The published repository intentionally excludes generated builds, local environments, large terrain datasets, NAIF kernels, and selected oversized image assets.

## Run locally

### 1. Requirements

- Python **3.10+**
- Node.js and npm
- A network connection to obtain scientific datasets when needed

### 2. Install backend dependencies

From the project root:

```bash
python3 -m venv .venv
source .venv/bin/activate           # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

### 3. Prepare SPICE data

```bash
python3 backend/download_kernels.py --check
python3 backend/download_kernels.py
```

The downloader retrieves public NAIF kernels into `backend/kernels/`. Some downloads may be large. These files are not committed to GitHub.

Lunar terrain tiles and additional DEM datasets may be required for the full terrain and environmental-analysis experience. They are provided separately and should be configured for the target deployment. Without them, some visualization layers or calculations may be unavailable.

### 4. Build the frontend

```bash
cd frontend
npm ci
npm run build
cd ..
```

### 5. Start Flask

```bash
python3 backend/calculation.py
```

Open **http://127.0.0.1:5000/**. This uses Flask to serve the compiled frontend and the API on the same origin.

> The Vite development server does not have a default `/api` proxy in this source tree. For a straightforward local setup, use the build + Flask procedure above.

## API

The Flask server includes these routes:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | API, frontend build, and SPICE kernel status |
| `POST` | `/api/get_data` | Ephemerides, point/zone/time-series analysis, illumination |
| `GET` | `/api/mission-markers` | Lunar mission markers |

Basic health check:

```bash
curl http://127.0.0.1:5000/api/health
```

Basic endpoint test:

```bash
curl -X POST http://127.0.0.1:5000/api/get_data \
  -H 'Content-Type: application/json' \
  -d '{"lat":0,"lon":0}'
```

## Deployment notes

The application has been deployed on an **Ubuntu** server with **Nginx** in front of the Flask backend (port `5000`). Ensure the Nginx HTTPS server forwards `/api/` to Flask without removing the API path:

```nginx
location ^~ /api/ {
    proxy_pass http://127.0.0.1:5000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

For deployments under a URL subpath, use the correct Vite base when building and ensure asset paths and Nginx routing agree. The deployment configuration will vary between servers.

## Team

| Team member | Contribution |
| --- | --- |
| **Aleksander Andersen Shevchenko** | Team Lead |
| **Yehor Chesnokov** | Backend development, data analysis |
| **Taras Gladysh** | Full-stack development, design |
| **Hlib Hryhorian** | Backend development, data analysis |
| **Oleksandra Ivanova** | Management, testing and presentation of the project |
| **Mariana Zinkevych** | Project presentation, design |

**Team contacts:** [taras08gll@gmail.com](mailto:taras08gll@gmail.com) · [hryhorian.hlib_ak51@edu.kpi.ua](mailto:hryhorian.hlib_ak51@edu.kpi.ua)

## Data and attribution

- **NASA/JPL NAIF SPICE** — planetary and lunar ephemerides. <https://naif.jpl.nasa.gov/naif/>
- **CesiumJS** — 3D visualization engine. <https://cesium.com/platform/cesiumjs/>
- **Lunar imagery and DEM products** — retain attribution and comply with the terms of each data source included in your deployment.

This is an independent educational/research prototype developed for a hackathon; it is **not an official NASA product**.

## Before publishing

- Do not commit SSH keys, passwords, `.env` secrets, or server configuration containing credentials.
- Do not commit the `backend/kernels/` directory or server-side terrain/DEM datasets.
- `frontend/img/lroc_color_16bit_srgb_8k.png` exceeds GitHub's regular 100 MB file limit; it is excluded by `.gitignore`. If the full-resolution original is essential to version control, set up Git LFS **before** the initial commit.
- Review the source files and third-party assets before creating a public repository.
- Agree on a license with the team before adding a `LICENSE` file. No specific open-source license is implied by this README.
