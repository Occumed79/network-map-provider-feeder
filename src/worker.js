import { createServer } from "http";
import { query, withTransaction, end } from "./db.js";
import { runScraper } from "./scraper.js";
import { logger } from "./logger.js";
import { validateSchema } from "./schema.js";
import { ensureQueueBacklog } from "./jobSeeder.js";
import {
  normalizePhone,
  normalizeWebsite,
  normalizeName,
  normalizeLat,
  normalizeLng,
  computeDedupeKey,
  isNearbyDuplicate,
  computeConfidence,
} from "./normalize.js";

const POLL_INTERVAL = parseInt(process.env.WORKER_POLL_INTERVAL_MS || "30000", 10);
const MAX_JOBS_PER_LOOP = parseInt(process.env.MAX_JOBS_PER_LOOP || "1", 10);
const DEFAULT_CONCURRENCY = parseInt(process.env.DEFAULT_CONCURRENCY || "1", 10);
const VALIDATE_SCHEMA_ON_START = process.env.VALIDATE_SCHEMA_ON_START !== "0";
const AUTO_SEED_ON_START = process.env.AUTO_SEED_ON_START === "1";
const MIN_PENDING_JOBS = parseInt(process.env.MIN_PENDING_JOBS || "25", 10);
const MAX_AUTO_SEED_JOBS = parseInt(process.env.MAX_AUTO_SEED_JOBS || "250", 10);
const RESET_STALE_RUNNING_MINUTES = parseInt(process.env.RESET_STALE_RUNNING_MINUTES || "120", 10);

const health = {
  startedAt: new Date().toISOString(),
  ready: false,
  status: "starting",
  lastLoopAt: null,
  lastJobAt: null,
  lastJobId: null,
  lastError: null,
};

function startHealthServer() {
  const port = parseInt(process.env.PORT || "0", 10);
  if (!port) return null;

  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] || "/";
    if (!["/", "/health", "/healthz", "/status"].includes(path)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "network-map-provider-feeder", ...health }));
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info("Health server listening", { port });
  });
  return server;
}

async function resetStaleRunningJobs() {
  const { rows } = await query(
    `UPDATE provider_feeder_jobs
     SET status = 'pending', started_at = NULL,
         error = 'Reset stale running job after worker restart/deploy'
     WHERE status = 'running'
       AND started_at < now() - ($1::int * interval '1 minute')
     RETURNING id`,
    [RESET_STALE_RUNNING_MINUTES]
  );
  if (rows.length) logger.warn("Reset stale running jobs", { count: rows.length });
}

