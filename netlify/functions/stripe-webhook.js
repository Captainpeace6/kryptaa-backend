const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');
const { resolveLine } = require('./catalog');

/* Netlify does not inject the Blobs context on this site, so pass siteID/token
   explicitly when they are available. Falls back to the automatic context. */
function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const BASE_STOCK = {
  10:  { S: 5,  M: 10, L: 10, XL: 5  },
  11:  { S: 5,  M: 10, L: 10, XL: 5  },
  12:  { S: 5,  M: 10, L: 10, XL: 5  },
  14:  { S: 5,  M: 10, L: 10, XL: 5  },
  30:  { S: 5,  M: 10, L: 10, XL: 5  },
  31:  { S: 5,  M: 8,  L: 11, XL: 6  },
  32:  { S: 5,  M: 10, L: 10, XL: 5  },
  500: { XS: 9,  S: 12, M: 12, L: 12, XL: 0 },
  501: { XS: 9,  S: 15, M: 13, L: 11, XL: 0 },
  502: { XS: 7,  S: 12, M: 12, L: 11, XL: 0 },
  503: { XS: 12, S: 12, M: 9,  L: 7,  XL: 0 },
  // Silver Metallic Crop Set (id 90) — Top & Skirt tracked separately (Universal size)
  '90:top':   { Universal: 12 },
  '90:skirt': { Universal: 12 },
};

/* Which stock keys a cart line draws down. The Silver Set (id 90) splits into
   Top and Skirt: a Full Set (or unspecified variant) deducts BOTH pieces. */
function stockKeysFor(item) {
  if (String(item.id) === '90') {
    if (item.variant === 'top') return ['90:top'];
    if (item.variant === 'skirt') return ['90:skirt'];
    return ['90:top', '90:skirt']; // full set (or legacy items with no variant)
  }
  return [String(item.id)];
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  if (!sig) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return { statusCode: 400, body: 'Webhook Error: ' + err.message };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'Ignored' };
  }

  const session = stripeEvent.data.object;
  const cartJson = session.metadata && session.metadata.cart;

  if (!cartJson) {
    console.log('No cart metadata in session', session.id);
    return { statusCode: 200, body: 'No cart metadata — stock not updated' };
  }

  let cartItems;
  try {
    cartItems = JSON.parse(cartJson);
  } catch (e) {
    console.error('Invalid cart metadata:', cartJson);
    return { statusCode: 200, body: 'Invalid cart metadata' };
  }

  const store = blobStore('kryptaa-stock');

  let stock;
  try {
    const raw = await store.get('stock');
    stock = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(BASE_STOCK));
  } catch (e) {
    stock = JSON.parse(JSON.stringify(BASE_STOCK));
  }

  for (const item of cartItems) {
    const size = item.size;
    const qty = item.qty || 1;
    for (const id of stockKeysFor(item)) {
      if (stock[id] && stock[id][size] !== undefined) {
        stock[id][size] = Math.max(0, (stock[id][size] || 0) - qty);
      }
    }
  }

  try {
    await store.set('stock', JSON.stringify(stock));
    console.log('Stock deducted for session', session.id, JSON.stringify(cartItems));
  } catch (e) {
    console.error('Failed to save stock:', e.message);
    return { statusCode: 500, body: 'Failed to update stock' };
  }

  /* Queue a post-purchase review request — sent ~5 days later by the
     send-review-requests scheduled function. Never blocks the webhook. */
  try {
    const email = session.customer_details && session.customer_details.email;
    if (email) {
      const first = cartItems[0] || {};
      const resolved = resolveLine(first.id, first.variant);
      const q = blobStore('kryptaa-review-queue');
      await q.set(session.id, JSON.stringify({
        email,
        name: (session.customer_details && session.customer_details.name) || '',
        product: resolved ? resolved.name : 'your KRYPTAA order',
        orderedAt: session.created ? session.created * 1000 : Date.now(),
        sent: false,
      }));
    }
  } catch (e) {
    console.error('Review-queue enqueue failed:', e.message);
  }

  return { statusCode: 200, body: 'OK' };
};
