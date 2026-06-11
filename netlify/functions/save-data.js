const https = require('https');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO;

function githubRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'User-Agent': 'diabete-tracker',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const { data } = JSON.parse(event.body);
    if (!data) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dati mancanti' }) };
    if (!GITHUB_TOKEN || !GITHUB_REPO) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Configurazione GitHub mancante' }) };

    const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    const filePath = `/repos/${GITHUB_REPO}/contents/user-data.json`;

    // Controlla se il file esiste già (per ottenere SHA)
    const existing = await githubRequest(filePath, 'GET');
    const sha = existing.data?.sha;

    // Crea o aggiorna il file
    const body = {
      message: `sync: aggiorna dati utente ${new Date().toISOString().slice(0,10)}`,
      content,
      ...(sha ? { sha } : {})
    };

    const result = await githubRequest(filePath, 'PUT', body);

    if (result.status === 200 || result.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    } else {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Errore GitHub', detail: result.data }) };
    }
  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
