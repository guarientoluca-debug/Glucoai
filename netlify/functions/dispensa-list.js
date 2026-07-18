const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let params;
  try { params = JSON.parse(event.body || '{}'); } catch (e) { params = event.queryStringParameters || {}; }

  const userId = params.user_id || '431eb6a4-0b96-4485-afd1-6c8fe238c062';
  const action = params.action || 'list';

  if (action === 'list') {
    const { data, error } = await supabase
      .from('alimenti')
      .select('id, nome, carbo_per_100g, proteine_per_100g, grassi_per_100g, fibre_per_100g, kcal_per_100g, fonte, verificato, fonte_dettaglio, barcode, ultimo_uso, categoria')
      .eq('user_id', userId)
      .order('ultimo_uso', { ascending: false, nullsFirst: false })
      .limit(500);

    return {
      statusCode: 200, headers,
      body: JSON.stringify({ prodotti: data || [], error: error?.message }),
    };
  }

  if (action === 'delete') {
    const { id } = params;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id mancante' }) };
    await supabase.from('alimenti').delete().eq('id', id).eq('user_id', userId);
    return { statusCode: 200, headers, body: JSON.stringify({ deleted: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'action non valida' }) };
};
