const https = require('https');
const http = require('http');
const url = require('url');

function makeRequest(options, payload) {
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: 200,
          headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
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

function fetchUrl(targetUrl) {
  return new Promise((resolve) => {
    const parsed = url.parse(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.path,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StyleTableBot/1.0)',
        'Accept': 'text/html'
      },
      timeout: 8000
    };
    const req = lib.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve);
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; if (data.length > 200000) req.destroy(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

function extractMeta(html, targetUrl) {
  const get = (pattern) => {
    const m = html.match(pattern);
    return m ? m[1].replace(/&amp;/g,'&').replace(/&quot;/g,'"').trim() : null;
  };

  const image = get(/property="og:image"\s+content="([^"]+)"/) ||
                get(/content="([^"]+)"\s+property="og:image"/) ||
                get(/property="og:image:url"\s+content="([^"]+)"/) ||
                get(/name="twitter:image"\s+content="([^"]+)"/);

  const title = get(/property="og:title"\s+content="([^"]+)"/) ||
                get(/content="([^"]+)"\s+property="og:title"/) ||
                get(/<title[^>]*>([^<]+)<\/title>/);

  const price = get(/property="product:price:amount"\s+content="([^"]+)"/) ||
                get(/itemprop="price"\s+content="([^"]+)"/) ||
                get(/"price":\s*"?(\$?[\d.,]+)"?/) ||
                get(/class="[^"]*price[^"]*"[^>]*>\s*\$?([\d.,]+)/i);

  // Extract retailer from domain
  const domain = url.parse(targetUrl).hostname || '';
  const retailerMap = {
    'nordstrom.com': 'Nordstrom',
    'net-a-porter.com': 'Net-a-Porter',
    'revolve.com': 'Revolve',
    'gap.com': 'Banana Republic',
    'bananarepublic.com': 'Banana Republic',
    'bloomingdales.com': "Bloomingdale's",
    'moderncitizen.com': 'Modern Citizen',
    'marcellanyc.com': 'Marcella NYC',
    'hueandstripe.com': 'Hue & Stripe',
    'amazon.com': 'Amazon',
    'shopbop.com': 'Shopbop',
    'farfetch.com': 'Farfetch',
    'ssense.com': 'SSENSE',
    'matches.com': 'MatchesFashion',
    'mytheresa.com': 'Mytheresa'
  };
  const retailer = Object.entries(retailerMap).find(([k]) => domain.includes(k))?.[1] || 
                   domain.replace('www.','').split('.')[0];

  return { image, title, price: price ? '$' + price.replace('$','') : null, retailer };
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

  // ── URL fetch & metadata extraction ───────────────────────────────────────
  if (body.service === 'fetch-url') {
    try {
      const html = await fetchUrl(body.url);
      if (!html) throw new Error('Could not fetch page');
      const meta = extractMeta(html, body.url);
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify(meta)
      };
    } catch(e) {
      return {
        statusCode: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: e.message })
      };
    }
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
      return makeRequest({
        hostname: 'api.replicate.com',
        path: '/v1/predictions/' + body.predictionId,
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + replicateKey, 'Content-Type': 'application/json' }
      }, null);
    } else {
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
