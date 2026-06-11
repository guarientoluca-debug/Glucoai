const https = require('https');

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    const body = JSON.parse(event.body);
    const { readings, insulin, sensors, meals, libreData, insulinConfig } = body;

    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    const REPO = process.env.GITHUB_REPO; // es. "guarientoluca-debug/diabete-tracker"

    if (!GITHUB_TOKEN || !REPO) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'GitHub token non configurato' }) };
    }

    const content = JSON.stringify({ readings, insulin, sensors, meals, libreData, insulinConfig, savedAt: new Date().toISOString() }, null, 2);
    const contentBase64 = Buffer.from(content).toString('base64');

    // Controlla se il file esiste già (per ottenere lo SHA)
    let sha = null;
    const getRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${REPO}/contents/user-data.json`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'DiabeteTracker',
          'Accept': 'application/vnd.github.v3+json'
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });

    if (getRes.status === 200) sha = getRes.data.sha;

    // Salva il file
    const putPayload = JSON.stringify({
      message: `sync: aggiorna dati utente ${new Date().toISOString().slice(0,10)}`,
      content: contentBase64,
      ...(sha ? { sha } : {})
    });

    const putRes = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.github.com',
        path: `/repos/${REPO}/contents/user-data.json`,
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${GITHUB_TOKEN}`,
          'User-Agent': 'DiabeteTracker',
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(putPayload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', reject);
      req.write(putPayload);
      req.end();
    });

    if (putRes.status === 200 || putRes.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    } else {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `GitHub API error: ${putRes.status}` }) };
    }

  } catch(err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
