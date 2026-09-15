/* Admin: back-in-stock waitlist.
   GET  →  { counts: { "110": 3, ... } }        (unsent waiters per product)
   POST { id }  →  { productId, sent, failed, skipped }  (email waiters now) */
const { notifyProduct, waitlistCounts, blobStore } = require('./restock-lib');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (code, obj) => ({ statusCode: code, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });

  try {
    if (event.httpMethod === 'GET') return json(200, { counts: await waitlistCounts() });
    if (event.httpMethod === 'POST') {
      const { id, remove } = JSON.parse(event.body || '{}');
      if (!id) return json(400, { error: 'id required' });
      /* { id, remove: "<email>" } — drop one waiter (tests / unsubscribe requests) */
      if (remove) {
        const crypto = require('crypto');
        const key = 'p' + String(id) + '_' + crypto.createHash('sha256').update(String(remove).trim().toLowerCase()).digest('hex');
        await blobStore('kryptaa-restock').delete(key);
        return json(200, { ok: true, removed: key });
      }
      return json(200, await notifyProduct(String(id)));
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('restock-notify error:', err.message);
    return json(500, { error: err.message });
  }
};
