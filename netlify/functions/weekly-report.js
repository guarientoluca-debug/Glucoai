// netlify/functions/weekly-report.js
// Eseguito ogni domenica alle 8:00 via netlify.toml schedule
// Invia riepilogo settimanale a tutti i pazienti GlucoAI

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const transporter = nodemailer.createTransport({
  host: 'smtps.aruba.it',
  port: 465,
  secure: true,
  auth: {
    user: 'info@glucoai.it',
    pass: process.env.ARUBA_SMTP_PASSWORD,
  },
});

const getColor = (val) => {
  if (val < 70) return '#e74c3c';
  if (val > 180) return '#e67e22';
  return '#2ecc71';
};

const tirColor = (tir) => {
  if (tir >= 70) return '#2ecc71';
  if (tir >= 50) return '#e67e22';
  return '#e74c3c';
};

const generateEmailHTML = (nome, data) => {
  const {
    glicMedia, glicMin, glicMax, tir,
    totaleMisurazioni, totaleIpo, totaleIper,
    hba1c, mediaRapida, mediaLenta,
    totalePasti, carboMedi
  } = data;

  return `
<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Il tuo riepilogo settimanale GlucoAI</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        
        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#E84545,#c03333);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
          <p style="margin:0 0 8px;font-size:28px;">🩸</p>
          <h1 style="margin:0;color:#fff;font-size:24px;font-weight:800;letter-spacing:-0.5px;">GlucoAI</h1>
          <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">Riepilogo settimanale</p>
        </td></tr>

        <!-- Saluto -->
        <tr><td style="background:#fff;padding:28px 32px 20px;">
          <p style="margin:0;font-size:16px;color:#1a2332;">Ciao <strong>${nome}</strong> 👋</p>
          <p style="margin:8px 0 0;font-size:14px;color:#6b7280;line-height:1.6;">
            Ecco il riepilogo dei tuoi dati degli ultimi 7 giorni. Continua così!
          </p>
        </td></tr>

        <!-- Glicemia Stats -->
        <tr><td style="background:#fff;padding:0 32px 20px;">
          <h2 style="margin:0 0 16px;font-size:13px;font-weight:700;color:#9ca3af;letter-spacing:0.08em;text-transform:uppercase;">📊 Glicemia</h2>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="25%" style="text-align:center;background:#f8f9fa;border-radius:12px;padding:16px 8px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:${getColor(glicMedia)};">${glicMedia}</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">Media mg/dL</p>
              </td>
              <td width="4%"></td>
              <td width="25%" style="text-align:center;background:#f8f9fa;border-radius:12px;padding:16px 8px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:${tirColor(tir)};">${tir}%</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">TIR 70-180</p>
              </td>
              <td width="4%"></td>
              <td width="25%" style="text-align:center;background:#f8f9fa;border-radius:12px;padding:16px 8px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#6c63ff;">${hba1c}%</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">HbA1c est.</p>
              </td>
              <td width="4%"></td>
              <td width="17%" style="text-align:center;background:#f8f9fa;border-radius:12px;padding:16px 8px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#1a2332;">${totaleMisurazioni}</p>
                <p style="margin:4px 0 0;font-size:11px;color:#9ca3af;">Misurazioni</p>
              </td>
            </tr>
          </table>
          
          <!-- Min/Max/Ipo/Iper -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
            <tr>
              <td width="48%" style="background:#e8faf7;border-radius:10px;padding:12px;text-align:center;">
                <p style="margin:0;font-size:13px;color:#00b894;"><strong>Min: ${glicMin}</strong> · Max: ${glicMax} mg/dL</p>
              </td>
              <td width="4%"></td>
              <td width="48%" style="background:#fff0f3;border-radius:10px;padding:12px;text-align:center;">
                <p style="margin:0;font-size:13px;color:#e84545;"><strong>${totaleIpo} ipo</strong> · ${totaleIper} iper</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Insulina -->
        <tr><td style="background:#fff;padding:0 32px 20px;">
          <h2 style="margin:0 0 16px;font-size:13px;font-weight:700;color:#9ca3af;letter-spacing:0.08em;text-transform:uppercase;">💉 Insulina</h2>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="48%" style="text-align:center;background:#fff5f5;border-radius:12px;padding:16px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#e84545;">${mediaRapida}U</p>
                <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">⚡ Media Rapida</p>
              </td>
              <td width="4%"></td>
              <td width="48%" style="text-align:center;background:#f5f0ff;border-radius:12px;padding:16px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#9b59b6;">${mediaLenta}U</p>
                <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">🌙 Media Lenta</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Pasti -->
        <tr><td style="background:#fff;padding:0 32px 28px;">
          <h2 style="margin:0 0 16px;font-size:13px;font-weight:700;color:#9ca3af;letter-spacing:0.08em;text-transform:uppercase;">🍽️ Pasti</h2>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="48%" style="text-align:center;background:#fff8e7;border-radius:12px;padding:16px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#f39c12;">${totalePasti}</p>
                <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">Pasti registrati</p>
              </td>
              <td width="4%"></td>
              <td width="48%" style="text-align:center;background:#fff8e7;border-radius:12px;padding:16px;">
                <p style="margin:0;font-size:22px;font-weight:800;color:#f39c12;">${carboMedi}g</p>
                <p style="margin:4px 0 0;font-size:12px;color:#9ca3af;">Media carbo/pasto</p>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#1a2332;border-radius:0 0 16px 16px;padding:24px 32px;text-align:center;">
          <p style="margin:0 0 8px;font-size:13px;color:rgba(255,255,255,0.6);">
            Questo report è generato automaticamente da <strong style="color:#fff;">GlucoAI</strong>
          </p>
          <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.35);">
            ⚠️ I dati sono indicativi. Consulta sempre il tuo diabetologo per le decisioni terapeutiche.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
  `;
};

