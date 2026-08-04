// netlify/functions/stripe-webhook.js
// Stripe sends payment events here → we update Supabase subscription status
//
// No npm dependencies — Node builtins + global fetch only.
//
// Required Netlify env vars:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

const https  = require('https');
const crypto = require('crypto');

// ─── Supabase REST helper ───────────────────────────────────────────────────
// Uses return=representation so we can tell "updated 0 rows" from "updated 1".
// With return=minimal a mismatched filter looks identical to success.
function supabaseRequest(path, method, body) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY; // service_role key — bypasses RLS

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: new URL(url).hostname,
      path:     '/rest/v1/' + path,
      method,
      headers: {
        'Content-Type':  'application/json',
        'apikey':        key,
        'Authorization': 'Bearer ' + key,
        'Prefer':        'return=representation',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// PATCH a profile and report whether it actually matched a row.
async function patchProfile(filter, data, label) {
  const res = await supabaseRequest(`profiles?${filter}`, 'PATCH', data);

  if (res.status < 200 || res.status >= 300) {
    console.error('❌ Supabase PATCH failed', res.status, res.body.slice(0, 400), '|', filter);
    return false;
  }

  let rows = [];
  try { rows = JSON.parse(res.body); } catch (e) { rows = []; }

  if (!Array.isArray(rows) || rows.length === 0) {
    // The most common real-world failure: stripe_customer_id was never
    // written, so every later lookup by that column matches nothing.
    console.error('❌ Supabase PATCH matched NO ROWS for filter:', filter);
    return false;
  }

  console.log('✅', label, '|', filter, '| rows:', rows.length);
  return true;
}

// ─── Stripe REST helper (no SDK) ───────────────────────────────────────────
async function stripeGet(path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY },
  });
  if (!res.ok) {
    console.error('Stripe GET failed', path, res.status, (await res.text()).slice(0, 300));
    return null;
  }
  return res.json();
}

