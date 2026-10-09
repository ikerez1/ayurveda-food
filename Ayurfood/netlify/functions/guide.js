// netlify/functions/guide.js
// The conversational Ayurvedic guide: a free-text question in, a grounded
// answer plus named dishes out.
//
// No npm dependencies — Node builtins only, matching every other function here.
//
// Required Netlify env vars (same set analyse.js already uses):
//   ANTHROPIC_API_KEY  (or ANTHROPIC_API_KEY_FOR_AYURFOOD)
//   SUPABASE_URL, SUPABASE_ANON_KEY, ANALYSE_HASH_SALT,
//   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)
// Optional:
//   GUIDE_USER_DAILY (default 30), GUIDE_GUEST_DAILY (default 3)
//
// On the duplicated guard: the four-layer caller guard below is a copy of the
// one in analyse.js rather than a shared module. Netlify bundles each function
// separately, and moving security-critical code out of a working, deployed
// function to prove a bundler behaviour is not a trade worth making blind. If
// the two are ever unified, do it in its own deploy and watch the first
// invocation — a guard that fails to bundle is an open proxy.

const https  = require('https');
const crypto = require('crypto');

// ── Configuration ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ayurveda-food.com,https://www.ayurveda-food.com')
  .split(',').map(s => s.trim()).filter(Boolean);

const GUIDE_USER_DAILY  = Number(process.env.GUIDE_USER_DAILY  || 30);
const GUIDE_GUEST_DAILY = Number(process.env.GUIDE_GUEST_DAILY || 3);

const MAX_QUESTION_LEN = 400;
const MAX_RECENT       = 12;

const SB_URL     = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_ANON    = process.env.SUPABASE_ANON_KEY || '';
const SB_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ||
                   process.env.SUPABASE_SERVICE_KEY || '';
const HASH_SALT  = process.env.ANALYSE_HASH_SALT || '';

const LEGACY_TRIAL_CUTOFF = '2026-08-04T09:42:05Z';
const LEGACY_TRIAL_DAYS   = 7;

const DOSHA_NAMES = { vata: 'Vāta', pitta: 'Pitta', kapha: 'Kapha' };
const DOSHA_Q = {
  vata:  ['Light', 'Dry', 'Cold', 'Mobile'],
  pitta: ['Hot', 'Sharp', 'Light', 'Oily'],
  kapha: ['Heavy', 'Slow', 'Cold', 'Moist'],
};

// ══════════════════════════════════════════════════════════════════════════
// CALLER GUARD  (mirror of analyse.js — see the note at the top of the file)
// ══════════════════════════════════════════════════════════════════════════
const afcGuard = {};

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
    req.on('error', () => resolve({ status: 0, json: null, text: '' }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ status: 0, json: null, text: '' }); });
    if (body) req.write(body);
    req.end();
  });
};

