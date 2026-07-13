const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  const now = Date.now();

  // Finestra allargata: pasti da 30 min a 4h fa
  // - Se c'e lettura manuale postMeal → feedback immediato
  // - Se non c'e → aspetta finestra 3h-3h30 e usa Libre
  const wideFrom = new Date(now - 4 * 3600000).toISOString();
  const wideTo = new Date(now - 30 * 60000).toISOString();

  const { data: meals, error: mErr } = await supabase
    .from('meals')
    .select('*')
    .gte('date', wideFrom)
    .lte('date', wideTo);

  if (mErr || !meals?.length) {
    return { statusCode: 200, body: `Nessun pasto nella finestra. ${mErr?.message || ''}` };
  }

  const results = [];

  for (const meal of meals) {
    const userId = meal.user_id;
    const mealTime = new Date(meal.date).getTime();
    const mealAge = (now - mealTime) / 3600000; // ore dal pasto

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

    // === PRIORITA 1: Lettura manuale postMeal ===
    // Cerca readings con moment='postMeal' tra 30 min e 4h dopo il pasto
    const manualFrom = new Date(mealTime + 30 * 60000).toISOString();
    const manualTo = new Date(mealTime + 4 * 3600000).toISOString();

    const { data: postMealReadings } = await supabase
      .from('readings')
      .select('value, date, moment')
      .eq('user_id', userId)
      .eq('moment', 'postMeal')
      .gte('date', manualFrom)
      .lte('date', manualTo)
      .order('date', { ascending: false })
      .limit(1);

    let postValue = null;
    let source = null;

    if (postMealReadings?.length > 0) {
      // Lettura manuale trovata → usa subito
      postValue = postMealReadings[0].value;
      source = 'manual_postMeal';
    } else {
      // === PRIORITA 2: Libre a ~3h ===
      // Solo se il pasto e tra 3h e 3h30 fa
      if (mealAge < 3 || mealAge > 3.5) {
        results.push({ meal_id: meal.id, skipped: 'waiting_3h', mealAge: Math.round(mealAge * 10) / 10 });
        continue;
      }

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

      postValue = closest.value;
      source = 'libre_3h';
    }

    const carbs = meal.carbs || 0;
    const timing = meal.timing || '';

    // Determina tipo carbo
    const foods = meal.foods || [];
    let hasVeloce = false;
    let hasLento = false;
    for (const f of foods) {
      const gi = f.indice_glicemico || '';
      if (gi === 'veloce') hasVeloce = true;
      if (gi === 'lento') hasLento = true;
    }
    const mealNote = (meal.note || '').toLowerCase();
    const fastFoods = ['pizza', 'focaccia', 'pane bianco', 'dolce', 'brioche', 'cornetto', 'succo'];
    if (!hasVeloce && fastFoods.some(f => mealNote.includes(f))) hasVeloce = true;

    const carboTipo = hasVeloce ? 'veloce' : 'lento';

    // Carica config
    const { data: config } = await supabase
      .from('insulin_config')
      .select('marca_rapida, dose_per_pasto')
      .eq('user_id', userId)
      .single();

    const marca = config?.marca_rapida || 'novorapid';

    // Genera feedback
    let titolo, testo, livello;

    const sourceLabel = source === 'manual_postMeal' ? ' (glucometro)' : ' (Libre)';

    if (postValue >= 70 && postValue <= 180) {
      livello = 'ok';
      titolo = `\u2705 ${timing || 'Pasto'}: ottimo risultato!`;
      testo = `Post-prandiale a ${postValue} mg/dL${sourceLabel} (target 70-180). La dose era corretta per ${carbs}g di carbo. Continua cosi! [ref:${meal.id}]`;
    } else if (postValue > 180) {
      livello = 'alto';
      if (carboTipo === 'veloce') {
        titolo = `\u26A0\uFE0F ${timing || 'Pasto'}: picco da carbo veloci`;
        testo = `Post-prandiale a ${postValue} mg/dL${sourceLabel} dopo ${carbs}g di carbo veloci. Il picco e dovuto all'assorbimento rapido, non alla dose. Prova: 1) bolo 15 min prima, 2) dose split 60/40. [ref:${meal.id}]`;
      } else {
        const eccesso = postValue - 140;
        const extraU = Math.round(eccesso / 50 * 2) / 2;
        titolo = `\u26A0\uFE0F ${timing || 'Pasto'}: dose da rivedere`;
        testo = `Post-prandiale a ${postValue} mg/dL${sourceLabel} dopo ${carbs}g di carbo. Considera +${Math.max(0.5, extraU)}U la prossima volta. Confronta col diabetologo. [ref:${meal.id}]`;
      }
    } else {
      livello = 'basso';
      if (carboTipo === 'veloce') {
        titolo = `\u{1F534} ${timing || 'Pasto'}: ipo dopo carbo veloci`;
        testo = `Post-prandiale a ${postValue} mg/dL${sourceLabel}. I carbo veloci si sono esauriti prima dell'insulina. Snack lento 2h dopo o -1U. [ref:${meal.id}]`;
      } else {
        titolo = `\u{1F534} ${timing || 'Pasto'}: dose eccessiva`;
        testo = `Post-prandiale a ${postValue} mg/dL${sourceLabel} dopo ${carbs}g di carbo. Considera -1U la prossima volta. Confronta col diabetologo. [ref:${meal.id}]`;
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

    // Aggiorna il pasto con il valore post-prandiale
    await supabase.from('meals').update({
      post_meal_glucose: postValue,
    }).eq('id', meal.id);

    // Push notification
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

    results.push({ meal_id: meal.id, postValue, source, carboTipo, livello, titolo });
  }

  return { statusCode: 200, body: JSON.stringify({ processed: results.length, results }) };
};
