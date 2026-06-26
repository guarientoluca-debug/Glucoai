const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const { paziente_id, titolo, messaggio } = JSON.parse(event.body || '{}');

  if (!paziente_id || !messaggio) {
    return { statusCode: 400, body: 'paziente_id e messaggio obbligatori' };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Recupera expo_push_token del paziente
  const { data: profile, error } = await supabase
    .from('profiles')
    .select('expo_push_token, nome')
    .eq('id', paziente_id)
    .single();

  if (error || !profile?.expo_push_token) {
    return { statusCode: 404, body: 'Token push non trovato per questo paziente' };
  }

  // Invia notifica tramite Expo Push API
  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      to: profile.expo_push_token,
      title: titolo || '🩺 Messaggio dal tuo medico',
      body: messaggio,
      sound: 'default',
      data: { type: 'nota_medico' }
    })
  });

  const result = await response.json();
  console.log('Expo push result:', JSON.stringify(result));

  if (result.data?.status === 'error') {
    return { statusCode: 500, body: 'Errore invio: ' + result.data.message };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, paziente: profile.nome })
  };
};
