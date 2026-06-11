const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    if (!GITHUB_TOKEN || !GITHUB_REPO) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Configurazione GitHub mancante' }) };

    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/contents/user-data.json`,
      method: 'GET',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'diabete-tracker',
        'Accept': 'application/vnd.github.v3+json',
      }
    };

    const result = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
          catch(e) { resolve({ status: res.statusCode, raw: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    if (result.status === 404) {
      return { statusCode: 200, headers, body: JSON.stringify({ data: null }) };
    }

    if (result.status === 200) {
      const content = Buffer.from(result.data.content, 'base64').toString('utf8');
      return { statusCode: 200, headers, body: JSON.stringify({ data: JSON.parse(content) }) };
    }

    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore GitHub', status: result.status }) };
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
