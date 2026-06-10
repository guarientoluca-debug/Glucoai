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

    let messages;

    // ── Modalità 1: analisi foto pasto ───────────────────────────────────────
    if (body.imageBase64) {
      const { imageBase64, mediaType } = body;
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: 'Sei un nutrizionista esperto. Analizza questo piatto. Per ogni alimento riconosci la porzione visibile e i carboidrati per 100g. Rispondi SOLO con JSON valido senza markdown, formato: {"alimenti":[{"nome":"nome alimento","quantita_g":150,"carbo_per_100g":30,"carbo_g":45}],"totale_carbo_g":45,"note":"nota opzionale"}' }
        ]
      }];

    // ── Modalità 2: calcolo rapporto insulina/carbo ──────────────────────────
    } else if (body.analysisType === 'insulin-ratio') {
      const { meals, insulin, readings, currentConfig } = body.data;

      // Costruisci sommario dati storici
      const pairs = meals.map(m => {
        const mealTime = new Date(m.date).getTime();
        // Insulina rapida entro 30 min prima o dopo il pasto
        const dose = insulin
          .filter(i => i.type === 'rapida' && Math.abs(new Date(i.date).getTime() - mealTime) <= 30 * 60000)
          .sort((a,b) => Math.abs(new Date(a.date).getTime()-mealTime) - Math.abs(new Date(b.date).getTime()-mealTime))[0];
        // Glicemia post-pasto entro 3h
        const postGlucose = readings
          .filter(r => r.timing === 'post-pasto' && new Date(r.date).getTime() > mealTime && new Date(r.date).getTime() - mealTime <= 3*3600000)
          .sort((a,b) => new Date(a.date)-new Date(b.date))[0];
        if (m.carbs > 0 && dose) {
          return { carbo: m.carbs, unita: dose.units, glicemiaPost: postGlucose?.value || null, data: m.date.slice(0,10) };
        }
        return null;
      }).filter(Boolean);

      if (pairs.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dati insufficienti: registra almeno un pasto con carboidrati e la relativa dose di insulina rapida' }) };
      }

      const datiTesto = pairs.map(p =>
        `- ${p.data}: ${p.carbo}g carbo → ${p.unita}U rapida${p.glicemiaPost ? ` → glicemia post ${p.glicemiaPost} mg/dL` : ''}`
      ).join('\n');

      const configTesto = currentConfig.targetGlucose
        ? `Glicemia target del paziente: ${currentConfig.targetGlucose} mg/dL. ISF attuale: ${currentConfig.isf} mg/dL per unità.`
        : '';

      messages = [{
        role: 'user',
        content: `Sei un diabetologo esperto. Analizza questi dati reali di un paziente diabetico e calcola il rapporto ottimale insulina/carboidrati (quanti grammi di carboidrati coprono 1 unità di insulina rapida).

${configTesto}

Dati storici (${pairs.length} pasti con insulina):
${datiTesto}

Calcola il rapporto ottimale basandoti sui casi in cui la glicemia post-pasto era più vicina al target. Se non ci sono glicemie post disponibili, usa la media dei rapporti osservati.

Rispondi SOLO con JSON valido senza markdown, formato:
{"rapporto_g_per_u": 10, "confidenza": "alta|media|bassa", "spiegazione": "breve spiegazione in italiano", "note_cliniche": "eventuali osservazioni utili", "campioni_usati": 5}`
      }];

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Parametri mancanti: imageBase64 o analysisType richiesto' }) };
    }

    // ── Chiamata API Anthropic ───────────────────────────────────────────────
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
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
