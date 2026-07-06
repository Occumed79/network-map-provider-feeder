import { spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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
let recentRuns = loadRecentRuns();

function loadRecentRuns() {
  try {
    return JSON.parse(readFileSync(RECENT_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveRecentRuns() {
  writeFileSync(RECENT_FILE, JSON.stringify(recentRuns.slice(0, 20), null, 2));
}

function outputDir(runId) {
  const dir = join(TMP_OUTPUT, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function assertHttpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("URL must be http or https");
  }
  return url;
}

function publicOutputFiles(run) {
  return Object.fromEntries(
    Object.entries(run.outputFiles || {}).map(([key, value]) => [key, basename(value)])
  );
}

function snapshotRun(run) {
  return { ...run, outputFiles: publicOutputFiles(run) };
}

function completeRun(run, status, err) {
  run.status = status;
  run.completedAt = new Date().toISOString();
  if (err) run.error = err.message || String(err);
  currentRun = run;
  const completedSnapshot = snapshotRun(run);
  recentRuns = [completedSnapshot, ...recentRuns.filter((recent) => recent.runId !== run.runId)].slice(0, 20);
  saveRecentRuns();
}

function appendLog(run, text) {
  run.logs += text;
  if (run.outputFiles.logs) {
    writeFileSync(run.outputFiles.logs, run.logs, "utf8");
  }
}

function execStep(run, command, args, opts = {}) {
  return new Promise((resolveStep, reject) => {
    run.command = [command, ...args].join(" ");
    appendLog(run, `\n$ ${run.command}\n`);

    const child = spawn(command, args, {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      shell: false,
    });

    child.stdout.on("data", (data) => appendLog(run, data.toString()));
    child.stderr.on("data", (data) => appendLog(run, data.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolveStep();
      else reject(new Error(`${command} exited ${code}`));
    });
  });
}

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
  return dest;
}

function importerArgs(input, run, write, sourceType, sourceTag) {
  return [
    "scripts/import_provider_text.py",
    input,
    "--source-type",
    sourceType,
    "--source-tag",
    sourceTag || run.mode,
    "--accepted-out",
    run.outputFiles.accepted,
    "--rejected-out",
    run.outputFiles.rejected,
    "--report-out",
    run.outputFiles.report,
    ...(write ? ["--write"] : []),
  ];
}

async function runImporter(run, input, write, sourceType, sourceTag) {
  await execStep(run, "python", importerArgs(input, run, write, sourceType, sourceTag), {
    env: { SCRAPY_WRITE_TO_NEON: write ? "1" : "0" },
  });
  summarizeReport(run);
}

function summarizeReport(run) {
  try {
    Object.assign(run, JSON.parse(readFileSync(run.outputFiles.report, "utf8")));
  } catch {
    // Some discovery-only runs do not produce importer reports.
  }
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function splitScrapyOutput(rawFile, providersFile, discoveredFile) {
  const providerRows = [];
  const discoveredRows = [];
  const text = existsSync(rawFile) ? readFileSync(rawFile, "utf8") : "";

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.type === "discovered_link") discoveredRows.push(row);
    else providerRows.push(row);
  }

  writeFileSync(providersFile, providerRows.map((row) => JSON.stringify(row)).join("\n"), "utf8");

  const fields = ["name", "sourceUrl", "services", "sourceType", "sourceTag", "evidenceNote"];
  const csv = [fields.join(",")]
    .concat(discoveredRows.map((row) => fields.map((field) => csvEscape(row[field])).join(",")))
    .join("\n");
  writeFileSync(discoveredFile, `${csv}\n`, "utf8");
}

export function getCurrentRun() {
  return currentRun.runId ? snapshotRun(currentRun) : currentRun;
}

export function getRecentRuns() {
  return recentRuns;
}

export function resolveOutput(runId, filename) {
  const base = resolve(TMP_OUTPUT, runId);
  const full = resolve(base, filename);
  if (!full.startsWith(`${base}/`) || basename(full) !== filename || !existsSync(full)) {
    return null;
  }
  return full;
}

export function startRun(mode, params = {}) {
  if (currentRun.status === "running") {
    throw new Error(`Run ${currentRun.runId} is already running`);
  }

  const runId = randomUUID().slice(0, 12);
  const out = outputDir(runId);
  const run = {
    ok: true,
    runId,
    status: "running",
    mode,
    startedAt: new Date().toISOString(),
    completedAt: null,
    command: "",
    logs: "",
    outputFiles: {
      accepted: join(out, "accepted.csv"),
      rejected: join(out, "rejected.csv"),
      report: join(out, "report.json"),
      logs: join(out, "logs.txt"),
    },
  };

  currentRun = run;

  (async () => {
    try {
      if (mode === "scrape_url") {
        const url = assertHttpUrl(params.url);
        const raw = join(out, "scrape.jsonl");
        const providers = join(out, "provider-candidates.jsonl");
        run.outputFiles.discovered = join(out, "discovered-links.csv");

        await execStep(run, "scrapy", [
          "crawl",
          "generic_provider_url",
          "-a",
          `url=${url.href}`,
          "-a",
          `country=${params.country || ""}`,
          "-a",
          `source_tag=${params.sourceTag || "pasted_url"}`,
          "-O",
          raw,
        ], { cwd: join(ROOT, "scrapers") });

        splitScrapyOutput(raw, providers, run.outputFiles.discovered);
        await runImporter(run, providers, Boolean(params.write), "pasted_url_scrape", params.sourceTag || "pasted_url");
      } else if (mode === "discover_government_health") {
        run.outputFiles.discovered = join(out, "discovered-links.csv");
        const sourceFile = params.sourceFile === "part2" ? "sources/government_health_sources_part2.csv" : "sources/government_health_sources.csv";
        const args = ["crawl", "government_health_discovery", "-a", `countries=${params.countries || ""}`, "-O", run.outputFiles.discovered];
        args.splice(2, 0, "-a", params.sourceFile === "all" ? "source_file=all" : `source_file=${sourceFile}`);
        await execStep(run, "scrapy", args, { cwd: join(ROOT, "scrapers") });
      } else if (mode === "import_document_url") {
        const url = assertHttpUrl(params.url);
        const input = join(TMP_INPUT, `${runId}-${basename(url.pathname) || "document"}`);
        await download(url.href, input);

        let importInput = input;
        let sourceType = params.sourceType || "provider_file_import";
        if (/\.pdf$/i.test(input)) {
          importInput = join(out, "pdf-extracted.csv");
          sourceType = "pdf_provider_directory";
          await execStep(run, "python", ["scripts/extract_medical_providers.py", input, importInput]);
        }
        await runImporter(run, importInput, Boolean(params.write), sourceType, params.sourceTag || "document_url");
      } else if (mode === "import_raw_text") {
        const input = join(TMP_INPUT, `manual-${runId}.txt`);
        writeFileSync(input, params.text || "", "utf8");
        await runImporter(run, input, Boolean(params.write), params.sourceType || "provider_file_import", params.sourceTag || "manual_raw_text");
      } else if (mode === "import_provider_file_write") {
        const previous = recentRuns.find((recent) => recent.runId === params.runId);
        if (!previous?.outputFiles?.accepted) throw new Error("Preview run not found");
        const input = resolveOutput(params.runId, previous.outputFiles.accepted);
        if (!input) throw new Error("Accepted CSV not found");
        await runImporter(run, input, true, "provider_file_import", `write_from_${params.runId}`);
      } else {
        throw new Error(`Unsupported run mode: ${mode}`);
      }

      completeRun(run, "completed");
    } catch (err) {
      appendLog(run, `\n${err.stack || err.message}\n`);
      completeRun(run, "failed", err);
    }
  })();

  return snapshotRun(run);
}
