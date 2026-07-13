import { createReadStream } from "fs";
import { basename } from "path";

import { isValidSqlIdentifier } from "./appCandidateWriter.js";
import { APPLE_DASHBOARD_CSS } from "./dashboardTheme.js";
import { query } from "./db.js";
import { getCurrentRun, getRecentRuns, resolveOutput, startRun, stopRun } from "./manualRunner.js";

const CURRENT_SOURCES = [
  "scrapy_directory",
  "pasted_url_scrape",
  "government_health_registry",
  "provider_file_import",
  "pdf_provider_directory",
  "google_local_jsonl_import",
];
const LEGACY_SOURCES = [
  "bing_maps_http",
  "google_maps_http",
  "apple_maps_http",
  "npi_registry",
  "unknown",
  "browser_scraper",
  "map_scraper",
  "google_maps_browser",
];
const APP_TABLE = process.env.APP_CANDIDATE_TABLE || "provider_candidates";
const MAX_BODY_BYTES = Number(process.env.MANUAL_INGESTION_MAX_BODY_BYTES || 2_000_000);

const response = (statusCode, contentType, body) => ({
  statusCode,
  headers: { "content-type": contentType, "cache-control": "no-store" },
  body,
});
const json = (statusCode, payload) => response(statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
const q = (name) => `"${name}"`;
const first = (columns, names) => names.find((name) => columns.has(name));

async function safeRows(sql, params = []) {
  try {
    return (await query(sql, params)).rows;
  } catch (err) {
    return [{ error: err.message }];
  }
}

async function one(sql, params = []) {
  return (await safeRows(sql, params))[0] || {};
}

async function tableExists(tableName) {
  if (!isValidSqlIdentifier(tableName)) return false;
  return Boolean((await one("SELECT to_regclass($1::text) AS regclass", [`public.${tableName}`])).regclass);
}

async function columns(tableName) {
  if (!isValidSqlIdentifier(tableName)) return new Set();
  const rows = await safeRows(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
    [tableName]
  );
  return new Set(rows.map((row) => row.column_name).filter(Boolean));
}

function legacyErrorKind(error) {
  return /google-maps-scraper binary exited|No mapped results returned|mapped/i.test(error || "")
    ? "legacy_map_scraper"
    : "error";
}

async function recentAppCandidates(appTableExists) {
  if (!appTableExists || !isValidSqlIdentifier(APP_TABLE)) return [];
  const cols = await columns(APP_TABLE);
  const idCol = first(cols, ["id"]);
  const nameCol = first(cols, ["name", "provider_name", "clinic_name", "title"]);
  const categoryCol = first(cols, ["category", "provider_category", "primary_category", "service_line", "service_type"]);
  const addressCol = first(cols, ["address", "full_address", "street_address"]);
  const phoneCol = first(cols, ["phone", "phone_number"]);
  const websiteCol = first(cols, ["website", "url"]);
  const confidenceCol = first(cols, ["confidence_score", "confidence"]);
  const updatedCol = first(cols, ["updated_at", "created_at"]);
  const select = [
    idCol ? `${q(idCol)} AS id` : "NULL AS id",
    nameCol ? `${q(nameCol)} AS name` : "NULL AS name",
    categoryCol ? `${q(categoryCol)} AS category` : "NULL AS category",
    addressCol ? `${q(addressCol)} AS address` : "NULL AS address",
    phoneCol ? `${q(phoneCol)} AS phone` : "NULL AS phone",
    websiteCol ? `${q(websiteCol)} AS website` : "NULL AS website",
    confidenceCol ? `${q(confidenceCol)} AS confidence_score` : "NULL AS confidence_score",
    updatedCol ? `${q(updatedCol)} AS updated_at` : "NULL AS updated_at",
  ].join(", ");
  const order = updatedCol || idCol || [...cols][0];
  if (!order) return [];
  return safeRows(`SELECT ${select} FROM ${q(APP_TABLE)} ORDER BY ${q(order)} DESC LIMIT 30`);
}

async function latestCrawlRuns() {
  const exists = await tableExists("provider_feeder_crawl_runs");
  if (!exists) return [];
  return safeRows(
    `SELECT run_key, mode, start_url, status, pages_crawled, providers_found, providers_written,
            last_url, last_error, started_at, updated_at, completed_at, config
       FROM provider_feeder_crawl_runs
      ORDER BY updated_at DESC
      LIMIT 20`
  );
}

async function latestResumableCrawl() {
  const exists = await tableExists("provider_feeder_crawl_runs");
  if (!exists) return null;
  const row = await one(
    `SELECT run_key, mode, config
       FROM provider_feeder_crawl_runs
      WHERE status IN ('paused','failed','running')
      ORDER BY updated_at DESC
      LIMIT 1`
  );
  return row?.run_key ? row : null;
}

export async function loadDashboardData(health) {
  const appTableExists = await tableExists(APP_TABLE);
  const showLegacy = process.env.DASHBOARD_SHOW_LEGACY === "1";
  const [
    rawTotal,
    currentRawSinceStart,
    feederTotal,
    appTotal,
    currentSourceCounts,
    legacySourceCounts,
    recentFeeder,
    recentApp,
    crawlRuns,
    legacyJobs,
    legacyErrorsRaw,
  ] = await Promise.all([
    one("SELECT count(*)::int AS count FROM google_maps_raw_results"),
    one(
      "SELECT count(*)::int AS count FROM google_maps_raw_results WHERE created_at >= $1::timestamptz AND COALESCE(raw->>'source','unknown') = ANY($2::text[])",
      [health.startedAt, CURRENT_SOURCES]
    ),
    one("SELECT count(*)::int AS count FROM provider_feeder_candidates"),
    appTableExists ? one(`SELECT count(*)::int AS count FROM ${q(APP_TABLE)}`) : { count: 0 },
    safeRows(
      "SELECT COALESCE(raw->>'source','unknown') AS source, count(*)::int AS count FROM google_maps_raw_results WHERE COALESCE(raw->>'source','unknown') = ANY($1::text[]) GROUP BY 1 ORDER BY count DESC, source ASC",
      [CURRENT_SOURCES]
    ),
    safeRows(
      "SELECT COALESCE(raw->>'source','unknown') AS source, count(*)::int AS count FROM google_maps_raw_results WHERE NOT (COALESCE(raw->>'source','unknown') = ANY($1::text[])) GROUP BY 1 ORDER BY count DESC, source ASC LIMIT 20",
      [CURRENT_SOURCES]
    ),
    safeRows(
      "SELECT id, name, category, address, phone, website, confidence_score, status, updated_at FROM provider_feeder_candidates ORDER BY updated_at DESC LIMIT 30"
    ),
    recentAppCandidates(appTableExists),
    latestCrawlRuns(),
    showLegacy
      ? safeRows(
          "SELECT id, query, status, attempts, error, created_at, started_at, completed_at FROM provider_feeder_jobs ORDER BY COALESCE(started_at, completed_at, created_at) DESC LIMIT 25"
        )
      : [],
    showLegacy
      ? safeRows(
          "SELECT id, query, status, attempts, error, completed_at, started_at FROM provider_feeder_jobs WHERE error IS NOT NULL ORDER BY COALESCE(completed_at, started_at, created_at) DESC LIMIT 25"
        )
      : [],
  ]);

  const warnings = [];
  if (process.env.ENABLE_APP_CANDIDATE_WRITE !== "1") {
    warnings.push("ENABLE_APP_CANDIDATE_WRITE is disabled; final provider_candidates writes are off.");
  }
  if (!appTableExists) warnings.push(`${APP_TABLE} is missing or unavailable; showing feeder staging only.`);
  if ((currentRawSinceStart.count || 0) === 0) {
    warnings.push("No providers have been written by the current crawler since this dashboard service started.");
  }
  if (legacySourceCounts.some((row) => LEGACY_SOURCES.includes(row.source))) {
    warnings.push("Legacy map/NPI rows exist and are separated from current crawler source counts.");
  }

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    env: {
      mode: health.mode || "dashboard_and_scrapy_ingestion",
      currentSources: CURRENT_SOURCES,
      appCandidateWrite: process.env.ENABLE_APP_CANDIDATE_WRITE === "1",
      appCandidateTable: APP_TABLE,
      appCandidateTableExists: appTableExists,
      dashboardShowLegacy: showLegacy,
    },
    health,
    warnings,
    totals: {
      appCandidates: appTotal.count || 0,
      feederStaging: feederTotal.count || 0,
      rawResults: rawTotal.count || 0,
      currentRawSinceStart: currentRawSinceStart.count || 0,
    },
    currentSourceCounts,
    legacySourceCounts,
    recentAppCandidates: recentApp,
    recentFeederCandidates: recentFeeder,
    crawlRuns,
    legacyJobs,
    legacyErrors: legacyErrorsRaw.map((row) => ({ ...row, error_kind: legacyErrorKind(row.error) })),
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Provider Ingestion Dashboard</title>
  <style>${APPLE_DASHBOARD_CSS}</style>
</head>
<body>
<header class="top">
  <div>
    <h1>Provider Ingestion Dashboard</h1>
    <div class="sub">Manually start a deep crawl. Valid provider records write to Neon automatically while it runs.</div>
    <div class="meta">Last refreshed: <span id="lastRefreshed">never</span></div>
  </div>
  <div class="actions">
    <button class="button" id="refreshButton" type="button">Refresh now</button>
    <div class="badge" id="status">loading</div>
  </div>
</header>
<main>
  <div id="warnings"></div>
  <section class="grid cards" id="cards"></section>

  <section class="panel">
    <h2>Long-Run Provider Crawl</h2>
    <p class="hint">This follows provider, facility, location, detail, and pagination pages. It outputs provider records only and writes accepted records to Neon automatically.</p>
    <div class="grid cols">
      <div class="card">
        <h3>Crawl a provider directory</h3>
        <input id="scrapeUrl" placeholder="https://example.org/locations">
        <input id="scrapeCountry" placeholder="Country or 2-letter country code">
        <input id="scrapeTag" placeholder="Source tag optional">
        <div class="grid cols">
          <label class="hint">Runtime hours<input id="runtimeHours" type="number" min="0.1" max="24" step="0.5" value="8"></label>
          <label class="hint">Maximum pages<input id="maxPages" type="number" min="10" max="100000" step="100" value="5000"></label>
          <label class="hint">Crawl depth<input id="maxDepth" type="number" min="1" max="20" value="8"></label>
          <label class="hint">Concurrency<input id="concurrency" type="number" min="1" max="24" value="6"></label>
          <label class="hint">Delay seconds<input id="delay" type="number" min="0" max="10" step="0.05" value="0.35"></label>
        </div>
        <button class="button" onclick="startDirectoryCrawl()">Run and write providers to Neon</button>
      </div>

      <div class="card">
        <h3>Government registry provider crawl</h3>
        <p class="hint">This no longer returns a list of discovered links. It follows the registry pages and extracts provider records.</p>
        <select id="govSource"><option value="all">Both source lists</option><option value="part1">Part 1</option><option value="part2">Part 2</option></select>
        <input id="govCountries" placeholder="Countries optional, comma-separated">
        <select id="govMode"><option value="facility_registry">Facility registries only</option><option value="all">All selected government health sources</option></select>
        <label class="hint">Maximum source sites<input id="govMaxSources" type="number" min="1" max="500" value="50"></label>
        <button class="button" onclick="startGovernmentCrawl()">Run and write providers to Neon</button>
      </div>
    </div>
    <div class="actions" style="justify-content:flex-start;margin-top:14px">
      <button class="button" onclick="stopCurrentRun()">Stop current run</button>
      <button class="button" onclick="resumeLastRun()">Resume last stopped crawl</button>
    </div>
    <h3>Current Run</h3>
    <div id="runStatus" class="mono"></div>
    <pre id="runLogs" class="scroll"></pre>
  </section>

  <section class="panel">
    <h2>File and Text Import</h2>
    <p class="hint">These remain preview-first because they are user-supplied files rather than live directory crawls.</p>
    <div class="grid cols">
      <div class="card">
        <h3>Import document or file URL</h3>
        <input id="docUrl" placeholder="https://example.gov/providers.pdf">
        <select id="docType"><option>pdf_provider_directory</option><option>provider_file_import</option><option>google_local_jsonl_import</option></select>
        <input id="docTag" placeholder="Source tag optional">
        <button class="button" onclick="startImport('import-document-url',false)">Preview</button>
        <button class="button" onclick="startImport('import-document-url',true)">Write accepted rows</button>
      </div>
      <div class="card">
        <h3>Paste raw provider text</h3>
        <textarea id="rawText" rows="7" placeholder="Paste provider data"></textarea>
        <input id="rawTag" placeholder="Source tag optional">
        <button class="button" onclick="startImport('import-raw-text',false)">Preview</button>
        <button class="button" onclick="startImport('import-raw-text',true)">Write accepted rows</button>
      </div>
    </div>
  </section>

  <section class="grid cols">
    <div class="panel"><h2>Current Source Counts</h2><div id="sourceCounts"></div><div id="legacySourcePanel"><h2>Legacy Source Counts</h2><div id="legacySources"></div></div></div>
    <div class="panel"><h2>Durable Crawl Runs</h2><div class="scroll" id="crawlRuns"></div></div>
  </section>
  <section class="grid cols">
    <div class="panel"><h2>Recent App Candidates</h2><div class="scroll" id="appCandidates"></div></div>
    <div class="panel"><h2>Recent Feeder Staging Candidates</h2><div class="scroll" id="feederCandidates"></div></div>
  </section>
  <section class="grid cols" id="legacySection">
    <div class="panel"><h2>Legacy Map Jobs</h2><div class="scroll" id="legacyJobs"></div></div>
    <div class="panel"><h2>Legacy Errors</h2><div class="scroll" id="legacyErrors"></div></div>
  </section>
</main>
<script>
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt = value => value ? new Date(value).toLocaleString() : '';
const card = (label,value,hint='') => '<div class="card"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div><div class="hint">'+esc(hint)+'</div></div>';
function table(headers, rows, mapper){if(!rows||!rows.length)return '<div class="empty">No rows.</div>';return '<table><thead><tr>'+headers.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+mapper(row).map(cell=>'<td>'+cell+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
async function post(path,body={}){const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(data.error||'Request failed');return data}
function crawlControls(){return {runtimeMinutes:Number(runtimeHours.value||8)*60,maxPages:Number(maxPages.value||5000),maxDepth:Number(maxDepth.value||8),concurrency:Number(concurrency.value||6),delay:Number(delay.value||0.35),sameDomain:true}}
async function startDirectoryCrawl(){try{await post('/api/run/scrape-url',{url:scrapeUrl.value,country:scrapeCountry.value,sourceTag:scrapeTag.value||'pasted_url',...crawlControls()});await refresh()}catch(error){alert(error.message)}}
async function startGovernmentCrawl(){try{await post('/api/run/government-health-ingest',{sourceFile:govSource.value,countries:govCountries.value,crawlMode:govMode.value,maxSources:Number(govMaxSources.value||50),...crawlControls()});await refresh()}catch(error){alert(error.message)}}
async function stopCurrentRun(){try{await post('/api/run/stop');await refresh()}catch(error){alert(error.message)}}
async function resumeLastRun(){try{await post('/api/run/resume-last');await refresh()}catch(error){alert(error.message)}}
async function startImport(kind,write){try{const body=kind==='import-document-url'?{url:docUrl.value,sourceType:docType.value,sourceTag:docTag.value,write}:{text:rawText.value,sourceType:'provider_file_import',sourceTag:rawTag.value||'manual_raw_text',write};await post('/api/run/'+kind,body);await refresh()}catch(error){alert(error.message)}}
function renderRun(run){const files=run.outputFiles||{};const downloads=Object.values(files).map(file=>'<a class="button" href="/api/output/'+esc(run.runId||'')+'/'+esc(file)+'">'+esc(file)+'</a>').join(' ');runStatus.innerHTML='Status: '+esc(run.status||'idle')+' | Run: '+esc(run.runId||'')+' | Crawl key: '+esc(run.runKey||'')+' | Pages: '+esc(run.pagesCrawled||0)+' | Providers found: '+esc(run.providersFound||0)+' | Written: '+esc(run.providersWritten||0)+' | Pending URLs: '+esc(run.pendingUrls||0)+'<br>Current: '+esc(run.currentUrl||'')+'<br>'+downloads;runLogs.textContent=(run.logs||'').slice(-14000)}
let isRefreshing=false;
async function refresh(){if(isRefreshing)return;isRefreshing=true;refreshButton.disabled=true;refreshButton.textContent='Refreshing...';try{const data=await(await fetch('/api/dashboard?ts='+Date.now(),{cache:'no-store'})).json();const runData=await(await fetch('/api/run/status?ts='+Date.now(),{cache:'no-store'})).json();renderRun(runData.currentRun||{});status.textContent=data.health.status+(data.health.ready?' / ready':'');lastRefreshed.textContent=new Date().toLocaleString();warnings.innerHTML=(data.warnings||[]).map(w=>'<div class="warn">'+esc(w)+'</div>').join('');cards.innerHTML=[card('App Candidates',data.totals.appCandidates,'final provider rows'),card('Feeder Staging',data.totals.feederStaging,'deduplicated staging rows'),card('Raw Evidence',data.totals.rawResults,'source evidence rows'),card('Written This Service Run',data.totals.currentRawSinceStart,'current crawler sources')].join('');sourceCounts.innerHTML=table(['Source','Rows'],data.currentSourceCounts,row=>[esc(row.source),'<span class="mono">'+esc(row.count)+'</span>']);crawlRuns.innerHTML=table(['Status','Mode','Pages','Found','Written','Updated'],data.crawlRuns,row=>['<span class="pill '+esc(row.status)+'">'+esc(row.status)+'</span>',esc(row.mode),esc(row.pages_crawled),esc(row.providers_found),esc(row.providers_written),esc(fmt(row.updated_at))]);const candidates=rows=>table(['Name','Category','Address','Confidence'],rows,row=>[esc(row.name),esc(row.category||''),esc(row.address||''),'<span class="mono">'+esc(Number(row.confidence_score||0).toFixed(2))+'</span>']);appCandidates.innerHTML=candidates(data.recentAppCandidates);feederCandidates.innerHTML=candidates(data.recentFeederCandidates);const showLegacy=Boolean(data.env&&data.env.dashboardShowLegacy);legacySourcePanel.style.display=showLegacy?'':'none';legacySection.style.display=showLegacy?'':'none';legacySources.innerHTML=showLegacy?table(['Source','Rows'],data.legacySourceCounts,row=>[esc(row.source),esc(row.count)]):'';legacyJobs.innerHTML=showLegacy?table(['ID','Status','Query','Updated'],data.legacyJobs,row=>[esc(row.id),esc(row.status),esc(row.query),esc(fmt(row.completed_at||row.started_at||row.created_at))]):'';legacyErrors.innerHTML=showLegacy?table(['Job','Kind','Error'],data.legacyErrors,row=>[esc(row.id),esc(row.error_kind||'error'),esc(row.error||'')]):''}catch(error){status.textContent='dashboard error';console.error(error)}finally{isRefreshing=false;refreshButton.disabled=false;refreshButton.textContent='Refresh now'}}
refreshButton.addEventListener('click',refresh);refresh();setInterval(refresh,10000);
</script>
</body>
</html>`;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error(`Request body too large; max ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function validateHttpUrl(value) {
  const url = new URL(value || "");
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("URL must be http/https");
  return url.href;
}

export async function handleDashboardRequest(req, health) {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/" || url.pathname === "/dashboard") {
    return response(200, "text/html; charset=utf-8", dashboardHtml());
  }
  if (["/health", "/healthz", "/status"].includes(url.pathname)) {
    return json(200, { ok: true, service: "network-map-provider-feeder", ...health });
  }
  if (url.pathname === "/api/dashboard" || url.pathname === "/api/status") {
    return json(200, await loadDashboardData(health));
  }
  if (url.pathname === "/api/run/status") {
    return json(200, { ok: true, currentRun: getCurrentRun(), recentRuns: getRecentRuns() });
  }
  if (url.pathname.startsWith("/api/output/")) {
    const [, , , runId, file] = url.pathname.split("/");
    const path = resolveOutput(runId, basename(file || ""));
    if (!path) return json(404, { ok: false, error: "output_not_found" });
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${basename(path)}"`,
      },
      body: createReadStream(path),
    };
  }
  if (req.method === "POST" && url.pathname === "/api/run/stop") {
    try {
      return json(202, stopRun());
    } catch (err) {
      return json(400, { ok: false, error: err.message });
    }
  }
  if (req.method === "POST" && url.pathname === "/api/run/resume-last") {
    try {
      const latest = await latestResumableCrawl();
      if (!latest) throw new Error("No stopped or failed crawl is available to resume");
      const config = typeof latest.config === "string" ? JSON.parse(latest.config) : latest.config || {};
      const mode = latest.mode === "government_health_ingest" ? "government_health_ingest" : "scrape_url";
      return json(202, startRun(mode, { ...config, runKey: latest.run_key }));
    } catch (err) {
      return json(400, { ok: false, error: err.message });
    }
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
    try {
      const body = await readJsonBody(req);
      let mode = url.pathname.slice("/api/run/".length).replaceAll("-", "_");
      if (mode === "discover_government_health") mode = "government_health_ingest";
      if (mode === "write_last_accepted") mode = "import_provider_file_write";
      if (["scrape_url", "import_document_url"].includes(mode)) body.url = validateHttpUrl(body.url);
      return json(202, startRun(mode, body));
    } catch (err) {
      return json(400, { ok: false, error: err.message });
    }
  }
  return json(404, { ok: false, error: "not_found" });
}
