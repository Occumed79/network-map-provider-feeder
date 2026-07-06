import { query } from "./db.js";

function response(statusCode, contentType, body) {
  return {
    statusCode,
    headers: { "content-type": contentType, "cache-control": "no-store" },
    body,
  };
}

function json(statusCode, payload) {
  return response(statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
}

async function safeRows(sql, params = []) {
  try {
    const { rows } = await query(sql, params);
    return rows;
  } catch (err) {
    return [{ error: err.message }];
  }
}

async function one(sql, params = []) {
  const rows = await safeRows(sql, params);
  return rows[0] || {};
}

export async function loadDashboardData(health) {
  const [jobCounts, runCounts, rawTotal, candidateTotal, sourceCounts, recentJobs, recentCandidates, recentErrors] = await Promise.all([
    safeRows(`SELECT status, count(*)::int AS count FROM provider_feeder_jobs GROUP BY status ORDER BY status`),
    safeRows(`SELECT status, count(*)::int AS count FROM provider_feeder_runs GROUP BY status ORDER BY status`),
    one(`SELECT count(*)::int AS count FROM google_maps_raw_results`),
    one(`SELECT count(*)::int AS count FROM provider_feeder_candidates`),
    safeRows(`
      SELECT COALESCE(raw->>'source', 'unknown') AS source, count(*)::int AS count
      FROM google_maps_raw_results
      GROUP BY 1
      ORDER BY count DESC, source ASC
      LIMIT 20
    `),
    safeRows(`
      SELECT id, query, service_line, region_name, status, attempts, max_attempts, error,
             created_at, started_at, completed_at
      FROM provider_feeder_jobs
      ORDER BY COALESCE(started_at, completed_at, created_at) DESC
      LIMIT 30
    `),
    safeRows(`
      SELECT id, name, category, address, phone, website, confidence_score, status, updated_at
      FROM provider_feeder_candidates
      ORDER BY updated_at DESC
      LIMIT 30
    `),
    safeRows(`
      SELECT id, query, status, attempts, error, completed_at, started_at
      FROM provider_feeder_jobs
      WHERE error IS NOT NULL
      ORDER BY COALESCE(completed_at, started_at, created_at) DESC
      LIMIT 25
    `),
  ]);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    env: {
      provider: process.env.SCRAPER_PROVIDER || "parallel_mapped_http",
      mapSources: process.env.MAP_SOURCES || "bing,google,apple",
      maxJobsPerLoop: process.env.MAX_JOBS_PER_LOOP || "1",
      maxResultsPerJob: process.env.MAX_RESULTS_PER_JOB || "120",
    },
    health,
    totals: {
      rawResults: rawTotal.count || 0,
      candidates: candidateTotal.count || 0,
    },
    jobCounts,
    runCounts,
    sourceCounts,
    recentJobs,
    recentCandidates,
    recentErrors,
  };
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Provider Feeder</title>
<style>
:root{color-scheme:dark;--bg:#07111f;--p:rgba(15,27,45,.82);--b:rgba(125,211,252,.22);--t:#e5f3ff;--m:#94a3b8;--g:#34d399;--w:#fbbf24;--r:#fb7185;--c:#38bdf8}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 12% 0,rgba(56,189,248,.22),transparent 34rem),radial-gradient(circle at 88% 0,rgba(52,211,153,.16),transparent 30rem),linear-gradient(135deg,#020617,var(--bg));color:var(--t);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}header{padding:32px clamp(18px,4vw,54px) 16px;display:flex;justify-content:space-between;gap:16px;align-items:flex-start}h1{font-size:clamp(30px,4vw,50px);letter-spacing:-.045em;margin:0}.sub{color:var(--m);margin-top:8px}.badge{border:1px solid var(--b);background:rgba(56,189,248,.1);border-radius:999px;padding:8px 12px;color:#bae6fd;white-space:nowrap}main{padding:0 clamp(18px,4vw,54px) 54px}.grid{display:grid;gap:16px}.cards{grid-template-columns:repeat(6,minmax(0,1fr))}.cols{grid-template-columns:minmax(0,1.1fr) minmax(0,.9fr);margin-top:16px}.card,.panel{border:1px solid var(--b);background:linear-gradient(180deg,var(--p),rgba(6,15,28,.88));border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(14px)}.card{padding:18px;min-height:108px}.label{color:var(--m);font-size:12px;text-transform:uppercase;letter-spacing:.12em}.value{font-size:32px;font-weight:780;margin-top:8px;letter-spacing:-.04em}.hint{color:var(--m);font-size:13px;margin-top:7px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.panel{padding:18px;overflow:hidden}.panel h2{font-size:17px;margin:0 0 12px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--m);font-weight:650;border-bottom:1px solid var(--b);padding:10px 8px}td{border-bottom:1px solid rgba(148,163,184,.12);padding:10px 8px;vertical-align:top}tr:hover td{background:rgba(56,189,248,.05)}.scroll{overflow:auto;max-height:520px}.pill{border:1px solid rgba(148,163,184,.24);border-radius:999px;padding:3px 8px;background:rgba(15,23,42,.62)}.pending{color:var(--w)}.running{color:var(--c)}.completed{color:var(--g)}.failed{color:var(--r)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.err{color:#fecdd3;max-width:460px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.empty{color:var(--m);padding:14px 4px}@media(max-width:1180px){.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.cols{grid-template-columns:1fr}}@media(max-width:720px){header{flex-direction:column}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.value{font-size:26px}}
</style>
</head>
<body>
<header><div><h1>Provider Feeder</h1><div class="sub">Parallel mapped-source scraper feeding Neon. Sources: <span id="sources">loading</span></div></div><div class="badge" id="status">loading</div></header>
<main><section class="grid cards" id="cards"></section><section class="grid cols"><div class="panel"><h2>Recent Jobs</h2><div class="scroll" id="jobs"></div></div><div class="panel"><h2>Source Counts</h2><div id="sourceCounts"></div></div></section><section class="grid cols"><div class="panel"><h2>Newest Candidates</h2><div class="scroll" id="candidates"></div></div><div class="panel"><h2>Recent Errors</h2><div class="scroll" id="errors"></div></div></section></main>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>v?new Date(v).toLocaleString():'';
const count=(rows,s)=>(rows||[]).find(r=>r.status===s)?.count||0;
const card=(l,v,h='')=>'<div class="card"><div class="label">'+esc(l)+'</div><div class="value">'+esc(v)+'</div><div class="hint">'+esc(h)+'</div></div>';
function table(headers, rows, mapper){if(!rows||!rows.length)return '<div class="empty">No rows yet.</div>';return '<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+mapper(r).map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
async function refresh(){const res=await fetch('/api/dashboard',{cache:'no-store'});const d=await res.json();document.getElementById('status').textContent=d.health.status+(d.health.ready?' / ready':'');document.getElementById('sources').textContent=d.env.mapSources;document.getElementById('cards').innerHTML=[card('Candidates',d.totals.candidates,'normalized provider rows'),card('Raw Results',d.totals.rawResults,'mapped source rows'),card('Pending',count(d.jobCounts,'pending'),'jobs waiting'),card('Running',count(d.jobCounts,'running'),'currently claimed'),card('Completed',count(d.jobCounts,'completed'),'finished jobs'),card('Failed',count(d.jobCounts,'failed'),d.health.lastError||'no latest error')].join('');document.getElementById('jobs').innerHTML=table(['ID','Status','Query','Attempts','Updated'],d.recentJobs,r=>['<span class="mono">'+esc(r.id)+'</span>','<span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span>',esc(r.query),esc((r.attempts||0)+'/'+(r.max_attempts||'')),esc(fmt(r.completed_at||r.started_at||r.created_at))]);document.getElementById('sourceCounts').innerHTML=table(['Source','Rows'],d.sourceCounts,r=>[esc(r.source),'<span class="mono">'+esc(r.count)+'</span>']);document.getElementById('candidates').innerHTML=table(['Name','Category','Address','Confidence'],d.recentCandidates,r=>[esc(r.name),esc(r.category||''),esc(r.address||''),'<span class="mono">'+esc(Number(r.confidence_score||0).toFixed(2))+'</span>']);document.getElementById('errors').innerHTML=table(['Job','Status','Error'],d.recentErrors,r=>['<span class="mono">'+esc(r.id)+'</span>','<span class="pill '+esc(r.status)+'">'+esc(r.status)+'</span>','<div class="err">'+esc(r.error||'')+'</div>'])}
refresh().catch(e=>{document.getElementById('status').textContent='dashboard error';console.error(e)});setInterval(refresh,15000);
</script>
</body>
</html>`;
}

export async function handleDashboardRequest(req, health) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  if (path === "/" || path === "/dashboard") return response(200, "text/html; charset=utf-8", dashboardHtml());
  if (["/health", "/healthz", "/status"].includes(path)) return json(200, { ok: true, service: "network-map-provider-feeder", ...health });
  if (path === "/api/dashboard" || path === "/api/status") return json(200, await loadDashboardData(health));
  return json(404, { ok: false, error: "not_found" });
}
