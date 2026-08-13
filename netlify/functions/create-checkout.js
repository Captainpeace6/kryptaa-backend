const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { resolveLine, COUPONS } = require('./catalog');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/* Only allow product images from our own domain (or site-relative paths).
   Everything else is dropped — the client never dictates arbitrary image URLs. */
function safeImage(img) {
  if (!img || typeof img !== 'string') return null;
  if (img.startsWith('https://www.kryptaa.com/')) return img;
  if (/^https?:\/\//i.test(img)) return null;
  return 'https://www.kryptaa.com/' + img.replace(/^\/+/, '');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const json = (code, obj) => ({
    statusCode: code,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });

  try {
    const body = JSON.parse(event.body || '{}');
    const cart = Array.isArray(body.cart) ? body.cart : [];
    if (!cart.length) return json(400, { error: 'Cart is empty' });

    /* ── Build line items from the SERVER catalog. The client-sent price/name
          are ignored entirely — only id, variant, size and qty are read. ── */
    let subtotal = 0;
    const line_items = [];
    const metaCart = [];

    for (const item of cart) {
      const resolved = resolveLine(item.id, item.variant);
      if (!resolved) {
        return json(400, { error: 'Unknown item in cart: ' + item.id + (item.variant ? '/' + item.variant : '') });
      }
      const qty = Math.min(20, Math.max(1, parseInt(item.qty, 10) || 1));
      const size = String(item.size || 'N/A').slice(0, 40);
      const img = safeImage(item.img);

      subtotal += resolved.price * qty;
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: {
            name: resolved.name + ' — Size: ' + size,
            images: img ? [img] : [],
          },
          unit_amount: Math.round(resolved.price * 100), // server price, in cents
        },
        quantity: qty,
      });
      metaCart.push({ id: item.id, variant: item.variant || undefined, size, qty });
    }

    /* ── Coupon: validate the code against the SERVER table, ignore any
          client-sent rate. Applied via a one-time Stripe coupon. ── */
    let discounts;
    let appliedCode;
    if (body.coupon) {
      const code = String(body.coupon).toUpperCase().trim();
      const c = COUPONS[code];
      if (c) {
        try {
          const coupon = await stripe.coupons.create({
            percent_off: c.percentOff,
            duration: 'once',
            max_redemptions: 1,
            name: code,
          });
          discounts = [{ coupon: coupon.id }];
          appliedCode = code;
        } catch (e) {
          console.error('Coupon create failed:', e.message); // proceed without discount
        }
      }
      // Unknown codes are silently ignored (no discount) rather than failing checkout.
    }

    const shipping_options = subtotal >= 75
      ? [{
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 0, currency: 'usd' },
            display_name: 'Free Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 7 },
              maximum: { unit: 'business_day', value: 14 },
            },
          },
        }]
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

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items,
      mode: 'payment',
      discounts,
      metadata: { cart: JSON.stringify(metaCart), coupon: appliedCode || '' },
      shipping_options,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'IN', 'AE', 'SG', 'DE', 'FR', 'NL'],
      },
      phone_number_collection: { enabled: true },
      success_url: 'https://www.kryptaa.com/checkout.html?success=true&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.kryptaa.com/checkout.html',
    });

    return json(200, { url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    return json(500, { error: err.message });
  }
};
