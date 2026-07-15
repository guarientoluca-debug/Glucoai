const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fetch JSON da URL (per OpenFoodFacts)
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'GlucoAI/1.0 (glucoai.it)' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (!SUPABASE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing SUPABASE_KEY' }) };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let params;
  try {
    params = JSON.parse(event.body || '{}');
  } catch (e) {
    // Prova query string
    params = event.queryStringParameters || {};
  }

  const { barcode, nome, user_id } = params;
  const userId = user_id || '431eb6a4-0b96-4485-afd1-6c8fe238c062';

  // ============================================
  // MODALITA 1: BARCODE → OpenFoodFacts
  // ============================================
  if (barcode) {
    // Prima cerca nel nostro DB
    const { data: localMatch } = await supabase
      .from('alimenti')
      .select('*')
      .eq('user_id', userId)
      .eq('barcode', barcode)
      .limit(1);

    if (localMatch?.length > 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          found: true,
          source: localMatch[0].fonte || 'db_locale',
          verified: localMatch[0].verificato || false,
          fonte_dettaglio: localMatch[0].fonte_dettaglio,
          alimento: localMatch[0],
        }),
      };
    }

    // Cerca su OpenFoodFacts
    try {
      const off = await fetchJSON(`https://world.openfoodfacts.org/api/v2/product/${barcode}.json`);

      if (off.status === 1 && off.product) {
        const p = off.product;
        const nutriments = p.nutriments || {};

        const alimento = {
          nome: p.product_name_it || p.product_name || 'Prodotto sconosciuto',
          carbo_per_100g: nutriments.carbohydrates_100g || null,
          proteine_per_100g: nutriments.proteins_100g || null,
          grassi_per_100g: nutriments.fat_100g || null,
          fibre_per_100g: nutriments.fiber_100g || null,
          kcal_per_100g: nutriments['energy-kcal_100g'] || null,
          barcode: barcode,
          marca: p.brands || null,
          immagine: p.image_url || null,
        };

        // Salva nel nostro DB per le prossime volte
        if (alimento.carbo_per_100g !== null) {
          await supabase.from('alimenti').insert({
            user_id: userId,
            nome: alimento.nome,
            carbo_per_100g: alimento.carbo_per_100g,
            proteine_per_100g: alimento.proteine_per_100g,
            grassi_per_100g: alimento.grassi_per_100g,
            fibre_per_100g: alimento.fibre_per_100g,
            kcal_per_100g: alimento.kcal_per_100g,
            barcode: barcode,
            fonte: 'openfoodfacts',
            verificato: true,
            fonte_dettaglio: `OpenFoodFacts - ${alimento.nome} (${p.brands || 'marca sconosciuta'})`,
            ultimo_uso: new Date().toISOString(),
          });
        }

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            found: true,
            source: 'openfoodfacts',
            verified: true,
            fonte_dettaglio: `OpenFoodFacts - ${p.brands || ''}`,
            alimento,
          }),
        };
      }
    } catch (e) {
      // OpenFoodFacts non disponibile, continua
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: false,
        source: null,
        message: 'Prodotto non trovato. Prova con la foto dell\'etichetta.',
      }),
    };
  }

  // ============================================
  // MODALITA 2: NOME → DB locale (CREA + storico)
  // ============================================
  if (nome) {
    const searchTerm = nome.trim().toLowerCase();

    // Ricerca esatta
    const { data: exactMatch } = await supabase
      .from('alimenti')
      .select('*')
      .eq('user_id', userId)
      .ilike('nome', searchTerm)
      .limit(1);

    if (exactMatch?.length > 0) {
      // Aggiorna ultimo_uso
      await supabase.from('alimenti')
        .update({ ultimo_uso: new Date().toISOString() })
        .eq('id', exactMatch[0].id);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          found: true,
          source: exactMatch[0].fonte || 'db_locale',
          verified: exactMatch[0].verificato || false,
          fonte_dettaglio: exactMatch[0].fonte_dettaglio,
          alimento: exactMatch[0],
          alternatives: [],
        }),
      };
    }

    // Ricerca fuzzy (contiene)
    const { data: fuzzyMatches } = await supabase
      .from('alimenti')
      .select('*')
      .eq('user_id', userId)
      .ilike('nome', `%${searchTerm}%`)
      .order('verificato', { ascending: false }) // CREA prima
      .limit(10);

    if (fuzzyMatches?.length > 0) {
      // Il primo risultato verificato ha priorita
      const best = fuzzyMatches[0];

      await supabase.from('alimenti')
        .update({ ultimo_uso: new Date().toISOString() })
        .eq('id', best.id);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          found: true,
          source: best.fonte || 'db_locale',
          verified: best.verificato || false,
          fonte_dettaglio: best.fonte_dettaglio,
          alimento: best,
          alternatives: fuzzyMatches.slice(1).map(a => ({
            id: a.id,
            nome: a.nome,
            carbo_per_100g: a.carbo_per_100g,
            fonte: a.fonte,
            verificato: a.verificato,
          })),
        }),
      };
    }

    // Nessun match nel DB
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: false,
        source: null,
        message: 'Alimento non trovato nel database. Usa la stima AI.',
        search_term: searchTerm,
      }),
    };
  }

  // ============================================
  // NESSUN PARAMETRO
  // ============================================
  return {
    statusCode: 400,
    headers,
    body: JSON.stringify({
      error: 'Parametro mancante. Invia "barcode" o "nome".',
      usage: {
        barcode: 'POST { "barcode": "8076809513388" }',
        nome: 'POST { "nome": "pasta di semola" }',
      },
    }),
  };
};
