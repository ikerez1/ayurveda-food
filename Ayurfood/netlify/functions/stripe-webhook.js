// netlify/functions/stripe-webhook.js
// Stripe sends payment events here → we update Supabase subscription status

const https = require('https');
const crypto = require('crypto');

// ─── Supabase REST helper ───────────────────────────────────────────────────
function supabaseRequest(path, method, body) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key  = process.env.SUPABASE_SERVICE_KEY; // service_role key — full access

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
        'Prefer':        'return=minimal',
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

// ─── Verify Stripe webhook signature ───────────────────────────────────────
function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts     = sigHeader.split(',').reduce((acc, p) => {
      const [k, v] = p.split('=');
      acc[k] = v;
      return acc;
    }, {});
    const timestamp = parts.t;
    const sig       = parts.v1;
    const signed    = `${timestamp}.${payload}`;
    const expected  = crypto.createHmac('sha256', secret).update(signed).digest('hex');
    // Allow 5 minute tolerance
    const age = Math.abs(Date.now() / 1000 - parseInt(timestamp));
    if (age > 300) return false;
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch(e) {
    return false;
  }
}

// ─── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig     = event.headers['stripe-signature'];
  const secret  = process.env.STRIPE_WEBHOOK_SECRET;
  const payload = event.body;

  // Verify signature if webhook secret is set
  if (secret && sig) {
    if (!verifyStripeSignature(payload, sig, secret)) {
      console.error('Invalid Stripe signature');
      return { statusCode: 400, body: 'Invalid signature' };
    }
  }

  let stripeEvent;
  try {
    stripeEvent = JSON.parse(payload);
  } catch(e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  console.log('Stripe event:', stripeEvent.type);

  const obj = stripeEvent.data?.object;

  try {
    switch (stripeEvent.type) {

      // ── Payment succeeded → activate subscription ──────────────────────
      case 'checkout.session.completed': {
        const userId = obj.client_reference_id || obj.metadata?.userId;
        const email  = obj.customer_email;

        if (!userId && !email) {
          console.log('No userId or email in checkout session');
          break;
        }

        // Calculate subscription end based on plan
        const subEnd = new Date();
        subEnd.setFullYear(subEnd.getFullYear() + 1); // default 1 year

        const updateData = {
          subscription_status:    'active',
          subscription_end:       subEnd.toISOString(),
          stripe_customer_id:     obj.customer,
          stripe_subscription_id: obj.subscription,
        };

        if (userId) {
          await supabaseRequest(
            `profiles?id=eq.${userId}`,
            'PATCH',
            updateData
          );
          console.log('✅ Activated subscription for user:', userId);
        } else if (email) {
          await supabaseRequest(
            `profiles?email=eq.${encodeURIComponent(email)}`,
            'PATCH',
            updateData
          );
          console.log('✅ Activated subscription for email:', email);
        }
        break;
      }

      // ── Subscription renewed ────────────────────────────────────────────
      case 'invoice.payment_succeeded': {
        const customerId = obj.customer;
        const subId      = obj.subscription;
        if (!customerId) break;

        // Extend subscription by the billing period
        const periodEnd = obj.lines?.data?.[0]?.period?.end;
        const subEnd    = periodEnd
          ? new Date(periodEnd * 1000).toISOString()
          : new Date(Date.now() + 366*24*60*60*1000).toISOString();

        await supabaseRequest(
          `profiles?stripe_customer_id=eq.${customerId}`,
          'PATCH',
          { subscription_status: 'active', subscription_end: subEnd, stripe_subscription_id: subId }
        );
        console.log('✅ Renewed subscription for customer:', customerId);
        break;
      }

      // ── Subscription cancelled ──────────────────────────────────────────
      case 'customer.subscription.deleted': {
        const customerId = obj.customer;
        if (!customerId) break;

        await supabaseRequest(
          `profiles?stripe_customer_id=eq.${customerId}`,
          'PATCH',
          { subscription_status: 'cancelled' }
        );
        console.log('✅ Cancelled subscription for customer:', customerId);
        break;
      }

      // ── Payment failed ──────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const customerId = obj.customer;
        if (!customerId) break;

        // Don't immediately cancel — Stripe retries. Just log.
        console.log('⚠️ Payment failed for customer:', customerId);
        break;
      }

      // ── Subscription paused/updated ─────────────────────────────────────
      case 'customer.subscription.updated': {
        const customerId = obj.customer;
        const status     = obj.status; // active, past_due, canceled, etc.
        if (!customerId) break;

        const dbStatus = status === 'active' ? 'active'
                       : status === 'canceled' ? 'cancelled'
                       : status === 'past_due' ? 'trial' // grace period
                       : 'trial';

        await supabaseRequest(
          `profiles?stripe_customer_id=eq.${customerId}`,
          'PATCH',
          { subscription_status: dbStatus }
        );
        console.log('✅ Updated subscription status:', customerId, '→', dbStatus);
        break;
      }

      default:
        console.log('Unhandled event type:', stripeEvent.type);
    }
  } catch(e) {
    console.error('Webhook handler error:', e.message);
    return { statusCode: 500, body: 'Handler error: ' + e.message };
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
