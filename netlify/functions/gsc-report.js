/* Google Search Console report for the KRYPTAA admin SEO dashboard.
   Reuses the same Google service account as GA4 (Phase 9.3) — no new credential needed,
   just a different API + scope. Requires:
     GSC_SITE_URL  — the exact Search Console property, e.g. "sc-domain:kryptaa.com"
                     (Domain property) or "https://www.kryptaa.com/" (URL-prefix property)
     a service-account key — GSC_SA_KEY if set, else falls back to GA4_SA_KEY
   The service account must be added as a user on the Search Console property, and the
   Search Console API must be enabled in the Cloud project. Until configured, returns
   { configured:false } so the dashboard shows a clean "Waiting for connection" state —
   never fabricated numbers. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  // Admin auth — same gate as the other admin endpoints.
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const siteUrl = process.env.GSC_SITE_URL;
  const saKeyRaw = process.env.GSC_SA_KEY || process.env.GA4_SA_KEY;
  if (!siteUrl || !saKeyRaw) {
    return json(200, { configured: false, reason: 'Missing GSC_SITE_URL or service-account key (GSC_SA_KEY/GA4_SA_KEY)' });
  }

  // date range: ?range=7|28|90 days (default 28). GSC data lags ~2 days, so end 2 days ago
  // to avoid partial/incomplete recent days skewing CTR & position.
  const rangeDays = parseInt((event.queryStringParameters && event.queryStringParameters.range) || '28', 10) || 28;
  const end = new Date(Date.now() - 2 * 86400000);
  const start = new Date(end.getTime() - rangeDays * 86400000);
  const startDate = ymd(start);
  const endDate = ymd(end);

  // Auth: request a webmasters.readonly access token via the service account.
  let token;
  try {
    const credentials = JSON.parse(saKeyRaw);
    if (credentials.private_key && credentials.private_key.indexOf('\\n') !== -1) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/webmasters.readonly'],
    });
    const client = await auth.getClient();
    const at = await client.getAccessToken();
    token = (at && at.token) || at;
    if (!token) throw new Error('no access token');
  } catch (e) {
    return json(200, { configured: false, reason: 'Auth failed: ' + (e.message || String(e)) });
  }

  const base = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl);
  async function gapi(path, method, body) {
    const res = await fetch(base + path, {
      method: method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (e) { /* leave {} */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  try {
    // Aggregate totals (no dimensions → single summary row)
    const totalsResp = await gapi('/searchAnalytics/query', 'POST', { startDate, endDate, dimensions: [] });
    const t = (totalsResp.rows && totalsResp.rows[0]) || {};
    const clicks = t.clicks || 0;
    const impressions = t.impressions || 0;
    const ctr = t.ctr || 0;          // 0..1
    const position = t.position || 0; // avg position

    // Top keywords
    const kwResp = await gapi('/searchAnalytics/query', 'POST', { startDate, endDate, dimensions: ['query'], rowLimit: 10 });
    const keywords = (kwResp.rows || []).map((r) => ({
      query: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0,
    }));

    // Top landing pages
    const pgResp = await gapi('/searchAnalytics/query', 'POST', { startDate, endDate, dimensions: ['page'], rowLimit: 10 });
    const pages = (pgResp.rows || []).map((r) => ({
      page: r.keys[0], clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0,
    }));

    // Sitemaps + index coverage (derived from sitemap contents submitted/indexed)
    let sitemaps = [];
    let submitted = 0, indexed = 0;
    try {
      const smResp = await gapi('/sitemaps', 'GET');
      sitemaps = (smResp.sitemap || []).map((s) => {
        const contents = s.contents || [];
        contents.forEach((c) => { submitted += parseInt(c.submitted || 0, 10); indexed += parseInt(c.indexed || 0, 10); });
        return {
          path: s.path,
          lastSubmitted: s.lastSubmitted || null,
          lastDownloaded: s.lastDownloaded || null,
          isPending: !!s.isPending,
          isSitemapsIndex: !!s.isSitemapsIndex,
          warnings: parseInt(s.warnings || 0, 10),
          errors: parseInt(s.errors || 0, 10),
        };
      });
    } catch (e) { /* sitemaps optional */ }

    return json(200, {
      configured: true,
      siteUrl,
      rangeDays, startDate, endDate,
      clicks, impressions, ctr, position,
      keywords, pages,
      sitemaps,
      indexCoverage: { submitted, indexed },
      updatedAt: Date.now(),
    });
  } catch (e) {
    // Permission / API-not-enabled / property errors land here.
    let reason = 'GSC API error: ' + (e.message || String(e));
    if (e.status === 403) reason = 'Access denied — add the service account as a user on the GSC property, and enable the Search Console API (403)';
    return json(200, { configured: false, reason });
  }
};
