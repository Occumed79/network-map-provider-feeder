# Use the scraper image as the runtime base so Render does not need Docker-in-Docker.
# The app runs the google-maps-scraper binary directly inside this container.
FROM gosom/google-maps-scraper:latest

USER root
WORKDIR /app
ENTRYPOINT []

ENV NODE_ENV=production \
    SCRAPER_MODE=binary \
    SCRAPER_BINARY=google-maps-scraper \
    DISABLE_TELEMETRY=1

RUN set -eux; \
    if ! command -v node >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -; \
      apt-get install -y --no-install-recommends nodejs; \
      rm -rf /var/lib/apt/lists/*; \
    fi; \
    if ! command -v npm >/dev/null 2>&1; then \
      corepack enable || true; \
    fi; \
    if ! command -v google-maps-scraper >/dev/null 2>&1; then \
      scraper_path="$(find / -type f -name 'google-maps-scraper' -perm /111 2>/dev/null | head -n 1)"; \
      test -n "$scraper_path"; \
      ln -sf "$scraper_path" /usr/local/bin/google-maps-scraper; \
    fi; \
    node --version; \
    npm --version; \
    google-maps-scraper -help >/dev/null 2>&1 || true

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .

CMD ["npm", "run", "worker"]
