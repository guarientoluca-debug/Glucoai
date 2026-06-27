// weekly-dose-suggestion.js
// Netlify scheduled function: gira ogni domenica alle 9:00 (vedi netlify.toml).
//
// Per ogni paziente con dosi e carbo_riferimento configurati:
// 1. Recupera gli ultimi 14gg di pasti, letture, attivita'
// 2. Per ogni tipo pasto (colazione/pranzo/cena):
//    - filtra i pasti "standard" (entro +-25% dal carbo_riferimento)
//    - esclude quelli con attivita' fisica nelle 3h intorno al pasto
//    - cerca per ognuno la glicemia post-prandiale (2-4h dopo)
//    - serve un minimo di 7 pasti utili
//    - applica la regola: >=5/7 alti (>180) -> +0.5U, >=3/7 bassi (<70) -> -0.5U
// 3. Sceglie il pasto con scarto maggiore (uno solo per settimana)
// 4. Inserisce una riga in dose_adjustment_suggestions (stato=pending)
// 5. Invia push se l'utente ha expo_push_token
//
// Conservativo by design. La modifica effettiva delle dosi NON avviene qui:
// avviene solo quando l'utente conferma in-app.

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TARGET_HIGH = 180;       // mg/dL: post-prandiale considerato alto
const TARGET_LOW = 70;         // mg/dL: post-prandiale considerato basso
const STD_BAND_PCT = 0.25;     // +-25% dal carbo_riferimento = "pasto standard"
const MIN_MEALS = 7;           // numero minimo di pasti utili per agire
const SOGLIA_ALTI = 5;         // alti su MIN_MEALS per proporre +0.5U
const SOGLIA_BASSI = 3;        // bassi su MIN_MEALS per proporre -0.5U
const DELTA_DOSE = 0.5;        // unita' di aggiustamento (passo penna)
const ACTIVITY_WINDOW_H = 3;   // ore intorno al pasto in cui un'attivita' lo "contamina"
const POST_MIN_H = 2;          // finestra post-prandiale (h)
const POST_MAX_H = 4;
const LOOKBACK_DAYS = 14;

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3600000;
}

// Lettura post-prandiale piu' vicina a 3h dopo il pasto (finestra 2-4h).
function findPostPrandial(mealDate, readings) {
  const mt = new Date(mealDate).getTime();
  const lo = mt + POST_MIN_H * 3600000;
  const hi = mt + POST_MAX_H * 3600000;
  const target = mt + 3 * 3600000;
  let best = null, bestDist = Infinity;
  for (const r of readings) {
    const t = new Date(r.date).getTime();
    if (t < lo || t > hi) continue;
    const d = Math.abs(t - target);
    if (d < bestDist) { best = r; bestDist = d; }
  }
  return best;
}

function hasActivityNearby(mealDate, activities) {
  return activities.some(a => {
    const rid = a.riduzione_dose_percentuale || 0;
    if (rid <= 0) return false;
    return hoursBetween(mealDate, a.date) <= ACTIVITY_WINDOW_H;
  });
}

// Analizza un tipo pasto, ritorna {delta, reason, evidence} oppure null se nessuna azione
function analyzeMealType(timing, refCarbs, meals, readings, activities) {
  const candidate = meals
    .filter(m => (m.timing || '').toLowerCase() === timing)
    .filter(m => m.carbs && refCarbs > 0)
    .filter(m => {
      const delta = Math.abs(m.carbs - refCarbs) / refCarbs;
      return delta <= STD_BAND_PCT; // solo pasti standard
    })
    .filter(m => !hasActivityNearby(m.date, activities)); // niente attivita'

  const withPost = [];
  for (const m of candidate) {
    const post = findPostPrandial(m.date, readings);
    if (post) withPost.push({ meal: m, glicemia: post.value });
  }

  if (withPost.length < MIN_MEALS) {
    return { delta: 0, reason: 'insufficient_data', evidence: { n: withPost.length } };
  }

  // prendo gli ULTIMI MIN_MEALS pasti (per ordine cronologico)
  withPost.sort((a, b) => new Date(b.meal.date) - new Date(a.meal.date));
  const last = withPost.slice(0, MIN_MEALS);

  const alti = last.filter(x => x.glicemia > TARGET_HIGH).length;
  const bassi = last.filter(x => x.glicemia < TARGET_LOW).length;
  const media = last.reduce((s, x) => s + x.glicemia, 0) / last.length;

  let delta = 0;
  if (alti >= SOGLIA_ALTI && media > TARGET_HIGH) delta = +DELTA_DOSE;
  else if (bassi >= SOGLIA_BASSI) delta = -DELTA_DOSE;

  return {
    delta,
    reason: delta > 0 ? 'too_high' : (delta < 0 ? 'too_low' : 'on_target'),
    evidence: { n: last.length, alti, bassi, media: Math.round(media) },
  };
}

