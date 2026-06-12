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

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chiave API non configurata su Netlify' }) };

    const { imageBase64, mediaType } = body;
    if (!imageBase64) return { statusCode: 400, headers, body: JSON.stringify({ error: 'imageBase64 mancante' }) };

    const messages = [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: `Sei un esperto di fisiologia dello sport e diabete. Analizza questo screenshot di attività fisica (può essere da Strava, Apple Watch, Garmin, Nike Run, o qualsiasi app fitness).

Estrai tutte le informazioni disponibili e classifica l'intensità dell'attività per un paziente diabetico.

LIVELLI DI INTENSITÀ (scegli uno):
- "sedentario": nessuna attività o attività minima (camminata <20 min)
- "moderato": attività leggera-moderata (camminata >20 min, nuoto lento, yoga, ciclismo leggero)
- "intenso": attività intensa (corsa, nuoto veloce, ciclismo intenso, palestra, sport)

Per il diabete, l'attività fisica aumenta la sensibilità all'insulina:
- moderato: riduzione dose consigliata ~10%
- intenso: riduzione dose consigliata ~20%

Rispondi SOLO con JSON valido senza markdown:
{
  "tipo_attivita": "es. Corsa, Nuoto, Ciclismo, Camminata...",
  "durata_minuti": 60,
  "distanza_km": 5.2,
  "calorie": 450,
  "frequenza_cardiaca_media": 145,
  "intensita": "sedentario|moderato|intenso",
  "riduzione_dose_percentuale": 0,
  "nota": "breve nota in italiano su come questa attività influenza la glicemia",
  "fonte": "Strava|Apple Watch|Garmin|Nike|altro"
}

Se un campo non è visibile nello screenshot, usa null. Il campo intensita e riduzione_dose_percentuale sono obbligatori.` }
      ]
    }];

    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      messages
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

    let anthropicResponse;
    try { anthropicResponse = JSON.parse(result); }
    catch(e) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta API non valida' }) }; }

    if (anthropicResponse.error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: anthropicResponse.error.message || 'Errore Anthropic' }) };
    }

    const text = anthropicResponse?.content?.[0]?.text;
    if (!text) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta vuota da Claude' }) };

    const clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

    try { JSON.parse(clean); }
    catch(e) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude non ha restituito JSON valido', raw: clean.slice(0, 200) }) }; }

    return { statusCode: 200, headers, body: clean };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
