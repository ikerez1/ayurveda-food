// netlify/functions/analyse.js
// Proxies food analysis to the Anthropic API so the key never reaches the client.
//
// No npm dependencies — Node builtins only.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY  (or ANTHROPIC_API_KEY_FOR_AYURFOOD)

const https  = require('https');
const crypto = require('crypto');

// ── Guard configuration ────────────────────────────────────────────────────
// Every value has a default so a missing env var degrades predictably rather
// than throwing on cold start. The three Supabase vars have no safe default:
// without them the guard cannot verify anything, and it fails closed.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ayurveda-food.com,https://www.ayurveda-food.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const GUEST_DAILY = Number(process.env.ANALYSE_GUEST_DAILY || 8);
const USER_DAILY  = Number(process.env.ANALYSE_USER_DAILY  || 60);

// ~5 MB of binary. The client already downscales before upload; this is the
// backstop against a hand-crafted payload running up an image bill.
const MAX_IMAGE_B64 = 7000000;
const MAX_NAME_LEN  = 200;

const SB_URL     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON    = process.env.SUPABASE_ANON_KEY || '';
// Either name is accepted. create-checkout.js has always read
// SUPABASE_SERVICE_KEY, and holding one credential under two names invites the
// failure where a rotation updates one and silently breaks the other.
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ||
                   process.env.SUPABASE_SERVICE_KEY || '';
const HASH_SALT  = process.env.ANALYSE_HASH_SALT || '';

// Mirrors CONFIG.LEGACY_TRIAL_CUTOFF in the client. Accounts whose card-free
// trial predates this keep it; nobody else enters that branch.
const LEGACY_TRIAL_CUTOFF = '2026-08-04T09:42:05Z';
const LEGACY_TRIAL_DAYS   = 7;

const DOSHA_NAMES = { vata: 'Vāta', pitta: 'Pitta', kapha: 'Kapha' };
const DOSHA_Q = {
  vata:  ['Light', 'Dry', 'Cold', 'Mobile'],
  pitta: ['Hot', 'Sharp', 'Light', 'Oily'],
  kapha: ['Heavy', 'Slow', 'Cold', 'Moist'],
};

// Builds the constitutional context for the system prompt.
//
// Accepts all seven classical prakriti types: three single ('vata'), three
// dual ('vata-pitta', 'vata-kapha', 'pitta-kapha') and tridoshic ('sama').
// The previous version indexed DOSHA_Q directly by the key, so any hyphenated
// value threw on .join() and the handler returned a 500 — every analysis
// failed for dual-constitution users.
function doshaContext(dosha) {
  if (!dosha || typeof dosha !== 'string') return 'No prakriti set.';

  if (dosha === 'sama') {
    return 'User prakriti: SAMA (tridoṣic — Vāta, Pitta and Kapha in balance). '
         + 'No single dosha dominates. Judge the food on whether it maintains '
         + 'overall equilibrium and suits the current season, rather than on '
         + 'pacifying one dosha. Flag anything that would strongly aggravate '
         + 'any single dosha.';
  }

  const parts = dosha.split('-').filter(k => DOSHA_NAMES[k]);
  if (!parts.length) return 'No prakriti set.';

  if (parts.length === 1) {
    const k = parts[0];
    return `User prakriti: ${k.toUpperCase()} (${DOSHA_NAMES[k]}). `
         + `Qualities: ${DOSHA_Q[k].join(', ')}. `
         + `Judge the food primarily on its effect on ${DOSHA_NAMES[k]}.`;
  }

  // Dual constitution. Both doshas carry roughly equal weight, so a food that
  // pacifies one while strongly aggravating the other is not a good choice —
  // which is precisely the judgement a single-dosha prompt cannot make.
  const [a, b] = parts;
  return `User prakriti: ${a.toUpperCase()}-${b.toUpperCase()} `
       + `(${DOSHA_NAMES[a]}-${DOSHA_NAMES[b]}) — a dual (dvandvaja) constitution. `
       + `${DOSHA_NAMES[a]} qualities: ${DOSHA_Q[a].join(', ')}. `
       + `${DOSHA_NAMES[b]} qualities: ${DOSHA_Q[b].join(', ')}. `
       + `Both doshas matter roughly equally. Do NOT optimise for one at the `
       + `other's expense: a food that pacifies ${DOSHA_NAMES[a]} but strongly `
       + `aggravates ${DOSHA_NAMES[b]} should not score well. In the verdict and `
       + `advice, say which of the two the food serves and which it provokes, and `
       + `note when the answer depends on season or current imbalance.`;
}

