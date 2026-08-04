// netlify/functions/analyse.js
// Proxies food analysis to the Anthropic API so the key never reaches the client.
//
// No npm dependencies — Node builtins only.
//
// Required Netlify env vars:
//   ANTHROPIC_API_KEY  (or ANTHROPIC_API_KEY_FOR_AYURFOOD)

const https = require('https');

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

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };
  }

  try {
    const { foodName, imageB64, dosha } = JSON.parse(event.body || '{}');

    const ctx = doshaContext(dosha);

    const systemPrompt = `You are a classical Ayurvedic nutritionist. ${ctx} Return ONLY JSON: {"foodName":"string","emoji":"emoji","category":"string","rasa":"string","virya":"Heating or Cooling","vipaka":"Sweet or Sour or Pungent","tastes":["Sweet"],"season":"string","vata":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"pitta":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"kapha":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"verdict":"Excellent|Good|Neutral|Caution|Avoid","advice":"string"}`;

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
      max_tokens: 1024,
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

    return { statusCode: 200, headers, body: clean };

  } catch (err) {
    console.error('analyse error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
