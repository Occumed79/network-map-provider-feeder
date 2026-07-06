FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    SCRAPER_PROVIDER=parallel_mapped_http \
    MAP_SOURCES=bing,google,apple \
    DISABLE_TELEMETRY=1

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

CMD ["npm", "run", "worker"]
