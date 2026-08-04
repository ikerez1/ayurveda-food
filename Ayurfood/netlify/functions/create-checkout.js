// netlify/functions/create-checkout.js
// Creates a Stripe Checkout session for a CARD-REQUIRED 7-day trial.
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

const TRIAL_DAYS    = 7;
const TERMS_VERSION = '2026-08-04';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return fail(405, 'Method not allowed');

  try {
    const { priceId, email, userId, siteUrl, consent } = JSON.parse(event.body || '{}');

    if (!priceId) return fail(400, 'Missing priceId');
    if (!userId)  return fail(400, 'Missing userId');

    // ── Price allowlist ────────────────────────────────────────────────────
    // Without this, any client-supplied price from the account is accepted.
    const allowed = (process.env.ALLOWED_PRICE_IDS || '')
      .split(',').map(s => s.trim()).filter(Boolean);

    if (!allowed.length) {
      console.error('ALLOWED_PRICE_IDS not set — refusing to create session');
      return fail(500, 'Pricing not configured');
    }
    if (!allowed.includes(priceId)) {
      console.error('Rejected non-allowlisted priceId:', priceId);
      return fail(400, 'Unknown plan');
    }

    // ── Read the price from Stripe: server truth for the disclosure ────────
    const priceRes = await stripeGet('prices/' + encodeURIComponent(priceId));
    if (!priceRes.ok || !priceRes.data?.unit_amount) {
      console.error('Price lookup failed', priceRes.status, priceRes.data?.error?.message);
      return fail(400, 'Plan unavailable');
    }
    const price      = priceRes.data;
    const amountText = formatAmount(price.unit_amount, price.currency);
    const perText    = intervalLabel(price.recurring);
    const chargeDate = firstChargeDate(TRIAL_DAYS);

    // ── ROSCA: material terms, clearly and conspicuously, before billing ───
    // Stripe caps custom_text.submit.message at 1200 characters.
    const disclosure =
      `Your first ${TRIAL_DAYS} days are free. On ${chargeDate} your card is ` +
      `charged ${amountText}, and then ${amountText} every ${perText} until you ` +
      `cancel. Cancel any time in one tap: Account → Cancel Subscription. ` +
      `No email or phone call needed. Cancelling stops all future charges and ` +
      `your access continues to the end of the period you have already paid for.`;

    const base = (siteUrl || 'https://ayurveda-food.com').replace(/\/$/, '');

    const params = new URLSearchParams({
      mode:                     'subscription',
      'payment_method_types[]': 'card',
      'line_items[0][price]':    priceId,
      'line_items[0][quantity]': '1',

      // Card captured up front; the trial clock now lives in Stripe.
      payment_method_collection: 'always',
      'subscription_data[trial_period_days]': String(TRIAL_DAYS),
      'subscription_data[trial_settings][end_behavior][missing_payment_method]': 'cancel',
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
      return fail(sessionRes.status, sessionRes.data?.error?.message || 'Stripe error');
    }

    // ── Consent evidence ───────────────────────────────────────────────────
    await recordConsent({
      user_id:             userId,
      plan:                price.nickname || priceId,
      price_cents:         price.unit_amount,
      currency:            price.currency,
      billing_interval:    perText,
      trial_days:          TRIAL_DAYS,
      first_charge_date:   chargeDate,
      terms_version:       TERMS_VERSION,
      disclosure_text:     consent?.disclosure_text || disclosure,
      checkout_session_id: sessionRes.data.id,
      user_agent:          event.headers['user-agent'] || null,
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ url: sessionRes.data.url }),
    };

  } catch (err) {
    console.error('create-checkout error:', err.message);
    return fail(500, err.message);
  }
};