afcGuard.sbHost = function () { return SB_URL.replace(/^https?:\/\//, ''); };

afcGuard.originOf = function (event) {
  const h = event.headers || {};
  const origin = h.origin || h.Origin || '';
  if (origin) return ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : null;
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

afcGuard.bucketKey = function (prefix, value) {
  return prefix + ':' + crypto.createHmac('sha256', HASH_SALT)
    .update(String(value)).digest('hex').slice(0, 32);
};

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

afcGuard.profileOf = async function (userId) {
  if (!SB_URL || !SB_SERVICE) return null;
  const cols = 'subscription_status,subscription_end,stripe_status,trial_start,dosha';
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
  if (res.status !== 200 || !res.json) return { ok: false, used: 0, quota: limit, degraded: true };
  const row = Array.isArray(res.json) ? res.json[0] : res.json;
  if (!row || typeof row.allowed !== 'boolean') {
    return { ok: false, used: 0, quota: limit, degraded: true };
  }
  return { ok: row.allowed, used: row.used, quota: row.quota, degraded: false };
};

// ══════════════════════════════════════════════════════════════════════════
// FOOD LIBRARY
// ══════════════════════════════════════════════════════════════════════════
// The guide may only name foods that exist in the published reference. Giving
// the model the whole library costs a few thousand tokens and buys two things
// that matter more: every suggestion has a real /food/<slug>/ page behind it,
// and the model cannot invent an ingredient or contradict the site.
//
// Cached in module scope, so a warm container answers without a round trip.
let FOOD_CACHE = null;
let FOOD_CACHE_AT = 0;
const FOOD_TTL_MS = 10 * 60 * 1000;

async function loadFoods() {
  if (FOOD_CACHE && Date.now() - FOOD_CACHE_AT < FOOD_TTL_MS) return FOOD_CACHE;
  if (!SB_URL || !SB_SERVICE) return [];
  const cols = 'slug,name,rasa,virya,vipaka,vata_effect,pitta_effect,kapha_effect';
  const res = await afcGuard.request({
    hostname: afcGuard.sbHost(),
    path: '/rest/v1/foods?status=eq.published&select=' + cols + '&limit=1000',
    method: 'GET',
    headers: {
      'apikey': SB_SERVICE,
      'Authorization': 'Bearer ' + SB_SERVICE,
      'Accept': 'application/json',
    },
  });
  if (res.status !== 200 || !Array.isArray(res.json) || !res.json.length) {
    return FOOD_CACHE || [];
  }
  FOOD_CACHE = res.json;
  FOOD_CACHE_AT = Date.now();
  return FOOD_CACHE;
}

const EFF_SHORT = {
  'strongly decreases': '--', 'decreases': '-', 'neutral': '0',
  'increases': '+', 'strongly increases': '++',
};
function effShort(v) { return EFF_SHORT[String(v || 'neutral').toLowerCase().trim()] || '0'; }

/** One line per food: enough for the model to reason, short enough to afford. */
function foodLines(rows) {
  return rows.map(r =>
    r.slug + '|' + r.name + '|' + (r.virya || '?') + '|' + (r.rasa || '?') +
    '|V' + effShort(r.vata_effect) + ' P' + effShort(r.pitta_effect) + ' K' + effShort(r.kapha_effect)
  ).join('\n');
}

// ══════════════════════════════════════════════════════════════════════════
// CONTEXT
// ══════════════════════════════════════════════════════════════════════════
function doshaContext(dosha) {
  if (!dosha || typeof dosha !== 'string') return 'The person has not set a prakriti yet — answer generally and say that setting it would sharpen the answer.';
  if (dosha === 'sama') {
    return 'Prakriti: SAMA (tridoṣic). Judge by what maintains equilibrium and suits the season rather than by pacifying one doṣa.';
  }
  const parts = dosha.split('-').filter(k => DOSHA_NAMES[k]);
  if (!parts.length) return 'The person has not set a prakriti yet.';
  if (parts.length === 1) {
    const k = parts[0];
    return 'Prakriti: ' + k.toUpperCase() + ' (' + DOSHA_NAMES[k] + '). Qualities: ' + DOSHA_Q[k].join(', ') + '.';
  }
  const [a, b] = parts;
  return 'Prakriti: ' + a.toUpperCase() + '-' + b.toUpperCase() + ' (' + DOSHA_NAMES[a] + '-' + DOSHA_NAMES[b] +
    '), a dual (dvandvaja) constitution. ' + DOSHA_NAMES[a] + ': ' + DOSHA_Q[a].join(', ') + '. ' +
    DOSHA_NAMES[b] + ': ' + DOSHA_Q[b].join(', ') + '. Both matter roughly equally — do not pacify one at the other\'s expense.';
}

/** Classical ṛtu, mirrored below the equator so July is not winter advice. */
function seasonOf(date, southern) {
  let m = date.getUTCMonth();
  if (southern) m = (m + 6) % 12;
  if (m >= 9 || m === 0) return { key: 'vata',  text: 'Vāta season — cold, dry, windy' };
  if (m >= 1 && m <= 4)  return { key: 'kapha', text: 'Kapha season — damp, heavy, cool' };
  return { key: 'pitta', text: 'Pitta season — hot and sharp' };
}

function kalaOf(hour) {
  if (hour >= 6  && hour < 10) return 'Kapha time of day (morning) — digestion is slow to start';
  if (hour >= 10 && hour < 14) return 'Pitta time of day (midday) — digestion is at its strongest';
  if (hour >= 14 && hour < 18) return 'Vāta time of day (afternoon)';
  if (hour >= 18 && hour < 22) return 'Kapha time of day (evening) — the heaviest meal sits worst here';
  return 'Pitta/Vāta time of night — classical practice is not to eat at this hour';
}

// ══════════════════════════════════════════════════════════════════════════
// HEALTH CLAIM VALIDATOR
// ══════════════════════════════════════════════════════════════════════════
// Regulation (EC) 1924/2006: a statement that a food affects a bodily function
// or reduces disease risk is a health claim and needs authorisation. Describing
// a tradition is not. "Ayurveda traditionally takes ginger before a meal" is
// fine; "ginger aids digestion" is not. Same line the AYUR_HINTS corpus and the
// food generator already hold; enforced here because this text is generated per
// request and can never be reviewed in advance.
const CLAIM_PATTERNS = [
  // "treat" is deliberately NOT matched on its own: "Ayurveda treats ginger as
  // warming" is exactly the phrasing the prompt asks for. Only the therapeutic
  // senses are caught.
  /\b(cure|cures|cured|curing|heals?|healing|remed(y|ies))\b/i,
  /\btreatment\s+for\b|\btreats?\s+\w+\s+(disease|condition|symptoms?|illness)\b/i,
  /\b(prevent|prevents|preventing|protects? against|reduces? the risk)\b/i,
  /\b(boost|boosts|boosting|strengthens?|improves?|enhances?|supports?)\s+(your\s+)?(immunity|immune|metabolism|digestion|liver|heart|brain|memory|energy levels)\b/i,
  /\b(detox|detoxif\w*|cleanse|cleansing)\b/i,
  /\b(weight loss|lose weight|burns? fat|slimming)\b/i,
  /\b(lowers?|reduces?|raises?)\s+(blood\s+)?(sugar|pressure|cholesterol|inflammation|glucose)\b/i,
  /\b(diabet\w*|cancer|arthritis|depression|anxiety disorder|ibs|crohn\w*|hypertension)\b/i,
  // Naming a symptom is itself the risk, whatever verb sits next to it.
  /\b(indigestion|bloating|constipation|acid reflux|heartburn|nausea|insomnia|migraines?|headaches?)\b/i,
  /\b(anti-?inflammatory|antioxidant|immune[- ]boosting|medicinal|therapeutic)\b/i,
  /\b(diagnos\w+|prescrib\w+|dosage)\b|\d\s*(mg|g|ml)\b/i,
];

function claimIssues(text) {
  const s = String(text || '');
  const hits = [];
  CLAIM_PATTERNS.forEach((re) => { const m = s.match(re); if (m) hits.push(m[0]); });
  return hits;
}

/** Every string a payload would show the user, flattened for checking. */
function payloadText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const bits = [obj.answer || ''];
  ['picks', 'avoid'].forEach(k => {
    (Array.isArray(obj[k]) ? obj[k] : []).forEach(p => bits.push((p && p.why) || ''));
  });
  return bits.join(' \n ');
}

// ══════════════════════════════════════════════════════════════════════════
// PROMPT
// ══════════════════════════════════════════════════════════════════════════
function buildSystemPrompt(ctx) {
  return `You are a classical Ayurvedic nutrition guide inside an app. You answer one practical question about what to eat, for one person, right now.

THE PERSON
${ctx.dosha}
Season: ${ctx.season}
Time where they are: ${ctx.kala} (local hour ${ctx.hour})
${ctx.recent ? 'What they have eaten recently, with the app\'s score for their constitution:\n' + ctx.recent : 'No recent meals recorded.'}

THE FOOD LIBRARY — the only foods you may name
Each line is: slug|name|vīrya|rasa|effect on Vāta/Pitta/Kapha (-- strongly decreases, - decreases, 0 neutral, + increases, ++ strongly increases).
${ctx.foods}

RULES
1. You may only name foods that appear in the library above, and you must use the exact slug. A dish may combine several of them — say so in words, but every slug you return must be from the list.
2. Reason from rasa, vīrya, vipāka, the season, the hour and what they ate recently. Say which of these drove your answer.
3. Be concrete and short. Two or three sentences of answer, then the picks. Speak to the person directly, in plain English, second person.
4. Never invent a food, a slug, or a property.
5. If the question is not about food, eating, or Ayurvedic diet, say briefly that this is what you can help with, and return empty picks.

LANGUAGE — this is a legal requirement, not a style note
You are writing for an EU audience under Regulation (EC) 1924/2006. Describe traditional practice and the qualities of foods. NEVER state or imply that a food affects a bodily function, treats, prevents or reduces the risk of any condition, aids digestion, boosts immunity, detoxifies, reduces inflammation, or causes weight loss. Do not name diseases. Do not give dosages.
Write "Ayurveda treats ginger as warming and takes it before a meal", never "ginger aids digestion".
Never give medical advice. If the question describes symptoms or illness, answer only about food qualities and suggest they speak to a qualified practitioner.

OUTPUT
Return ONLY JSON, no preamble and no markdown fences:
{"answer":"2-3 sentences","picks":[{"slug":"exact-slug","name":"Name","why":"under 14 words"}],"avoid":[{"slug":"exact-slug","name":"Name","why":"under 14 words"}]}
Give 2 to 4 picks and 0 to 3 avoids.`;
}

// ══════════════════════════════════════════════════════════════════════════
// RESPONSE SHAPING
// ══════════════════════════════════════════════════════════════════════════
/** Drops anything the model named that is not in the library, and trims. */
function sanitise(obj, rows) {
  const bySlug = {};
  rows.forEach(r => { bySlug[r.slug] = r; });
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map(p => {
      if (!p || typeof p !== 'object') return null;
      const row = bySlug[String(p.slug || '').trim()];
      if (!row) return null;
      return { slug: row.slug, name: row.name, why: String(p.why || '').slice(0, 90) };
    })
    .filter(Boolean)
    .slice(0, 4);
  return {
    answer: String((obj && obj.answer) || '').slice(0, 900),
    picks: clean(obj && obj.picks),
    avoid: clean(obj && obj.avoid).slice(0, 3),
  };
}

function callAnthropic(apiKey, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(25000, () => { req.destroy(); reject(new Error('Upstream timeout')); });
    req.write(body);
    req.end();
  });
}

