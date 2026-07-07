const { getStore } = require('@netlify/blobs');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const BASE_STOCK = {
  10:  { S: 5,  M: 10, L: 10, XL: 5  },
  11:  { S: 5,  M: 10, L: 10, XL: 5  },
  12:  { S: 5,  M: 10, L: 10, XL: 5  },
  14:  { S: 5,  M: 10, L: 10, XL: 5  },
  30:  { S: 5,  M: 10, L: 10, XL: 5  },
  31:  { S: 5,  M: 8,  L: 11, XL: 6  },
  32:  { S: 5,  M: 10, L: 10, XL: 5  },
  500: { XS: 9,  S: 12, M: 12, L: 12, XL: 0 },
  501: { XS: 9,  S: 15, M: 13, L: 11, XL: 0 },
  502: { XS: 7,  S: 12, M: 12, L: 11, XL: 0 },
  503: { XS: 12, S: 12, M: 9,  L: 7,  XL: 0 },
};

const PRODUCT_NAMES = {
  10: 'Vintage Distressed Wide-Leg',
  11: 'Red Gothic Embroidery Denim',
  12: 'Acid Rust Patchwork Jeans',
  14: 'Ice Cargo Wide-Leg Denim',
  30: 'Gothic Skull Wide-Leg',
  31: 'Gold Baroque Wide-Leg',
  32: 'Creature Graphic Wide-Leg',
  500: 'Street Track Pant — Blue',
  501: 'Street Track Pant — Green',
  502: 'Street Track Pant — Red',
  503: 'Street Track Pant — Yellow',
};

const THRESHOLD = 2;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const adminKey = event.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  try {
    const store = getStore('kryptaa-stock');
    const raw = await store.get('stock');
    const stock = raw ? JSON.parse(raw) : BASE_STOCK;

    const alerts = [];
    Object.keys(stock).forEach(function (id) {
      const sizes = stock[id];
      Object.keys(sizes).forEach(function (sz) {
        const qty = sizes[sz];
        if (qty <= THRESHOLD) {
          alerts.push({
            id,
            name: PRODUCT_NAMES[parseInt(id)] || ('Product ' + id),
            size: sz,
            qty,
          });
        }
      });
    });

    alerts.sort(function (a, b) { return a.qty - b.qty; });

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alerts, threshold: THRESHOLD }),
    };
  } catch (err) {
    console.error('low-stock-alert error:', err.message);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
