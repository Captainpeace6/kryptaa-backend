const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

  let email;
  try {
    const body = JSON.parse(event.body || '{}');
    email = (body.email || '').trim().toLowerCase();
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Valid email required' }) };
  }

  try {
    /* Search Stripe sessions by customer email */
    const sessions = await stripe.checkout.sessions.list({
      limit: 100,
      customer_details: { email },
    });

    const paid = sessions.data.filter((s) => s.payment_status === 'paid');

    if (!paid.length) {
      return {
        statusCode: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ orders: [] }),
      };
    }

    const orders = await Promise.all(
      paid.map(async (session, idx) => {
        let items = [];
        try {
          const resp = await stripe.checkout.sessions.listLineItems(session.id, { limit: 50 });
          items = resp.data
            .filter((i) => !/^shipping$/i.test(i.description || ''))
            .map((i) => ({
              name: i.description,
              qty: i.quantity,
              total: (i.amount_total / 100).toFixed(2),
            }));
        } catch (e) {}

        const addr = (session.shipping_details && session.shipping_details.address) || {};
        const addressLine = [addr.line1, addr.city, addr.state, addr.postal_code, addr.country]
          .filter(Boolean)
          .join(', ');

        return {
          orderNum: paid.length - idx,
          created: session.created,
          total: (session.amount_total / 100).toFixed(2),
          items,
          shippingAddress: addressLine || '—',
          paymentId: session.payment_intent || session.id,
        };
      })
    );

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders }),
    };
  } catch (err) {
    console.error('track-order error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Could not retrieve orders. Try again later.' }),
    };
  }
};
