/* ─────────────────────────────────────────────────────────────
   KRYPTAA — Review moderation (admin)

   Store "kryptaa-reviews": one blob per submission from submit-review.js
   { product, name, size, rating, review, photos[dataURI], date, status }.
   GET                         → { reviews: [...] }  newest first, photos as
                                 count + thumbs (first 3 data URIs)
   POST { key, action, productId?, photosKeep?[] }
        action = approve → status 'approved', productId set (which product
                            page it belongs to), photos trimmed to photosKeep
        action = reject  → status 'rejected'
   Approved reviews are served publicly by reviews-public.js.
   ───────────────────────────────────────────────────────────── */
const { getStore } = require('@netlify/blobs');

function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (c, o) => ({ statusCode: c, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(o) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const k = event.headers['x-admin-key'];
  if (!k || k !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });
  const store = blobStore('kryptaa-reviews');

  try {
    if (event.httpMethod === 'GET') {
      const listing = await store.list();
      const out = [];
      for (const b of (listing && listing.blobs) || []) {
        try {
          const r = JSON.parse(await store.get(b.key));
          out.push({ key: b.key, product: r.product, name: r.name, size: r.size, rating: r.rating, review: r.review, date: r.date, status: r.status || 'pending', productId: r.productId || null, photoCount: (r.photos || []).length, photos: (r.photos || []).slice(0, 3) });
        } catch (e) {}
      }
      out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      return json(200, { reviews: out });
    }
    if (event.httpMethod === 'POST') {
      const { key, action, productId, photosKeep } = JSON.parse(event.body || '{}');
      if (!key || !action) return json(400, { error: 'key and action required' });
      const raw = await store.get(key); if (!raw) return json(404, { error: 'not found' });
      const r = JSON.parse(raw);
      if (action === 'approve') {
        r.status = 'approved'; r.approvedAt = Date.now();
        if (productId) r.productId = String(productId);
        if (Array.isArray(photosKeep)) r.photos = (r.photos || []).filter((_, i) => photosKeep.includes(i));
      } else if (action === 'reject') {
        r.status = 'rejected';
      } else return json(400, { error: 'unknown action' });
      await store.set(key, JSON.stringify(r));
      return json(200, { ok: true, status: r.status, productId: r.productId || null });
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('reviews-admin error:', err.message);
    return json(500, { error: err.message });
  }
};
