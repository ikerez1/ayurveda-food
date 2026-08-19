// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session billed immediately — no free trial.
// The caller is authenticated before any session or consent record is made.
//
// No npm dependencies — Node builtins + global fetch only.
//
// Required Netlify env vars:
//   STRIPE_SECRET_KEY
//   ALLOWED_PRICE_IDS   comma-separated allowlist: price_aaa,price_bbb,price_ccc
//
// Optional:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   → writes the ARL consent record
//   STRIPE_TOS_CONFIGURED=true           → enables Stripe's own ToS checkbox
//                                          (requires a Terms of Service URL set
//                                          in Stripe → Settings → Public details;
//                                          Checkout errors out without it)

// No free trial is granted. Kept as a named constant rather than deleted so
// the disclosure and the consent record have one place to change if a
// promotional trial is ever reintroduced — and so trial_days on the stored
// consent row stays an accurate 0 rather than a missing field.
const TRIAL_DAYS    = 0;
const TERMS_VERSION = '2026-08-19';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ayurveda-food.com,https://www.ayurveda-food.com')
  .split(',').map(s => s.trim()).filter(Boolean);

// This file has always read SUPABASE_SERVICE_KEY while analyse.js reads
// SUPABASE_SERVICE_ROLE_KEY. Both are accepted so a single missing alias
// cannot silently disable the consent write.
const SB_URL     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON    = process.env.SUPABASE_ANON_KEY || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ||
                   process.env.SUPABASE_SERVICE_KEY || '';

function corsFor(event) {
  const h = (event && event.headers) || {};
  const origin = h.origin || h.Origin || '';
  const ref    = h.referer || h.Referer || '';
  let allowed = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : null;
  if (!allowed && !origin) {
    const hit = ALLOWED_ORIGINS.filter(o => ref.indexOf(o + '/') === 0 || ref === o);
    allowed = hit.length ? hit[0] : null;
  }
  return {
    ok: !!allowed,
    headers: {
      'Access-Control-Allow-Origin':  allowed || ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Vary':                         'Origin',
      'Content-Type':                 'application/json',
    },
  };
}

// Retained so the module-level `fail` helper below keeps working; per-request
// responses use corsFor(event) instead.
const CORS = {
  'Access-Control-Allow-Origin':  ALLOWED_ORIGINS[0],
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

const fail = (statusCode, message) => ({
  statusCode,
  headers: CORS,
  body: JSON.stringify({ error: message }),
});

// ─── Stripe helpers (no SDK) ────────────────────────────────────────────────
async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY },
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, data: safeJson(body) };
}

async function stripePost(path, params) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: {
      Authorization:  'Bearer ' + process.env.STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const body = await res.text();
  return { ok: res.ok, status: res.status, data: safeJson(body) };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch (e) { return {}; }
}

// ─── Money / date formatting for the disclosure ─────────────────────────────
function formatAmount(unitAmount, currency) {
  const major = (unitAmount / 100).toFixed(2);
  const symbol = { usd: '$', gbp: '£', eur: '€' }[String(currency).toLowerCase()];
  return symbol ? symbol + major : major + ' ' + String(currency).toUpperCase();
}

function intervalLabel(recurring) {
  if (!recurring) return 'period';
  const n = recurring.interval_count || 1;
  return n === 1 ? recurring.interval : n + ' ' + recurring.interval + 's';
}

function firstChargeDate(days) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}

// The next renewal, stepped by the price's own interval rather than by a
// hardcoded number of days. A hardcoded offset gave the same date for a
// monthly and an annual plan, which the disclosure must not do.
function nextRenewalDate(recurring) {
  const d = new Date();
  const n = (recurring && recurring.interval_count) || 1;
  switch (recurring && recurring.interval) {
    case 'day':   d.setUTCDate(d.getUTCDate() + n); break;
    case 'week':  d.setUTCDate(d.getUTCDate() + 7 * n); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + n); break;
    default: return null;
  }
  return d.toISOString().slice(0, 10);
}