// ─── Verify Stripe webhook signature ───────────────────────────────────────
// Stripe may send several v1 signatures during a secret rotation, so every
// candidate is checked rather than only the last one parsed.
function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(',').map(p => p.split('='));
    const timestamp = (parts.find(p => p[0].trim() === 't') || [])[1];
    const sigs = parts.filter(p => p[0].trim() === 'v1').map(p => p[1]);
    if (!timestamp || !sigs.length) return false;

    // Replay window.
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
    if (!isFinite(age) || age > 300) return false;

    const expected = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`)
      .digest('hex');
    const expBuf = Buffer.from(expected, 'hex');

    return sigs.some((s) => {
      try {
        const sBuf = Buffer.from(s, 'hex');
        return sBuf.length === expBuf.length && crypto.timingSafeEqual(sBuf, expBuf);
      } catch (e) { return false; }
    });
  } catch (e) {
    return false;
  }
}

// ─── Has this subscription ever actually been paid for? ────────────────────
// NEW. Distinguishes two very different past_due situations:
//   (a) an established customer whose card expired  → keep access, Stripe retries
//   (b) a trial converting on a card that declined  → revoke, this is free riding
// Without this, a card-required trial can be extended for the full retry
// window (often ~3 weeks) simply by supplying a card that will not charge.
async function hasEverPaid(subId) {
  const res = await stripeGet(
    'invoices?subscription=' + encodeURIComponent(subId) + '&status=paid&limit=1'
  );
  if (!res) return true;              // fail open: never lock out on an API blip
  return Array.isArray(res.data) && res.data.length > 0;
}

// ─── Shared: write a subscription's true state onto the profile ────────────
// Reads the real period end from Stripe instead of assuming a term length.
async function syncFromSubscription(subId, filter, label) {
  const sub = await stripeGet('subscriptions/' + subId);
  if (!sub) return false;

  const endTs = sub.current_period_end
             || sub.items?.data?.[0]?.current_period_end
             || sub.trial_end
             || null;

  // active and trialing always grant. past_due grants only where the customer
  // has a payment history — see hasEverPaid above.
  let grants;
  if (sub.status === 'active' || sub.status === 'trialing') {
    grants = true;
  } else if (sub.status === 'past_due') {
    grants = await hasEverPaid(sub.id);
    if (!grants) {
      console.log('⚠️ past_due with no prior payment — revoking access for', sub.id);
    }
  } else {
    grants = false;
  }

  return patchProfile(filter, {
    subscription_status:    grants ? 'active' : 'cancelled',
    // NEW: preserve Stripe's own status verbatim so trialing is distinguishable
    // from active. Needed for reminders, conversion metrics and the ARL record.
    stripe_status:          sub.status,
    trial_end:              sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    subscription_end:       endTs ? new Date(endTs * 1000).toISOString() : null,
    cancel_at_period_end:   !!sub.cancel_at_period_end,
    stripe_subscription_id: sub.id,
    stripe_customer_id:     typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
  }, label);
}

// ─── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig     = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  // Fail closed. An unverified payload is anonymous internet input claiming
  // someone's subscription changed — acting on it would let anyone grant
  // themselves access, or revoke a paying customer's, with a plain POST.
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET not set — refusing to process');
    return { statusCode: 500, body: 'Webhook secret not configured' };
  }
  if (!sig || !verifyStripeSignature(payload, sig, secret)) {
    console.error('Invalid or missing Stripe signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(payload);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Stripe event:', stripeEvent.type, stripeEvent.id);

  const obj = stripeEvent.data?.object;
  if (!obj) return { statusCode: 200, body: JSON.stringify({ received: true }) };

  try {
    switch (stripeEvent.type) {

      // ── Checkout completed → trial starts (card on file) ────────────────
      case 'checkout.session.completed': {
        if (obj.mode && obj.mode !== 'subscription') break;

        const userId = obj.client_reference_id
                    || obj.metadata?.supabase_user_id
                    || obj.metadata?.userId;
        // customer_email is frequently null; customer_details.email is the
        // field Checkout actually populates.
        const email  = obj.customer_details?.email || obj.customer_email;

        if (!userId && !email) {
          console.error('No userId or email in checkout session', obj.id);
          break;
        }

        const filter = userId
          ? `id=eq.${encodeURIComponent(userId)}`
          : `email=eq.${encodeURIComponent(email)}`;

        if (obj.subscription) {
          // Real dates from Stripe — a monthly plan must not be recorded
          // as ending a year out. With a trial, this lands as trialing.
          const ok = await syncFromSubscription(obj.subscription, filter, 'Trial started');
          if (ok) break;
        }

        // Fallback if the subscription could not be read.
        await patchProfile(filter, {
          subscription_status:    'active',
          stripe_customer_id:     obj.customer,
          stripe_subscription_id: obj.subscription,
        }, 'Activated (no dates)');
        break;
      }

      // ── Subscription renewed, or trial converted to paid ────────────────
      case 'invoice.payment_succeeded': {
        const customerId = obj.customer;
        const subId = obj.subscription
                   || obj.parent?.subscription_details?.subscription
                   || obj.lines?.data?.[0]?.subscription;
        if (!customerId) break;

        if (subId) {
          await syncFromSubscription(
            subId,
            `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
            'Renewed'
          );
          break;
        }

        const periodEnd = obj.lines?.data?.[0]?.period?.end;
        if (periodEnd) {
          await patchProfile(
            `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
            { subscription_status: 'active', subscription_end: new Date(periodEnd * 1000).toISOString() },
            'Renewed (invoice dates)'
          );
        }
        break;
      }

      // ── Trial ends in 3 days ────────────────────────────────────────────
      // NEW. Stripe's built-in trial-ending email (Settings → Billing →
      // Subscriptions and emails) does the actual notifying, so this only
      // records the state. If you later want your own reminder, send it here.
      case 'customer.subscription.trial_will_end': {
        const customerId = obj.customer;
        if (!customerId || !obj.id) break;
        console.log('⏳ Trial ending in 3 days for subscription', obj.id);
        await syncFromSubscription(
          obj.id,
          `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
          'Trial ending soon'
        );
        break;
      }

      // ── Subscription created/updated (includes cancel-at-period-end) ────
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.paused':
      case 'customer.subscription.resumed': {
        const customerId = obj.customer;
        if (!customerId || !obj.id) break;
        await syncFromSubscription(
          obj.id,
          `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
          'Updated'
        );
        break;
      }

      // ── Subscription actually ended → revoke access ─────────────────────
      case 'customer.subscription.deleted': {
        const customerId = obj.customer;
        if (!customerId) break;

        // subscription_end is set to now so the app's client-side check
        // (subscription_end in the past → expired) also revokes immediately,
        // even before the next profile sync lands.
        await patchProfile(
          `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
          {
            subscription_status:  'cancelled',
            stripe_status:        'canceled',
            subscription_end:     new Date().toISOString(),
            cancel_at_period_end: false,
          },
          'Cancelled'
        );
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const customerId = obj.customer;
        const subId = obj.subscription
                   || obj.parent?.subscription_details?.subscription
                   || obj.lines?.data?.[0]?.subscription;

        console.log('⚠️ Payment failed for customer:', customerId, 'sub:', subId);

        // NEW. Re-sync rather than ignoring. syncFromSubscription now decides
        // whether past_due keeps access, based on payment history — so an
        // established customer is left alone while a failed trial conversion
        // loses access immediately.
        if (customerId && subId) {
          await syncFromSubscription(
            subId,
            `stripe_customer_id=eq.${encodeURIComponent(customerId)}`,
            'Payment failed'
          );
        }
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }
  } catch (e) {
    // 500 makes Stripe retry. A dropped event means a wrong access state.
    console.error('Webhook handler error:', e.message);
    return { statusCode: 500, body: 'Handler error: ' + e.message };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
