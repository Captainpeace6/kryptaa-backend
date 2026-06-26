const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const nodemailer = require('nodemailer');

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sig = event.headers['stripe-signature'];
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'OK' };
  }

  const session = stripeEvent.data.object;

  // Fetch the actual line items (product names + sizes)
  let lineItems = [];
  try {
    const resp = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
    lineItems = resp.data;
  } catch (err) {
    console.error('Could not fetch line items:', err.message);
  }

  const customer = session.customer_details || {};
  const shipping = session.shipping_details || {};
  const addr = shipping.address || {};
  const total = ((session.amount_total || 0) / 100).toFixed(2);
  const paymentId = session.payment_intent || session.id;

  const itemRows = lineItems.length
    ? lineItems.map((item) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #1a1a1a;">${item.description}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1a1a1a;text-align:center;">${item.quantity}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #1a1a1a;text-align:right;">$${(item.amount_total / 100).toFixed(2)}</td>
        </tr>`).join('')
    : `<tr><td colspan="3" style="padding:8px 12px;">No item details available</td></tr>`;

  const addressLine = [addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country]
    .filter(Boolean).join(', ');

  const html = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0c0b09;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#f0ede8;">
  <div style="max-width:560px;margin:32px auto;background:#111009;border:1px solid rgba(210,174,91,0.25);padding:32px;">
    <div style="border-bottom:1px solid rgba(210,174,91,0.2);padding-bottom:20px;margin-bottom:24px;">
      <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(210,174,91,0.65);">KRYPTAA · New Order</p>
      <h1 style="margin:0;font-size:22px;color:#d2ae5b;">$${total} received</h1>
    </div>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
      <tr>
        <td style="width:50%;vertical-align:top;padding-right:16px;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.5);">Customer</p>
          <p style="margin:0;font-size:14px;color:#f0ede8;">${customer.name || '—'}</p>
          <p style="margin:2px 0 0;font-size:13px;color:rgba(240,237,232,0.6);">${customer.email || '—'}</p>
          <p style="margin:2px 0 0;font-size:13px;color:rgba(240,237,232,0.6);">${customer.phone || '—'}</p>
        </td>
        <td style="width:50%;vertical-align:top;">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.5);">Ship to</p>
          <p style="margin:0;font-size:13px;color:rgba(240,237,232,0.75);line-height:1.5;">${addressLine || '—'}</p>
        </td>
      </tr>
    </table>

    <table style="width:100%;border-collapse:collapse;margin-bottom:24px;background:#0d0c0a;border:1px solid rgba(210,174,91,0.12);">
      <thead>
        <tr style="background:rgba(210,174,91,0.06);">
          <th style="padding:10px 12px;text-align:left;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(210,174,91,0.55);font-weight:400;">Item</th>
          <th style="padding:10px 12px;text-align:center;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(210,174,91,0.55);font-weight:400;">Qty</th>
          <th style="padding:10px 12px;text-align:right;font-size:10px;letter-spacing:0.15em;text-transform:uppercase;color:rgba(210,174,91,0.55);font-weight:400;">Total</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr style="background:rgba(210,174,91,0.04);">
          <td colspan="2" style="padding:10px 12px;font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:rgba(240,237,232,0.5);">Order Total</td>
          <td style="padding:10px 12px;text-align:right;font-size:16px;color:#d2ae5b;font-weight:700;">$${total}</td>
        </tr>
      </tfoot>
    </table>

    <p style="margin:0 0 4px;font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:rgba(210,174,91,0.4);">Payment Reference</p>
    <p style="margin:0;font-size:11px;color:rgba(240,237,232,0.35);word-break:break-all;">${paymentId}</p>

    <div style="margin-top:28px;padding-top:20px;border-top:1px solid rgba(210,174,91,0.12);">
      <a href="https://dashboard.stripe.com/payments" style="display:inline-block;background:#d2ae5b;color:#070604;font-size:11px;letter-spacing:0.15em;text-transform:uppercase;padding:10px 20px;text-decoration:none;font-weight:700;">View in Stripe →</a>
    </div>
  </div>
</body>
</html>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  try {
    await transporter.sendMail({
      from: `KRYPTAA Orders <${process.env.GMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || 'kryptaa.official@gmail.com',
      subject: `New Order $${total} — ${customer.name || 'Customer'} — ${new Date().toLocaleDateString('en-IN')}`,
      html,
    });
    console.log('Order notification sent for session', session.id);
  } catch (err) {
    console.error('Email send error:', err.message);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