// ─── Caller verification ────────────────────────────────────────────────────
// Until now userId came from the request body and was trusted. The consent
// row written below is meant to evidence that a particular person accepted
// particular terms; attributed to an unverified id it evidences nothing.
async function verifyCaller(event) {
  if (!SB_URL || !SB_ANON) {
    return { error: 503, message: 'Checkout is temporarily unavailable' };
  }
  const h = event.headers || {};
  const raw = h.authorization || h.Authorization || '';
  const token = raw.replace(/^Bearer\s+/i, '').trim();
  if (!token) return { error: 401, message: 'Please sign in to subscribe' };

  try {
    const res = await fetch(SB_URL + '/auth/v1/user', {
      headers: { apikey: SB_ANON, Authorization: 'Bearer ' + token },
    });
    if (!res.ok) return { error: 401, message: 'Your session has expired' };
    const u = safeJson(await res.text());
    if (!u || !u.id) return { error: 401, message: 'Your session has expired' };
    return { userId: u.id, email: u.email || null };
  } catch (e) {
    console.error('verifyCaller threw:', e.message);
    return { error: 503, message: 'Checkout is temporarily unavailable' };
  }
}

// Refuses a second concurrent subscription. The client checks this against its
// own cached profile, which is why three of them once accumulated on one
// account during testing.
async function hasLiveSubscription(userId) {
  if (!SB_URL || !SB_SERVICE) return false;
  try {
    const res = await fetch(
      SB_URL + '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) +
      '&select=subscription_status,subscription_end,cancel_at_period_end',
      { headers: { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE } });
    if (!res.ok) return false;
    const rows = safeJson(await res.text());
    const p = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!p) return false;
    if (p.subscription_status !== 'active') return false;
    if (p.cancel_at_period_end === true) return false;  // winding down: may resubscribe
    if (p.subscription_end && new Date(p.subscription_end) < new Date()) return false;
    return true;
  } catch (e) {
    // Unreachable profile must not block a paying customer from subscribing.
    console.warn('hasLiveSubscription check failed:', e.message);
    return false;
  }
}

