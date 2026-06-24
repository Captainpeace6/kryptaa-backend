const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { cart } = JSON.parse(event.body);

    const line_items = cart.map(function(item) {
      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: item.name + ' (Size: ' + (item.size || 'N/A') + ')',
          },
          unit_amount: Math.round((item.price || 0) * 100),
        },
        quantity: item.qty || 1,
      };
    });

    const subtotal = cart.reduce(function(s, i) { return s + (i.price || 0) * (i.qty || 1); }, 0);
    if (subtotal < 75) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Shipping' },
          unit_amount: 999,
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: line_items,
      mode: 'payment',
      success_url: 'https://www.kryptaa.com/checkout.html?success=true',
      cancel_url: 'https://www.kryptaa.com/checkout.html',
      shipping_address_collection: { allowed_countries: ['US', 'CA', 'GB', 'AU', 'IN'] },
      phone_number_collection: { enabled: true },
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
