const https = require('https');

function makeRequest(options, payload) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
          },
          body: data || JSON.stringify({ error: 'Empty response from upstream' })
        });
      });
    });
    req.on('error', (e) => {
      resolve({
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: e.message })
      });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch(e) {
    return {
      statusCode: 400,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON: ' + e.message })
    };
  }

  // ── Replicate image generation ─────────────────────────────────────────
  if (body.service === 'replicate') {
    const replicateKey = process.env.REPLICATE_API_KEY;
    if (!replicateKey) {
      return {
        statusCode: 500,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'REPLICATE_API_KEY not set' })
      };
    }

    if (body.predictionId) {
      // Poll existing prediction
      return makeRequest({
        hostname: 'api.replicate.com',
        path: '/v1/predictions/' + body.predictionId,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + replicateKey,
          'Content-Type': 'application/json'
        }
      }, null);
    } else {
      // Use FLUX Pro model
      const payload = JSON.stringify({ input: body.input });
      return makeRequest({
        hostname: 'api.replicate.com',
        path: '/v1/models/black-forest-labs/flux-pro/predictions',
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + replicateKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, payload);
    }
  }

  // ── Anthropic chat ─────────────────────────────────────────────────────
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' })
    };
  }

  const payload = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    system: body.system || 'You are a helpful wardrobe assistant for At The Style Table.',
    messages: body.messages
  });

  return makeRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
};
