/* ─────────────────────────────────────────────────────────────
   KRYPTAA — Authoritative price catalog (server-side source of truth)

   The browser is NOT trusted for prices. create-checkout looks up every
   line item here by id (and variant), so the amount Stripe charges is
   always the real catalog price regardless of what the client sends.

   KEEP IN SYNC with the frontend kryptaa-v2/products.js. When a price
   changes there, mirror it here (ids + prices only — names are for the
   Stripe line-item label). Anime pieces (108–116) are contact-to-order
   and never checked out on-site, but are included for completeness.
   ───────────────────────────────────────────────────────────── */

const CATALOG = {
  1:   { name: "Medusa Serpent Oversized Tee", price: 39 },
  3:   { name: "Angel of Death Heavyweight Tee", price: 39 },
  4:   { name: "Broken Skull Heavyweight Tee", price: 39 },
  5:   { name: "Need Some Money Oversized Tee", price: 39 },
  10:  { name: "Vintage Distressed Wide-Leg", price: 67 },
  11:  { name: "Red Gothic Embroidery Denim", price: 67 },
  12:  { name: "Acid Rust Patchwork Jeans", price: 63 },
  14:  { name: "Ice Cargo Wide-Leg Denim", price: 63 },
  30:  { name: "Gothic Skull Wide-Leg", price: 51 },
  31:  { name: "Gold Baroque Wide-Leg", price: 62 },
  32:  { name: "Creature Graphic Wide-Leg", price: 62 },
  70:  { name: "Rhinestone Mesh Hooded Crop", price: 41 },
  80:  { name: "Holographic Sequin Bra Top", price: 21 },
  90:  {
    name: "Silver Metallic Crop Set", price: 27,
    variants: {
      set:   { name: "Silver Metallic Crop Set", price: 27 },
      top:   { name: "Silver Metallic Crop Top", price: 14 },
      skirt: { name: "Silver Metallic Mini Chainmail Skirt", price: 14 },
    },
  },
  108: { name: "Six Eyes Gojo Satoru Denim", price: 69 },
  109: { name: "Cursed Energy JJK Collage", price: 59 },
  110: { name: "Cursed Energy JJK Vol. 2", price: 65 },
  111: { name: "Demon Back Baki Denim", price: 70 },
  112: { name: "Shinigami Death Note Denim", price: 67 },
  113: { name: "Straw Hat One Piece Jeans", price: 77 },
  114: { name: "Horror Anime Black Denim", price: 64 },
  115: { name: "Six Eyes Gojo Vol. 2", price: 69 },
  116: { name: "Black Red Anime Denim", price: 65 },
  500: { name: "Unisex Street Track Pant — Blue", price: 42 },
  501: { name: "Unisex Street Track Pant — Green", price: 42 },
  502: { name: "Unisex Street Track Pant — Red", price: 42 },
  503: { name: "Unisex Street Track Pant — Yellow", price: 42 },
};

/* Server-side coupon table — the client only sends the code, never the rate. */
const COUPONS = {
  KRYPTAA10: { percentOff: 10 },
};

/* Resolve a cart line to its authoritative { name, price }.
   Returns null if the id (or claimed variant) is unknown. */
function resolveLine(id, variantKey) {
  const product = CATALOG[id];
  if (!product) return null;
  if (variantKey) {
    const v = product.variants && product.variants[variantKey];
    if (!v) return null;
    return { name: v.name, price: v.price };
  }
  return { name: product.name, price: product.price };
}

module.exports = { CATALOG, COUPONS, resolveLine };
