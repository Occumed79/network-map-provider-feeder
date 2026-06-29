-- ============================================================
-- network-map-provider-feeder — initial migration
-- Creates tables in the shared Neon Postgres database.
-- These tables are owned by the feeder service but are safe
-- for Network Map to read (SELECT only).
-- ============================================================

-- 1. provider_feeder_jobs
CREATE TABLE IF NOT EXISTS provider_feeder_jobs (
    id            BIGSERIAL PRIMARY KEY,
    query         TEXT        NOT NULL,
    country_code  VARCHAR(2)  NOT NULL DEFAULT 'US',
    region_name   TEXT,
    service_line  TEXT,
    status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','completed','failed')),
    priority      INTEGER     NOT NULL DEFAULT 0,
    attempts      INTEGER     NOT NULL DEFAULT 0,
    max_attempts  INTEGER     NOT NULL DEFAULT 3,
    error         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at    TIMESTAMPTZ,
    completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_feeder_jobs_status_priority
    ON provider_feeder_jobs (status, priority DESC, created_at);

-- 2. google_maps_raw_results
CREATE TABLE IF NOT EXISTS google_maps_raw_results (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE CASCADE,
    query           TEXT,
    country_code    VARCHAR(2) DEFAULT 'US',
    title           TEXT,
    category        TEXT,
    categories      JSONB,
    address         TEXT,
    phone           TEXT,
    website         TEXT,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    google_place_id TEXT,
    google_cid      TEXT,
    review_rating   DOUBLE PRECISION,
    review_count    INTEGER,
    open_hours      JSONB,
    raw             JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raw_results_job_id
    ON google_maps_raw_results (job_id);
CREATE INDEX IF NOT EXISTS idx_raw_results_place_id
    ON google_maps_raw_results (google_place_id);
CREATE INDEX IF NOT EXISTS idx_raw_results_cid
    ON google_maps_raw_results (google_cid);

-- 3. provider_candidates
CREATE TABLE IF NOT EXISTS provider_candidates (
    id               BIGSERIAL PRIMARY KEY,
    name             TEXT        NOT NULL,
    normalized_name  TEXT        NOT NULL,
    country_code     VARCHAR(2)  NOT NULL DEFAULT 'US',
    category         TEXT,
    address          TEXT,
    phone            TEXT,
    website          TEXT,
    latitude         DOUBLE PRECISION,
    longitude        DOUBLE PRECISION,
    confidence_score DOUBLE PRECISION NOT NULL DEFAULT 0,
    status           VARCHAR(20) NOT NULL DEFAULT 'new'
                       CHECK (status IN ('new','verified','rejected','merged')),
    dedupe_key       TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_candidates_dedupe
    ON provider_candidates (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_provider_candidates_name
    ON provider_candidates (normalized_name);
CREATE INDEX IF NOT EXISTS idx_provider_candidates_country
    ON provider_candidates (country_code);

-- 4. provider_candidate_sources
CREATE TABLE IF NOT EXISTS provider_candidate_sources (
    id               BIGSERIAL PRIMARY KEY,
    candidate_id     BIGINT NOT NULL REFERENCES provider_candidates(id) ON DELETE CASCADE,
    raw_result_id    BIGINT NOT NULL REFERENCES google_maps_raw_results(id) ON DELETE CASCADE,
    job_id           BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pcs_candidate_id
    ON provider_candidate_sources (candidate_id);
CREATE INDEX IF NOT EXISTS idx_pcs_raw_result_id
    ON provider_candidate_sources (raw_result_id);

-- 5. provider_feeder_runs
CREATE TABLE IF NOT EXISTS provider_feeder_runs (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT REFERENCES provider_feeder_jobs(id) ON DELETE CASCADE,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    raw_count       INTEGER     NOT NULL DEFAULT 0,
    candidate_count INTEGER     NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','completed','failed')),
    error           TEXT
);

CREATE INDEX IF NOT EXISTS idx_feeder_runs_job_id
    ON provider_feeder_runs (job_id);
