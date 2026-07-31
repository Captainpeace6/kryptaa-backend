const { getStore } = require('@netlify/blobs');

/* Netlify does not inject the Blobs context on this site, so pass siteID/token
   explicitly when they are available. Falls back to the automatic context. */
function blobStore(name) {
  const siteID = process.env.SITE_ID || process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  // Silver Metallic Crop Set (id 90) — Top & Skirt tracked separately (Universal size)
  '90:top':   { Universal: 12 },
  '90:skirt': { Universal: 12 },
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  try {
    const store = blobStore('kryptaa-stock');
    const raw = await store.get('stock');
    const stock = raw ? JSON.parse(raw) : BASE_STOCK;
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock }),
    };
  } catch (err) {
    console.error('get-stock error:', err.message);
    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stock: BASE_STOCK }),
    };
  }
};
