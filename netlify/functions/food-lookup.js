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

    // Funzione per pulire il nome: rimuove parentesi, aggettivi di cottura, e parti superflue
    function extractKeywords(name) {
      let clean = name.toLowerCase();
      // Rimuovi tutto tra parentesi
      clean = clean.replace(/\([^)]*\)/g, '');
      // Rimuovi aggettivi/specificazioni comuni dall'AI
      clean = clean.replace(/\b(a julienne|a bastoncini|a fette|a cubetti|a pezzi|a rondelle|grattuggiato|tritato|affettato|tagliato|scottato|scottate|alla griglia|al forno|in padella|alla piastra|saltato|soffritto|fritto|lesso|lessato|condito|condita|surgelato|fresco|freschi|fresche|crudo|cruda|crudi|crude|cotto|cotta|cotti|cotte|bollito|bollita|bolliti|bollite|porzione|misto|mista|misti|miste)\b/g, '');
      // Rimuovi articoli e preposizioni
      clean = clean.replace(/\b(il|lo|la|le|gli|i|un|una|del|della|dello|dei|delle|degli|di|da|in|con|su|per|tra|fra|al|alla|allo|alle|agli|ai|e|o|ed)\b/g, '');
      // Rimuovi spazi multipli e trim
      clean = clean.replace(/\s+/g, ' ').trim();
      return clean;
    }

    // Estrai parole chiave
    const keywords = extractKeywords(searchTerm).split(' ').filter(w => w.length > 2);

    // Ricerca esatta
    const { data: exactMatch } = await supabase
      .from('alimenti')
      .select('*')
      .eq('user_id', userId)
      .ilike('nome', searchTerm)
      .limit(1);

    if (exactMatch?.length > 0) {
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

    // Ricerca fuzzy (contiene il termine intero)
    const { data: fuzzyMatches } = await supabase
      .from('alimenti')
      .select('*')
      .eq('user_id', userId)
      .ilike('nome', `%${searchTerm}%`)
      .order('verificato', { ascending: false })
      .order('ultimo_uso', { ascending: false, nullsFirst: false })
      .limit(10);

    // Se fuzzy non trova nulla O non trova CREA, cerca anche per parole chiave
    let allMatches = fuzzyMatches || [];
    const hasCreaMatch = allMatches.some(m => m.fonte === 'crea' || m.fonte === 'etichetta' || m.fonte === 'manuale' || m.fonte === 'openfoodfacts');

    if (keywords.length > 0 && !hasCreaMatch) {
      // Cerca con ogni parola chiave e aggiungi i risultati
      for (const kw of keywords) {
        const { data: kwMatches } = await supabase
          .from('alimenti')
          .select('*')
          .eq('user_id', userId)
          .ilike('nome', `%${kw}%`)
          .eq('verificato', true) // solo verificati (CREA, etichetta, ecc)
          .order('ultimo_uso', { ascending: false, nullsFirst: false })
          .limit(10);
        if (kwMatches?.length > 0) {
          // Merge: aggiungi senza duplicati
          const existingIds = new Set(allMatches.map(m => m.id));
          for (const km of kwMatches) {
            if (!existingIds.has(km.id)) {
              allMatches.push(km);
              existingIds.add(km.id);
            }
          }
          break; // la prima keyword che trova match verificati basta
        }
      }
    }

    if (allMatches.length > 0) {
      // Priorità: fonte (paziente > CREA > AI) + rilevanza keywords
      const sortedMatches = allMatches.sort((a, b) => {
        const sourcePriority = (item) => {
          if (item.fonte === 'etichetta' || item.fonte === 'manuale' || item.fonte === 'openfoodfacts' || item.fonte === 'medico') return 0;
          if (item.fonte === 'crea') return 1;
          return 2; // ai o null
        };
        // Conta quante keywords matchano nel nome
        const keywordScore = (item) => {
          const nome = item.nome.toLowerCase();
          return keywords.filter(kw => nome.includes(kw)).length;
        };
        const srcDiff = sourcePriority(a) - sourcePriority(b);
        if (srcDiff !== 0) return srcDiff;
        // A parità di fonte, più keywords matchano = meglio
        return keywordScore(b) - keywordScore(a);
      });
      const best = sortedMatches[0];

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
          alternatives: sortedMatches.slice(1).map(a => ({
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
