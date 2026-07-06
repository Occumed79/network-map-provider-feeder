import { query } from "./db.js";
import { isValidSqlIdentifier } from "./appCandidateWriter.js";

const CURRENT_SOURCES = ["scrapy_directory"];
const LEGACY_SOURCES = ["bing_maps_http", "google_maps_http", "apple_maps_http", "npi_registry", "unknown"];
const APP_TABLE = process.env.APP_CANDIDATE_TABLE || "provider_candidates";

function response(statusCode, contentType, body) {
  return { statusCode, headers: { "content-type": contentType, "cache-control": "no-store" }, body };
}

function json(statusCode, payload) {
  return response(statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
}

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
  const row = await one("SELECT to_regclass($1::text) AS regclass", [`public.${tableName}`]);
  return Boolean(row.regclass);
}

async function columns(tableName) {
  if (!isValidSqlIdentifier(tableName)) return new Set();
  const rows = await safeRows(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
    [tableName]
  );
  return new Set(rows.map((r) => r.column_name).filter(Boolean));
}

function q(name) {
  return `"${name}"`;
}

function first(cols, names) {
  return names.find((n) => cols.has(n));
}

function legacyErrorKind(error) {
  return /google-maps-scraper binary exited|No mapped results returned|mapped/i.test(error || "") ? "legacy_map_scraper" : "error";
}

async function recentAppCandidates(appTableExists) {
  if (!appTableExists || !isValidSqlIdentifier(APP_TABLE)) return [];

  const cols = await columns(APP_TABLE);
  const nameCol = first(cols, ["name", "provider_name", "clinic_name", "title"]);
  const categoryCol = first(cols, ["category", "provider_category", "primary_category", "service_line", "service_type"]);
  const addressCol = first(cols, ["address", "full_address", "street_address"]);
  const phoneCol = first(cols, ["phone", "phone_number"]);
  const websiteCol = first(cols, ["website", "url"]);
  const confidenceCol = first(cols, ["confidence_score", "confidence"]);
  const updatedCol = first(cols, ["updated_at", "created_at"]);
  const idCol = first(cols, ["id"]);

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
  return safeRows(`SELECT ${select} FROM ${q(APP_TABLE)} ORDER BY ${q(order)} DESC LIMIT 30`);
}

