import { spawn } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TMP_INPUT = join(ROOT, "tmp", "input");
const TMP_OUTPUT = join(ROOT, "tmp", "output");
const RECENT_FILE = join(TMP_OUTPUT, "manual-runs.json");
mkdirSync(TMP_INPUT, { recursive: true });
mkdirSync(TMP_OUTPUT, { recursive: true });
let currentRun = { status: "idle" };
let recentRuns = loadRecent();

function loadRecent() { try { return JSON.parse(readFileSync(RECENT_FILE, "utf8")); } catch { return []; } }
function saveRecent() { writeFileSync(RECENT_FILE, JSON.stringify(recentRuns.slice(0, 20), null, 2)); }
function outputDir(runId) { const dir = join(TMP_OUTPUT, runId); mkdirSync(dir, { recursive: true }); return dir; }
function safeUrl(value) { const u = new URL(value); if (!["http:", "https:"].includes(u.protocol)) throw new Error("URL must be http or https"); return u; }
function runFile(run, name) { return join(outputDir(run.runId), name); }
function publicFiles(run) { return Object.fromEntries(Object.entries(run.outputFiles || {}).map(([k, v]) => [k, basename(v)])); }
function finish(run, status, err) { run.status = status; run.completedAt = new Date().toISOString(); if (err) run.error = err.message || String(err); recentRuns = [{ ...run, outputFiles: publicFiles(run) }, ...recentRuns.filter((r) => r.runId !== run.runId)].slice(0, 20); saveRecent(); currentRun = { ...run, outputFiles: publicFiles(run) }; }
function execStep(run, command, args, opts = {}) { return new Promise((resolveStep, reject) => { run.command = [command, ...args].join(" "); const child = spawn(command, args, { cwd: opts.cwd || ROOT, env: { ...process.env, ...(opts.env || {}) }, shell: false }); child.stdout.on("data", (d) => { const s = d.toString(); run.logs += s; opts.stdout?.write(s); }); child.stderr.on("data", (d) => { const s = d.toString(); run.logs += s; opts.stderr?.write(s); }); child.on("error", reject); child.on("close", (code) => code === 0 ? resolveStep() : reject(new Error(`${command} exited ${code}`)) ); }); }
async function download(url, dest) { const res = await fetch(url); if (!res.ok) throw new Error(`Download failed: ${res.status}`); const buf = Buffer.from(await res.arrayBuffer()); writeFileSync(dest, buf); return dest; }
function importerArgs(input, run, write, sourceType, sourceTag) { return ["scripts/import_provider_text.py", input, "--source-type", sourceType, "--source-tag", sourceTag || run.mode, "--accepted-out", run.outputFiles.accepted, "--rejected-out", run.outputFiles.rejected, "--report-out", run.outputFiles.report, ...(write ? ["--write"] : [])]; }
async function runImporter(run, input, write, sourceType, sourceTag) { await execStep(run, "python", importerArgs(input, run, write, sourceType, sourceTag), { env: write ? { SCRAPY_WRITE_TO_NEON: "1" } : { SCRAPY_WRITE_TO_NEON: "0" } }); summarizeReport(run); }
function summarizeReport(run) { try { Object.assign(run, JSON.parse(readFileSync(run.outputFiles.report, "utf8"))); } catch {} }

export function getCurrentRun() { return currentRun; }
export function getRecentRuns() { return recentRuns; }
export function resolveOutput(runId, filename) { const base = resolve(TMP_OUTPUT, runId); const full = resolve(base, filename); if (!full.startsWith(`${base}/`) || basename(full) !== filename || !existsSync(full)) return null; return full; }

export function startRun(mode, params = {}) {
  if (currentRun.status === "running") throw new Error(`Run ${currentRun.runId} is already running`);
  const runId = randomUUID().slice(0, 12);
  const run = { ok: true, runId, status: "running", mode, startedAt: new Date().toISOString(), completedAt: null, command: "", logs: "", outputFiles: {} };
  const out = outputDir(runId);
  run.outputFiles = { accepted: join(out, "accepted.csv"), rejected: join(out, "rejected.csv"), report: join(out, "report.json"), logs: join(out, "logs.txt") };
  currentRun = run;
  (async () => {
    try {
      const logStream = createWriteStream(run.outputFiles.logs, { flags: "a" });
      if (mode === "scrape_url") {
        const u = safeUrl(params.url); run.outputFiles.discovered = join(out, "discovered-links.csv"); const raw = join(out, "scrape.jsonl");
        await execStep(run, "scrapy", ["crawl", "generic_provider_url", "-a", `url=${u.href}`, "-a", `country=${params.country || ""}`, "-a", `source_tag=${params.sourceTag || "pasted_url"}`, "-O", raw], { cwd: join(ROOT, "scrapers") });
        await runImporter(run, raw, Boolean(params.write), "pasted_url_scrape", params.sourceTag || "pasted_url");
      } else if (mode === "discover_government_health") {
        run.outputFiles = { ...run.outputFiles, discovered: join(out, "discovered-links.csv") };
        const source = params.sourceFile === "part2" ? "sources/government_health_sources_part2.csv" : "sources/government_health_sources.csv";
        const args = ["crawl", "government_health_discovery", "-a", `countries=${params.countries || ""}`, "-O", run.outputFiles.discovered];
        if (params.sourceFile !== "all") args.splice(2, 0, "-a", `source_file=${source}`); else args.splice(2, 0, "-a", "source_file=all");
        await execStep(run, "scrapy", args, { cwd: join(ROOT, "scrapers") });
      } else if (mode === "import_document_url") {
        const u = safeUrl(params.url); const input = join(TMP_INPUT, `${runId}-${basename(u.pathname) || "document"}`); await download(u.href, input);
        let importInput = input; let type = params.sourceType || "provider_file_import";
        if (/\.pdf$/i.test(input)) { importInput = join(out, "pdf-extracted.csv"); type = "pdf_provider_directory"; await execStep(run, "python", ["scripts/extract_medical_providers.py", input, importInput]); }
        await runImporter(run, importInput, Boolean(params.write), type, params.sourceTag || "document_url");
      } else if (mode === "import_raw_text") {
        const input = join(TMP_INPUT, `manual-${runId}.txt`); writeFileSync(input, params.text || ""); await runImporter(run, input, Boolean(params.write), params.sourceType || "provider_file_import", params.sourceTag || "manual_raw_text");
      } else if (mode === "import_provider_file_write") {
        const prev = recentRuns.find((r) => r.runId === params.runId); if (!prev?.outputFiles?.accepted) throw new Error("Preview run not found"); const input = resolveOutput(params.runId, prev.outputFiles.accepted); if (!input) throw new Error("Accepted CSV not found"); await runImporter(run, input, true, "provider_file_import", `write_from_${params.runId}`);
      } else throw new Error(`Unsupported run mode: ${mode}`);
      logStream.end(); finish(run, "completed");
    } catch (err) { finish(run, "failed", err); try { writeFileSync(run.outputFiles.logs, run.logs + "\n" + (err.stack || err.message)); } catch {} }
  })();
  return { ...run, outputFiles: publicFiles(run) };
}
