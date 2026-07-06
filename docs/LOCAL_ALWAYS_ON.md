# Local always-on worker

This is the free continuous option: run the feeder on a computer you control.

## What you need

- A computer that can stay on
- Docker Desktop installed
- The Neon connection string for the shared database
- The GitHub repo cloned locally

## Basic setup

```bash
git clone https://github.com/Occumed79/network-map-provider-feeder.git
cd network-map-provider-feeder
cp .env.example .env
```

Open `.env` and paste the Neon connection string into `DATABASE_URL`.

Do not commit `.env`.

## Start the worker

```bash
docker compose up --build -d
```

This starts the feeder in the background.

## Watch logs

```bash
docker compose logs -f feeder
```

Good signs:

```text
Free-only source policy passed
Worker starting
Read-only Neon schema validation passed
Targeted feeder jobs seeded
Processing job
Scraper completed
Job completed
```

## Stop the worker

```bash
docker compose down
```

## Restart after reboot

```bash
cd network-map-provider-feeder
docker compose up -d
```

The compose file uses `restart: unless-stopped`, so Docker should try to keep it running while Docker Desktop is running.

## Keep it conservative first

Use the default settings first:

```text
DEFAULT_CONCURRENCY=1
MAX_JOBS_PER_LOOP=1
DEFAULT_SCRAPER_DEPTH=1
```

Increase only after the worker proves it can complete jobs without crashing.

## Best hardware

A spare desktop, mini PC, or always-plugged-in laptop is better than a laptop you use daily. The worker needs Docker and browser automation, so sleep mode will stop it.

## Important

This worker writes to the existing Neon tables. It should not change schema during normal operation. Keep:

```text
ALLOW_SCHEMA_CHANGES=0
```