async function claimJobs(count) {
  const { rows } = await query(
    `UPDATE provider_feeder_jobs
     SET status = 'running', started_at = now(), completed_at = NULL,
         attempts = attempts + 1, error = NULL
     WHERE id IN (
       SELECT id FROM provider_feeder_jobs
       WHERE status = 'pending' AND attempts < max_attempts
       ORDER BY priority DESC, created_at ASC
       LIMIT $1::int
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [count]
  );
  return rows;
}

function mapRawResult(raw) {
  const title = raw.title || raw.name || raw.name_text || null;
  const category = raw.category || raw.type || raw.main_category || null;
  const categories = raw.categories || raw.types || (category ? [category] : null);
  const address = raw.address || raw.street || raw.full_address || null;
  const phone = raw.phone || raw.phone_number || raw.phoneNumber || null;
  const website = raw.website || raw.site || raw.url || null;
  const latitude = raw.latitude ?? raw.lat ?? raw.gps_coordinates?.latitude ?? null;
  const longitude = raw.longitude ?? raw.lng ?? raw.lon ?? raw.gps_coordinates?.longitude ?? null;
  return {
    title,
    category,
    categories,
    address,
    phone,
    website,
    latitude: latitude != null ? parseFloat(latitude) : null,
    longitude: longitude != null ? parseFloat(longitude) : null,
    googlePlaceId: raw.place_id || raw.google_place_id || raw.placeId || null,
    googleCid: raw.cid || raw.google_cid || raw.data_cid || null,
    reviewRating: raw.rating || raw.review_rating || raw.stars || null,
    reviewCount: raw.reviews || raw.review_count || raw.reviews_count || null,
    openHours: raw.open_hours || raw.hours || raw.working_hours || null,
    raw,
  };
}

async function insertRawResults(client, jobId, job, results) {
  const insertedRows = [];
  for (const raw of results) {
    const r = mapRawResult(raw);
    const { rows } = await client.query(
      `INSERT INTO google_maps_raw_results
        (job_id, query, country_code, title, category, categories, address,
         phone, website, latitude, longitude, google_place_id, google_cid,
         review_rating, review_count, open_hours, raw)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb)
       RETURNING id`,
      [
        jobId,
        job.query,
        job.country_code,
        r.title,
        r.category,
        r.categories ? JSON.stringify(r.categories) : null,
        r.address,
        r.phone,
        r.website,
        r.latitude,
        r.longitude,
        r.googlePlaceId,
        r.googleCid,
        r.reviewRating != null ? parseFloat(r.reviewRating) : null,
        r.reviewCount != null ? parseInt(r.reviewCount, 10) : null,
        r.openHours ? JSON.stringify(r.openHours) : null,
        JSON.stringify(raw),
      ]
    );
    insertedRows.push({ id: rows[0].id, mapped: r });
  }
  return insertedRows;
}

async function normalizeAndUpsertCandidates(client, jobId, job, rawRows) {
  let candidateCount = 0;
  for (const rawRow of rawRows) {
    const r = rawRow.mapped;
    if (!r.title) continue;

    const name = r.title;
    const normalizedName = normalizeName(name);
    const phone = normalizePhone(r.phone);
    const website = normalizeWebsite(r.website);
    const lat = normalizeLat(r.latitude);
    const lng = normalizeLng(r.longitude);
    const confidence = computeConfidence({
      title: name,
      address: r.address,
      phone: r.phone,
      website: r.website,
      latitude: r.latitude,
      longitude: r.longitude,
      google_place_id: r.googlePlaceId,
      review_count: r.reviewCount,
      review_rating: r.reviewRating,
    });
    const dedupeKey = computeDedupeKey({
      google_place_id: r.googlePlaceId,
      google_cid: r.googleCid,
      phone: r.phone,
      website: r.website,
      title: name,
      address: r.address,
    });

    const existing = await client.query("SELECT * FROM provider_feeder_candidates WHERE dedupe_key = $1::text", [dedupeKey]);
    let candidateId;

    if (existing.rows.length) {
      candidateId = existing.rows[0].id;
      await client.query(
        `UPDATE provider_feeder_candidates
         SET name = COALESCE(NULLIF($1::text,''), name),
             normalized_name = COALESCE(NULLIF($2::text,''), normalized_name),
             category = COALESCE($3::text, category),
             address = COALESCE($4::text, address),
             phone = COALESCE($5::text, phone),
             website = COALESCE($6::text, website),
             latitude = COALESCE($7::double precision, latitude),
             longitude = COALESCE($8::double precision, longitude),
             confidence_score = GREATEST(confidence_score, $9::double precision),
             updated_at = now()
         WHERE id = $10::bigint`,
        [name, normalizedName, r.category, r.address, phone, website, lat, lng, confidence, candidateId]
      );
    } else {
      let nearbyMatch = null;
      if (lat != null && lng != null) {
        const nearby = await client.query(
          `SELECT * FROM provider_feeder_candidates
           WHERE country_code = $1::varchar
             AND latitude IS NOT NULL AND longitude IS NOT NULL
             AND latitude BETWEEN $2::double precision - 0.002 AND $2::double precision + 0.002
             AND longitude BETWEEN $3::double precision - 0.002 AND $3::double precision + 0.002`,
          [job.country_code, lat, lng]
        );
        nearbyMatch = nearby.rows.find((c) => isNearbyDuplicate({ title: name, latitude: lat, longitude: lng }, c));
      }

      if (nearbyMatch) {
        candidateId = nearbyMatch.id;
        await client.query(
          `UPDATE provider_feeder_candidates
           SET confidence_score = GREATEST(confidence_score, $1::double precision), updated_at = now()
           WHERE id = $2::bigint`,
          [confidence, candidateId]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO provider_feeder_candidates
            (name, normalized_name, country_code, category, address,
             phone, website, latitude, longitude, confidence_score, status, dedupe_key)
           VALUES ($1::text,$2::text,$3::varchar,$4::text,$5::text,$6::text,$7::text,$8::double precision,$9::double precision,$10::double precision,'new',$11::text)
           RETURNING id`,
          [name, normalizedName, job.country_code, r.category, r.address, phone, website, lat, lng, confidence, dedupeKey]
        );
        candidateId = ins.rows[0].id;
        candidateCount++;
      }
    }

    await client.query(
      `INSERT INTO provider_feeder_candidate_sources (candidate_id, raw_result_id, job_id)
       VALUES ($1::bigint, $2::bigint, $3::bigint) ON CONFLICT DO NOTHING`,
      [candidateId, rawRow.id, jobId]
    );
  }
  return candidateCount;
}

