/* Public: approved customer reviews, grouped by productId, for the site to
   merge with the static REVIEWS map. Photos are served as data URIs (≤3).
   Cached 5 minutes at the edge. */
const { getStore } = require('@netlify/blobs');
function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
const monthYear = (iso) => { const d = new Date(iso || Date.now()); return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }); };

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const byProduct = {};
  try {
    const store = blobStore('kryptaa-reviews');
    const listing = await store.list();
    for (const b of (listing && listing.blobs) || []) {
      try {
        const r = JSON.parse(await store.get(b.key));
        if (r.status !== 'approved' || !r.productId) continue;
        (byProduct[r.productId] = byProduct[r.productId] || []).push({
          author: r.name, date: monthYear(r.date), rating: r.rating, size: r.size || '', body: r.review,
          photos: (r.photos || []).slice(0, 3), verified: !!r.verified, dynamic: true, key: b.key,
        });
      } catch (e) {}
    }
  } catch (e) { console.error('reviews-public error:', e.message); }
  return {
    statusCode: 200,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify({ reviews: byProduct }),
  };
};