export async function loadDashboardData(health) {
  const appTableExists = await tableExists(APP_TABLE);
  const showLegacy = process.env.DASHBOARD_SHOW_LEGACY === "1";
  const currentSourceSql = `
    SELECT COALESCE(raw->>'source','unknown') AS source, count(*)::int AS count
    FROM google_maps_raw_results
    WHERE COALESCE(raw->>'source','unknown') = ANY($1::text[])
    GROUP BY 1
    ORDER BY count DESC, source ASC
  `;
  const legacySourceSql = `
    SELECT COALESCE(raw->>'source','unknown') AS source, count(*)::int AS count
    FROM google_maps_raw_results
    WHERE NOT (COALESCE(raw->>'source','unknown') = ANY($1::text[]))
    GROUP BY 1
    ORDER BY count DESC, source ASC
    LIMIT 20
  `;

  const [
    rawTotal,
    currentRawSinceStart,
    feederTotal,
    appTotal,
    currentSourceCounts,
    legacySourceCounts,
    recentFeeder,
    recentApp,
    legacyJobs,
    legacyErrorsRaw,
  ] = await Promise.all([
    one(`SELECT count(*)::int AS count FROM google_maps_raw_results`),
    one(
      `SELECT count(*)::int AS count
       FROM google_maps_raw_results
       WHERE created_at >= $1::timestamptz
         AND COALESCE(raw->>'source','unknown') = ANY($2::text[])`,
      [health.startedAt, CURRENT_SOURCES]
    ),
    one(`SELECT count(*)::int AS count FROM provider_feeder_candidates`),
    appTableExists ? one(`SELECT count(*)::int AS count FROM ${q(APP_TABLE)}`) : { count: 0 },
    safeRows(currentSourceSql, [CURRENT_SOURCES]),
    safeRows(legacySourceSql, [CURRENT_SOURCES]),
    safeRows(`
      SELECT id, name, category, address, phone, website, confidence_score, status, updated_at
      FROM provider_feeder_candidates
      ORDER BY updated_at DESC
      LIMIT 30
    `),
    recentAppCandidates(appTableExists),
    showLegacy
      ? safeRows(`
          SELECT id, query, status, attempts, error, created_at, started_at, completed_at
          FROM provider_feeder_jobs
          ORDER BY COALESCE(started_at, completed_at, created_at) DESC
          LIMIT 25
        `)
      : [],
    showLegacy
      ? safeRows(`
          SELECT id, query, status, attempts, error, completed_at, started_at
          FROM provider_feeder_jobs
          WHERE error IS NOT NULL
          ORDER BY COALESCE(completed_at, started_at, created_at) DESC
          LIMIT 25
        `)
      : [],
  ]);

  const warnings = [];
  if (process.env.ENABLE_APP_CANDIDATE_WRITE !== "1") warnings.push("ENABLE_APP_CANDIDATE_WRITE is disabled; final provider_candidates writes are off.");
  if (!appTableExists) warnings.push(`${APP_TABLE} is missing or unavailable; showing feeder staging only.`);
  if ((currentRawSinceStart.count || 0) === 0) warnings.push("No Scrapy directory rows have been written since this dashboard service started. Run a Scrapy source with SCRAPY_WRITE_TO_NEON=1 to populate providers.");
  if (legacySourceCounts.some((r) => LEGACY_SOURCES.includes(r.source))) warnings.push("Legacy map/NPI rows exist and are separated from current Scrapy source counts.");

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
    legacyJobs,
    legacyErrors: legacyErrorsRaw.map((r) => ({ ...r, error_kind: legacyErrorKind(r.error) })),
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Provider Feeder</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--p:rgba(15,27,45,.82);--b:rgba(125,211,252,.22);--t:#e5f3ff;--m:#94a3b8;--g:#34d399;--w:#fbbf24;--r:#fb7185;--c:#38bdf8}*{box-sizing:border-box}body{margin:0;background:linear-gradient(135deg,#020617,var(--bg));color:var(--t);font-family:system-ui,sans-serif}header,main{padding:24px clamp(18px,4vw,54px)}h1{margin:0;font-size:42px}.sub,.hint,.empty,.meta{color:var(--m)}.badge,.button{border:1px solid var(--b);border-radius:999px;padding:8px 12px;color:#bae6fd;background:rgba(56,189,248,.08)}.button{cursor:pointer;font:inherit}.button:hover{background:rgba(56,189,248,.16)}.button:disabled{cursor:wait;opacity:.65}.top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end}.grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(4,minmax(0,1fr))}.cols{grid-template-columns:1fr 1fr;margin-top:16px}.card,.panel,.warn{border:1px solid var(--b);background:var(--p);border-radius:18px;padding:16px}.warn{border-color:rgba(251,191,36,.5);background:rgba(251,191,36,.08);margin-bottom:16px}.label{color:var(--m);font-size:12px;text-transform:uppercase;letter-spacing:.12em}.value{font-size:30px;font-weight:800}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid rgba(148,163,184,.16);padding:8px;vertical-align:top}.scroll{overflow:auto;max-height:430px}.pill{border:1px solid rgba(148,163,184,.24);border-radius:999px;padding:3px 8px}.completed{color:var(--g)}.failed{color:var(--r)}.running{color:var(--c)}.pending{color:var(--w)}.mono{font-family:monospace}.err{color:#fecdd3;max-width:520px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}@media(max-width:1100px){.cards{grid-template-columns:repeat(2,1fr)}.cols{grid-template-columns:1fr}}@media(max-width:680px){.cards{grid-template-columns:1fr}.top{display:block}.actions{justify-content:flex-start;margin-top:14px}}
</style>
</head>
<body>
<header class="top">
  <div>
    <h1>Provider Feeder</h1>
    <div class="sub">Scrapy crawler ingestion dashboard. Current source: <span id="sources">loading</span></div>
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
  <section class="grid cols"><div class="panel"><h2>Current Scrapy Source Counts</h2><div id="sourceCounts"></div><h2>Legacy Source Counts</h2><div id="legacySources"></div></div><div class="panel"><h2>Current Diagnosis</h2><div id="diagnosis"></div></div></section>
  <section class="grid cols"><div class="panel"><h2>Recent App Candidates</h2><div class="scroll" id="appCandidates"></div></div><div class="panel"><h2>Recent Feeder Staging Candidates</h2><div class="scroll" id="feederCandidates"></div></div></section>
  <section class="grid cols"><div class="panel"><h2>Legacy Map Jobs</h2><div class="scroll" id="legacyJobs"></div></div><div class="panel"><h2>Legacy Errors</h2><div class="scroll" id="legacyErrors"></div></div></section>
</main>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v?new Date(v).toLocaleString():'';
const card=(l,v,h='')=>'<div class="card"><div class="label">'+esc(l)+'</div><div class="value">'+esc(v)+'</div><div class="hint">'+esc(h)+'</div></div>';
function table(h,rows,map){if(!rows||!rows.length)return '<div class="empty">No rows.</div>';return '<table><thead><tr>'+h.map(x=>'<th>'+esc(x)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+map(r).map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
let isRefreshing=false;
async function refresh(){
  if(isRefreshing)return;
  isRefreshing=true;
  refreshButton.disabled=true;
  refreshButton.textContent='Refreshing...';
  try{
    const d=await (await fetch('/api/dashboard?ts='+Date.now(),{cache:'no-store'})).json();
    status.textContent=d.health.status+(d.health.ready?' / ready':'');
    sources.textContent=(d.env.currentSources||[]).join(', ');
    lastRefreshed.textContent=new Date().toLocaleString();
    warnings.innerHTML=(d.warnings||[]).map(w=>'<div class="warn">'+esc(w)+'</div>').join('');
    cards.innerHTML=[card('App Candidates',d.totals.appCandidates,'final app-facing provider rows'),card('Feeder Staging',d.totals.feederStaging,'staging/dedupe rows'),card('Raw Results',d.totals.rawResults,'all raw rows'),card('New Scrapy Rows',d.totals.currentRawSinceStart,'since dashboard start')].join('');
    sourceCounts.innerHTML=table(['Source','Rows'],d.currentSourceCounts,r=>[esc(r.source),'<span class="mono">'+esc(r.count)+'</span>']);
    legacySources.innerHTML=table(['Source','Rows'],d.legacySourceCounts,r=>[esc(r.source),'<span class="mono">'+esc(r.count)+'</span>']);
    const cand=(rows)=>table(['Name','Category','Address','Confidence'],rows,r=>[esc(r.name),esc(r.category||''),esc(r.address||''),'<span class="mono">'+esc(Number(r.confidence_score||0).toFixed(2))+'</span>']);
    appCandidates.innerHTML=cand(d.recentAppCandidates);
    feederCandidates.innerHTML=cand(d.recentFeederCandidates);
    legacyJobs.innerHTML=table(['ID','Status','Query','Updated'],d.legacyJobs,r=>['<span class="mono">'+esc(r.id)+'</span>','<span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span>',esc(r.query),esc(fmt(r.completed_at||r.started_at||r.created_at))]);
    legacyErrors.innerHTML=table(['Job','Kind','Error'],d.legacyErrors,r=>['<span class="mono">'+esc(r.id)+'</span>',esc(r.error_kind||'error'),'<div class="err">'+esc(r.error||'')+'</div>']);
    diagnosis.innerHTML='<div class="empty">The legacy map worker loop is removed. Provider growth now comes from Scrapy crawler runs writing raw.source=scrapy_directory into Neon.</div>';
  }catch(e){
    status.textContent='dashboard error';
    console.error(e);
  }finally{
    isRefreshing=false;
    refreshButton.disabled=false;
    refreshButton.textContent='Refresh now';
  }
}
refreshButton.addEventListener('click',refresh);
refresh();
setInterval(refresh,15000);
</script>
</body>
</html>`;
}

export async function handleDashboardRequest(req, health) {
  const url = new URL(req.url || "/", "http://localhost");
  if (url.pathname === "/" || url.pathname === "/dashboard") return response(200, "text/html; charset=utf-8", dashboardHtml());
  if (["/health", "/healthz", "/status"].includes(url.pathname)) return json(200, { ok: true, service: "network-map-provider-feeder", ...health });
  if (url.pathname === "/api/dashboard" || url.pathname === "/api/status") return json(200, await loadDashboardData(health));
  return json(404, { ok: false, error: "not_found" });
}