// ─── ARL consent evidence (Cal. Bus. & Prof. Code § 17602(a)(6)) ────────────
// Written after the session is created so the Checkout session id can be
// stored alongside it. Failure is logged but does NOT block checkout — see
// the note in the accompanying summary about that tradeoff.
async function recordConsent(row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.warn('⚠️ Supabase env not set — ARL consent record NOT written');
    return false;
  }
  try {
    const res = await fetch(url.replace(/\/$/, '') + '/rest/v1/arl_consents', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        apikey:          key,
        Authorization:   'Bearer ' + key,
        Prefer:          'return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.error('❌ ARL consent write failed', res.status, (await res.text()).slice(0, 300));
      return false;
    }
    console.log('✅ ARL consent recorded for user', row.user_id);
    return true;
  } catch (e) {
    console.error('❌ ARL consent write threw:', e.message);
    return false;
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const cors = corsFor(event);
  const H = cors.headers;
  const deny = (code, msg) => ({ statusCode: code, headers: H, body: JSON.stringify({ error: msg }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: H, body: '' };
  if (event.httpMethod !== 'POST')    return deny(405, 'Method not allowed');
  if (!cors.ok)                       return deny(403, 'Forbidden');

  try {
    const body = JSON.parse(event.body || '{}');
    const { priceId, siteUrl, consent } = body;

    if (!priceId) return deny(400, 'Missing priceId');

    // ── Who is calling ─────────────────────────────────────────────────────
    const caller = await verifyCaller(event);
    if (caller.error) return deny(caller.error, caller.message);

    // A body id that disagrees with the token is either a stale client or an
    // attempt to file consent against someone else's account. Neither should
    // proceed quietly.
    if (body.userId && body.userId !== caller.userId) {
      console.error('userId mismatch: body', body.userId, 'token', caller.userId);
      return deny(403, 'Forbidden');
    }
    const userId = caller.userId;
    // The verified address, not the one in the request body.
    const email  = caller.email || body.email || null;

    if (await hasLiveSubscription(userId)) {
      return deny(409, 'You already have an active subscription');
    }

    // ── Price allowlist ────────────────────────────────────────────────────
    // Without this, any client-supplied price from the account is accepted.
    const allowed = (process.env.ALLOWED_PRICE_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (!allowed.length) {
      console.error('ALLOWED_PRICE_IDS not set — refusing to create session');
      return deny(500, 'Pricing not configured');
    }
    if (!allowed.includes(priceId)) {
      console.error('Rejected non-allowlisted priceId:', priceId);
      return deny(400, 'Unknown plan');
    }

    // ── Read the price from Stripe: server truth for the disclosure ────────
    const priceRes = await stripeGet('prices/' + encodeURIComponent(priceId));
    if (!priceRes.ok || !priceRes.data?.unit_amount) {
      console.error('Price lookup failed', priceRes.status, priceRes.data?.error?.message);
      return deny(400, 'Plan unavailable');
    }
    const price      = priceRes.data;
    const amountText = formatAmount(price.unit_amount, price.currency);
    const perText    = intervalLabel(price.recurring);
    const chargeDate  = firstChargeDate(TRIAL_DAYS);   // TRIAL_DAYS is 0: today
    const renewalDate = nextRenewalDate(price.recurring);

    // ── ROSCA: material terms, clearly and conspicuously, before billing ───
    // Stripe caps custom_text.submit.message at 1200 characters.
    const disclosure =
      `Your card is charged ${amountText} today. It then renews automatically ` +
      `at ${amountText} every ${perText}` +
      (renewalDate ? `, next on ${renewalDate}` : '') +
      `, until you cancel. Cancel any time in one tap: Account → Cancel ` +
      `Subscription. No email or phone call needed. Cancelling stops all future ` +
      `charges and your access continues to the end of the period you have ` +
      `already paid for.`;

    const base = (siteUrl || 'https://ayurveda-food.com').replace(/\/$/, '');

    const params = new URLSearchParams({
      mode:                     'subscription',
      'payment_method_types[]': 'card',
      'line_items[0][price]':    priceId,
      'line_items[0][quantity]': '1',

      // No trial: the first invoice is charged at Checkout. trial_period_days
      // and the trial_settings that governed a missing payment method at trial
      // end are both gone — with nothing to convert, they have no meaning.
      payment_method_collection: 'always',
      'subscription_data[metadata][supabase_user_id]': userId,
      'subscription_data[metadata][terms_version]':    TERMS_VERSION,

      'custom_text[submit][message]': disclosure.slice(0, 1200),

      client_reference_id:          userId,
      'metadata[supabase_user_id]': userId,
      'metadata[terms_version]':    TERMS_VERSION,

      success_url: `${base}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${base}?payment=cancelled`,
    });

    if (email) params.append('customer_email', email);

    // Second, independent evidence of acceptance — but only if a ToS URL is
    // actually configured in Stripe, otherwise session creation 400s.
    if (String(process.env.STRIPE_TOS_CONFIGURED).toLowerCase() === 'true') {
      params.append('consent_collection[terms_of_service]', 'required');
    }

    const sessionRes = await stripePost('checkout/sessions', params);
    if (!sessionRes.ok) {
      console.error('Stripe session error', sessionRes.status, sessionRes.data?.error?.message);
      return deny(sessionRes.status, sessionRes.data?.error?.message || 'Stripe error');
    }

    // ── Consent evidence ───────────────────────────────────────────────────
    await recordConsent({
      user_id:             userId,
      plan:                price.nickname || priceId,
      price_cents:         price.unit_amount,
      currency:            price.currency,
      billing_interval:    perText,
      trial_days:          TRIAL_DAYS,          // 0 — no trial is offered
      first_charge_date:   chargeDate,          // today
      // Existing columns only: nothing here needs an arl_consents migration.
      terms_version:       TERMS_VERSION,
      disclosure_text:     consent?.disclosure_text || disclosure,
      checkout_session_id: sessionRes.data.id,
      user_agent:          event.headers['user-agent'] || null,
    });

    return {
      statusCode: 200,
      headers: H,
      body: JSON.stringify({ url: sessionRes.data.url }),
    };

  } catch (err) {
    console.error('create-checkout error:', err.message);
    return fail(500, err.message);
  }
};
