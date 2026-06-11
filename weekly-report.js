const https = require('https');
const fs = require('fs');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const USER_EMAIL = process.env.USER_EMAIL;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sendEmail(to, subject, htmlContent) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: 'noreply@diabete-tracker.app', name: 'Diabete Tracker' },
      subject,
      content: [{ type: 'text/html', value: htmlContent }]
    });
    const req = https.request({
      hostname: 'api.sendgrid.com',
      path: '/v3/mail/send',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SENDGRID_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    // Leggi dati utente
    if (!fs.existsSync('user-data.json')) {
      console.log('❌ Nessun dato utente trovato');
      process.exit(0);
    }
    const userData = JSON.parse(fs.readFileSync('user-data.json', 'utf8'));
    const { readings, insulin, meals, libreData, insulinConfig } = userData;

    // Filtra ultima settimana
    const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
    const weekReadings = (readings || []).filter(r => r.date >= weekAgo);
    const weekInsulin = (insulin || []).filter(i => i.date >= weekAgo);
    const weekMeals = (meals || []).filter(m => m.date >= weekAgo);
    const weekLibre = (libreData || []).filter(r => r.date >= weekAgo);

    const allGlucose = [...weekReadings, ...weekLibre].map(r => r.value);
    if (allGlucose.length === 0) {
      console.log('⚠️ Nessun dato glicemico questa settimana');
      process.exit(0);
    }

    const avg = Math.round(allGlucose.reduce((a,b) => a+b, 0) / allGlucose.length);
    const tir = Math.round(allGlucose.filter(v => v >= 70 && v <= 180).length / allGlucose.length * 100);
    const minV = Math.min(...allGlucose);
    const maxV = Math.max(...allGlucose);
    const ipoCount = allGlucose.filter(v => v < 70).length;
    const iperCount = allGlucose.filter(v => v > 180).length;

    // Analisi pasti con risultati glicemici
    const mealPairs = weekMeals.map(m => {
      const mealTime = new Date(m.date).getTime();
      const postGlucose = weekReadings.filter(r =>
        r.timing === 'post-pasto' &&
        new Date(r.date).getTime() > mealTime &&
        new Date(r.date).getTime() - mealTime <= 3*3600000
      ).sort((a,b) => new Date(a.date)-new Date(b.date))[0];
      const dose = weekInsulin.filter(i =>
        i.type === 'rapida' &&
        Math.abs(new Date(i.date).getTime() - mealTime) <= 30*60000
      )[0];
      return { carbo: m.carbs, timing: m.timing, dose: dose?.units, postGlucose: postGlucose?.value };
    }).filter(m => m.carbo > 0);

    // Prompt AI
    const prompt = `Sei un diabetologo esperto. Analizza la settimana diabetologica di questo paziente e scrivi un report settimanale in italiano.

DATI SETTIMANA:
- Misurazioni glicemia: ${allGlucose.length} (glucometro: ${weekReadings.length}, Libre: ${weekLibre.length})
- Media glicemica: ${avg} mg/dL
- TIR (70-180): ${tir}%
- Min: ${minV} mg/dL, Max: ${maxV} mg/dL
- Episodi ipoglicemia (<70): ${ipoCount}
- Episodi iperglicemia (>180): ${iperCount}
- Dosi insulina rapida: ${weekInsulin.filter(i=>i.type==='rapida').length}
- Dosi insulina lenta: ${weekInsulin.filter(i=>i.type==='lenta').length}
- Pasti registrati: ${weekMeals.length}
${mealPairs.length > 0 ? `
Pasti con dati completi:
${mealPairs.slice(0,5).map(m => `- ${m.timing}: ${m.carbo}g carbo${m.dose ? `, ${m.dose}U insulina` : ''}${m.postGlucose ? `, glicemia post ${m.postGlucose} mg/dL` : ''}`).join('\n')}` : ''}

Configurazione attuale:
- Rapporto insulina/carbo: ${insulinConfig?.carbRatio || 'non configurato'} g/U
- Target glicemia: ${insulinConfig?.targetGlucose || 'non configurato'} mg/dL
- ISF: ${insulinConfig?.isf || 'non configurato'} mg/dL per U

Scrivi un report HTML con:
1. Titolo della settimana (es. "Settimana buona" o "Settimana da migliorare")
2. Statistiche principali in evidenza
3. Cosa è andato bene
4. Cosa migliorare
5. Suggerimento sul rapporto insulina/carbo (se i dati lo permettono)

Usa HTML semplice con stili inline. Sii diretto e incoraggiante. Max 400 parole.`;

    console.log('🤖 Chiamata Claude per analisi...');
    const aiResponse = await callAnthropic(prompt);
    const reportHtml = aiResponse?.content?.[0]?.text || '<p>Report non disponibile</p>';

    // Email HTML
    const emailHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;background:#f0f4f8">
  <div style="background:#fff;border-radius:16px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <h1 style="color:#1e293b;font-size:20px;margin-bottom:4px">🩺 Diabete Tracker</h1>
    <p style="color:#94a3b8;font-size:13px;margin-bottom:20px">Report settimanale — ${new Date().toLocaleDateString('it-IT', {day:'2-digit',month:'long',year:'numeric'})}</p>
    <div style="display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap">
      <div style="flex:1;min-width:100px;background:#f0fdf4;border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:11px;color:#16a34a;font-weight:700">MEDIA</div>
        <div style="font-size:24px;font-weight:800;color:#15803d">${avg}</div>
        <div style="font-size:10px;color:#94a3b8">mg/dL</div>
      </div>
      <div style="flex:1;min-width:100px;background:${tir>=70?'#f0fdf4':tir>=50?'#fffbeb':'#fef2f2'};border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:11px;color:${tir>=70?'#16a34a':tir>=50?'#d97706':'#dc2626'};font-weight:700">TIR</div>
        <div style="font-size:24px;font-weight:800;color:${tir>=70?'#15803d':tir>=50?'#b45309':'#b91c1c'}">${tir}%</div>
        <div style="font-size:10px;color:#94a3b8">70-180 mg/dL</div>
      </div>
      <div style="flex:1;min-width:100px;background:#fef2f2;border-radius:12px;padding:12px;text-align:center">
        <div style="font-size:11px;color:#dc2626;font-weight:700">IPO</div>
        <div style="font-size:24px;font-weight:800;color:#b91c1c">${ipoCount}</div>
        <div style="font-size:10px;color:#94a3b8">episodi</div>
      </div>
    </div>
    ${reportHtml}
    <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0"/>
    <p style="font-size:11px;color:#94a3b8;text-align:center">Generato automaticamente da Diabete Tracker · Non sostituisce il parere medico</p>
  </div>
</body>
</html>`;

    console.log('📧 Invio email a', USER_EMAIL);
    const emailResult = await sendEmail(USER_EMAIL, `🩺 Report settimanale diabete — TIR ${tir}%`, emailHtml);
    console.log('Email status:', emailResult.status);

    if (emailResult.status === 202) {
      console.log('✅ Email inviata con successo!');
    } else {
      console.log('❌ Errore invio email:', emailResult.data);
    }

  } catch(err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
