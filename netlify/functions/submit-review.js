const nodemailer = require('nodemailer');
const { getStore } = require('@netlify/blobs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch (err) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON' }),
    };
  }

  const product = String(data.product || '').slice(0, 120).trim();
  const name = String(data.name || '').slice(0, 80).trim();
  const size = String(data.size || '').slice(0, 40).trim();
  const rating = Math.min(5, Math.max(1, parseInt(data.rating, 10) || 5));
  const review = String(data.review || '').slice(0, 4000).trim();
  let photos = Array.isArray(data.photos) ? data.photos.slice(0, 3) : [];
  photos = photos.filter(
    (p) => typeof p === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(p) && p.length < 2000000
  );

  if (!product || !name || !review) {
    return {
      statusCode: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing required fields' }),
    };
  }

  const record = {
    product,
    name,
    size,
    rating,
    review,
    photoCount: photos.length,
    date: new Date().toISOString(),
    status: 'pending',
  };

  let stored = false;
  let blobErr = null;
  try {
    const store = getStore('kryptaa-reviews');
    const key = Date.now() + '-' + product.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    await store.set(key, JSON.stringify({ ...record, photos }));
    stored = true;
  } catch (err) {
    blobErr = err.message;
    console.error('Review blob write error:', err.message);
  }

  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  const attachments = photos.map((p, i) => {
    const m = p.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    return {
      filename: 'review-photo-' + (i + 1) + '.' + m[1].split('/')[1],
      content: Buffer.from(m[2], 'base64'),
      contentType: m[1],
    };
  });

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0c0b09;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:32px;">
    <div style="border-bottom:1px solid rgba(210,174,91,0.2);padding-bottom:20px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(210,174,91,0.65);">KRYPTAA · New Review</p>
      <h1 style="margin:0;font-size:22px;color:#d2ae5b;">${stars}</h1>
    </div>
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.5);">Product</p>
    <p style="margin:0 0 18px;font-size:15px;color:#f0ede8;">${esc(product)}</p>
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.5);">Customer</p>
    <p style="margin:0 0 18px;font-size:14px;color:rgba(240,237,232,0.8);">${esc(name)}${size ? ' · Size ' + esc(size) : ''}</p>
    <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.5);">Review</p>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.7;color:rgba(240,237,232,0.85);white-space:pre-wrap;">${esc(review)}</p>
    ${photos.length ? `<p style="margin:0;font-size:12px;color:rgba(210,174,91,0.6);">${photos.length} photo${photos.length > 1 ? 's' : ''} attached</p>` : ''}
  </div>
</body>
</html>`;

  let mailed = false;
  let mailErr = null;
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });
    await transporter.sendMail({
      from: `KRYPTAA Reviews <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || 'kryptaa.official@gmail.com',
      subject: `New Review ${stars} — ${product} — ${name}`,
      html,
      attachments,
    });
    mailed = true;
  } catch (err) {
    mailErr = err.message;
    console.error('Review email error:', err.message);
  }

  if (!stored && !mailed) {
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Could not save review',
        blobErr,
        mailErr,
        hasUser: !!process.env.GMAIL_USER,
        hasPass: !!process.env.GMAIL_APP_PASSWORD,
        envKeys: Object.keys(process.env).filter((k) =>
          /SITE|NETLIFY|BLOB|DEPLOY|URL/i.test(k)
        ),
        siteIdPresent: !!(process.env.SITE_ID || process.env.NETLIFY_SITE_ID),
      }),
    };
  }

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
};