// ══════════════════════════════════════════════════════════════════════════
// CALLER GUARD
// ══════════════════════════════════════════════════════════════════════════
const afcGuard = {};

/** Minimal JSON-over-HTTPS helper. Node builtins only, no npm. */
afcGuard.request = function (opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (e) {}
        resolve({ status: res.statusCode, json: parsed, text: data });
      });
    });
    // A network failure must not throw into the handler; the caller decides
    // whether a null response fails open or closed.
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: 0, json: null, text: '' }); });
    if (body) req.write(body);
    req.end();
  });
};

afcGuard.sbHost = function () {
  return SB_URL.replace(/^https?:\/\//, '');
};

/** The origin to echo back, or null when the caller is not allowed. */
afcGuard.originOf = function (event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  if (origin) return ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : null;
  // Same-origin fetch from some in-app browsers omits Origin entirely; fall
  // back to Referer before rejecting, since the PWA and the TWA both reach
  // this endpoint from the site itself.
  const ref = h.referer || h.Referer || '';
  const hit = ALLOWED_ORIGINS.filter(o => ref.indexOf(o + '/') === 0 || ref === o);
  return hit.length ? hit[0] : null;
};

afcGuard.clientIp = function (event) {
  const h = event.headers || {};
  const raw = h['x-nf-client-connection-ip']
           || (h['x-forwarded-for'] || '').split(',')[0]
           || h['client-ip'] || '';
  return String(raw).trim();
};

/** Pseudonymised quota bucket. The raw IP is never stored or logged. */
afcGuard.bucketKey = function (prefix, value) {
  return prefix + ':' + crypto.createHmac('sha256', HASH_SALT)
    .update(String(value)).digest('hex').slice(0, 32);
};

/** Verifies a Supabase access token. Returns the user id, or null. */
afcGuard.userFromToken = async function (token) {
  if (!token || !SB_URL || !SB_ANON) return null;
  const res = await afcGuard.request({
    hostname: afcGuard.sbHost(),
    path: '/auth/v1/user',
    method: 'GET',
    headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + token },
  });
  if (res.status !== 200 || !res.json || !res.json.id) return null;
  return res.json.id;
};

/** Reads the subscription fields with the service role. */
afcGuard.profileOf = async function (userId) {
  if (!SB_URL || !SB_SERVICE) return null;
  const cols = 'subscription_status,subscription_end,stripe_status,trial_start';
  const res = await afcGuard.request({
    hostname: afcGuard.sbHost(),
    path: '/rest/v1/profiles?id=eq.' + encodeURIComponent(userId) + '&select=' + cols,
    method: 'GET',
    headers: {
      'apikey': SB_SERVICE,
      'Authorization': 'Bearer ' + SB_SERVICE,
      'Accept': 'application/json',
    },
  });
  if (res.status !== 200 || !Array.isArray(res.json) || !res.json.length) return null;
  return res.json[0];
};

/**
 * Server-side mirror of getSubscriptionStatus() in the client.
 *
 * Note on 'cancelled': this returns 'expired', matching the client. That is
 * correct only if the webhook writes 'cancelled' when the period actually
 * ends, keeping 'active' with cancel_at_period_end until then. If it writes
 * 'cancelled' at the moment of cancellation instead, both this and the client
 * cut access early, contradicting the paywall's stated terms — worth checking
 * against the webhook before relying on it.
 */
afcGuard.entitlement = function (p) {
  if (!p) return 'none';
  const now = new Date();
  const end = p.subscription_end ? new Date(p.subscription_end) : null;
  const ended = end && !isNaN(end.getTime()) && end < now;

  if (p.subscription_status === 'active') {
    if (ended) return 'expired';
    return p.stripe_status === 'trialing' ? 'trial' : 'active';
  }
  if (p.subscription_status === 'comped') return ended ? 'expired' : 'active';
  if (p.subscription_status === 'cancelled' || p.subscription_status === 'canceled') {
    return 'expired';
  }
  if (p.trial_start) {
    const start = new Date(p.trial_start);
    if (!isNaN(start.getTime()) && start < new Date(LEGACY_TRIAL_CUTOFF)) {
      const days = (now - start) / 86400000;
      return days <= LEGACY_TRIAL_DAYS ? 'trial' : 'expired';
    }
  }
  return 'none';
};

