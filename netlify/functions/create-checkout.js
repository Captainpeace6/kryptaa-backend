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
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { cart } = JSON.parse(event.body);

    const subtotal = cart.reduce(function (s, i) {
      return s + (i.price || 0) * (i.qty || 1);
    }, 0);

    const line_items = cart.map(function (item) {
      const imgUrl = item.img
        ? (item.img.startsWith('http') ? item.img : 'https://www.kryptaa.com/' + item.img.replace(/^\//, ''))
        : null;
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name + ' — Size: ' + (item.size || 'N/A'),
            description: item.collection || undefined,
            images: imgUrl ? [imgUrl] : [],
          },
          unit_amount: Math.round((item.price || 0) * 100),
        },
        quantity: item.qty || 1,
      };
    });

    // Shipping options — Stripe handles display + delivery estimate
    const shipping_options = subtotal >= 75
      ? [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 0, currency: 'usd' },
              display_name: 'Free Shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 7 },
                maximum: { unit: 'business_day', value: 14 },
              },
            },
          },
        ]
      : [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 999, currency: 'usd' },
              display_name: 'Standard Shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 7 },
                maximum: { unit: 'business_day', value: 14 },
              },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: 2499, currency: 'usd' },
              display_name: 'Express Shipping',
              delivery_estimate: {
                minimum: { unit: 'business_day', value: 3 },
                maximum: { unit: 'business_day', value: 5 },
              },
            },
          },
        ];

    const cartMeta = JSON.stringify(
      cart.map(function (i) { return { id: i.id, size: i.size, qty: i.qty || 1 }; })
    );

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      metadata: { cart: cartMeta },
      shipping_options,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'IN', 'AE', 'SG', 'DE', 'FR', 'NL'],
      },
      phone_number_collection: { enabled: true },
      success_url: 'https://www.kryptaa.com/checkout.html?success=true',
      cancel_url: 'https://www.kryptaa.com/checkout.html',
    });

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    console.error('Checkout error:', err.message);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
