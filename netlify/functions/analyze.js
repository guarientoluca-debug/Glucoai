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
    let body;
    try { body = JSON.parse(event.body); }
    catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON non valido' }) }; }

    const { imageBase64, mediaType } = body;
    const apiKey = process.env.ANTHROPIC_API_KEY;

    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'imageBase64 mancante' }) };
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chiave API non configurata su Netlify' }) };

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Sei un nutrizionista esperto. Analizza questo piatto. Per ogni alimento riconosci la porzione visibile e i carboidrati per 100g. Rispondi SOLO con JSON valido senza markdown, formato: {"alimenti":[{"nome":"nome alimento","quantita_g":150,"carbo_per_100g":30,"carbo_g":45}],"totale_carbo_g":45,"note":"nota opzionale"}' }
        ]
      }]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      let data = '';
      const req = https.request(options, (res) => {
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', e => reject(e));
      req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(payload);
      req.end();
    });

    // Parse risposta Anthropic
    let anthropicResponse;
    try {
      anthropicResponse = JSON.parse(result);
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta API non valida', raw: result.slice(0, 200) }) };
    }

    // Controlla errori Anthropic (es. chiave non valida, quota esaurita)
    if (anthropicResponse.error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: anthropicResponse.error.message || 'Errore Anthropic' }) };
    }

    const text = anthropicResponse?.content?.[0]?.text;
    if (!text) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta vuota da Claude' }) };
    }

    // Rimuovi eventuali backtick markdown
    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    // Verifica che sia JSON valido prima di restituire
    try {
      JSON.parse(clean);
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude non ha restituito JSON valido', raw: clean.slice(0, 200) }) };
    }

    return { statusCode: 200, headers, body: clean };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
