/* Microsoft Clarity behavior report for the KRYPTAA admin (Phase 9.8).
   Uses the official Clarity Data Export API (project-live-insights), which returns AGGREGATED
   behavioral metrics only — sessions, rage/dead clicks, scroll depth, quick-backs, JS errors,
   engagement — by dimension (we request URL). Heatmaps & session recordings are NOT available via
   API (Clarity UI only) → the frontend links to them with official deep links.

   Env vars (Netlify):
     CLARITY_API_TOKEN   — Bearer token from Clarity → Settings → Data export (secret)
     CLARITY_PROJECT_ID  — the public project id (used for deep links + the tracking tag)
     ADMIN_KEY           — admin gate (shared with the other endpoints)

   The Clarity API allows only 10 calls/project/day, so responses are cached in Netlify Blobs for
   6 hours (≤4 calls/day). If a live fetch fails but a cache exists, the cached copy is returned with
   stale:true. Until CLARITY_API_TOKEN is set, returns { configured:false } for a clean waiting state.
   Never fabricates values. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }
function n(v) { var f = parseFloat(v); return isNaN(f) ? 0 : f; }

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const token = process.env.CLARITY_API_TOKEN;
  const projectId = process.env.CLARITY_PROJECT_ID || null;
  if (!token) {
    return json(200, { configured: false, reason: 'Missing CLARITY_API_TOKEN env var', projectId });
  }

  const debug = !!(event.queryStringParameters && event.queryStringParameters.debug);
  const force = !!(event.queryStringParameters && event.queryStringParameters.force);

  // ── Blobs cache (6h) — protects the 10 calls/day API limit ──
  let store = null;
  try { const { getStore } = require('@netlify/blobs'); store = getStore('clarity-cache'); } catch (e) { /* blobs optional */ }
  const CACHE_MS = 6 * 3600 * 1000;
  if (store && !force) {
    try {
      const cached = await store.get('insights', { type: 'json' });
      if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < CACHE_MS) {
        return json(200, Object.assign({}, cached.payload, { cached: true, stale: false }));
      }
    } catch (e) { /* ignore cache read errors */ }
  }

  // ── Live fetch (1 call: metrics by URL over last 3 days) ──
  let raw;
  try {
    const url = 'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL';
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    const text = await res.text();
    if (!res.ok) {
      // On failure, serve stale cache if we have one
      if (store) {
        try { const c = await store.get('insights', { type: 'json' }); if (c && c.payload) return json(200, Object.assign({}, c.payload, { cached: true, stale: true, reason: 'Live fetch failed (' + res.status + ') — showing last cached' })); } catch (e) {}
      }
      let msg = 'HTTP ' + res.status;
      try { const j = JSON.parse(text); msg = j.message || j.error || msg; } catch (e) {}
      if (res.status === 401 || res.status === 403) return json(200, { configured: false, reason: 'Clarity auth failed — check CLARITY_API_TOKEN (' + msg + ')', projectId });
      return json(200, { configured: false, reason: 'Clarity API error: ' + msg, projectId });
    }
    raw = JSON.parse(text);
  } catch (e) {
    if (store) { try { const c = await store.get('insights', { type: 'json' }); if (c && c.payload) return json(200, Object.assign({}, c.payload, { cached: true, stale: true, reason: 'Fetch error — showing last cached' })); } catch (e2) {} }
    return json(200, { configured: false, reason: 'Clarity fetch error: ' + (e.message || String(e)), projectId });
  }

  // ── Normalize. Clarity returns an array of { metricName, information:[ {..dims + fields..} ] } ──
  const metrics = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.metrics) ? raw.metrics : []);
  const totals = {
    sessions: 0, bots: 0, distinctUsers: 0, pagesPerSession: 0,
    avgScrollDepth: null, engagementTotalMin: null, engagementActiveMin: null,
    rageClicks: 0, deadClicks: 0, excessiveScroll: 0, quickBacks: 0, scriptErrors: 0, errorClicks: 0,
  };
  const pageMap = {}; // url -> { sessions, rage, dead, scroll, quickBack, error }
  function page(u) { if (!pageMap[u]) pageMap[u] = { url: u, sessions: 0, rage: 0, dead: 0, scroll: null, quickBack: 0, error: 0, excessive: 0 }; return pageMap[u]; }

  metrics.forEach((m) => {
    const key = norm(m.metricName);
    const info = Array.isArray(m.information) ? m.information : [];
    info.forEach((row) => {
      const u = row.Url || row.url || row.URL || null;
      if (key === 'traffic') {
        totals.sessions += n(row.totalSessionCount);
        totals.bots += n(row.totalBotSessionCount);
        totals.distinctUsers += n(row.distinctUserCount);
        if (row.pagesPerSessionPercentage != null) totals.pagesPerSession = n(row.pagesPerSessionPercentage);
        if (u) page(u).sessions += n(row.totalSessionCount);
      } else if (key === 'scrolldepth') {
        const sd = n(row.averageScrollDepth);
        if (totals.avgScrollDepth == null) totals.avgScrollDepth = 0;
        totals.avgScrollDepth = Math.max(totals.avgScrollDepth, sd);
        if (u) page(u).scroll = sd;
      } else if (key === 'engagementtime') {
        totals.engagementTotalMin = (totals.engagementTotalMin || 0) + n(row.totalTime);
        totals.engagementActiveMin = (totals.engagementActiveMin || 0) + n(row.activeTime);
      } else if (key === 'rageclickcount' || key === 'rageclick') {
        totals.rageClicks += n(row.subTotal); if (u) page(u).rage += n(row.subTotal);
      } else if (key === 'deadclickcount' || key === 'deadclick') {
        totals.deadClicks += n(row.subTotal); if (u) page(u).dead += n(row.subTotal);
      } else if (key === 'excessivescroll' || key === 'excessivescrolling') {
        totals.excessiveScroll += n(row.subTotal); if (u) page(u).excessive += n(row.subTotal);
      } else if (key === 'quickbackclick' || key === 'quickback') {
        totals.quickBacks += n(row.subTotal); if (u) page(u).quickBack += n(row.subTotal);
      } else if (key === 'scripterrorcount' || key === 'scripterror') {
        totals.scriptErrors += n(row.subTotal); if (u) page(u).error += n(row.subTotal);
      } else if (key === 'errorclickcount' || key === 'errorclick') {
        totals.errorClicks += n(row.subTotal);
      }
    });
  });

  const pages = Object.keys(pageMap).map((k) => pageMap[k]).sort((a, b) => b.sessions - a.sessions).slice(0, 40);
  const payload = {
    configured: true,
    projectId,
    rangeDays: 3,
    totals,
    pages,
    metricNames: metrics.map((m) => m.metricName),
    updatedAt: Date.now(),
    ...(debug ? { raw } : {}),
  };

  if (store) { try { await store.setJSON('insights', { fetchedAt: Date.now(), payload }); } catch (e) { /* cache write best-effort */ } }
  return json(200, Object.assign({}, payload, { cached: false, stale: false }));
};
