import { spawn } from "child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { constants } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { logger } from "./logger.js";

const SCRAPER_IMAGE = process.env.SCRAPER_IMAGE || "gosom/google-maps-scraper";
const SCRAPER_BINARY = process.env.SCRAPER_BINARY || "google-maps-scraper";
const SCRAPER_MODE = (process.env.SCRAPER_MODE || "auto").toLowerCase();
const SCRAPER_TIMEOUT_MS = parseInt(process.env.SCRAPER_TIMEOUT_MS || "300000", 10);
const SCRAPER_EXIT_ON_INACTIVITY = process.env.SCRAPER_EXIT_ON_INACTIVITY || "3m";
const SCRAPER_PROXIES = process.env.SCRAPER_PROXIES || "";
const DISABLE_TELEMETRY = process.env.DISABLE_TELEMETRY === "1";

function buildScraperArgs({ inputFile, outputFile, depth, concurrency, geo, radiusMeters, fastMode }) {
  const args = [
    "-input", inputFile,
    "-results", outputFile,
    "-json",
    "-depth", String(depth),
    "-c", String(concurrency),
    "-exit-on-inactivity", SCRAPER_EXIT_ON_INACTIVITY,
  ];

  if (SCRAPER_PROXIES) args.push("-proxies", SCRAPER_PROXIES);
  if (fastMode) args.push("-fast-mode");
  if (geo?.lat != null && geo?.lng != null) args.push("-geo", `${geo.lat},${geo.lng}`);
  if (radiusMeters) args.push("-radius", String(radiusMeters));
  return args;
}

async function executableExists(command) {
  if (command.includes("/")) {
    try {
      await access(command, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function runCommand(command, args, { timeout, env = {}, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      reject(new Error(`${label} timed out after ${timeout}ms`));
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) stdout = stdout.slice(-1024 * 1024);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (stderr) logger.debug(`${label} stderr`, { stderr: stderr.slice(0, 1000) });
      if (stdout) logger.debug(`${label} stdout`, { stdout: stdout.slice(0, 1000) });
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${label} exited with code ${code}: ${stderr.slice(0, 1000)}`));
    });
  });
}

async function parseResultFile(outputFile) {
  let raw;
  try {
    raw = await readFile(outputFile, "utf8");
  } catch {
    logger.warn("No output file produced by scraper", { file: outputFile });
    return [];
  }

  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const rows = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (err) {
        logger.warn("Skipping malformed JSON scraper output line", { error: err.message });
      }
    }
    return rows;
  }
}

async function runBinaryScraper(opts, paths) {
  const args = buildScraperArgs({
    inputFile: paths.queryFile,
    outputFile: paths.localOutFile,
    depth: opts.depth,
    concurrency: opts.concurrency,
    geo: opts.geo,
    radiusMeters: opts.radiusMeters,
    fastMode: opts.fastMode,
  });

  logger.info("Starting scraper binary", {
    query: opts.query,
    binary: SCRAPER_BINARY,
    depth: opts.depth,
    concurrency: opts.concurrency,
    timeout: opts.timeout,
    fastMode: opts.fastMode,
  });

  await runCommand(SCRAPER_BINARY, args, {
    timeout: opts.timeout,
    env: DISABLE_TELEMETRY ? { DISABLE_TELEMETRY: "1" } : {},
    label: "google-maps-scraper binary",
  });
}

async function runDockerScraper(opts, paths) {
  const args = [
    "run", "--rm",
    ...(DISABLE_TELEMETRY ? ["-e", "DISABLE_TELEMETRY=1"] : []),
    "-v", `${paths.tmpDir}:/out`,
    "-v", `${paths.queryFile}:/queries.txt:ro`,
    SCRAPER_IMAGE,
    ...buildScraperArgs({
      inputFile: "/queries.txt",
      outputFile: "/out/results.json",
      depth: opts.depth,
      concurrency: opts.concurrency,
      geo: opts.geo,
      radiusMeters: opts.radiusMeters,
      fastMode: opts.fastMode,
    }),
  ];

  logger.info("Starting scraper Docker image", {
    query: opts.query,
    image: SCRAPER_IMAGE,
    depth: opts.depth,
    concurrency: opts.concurrency,
    timeout: opts.timeout,
    fastMode: opts.fastMode,
  });

  await runCommand("docker", args, { timeout: opts.timeout, label: "google-maps-scraper docker" });
}

/**
 * Run gosom/google-maps-scraper for one controlled job.
 *
 * Modes:
 * - SCRAPER_MODE=binary: run an installed google-maps-scraper binary.
 * - SCRAPER_MODE=docker: run the gosom/google-maps-scraper Docker image.
 * - SCRAPER_MODE=auto: prefer binary, fall back to Docker if available.
 */
export async function runScraper({
  query,
  depth = 1,
  concurrency = 1,
  timeout,
  geo = null,
  radiusMeters = null,
  fastMode = false,
}) {
  const effectiveTimeout = timeout || SCRAPER_TIMEOUT_MS;
  const tmpDir = await mkdtemp(join(tmpdir(), "provider-feeder-"));
  const queryFile = join(tmpDir, "queries.txt");
  const localOutFile = join(tmpDir, "results.json");

  await mkdir(tmpDir, { recursive: true });
  await writeFile(queryFile, `${query}\n`, "utf8");

  const opts = { query, depth, concurrency, timeout: effectiveTimeout, geo, radiusMeters, fastMode };

  try {
    if (SCRAPER_MODE === "binary") {
      await runBinaryScraper(opts, { tmpDir, queryFile, localOutFile });
    } else if (SCRAPER_MODE === "docker") {
      await runDockerScraper(opts, { tmpDir, queryFile, localOutFile });
    } else {
      const hasBinary = await executableExists(SCRAPER_BINARY);
      if (hasBinary) {
        await runBinaryScraper(opts, { tmpDir, queryFile, localOutFile });
      } else {
        const hasDocker = await executableExists("docker");
        if (!hasDocker) {
          throw new Error(`No scraper runtime found. Install ${SCRAPER_BINARY}, set SCRAPER_BINARY, or run with Docker available.`);
        }
        await runDockerScraper(opts, { tmpDir, queryFile, localOutFile });
      }
    }

    const results = await parseResultFile(localOutFile);
    logger.info("Scraper completed", { query, resultCount: results.length });
    return results;
  } catch (err) {
    logger.error("Scraper process failed", { query, error: err.message });
    throw new Error(`Scraper failed: ${err.message}`);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
