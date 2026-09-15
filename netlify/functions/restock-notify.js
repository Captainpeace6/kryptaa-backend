/* Admin: back-in-stock waitlist.
   GET  →  { counts: { "110": 3, ... } }        (unsent waiters per product)
   POST { id }  →  { productId, sent, failed, skipped }  (email waiters now) */
const { notifyProduct, waitlistCounts } = require('./restock-lib');

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
      const { id } = JSON.parse(event.body || '{}');
      if (!id) return json(400, { error: 'id required' });
      return json(200, await notifyProduct(String(id)));
    }
    return json(405, { error: 'Method Not Allowed' });
  } catch (err) {
    console.error('restock-notify error:', err.message);
    return json(500, { error: err.message });
  }
};
