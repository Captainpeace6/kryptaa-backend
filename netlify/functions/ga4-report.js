/* GA4 Data API report for the KRYPTAA admin Analytics dashboard.
   Requires two Netlify env vars (see setup steps):
     GA4_PROPERTY_ID  — the NUMERIC GA4 property id (e.g. 123456789), NOT G-242EQ24FP3
     GA4_SA_KEY       — the full service-account JSON key, pasted as a single-line string
   Until both are set (and the service account has Viewer access on the property with the
   GA4 Data API enabled), this returns { configured:false } so the dashboard shows a clean
   "Waiting for connection" state — never fabricated numbers. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };

  // Admin auth — same gate as the other admin endpoints.
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const propertyId = process.env.GA4_PROPERTY_ID;
  const saKeyRaw = process.env.GA4_SA_KEY;
  if (!propertyId || !saKeyRaw) {
    return json(200, { configured: false, reason: 'Missing GA4_PROPERTY_ID or GA4_SA_KEY env var' });
  }

  // date range: ?range=7|30|90 days (default 30)
  const rangeDays = parseInt((event.queryStringParameters && event.queryStringParameters.range) || '30', 10) || 30;
  const startDate = rangeDays + 'daysAgo';

  let client;
  try {
    const { BetaAnalyticsDataClient } = require('@google-analytics/data');
    const credentials = JSON.parse(saKeyRaw);
    if (credentials.private_key && credentials.private_key.indexOf('\\n') !== -1) {
      credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    }
    client = new BetaAnalyticsDataClient({ credentials, projectId: credentials.project_id });
  } catch (e) {
    return json(200, { configured: false, reason: 'Invalid GA4_SA_KEY JSON: ' + e.message });
  }

  const property = 'properties/' + propertyId;

  try {
    // Core metrics
    const [core] = await client.runReport({
      property,
      dateRanges: [{ startDate, endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'screenPageViews' },
        { name: 'engagedSessions' },
        { name: 'userEngagementDuration' },
        { name: 'bounceRate' },
        { name: 'conversions' },
        { name: 'totalRevenue' },
      ],
    });

    const mv = (core.rows && core.rows[0] && core.rows[0].metricValues) || [];
    const num = (i) => (mv[i] ? parseFloat(mv[i].value) || 0 : 0);
    const sessions = num(0);
    const users = num(1);
    const pageViews = num(2);
    const engagedSessions = num(3);
    const engagementDuration = num(4); // total seconds
    const bounceRate = num(5); // 0..1
    const conversions = num(6);
    const revenue = num(7);
    const avgEngagementSec = users ? engagementDuration / users : 0;
    const convRate = sessions ? (conversions / sessions) * 100 : 0;

    // Funnel by event
    let funnel = { view_item: 0, add_to_cart: 0, begin_checkout: 0, purchase: 0 };
    try {
      const [fr] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: { fieldName: 'eventName', inListFilter: { values: Object.keys(funnel) } },
        },
      });
      (fr.rows || []).forEach((r) => {
        const name = r.dimensionValues[0].value;
        if (name in funnel) funnel[name] = parseFloat(r.metricValues[0].value) || 0;
      });
    } catch (e) { /* funnel optional; leave zeros */ }

    // Channel attribution (sessions/users/revenue by default channel group) — for Marketing Attribution
    let channels = [];
    try {
      const [cr] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'conversions' }, { name: 'totalRevenue' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 15,
      });
      channels = (cr.rows || []).map((r) => ({
        channel: r.dimensionValues[0].value,
        sessions: parseFloat(r.metricValues[0].value) || 0,
        users: parseFloat(r.metricValues[1].value) || 0,
        conversions: parseFloat(r.metricValues[2].value) || 0,
        revenue: parseFloat(r.metricValues[3].value) || 0,
      }));
    } catch (e) { /* channels optional */ }

    // Per-page metrics (sessions, views, bounce, avg engagement) — for Landing Page Performance
    let pages = [];
    try {
      const [pr] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'sessions' }, { name: 'screenPageViews' }, { name: 'bounceRate' }, { name: 'userEngagementDuration' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 15,
      });
      pages = (pr.rows || []).map((r) => {
        const s = parseFloat(r.metricValues[0].value) || 0;
        const eng = parseFloat(r.metricValues[3].value) || 0;
        return {
          path: r.dimensionValues[0].value,
          sessions: s,
          views: parseFloat(r.metricValues[1].value) || 0,
          bounceRate: parseFloat(r.metricValues[2].value) || 0,
          avgEngagementSec: s ? eng / s : 0,
        };
      });
    } catch (e) { /* pages optional */ }

    // Per-product (item-scoped) metrics — for Product Intelligence
    let items = [];
    try {
      const [ir] = await client.runReport({
        property,
        dateRanges: [{ startDate, endDate: 'today' }],
        dimensions: [{ name: 'itemName' }],
        metrics: [
          { name: 'itemsViewed' },
          { name: 'itemsAddedToCart' },
          { name: 'itemsPurchased' },
          { name: 'itemRevenue' },
        ],
        orderBys: [{ metric: { metricName: 'itemsViewed' }, desc: true }],
        limit: 100,
      });
      items = (ir.rows || []).map((r) => ({
        name: r.dimensionValues[0].value,
        views: parseFloat(r.metricValues[0].value) || 0,
        addToCart: parseFloat(r.metricValues[1].value) || 0,
        purchased: parseFloat(r.metricValues[2].value) || 0,
        revenue: parseFloat(r.metricValues[3].value) || 0,
      }));
    } catch (e) { /* items optional */ }

    return json(200, {
      configured: true,
      rangeDays,
      sessions, users, pageViews, engagedSessions,
      avgEngagementSec, bounceRate, conversions, revenue, convRate,
      funnel,
      channels,
      pages,
      items,
      updatedAt: Date.now(),
    });
  } catch (e) {
    // Permission / API-not-enabled / property errors land here.
    return json(200, { configured: false, reason: 'GA4 API error: ' + (e.message || String(e)) });
  }
};
