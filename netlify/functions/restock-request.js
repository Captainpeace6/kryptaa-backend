/* Public: shopper joins the back-in-stock waitlist for a product.
   POST { email, id, product }  →  { ok: true }
   Called by motion.js alongside the Mailchimp signup (fire-and-forget). */
const { addWaiter } = require('./restock-lib');
const { CATALOG } = require('./catalog');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (code, obj) => ({ statusCode: code, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  try {
    const body = JSON.parse(event.body || '{}');
    const email = String(body.email || '').trim().toLowerCase();
    const id = String(body.id || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return json(400, { error: 'Invalid email' });
    if (!CATALOG[id]) return json(400, { error: 'Unknown product' });
    const product = String(body.product || CATALOG[id].name).slice(0, 120);
    await addWaiter({ email, productId: id, product });
    return json(200, { ok: true });
  } catch (err) {
    console.error('restock-request error:', err.message);
    return json(500, { error: 'Failed' });
  }
};
