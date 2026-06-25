const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SMTP_PASSWORD = process.env.ARUBA_SMTP_PASSWORD;

exports.handler = async () => {
  if (!SUPABASE_KEY || !SMTP_PASSWORD) {
    return { statusCode: 500, body: 'Variabili mancanti' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Recupera tutti i profili con email
  // Legge email da auth.users tramite admin API
  const { data: { users }, error } = await supabase.auth.admin.listUsers();
  const profiles = (users || []).map(u => ({
    id: u.id,
    email: u.email,
    nome: u.user_metadata?.nome || u.email?.split('@')[0] || 'Paziente'
  }));

  if (error || !profiles?.length) {
    console.log('Nessun profilo trovato');
    return { statusCode: 200, body: 'Nessun paziente' };
  }

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

    // Glicemie settimana
    const { data: readings } = await supabase
      .from('readings')
      .select('value, date')
      .eq('user_id', profile.id)
      .gte('date', weekAgo);

    // Dati Libre
    const { data: libreRows } = await supabase
      .from('libre_data')
      .select('value, date')
      .eq('user_id', profile.id)
      .gte('date', weekAgo);

    // Pasti
    const { data: meals } = await supabase
      .from('meals')
      .select('carbs, timing, date')
      .eq('user_id', profile.id)
      .gte('date', weekAgo);

    // Insulina
    const { data: insulin } = await supabase
      .from('insulin')
      .select('units, type, date')
      .eq('user_id', profile.id)
      .gte('date', weekAgo);

    const allGlucose = [
      ...(readings || []).map(r => r.value),
      ...(libreRows || []).map(r => r.value)
    ];

    if (allGlucose.length === 0) continue;

    const avg = Math.round(allGlucose.reduce((a, b) => a + b, 0) / allGlucose.length);
    const tir = Math.round(allGlucose.filter(v => v >= 70 && v <= 180).length / allGlucose.length * 100);
    const ipo = allGlucose.filter(v => v < 70).length;
    const iper = allGlucose.filter(v => v > 180).length;
    const minV = Math.min(...allGlucose);
    const maxV = Math.max(...allGlucose);

    const rapidCount = (insulin || []).filter(i => i.type?.toLowerCase() === 'rapida').length;
    const totalCarbs = (meals || []).reduce((s, m) => s + (m.carbs || 0), 0);

    const tirColor = tir >= 70 ? '#22c55e' : tir >= 50 ? '#f59e0b' : '#ef4444';
    const avgColor = avg <= 180 ? '#22c55e' : '#ef4444';
    const ipoColor = ipo === 0 ? '#22c55e' : '#ef4444';

    const nome = profile.nome?.split(' ')[0] || 'Caro paziente';
    const dateFrom = new Date(weekAgo).toLocaleDateString('it-IT');
    const dateTo = new Date().toLocaleDateString('it-IT');

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
      <div class="stat">
        <div class="stat-val" style="color:${avgColor}">${avg}</div>
        <div class="stat-label">Media mg/dL</div>
      </div>
      <div class="stat">
        <div class="stat-val" style="color:${tirColor}">${tir}%</div>
        <div class="stat-label">Tempo in range</div>
      </div>
      <div class="stat">
        <div class="stat-val" style="color:${ipoColor}">${ipo}</div>
        <div class="stat-label">Ipoglicemie</div>
      </div>
    </div>

    <div style="margin-bottom:16px">
      <div style="font-size:11px;color:#94a3b8;margin-bottom:4px">Tempo in range (70–180 mg/dL)</div>
      <div class="tir-bar"><div class="tir-fill"></div></div>
      <div style="font-size:11px;color:#64748b">${tir}% • Obiettivo ADA: ≥70%</div>
    </div>

    <div style="background:#f8fafc;border-radius:10px;padding:16px;margin:16px 0">
      <div class="info-row"><span>📉 Minimo</span><span><strong>${minV} mg/dL</strong></span></div>
      <div class="info-row"><span>📈 Massimo</span><span><strong>${maxV} mg/dL</strong></span></div>
      <div class="info-row"><span>🔴 Iperglicemie (>180)</span><span><strong>${iper}</strong></span></div>
      <div class="info-row"><span>💉 Dosi rapide</span><span><strong>${rapidCount}</strong></span></div>
      <div class="info-row" style="border:none"><span>🍽️ Carboidrati totali</span><span><strong>${totalCarbs}g</strong></span></div>
    </div>

    ${tir >= 70
      ? `<p>✅ <strong>Ottimo lavoro!</strong> Il tuo tempo in range è sopra l'obiettivo del 70%. Continua così!</p>`
      : tir >= 50
      ? `<p>⚠️ Il tempo in range è migliorabile. Apri GlucoAI per analizzare i pasti e le dosi della settimana.</p>`
      : `<p>🔴 Il tempo in range è sotto il 50%. Ti consigliamo di condividere questo report con il tuo diabetologo.</p>`
    }

    <p style="font-size:12px;color:#94a3b8;margin-top:20px">⚕️ Questo report è generato automaticamente e non sostituisce il parere del medico.</p>
  </div>
  <div class="footer">
    📱 GlucoAI · <a href="https://glucoai.it" style="color:#E84545;text-decoration:none">glucoai.it</a>
  </div>
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
    console.log(`✅ Email inviata a ${profile.email}`);
  }

  return { statusCode: 200, body: `Email inviate: ${sent}` };
};
