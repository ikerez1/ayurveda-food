const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Auto-detect the Supabase env vars, whatever they happen to be called.
function pickEnv(patterns) {
  for (const p of patterns) {
    for (const name of Object.keys(process.env)) {
      if (p.test(name) && process.env[name]) return { name, value: process.env[name] };
    }
  }
  return null;
}

const urlVar = pickEnv([/^SUP.?BASE.*URL$/i, /SUP.?BASE.*URL/i]);
const keyVar = pickEnv([
  /^SUP.?BASE.*ANON.*KEY$/i,
  /^SUP.?BASE.*SERVICE.*KEY$/i,
  /SUP.?BASE.*KEY/i
]);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  if (!urlVar || !keyVar || !process.env.STRIPE_SECRET_KEY) {
    console.error('MISSING CONFIG. Supabase-ish names present:',
      Object.keys(process.env).filter(n => /SUP|STRIPE/i.test(n)));
    return json(500, { error: 'server_misconfigured' });
  }
  console.log('using env vars:', urlVar.name, '/', keyVar.name);

  const SUPABASE_URL = urlVar.value.replace(/\/+$/, '');
  const SUPABASE_KEY = keyVar.value;

  try {
    // 1. Authenticate the caller — never trust an email sent from the browser.
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json(401, { error: 'not_authenticated' });

    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_KEY }
    });
    if (!uRes.ok) {
      console.error('supabase auth failed', uRes.status, await uRes.text());
      return json(401, { error: 'invalid_session' });
    }

    const user = await uRes.json();
    const email = (user.email || '').toLowerCase().trim();
    if (!email) return json(401, { error: 'no_email' });

    // 2. Find that customer in Stripe.
    const found = await stripe.customers.list({ email, limit: 1 });
    if (!found.data.length) {
      console.log('no stripe customer for', email);
      return json(404, { error: 'no_customer' });
    }
    const customerId = found.data[0].id;

    // 3. Find a cancellable subscription (includes trials).
    const all = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 });
    const sub = all.data.find(s =>
      ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status) && !s.cancel_at_period_end
    );

    if (!sub) {
      const already = all.data.find(s => s.cancel_at_period_end);
      if (already) return json(200, { ok: true, already: true, access_until: endDate(already) });
      return json(404, { error: 'no_subscription' });
    }

    // 4. Cancel at the end of the paid period — never mid-period.
    const updated = await stripe.subscriptions.update(sub.id, { cancel_at_period_end: true });

    return json(200, { ok: true, access_until: endDate(updated) });
  } catch (err) {
    console.error('cancel error', err);
    return json(500, { error: 'cancel_failed' });
  }
};

function endDate(sub) {
  const ts = sub.current_period_end
    || sub.items?.data?.[0]?.current_period_end
    || sub.trial_end
    || null;
  return ts ? new Date(ts * 1000).toISOString() : null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
}
