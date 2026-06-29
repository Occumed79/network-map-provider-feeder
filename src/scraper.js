import { exec } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import { logger } from "./logger.js";

const execAsync = promisify(exec);

const SCRAPER_IMAGE = process.env.SCRAPER_IMAGE || "gosom/google-maps-scraper";
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || "300000", 10);
const DISABLE_TELEMETRY = process.env.DISABLE_TELEMETRY === "1";

const TMP_DIR = join(process.cwd(), "tmp");

/**
 * Run the gosom/google-maps-scraper in Docker for a single query.
 *
 * @param {object} opts
 * @param {string} opts.query       — search query string
 * @param {number} [opts.depth=1]   — scrape depth
 * @param {number} [opts.concurrency=1]
 * @param {number} [opts.timeout]   — ms override
 * @returns {Promise<object[]>}     — parsed JSON array of results
 */
export async function runScraper({ query, depth = 1, concurrency = 1, timeout }) {
  const effectiveTimeout = timeout || SCRAPER_TIMEOUT_MS;
  await mkdir(TMP_DIR, { recursive: true });

  const stamp = Date.now();
  const queryFile = join(TMP_DIR, `queries_${stamp}.txt`);
  const outFile = `/out/results_${stamp}.json`;
  const localOutFile = join(TMP_DIR, `results_${stamp}.json`);

  await writeFile(queryFile, query + "\n", "utf8");

  const envFlag = DISABLE_TELEMETRY ? "-e DISABLE_TELEMETRY=1" : "";

  const cmd = [
    "docker run --rm",
    envFlag,
    `-v "${TMP_DIR}:/out"`,
    `-v "${queryFile}:/queries.txt:ro"`,
    SCRAPER_IMAGE,
    "-input /queries.txt",
    `-results ${outFile}`,
    "-json",
    `-depth ${depth}`,
    `-c ${concurrency}`,
    "-exit-on-inactivity 3m",
  ]
    .filter(Boolean)
    .join(" ");

  logger.info("Starting scraper", { query, depth, concurrency, timeout: effectiveTimeout });

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: effectiveTimeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stderr) logger.debug("scraper stderr", { stderr: stderr.slice(0, 500) });
    logger.debug("scraper stdout", { stdout: stdout.slice(0, 500) });
  } catch (err) {
    logger.error("Scraper process failed", { error: err.message });
    throw new Error(`Scraper failed: ${err.message}`);
  } finally {
    // Clean up query file
    try {
      await unlink(queryFile);
    } catch {}
  }

  // Read results
  let raw;
  try {
    raw = await readFile(localOutFile, "utf8");
  } catch {
    logger.warn("No output file produced by scraper", { file: localOutFile });
    return [];
  }

  try {
    await unlink(localOutFile);
  } catch {}

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.error("Failed to parse scraper JSON output");
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn("Scraper output is not an array, wrapping", { type: typeof parsed });
    parsed = [parsed];
  }

  logger.info("Scraper completed", { resultCount: parsed.length });
  return parsed;
}
