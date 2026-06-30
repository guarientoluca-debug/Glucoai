const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMTP_PASSWORD = process.env.ARUBA_SMTP_PASSWORD;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Chiamata Claude per analisi clinica ──────────────────────────────────
async function generaAnalisiAI(datiPaziente) {
  if (!ANTHROPIC_KEY) return null;

  const prompt = `Sei un assistente diabetologico. Analizza i dati settimanali di un paziente con diabete di tipo 1 e genera un report clinico in HTML.

DATI SETTIMANALE:
- Media glicemica: ${datiPaziente.avg} mg/dL (target: 120 mg/dL)
- Tempo in range (70-180): ${datiPaziente.tir}%
- Ipoglicemie (<70): ${datiPaziente.ipo}
- Iperglicemie (>180): ${datiPaziente.iper}
- Minimo: ${datiPaziente.minV} mg/dL
- Massimo: ${datiPaziente.maxV} mg/dL
- Misurazioni totali: ${datiPaziente.totalReadings}
- Dosi rapide registrate: ${datiPaziente.rapidCount}
- Pasti registrati: ${datiPaziente.mealsCount}
- Carboidrati totali: ${datiPaziente.totalCarbs}g
- Schema dosi prescritte: colazione ${datiPaziente.doseBase.colazione || '?'}U, pranzo ${datiPaziente.doseBase.pranzo || '?'}U, cena ${datiPaziente.doseBase.cena || '?'}U
- Rapporto insulina/carbo: ${datiPaziente.carbRatio || '?'} g/U
- Carbo di riferimento: colazione ${datiPaziente.carboRif.colazione || '?'}g, pranzo ${datiPaziente.carboRif.pranzo || '?'}g, cena ${datiPaziente.carboRif.cena || '?'}g
${datiPaziente.topMeals ? `- Pasti registrati (top 5 per carbo):\n${datiPaziente.topMeals}` : ''}

ISTRUZIONI:
Genera SOLO il contenuto HTML (senza <html>, <head>, <body>, <DOCTYPE>) con queste sezioni:
1. <h2>📊 Report Settimanale [date]: [titolo breve]</h2>
2. Un paragrafo introduttivo con valutazione generale
3. <h3>✅ Cosa sta funzionando</h3> con <ul> di 2-3 punti
4. <h3>⚠️ Aree di miglioramento</h3> con <ul> di 2-3 punti
5. <h3>💉 Valutazione del Rapporto Insulina/Carbo (${datiPaziente.carbRatio || '?'}g per 1U)</h3> con analisi e suggerimenti
6. <h3>💪 Messaggio Motivazionale</h3> con incoraggiamento personalizzato
7. <p><em>⚕️ Questo report non sostituisce il parere medico. Condividetelo con il vostro team diabetologico prima di modificare la terapia insulinica.</em></p>

Usa il "voi" formale. Sii specifico e cita i dati. Rispondi SOLO con HTML, niente markdown, niente backtick.`;

  const body = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.map(c => c.text || '').join('') || '';
          resolve(text || null);
        } catch (e) {
          console.log('Errore parsing AI:', e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { console.log('Errore AI:', e.message); resolve(null); });
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Handler principale ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (!SUPABASE_KEY || !SMTP_PASSWORD) {
    return { statusCode: 500, body: `Variabili mancanti: KEY=${!!SUPABASE_KEY} SMTP=${!!SMTP_PASSWORD}` };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, email, nome')
    .not('email', 'is', null);

  if (error) return { statusCode: 500, body: `Errore Supabase: ${error.message}` };
  if (!profiles?.length) return { statusCode: 200, body: 'Nessun profilo con email' };

  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();

  const transporter = nodemailer.createTransport({
    host: 'smtps.aruba.it',
    port: 465,
    secure: true,
    auth: { user: 'info@glucoai.it', pass: SMTP_PASSWORD }
  });

  let sent = 0;

  for (const profile of profiles) {
    if (!profile.email) continue;

    // ── Recupera dati ──
    const { data: readings } = await supabase.from('readings').select('value, date').eq('user_id', profile.id).gte('date', weekAgo);
    const { data: libreRows } = await supabase.from('libre_data').select('value, date').eq('user_id', profile.id).gte('date', weekAgo);
    const { data: meals } = await supabase.from('meals').select('carbs, timing, date').eq('user_id', profile.id).gte('date', weekAgo);
    const { data: insulin } = await supabase.from('insulin').select('units, type, date').eq('user_id', profile.id).gte('date', weekAgo);
    const { data: config } = await supabase.from('insulin_config').select('*').eq('user_id', profile.id).single();

    const allGlucose = [
      ...(readings || []).map(r => r.value),
      ...(libreRows || []).map(r => r.value)
    ];

    if (allGlucose.length === 0) continue;

    // ── Calcola statistiche ──
    const avg = Math.round(allGlucose.reduce((a, b) => a + b, 0) / allGlucose.length);
    const tir = Math.round(allGlucose.filter(v => v >= 70 && v <= 180).length / allGlucose.length * 100);
    const ipo = allGlucose.filter(v => v < 70).length;
    const iper = allGlucose.filter(v => v > 180).length;
    const minV = Math.min(...allGlucose);
    const maxV = Math.max(...allGlucose);
    const rapidCount = (insulin || []).filter(i => i.type?.toLowerCase() === 'rapida').length;
    const totalCarbs = (meals || []).reduce((s, m) => s + (m.carbs || 0), 0);

    const tirColor = tir >= 70 ? '#22c55e' : tir >= 50 ? '#f59e0b' : '#ef4444';
    const nome = profile.nome?.split(' ')[0] || 'Paziente';
    const dateFrom = new Date(weekAgo).toLocaleDateString('it-IT');
    const dateTo = new Date().toLocaleDateString('it-IT');

    // ── Top 5 pasti per carbo (per l'AI) ──
    const sortedMeals = (meals || [])
      .filter(m => m.carbs > 0)
      .sort((a, b) => b.carbs - a.carbs)
      .slice(0, 5);
    const topMeals = sortedMeals.map(m => {
      const d = new Date(m.date).toLocaleDateString('it-IT');
      return `  ${d} ${m.timing || ''}: ${m.carbs}g carbo`;
    }).join('\n');

    // ── Dati per l'AI ──
    const doseBase = config?.dose_per_pasto || {};
    const carboRif = config?.carbo_riferimento || {};
    const carbRatio = config?.carb_ratio || null;

    // ── Genera analisi AI ──
    const analisiHTML = await generaAnalisiAI({
      avg, tir, ipo, iper, minV, maxV,
      totalReadings: allGlucose.length,
      rapidCount,
      mealsCount: (meals || []).length,
      totalCarbs,
      doseBase,
      carboRif,
      carbRatio,
      topMeals,
      dateFrom,
      dateTo
    });

    // ── Rapporto adattivo (dal vecchio report) ──
    let adattivoHTML = '';
    if (config?.carb_ratio) {
      adattivoHTML = `
    <div style="background:#f0fdf4;border-radius:10px;padding:12px;margin-top:16px">
      <strong>🧠 Parametri attuali</strong><br/>
      <small>Schema dosi:</small><br/>
      <strong>colazione</strong>: ${doseBase.colazione || '?'}U ·
      <strong>pranzo</strong>: ${doseBase.pranzo || '?'}U ·
      <strong>cena</strong>: ${doseBase.cena || '?'}U
      <br/><small>Rapporto I:C: <strong>${carbRatio}g/U</strong> ·
      Carbo rif.: col ${carboRif.colazione || '?'}g · pranzo ${carboRif.pranzo || '?'}g · cena ${carboRif.cena || '?'}g</small>
    </div>`;
    }

    // ── Componi email ──
    const htmlEmail = `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif;background:#f0f4f8;margin:0;padding:20px;color:#1e293b}
  .container{max-width:600px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)}
  .header{background:linear-gradient(135deg,#E84545,#c0392b);padding:24px;text-align:center;color:#fff}
  .header h1{margin:0;font-size:22px;font-weight:800}
  .header p{margin:6px 0 0;opacity:.85;font-size:13px}
  .content{padding:24px}
  .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}
  .stat{background:#f8fafc;border-radius:10px;padding:12px;text-align:center}
  .stat-val{font-size:24px;font-weight:800}
  .stat-label{font-size:10px;color:#94a3b8;text-transform:uppercase;margin-top:2px}
  .tir-bar{background:#e2e8f0;border-radius:6px;height:12px;margin:6px 0;overflow:hidden}
  .tir-fill{height:12px;border-radius:6px;background:${tirColor};width:${tir}%}
  .info-row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
  .footer{background:#f8fafc;padding:16px;text-align:center;font-size:11px;color:#94a3b8}
  p{font-size:14px;line-height:1.6;color:#475569}
  h2{font-size:16px;margin:20px 0 8px;color:#1e293b}
  h3{font-size:14px;margin:16px 0 6px;color:#1e293b}
  ul{margin:4px 0 12px;padding-left:20px}
  li{font-size:14px;line-height:1.6;color:#475569;margin-bottom:4px}
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🩸 GlucoAI — Report Settimanale</h1>
    <p>${dateFrom} → ${dateTo}</p>
  </div>
  <div class="content">
    <p>Ciao <strong>${nome}</strong>! Ecco il riepilogo della tua settimana 👇</p>
    <div class="stat-grid">
      <div class="stat"><div class="stat-val" style="color:${avg<=180?'#22c55e':'#ef4444'}">${avg}</div><div class="stat-label">Media mg/dL</div></div>
      <div class="stat"><div class="stat-val" style="color:${tirColor}">${tir}%</div><div class="stat-label">Tempo in range</div></div>
      <div class="stat"><div class="stat-val" style="color:${ipo===0?'#22c55e':'#ef4444'}">${ipo}</div><div class="stat-label">Ipoglicemie</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">Tempo in range (70–180 mg/dL)</div>
      <div class="tir-bar"><div class="tir-fill"></div></div>
      <div style="font-size:11px;color:#64748b">${tir}% • Obiettivo ADA: ≥70%</div>
    </div>
    ${analisiHTML || `
    <div style="background:#f8fafc;border-radius:10px;padding:16px;margin:16px 0">
      <div class="info-row"><span>📉 Minimo</span><span><strong>${minV} mg/dL</strong></span></div>
      <div class="info-row"><span>📈 Massimo</span><span><strong>${maxV} mg/dL</strong></span></div>
      <div class="info-row"><span>🔴 Iperglicemie (>180)</span><span><strong>${iper}</strong></span></div>
      <div class="info-row"><span>💉 Dosi rapide</span><span><strong>${rapidCount}</strong></span></div>
      <div class="info-row" style="border:none"><span>🍽️ Carboidrati totali</span><span><strong>${totalCarbs}g</strong></span></div>
    </div>
    ${tir >= 70 ? '<p>✅ <strong>Ottimo lavoro!</strong> Il tuo tempo in range è sopra l\'obiettivo del 70%!</p>'
      : tir >= 50 ? '<p>⚠️ Il tempo in range è migliorabile. Apri GlucoAI per analizzare pasti e dosi.</p>'
      : '<p>🔴 Il tempo in range è sotto il 50%. Ti consigliamo di condividere questo report con il tuo diabetologo.</p>'}
    `}
    ${adattivoHTML}
  </div>
  <div class="footer">📱 GlucoAI · <a href="https://glucoai.it" style="color:#E84545;text-decoration:none">glucoai.it</a></div>
</div>
</body>
</html>`;

    await transporter.sendMail({
      from: '"GlucoAI" <info@glucoai.it>',
      to: profile.email,
      subject: `🩸 Il tuo report GlucoAI — TIR ${tir}% questa settimana`,
      html: htmlEmail
    });

    sent++;
  }

  return { statusCode: 200, body: `Email inviate: ${sent} su ${profiles.length} pazienti` };
};
