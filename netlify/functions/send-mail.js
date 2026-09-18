/* Internal mail relay for the Cloudflare Worker (Workers can't reach Gmail SMTP).
   POST { to, subject, html, from?, attachments?: [{ filename, contentType, contentBase64 }] }
   Header X-Mail-Secret must equal MAIL_SECRET. Low volume by design (order emails,
   owner alerts, restock + review-request notices) so it stays well inside free credits. */
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const secret = event.headers['x-mail-secret'];
  if (!secret || !process.env.MAIL_SECRET || secret !== process.env.MAIL_SECRET) return { statusCode: 401, body: 'Unauthorized' };
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return { statusCode: 500, body: 'mail not configured' };

  let body; try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, body: 'Invalid JSON' }; }
  const { to, subject, html, from, attachments } = body;
  if (!to || !subject || !html) return { statusCode: 400, body: 'to, subject, html required' };

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  try {
    await transporter.sendMail({
      from: `${String(from || 'KRYPTAA').replace(/[<>\r\n]/g, '').slice(0, 60)} <${process.env.GMAIL_USER}>`,
      to: String(to).slice(0, 200), subject: String(subject).slice(0, 200), html: String(html).slice(0, 200000),
      attachments: Array.isArray(attachments) ? attachments.slice(0, 3).map((a) => ({ filename: String(a.filename || 'file').slice(0, 80), content: Buffer.from(String(a.contentBase64 || ''), 'base64'), contentType: String(a.contentType || 'application/octet-stream') })) : undefined,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('send-mail error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
