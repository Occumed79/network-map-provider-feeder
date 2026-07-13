import { spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve, sep } from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_INPUT = join(ROOT, "tmp", "input");
const TMP_OUTPUT = join(ROOT, "tmp", "output");
const RECENT_FILE = join(TMP_OUTPUT, "manual-runs.json");
const MAX_DOWNLOAD_BYTES = Number(process.env.MANUAL_DOWNLOAD_MAX_BYTES || 100_000_000);
mkdirSync(TMP_INPUT, { recursive: true });
mkdirSync(TMP_OUTPUT, { recursive: true });

let currentRun = { status: "idle" };
let currentChild = null;
let recentRuns = loadRecent();

function loadRecent() {
  try { return JSON.parse(readFileSync(RECENT_FILE, "utf8")); } catch { return []; }
}
function saveRecent() { writeFileSync(RECENT_FILE, JSON.stringify(recentRuns.slice(0, 30), null, 2)); }
function outputDir(runId) { const dir = join(TMP_OUTPUT, runId); mkdirSync(dir, { recursive: true }); return dir; }
function safeUrl(value) { const url = new URL(value); if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must be http or https"); return url; }
function publicFiles(run) { return Object.fromEntries(Object.entries(run.outputFiles || {}).filter(([, value]) => value && existsSync(value)).map(([key, value]) => [key, basename(value)])); }
function snapshot(run) { return { ...run, outputFiles: publicFiles(run) }; }
function finish(run, status, err) {
  run.status = status;
  run.completedAt = new Date().toISOString();
  run.lastActivityAt = run.completedAt;
  if (err) run.error = err.message || String(err);
  recentRuns = [snapshot(run), ...recentRuns.filter((item) => item.runId !== run.runId)].slice(0, 30);
  saveRecent();
  currentRun = snapshot(run);
  currentChild = null;
}
function numberParam(value, fallback, min, max) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback; }
function parseProgress(run, text) {
  run.lastActivityAt = new Date().toISOString();
  let match = text.match(/CRAWL_PROGRESS pages=(\d+) providers=(\d+) pending=(\d+) current=(\S+)/);
  if (match) { run.pagesCrawled = Number(match[1]); run.providersFound = Number(match[2]); run.pendingUrls = Number(match[3]); run.currentUrl = match[4]; }
  match = text.match(/NEON_PROGRESS written=(\d+) skipped=(\d+)/);
  if (match) { run.providersWritten = Number(match[1]); run.providersSkipped = Number(match[2]); }
  match = text.match(/CRAWL_COMPLETE status=(\S+) reason=(\S+) pages=(\d+) providers=(\d+)/);
  if (match) { run.crawlStatus = match[1]; run.stopReason = match[2]; run.pagesCrawled = Number(match[3]); run.providersFound = Number(match[4]); }
}
function execStep(run, command, args, opts = {}) {
  return new Promise((resolveStep, reject) => {
    run.command = [command, ...args].join(" ");
    const child = spawn(command, args, { cwd: opts.cwd || ROOT, env: { ...process.env, ...(opts.env || {}) }, shell: false });
    currentChild = child;
    child.stdout.on("data", (data) => { const text = data.toString(); run.logs += text; parseProgress(run, text); opts.stdout?.write(text); });
    child.stderr.on("data", (data) => { const text = data.toString(); run.logs += text; parseProgress(run, text); opts.stderr?.write(text); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      currentChild = null;
      if (run.stopRequested && (code === 0 || signal)) return resolveStep();
      if (code === 0) return resolveStep();
      reject(new Error(`${command} exited ${code}${signal ? ` (${signal})` : ""}`));
    });
  });
}
async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const announced = Number(response.headers.get("content-length") || 0);
  if (announced > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Download response had no body");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_DOWNLOAD_BYTES) throw new Error(`Download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
    chunks.push(Buffer.from(value));
  }
  writeFileSync(destination, Buffer.concat(chunks));
  return destination;
}
function importerArgs(input, run, write, sourceType, sourceTag) {
  return ["scripts/import_provider_text.py", input, "--source-type", sourceType, "--source-tag", sourceTag || run.mode, "--accepted-out", run.outputFiles.accepted, "--rejected-out", run.outputFiles.rejected, "--report-out", run.outputFiles.report, ...(write ? ["--write"] : [])];
}
async function runImporter(run, input, write, sourceType, sourceTag) {
  await execStep(run, "python", importerArgs(input, run, write, sourceType, sourceTag), { env: write ? { SCRAPY_WRITE_TO_NEON: "1", ENABLE_APP_CANDIDATE_WRITE: "1" } : { SCRAPY_WRITE_TO_NEON: "0" } });
  try { Object.assign(run, JSON.parse(readFileSync(run.outputFiles.report, "utf8"))); } catch {}
}
function crawlConfig(params, mode, runKey) {
  return {
    mode, runKey, url: params.url || "", country: params.country || "", sourceTag: params.sourceTag || "pasted_url",
    sourceFile: params.sourceFile || "all", countries: params.countries || "", crawlMode: params.crawlMode || "facility_registry",
    maxSources: numberParam(params.maxSources, 50, 1, 500), runtimeMinutes: numberParam(params.runtimeMinutes, 480, 5, 1440),
    maxPages: numberParam(params.maxPages, 5000, 10, 100000), maxDepth: numberParam(params.maxDepth, 8, 1, 20),
    concurrency: numberParam(params.concurrency, 6, 1, 24), delay: numberParam(params.delay, 0.35, 0, 10), sameDomain: params.sameDomain !== false,
  };
}
async function runLongCrawl(run, params, mode) {
  const runKey = params.runKey || run.runId;
  const config = crawlConfig(params, mode, runKey);
  run.runKey = runKey;
  run.autoWrite = true;
  run.config = config;
  run.outputFiles.providers = join(outputDir(run.runId), "providers.jsonl");
  run.outputFiles.logs = join(outputDir(run.runId), "logs.txt");
  const logStream = createWriteStream(run.outputFiles.logs, { flags: "a" });
  const common = [
    "-a", `run_key=${runKey}`, "-a", `max_depth=${config.maxDepth}`, "-a", `same_domain=${config.sameDomain ? "1" : "0"}`,
    "-a", `config_json=${JSON.stringify(config)}`, "-s", `CLOSESPIDER_PAGECOUNT=${config.maxPages}`,
    "-s", `CLOSESPIDER_TIMEOUT=${Math.round(config.runtimeMinutes * 60)}`, "-s", `DEPTH_LIMIT=${config.maxDepth}`,
    "-s", `CONCURRENT_REQUESTS=${config.concurrency}`, "-s", `DOWNLOAD_DELAY=${config.delay}`, "-s", "LOGSTATS_INTERVAL=30",
    "-O", run.outputFiles.providers,
  ];
  let args;
  if (mode === "government_health_ingest") {
    args = ["crawl", "government_health_ingest", "-a", `source_file=${config.sourceFile}`, "-a", `countries=${config.countries}`, "-a", `crawl_mode=${config.crawlMode}`, "-a", `max_sources=${config.maxSources}`, "-a", "include_disabled=1", ...common];
  } else {
    const url = safeUrl(config.url);
    args = ["crawl", "generic_provider_url", "-a", `url=${url.href}`, "-a", `country=${config.country}`, "-a", `source_tag=${config.sourceTag}`, ...common];
  }
  await execStep(run, "scrapy", args, { cwd: join(ROOT, "scrapers"), env: { SCRAPY_WRITE_TO_NEON: "1", ENABLE_APP_CANDIDATE_WRITE: "1" }, stdout: logStream, stderr: logStream });
  logStream.end();
  if (existsSync(run.outputFiles.providers)) run.providerOutputBytes = statSync(run.outputFiles.providers).size;
}

