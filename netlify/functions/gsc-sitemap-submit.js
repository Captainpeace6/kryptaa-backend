/* ─────────────────────────────────────────────────────────────
   KRYPTAA — (Re)submit the sitemap to Google Search Console (admin)

   POST { sitemap? }  → PUT sites/{GSC_SITE_URL}/sitemaps/{sitemap}
   Default sitemap: https://www.kryptaa.com/sitemap.xml
   Needs the service account to have Full/Owner permission on the property
   (read-only users get 403 from the PUT). Uses GSC_SA_KEY / GA4_SA_KEY.
   Returns the sitemap's status after submission so the caller can see
   lastSubmitted / isPending / submitted-vs-indexed counts.
   ───────────────────────────────────────────────────────────── */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (c, o) => ({ statusCode: c, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const k = event.headers['x-admin-key'];
  if (!k || k !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  const siteUrl = process.env.GSC_SITE_URL;
  const saKeyRaw = process.env.GSC_SA_KEY || process.env.GA4_SA_KEY;
  if (!siteUrl || !saKeyRaw) return json(200, { ok: false, reason: 'Missing GSC_SITE_URL or service-account key' });
  const { sitemap = 'https://www.kryptaa.com/sitemap.xml' } = JSON.parse(event.body || '{}');

  let token;
  try {
    const credentials = JSON.parse(saKeyRaw);
    if (credentials.private_key && credentials.private_key.indexOf('\\n') !== -1) credentials.private_key = credentials.private_key.replace(/\\n/g, '\n');
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/webmasters'] });
    const client = await auth.getClient();
    const at = await client.getAccessToken();
    token = (at && at.token) || at;
    if (!token) throw new Error('no access token');
  } catch (e) { return json(200, { ok: false, reason: 'Auth failed: ' + e.message }); }

  const base = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(siteUrl) + '/sitemaps/' + encodeURIComponent(sitemap);
  const hdr = { Authorization: 'Bearer ' + token };
  try {
    const put = await fetch(base, { method: 'PUT', headers: hdr });
    if (!put.ok) return json(200, { ok: false, status: put.status, reason: (await put.text()).slice(0, 400) });
    const get = await fetch(base, { headers: hdr });
    const s = get.ok ? await get.json() : {};
    const contents = s.contents || [];
    return json(200, {
      ok: true, sitemap,
      lastSubmitted: s.lastSubmitted || null, lastDownloaded: s.lastDownloaded || null, isPending: !!s.isPending,
      submitted: contents.reduce((n, c) => n + parseInt(c.submitted || 0, 10), 0),
      indexed: contents.reduce((n, c) => n + parseInt(c.indexed || 0, 10), 0),
      warnings: parseInt(s.warnings || 0, 10), errors: parseInt(s.errors || 0, 10),
    });
  } catch (e) { return json(500, { ok: false, reason: e.message }); }
};
