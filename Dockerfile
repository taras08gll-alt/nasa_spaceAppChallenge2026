# One HTTP service for the frontend and Flask API (both under the same host).
# Docker builds the CURRENT JS sources, not the stale bundled assets from Nov 10.
FROM node:22.18.0-bookworm-slim AS website
WORKDIR /site
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PORT=8000
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./backend/
COPY --from=website /site/dist/ ./frontend/dist/

# Initial Docker build downloads missing JPL NAIF kernels to make Moon
# lighting work on a fresh server. Set FETCH_SPICE_KERNELS=0 if provided
# separately / building offline. NAIF de440.bsp is a large binary file.
ARG FETCH_SPICE_KERNELS=1
RUN if [ "$FETCH_SPICE_KERNELS" = "1" ]; then python backend/download_kernels.py; fi

EXPOSE 8000
# Single worker ensures CSPICE kernel state is not duplicated across processes.
CMD ["sh", "-c", "exec gunicorn --chdir backend --bind 0.0.0.0:${PORT:-8000} --workers 1 --threads 4 --timeout 180 calculation:app"]