async function processPatient(sb, patientId) {
  // Config
  const { data: config } = await sb
    .from('insulin_config')
    .select('dose_per_pasto, carbo_riferimento')
    .eq('user_id', patientId)
    .single();

  if (!config?.dose_per_pasto || !config?.carbo_riferimento) {
    return { patientId, skipped: 'no_config' };
  }

  // Skip se un suggerimento pending esiste gia' per questo paziente
  const { data: pending } = await sb
    .from('dose_adjustment_suggestions')
    .select('id')
    .eq('paziente_id', patientId)
    .eq('stato', 'pending')
    .limit(1);
  if (pending && pending.length > 0) {
    return { patientId, skipped: 'pending_exists' };
  }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const [mealsRes, readingsRes, libreRes, activitiesRes] = await Promise.all([
    sb.from('meals').select('id, date, timing, carbs').eq('user_id', patientId).gte('date', since),
    sb.from('readings').select('date, value').eq('user_id', patientId).gte('date', since),
    sb.from('libre_data').select('date, value').eq('user_id', patientId).gte('date', since),
    sb.from('activities').select('date, riduzione_dose_percentuale').eq('user_id', patientId).gte('date', since),
  ]);

  const meals = mealsRes.data || [];
  // readings + libre_data unite: per il post-prandiale servono entrambe
  const readings = [...(readingsRes.data || []), ...(libreRes.data || [])];
  const activities = activitiesRes.data || [];

  const results = {};
  for (const timing of ['colazione', 'pranzo', 'cena']) {
    const ref = config.carbo_riferimento[timing];
    if (!ref) continue;
    results[timing] = analyzeMealType(timing, ref, meals, readings, activities);
  }

  // Scelgo UN solo pasto da aggiustare: quello con scarto piu' marcato
  // (deviazione assoluta della media dal target 120, tra quelli con delta != 0)
  const candidates = Object.entries(results)
    .filter(([, r]) => r.delta !== 0 && r.evidence.media != null)
    .map(([timing, r]) => ({
      timing, r,
      scarto: Math.abs(r.evidence.media - 120),
    }))
    .sort((a, b) => b.scarto - a.scarto);

  if (candidates.length === 0) {
    return { patientId, skipped: 'no_action_needed', details: results };
  }

  const pick = candidates[0];
  const doseAttuale = config.dose_per_pasto[pick.timing] || 0;
  const doseProposta = Math.max(0, doseAttuale + pick.r.delta);

  // Insert suggerimento
  const { error: insErr } = await sb
    .from('dose_adjustment_suggestions')
    .insert({
      paziente_id: patientId,
      tipo_pasto: pick.timing,
      dose_attuale: doseAttuale,
      dose_proposta: doseProposta,
      delta: pick.r.delta,
      pasti_analizzati: pick.r.evidence.n,
      pasti_alti: pick.r.evidence.alti,
      pasti_bassi: pick.r.evidence.bassi,
      glicemia_media: pick.r.evidence.media,
    });

  if (insErr) return { patientId, error: insErr.message };

  // Push se disponibile
  const { data: prof } = await sb
    .from('profiles')
    .select('expo_push_token, nome')
    .eq('id', patientId)
    .single();

  if (prof?.expo_push_token) {
    try {
      const verbo = pick.r.delta > 0 ? 'aumentare' : 'ridurre';
      const valore = Math.abs(pick.r.delta);
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          to: prof.expo_push_token,
          title: '🩺 Suggerimento dose settimanale',
          body: `Ho un suggerimento per ${verbo} di ${valore}U la dose ${pick.timing}. Apri l'app per decidere.`,
          sound: 'default',
          data: { type: 'dose_suggestion', timing: pick.timing },
        }),
      });
    } catch (e) {
      // push fallita, non bloccante
    }
  }

  return {
    patientId,
    suggested: pick.timing,
    from: doseAttuale,
    to: doseProposta,
    evidence: pick.r.evidence,
  };
}

export const handler = async () => {
  if (!SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'SUPABASE_SERVICE_ROLE_KEY mancante' }) };
  }

  const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Pazienti = tutti gli utenti con almeno una riga in insulin_config
  const { data: patients, error } = await sb
    .from('insulin_config')
    .select('user_id');

  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  const results = [];
  for (const p of (patients || [])) {
    try {
      results.push(await processPatient(sb, p.user_id));
    } catch (e) {
      results.push({ patientId: p.user_id, error: e.message });
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2),
  };
};
