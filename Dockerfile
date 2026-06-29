FROM node:20-slim

WORKDIR /app

# Install Docker CLI so the worker can spawn the scraper container
# (only needed if running inside Docker with Docker socket mounted)
RUN apt-get update && apt-get install -y --no-install-recommends \
    docker.io \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

CMD ["npm", "run", "worker"]