exports.handler = async (event) => {
  try {
    // Leggi tutti i profili con email
    const { data: profiles, error: profErr } = await supabase
      .from('profiles')
      .select('id, nome, email')
      .not('email', 'is', null);

    if (profErr || !profiles?.length) {
      return { statusCode: 200, body: 'Nessun profilo trovato' };
    }

    const dal7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let inviati = 0;

    for (const profile of profiles) {
      try {
        const userId = profile.id;

        // Letture glicemiche
        const { data: readings } = await supabase
          .from('readings').select('value').eq('user_id', userId).gte('date', dal7);

        if (!readings?.length) continue; // Salta se non ha dati

        const valori = readings.map(r => r.value);
        const glicMedia = Math.round(valori.reduce((a, b) => a + b, 0) / valori.length);
        const glicMin = Math.min(...valori);
        const glicMax = Math.max(...valori);
        const inTarget = valori.filter(v => v >= 70 && v <= 180).length;
        const tir = Math.round((inTarget / valori.length) * 100);
        const totaleIpo = valori.filter(v => v < 70).length;
        const totaleIper = valori.filter(v => v > 180).length;
        const hba1c = ((glicMedia + 46.7) / 28.7).toFixed(1);

        // Insulina
        const { data: insuline } = await supabase
          .from('insulin').select('units, type').eq('user_id', userId).gte('date', dal7);
        const rapide = insuline?.filter(i => i.type?.toLowerCase().includes('rapida')) || [];
        const lente = insuline?.filter(i => i.type?.toLowerCase().includes('lenta')) || [];
        const mediaRapida = rapide.length ? Math.round(rapide.reduce((a, b) => a + b.units, 0) / rapide.length) : 0;
        const mediaLenta = lente.length ? Math.round(lente.reduce((a, b) => a + b.units, 0) / lente.length) : 0;

        // Pasti
        const { data: pasti } = await supabase
          .from('meals').select('carbs').eq('user_id', userId).gte('date', dal7);
        const totalePasti = pasti?.length || 0;
        const carboMedi = totalePasti ? Math.round(pasti.reduce((a, b) => a + (b.carbs || 0), 0) / totalePasti) : 0;

        const html = generateEmailHTML(profile.nome || 'paziente', {
          glicMedia, glicMin, glicMax, tir,
          totaleMisurazioni: valori.length, totaleIpo, totaleIper,
          hba1c, mediaRapida, mediaLenta, totalePasti, carboMedi
        });

        await transporter.sendMail({
          from: '"GlucoAI" <info@glucoai.it>',
          to: profile.email,
          subject: `📊 Il tuo riepilogo settimanale GlucoAI — TIR ${tir}%`,
          html,
        });

        inviati++;
      } catch (e) {
        console.error(`Errore per ${profile.email}:`, e.message);
      }
    }

    return { statusCode: 200, body: `Report inviati: ${inviati}` };
  } catch (e) {
    return { statusCode: 500, body: e.message };
  }
};
