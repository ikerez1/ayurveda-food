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
    const { priceId, email, userId, siteUrl } = JSON.parse(event.body || '{}');
    if (!priceId) return { statusCode: 400, headers, body: '{"error":"Missing priceId"}' };

    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const params = new URLSearchParams({
      mode: 'subscription',
      'payment_method_types[]': 'card',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${siteUrl}?payment=success`,
      cancel_url: `${siteUrl}?payment=cancelled`,
      client_reference_id: userId || '',
    });
    if (email) params.append('customer_email', email);

    const body = params.toString();

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.stripe.com',
        path: '/v1/checkout/sessions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    const data = JSON.parse(result.body);
    if (result.status !== 200) return { statusCode: result.status, headers, body: JSON.stringify({ error: data.error?.message || 'Stripe error' }) };

    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
