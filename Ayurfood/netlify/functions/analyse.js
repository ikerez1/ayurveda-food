const https = require('https');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: '{"error":"Method not allowed"}' };

  try {
    const { foodName, imageB64, dosha } = JSON.parse(event.body || '{}');

    const doshaNames = { vata:'Vāta', pitta:'Pitta', kapha:'Kapha' };
    const doshaQ = { vata:['Light','Dry','Cold','Mobile'], pitta:['Hot','Sharp','Light','Oily'], kapha:['Heavy','Slow','Cold','Moist'] };
    const ctx = dosha ? `User dosha: ${dosha.toUpperCase()} (${doshaNames[dosha]}). Qualities: ${doshaQ[dosha].join(', ')}.` : 'No dosha set.';

    const systemPrompt = `You are a classical Ayurvedic nutritionist. ${ctx} Return ONLY JSON: {"foodName":"string","emoji":"emoji","category":"string","rasa":"string","virya":"Heating or Cooling","vipaka":"Sweet or Sour or Pungent","tastes":["Sweet"],"season":"string","vata":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"pitta":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"kapha":{"score":0-100,"effect":"↓|~|↑|↑↑","desc":"string"},"verdict":"Excellent|Good|Neutral|Caution|Avoid","advice":"string"}`;

    const content = imageB64
      ? [{ type:'image', source:{ type:'base64', media_type:'image/jpeg', data:imageB64 }},{ type:'text', text: foodName ? `Analyse this food. Label: "${foodName}"` : 'Analyse this food.' }]
      : `Analyse "${foodName}" from an Ayurvedic perspective.`;

    const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY_FOR_AYURFOOD;

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
      const err = JSON.parse(result.body);
      return { statusCode: result.status, headers, body: JSON.stringify({ error: err.error?.message || 'API error' }) };
    }

    const data = JSON.parse(result.body);
    const raw = (data.content || []).map(c => c.text || '').join('').trim();
    const clean = raw.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim();

    return { statusCode: 200, headers, body: clean };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
