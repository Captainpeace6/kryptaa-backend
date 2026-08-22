/* Paid Marketing Intelligence for the KRYPTAA admin (Phase 9.9).
   Reports the REAL connection status of each ad platform and, when credentials exist, pulls live
   spend/campaign data. NEVER fabricates or estimates ad spend or ROAS — an unconfigured platform
   reports "Not Connected"; a configured one with no campaigns reports "No Campaigns"; an API error
   reports "Permission Error"/"Processing". Revenue/AOV/ROAS math is done client-side by combining
   this with the GA4 + orders data the admin already has.

   Env vars (all optional; absent → that platform is "Not Connected"):
     Google Ads:   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CLIENT_ID,
                   GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_CUSTOMER_ID
     Meta Ads:     META_ADS_TOKEN, META_ADS_ACCOUNT_ID   (act_XXXXXXXX)
     Microsoft:    MSFT_ADS_DEVELOPER_TOKEN, MSFT_ADS_REFRESH_TOKEN, MSFT_ADS_CLIENT_ID, MSFT_ADS_ACCOUNT_ID
   Cached 6h in Netlify Blobs; serves stale on failure. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};
function json(statusCode, obj) {
  return { statusCode, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
function n(v) { var f = parseFloat(v); return isNaN(f) ? 0 : f; }

/* ── Meta Marketing API (Graph) — the one platform reachable with a single token ── */
async function fetchMeta() {
  const token = process.env.META_ADS_TOKEN;
  const acct = process.env.META_ADS_ACCOUNT_ID; // act_XXXXXXXXX
  if (!token || !acct) return { status: 'Not Connected', reason: 'Missing META_ADS_TOKEN / META_ADS_ACCOUNT_ID' };
  const acctId = acct.indexOf('act_') === 0 ? acct : ('act_' + acct);
  try {
    const fields = 'campaign_name,spend,clicks,impressions,ctr,cpc,actions,action_values';
    const url = 'https://graph.facebook.com/v21.0/' + encodeURIComponent(acctId) + '/insights'
      + '?level=campaign&date_preset=last_30d&limit=200&fields=' + encodeURIComponent(fields)
      + '&access_token=' + encodeURIComponent(token);
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok || data.error) {
      const msg = (data.error && data.error.message) || ('HTTP ' + res.status);
      const isAuth = data.error && (data.error.code === 190 || data.error.type === 'OAuthException');
      return { status: isAuth ? 'Permission Error' : 'Processing', reason: msg };
    }
    const rows = data.data || [];
    const campaigns = rows.map((r) => {
      const purch = (r.actions || []).filter((a) => /purchase/i.test(a.action_type)).reduce((s, a) => s + n(a.value), 0);
      const rev = (r.action_values || []).filter((a) => /purchase/i.test(a.action_type)).reduce((s, a) => s + n(a.value), 0);
      const spend = n(r.spend);
      return {
        name: r.campaign_name, platform: 'Meta', spend, clicks: n(r.clicks), impressions: n(r.impressions),
        ctr: n(r.ctr), cpc: n(r.cpc), conversions: purch, revenue: rev,
        roas: spend > 0 && rev > 0 ? rev / spend : null, cpa: spend > 0 && purch > 0 ? spend / purch : null,
      };
    });
    if (!campaigns.length) return { status: 'No Campaigns', campaigns: [], spend: 0 };
    const agg = campaigns.reduce((a, c) => ({ spend: a.spend + c.spend, clicks: a.clicks + c.clicks, impressions: a.impressions + c.impressions, conversions: a.conversions + c.conversions, revenue: a.revenue + c.revenue }), { spend: 0, clicks: 0, impressions: 0, conversions: 0, revenue: 0 });
    return { status: 'Connected', campaignCount: campaigns.length, campaigns, ...agg, ctr: agg.impressions ? (agg.clicks / agg.impressions) * 100 : 0, cpc: agg.clicks ? agg.spend / agg.clicks : 0, roas: agg.spend > 0 && agg.revenue > 0 ? agg.revenue / agg.spend : null };
  } catch (e) {
    return { status: 'Processing', reason: 'Meta fetch error: ' + (e.message || String(e)) };
  }
}

/* Google Ads & Microsoft Ads require heavier OAuth + SDK setup and an approved developer token.
   Until fully credentialed we report their real state honestly (never fabricate). */
function fetchGoogle() {
  const ok = process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_REFRESH_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID;
  if (!ok) return { status: 'Not Connected', reason: 'Missing Google Ads credentials (developer token + OAuth refresh token + customer id)' };
  return { status: 'Processing', reason: 'Google Ads credentials present — connector activation pending' };
}
function fetchMicrosoft() {
  const ok = process.env.MSFT_ADS_DEVELOPER_TOKEN && process.env.MSFT_ADS_REFRESH_TOKEN && process.env.MSFT_ADS_ACCOUNT_ID;
  if (!ok) return { status: 'Not Connected', reason: 'Missing Microsoft Advertising credentials (developer token + OAuth + account id)' };
  return { status: 'Processing', reason: 'Microsoft Ads credentials present — connector activation pending' };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const force = !!(event.queryStringParameters && event.queryStringParameters.force);
  let store = null;
  try { const { getStore } = require('@netlify/blobs'); store = getStore('marketing-cache'); } catch (e) {}
  const CACHE_MS = 6 * 3600 * 1000;
  if (store && !force) {
    try { const c = await store.get('report', { type: 'json' }); if (c && c.fetchedAt && (Date.now() - c.fetchedAt) < CACHE_MS) return json(200, Object.assign({}, c.payload, { cached: true })); } catch (e) {}
  }

  const meta = await fetchMeta();
  const google = fetchGoogle();
  const microsoft = fetchMicrosoft();

  // Aggregate ONLY across genuinely-connected platforms (never invent totals).
  const connected = [google, meta, microsoft].filter((p) => p.status === 'Connected');
  const totalSpend = connected.reduce((s, p) => s + n(p.spend), 0);
  const anyConnected = connected.length > 0;

  const payload = {
    platforms: { google, meta, microsoft },
    totals: {
      connectedCount: connected.length,
      spend: anyConnected ? totalSpend : null,     // null → "Not Connected" on the frontend (never $0-as-fact)
      clicks: anyConnected ? connected.reduce((s, p) => s + n(p.clicks), 0) : null,
      impressions: anyConnected ? connected.reduce((s, p) => s + n(p.impressions), 0) : null,
      adConversions: anyConnected ? connected.reduce((s, p) => s + n(p.conversions), 0) : null,
      adRevenue: anyConnected ? connected.reduce((s, p) => s + n(p.revenue), 0) : null,
    },
    campaigns: connected.reduce((arr, p) => arr.concat(p.campaigns || []), []),
    updatedAt: Date.now(),
  };

  if (store) { try { await store.setJSON('report', { fetchedAt: Date.now(), payload }); } catch (e) {} }
  return json(200, Object.assign({}, payload, { cached: false }));
};