export function getCurrentRun() { return currentRun; }
export function getRecentRuns() { return recentRuns; }
export function resolveOutput(runId, filename) {
  const base = resolve(TMP_OUTPUT, runId);
  const full = resolve(base, filename);
  if (!full.startsWith(`${base}${sep}`) || basename(full) !== filename || !existsSync(full)) return null;
  return full;
}
export function stopRun() {
  if (currentRun.status !== "running" || !currentChild) throw new Error("No active run to stop");
  currentRun.stopRequested = true;
  currentRun.status = "stopping";
  currentRun.lastActivityAt = new Date().toISOString();
  currentChild.kill("SIGTERM");
  return snapshot(currentRun);
}
export function startRun(mode, params = {}) {
  if (["running", "stopping"].includes(currentRun.status)) throw new Error(`Run ${currentRun.runId} is already ${currentRun.status}`);
  const runId = randomUUID().slice(0, 12);
  const run = { ok: true, runId, status: "running", mode, startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), completedAt: null, command: "", logs: "", pagesCrawled: 0, providersFound: 0, providersWritten: 0, providersSkipped: 0, pendingUrls: 0, currentUrl: "", outputFiles: {} };
  const out = outputDir(runId);
  run.outputFiles = { accepted: join(out, "accepted.csv"), rejected: join(out, "rejected.csv"), report: join(out, "report.json"), logs: join(out, "logs.txt") };
  currentRun = run;
  (async () => {
    try {
      if (mode === "scrape_url" || mode === "government_health_ingest") await runLongCrawl(run, params, mode);
      else if (mode === "import_document_url") {
        const url = safeUrl(params.url);
        const input = join(TMP_INPUT, `${runId}-${basename(url.pathname) || "document"}`);
        await download(url.href, input);
        let importInput = input;
        let type = params.sourceType || "provider_file_import";
        if (/\.pdf$/i.test(input)) { importInput = join(out, "pdf-extracted.csv"); type = "pdf_provider_directory"; await execStep(run, "python", ["scripts/extract_medical_providers.py", input, importInput]); }
        await runImporter(run, importInput, Boolean(params.write), type, params.sourceTag || "document_url");
      } else if (mode === "import_raw_text") {
        const input = join(TMP_INPUT, `manual-${runId}.txt`);
        writeFileSync(input, params.text || "");
        await runImporter(run, input, Boolean(params.write), params.sourceType || "provider_file_import", params.sourceTag || "manual_raw_text");
      } else if (mode === "import_provider_file_write") {
        const previous = recentRuns.find((item) => item.runId === params.runId);
        if (!previous?.outputFiles?.accepted) throw new Error("Preview run not found");
        const input = resolveOutput(params.runId, previous.outputFiles.accepted);
        if (!input) throw new Error("Accepted CSV not found");
        await runImporter(run, input, true, "provider_file_import", `write_from_${params.runId}`);
      } else throw new Error(`Unsupported run mode: ${mode}`);
      finish(run, run.stopRequested || run.crawlStatus === "paused" ? "paused" : "completed");
    } catch (err) {
      finish(run, run.stopRequested ? "paused" : "failed", err);
      try { writeFileSync(run.outputFiles.logs, `${run.logs}\n${err.stack || err.message}`); } catch {}
    }
  })();
  return snapshot(run);
}