async function processJob(job) {
  logger.info("Processing job", { jobId: job.id, query: job.query, attempt: job.attempts });
  health.lastJobAt = new Date().toISOString();
  health.lastJobId = job.id;

  const { rows: runRows } = await query(
    `INSERT INTO provider_feeder_runs (job_id, status) VALUES ($1::bigint, 'running') RETURNING id`,
    [job.id]
  );
  const runId = runRows[0].id;

  try {
    const results = await runScraper({
      query: job.query,
      depth: job.scraper_depth || 1,
      concurrency: DEFAULT_CONCURRENCY,
      geo: job.target_lat != null && job.target_lng != null ? { lat: job.target_lat, lng: job.target_lng } : null,
      radiusMeters: job.radius_meters || null,
      fastMode: Boolean(job.scraper_fast_mode),
      serviceLine: job.service_line || null,
      countryCode: job.country_code || "US",
      regionName: job.region_name || null,
    });

    const result = await withTransaction(async (client) => {
      const rawRows = await insertRawResults(client, job.id, job, results);
      const candidateCount = await normalizeAndUpsertCandidates(client, job.id, job, rawRows);
      return { rawCount: rawRows.length, candidateCount };
    });

    await query(`UPDATE provider_feeder_jobs SET status = 'completed', completed_at = now(), error = NULL WHERE id = $1::bigint`, [job.id]);
    await query(
      `UPDATE provider_feeder_runs
       SET finished_at = now(), status = 'completed', raw_count = $1::int, candidate_count = $2::int
       WHERE id = $3::bigint`,
      [result.rawCount, result.candidateCount, runId]
    );
    health.lastError = null;
    logger.info("Job completed", { jobId: job.id, rawCount: result.rawCount, candidateCount: result.candidateCount });
  } catch (err) {
    logger.error("Job failed", { jobId: job.id, error: err.message });
    health.lastError = err.message;
    const shouldFail = job.attempts >= job.max_attempts;
    const nextStatus = shouldFail ? "failed" : "pending";
    await query(
      `UPDATE provider_feeder_jobs
       SET status = $1::varchar,
           started_at = CASE WHEN $1::varchar = 'pending' THEN NULL ELSE started_at END,
           completed_at = $2::timestamptz,
           error = $3::text
       WHERE id = $4::bigint`,
      [nextStatus, shouldFail ? new Date() : null, err.message, job.id]
    );
    await query(
      `UPDATE provider_feeder_runs
       SET finished_at = now(), status = 'failed', error = $1::text
       WHERE id = $2::bigint`,
      [err.message, runId]
    );
  }
}

async function maybeSeedBacklog() {
  if (AUTO_SEED_ON_START) {
    await ensureQueueBacklog({ minPending: MIN_PENDING_JOBS, maxSeedJobs: MAX_AUTO_SEED_JOBS });
  }
}

async function main() {
  const healthServer = startHealthServer();
  logger.info("Worker starting", {
    pollInterval: POLL_INTERVAL,
    maxJobsPerLoop: MAX_JOBS_PER_LOOP,
    concurrency: DEFAULT_CONCURRENCY,
    validateSchema: VALIDATE_SCHEMA_ON_START,
    autoSeed: AUTO_SEED_ON_START,
    healthServer: Boolean(healthServer),
  });

  if (VALIDATE_SCHEMA_ON_START) await validateSchema();
  await resetStaleRunningJobs();
  await maybeSeedBacklog();
  health.ready = true;
  health.status = "running";

  let running = true;
  const shutdown = () => {
    logger.info("Shutting down worker...");
    health.status = "stopping";
    running = false;
    if (healthServer) healthServer.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      health.lastLoopAt = new Date().toISOString();
      const jobs = await claimJobs(MAX_JOBS_PER_LOOP);
      if (!jobs.length) {
        await maybeSeedBacklog();
        await new Promise((r) => setTimeout(r, POLL_INTERVAL));
        continue;
      }
      for (const job of jobs) {
        if (!running) break;
        await processJob(job);
      }
    } catch (err) {
      health.lastError = err.message;
      logger.error("Worker loop error", { error: err.message });
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  await end();
  logger.info("Worker stopped.");
}

main().catch((err) => {
  health.status = "fatal";
  health.lastError = err.message;
  logger.error("Fatal worker error", { error: err.message });
  process.exit(1);
});
