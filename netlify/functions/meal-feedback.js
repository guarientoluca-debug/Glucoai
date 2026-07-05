const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Profili insulina per timing
const INSULIN_PROFILES = {
  novorapid: { peak: 1.5, duration: 4 },
  humalog: { peak: 1.5, duration: 4.5 },
  fiasp: { peak: 1, duration: 3.5 },
  apidra: { peak: 1, duration: 3.5 },
};

exports.handler = async (event) => {
  if (!SUPABASE_KEY) return { statusCode: 500, body: 'Missing SUPABASE_KEY' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Finestra: pasti registrati tra 3h e 3h30 fa (cosi gira ogni 30 min e non duplica)
  const now = Date.now();
  const from = new Date(now - 3.5 * 3600000).toISOString();
  const to = new Date(now - 3 * 3600000).toISOString();

  // Tutti i pasti nella finestra
  const { data: meals, error: mErr } = await supabase
    .from('meals')
    .select('*')
    .gte('date', from)
    .lte('date', to);

  if (mErr || !meals?.length) {
    return { statusCode: 200, body: `Nessun pasto nella finestra. ${mErr?.message || ''}` };
  }

  const results = [];

  for (const meal of meals) {
    const userId = meal.user_id;
    const mealTime = new Date(meal.date).getTime();

    // Cerca glicemia post-prandiale: lettura Libre piu vicina a 3h dopo il pasto
    const targetTime = mealTime + 3 * 3600000;
    const searchFrom = new Date(targetTime - 30 * 60000).toISOString();
    const searchTo = new Date(targetTime + 30 * 60000).toISOString();

    const { data: libreReadings } = await supabase
      .from('libre_data')
      .select('value, date')
      .eq('user_id', userId)
      .gte('date', searchFrom)
      .lte('date', searchTo)
      .order('date', { ascending: true });

    // Anche da readings (glucometro)
    const { data: manualReadings } = await supabase
      .from('readings')
      .select('value, date')
      .eq('user_id', userId)
      .gte('date', searchFrom)
      .lte('date', searchTo)
      .order('date', { ascending: true });

    const allReadings = [...(libreReadings || []), ...(manualReadings || [])];
    if (allReadings.length === 0) {
      results.push({ meal_id: meal.id, skipped: 'no_postprandial_reading' });
      continue;
    }

    // Trova la lettura piu vicina alle 3h
    let closest = allReadings[0];
    let closestDiff = Math.abs(new Date(closest.date).getTime() - targetTime);
    for (const r of allReadings) {
      const diff = Math.abs(new Date(r.date).getTime() - targetTime);
      if (diff < closestDiff) { closest = r; closestDiff = diff; }
    }

    const postValue = closest.value;
    const carbs = meal.carbs || 0;
    const timing = meal.timing || '';

    // Controlla se gia inviato feedback per questo pasto
    const { data: existingNotif } = await supabase
      .from('notifiche')
      .select('id')
      .eq('paziente_id', userId)
      .eq('tipo', 'feedback_pasto')
      .ilike('testo', `%${meal.id}%`)
      .limit(1);

    if (existingNotif?.length > 0) {
      results.push({ meal_id: meal.id, skipped: 'already_sent' });
      continue;
    }

    // Determina il tipo di carbo dal pasto (se salvato con indice_glicemico)
    // Altrimenti indovina dal nome degli alimenti
    const foods = meal.foods || [];
    let hasVeloce = false;
    let hasLento = false;
    for (const f of foods) {
      const gi = f.indice_glicemico || '';
      if (gi === 'veloce') hasVeloce = true;
      if (gi === 'lento') hasLento = true;
    }
    // Se non abbiamo info GI, cerchiamo nel nome
    const mealNote = (meal.note || '').toLowerCase();
    const fastFoods = ['pizza', 'focaccia', 'pane bianco', 'dolce', 'brioche', 'cornetto', 'succo'];
    if (!hasVeloce && fastFoods.some(f => mealNote.includes(f))) hasVeloce = true;

    const carboTipo = hasVeloce ? 'veloce' : 'lento';

    // Carica config per marca (IOB timing)
    const { data: config } = await supabase
      .from('insulin_config')
      .select('marca_rapida, dose_per_pasto')
      .eq('user_id', userId)
      .single();

    const marca = config?.marca_rapida || 'novorapid';
    const profile = INSULIN_PROFILES[marca] || INSULIN_PROFILES.novorapid;

    // Genera feedback
    let titolo, testo, livello;

    if (postValue >= 70 && postValue <= 180) {
      // IN TARGET - tutto ok
      livello = 'ok';
      titolo = `\u2705 ${timing || 'Pasto'}: ottimo risultato!`;
      testo = `Post-prandiale a ${postValue} mg/dL (target 70-180). La dose era corretta per ${carbs}g di carbo. Continua cosi! [ref:${meal.id}]`;
    } else if (postValue > 180) {
      // ALTO
      livello = 'alto';
      if (carboTipo === 'veloce') {
        // Carbo veloce: non aumentare dose, suggerisci split
        titolo = `\u26A0\uFE0F ${timing || 'Pasto'}: picco da carbo veloci`;
        testo = `Post-prandiale a ${postValue} mg/dL dopo ${carbs}g di carbo veloci (pizza, focaccia, pane). Il picco e dovuto all'assorbimento rapido, non alla dose. La prossima volta prova a: 1) fare il bolo 15 min prima di mangiare, 2) dividere la dose: 60% subito + 40% dopo 1.5h. [ref:${meal.id}]`;
      } else {
        // Carbo lento: dose insufficiente
        const eccesso = postValue - 140;
        const extraU = Math.round(eccesso / 50 * 2) / 2; // arrotonda a 0.5U
        titolo = `\u26A0\uFE0F ${timing || 'Pasto'}: dose da rivedere`;
        testo = `Post-prandiale a ${postValue} mg/dL dopo ${carbs}g di carbo. La dose potrebbe essere stata insufficiente. La prossima volta con un pasto simile, considera +${Math.max(0.5, extraU)}U in piu. Confronta col tuo diabetologo. [ref:${meal.id}]`;
      }
    } else {
      // BASSO (<70)
      livello = 'basso';
      if (carboTipo === 'veloce') {
        titolo = `\u{1F534} ${timing || 'Pasto'}: ipo dopo carbo veloci`;
        testo = `Post-prandiale a ${postValue} mg/dL. La dose totale era corretta ma i carbo veloci si sono esauriti prima dell'insulina. La prossima volta: mangia uno snack lento 2h dopo il pasto, oppure riduci la dose di 1U. [ref:${meal.id}]`;
      } else {
        titolo = `\u{1F534} ${timing || 'Pasto'}: dose eccessiva`;
        testo = `Post-prandiale a ${postValue} mg/dL dopo ${carbs}g di carbo. La dose era troppo alta. La prossima volta con un pasto simile, considera -1U. Confronta col tuo diabetologo. [ref:${meal.id}]`;
      }
    }

    // Salva notifica
    await supabase.from('notifiche').insert({
      paziente_id: userId,
      tipo: 'feedback_pasto',
      titolo,
      testo,
      letta: false,
    });

    // Invia push notification
    const { data: profileData } = await supabase
      .from('profiles')
      .select('expo_push_token')
      .eq('id', userId)
      .single();

    if (profileData?.expo_push_token) {
      const pushBody = JSON.stringify({
        to: profileData.expo_push_token,
        title: titolo,
        body: testo.substring(0, 150) + '...',
        sound: 'default',
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

    results.push({ meal_id: meal.id, postValue, carboTipo, livello, titolo });
  }

  return { statusCode: 200, body: JSON.stringify({ processed: results.length, results }) };
};
