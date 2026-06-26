const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return {
      statusCode: 401,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'Unauthorized' }),
    };
  }

  try {
    const sessions = await stripe.checkout.sessions.list({ limit: 100 });
    const paid = sessions.data.filter((s) => s.payment_status === 'paid');

    const orders = await Promise.all(
      paid.map(async (session) => {
        let items = [];
        try {
          const resp = await stripe.checkout.sessions.listLineItems(session.id, {
            limit: 100,
            expand: ['data.price.product'],
          });
          items = resp.data.map((item) => ({
            name: item.description,
            qty: item.quantity,
            total: (item.amount_total / 100).toFixed(2),
            image:
              item.price &&
              item.price.product &&
              item.price.product.images &&
              item.price.product.images[0]
                ? item.price.product.images[0]
                : null,
          }));
        } catch (e) {
          console.error('Line items error for', session.id, e.message);
        }

        const customer = session.customer_details || {};
        const shipping = session.shipping_details || {};
        const addr = shipping.address || {};
        const addressLine = [
          addr.line1, addr.line2, addr.city, addr.state, addr.postal_code, addr.country,
        ]
          .filter(Boolean)
          .join(', ');

        return {
          id: session.id,
          paymentId: session.payment_intent || session.id,
          created: session.created,
          total: (session.amount_total / 100).toFixed(2),
          customer: {
            name: customer.name || '—',
            email: customer.email || '—',
            phone: customer.phone || '—',
          },
          shippingName: (shipping.name) || (customer.name) || '—',
          shippingAddress: addressLine || '—',
          items,
        };
      })
    );

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders }),
    };
  } catch (err) {
    console.error('Get orders error:', err.message);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
