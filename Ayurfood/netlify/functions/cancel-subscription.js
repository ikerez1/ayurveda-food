// netlify/functions/cancel-subscription.js
// Lets a signed-in subscriber cancel their own plan, at period end.
//
// No npm dependencies — global fetch only (same approach as stripe-webhook.js).
//
// Required Netlify env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY), STRIPE_SECRET_KEY

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_KEY;
const STRIPE_KEY   = process.env.STRIPE_SECRET_KEY;

// ─── Stripe REST helpers (no SDK) ──────────────────────────────────────────
async function stripeCall(path, method = 'GET', form = null) {
  const opts = {
    method,
    headers: { Authorization: 'Bearer ' + STRIPE_KEY },
  };
  if (form) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(form).toString();
  }
  const res = await fetch('https://api.stripe.com/v1/' + path, opts);
  const text = await res.text();
  if (!res.ok) {
    console.error('Stripe error', method, path, res.status, text.slice(0, 400));
    return null;
  }
  try { return JSON.parse(text); } catch (e) { return null; }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  if (!SUPABASE_URL || !SUPABASE_KEY || !STRIPE_KEY) {
    console.error('MISSING CONFIG. Relevant env names present:',
      Object.keys(process.env).filter(n => /SUP|STRIPE/i.test(n)));
    return json(500, { error: 'server_misconfigured' });
  }

  try {
    // 1. Authenticate the caller via their Supabase session.
    //    Never trust an email posted from the browser — that would let
    //    anyone cancel any subscriber's plan by typing their address.
    const auth  = event.headers['authorization'] || event.headers['Authorization'] || '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (!token) return json(401, { error: 'not_authenticated' });

    const uRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: 'Bearer ' + token, apikey: SUPABASE_KEY },
    });
    if (!uRes.ok) {
      console.error('Supabase auth failed', uRes.status, (await uRes.text()).slice(0, 300));
      return json(401, { error: 'invalid_session' });
    }

    const user  = await uRes.json();
    const email = (user.email || '').toLowerCase().trim();
    if (!user.id && !email) return json(401, { error: 'no_email' });

    // 2. Resolve the Stripe customer.
    //    Prefer the stored stripe_customer_id, since a user may have paid
    //    with a different address than they signed up with.
    let customerId = null;

    const pRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token } }
    );
    if (pRes.ok) {
      const rows = await pRes.json().catch(() => []);
      customerId = rows?.[0]?.stripe_customer_id || null;
    }

    if (!customerId && email) {
      const found = await stripeCall('customers?email=' + encodeURIComponent(email) + '&limit=1');
      customerId = found?.data?.[0]?.id || null;
    }

    if (!customerId) {
      console.log('No Stripe customer for', email);
      return json(404, { error: 'no_customer' });
    }

    // 3. Find a cancellable subscription. `trialing` is included: trial users
    //    are the most likely to cancel, and excluding them would show them a
    //    "no subscription found" error.
    const list = await stripeCall(
      'subscriptions?customer=' + encodeURIComponent(customerId) + '&status=all&limit=10'
    );
    const subs = list?.data || [];

    const sub = subs.find(s =>
      ['active', 'trialing', 'past_due', 'unpaid'].includes(s.status) && !s.cancel_at_period_end
    );

    if (!sub) {
      const already = subs.find(s => s.cancel_at_period_end);
      if (already) {
        return json(200, { ok: true, already: true, access_until: endDate(already) });
      }
      return json(404, { error: 'no_subscription' });
    }

    // 4. Cancel at period end — never mid-period. They have paid through it,
    //    and an immediate cut-off invites a refund dispute.
    const updated = await stripeCall('subscriptions/' + sub.id, 'POST', {
      cancel_at_period_end: 'true',
    });
    if (!updated) return json(500, { error: 'cancel_failed' });

    console.log('Cancelled', updated.id, 'for', email);
    return json(200, { ok: true, access_until: endDate(updated) });

  } catch (err) {
    console.error('cancel error', err);
    return json(500, { error: 'cancel_failed' });
  }
};

// Newer Stripe API versions moved current_period_end onto the line item.
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
    body: JSON.stringify(body),
  };
}
