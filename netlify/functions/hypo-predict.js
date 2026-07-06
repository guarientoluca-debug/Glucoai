const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Durata azione per marca (ore)
const BRAND_DURATION = { novorapid: 4, humalog: 4.5, fiasp: 3.5, apidra: 3.5 };

// Calcola IOB residua
function calcolaIOB(dosi, marcaRapida) {
  const now = Date.now();
  const duration = (BRAND_DURATION[marcaRapida] || 4) * 3600000;
  let iob = 0;
  for (const dose of dosi) {
    const elapsed = now - new Date(dose.date).getTime();
    if (elapsed >= 0 && elapsed < duration && dose.type?.toLowerCase() === 'rapida') {
      const remaining = 1 - (elapsed / duration);
      iob += dose.units * remaining;
    }
  }
  return Math.round(iob * 10) / 10;
}

exports.handler = async (event) => {
  if (!SUPABASE_KEY) return { statusCode: 500, body: 'Missing key' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Tutti i profili con push token
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, expo_push_token, nome')
    .not('expo_push_token', 'is', null);

  if (!profiles?.length) return { statusCode: 200, body: 'Nessun profilo' };

  const results = [];

  for (const profile of profiles) {
    // Ultime 3 letture Libre (45 min)
    const { data: readings } = await supabase
      .from('libre_data')
      .select('value, date')
      .eq('user_id', profile.id)
      .order('date', { ascending: false })
      .limit(3);

    if (!readings || readings.length < 2) continue;

    const latest = readings[0];
    const prev = readings[1];
    const latestTime = new Date(latest.date).getTime();
    const prevTime = new Date(prev.date).getTime();
    const diffMin = (latestTime - prevTime) / 60000;

    // Evita letture troppo vecchie (>30 min tra le due = dati non affidabili)
    if (diffMin > 30 || diffMin < 5) continue;

    // Evita alert se l'ultima lettura è vecchia (>20 min fa)
    const ageMin = (Date.now() - latestTime) / 60000;
    if (ageMin > 20) continue;

    // Velocità di discesa (mg/dL per minuto)
    const velocita = (latest.value - prev.value) / diffMin;

    // Previsione a 15 e 30 minuti
    const pred15 = Math.round(latest.value + velocita * 15);
    const pred30 = Math.round(latest.value + velocita * 30);

    // Anti-spam: non inviare se abbiamo già inviato negli ultimi 30 min
    const { data: recentAlert } = await supabase
      .from('notifiche')
      .select('id')
      .eq('paziente_id', profile.id)
      .eq('tipo', 'hypo_predict')
      .gte('created_at', new Date(Date.now() - 30 * 60000).toISOString())
      .limit(1);

    if (recentAlert?.length > 0) {
      results.push({ user: profile.id, skipped: 'recent_alert' });
      continue;
    }

    // Carica IOB
    const { data: config } = await supabase
      .from('insulin_config')
      .select('marca_rapida')
      .eq('user_id', profile.id)
      .single();

    const marca = config?.marca_rapida || 'novorapid';

    const { data: dosi } = await supabase
      .from('insulin')
      .select('units, type, date')
      .eq('user_id', profile.id)
      .gte('date', new Date(Date.now() - 6 * 3600000).toISOString());

    const iob = calcolaIOB(dosi || [], marca);

    // Ora locale (per alert pre-sonno)
    const oraLocale = new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome', hour12: false });
    const ora = parseInt(oraLocale.split(' ')[1]?.split(':')[0] || '0');

    let titolo = null;
    let testo = null;
    let livello = null;

    // === CASO 1: Ipo imminente (valore attuale < 90 e in discesa, previsione < 70) ===
    if (latest.value < 90 && velocita < -0.5 && pred15 < 75) {
      livello = 'critico';
      const carboNecessari = Math.max(10, Math.round((80 - pred15) / 4 + iob * 3));
      titolo = `🔴 Ipo prevista tra 15 min: ${pred15} mg/dL`;
      testo = `Glicemia ${latest.value} in discesa (${Math.round(velocita * 15)} in 15 min). IOB attiva: ${iob}U. Mangia ${carboNecessari}g di carbo rapidi subito.`;
    }
    // === CASO 2: Discesa rapida (previsione 30 min < 80) ===
    else if (velocita < -0.8 && pred30 < 80 && latest.value < 130) {
      livello = 'warning';
      const carboNecessari = Math.max(10, Math.round((80 - pred30) / 4 + iob * 2));
      titolo = `⚠️ Attenzione: glicemia in discesa rapida`;
      testo = `Glicemia ${latest.value} → prevista ${pred30} tra 30 min (velocità ${Math.round(velocita * 15)}/15min). IOB: ${iob}U. Considera ${carboNecessari}g di carbo.`;
    }
    // === CASO 3: Alert pre-sonno (22-00, < 120, in discesa) ===
    else if ((ora >= 22 || ora === 0) && latest.value < 120 && velocita < -0.3) {
      livello = 'presleep';
      titolo = `🌙 Prima di dormire: glicemia ${latest.value} in discesa`;
      testo = `Sei a ${latest.value} e stai scendendo. IOB attiva: ${iob}U. Mangia 10-15g di carbo lenti (crackers + formaggio) per evitare ipo notturna.`;
    }

    if (!titolo) {
      results.push({ user: profile.id, value: latest.value, velocita: Math.round(velocita * 100) / 100, pred15, pred30, action: 'ok' });
      continue;
    }

    // Salva notifica
    await supabase.from('notifiche').insert({
      paziente_id: profile.id,
      tipo: 'hypo_predict',
      titolo,
      testo,
      letta: false,
    });

    // Push notification
    if (profile.expo_push_token) {
      const pushBody = JSON.stringify({
        to: profile.expo_push_token,
        title: titolo,
        body: testo,
        sound: 'default',
        priority: livello === 'critico' ? 'high' : 'default',
      });

      await new Promise((resolve) => {
        const req = https.request({
          hostname: 'exp.host',
          path: '/--/api/v2/push/send',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, (res) => { res.on('data', () => {}); res.on('end', resolve); });
        req.on('error', resolve);
        req.write(pushBody);
        req.end();
      });
    }

    results.push({ user: profile.id, value: latest.value, velocita: Math.round(velocita * 100) / 100, pred15, pred30, livello, titolo });
  }

  return { statusCode: 200, body: JSON.stringify({ processed: profiles.length, results }) };
};
