FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    SCRAPER_PROVIDER=parallel_mapped_http \
    MAP_SOURCES=bing,google,apple \
    DISABLE_TELEMETRY=1 \
    PATH="/opt/venv/bin:$PATH"

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY scrapers/requirements.txt ./scrapers/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r scrapers/requirements.txt

COPY . .

CMD ["npm", "run", "worker"]
