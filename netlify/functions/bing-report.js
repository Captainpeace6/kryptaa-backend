/* Bing Webmaster Tools report for the KRYPTAA admin SEO dashboard (Phase 9.6).
   Uses the Bing Webmaster REST API with API-key auth. Requires two Netlify env vars:
     BING_API_KEY   — the API key from Bing Webmaster Tools → Settings → API access
     BING_SITE_URL  — the exact verified site, e.g. "https://www.kryptaa.com" (or with a trailing /)
   Optional:
     INDEXNOW_KEY   — set this if IndexNow is configured for the site (drives the IndexNow status)

   Credentials live only on the server (never exposed to the frontend). Until both env vars are
   present and the site is verified in Bing WMT, this returns { configured:false } so the dashboard
   shows a clean "Waiting for Bing" state — never fabricated numbers.

   Bing's JSON endpoints wrap payloads in { "d": ... } and encode dates as "/Date(ms)/". Field names
   vary across methods, so every call is guarded and every field extracted defensively; whatever an
   endpoint doesn't return comes back null and the UI shows "No data available". Pass ?debug=1 to get
   the raw responses (useful for verifying field mapping against a live account). */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

// Bing encodes dates as "/Date(1692576000000)/" (sometimes with a timezone offset).
function parseBingDate(v) {
  if (!v) return null;
  if (typeof v === 'string') {
    const m = v.match(/\/Date\((\d+)/);
    if (m) return new Date(parseInt(m[1], 10)).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// Pick the first present numeric field from a list of candidate keys.
function num(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && !isNaN(parseFloat(obj[k]))) return parseFloat(obj[k]);
  }
  return 0;
}
function str(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).length) return String(obj[k]);
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  // Admin auth — same gate as the other admin endpoints.
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const apiKey = process.env.BING_API_KEY;
  const siteUrl = process.env.BING_SITE_URL;
  const indexNowConfigured = !!process.env.INDEXNOW_KEY;

  if (!apiKey || !siteUrl) {
    return json(200, {
      configured: false,
      reason: 'Missing BING_API_KEY or BING_SITE_URL env var',
      indexNow: { configured: indexNowConfigured },
    });
  }

  const debug = !!(event.queryStringParameters && event.queryStringParameters.debug);
  const base = 'https://ssl.bing.com/webmaster/api.svc/json/';
  const auth = 'apikey=' + encodeURIComponent(apiKey) + '&siteUrl=' + encodeURIComponent(siteUrl);
  const partial = [];   // endpoints that failed (surfaced for transparency)
  const raw = {};

  async function bing(method, extra) {
    const url = base + method + '?' + auth + (extra || '');
    const res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { throw new Error(method + ': non-JSON response'); }
    if (!res.ok) {
      const msg = (data && (data.Message || data.error || (data.ExceptionMessage))) || ('HTTP ' + res.status);
      throw new Error(method + ': ' + msg);
    }
    return data && Object.prototype.hasOwnProperty.call(data, 'd') ? data.d : data;
  }
  async function safe(method, extra) {
    try {
      const d = await bing(method, extra);
      if (debug) raw[method] = d;
      return d;
    } catch (e) {
      partial.push(e.message || String(e));
      return null;
    }
  }

  // Verify auth cheaply first: GetUserSites returns the sites this key can access.
  let authOk = true;
  try {
    await bing('GetUserSites', '');
  } catch (e) {
    // A bad key / unverified site fails here — report a clean waiting state rather than a hard error.
    return json(200, {
      configured: false,
      reason: 'Bing auth failed — check BING_API_KEY and that ' + siteUrl + ' is verified in Bing WMT (' + (e.message || e) + ')',
      indexNow: { configured: indexNowConfigured },
    });
  }

  // --- Search performance (traffic), keywords, pages, crawl, sitemaps, backlinks ---
  const [traffic, queryStats, pageStats, crawlStats, crawlIssues, feeds, linkCounts] = await Promise.all([
    safe('GetRankAndTrafficStats', ''),
    safe('GetQueryStats', ''),
    safe('GetPageStats', ''),
    safe('GetCrawlStats', ''),
    safe('GetCrawlIssues', ''),
    safe('GetFeeds', ''),
    safe('GetLinkCounts', '&page=0'),
  ]);

  // Totals from daily traffic rows
  const trafficRows = Array.isArray(traffic) ? traffic : [];
  let clicks = 0, impressions = 0;
  trafficRows.forEach((r) => { clicks += num(r, ['Clicks']); impressions += num(r, ['Impressions']); });

  // Keywords
  const kwRows = Array.isArray(queryStats) ? queryStats : [];
  const keywords = kwRows.slice(0, 25).map((r) => {
    const imp = num(r, ['Impressions']);
    const clk = num(r, ['Clicks']);
    return {
      query: str(r, ['Query']),
      clicks: clk,
      impressions: imp,
      ctr: imp ? clk / imp : 0,
      position: num(r, ['AvgImpressionPosition', 'AvgClickPosition', 'Position']),
    };
  }).filter((k) => k.query).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  // If daily traffic wasn't available, derive totals from query stats
  if (!clicks && !impressions && keywords.length) {
    keywords.forEach((k) => { clicks += k.clicks; impressions += k.impressions; });
  }

  // Pages
  const pgRows = Array.isArray(pageStats) ? pageStats : [];
  const pages = pgRows.slice(0, 25).map((r) => {
    const imp = num(r, ['Impressions']);
    const clk = num(r, ['Clicks']);
    return {
      page: str(r, ['Query', 'Page', 'Url']),   // Bing returns the page URL under "Query" for GetPageStats
      clicks: clk,
      impressions: imp,
      ctr: imp ? clk / imp : 0,
      position: num(r, ['AvgImpressionPosition', 'AvgClickPosition', 'Position']),
    };
  }).filter((p) => p.page).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

  // Average position (weighted by impressions across keywords)
  let avgPosition = 0;
  if (keywords.length) {
    let wsum = 0, isum = 0;
    keywords.forEach((k) => { if (k.position) { wsum += k.position * (k.impressions || 1); isum += (k.impressions || 1); } });
    avgPosition = isum ? wsum / isum : 0;
  }

  // Crawl — latest daily row + error totals
  const crawlRows = Array.isArray(crawlStats) ? crawlStats : [];
  let crawl = null;
  if (crawlRows.length) {
    // rows are per-day; find the most recent by Date
    const withDates = crawlRows.map((r) => ({ r, d: parseBingDate(r.Date) })).filter((x) => x.d);
    withDates.sort((a, b) => new Date(b.d) - new Date(a.d));
    const latest = (withDates[0] && withDates[0].r) || crawlRows[crawlRows.length - 1];
    let code4xx = 0, code5xx = 0, crawledPages = 0, blockedByRobots = 0, inIndex = 0, code2xx = 0;
    crawlRows.forEach((r) => {
      code4xx += num(r, ['Code4xx']);
      code5xx += num(r, ['Code5xx']);
      blockedByRobots += num(r, ['BlockedByRobotsTxt']);
    });
    crawledPages = num(latest, ['CrawledPages']);
    inIndex = num(latest, ['InIndex', 'InLinks']);
    code2xx = num(latest, ['Code2xx']);
    crawl = {
      lastCrawlDate: parseBingDate(latest.Date),
      crawledPages,
      crawlErrors: code4xx + code5xx,
      code4xx, code5xx, code2xx,
      blockedByRobots,
      inIndex,
    };
  }
  const crawlIssueCount = Array.isArray(crawlIssues) ? crawlIssues.length : null;

  // Sitemaps (GetFeeds)
  const feedRows = Array.isArray(feeds) ? feeds : [];
  const sitemaps = feedRows.map((f) => ({
    url: str(f, ['Url', 'Feed']),
    status: str(f, ['Status', 'FeedStatus']),
    lastCrawled: parseBingDate(f.LastCrawledDate || f.LastCrawled),
    submitted: num(f, ['UrlCount', 'DiscoveredUrlCount']),
  })).filter((s) => s.url);

  // Backlinks (GetLinkCounts → total inbound links for the site)
  let backlinks = null;
  if (Array.isArray(linkCounts)) {
    backlinks = linkCounts.reduce((sum, r) => sum + num(r, ['Count', 'LinkCount']), 0);
  } else if (linkCounts && typeof linkCounts === 'object') {
    backlinks = num(linkCounts, ['Count', 'LinkCount']) || null;
  }

  // Indexed pages: Bing has no single clean endpoint; use crawl InIndex if present.
  const indexedPages = crawl && crawl.inIndex ? crawl.inIndex : null;

  // Robots.txt: inferred — if crawling succeeded with few blocks, treat as accessible.
  let robotsStatus = null;
  if (crawl) robotsStatus = crawl.crawledPages > 0 ? 'Accessible' : (crawl.blockedByRobots > 0 ? 'Blocking pages' : null);

  return json(200, {
    configured: true,
    siteUrl,
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    avgPosition,
    keywords,
    pages,
    crawl,
    crawlIssueCount,
    sitemaps,
    backlinks,
    indexedPages,
    robotsStatus,
    indexNow: { configured: indexNowConfigured },
    partial: partial.length ? partial : undefined,
    updatedAt: Date.now(),
    ...(debug ? { raw } : {}),
  });
};
