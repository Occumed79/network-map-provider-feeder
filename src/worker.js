import { query, withTransaction, end } from "./db.js";
import { runScraper } from "./scraper.js";
import { logger } from "./logger.js";
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

const POLL_INTERVAL = parseInt(
  process.env.WORKER_POLL_INTERVAL_MS || "30000",
  10
);
const MAX_JOBS_PER_LOOP = parseInt(process.env.MAX_JOBS_PER_LOOP || "1", 10);
const DEFAULT_CONCURRENCY = parseInt(
  process.env.DEFAULT_CONCURRENCY || "1",
  10
);

/**
 * Claim pending jobs using atomic UPDATE ... RETURNING.
 */
async function claimJobs(count) {
  const sql = `
    UPDATE provider_feeder_jobs
    SET status = 'running',
        started_at = now(),
        attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM provider_feeder_jobs
      WHERE status = 'pending'
        AND attempts < max_attempts
      ORDER BY priority DESC, created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  const { rows } = await query(sql, [count]);
  return rows;
}

/**
 * Insert raw scraper results into google_maps_raw_results.
 */
async function insertRawResults(client, jobId, job, results) {
  let inserted = 0;
  for (const r of results) {
    // gosom/google-maps-scraper JSON field names vary; map common ones
    const title = r.title || r.name || null;
    const category = r.category || r.type || null;
    const categories = r.categories || (category ? [category] : null);
    const address = r.address || r.street || null;
    const phone = r.phone || r.phone_number || null;
    const website = r.website || r.site || null;
    const latitude = r.latitude != null ? parseFloat(r.latitude) : null;
    const longitude = r.longitude != null ? parseFloat(r.longitude) : null;
    const googlePlaceId = r.place_id || r.google_place_id || null;
    const googleCid = r.cid || r.google_cid || null;
    const reviewRating = r.rating || r.review_rating || null;
    const reviewCount = r.reviews || r.review_count || null;
    const openHours = r.open_hours || r.hours || null;

    await client.query(
      `INSERT INTO google_maps_raw_results
        (job_id, query, country_code, title, category, categories, address,
         phone, website, latitude, longitude, google_place_id, google_cid,
         review_rating, review_count, open_hours, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        jobId,
        job.query,
        job.country_code,
        title,
        category,
        categories ? JSON.stringify(categories) : null,
        address,
        phone,
        website,
        latitude,
        longitude,
        googlePlaceId,
        googleCid,
        reviewRating,
        reviewCount,
        openHours ? JSON.stringify(openHours) : null,
        JSON.stringify(r),
      ]
    );
    inserted++;
  }
  return inserted;
}

/**
 * Normalize raw results into provider_candidates with deduplication.
 */
