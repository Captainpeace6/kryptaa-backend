/* ─────────────────────────────────────────────────────────────
   KRYPTAA — Daily business pulse (scheduled, 08:00 America/New_York ≈ 12:00 UTC)

   One email to NOTIFY_EMAIL (falls back to GMAIL_USER) summarising the
   last 24h so nobody has to open the dashboard to know things are fine:
     • Stripe: orders + revenue (yesterday / 7d / 30d)
     • GA4: sessions, product views → carts → checkouts (last 1 day + 7d)
     • Abandoned-cart recovery emails sent, back-in-stock waiters
     • Low-stock sizes (≤2) and sold-out sizes
     • Health flags: Blobs write test, GA4 configured, GSC clicks (7d)
   Reuses the existing report handlers by invoking them with the admin key
   in-process (no HTTP). Every section is best-effort — a failing source
   prints "unavailable", never blocks the email. Honest numbers only.
   ───────────────────────────────────────────────────────────── */
const nodemailer = require('nodemailer');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { blobStore, waitlistCounts } = require('./restock-lib');
const { CATALOG } = require('./catalog');

const DAY = 24 * 3600 * 1000;
const money = (c) => '$' + (Math.round(c) / 100).toFixed(2);
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Call another function's handler in-process as the admin. */
async function callAdmin(name, qs) {
  try {
    const fn = require('./' + name);
    const res = await fn.handler({ httpMethod: 'GET', headers: { 'x-admin-key': process.env.ADMIN_KEY }, queryStringParameters: qs || {} });
    return res && res.statusCode === 200 ? JSON.parse(res.body) : null;
  } catch (e) { console.error('pulse: ' + name + ' failed:', e.message); return null; }
}

async function stripeStats() {
  const now = Math.floor(Date.now() / 1000);
  const since30 = now - 30 * 86400;
  const out = { d1: { n: 0, rev: 0 }, d7: { n: 0, rev: 0 }, d30: { n: 0, rev: 0 }, recent: [] };
  try {
    const charges = await stripe.charges.list({ limit: 100, created: { gte: since30 } });
    for (const c of charges.data) {
      if (c.status !== 'succeeded' || c.refunded) continue;
      const age = now - c.created;
      out.d30.n++; out.d30.rev += c.amount;
      if (age <= 7 * 86400) { out.d7.n++; out.d7.rev += c.amount; }
      if (age <= 86400) { out.d1.n++; out.d1.rev += c.amount; out.recent.push({ name: (c.billing_details && c.billing_details.name) || 'Customer', amount: c.amount, city: c.shipping && c.shipping.address && c.shipping.address.city }); }
    }
  } catch (e) { out.error = e.message; }
  return out;
}

