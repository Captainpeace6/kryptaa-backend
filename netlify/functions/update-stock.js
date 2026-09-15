const { notifyProduct } = require('./restock-lib');
const { getStore } = require('@netlify/blobs');

/* Netlify does not inject the Blobs context on this site, so pass siteID/token
   explicitly when they are available. Falls back to the automatic context. */
function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    const { stock } = JSON.parse(event.body);
    if (!stock || typeof stock !== 'object') {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: 'Invalid stock data' }),
      };
    }

    const cleaned = {};
    Object.keys(stock).forEach(function (id) {
      if (id === '_savedAt') return;
      cleaned[id] = stock[id];
    });

    const store = blobStore('kryptaa-stock');

    /* Snapshot previous stock so we can detect products coming back (0 → >0) */
    let previous = {};
    try { const raw = await store.get('stock'); previous = raw ? JSON.parse(raw) : {}; } catch (e) {}

    await store.set('stock', JSON.stringify(cleaned));

    /* Back-in-stock: for any product that was fully sold out and now has
       units, email its waitlist. Never fails the save. */
    const total = (o) => o && typeof o === 'object' ? Object.values(o).reduce((s, n) => s + (Number(n) || 0), 0) : 0;
    const restocked = [];
    for (const id of Object.keys(cleaned)) {
      const base = String(id).split(':')[0]; // "90:top" → "90"
      if (total(previous[id]) === 0 && total(cleaned[id]) > 0 && !restocked.includes(base)) restocked.push(base);
    }
    const notified = [];
    for (const id of restocked) {
      try { notified.push(await notifyProduct(id)); } catch (e) { console.error('restock notify failed', id, e.message); }
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, restocked, notified }),
    };
  } catch (err) {
    console.error('update-stock error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
