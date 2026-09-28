/* Scheduled (netlify.toml: 13:00 UTC = 09:00 America/New_York): one recovery email per
   cart abandoned in the last 3 days that carries an email address. The core in
   recover-carts.js does the eligibility work — one email per session ever, never to a
   buyer, never to an internal test session.

   Kept narrow on purpose: a daily sweep of a 3-day window catches every expired session
   (they expire 1h after creation) without ever reaching back to someone who walked away
   weeks ago. Sends through Gmail directly, so it does not depend on MAIL_SECRET. */
const { run } = require('./recover-carts');

exports.handler = async function (event) {
  /* Scheduled invocations carry no admin key; a direct HTTP call must. */
  const headers = event && event.headers ? event.headers : {};
  const isHttp = !!(event && event.httpMethod);
  if (isHttp && headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const out = await run({ days: 3, send: true });
  console.log('recover-carts-daily:', JSON.stringify({ sent: out.sentCount, failed: out.failedCount, error: out.error }));
  return { statusCode: 200, body: JSON.stringify(out) };
};