async function recoveryStats() {
  const out = { sent24h: 0, sent7d: 0, ok: false };
  try {
    const store = blobStore('kryptaa-cart-recovery');
    const listing = await store.list({ prefix: 'sent:' });
    const now = Date.now();
    for (const b of (listing && listing.blobs) || []) {
      const ts = Number(await store.get(b.key)) || 0;
      if (now - ts < DAY) out.sent24h++;
      if (now - ts < 7 * DAY) out.sent7d++;
    }
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

async function blobsHealth() {
  try {
    const store = blobStore('kryptaa-cart-recovery');
    await store.set('pulse:health', String(Date.now()));
    return 'OK';
  } catch (e) { return 'FAILING — ' + e.message; }
}

function stockSummary(stockRes) {
  if (!stockRes || !stockRes.alerts) return null;
  const low = stockRes.alerts.filter((a) => a.qty > 0);
  const out = stockRes.alerts.filter((a) => a.qty === 0);
  return { low, out };
}

function row(label, value, sub) {
  return `<tr><td style="padding:9px 0;border-bottom:1px solid rgba(210,174,91,0.14);font-size:13px;color:rgba(240,237,232,0.7);">${label}</td>
  <td style="padding:9px 0;border-bottom:1px solid rgba(210,174,91,0.14);font-size:14px;color:#f0ede8;text-align:right;white-space:nowrap;">${value}${sub ? `<br><span style="font-size:11px;color:rgba(240,237,232,0.45);">${sub}</span>` : ''}</td></tr>`;
}
function section(title, rows) {
  return `<p style="margin:26px 0 4px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">${title}</p><table style="width:100%;border-collapse:collapse;">${rows}</table>`;
}

exports.handler = async function () {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return { statusCode: 200, body: 'mail not configured' };
  const to = process.env.NOTIFY_EMAIL || process.env.GMAIL_USER;

  const [st, ga1, ga7, gsc, stock, rec, wait, blobs] = await Promise.all([
    stripeStats(),
    callAdmin('ga4-report', { range: '1' }),
    callAdmin('ga4-report', { range: '7' }),
    callAdmin('gsc-report'),
    callAdmin('low-stock-alert'),
    recoveryStats(),
    waitlistCounts().catch(() => ({})),
    blobsHealth(),
  ]);

  const f1 = (ga1 && ga1.funnel) || {}; const f7 = (ga7 && ga7.funnel) || {};
  const gaOk = ga1 && ga1.configured !== false;
  const stk = stockSummary(stock);
  const waitTotal = Object.values(wait || {}).reduce((s, n) => s + n, 0);
  const flags = [];
  if (blobs !== 'OK') flags.push('Netlify Blobs writes failing — stock/reviews/waitlist not persisting (' + esc(blobs) + ')');
  if (!gaOk) flags.push('GA4 not reporting');
  if (st.error) flags.push('Stripe: ' + esc(st.error));
  if (stk && stk.out.length) flags.push(stk.out.length + ' size(s) sold out — restock or the waitlist keeps growing');
  if (gaOk && (f7.begin_checkout || 0) > 0 && (f7.purchase || 0) === 0 && st.d7.n === 0) flags.push((f7.begin_checkout) + ' checkout(s) started this week, 0 purchases — check Stripe for failed payments');

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'America/New_York' });

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0c0b09;font-family:Georgia,'Times New Roman',serif;color:#f0ede8;">
  <div style="max-width:560px;margin:24px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:32px;">
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">KRYPTAA · Daily Pulse</p>
    <h1 style="margin:0 0 6px;font-size:22px;color:#d2ae5b;letter-spacing:0.05em;">${esc(dateStr)}</h1>
    <p style="margin:0;font-size:13px;color:rgba(240,237,232,0.6);">Last 24 hours, with 7-day context.</p>

    ${flags.length ? `<div style="margin:20px 0 0;padding:12px 14px;border:1px solid rgba(220,80,80,0.5);background:rgba(220,80,80,0.08);font-size:13px;line-height:1.6;color:#f0ede8;"><strong style="color:#ff9b9b;">Needs attention</strong><br>${flags.map((f) => '• ' + f).join('<br>')}</div>` : `<div style="margin:20px 0 0;padding:10px 14px;border:1px solid rgba(125,186,125,0.4);font-size:13px;color:rgba(125,186,125,0.9);">All systems healthy.</div>`}

    ${section('Sales (Stripe)', [
      row('Orders · yesterday', st.d1.n, money(st.d1.rev)),
      row('Orders · 7 days', st.d7.n, money(st.d7.rev)),
      row('Orders · 30 days', st.d30.n, money(st.d30.rev)),
      st.recent.length ? row('Latest', st.recent.map((r) => esc(r.name) + (r.city ? ' · ' + esc(r.city) : '') + ' · ' + money(r.amount)).join('<br>')) : '',
    ].join(''))}

    ${section('Traffic & funnel (GA4)', gaOk ? [
      row('Sessions · yesterday', ga1.sessions != null ? ga1.sessions : '—', (ga7.sessions != null ? ga7.sessions + ' this week' : '')),
      row('Product views', (f1.view_item || 0), (f7.view_item || 0) + ' · 7d'),
      row('Added to cart', (f1.add_to_cart || 0), (f7.add_to_cart || 0) + ' · 7d'),
      row('Checkout started', (f1.begin_checkout || 0), (f7.begin_checkout || 0) + ' · 7d'),
      row('Purchased (GA4)', (f1.purchase || 0), (f7.purchase || 0) + ' · 7d'),
      (function () { const m = ((ga7.mediums || []).find((x) => x.medium === 'meta_one')) || { sessions: 0, addToCarts: 0, purchases: 0, revenue: 0 };
        return row('Meta One links · 7d', m.sessions + ' sessions', m.addToCarts + ' carts · ' + m.purchases + ' orders' + (m.revenue ? ' · $' + m.revenue.toFixed(2) : '')); })(),
    ].join('') : row('GA4', 'unavailable'))}

    ${section('Automations', [
      row('Abandoned-cart emails sent', rec.ok ? rec.sent24h : 'unavailable', rec.ok ? rec.sent7d + ' · 7d' : ''),
      row('Back-in-stock waitlist', waitTotal + ' waiting', Object.keys(wait || {}).map((id) => (CATALOG[id] ? CATALOG[id].name : id) + ' ×' + wait[id]).join(', ')),
    ].join(''))}

    ${section('Inventory', stk ? [
      row('Sold out', stk.out.length ? stk.out.map((a) => esc(a.name) + ' ' + esc(a.size)).join('<br>') : 'none'),
      row('Low (≤2 left)', stk.low.length ? stk.low.map((a) => esc(a.name) + ' ' + esc(a.size) + ' (' + a.qty + ')').join('<br>') : 'none'),
    ].join('') : row('Stock', 'unavailable'))}

    ${section('Search (Google, ' + ((gsc && gsc.rangeDays) || 28) + 'd)', gsc && gsc.configured !== false ? [
      row('Clicks / impressions', (gsc.clicks || 0) + ' / ' + (gsc.impressions || 0), 'avg position ' + (gsc.position ? gsc.position.toFixed(1) : '—')),
      row('Top non-brand query', (() => { const q = (gsc.keywords || []).find((k) => !/kryptaa/i.test(k.query)); return q ? esc(q.query) + ' · ' + q.clicks + ' clicks' : '—'; })()),
    ].join('') : row('Search Console', 'unavailable'))}

    <p style="margin:28px 0 0;font-size:11px;line-height:1.6;color:rgba(240,237,232,0.4);">Blobs ${esc(blobs)} · Open the <a href="https://www.kryptaa.com/orders.html" style="color:#d2ae5b;">dashboard</a> for detail.</p>
  </div></body></html>`;

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await transporter.sendMail({
    from: `KRYPTAA Pulse <${process.env.GMAIL_USER}>`,
    to,
    subject: `Pulse · ${st.d1.n} order${st.d1.n === 1 ? '' : 's'} yesterday · ${gaOk && ga1.sessions != null ? ga1.sessions + ' sessions' : 'GA4 n/a'}${flags.length ? ' · ⚠ ' + flags.length + ' flag' + (flags.length > 1 ? 's' : '') : ''}`,
    html,
  });
  console.log('pulse sent to', to, 'flags:', flags.length);
  return { statusCode: 200, body: 'sent' };
};

/* Scheduled via netlify.toml [functions."daily-pulse"] schedule = "0 12 * * *" (08:00 ET). */
