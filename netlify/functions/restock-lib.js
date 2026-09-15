/* ─────────────────────────────────────────────────────────────
   KRYPTAA — Back-in-stock waitlist (shared logic)

   Store "kryptaa-restock": key `p${productId}_${sha256(email)}` →
   { email, productId, product, at, sent }.
   - restock-request.js  (public)  adds a waiter
   - restock-notify.js   (admin)   emails waiters for a product on demand
   - update-stock.js     (admin)   auto-notifies when a product's stock goes 0 → >0
   Never throws out of notifyProduct(); returns a summary instead.
   ───────────────────────────────────────────────────────────── */
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { CATALOG } = require('./catalog');

const sha256 = (v) => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

/* Product page = products/<slug>.html; slug mirrors products.js enrichProduct() */
function productUrl(id) {
  const cat = CATALOG[id];
  const slug = cat ? String(cat.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
  const page = slug ? 'products/' + slug + '.html' : '';
  return 'https://www.kryptaa.com/' + page + '?utm_source=email&utm_medium=restock&utm_campaign=back_in_stock';
}

function emailHtml(product, id) {
  return `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0c0b09;font-family:Georgia,'Times New Roman',serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:36px;">
    <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">KRYPTAA</p>
    <h1 style="margin:0 0 14px;font-size:24px;color:#d2ae5b;letter-spacing:0.06em;">It's back.</h1>
    <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:rgba(240,237,232,0.86);">You asked us to tell you the moment <strong style="color:#f0ede8;">${esc(product)}</strong> returned. It just did — and it won't sit for long.</p>
    <a href="${productUrl(id)}" style="display:inline-block;background:#d2ae5b;color:#060606;text-decoration:none;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;padding:14px 28px;">Shop it now</a>
    <p style="margin:28px 0 0;font-size:11px;line-height:1.6;color:rgba(240,237,232,0.4);">Statement without noise.<br>You're getting this because you joined the restock list on kryptaa.com. One-time note.</p>
  </div>
</body></html>`;
}

async function addWaiter({ email, productId, product }) {
  const store = blobStore('kryptaa-restock');
  const key = 'p' + String(productId) + '_' + sha256(email);
  await store.set(key, JSON.stringify({ email, productId: String(productId), product, at: Date.now(), sent: false }));
  return key;
}

/* Email every unsent waiter for productId. Returns { sent, failed, skipped }. */
async function notifyProduct(productId) {
  const summary = { productId: String(productId), sent: 0, failed: 0, skipped: 0 };
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) { summary.error = 'mail not configured'; return summary; }
  let store, listing;
  try {
    store = blobStore('kryptaa-restock');
    listing = await store.list({ prefix: 'p' + String(productId) + '_' });
  } catch (e) { summary.error = e.message; return summary; }
  const keys = (listing && listing.blobs) ? listing.blobs.map((b) => b.key) : [];
  if (!keys.length) return summary;

  const cat = CATALOG[productId];
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  for (const key of keys) {
    let rec;
    try { const raw = await store.get(key); rec = raw ? JSON.parse(raw) : null; } catch (e) { continue; }
    if (!rec || rec.sent || !rec.email) { summary.skipped++; continue; }
    const name = rec.product || (cat && cat.name) || 'your piece';
    try {
      await transporter.sendMail({
        from: `KRYPTAA <${process.env.GMAIL_USER}>`,
        to: rec.email,
        subject: `${name} is back in stock`,
        html: emailHtml(name, productId),
      });
      rec.sent = true; rec.sentAt = Date.now();
      await store.set(key, JSON.stringify(rec));
      summary.sent++;
    } catch (e) {
      console.error('restock email failed', key, e.message);
      summary.failed++;
    }
  }
  return summary;
}

/* Count of unsent waiters per product — for the dashboard. */
async function waitlistCounts() {
  const out = {};
  try {
    const store = blobStore('kryptaa-restock');
    const listing = await store.list();
    for (const b of (listing && listing.blobs) || []) {
      try {
        const rec = JSON.parse(await store.get(b.key));
        if (rec && !rec.sent) out[rec.productId] = (out[rec.productId] || 0) + 1;
      } catch (e) {}
    }
  } catch (e) {}
  return out;
}

module.exports = { addWaiter, notifyProduct, waitlistCounts, blobStore };
