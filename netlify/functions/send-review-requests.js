/* ─────────────────────────────────────────────────────────────
   KRYPTAA — Post-purchase review requests (scheduled, daily)

   The stripe-webhook enqueues {email, name, product, orderedAt, sent}
   into the Netlify Blobs store "kryptaa-review-queue" keyed by session id.
   This function runs once a day, finds orders that are >= REVIEW_DELAY_DAYS
   old and not yet emailed, sends a branded "leave a review" email from the
   KRYPTAA Gmail, and marks the record sent. Failures never throw — a bad
   record is skipped and retried next run.
   ───────────────────────────────────────────────────────────── */

const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');

const REVIEW_DELAY_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function emailHtml(name, product) {
  const hi = name ? esc(name.split(' ')[0]) : 'there';
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0c0b09;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:36px;">
    <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;text-transform:uppercase;color:rgba(210,174,91,0.7);">KRYPTAA</p>
    <h1 style="margin:0 0 20px;font-size:22px;color:#d2ae5b;letter-spacing:0.04em;">How's your fit, ${hi}?</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:rgba(240,237,232,0.86);">
      Hope you're loving your <strong style="color:#f0ede8;">${esc(product)}</strong>. Your words help the underground find us — would you drop a quick review? Photos welcome, and always appreciated. 🖤
    </p>
    <p style="margin:0 0 28px;font-size:15px;line-height:1.7;color:rgba(240,237,232,0.86);">
      It takes 30 seconds and means the world to a small brand like ours.
    </p>
    <a href="https://www.kryptaa.com/reviews.html" style="display:inline-block;background:#d2ae5b;color:#060606;text-decoration:none;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;padding:14px 28px;">Write a Review</a>
    <p style="margin:28px 0 0;font-size:11px;line-height:1.6;color:rgba(240,237,232,0.4);">
      Defined By Power / Driven By Aura<br>
      If you'd rather not hear from us, just ignore this email — it's a one-time note.
    </p>
  </div>
</body>
</html>`;
}

exports.handler = async function () {
  const now = Date.now();
  const cutoff = now - REVIEW_DELAY_DAYS * DAY_MS;

  let store;
  try {
    store = blobStore('kryptaa-review-queue');
  } catch (e) {
    console.error('review-queue store unavailable:', e.message);
    return { statusCode: 200, body: 'store unavailable' };
  }

  let listing;
  try {
    listing = await store.list();
  } catch (e) {
    console.error('review-queue list failed:', e.message);
    return { statusCode: 200, body: 'list failed' };
  }
  const keys = (listing && listing.blobs) ? listing.blobs.map((b) => b.key) : [];
  if (!keys.length) return { statusCode: 200, body: 'nothing queued' };

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });

  let sent = 0, pending = 0, purged = 0;

  for (const key of keys) {
    let rec;
    try {
      const raw = await store.get(key);
      rec = raw ? JSON.parse(raw) : null;
    } catch (e) { continue; }
    if (!rec || rec.sent) { continue; }

    // Purge very old unsent records (>60d) so the queue can't grow forever
    if (rec.orderedAt && rec.orderedAt < now - 60 * DAY_MS) {
      try { await store.delete(key); purged++; } catch (e) {}
      continue;
    }

    if (!rec.orderedAt || rec.orderedAt > cutoff) { pending++; continue; } // not old enough yet
    if (!rec.email) { continue; }

    try {
      await transporter.sendMail({
        from: `KRYPTAA <${process.env.GMAIL_USER}>`,
        to: rec.email,
        subject: 'How’s your KRYPTAA fit? ✨',
        html: emailHtml(rec.name, rec.product),
      });
      rec.sent = true;
      rec.sentAt = now;
      await store.set(key, JSON.stringify(rec));
      sent++;
    } catch (e) {
      console.error('review email send failed for', key, e.message); // retried next run
    }
  }

  const summary = `review-requests: sent=${sent} pending=${pending} purged=${purged}`;
  console.log(summary);
  return { statusCode: 200, body: summary };
};

/* Scheduled once a day via netlify.toml [functions."send-review-requests"]. */
