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
  try { params = JSON.parse(event.body || '{}'); } catch (e) { params = {}; }

  const userId = params.user_id || '431eb6a4-0b96-4485-afd1-6c8fe238c062';
  const action = params.action || 'list';

  // LIST
  if (action === 'list') {
    const { data, error } = await supabase
      .from('ricette')
      .select('*')
      .eq('user_id', userId)
      .order('ultimo_uso', { ascending: false, nullsFirst: false });
    return { statusCode: 200, headers, body: JSON.stringify({ ricette: data || [], error: error?.message }) };
  }

  // CREATE
  if (action === 'create') {
    const { nome, ingredienti, carbo_totali, note } = params;
    if (!nome || !ingredienti) return { statusCode: 400, headers, body: JSON.stringify({ error: 'nome e ingredienti obbligatori' }) };
    const { data, error } = await supabase
      .from('ricette')
      .insert({ user_id: userId, nome, ingredienti, carbo_totali, note, ultimo_uso: new Date().toISOString() })
      .select()
      .single();
    return { statusCode: 200, headers, body: JSON.stringify({ ricetta: data, error: error?.message }) };
  }

  // UPDATE
  if (action === 'update') {
    const { id, nome, ingredienti, carbo_totali, note } = params;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id obbligatorio' }) };
    const updates = {};
    if (nome) updates.nome = nome;
    if (ingredienti) updates.ingredienti = ingredienti;
    if (carbo_totali !== undefined) updates.carbo_totali = carbo_totali;
    if (note !== undefined) updates.note = note;
    updates.ultimo_uso = new Date().toISOString();
    const { data, error } = await supabase.from('ricette').update(updates).eq('id', id).eq('user_id', userId).select().single();
    return { statusCode: 200, headers, body: JSON.stringify({ ricetta: data, error: error?.message }) };
  }

  // DELETE
  if (action === 'delete') {
    const { id } = params;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id obbligatorio' }) };
    await supabase.from('ricette').delete().eq('id', id).eq('user_id', userId);
    return { statusCode: 200, headers, body: JSON.stringify({ deleted: true }) };
  }

  // USE (aggiorna ultimo_uso)
  if (action === 'use') {
    const { id } = params;
    if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id obbligatorio' }) };
    await supabase.from('ricette').update({ ultimo_uso: new Date().toISOString() }).eq('id', id);
    return { statusCode: 200, headers, body: JSON.stringify({ used: true }) };
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'action non valida' }) };
};