/**
 * Atomic per-day counter. The insert-or-increment happens inside Postgres, so
 * concurrent calls cannot both read the same count and both be let through.
 * Returns { ok, used, quota, degraded } — degraded means the store could not
 * be reached and the caller must decide.
 */
afcGuard.consume = async function (key, limit) {
  if (!SB_URL || !SB_SERVICE) return { ok: false, used: 0, quota: limit, degraded: true };
  const body = JSON.stringify({ p_key: key, p_limit: limit });
  const res = await afcGuard.request({
    hostname: afcGuard.sbHost(),
    path: '/rest/v1/rpc/bump_analyse_usage',
    method: 'POST',
    headers: {
      'apikey': SB_SERVICE,
      'Authorization': 'Bearer ' + SB_SERVICE,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, body);
  if (res.status !== 200 || !res.json) {
    return { ok: false, used: 0, quota: limit, degraded: true };
  }
  const row = Array.isArray(res.json) ? res.json[0] : res.json;
  if (!row || typeof row.allowed !== 'boolean') {
    return { ok: false, used: 0, quota: limit, degraded: true };
  }
  return { ok: row.allowed, used: row.used, quota: row.quota, degraded: false };
};

exports.handler = async (event) => {
  // CORS is now scoped to the site's own origins. '*' let any page on the
  // internet call this endpoint from a browser with no further work.
  const allowedOrigin = afcGuard.originOf(event);
  const headers = {
    'Access-Control-Allow-Origin': allowedOrigin || ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };
  }

  // ── Layer 0: the guard cannot run without its own configuration. Failing
  // closed here is deliberate: an unconfigured guard is an open proxy, which
  // is the condition this patch exists to end.
  if (!SB_URL || !SB_ANON || !SB_SERVICE || !HASH_SALT) {
    console.error('analyse: guard not configured — check SUPABASE_URL, ' +
                  'SUPABASE_ANON_KEY, ANALYSE_HASH_SALT, and one of ' +
                  'SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY');
    return { statusCode: 503, headers,
             body: JSON.stringify({ error: 'Analysis is temporarily unavailable' }) };
  }

  // ── Layer 1: origin. Cheap, spoofable, and worth having anyway.
  if (!allowedOrigin) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const { foodName, imageB64, dosha } = JSON.parse(event.body || '{}');

    // ── Layer 2: size, checked before anything is paid for.
    if (typeof imageB64 === 'string' && imageB64.length > MAX_IMAGE_B64) {
      return { statusCode: 413, headers,
               body: JSON.stringify({ error: 'Image too large — please retake the photo' }) };
    }
    if (typeof foodName === 'string' && foodName.length > MAX_NAME_LEN) {
      return { statusCode: 413, headers,
               body: JSON.stringify({ error: 'Food name too long' }) };
    }
    if (!foodName && !imageB64) {
      return { statusCode: 400, headers,
               body: JSON.stringify({ error: 'Nothing to analyse' }) };
    }

    // ── Layer 3: identity and entitlement.
    const authHdr = event.headers?.authorization || event.headers?.Authorization || '';
    const token   = authHdr.replace(/^Bearer\s+/i, '').trim();

    let quotaKey, quotaLimit;

    if (token) {
      const userId = await afcGuard.userFromToken(token);
      if (!userId) {
        return { statusCode: 401, headers,
                 body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
      }
      const prof  = await afcGuard.profileOf(userId);
      const state = afcGuard.entitlement(prof);
      if (state !== 'active' && state !== 'trial') {
        // 402 is the signal the client turns into the paywall. Until now this
        // check existed only in the browser, where it could simply be skipped.
        return { statusCode: 402, headers,
                 body: JSON.stringify({ error: 'A subscription is needed to continue',
                                        reason: 'subscription_required' }) };
      }
      quotaKey   = 'u:' + userId;
      quotaLimit = USER_DAILY;
    } else {
      // Unregistered caller. The 7-day guest window lives in localStorage and
      // cannot be verified here, so the IP quota is what actually bounds guest
      // spend — treat it as the real limit, not as a backstop.
      const ip = afcGuard.clientIp(event);
      if (!ip) {
        return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
      }
      quotaKey   = afcGuard.bucketKey('g', ip);
      quotaLimit = GUEST_DAILY;
    }

    // ── Layer 4: quota.
    const quota = await afcGuard.consume(quotaKey, quotaLimit);
    if (quota.degraded) {
      // The counter is unreachable. A verified, entitled account is allowed
      // through — the spend is bounded by people who are paying. An anonymous
      // caller is not, because nothing else bounds them.
      if (!token) {
        return { statusCode: 503, headers,
                 body: JSON.stringify({ error: 'Analysis is temporarily unavailable' }) };
      }
      console.warn('analyse: quota store unreachable, allowing verified account');
    } else if (!quota.ok) {
      return { statusCode: 429, headers,
               body: JSON.stringify({
                 error: token
                   ? 'Daily analysis limit reached — this resets tomorrow'
                   : 'Daily limit reached. Create a free account to continue analysing.',
                 reason: 'rate_limited',
                 used: quota.used, quota: quota.quota }) };
    }

    const ctx = doshaContext(dosha);

    const systemPrompt = `You are a classical Ayurvedic nutritionist. ${ctx}

SCORING RULES — read carefully.
Each dosha score is an integer from 0 to 100 describing how well this food suits a person of that constitution: 0 = strongly aggravating, 50 = genuinely neutral, 100 = ideally pacifying.

Derive each score from the food's actual properties — guna (qualities), rasa, virya, vipaka, method of preparation, and the portion a person would realistically eat. The number must be the one your reasoning supports, at single-integer resolution.

Do NOT round to the nearest 5 or 10. Scores such as 37, 62, 48, 71, 83 and 26 are expected and correct. A score ending in 0 or 5 is acceptable only where it is the genuine result of the assessment, never as a default or a convenient band. Do not reuse a score you have used for a different dosha in the same food unless the effect really is identical.

Two foods that differ in any relevant quality must not receive the same score. Cooking method, temperature, oil content and food-combining (viruddha ahara) all move the number.

Each "desc" must name the specific quality driving that score, in 12 words or fewer — for example "raw and cold; increases the dry, mobile quality" — not a restatement of the score.

Set "verdict" from the score for the user's own constitution: 80+ Excellent, 65-79 Good, 45-64 Neutral, 25-44 Caution, below 25 Avoid.

Return ONLY JSON, no preamble and no markdown fences: {"foodName":"string","emoji":"emoji","category":"string","rasa":"string","virya":"Heating or Cooling","vipaka":"Sweet or Sour or Pungent","tastes":["Sweet"],"season":"string","vata":{"score":0-100,"effect":"\u2193|~|\u2191|\u2191\u2191","desc":"string"},"pitta":{"score":0-100,"effect":"\u2193|~|\u2191|\u2191\u2191","desc":"string"},"kapha":{"score":0-100,"effect":"\u2193|~|\u2191|\u2191\u2191","desc":"string"},"verdict":"Excellent|Good|Neutral|Caution|Avoid","advice":"string"}`;

    const content = imageB64
      ? [{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:imageB64 }},
         { type:'text', text: foodName ? `Analyse this food. Label: "${foodName}"` : 'Analyse this food.' }]
      : `Analyse "${foodName}" from an Ayurvedic perspective.`;

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_FOR_AYURFOOD;
    if (!apiKey) {
      console.error('No Anthropic API key configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Analysis unavailable' }) };
    }

    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1400,
      system: systemPrompt,
      messages: [{ role: 'user', content }]
    });

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(requestBody)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });

    if (result.status !== 200) {
      let msg = 'API error';
      try { msg = JSON.parse(result.body).error?.message || msg; } catch (e) {}
      console.error('Anthropic API error', result.status, msg);
      return { statusCode: result.status, headers, body: JSON.stringify({ error: msg }) };
    }

    const data = JSON.parse(result.body);
    const raw = (data.content || []).map(c => c.text || '').join('').trim();
    const clean = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();

    // Coerce every dosha score to an integer in 0..100 before it leaves the
    // server. The client renders r.vata.score directly, so a non-numeric or
    // fractional value from the model would surface as NaN or as a decimal in
    // the score circle. Anything unparseable falls back to 50 (neutral).
    // If the payload will not parse at all, pass the original text through
    // unchanged so the existing client-side error path still applies.
    let out = clean;
    try {
      const obj = JSON.parse(clean);
      ['vata', 'pitta', 'kapha'].forEach(k => {
        const n = Math.round(Number(obj && obj[k] && obj[k].score));
        if (obj && obj[k] && typeof obj[k] === 'object') {
          obj[k].score = Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 50;
        }
      });
      out = JSON.stringify(obj);
    } catch (e) {
      console.warn('analyse: score normalisation skipped —', e.message);
    }

    return { statusCode: 200, headers, body: out };

  } catch (err) {
    console.error('analyse error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
