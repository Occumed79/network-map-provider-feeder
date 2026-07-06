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
       LIMIT $1
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

    const existing = await client.query("SELECT * FROM provider_feeder_candidates WHERE dedupe_key = $1", [dedupeKey]);
    let candidateId;

    if (existing.rows.length) {
      candidateId = existing.rows[0].id;
      await client.query(
        `UPDATE provider_feeder_candidates
         SET name = COALESCE(NULLIF($1,''), name),
             normalized_name = COALESCE(NULLIF($2,''), normalized_name),
             category = COALESCE($3, category),
             address = COALESCE($4, address),
             phone = COALESCE($5, phone),
             website = COALESCE($6, website),
             latitude = COALESCE($7, latitude),
             longitude = COALESCE($8, longitude),
             confidence_score = GREATEST(confidence_score, $9),
             updated_at = now()
         WHERE id = $10`,
        [name, normalizedName, r.category, r.address, phone, website, lat, lng, confidence, candidateId]
      );
    } else {
      let nearbyMatch = null;
      if (lat != null && lng != null) {
        const nearby = await client.query(
          `SELECT * FROM provider_feeder_candidates
           WHERE country_code = $1
             AND latitude IS NOT NULL AND longitude IS NOT NULL
             AND latitude BETWEEN $2 - 0.002 AND $2 + 0.002
             AND longitude BETWEEN $3 - 0.002 AND $3 + 0.002`,
          [job.country_code, lat, lng]
        );
        nearbyMatch = nearby.rows.find((c) => isNearbyDuplicate({ title: name, latitude: lat, longitude: lng }, c));
      }

      if (nearbyMatch) {
        candidateId = nearbyMatch.id;
        await client.query(
          `UPDATE provider_feeder_candidates
           SET confidence_score = GREATEST(confidence_score, $1), updated_at = now()
           WHERE id = $2`,
          [confidence, candidateId]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO provider_feeder_candidates
            (name, normalized_name, country_code, category, address,
             phone, website, latitude, longitude, confidence_score, status, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',$11)
           RETURNING id`,
          [name, normalizedName, job.country_code, r.category, r.address, phone, website, lat, lng, confidence, dedupeKey]
        );
        candidateId = ins.rows[0].id;
        candidateCount++;
      }
    }

    await client.query(
      `INSERT INTO provider_feeder_candidate_sources (candidate_id, raw_result_id, job_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [candidateId, rawRow.id, jobId]
    );
  }
  return candidateCount;
}

async function processJob(job) {
  logger.info("Processing job", { jobId: job.id, query: job.query, attempt: job.attempts });
  const { rows: runRows } = await query(
    `INSERT INTO provider_feeder_runs (job_id, status) VALUES ($1, 'running') RETURNING id`,
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
    });

    const result = await withTransaction(async (client) => {
      const rawRows = await insertRawResults(client, job.id, job, results);
      const candidateCount = await normalizeAndUpsertCandidates(client, job.id, job, rawRows);
      return { rawCount: rawRows.length, candidateCount };
    });

    await query(`UPDATE provider_feeder_jobs SET status = 'completed', completed_at = now(), error = NULL WHERE id = $1`, [job.id]);
    await query(
      `UPDATE provider_feeder_runs
       SET finished_at = now(), status = 'completed', raw_count = $1, candidate_count = $2
       WHERE id = $3`,
      [result.rawCount, result.candidateCount, runId]
    );
    logger.info("Job completed", { jobId: job.id, rawCount: result.rawCount, candidateCount: result.candidateCount });
  } catch (err) {
    logger.error("Job failed", { jobId: job.id, error: err.message });
    const shouldFail = job.attempts >= job.max_attempts;
    await query(
      `UPDATE provider_feeder_jobs
       SET status = $1,
           started_at = CASE WHEN $1 = 'pending' THEN NULL ELSE started_at END,
           completed_at = $2,
           error = $3
       WHERE id = $4`,
      [shouldFail ? "failed" : "pending", shouldFail ? new Date() : null, err.message, job.id]
    );
    await query(`UPDATE provider_feeder_runs SET finished_at = now(), status = 'failed', error = $1 WHERE id = $2`, [err.message, runId]);
  }
}

async function maybeSeedBacklog() {
  if (AUTO_SEED_ON_START) {
    await ensureQueueBacklog({ minPending: MIN_PENDING_JOBS, maxSeedJobs: MAX_AUTO_SEED_JOBS });
  }
}

async function main() {
  logger.info("Worker starting", {
    pollInterval: POLL_INTERVAL,
    maxJobsPerLoop: MAX_JOBS_PER_LOOP,
    concurrency: DEFAULT_CONCURRENCY,
    validateSchema: VALIDATE_SCHEMA_ON_START,
    autoSeed: AUTO_SEED_ON_START,
  });

  if (VALIDATE_SCHEMA_ON_START) await validateSchema();
  await resetStaleRunningJobs();
  await maybeSeedBacklog();

  let running = true;
  const shutdown = () => {
    logger.info("Shutting down worker...");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
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
      logger.error("Worker loop error", { error: err.message });
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  await end();
  logger.info("Worker stopped.");
}

main().catch((err) => {
  logger.error("Fatal worker error", { error: err.message });
  process.exit(1);
});
