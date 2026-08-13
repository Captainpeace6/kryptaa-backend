const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { getStore } = require('@netlify/blobs');
const { resolveLine } = require('./catalog');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

/* Meta Conversions API — server-side Purchase, deduplicated with the client
   Pixel via a shared event_id (the Stripe session id). No-op until
   META_CAPI_TOKEN is set. Never throws. */
async function sendMetaPurchase(session, cartItems) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return; // not configured yet
  const pixel = process.env.META_PIXEL_ID || '2070231503594050';
  const cd = session.customer_details || {};
  const user_data = {};
  if (cd.email) user_data.em = [sha256(cd.email)];
  if (cd.phone) user_data.ph = [sha256(String(cd.phone).replace(/[^0-9]/g, ''))];
  if (cd.name) user_data.fn = [sha256(String(cd.name).split(' ')[0])];
  if (!Object.keys(user_data).length) return;

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: session.created || Math.floor(Date.now() / 1000),
      event_id: session.id, // must match the client Pixel eventID for dedup
      action_source: 'website',
      event_source_url: 'https://www.kryptaa.com/checkout.html',
      user_data,
      custom_data: {
        currency: (session.currency || 'usd').toUpperCase(),
        value: (session.amount_total || 0) / 100,
        content_type: 'product',
        content_ids: cartItems.map((it) => String(it.id)),
        contents: cartItems.map((it) => ({ id: String(it.id), quantity: it.qty || 1 })),
        num_items: cartItems.reduce((s, it) => s + (it.qty || 1), 0),
      },
    }],
  };

  const res = await fetch(`https://graph.facebook.com/v19.0/${pixel}/events?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('Meta CAPI error:', res.status, t.slice(0, 300));
  } else {
    console.log('Meta CAPI Purchase sent for', session.id);
  }
}

const fmt = (cents) => '$' + (Math.round(cents) / 100).toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Branded order-confirmation email to the customer (best-effort). */
async function sendOrderConfirmation(session, cartItems) {
  const email = session.customer_details && session.customer_details.email;
  if (!email || !process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return;

  const first = (session.customer_details.name || '').split(' ')[0] || 'there';
  const ref = String(session.id || '').slice(-8).toUpperCase();
  const rows = cartItems.map((it) => {
    const r = resolveLine(it.id, it.variant);
    const name = r ? r.name : ('Item ' + it.id);
    const line = r ? r.price * 100 * (it.qty || 1) : 0;
    return `<tr>
      <td style="padding:10px 0;border-bottom:1px solid rgba(210,174,91,0.14);font-size:14px;color:#f0ede8;">${esc(name)}<br><span style="font-size:12px;color:rgba(240,237,232,0.5);">Size ${esc(it.size || 'N/A')} · Qty ${it.qty || 1}</span></td>
      <td style="padding:10px 0;border-bottom:1px solid rgba(210,174,91,0.14);font-size:14px;color:#d2ae5b;text-align:right;white-space:nowrap;">${fmt(line)}</td>
    </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0c0b09;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:36px;">
    <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">KRYPTAA · Order Confirmed</p>
    <h1 style="margin:0 0 8px;font-size:24px;color:#d2ae5b;letter-spacing:0.04em;">Thank you, ${esc(first)} 🖤</h1>
    <p style="margin:0 0 22px;font-size:14px;line-height:1.7;color:rgba(240,237,232,0.82);">Your order is confirmed and moving. We'll email tracking once it ships (typically 3–5 business days).</p>
    <p style="margin:0 0 6px;font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.55);">Order</p>
    <p style="margin:0 0 20px;font-size:15px;color:#f0ede8;">#${ref}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;">${rows}
      <tr><td style="padding:14px 0 0;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(240,237,232,0.6);">Total Paid</td>
      <td style="padding:14px 0 0;font-size:17px;color:#d2ae5b;text-align:right;font-weight:700;">${fmt(session.amount_total || 0)}</td></tr>
    </table>
    <a href="https://www.kryptaa.com/track.html" style="display:inline-block;margin-top:26px;background:#d2ae5b;color:#060606;text-decoration:none;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;padding:13px 26px;">Track My Order</a>
    <p style="margin:26px 0 0;font-size:11px;line-height:1.6;color:rgba(240,237,232,0.4);">Defined By Power / Driven By Aura<br>Questions? Reply to this email or reach us on Instagram @kryptaa__</p>
  </div>
</body></html>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `KRYPTAA <${process.env.GMAIL_USER}>`,
    to: email,
    subject: `Order Confirmed — KRYPTAA #${ref}`,
    html,
  });
}

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

  /* Branded order-confirmation email to the customer (never blocks the webhook) */
  try {
    await sendOrderConfirmation(session, cartItems);
  } catch (e) {
    console.error('Order confirmation email failed:', e.message);
  }

  /* Server-side Meta Purchase (Conversions API), deduped with the client Pixel */
  try {
    await sendMetaPurchase(session, cartItems);
  } catch (e) {
    console.error('Meta CAPI send failed:', e.message);
  }

  return { statusCode: 200, body: 'OK' };
};
