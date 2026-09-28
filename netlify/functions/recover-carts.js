/* Admin: find abandoned Stripe checkouts and (on request) email those shoppers once.
   The live webhook already does this the moment a session expires — this endpoint is for
   carts abandoned while the backend was down (Sep 17–27 credit outage), which nobody emailed.

   GET  /recover-carts?days=45   → the list, with why each one is or isn't eligible
   POST /recover-carts {"send":true, "ids":["cs_live_…"]}  → send (ids optional = all eligible)

   Rules: one email per session ever (Blobs 'kryptaa-cart-recovery' sent:<id>), never to
   someone who completed a purchase in the range, never without an email address. */
const stripeLib = require('stripe');
const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');
const { resolveLine } = require('./catalog');

const RECOVERY_CODE = 'KRYPTAA12';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (statusCode, obj) => ({ statusCode, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function blobStore(name) {
  const siteID = process.env.NETLIFY_API_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

function itemsOf(session) {
  try { return JSON.parse((session.metadata && session.metadata.cart) || '[]'); } catch (e) { return []; }
}
function itemLines(items) {
  return items.map((it) => {
    const r = resolveLine ? resolveLine(it.id, it.variant) : null;
    return { name: r ? r.name : 'Item ' + it.id, size: it.size || 'N/A', qty: it.qty || 1 };
  });
}

function recoveryHtml(first, lines, url) {
  const rows = lines.map((l) => `<li style="margin:0 0 6px;font-size:14px;color:#f0ede8;">${esc(l.name)} <span style="color:rgba(240,237,232,0.5);">· Size ${esc(l.size)} · Qty ${l.qty}</span></li>`).join('');
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0c0b09;font-family:Georgia,'Times New Roman',serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:36px;">
    <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">KRYPTAA</p>
    <h1 style="margin:0 0 14px;font-size:24px;color:#d2ae5b;letter-spacing:0.06em;">Still yours, ${esc(first)}.</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.7;color:rgba(240,237,232,0.86);">You started an order with us and it never went through — our checkout was down for a few days, and that may well have been why. Sorry about that. It's fixed.</p>
    ${rows ? `<ul style="margin:0 0 22px;padding-left:18px;">${rows}</ul>` : ''}
    <p style="margin:0 0 22px;font-size:15px;line-height:1.7;color:rgba(240,237,232,0.86);">Use <strong style="color:#d2ae5b;letter-spacing:0.12em;">${RECOVERY_CODE}</strong> at checkout for <strong>12% off</strong> — limited drops don't restock.</p>
    <a href="${url}" style="display:inline-block;background:#d2ae5b;color:#060606;text-decoration:none;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;padding:14px 28px;">Finish my order</a>
    <p style="margin:28px 0 0;font-size:11px;line-height:1.6;color:rgba(240,237,232,0.4);">Statement without noise.<br>One-time note — we won't email you about this cart again.</p>
  </div></body></html>`;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) return json(401, { error: 'Unauthorized' });
  if (!process.env.STRIPE_SECRET_KEY) return json(500, { error: 'Stripe not configured' });

  const stripe = stripeLib(process.env.STRIPE_SECRET_KEY);
  const qs = event.queryStringParameters || {};
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const days = Math.min(120, Math.max(1, parseInt(qs.days || body.days || '45', 10) || 45));
  const doSend = event.httpMethod === 'POST' && body.send === true;
  const onlyIds = Array.isArray(body.ids) && body.ids.length ? new Set(body.ids) : null;
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  /* Every checkout session in the window */
  const sessions = [];
  for await (const s of stripe.checkout.sessions.list({ created: { gte: since }, limit: 100 })) sessions.push(s);

  const buyerEmails = new Set();
  for (const s of sessions) {
    if (s.payment_status === 'paid') {
      const e = (s.customer_details && s.customer_details.email) || s.customer_email;
      if (e) buyerEmails.add(e.toLowerCase());
    }
  }

  const store = blobStore('kryptaa-cart-recovery');
  const alreadySent = async (id) => { try { return !!(await store.get('sent:' + id)); } catch (e) { return false; } };

  /* Newest first, one candidate per email */
  const seenEmail = new Set();
  const rows = [];
  for (const s of sessions.sort((a, b) => b.created - a.created)) {
    if (s.payment_status === 'paid') continue;
    const email = ((s.customer_details && s.customer_details.email) || s.customer_email || '').toLowerCase();
    const items = itemLines(itemsOf(s));
    const url = (s.after_expiration && s.after_expiration.recovery && s.after_expiration.recovery.url) || (s.status === 'open' ? s.url : null);
    const row = {
      id: s.id,
      created: new Date(s.created * 1000).toISOString().slice(0, 16).replace('T', ' '),
      email: email || null,
      name: (s.customer_details && s.customer_details.name) || null,
      amount: s.amount_total != null ? (s.amount_total / 100).toFixed(2) : null,
      status: s.status,
      items,
      hasRecoveryUrl: !!url,
    };
    if (!email) { row.skip = 'no email captured'; rows.push(row); continue; }
    if (buyerEmails.has(email)) { row.skip = 'this person completed an order'; rows.push(row); continue; }
    if (seenEmail.has(email)) { row.skip = 'newer abandoned cart for the same email'; rows.push(row); continue; }
    if (await alreadySent(s.id)) { row.skip = 'already emailed'; rows.push(row); continue; }
    seenEmail.add(email);
    row.eligible = true;
    row.sendUrl = url || 'https://www.kryptaa.com/checkout.html';
    row.urlKind = url ? 'stripe recovery link (cart restored)' : 'site checkout (cart not restored)';
    rows.push(row);
  }

  const eligible = rows.filter((r) => r.eligible && (!onlyIds || onlyIds.has(r.id)));
  if (!doSend) {
    return json(200, { scannedDays: days, sessions: sessions.length, eligible: eligible.length, rows });
  }

  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return json(500, { error: 'mail not configured' });
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });

  /* Make sure the code in the email actually exists in Stripe */
  try {
    const existing = await stripe.promotionCodes.list({ code: RECOVERY_CODE, limit: 1 });
    if (!existing.data.length) {
      const coupon = await stripe.coupons.create({ percent_off: 12, duration: 'forever', name: RECOVERY_CODE + ' (recovery)' });
      await stripe.promotionCodes.create({ coupon: coupon.id, code: RECOVERY_CODE });
    }
  } catch (e) { console.error('ensurePromotionCode:', e.message); }

  const sent = [], failed = [];
  for (const r of eligible) {
    const first = (r.name || '').split(' ')[0] || 'there';
    try {
      await transporter.sendMail({
        from: `KRYPTAA <${process.env.GMAIL_USER}>`,
        to: r.email,
        subject: 'Your KRYPTAA order never went through — 12% off to finish it',
        html: recoveryHtml(first, r.items, r.sendUrl),
      });
      try { await store.set('sent:' + r.id, String(Date.now())); } catch (e) {}
      sent.push({ id: r.id, email: r.email });
    } catch (e) {
      failed.push({ id: r.id, email: r.email, error: e.message });
    }
  }
  return json(200, { sentCount: sent.length, sent, failedCount: failed.length, failed });
};
