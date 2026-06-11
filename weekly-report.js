const https = require('https');
const fs = require('fs');
const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

if (!GMAIL_USER || !GMAIL_PASSWORD || !ANTHROPIC_API_KEY) {
  console.error('❌ Variabili mancanti');
  process.exit(1);
}

function callClaude(prompt, maxTokens = 2000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    let data = '';
    const req = https.request(options, (res) => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.content?.[0]?.text || '');
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

function getZone(v) {
  if (v < 70)  return 'ipoglicemia';
  if (v <= 99) return 'normale';
  if (v <= 125) return 'pre-diabete';
  if (v <= 180) return 'alta';
  return 'iperglicemia';
}

// ── Apprendimento adattivo ─────────────────────────────────────────────────────
function calculateAdaptiveRatios(meals, insulin, libreData, readings, insulinConfig) {
  const TARGET = insulinConfig.targetGlucose || 120;
  const ISF = insulinConfig.isf || 50;
  const TARGET_MS = 120 * 60000; // 2h dopo il pasto

  // Ultimi 30 giorni
  const monthAgo = Date.now() - 30 * 24 * 3600000;
  const recentMeals = meals.filter(m => new Date(m.date).getTime() > monthAgo);

  const pairs = recentMeals.map(m => {
    const mt = new Date(m.date).getTime();

    // Insulina rapida entro 30 min
    const dose = insulin
      .filter(i => i.type === 'rapida' && Math.abs(new Date(i.date).getTime() - mt) <= 30*60000)
      .sort((a,b) => Math.abs(new Date(a.date).getTime()-mt) - Math.abs(new Date(b.date).getTime()-mt))[0];

    // Glicemia post: prima Libre ~2h dopo, poi glucometro
    const librePost = libreData
      .filter(r => {
        const diff = new Date(r.date).getTime() - mt;
        return diff > 30*60000 && diff <= 210*60000;
      })
      .sort((a,b) => {
        const da = Math.abs(new Date(a.date).getTime() - mt - TARGET_MS);
        const db = Math.abs(new Date(b.date).getTime() - mt - TARGET_MS);
        return da - db;
      })[0];

    const glucPost = readings
      .filter(r => r.timing === 'post-pasto' && new Date(r.date).getTime() > mt && new Date(r.date).getTime() - mt <= 3*3600000)
      .sort((a,b) => new Date(a.date) - new Date(b.date))[0];

    const post = librePost?.value || glucPost?.value || null;

    if (!dose || !post || m.carbs <= 0) return null;

    // Calcola rapporto ideale:
    // Se post > target → serviva più insulina → rapporto più basso
    // Se post < target → serviva meno insulina → rapporto più alto
    const correction = (post - TARGET) / ISF;
    const idealDose = Math.max(0.5, dose.units - correction);
    const idealRatio = m.carbs / idealDose;

    return {
      timing: m.timing,
      carbs: m.carbs,
      dose: dose.units,
      post,
      idealRatio: Math.round(idealRatio * 10) / 10
    };
  }).filter(Boolean);

  if (pairs.length < 3) {
    console.log(`⚠️ Dati insufficienti per apprendimento adattivo (${pairs.length} coppie, servono ≥3)`);
    return null;
  }

  console.log(`🧠 Apprendimento adattivo: ${pairs.length} pasti analizzati`);

  const timings = ['colazione', 'pranzo', 'cena', 'spuntino'];
  const carbRatioPerPasto = {};

  timings.forEach(t => {
    const tPairs = pairs.filter(p => p.timing === t);
    if (tPairs.length >= 2) {
      const avg = tPairs.reduce((s,p) => s + p.idealRatio, 0) / tPairs.length;
      carbRatioPerPasto[t] = Math.round(avg * 2) / 2; // arrotonda a 0.5
      console.log(`  ${t}: ${carbRatioPerPasto[t]}g/U (da ${tPairs.length} pasti)`);
    }
  });

  // Rapporto globale come media di tutti
  const globalAvg = pairs.reduce((s,p) => s + p.idealRatio, 0) / pairs.length;
  const globalRatio = Math.round(globalAvg * 2) / 2;
  console.log(`  Rapporto globale: ${globalRatio}g/U`);

  return { carbRatioPerPasto, globalRatio, updatedAt: new Date().toISOString(), campioni: pairs.length };
}

async function main() {
  // Leggi dati salvati
  let userData = { readings: [], insulin: [], meals: [], libreData: [], insulinConfig: {} };
  if (fs.existsSync('user-data.json')) {
    try { userData = JSON.parse(fs.readFileSync('user-data.json', 'utf8')); } catch(e) {}
  }

  const { readings = [], insulin = [], meals = [], libreData = [], insulinConfig = {} } = userData;

  // Filtra ultimi 7 giorni
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000);
  const weekReadings = readings.filter(r => new Date(r.date) >= weekAgo);
  const weekInsulin = insulin.filter(i => new Date(i.date) >= weekAgo);
  const weekMeals = meals.filter(m => new Date(m.date) >= weekAgo);
  const weekLibre = libreData.filter(r => new Date(r.date) >= weekAgo);

  // Combina glicemie
  const allGlucose = [
    ...weekReadings.map(r => r.value),
    ...weekLibre.map(r => r.value)
  ];

  if (allGlucose.length === 0) {
    console.log('⚠️ Nessun dato questa settimana, email non inviata');
    return;
  }

  const avg = Math.round(allGlucose.reduce((a,b) => a+b, 0) / allGlucose.length);
  const minV = Math.min(...allGlucose);
  const maxV = Math.max(...allGlucose);
  const tir = Math.round(allGlucose.filter(v => v >= 70 && v <= 180).length / allGlucose.length * 100);
  const ipo = allGlucose.filter(v => v < 70).length;
  const iper = allGlucose.filter(v => v > 180).length;

  // Analisi pasti
  const mealResults = weekMeals.map(m => {
    const mealTime = new Date(m.date).getTime();
    const postGlucose = weekReadings
      .filter(r => r.timing === 'post-pasto' && new Date(r.date).getTime() > mealTime && new Date(r.date).getTime() - mealTime <= 3*3600000)
      .sort((a,b) => new Date(a.date) - new Date(b.date))[0];
    const dose = weekInsulin
      .filter(i => i.type === 'rapida' && Math.abs(new Date(i.date).getTime() - mealTime) <= 30*60000)
      .sort((a,b) => Math.abs(new Date(a.date).getTime()-mealTime) - Math.abs(new Date(b.date).getTime()-mealTime))[0];
    return { timing: m.timing, carbs: m.carbs, dose: dose?.units, postGlucose: postGlucose?.value, date: m.date.slice(0,10) };
  }).filter(m => m.carbs > 0);

  const rapidaPerPasto = weekInsulin.filter(i => i.type === 'rapida');
  const lenta = weekInsulin.filter(i => i.type === 'lenta');

  // ── Report Claude ────────────────────────────────────────────────────────────
  const prompt = `Sei un diabetologo che analizza i dati settimanali di un paziente diabetico e scrive un report in italiano chiaro e incoraggiante.

DATI SETTIMANA (${new Date(weekAgo).toLocaleDateString('it-IT')} - ${new Date().toLocaleDateString('it-IT')}):

📊 GLICEMIA (${allGlucose.length} misurazioni totali):
- Media: ${avg} mg/dL
- Min: ${minV} | Max: ${maxV} mg/dL  
- TIR (70-180): ${tir}%
- Episodi ipoglicemia (<70): ${ipo}
- Episodi iperglicemia (>180): ${iper}

💉 INSULINA:
- Dosi rapide: ${rapidaPerPasto.length} (media ${rapidaPerPasto.length ? (rapidaPerPasto.reduce((a,b)=>a+b.units,0)/rapidaPerPasto.length).toFixed(1) : 0}U)
- Dosi lente: ${lenta.length}

🍽️ PASTI CON DATI:
${mealResults.slice(0,10).map(m => `- ${m.date} ${m.timing}: ${m.carbs}g carbo${m.dose ? ` → ${m.dose}U insulina` : ''}${m.postGlucose ? ` → glicemia post ${m.postGlucose} mg/dL` : ''}`).join('\n')}

⚙️ CONFIGURAZIONE:
- Rapporto insulina/carbo: ${insulinConfig.carbRatio || 'non configurato'}g per 1U
- Target: ${insulinConfig.targetGlucose || 120} mg/dL
- Dosi prescritte: colazione ${insulinConfig.dosePerPasto?.colazione || '?'}U, pranzo ${insulinConfig.dosePerPasto?.pranzo || '?'}U, cena ${insulinConfig.dosePerPasto?.cena || '?'}U

Scrivi un report settimanale usando SOLO tag HTML semplici (h2, p, ul, li, strong, em). NON usare CSS inline. Sii conciso:
1. Titolo h2 con emoji e valutazione generale
2. Paragrafo "Cosa sta funzionando"
3. Paragrafo "Aree di miglioramento" (se necessario)
4. Valuta brevemente il rapporto insulina/carbo
5. Messaggio motivazionale finale
Aggiungi: "⚕️ Questo report non sostituisce il parere medico." Rispondi SOLO con HTML senza backtick.`;

  console.log('🤖 Chiamo Claude per report...');
  const reportHtml = await callClaude(prompt);
  const cleanReportHtml = reportHtml.replace(/```html\s*/gi, '').replace(/```\s*/gi, '').trim();

  // ── Apprendimento adattivo ───────────────────────────────────────────────────
  console.log('🧠 Calcolo rapporti adattivi...');
  const adaptiveResult = calculateAdaptiveRatios(meals, insulin, libreData, readings, insulinConfig);

  if (adaptiveResult) {
    // Aggiorna insulinConfig con i nuovi rapporti
    const updatedConfig = {
      ...insulinConfig,
      carbRatioPerPasto: adaptiveResult.carbRatioPerPasto,
      carbRatio: adaptiveResult.globalRatio,
      adaptiveUpdate: {
        updatedAt: adaptiveResult.updatedAt,
        campioni: adaptiveResult.campioni
      }
    };

    // Salva user-data.json aggiornato
    const updatedUserData = { ...userData, insulinConfig: updatedConfig };
    fs.writeFileSync('user-data.json', JSON.stringify(updatedUserData, null, 2));
    console.log(`✅ Rapporti adattivi aggiornati: globale ${adaptiveResult.globalRatio}g/U`);
  }

  // ── Email ────────────────────────────────────────────────────────────────────
  const adaptiveSection = adaptiveResult ? `
  <div style="background:#f0fdf4;border-radius:10px;padding:12px;margin-top:16px">
    <strong>🧠 Apprendimento adattivo aggiornato</strong><br/>
    <small>Basato su ${adaptiveResult.campioni} pasti degli ultimi 30 giorni:</small><br/>
    ${Object.entries(adaptiveResult.carbRatioPerPasto).map(([t,r]) => `<strong>${t}</strong>: ${r}g/U`).join(' · ')}
    <br/><small>Rapporto globale: <strong>${adaptiveResult.globalRatio}g/U</strong> · Aggiornato nell'app automaticamente</small>
  </div>` : '';

  const emailHtml = `
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  body { font-family: -apple-system, 'Segoe UI', sans-serif; background:#f0f4f8; margin:0; padding:20px; color:#1e293b; }
  .container { max-width:600px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,.1); }
  .header { background:linear-gradient(135deg,#3b82f6,#8b5cf6); padding:24px; text-align:center; color:#fff; }
  .header h1 { margin:0; font-size:22px; font-weight:800; }
  .header p { margin:6px 0 0; opacity:.85; font-size:13px; }
  .content { padding:24px; }
  .stat-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:16px 0; }
  .stat { background:#f8fafc; border-radius:10px; padding:12px; text-align:center; }
  .stat-val { font-size:22px; font-weight:800; }
  .stat-label { font-size:10px; color:#94a3b8; text-transform:uppercase; margin-top:2px; }
  .footer { background:#f8fafc; padding:16px; text-align:center; font-size:11px; color:#94a3b8; }
  h2 { font-size:16px; margin:20px 0 8px; color:#1e293b; }
  p { font-size:14px; line-height:1.6; color:#475569; }
  .tir-bar { background:#e2e8f0; border-radius:6px; height:12px; margin:6px 0; overflow:hidden; }
  .tir-fill { height:12px; border-radius:6px; background:${tir >= 70 ? '#22c55e' : tir >= 50 ? '#f59e0b' : '#ef4444'}; width:${tir}%; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🩺 Diabete Tracker — Report Settimanale</h1>
    <p>${new Date(weekAgo).toLocaleDateString('it-IT')} → ${new Date().toLocaleDateString('it-IT')}</p>
  </div>
  <div class="content">
    <div class="stat-grid">
      <div class="stat"><div class="stat-val" style="color:${avg<=180?'#22c55e':'#ef4444'}">${avg}</div><div class="stat-label">Media mg/dL</div></div>
      <div class="stat"><div class="stat-val" style="color:${tir>=70?'#22c55e':tir>=50?'#f59e0b':'#ef4444'}">${tir}%</div><div class="stat-label">Tempo in range</div></div>
      <div class="stat"><div class="stat-val" style="color:${ipo===0?'#22c55e':'#ef4444'}">${ipo}</div><div class="stat-label">Ipoglicemie</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">Tempo in range (70–180 mg/dL)</div>
      <div class="tir-bar"><div class="tir-fill"></div></div>
      <div style="font-size:11px;color:#64748b">${tir}% • obiettivo ADA: ≥70%</div>
    </div>
    ${cleanReportHtml}
    ${adaptiveSection}
  </div>
  <div class="footer">
    📱 Generato automaticamente da Diabete Tracker · Non sostituisce il parere medico<br/>
    Per modificare le preferenze, accedi all'app
  </div>
</div>
</body>
</html>`;

  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
    tls: { rejectUnauthorized: false }
  });

  console.log('📧 Invio email a', GMAIL_USER);
  await transporter.sendMail({
    from: `"Diabete Tracker" <${GMAIL_USER}>`,
    to: GMAIL_USER,
    subject: `🩺 Report settimanale Diabete Tracker — TIR ${tir}%`,
    html: emailHtml
  });

  console.log(`✅ Email inviata a ${GMAIL_USER}`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
