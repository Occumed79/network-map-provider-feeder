# Render Deployment Guide

This document covers deploying the network-map-provider-feeder to Render.

## Prerequisites

- Active Render account (https://render.com)
- GitHub repository access (Occumed79/network-map-provider-feeder)
- Neon Postgres database with `DATABASE_URL` connection string
- Existing `provider_feeder_jobs` table in Neon (schema validation will confirm)

## Deployment Steps

### 1. Connect Repository to Render

1. Log in to [Render Dashboard](https://dashboard.render.com)
2. Click **New +** → **Web Service**
3. Select **Deploy existing code from a repository**
4. Authorize GitHub and select `Occumed79/network-map-provider-feeder`
5. Click **Connect**

### 2. Configure Web Service

#### Basic Settings
- **Name:** `network-map-provider-feeder`
- **Branch:** `main`
- **Runtime:** `Docker`
- **Build Command:** (leave empty - uses Dockerfile)
- **Start Command:** (leave empty - uses Dockerfile CMD)

#### Environment Variables

Add the following in the **Environment** section:

```
NODE_ENV=production
DATABASE_URL=<your-neon-connection-string>
SCRAPER_MODE=binary
SCRAPER_BINARY=google-maps-scraper
DISABLE_TELEMETRY=1
VALIDATE_SCHEMA_ON_START=1
AUTO_SEED_ON_START=1
MIN_PENDING_JOBS=25
MAX_AUTO_SEED_JOBS=250
DEFAULT_CONCURRENCY=1
MAX_JOBS_PER_LOOP=1
SCRAPER_TIMEOUT_MS=300000
RESET_STALE_RUNNING_MINUTES=120
DEFAULT_RADIUS_METERS=40000
DEFAULT_SCRAPER_DEPTH=1
DEFAULT_FAST_MODE=0
PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
PLAYWRIGHT_DRIVER_PATH=/opt/ms-playwright-go/1.57.0
PLAYWRIGHT_NODEJS_PATH=/usr/bin/node
```

**Optional targeting variables** (leave blank to process all regions):
- `TARGET_STATES=` (e.g., `CA,TX,FL`)
- `TARGET_CITIES=` (e.g., `Fresno CA,Pensacola FL`)
- `TARGET_SERVICE_LINES=` (e.g., `occupational_health,dot_physical`)

#### Plan Selection
- **Starter:** Free tier with monthly limits (suitable for initial testing)
- **Standard:** Paid tier with higher resource allocation

#### Instance Settings
- **Num Instances:** `1`
- **Health Check Path:** (can leave empty - worker doesn't expose HTTP endpoint)
- **Health Check Timeout:** `300` seconds

### 3. Deploy

1. Click **Create Web Service**
2. Render will automatically build the Docker image and deploy
3. Monitor the deployment progress in the **Logs** tab

## Post-Deployment Verification

Once deployed, verify the service is running:

### Check Render Logs
1. Go to your service page in Render Dashboard
2. Click **Logs**
3. You should see startup messages like:
   ```
   Validating Neon schema...
   Schema validation passed
   Resetting stale running jobs...
   Seeding targeted backlog...
   Starting job polling loop...
   ```

### Verify Database Activity

Query your Neon database:

```sql
-- Check job queue status
SELECT status, COUNT(*) as count
FROM provider_feeder_jobs
GROUP BY status
ORDER BY status;

-- Check for recent results
SELECT COUNT(*) FROM google_maps_raw_results;
SELECT COUNT(*) FROM provider_candidates;

-- View recent provider candidates
SELECT name, address, phone, confidence_score, status
FROM provider_candidates
ORDER BY updated_at DESC
LIMIT 10;
```

## Managing the Deployment

### View Logs
1. Open service in Render Dashboard
2. Click **Logs** tab
3. Scroll through worker startup and job processing logs

### Restart Service
1. Open service in Render Dashboard
2. Click **Manual Deploy** → **Deploy latest commit**
3. Or click **Settings** → **Restart service**

### Update Environment Variables
1. Open service in Render Dashboard
2. Click **Environment**
3. Modify variables and click **Save Changes**
4. Service restarts automatically

### Monitor Resource Usage
1. Open service in Render Dashboard
2. Click **Metrics** tab
3. View CPU, memory, and network usage

### Stop/Remove Service
1. Open service in Render Dashboard
2. Click **Settings** → **Delete Web Service**
3. Confirm deletion (this does NOT delete your database)

## Cost Considerations

### Free Tier (Starter Plan)
- 100 service hours per month
- 512 MB RAM, shared CPU
- Limited to light workloads
- Good for testing and development

### Standard Plan
- Pay-per-use (approximately $0.07/hour for the smallest instance)
- 1 GB RAM, dedicated CPU
- Recommended for production
- No monthly hour limits

## Troubleshooting

### Service won't start

**Issue:** Build fails or service crashes immediately

**Solution:**
1. Check Render logs for error messages
2. Verify `DATABASE_URL` is correct and accessible
3. Ensure Neon database tables exist (run schema validation manually)
4. Check that Node 20+ is available (Dockerfile handles this)

### Jobs not being processed

**Issue:** Worker runs but no jobs complete

**Solution:**
1. Check Render logs for "Starting job polling loop" message
2. Query Neon to verify `provider_feeder_jobs` table exists
3. Verify `DATABASE_URL` has proper permissions (SELECT, INSERT, UPDATE on all tables)
4. Check `AUTO_SEED_ON_START=1` if queue is empty

### High resource usage

**Issue:** CPU or memory spikes during scraping

**Solution:**
1. Reduce `DEFAULT_CONCURRENCY` (default: 1)
2. Reduce `MAX_JOBS_PER_LOOP` (default: 1)
3. Increase `SCRAPER_TIMEOUT_MS` if jobs timeout (default: 300000ms)
4. Upgrade to a Standard plan with more resources

### Database connection errors

**Issue:** "Cannot connect to Neon database" errors in logs

**Solution:**
1. Verify `DATABASE_URL` in Render Environment is correct
2. Check Neon allowlist includes Render's IP ranges
3. Test connection locally with: `psql "$DATABASE_URL"`
4. Restart the service to retry connection

## Local Testing Before Deployment

Test the Docker configuration locally before deploying:

```bash
# Create .env file
cp .env.example .env
# Edit .env with your DATABASE_URL

# Build and run locally
docker compose up --build

# In another terminal, monitor logs
docker logs -f network-map-provider-feeder
```

## Rollback

If deployment introduces issues:

1. Open Render service page
2. Click **Settings** → **Deploy History**
3. Find the previous stable commit
4. Click **Deploy** on that commit

This redeploys the previous version without data loss.