async function normalizeAndUpsertCandidates(client, jobId, job, results) {
  let candidateCount = 0;

  for (const r of results) {
    const title = r.title || r.name;
    if (!title) continue;

    const name = title;
    const normalizedName = normalizeName(title);
    const phone = normalizePhone(r.phone || r.phone_number);
    const website = normalizeWebsite(r.website || r.site);
    const lat = normalizeLat(r.latitude);
    const lng = normalizeLng(r.longitude);
    const googlePlaceId = r.place_id || r.google_place_id;
    const googleCid = r.cid || r.google_cid;
    const category = r.category || r.type;
    const address = r.address || r.street;
    const confidence = computeConfidence(r);
    const dedupeKey = computeDedupeKey({
      google_place_id: googlePlaceId,
      google_cid: googleCid,
      phone: r.phone || r.phone_number,
      website: r.website || r.site,
      title,
      address,
    });

    // Check for existing candidate by dedupe_key
    const existing = await client.query(
      "SELECT * FROM provider_candidates WHERE dedupe_key = $1",
      [dedupeKey]
    );

    let candidateId;

    if (existing.rows.length > 0) {
      candidateId = existing.rows[0].id;
      // Update with richer data if available
      await client.query(
        `UPDATE provider_candidates
         SET name = COALESCE(NULLIF($1,''), name),
             phone = COALESCE($2, phone),
             website = COALESCE($3, website),
             latitude = COALESCE($4, latitude),
             longitude = COALESCE($5, longitude),
             confidence_score = GREATEST(confidence_score, $6),
             updated_at = now()
         WHERE id = $7`,
        [name, phone, website, lat, lng, confidence, candidateId]
      );
    } else {
      // Check for nearby duplicate
      let nearbyMatch = null;
      if (lat != null && lng != null) {
        const nearby = await client.query(
          `SELECT * FROM provider_candidates
           WHERE country_code = $1
             AND latitude IS NOT NULL AND longitude IS NOT NULL
             AND latitude BETWEEN $2 - 0.002 AND $2 + 0.002
             AND longitude BETWEEN $3 - 0.002 AND $3 + 0.002`,
          [job.country_code, lat, lng]
        );
        for (const c of nearby.rows) {
          if (isNearbyDuplicate({ title, latitude: lat, longitude: lng }, c)) {
            nearbyMatch = c;
            break;
          }
        }
      }

      if (nearbyMatch) {
        candidateId = nearbyMatch.id;
        await client.query(
          `UPDATE provider_candidates
           SET confidence_score = GREATEST(confidence_score, $1),
               updated_at = now()
           WHERE id = $2`,
          [confidence, candidateId]
        );
      } else {
        const ins = await client.query(
          `INSERT INTO provider_candidates
            (name, normalized_name, country_code, category, address,
             phone, website, latitude, longitude, confidence_score,
             status, dedupe_key)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new',$11)
           RETURNING id`,
          [
            name,
            normalizedName,
            job.country_code,
            category,
            address,
            phone,
            website,
            lat,
            lng,
            confidence,
            dedupeKey,
          ]
        );
        candidateId = ins.rows[0].id;
        candidateCount++;
      }
    }

    // Link candidate to raw result
    // Find the raw result we just inserted for this job + title
    const rawRow = await client.query(
      `SELECT id FROM google_maps_raw_results
       WHERE job_id = $1 AND title = $2
       ORDER BY created_at DESC LIMIT 1`,
      [jobId, title]
    );
    if (rawRow.rows.length > 0) {
      await client.query(
        `INSERT INTO provider_candidate_sources (candidate_id, raw_result_id, job_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [candidateId, rawRow.rows[0].id, jobId]
      );
    }
  }

  return candidateCount;
}

/**
 * Process a single job end-to-end.
 */
async function processJob(job) {
  logger.info("Processing job", { jobId: job.id, query: job.query });

  const { rows: runRows } = await query(
    `INSERT INTO provider_feeder_runs (job_id, status)
     VALUES ($1, 'running') RETURNING id`,
    [job.id]
  );
  const runId = runRows[0].id;

  try {
    const results = await runScraper({
      query: job.query,
      depth: 1,
      concurrency: DEFAULT_CONCURRENCY,
    });

    const result = await withTransaction(async (client) => {
      const rawCount = await insertRawResults(client, job.id, job, results);
      const candidateCount = await normalizeAndUpsertCandidates(
        client,
        job.id,
        job,
        results
      );
      return { rawCount, candidateCount };
    });

    await query(
      `UPDATE provider_feeder_jobs
       SET status = 'completed', completed_at = now(), error = NULL
       WHERE id = $1`,
      [job.id]
    );

    await query(
      `UPDATE provider_feeder_runs
       SET finished_at = now(), status = 'completed',
           raw_count = $1, candidate_count = $2
       WHERE id = $3`,
      [result.rawCount, result.candidateCount, runId]
    );

    logger.info("Job completed", {
      jobId: job.id,
      rawCount: result.rawCount,
      candidateCount: result.candidateCount,
    });
  } catch (err) {
    logger.error("Job failed", { jobId: job.id, error: err.message });

    const shouldFail = job.attempts >= job.max_attempts;
    await query(
      `UPDATE provider_feeder_jobs
       SET status = $1, completed_at = $2, error = $3
       WHERE id = $4`,
      [shouldFail ? "failed" : "pending", shouldFail ? new Date() : null, err.message, job.id]
    );

    await query(
      `UPDATE provider_feeder_runs
       SET finished_at = now(), status = 'failed', error = $1
       WHERE id = $2`,
      [err.message, runId]
    );
  }
}

/**
 * Main worker loop.
 */
async function main() {
  logger.info("Worker starting", {
    pollInterval: POLL_INTERVAL,
    maxJobsPerLoop: MAX_JOBS_PER_LOOP,
    concurrency: DEFAULT_CONCURRENCY,
  });

  // Graceful shutdown
  let running = true;
  const shutdown = async () => {
    logger.info("Shutting down worker...");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      const jobs = await claimJobs(MAX_JOBS_PER_LOOP);
      if (jobs.length === 0) {
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