function parseModelJson(result) {
  const data = JSON.parse(result.body);
  const raw = (data.content || []).map(c => c.text || '').join('').trim();
  const clean = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();
  return JSON.parse(clean);
}

// ══════════════════════════════════════════════════════════════════════════
// HANDLER
// ══════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
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

  // ── Layer 0: an unconfigured guard is an open proxy. Fail closed.
  if (!SB_URL || !SB_ANON || !SB_SERVICE || !HASH_SALT) {
    console.error('guide: guard not configured — check SUPABASE_URL, SUPABASE_ANON_KEY, ' +
                  'ANALYSE_HASH_SALT, and one of SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY');
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'The guide is temporarily unavailable' }) };
  }

  // ── Layer 1: origin.
  if (!allowedOrigin) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const question = String(body.question || '').trim();
    const dosha    = body.dosha;

    // ── Layer 2: size.
    if (!question) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Nothing to answer' }) };
    }
    if (question.length > MAX_QUESTION_LEN) {
      return { statusCode: 413, headers,
               body: JSON.stringify({ error: 'That question is too long — please shorten it' }) };
    }

    // ── Layer 3: identity and entitlement.
    const authHdr = event.headers?.authorization || event.headers?.Authorization || '';
    const token   = authHdr.replace(/^Bearer\s+/i, '').trim();

    let quotaKey, quotaLimit, profileDosha = null;

    if (token) {
      const userId = await afcGuard.userFromToken(token);
      if (!userId) {
        return { statusCode: 401, headers,
                 body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
      }
      const prof  = await afcGuard.profileOf(userId);
      const state = afcGuard.entitlement(prof);
      if (state !== 'active' && state !== 'trial') {
        return { statusCode: 402, headers,
                 body: JSON.stringify({ error: 'The guide is part of Compass+',
                                        reason: 'subscription_required' }) };
      }
      profileDosha = prof && prof.dosha;
      quotaKey   = 'gu:' + userId;
      quotaLimit = GUIDE_USER_DAILY;
    } else {
      // The 7-day window lives in localStorage and cannot be verified here, so
      // the IP quota is what actually bounds anonymous spend on a paid feature.
      const ip = afcGuard.clientIp(event);
      if (!ip) return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
      quotaKey   = afcGuard.bucketKey('gg', ip);
      quotaLimit = GUIDE_GUEST_DAILY;
    }

    // ── Layer 4: quota.
    const quota = await afcGuard.consume(quotaKey, quotaLimit);
    if (quota.degraded) {
      if (!token) {
        return { statusCode: 503, headers, body: JSON.stringify({ error: 'The guide is temporarily unavailable' }) };
      }
      console.warn('guide: quota store unreachable, allowing verified account');
    } else if (!quota.ok) {
      return { statusCode: 429, headers,
               body: JSON.stringify({
                 error: token
                   ? 'You have reached today\'s limit for the guide — it resets tomorrow'
                   : 'Daily limit reached. Create an account to keep asking.',
                 reason: 'rate_limited', used: quota.used, quota: quota.quota }) };
    }

    // ── Grounding.
    const rows = await loadFoods();
    if (!rows.length) {
      return { statusCode: 503, headers,
               body: JSON.stringify({ error: 'The food reference is unavailable right now' }) };
    }

    const now      = new Date();
    const hour     = Number.isFinite(Number(body.hour)) ? Math.min(23, Math.max(0, Math.round(Number(body.hour)))) : now.getUTCHours();
    const southern = body.southern === true;
    const season   = seasonOf(now, southern);

    const recent = (Array.isArray(body.recent) ? body.recent : [])
      .slice(0, MAX_RECENT)
      .map(r => {
        const n = String((r && r.name) || '').slice(0, 60);
        const s = Math.round(Number(r && r.score));
        return n ? '- ' + n + (Number.isFinite(s) ? ' (' + Math.min(100, Math.max(0, s)) + '/100)' : '') : '';
      })
      .filter(Boolean).join('\n');

    const systemPrompt = buildSystemPrompt({
      dosha:  doshaContext(dosha || profileDosha),
      season: season.text,
      kala:   kalaOf(hour),
      hour:   hour,
      recent: recent,
      foods:  foodLines(rows),
    });

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_FOR_AYURFOOD;
    if (!apiKey) {
      console.error('guide: no Anthropic API key configured');
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'The guide is unavailable' }) };
    }

    const ask = (extraSystem) => callAnthropic(apiKey, JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 900,
      system: extraSystem ? systemPrompt + '\n\n' + extraSystem : systemPrompt,
      messages: [{ role: 'user', content: question }],
    }));

    let result = await ask(null);
    if (result.status !== 200) {
      let msg = 'The guide could not answer just now';
      try { msg = JSON.parse(result.body).error?.message || msg; } catch (e) {}
      console.error('guide: Anthropic error', result.status, msg);
      return { statusCode: result.status === 429 ? 503 : 502, headers,
               body: JSON.stringify({ error: 'The guide could not answer just now — please try again' }) };
    }

    let payload;
    try { payload = parseModelJson(result); }
    catch (e) {
      console.warn('guide: unparseable model output —', e.message);
      return { statusCode: 502, headers,
               body: JSON.stringify({ error: 'The guide could not answer just now — please try again' }) };
    }

    // ── Health claim check, with one corrective retry.
    let issues = claimIssues(payloadText(payload));
    if (issues.length) {
      console.warn('guide: claim retry on', issues.join(', '));
      const corrective =
        'YOUR PREVIOUS ANSWER WAS REJECTED. It used this wording, which is a health claim under ' +
        'Regulation (EC) 1924/2006: ' + issues.join(', ') + '. ' +
        'Rewrite the whole answer describing only traditional practice and the qualities of the food ' +
        '(warming, cooling, heavy, light, dry, moist, grounding). Name no bodily function, no disease, ' +
        'and no outcome.';
      const retry = await ask(corrective);
      if (retry.status === 200) {
        try {
          const second = parseModelJson(retry);
          if (!claimIssues(payloadText(second)).length) { payload = second; issues = []; }
          else { issues = claimIssues(payloadText(second)); }
        } catch (e) { /* keep the first payload and fall through */ }
      }
    }

    const out = sanitise(payload, rows);

    // Still not clean after the retry: the picks are data from the library and
    // stay, the free text does not. Returning nothing would be worse than
    // returning the part that cannot carry a claim.
    if (claimIssues(payloadText(out)).length) {
      console.error('guide: claim validator failed twice — suppressing generated text');
      out.answer = 'Here is what suits your constitution at this hour and in this season.';
      out.picks = out.picks.map(p => ({ slug: p.slug, name: p.name, why: '' }));
      out.avoid = out.avoid.map(p => ({ slug: p.slug, name: p.name, why: '' }));
    }

    if (!out.answer && !out.picks.length) {
      return { statusCode: 502, headers,
               body: JSON.stringify({ error: 'The guide could not answer just now — please try again' }) };
    }

    out.season = season.key;
    out.remaining = quota.degraded ? null : Math.max(0, (quota.quota || 0) - (quota.used || 0));

    return { statusCode: 200, headers, body: JSON.stringify(out) };

  } catch (err) {
    console.error('guide error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'The guide could not answer just now' }) };
  }
};

// Exported for the offline test harness only; not part of the HTTP surface.
exports._internals = { claimIssues, sanitise, seasonOf, kalaOf, doshaContext, foodLines, buildSystemPrompt, payloadText };
