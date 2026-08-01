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
  // MODALITA 2: NOME → prima "alimenti" (prodotti confezionati verificati),
  // poi fallback su "crea_alimenti" (898 alimenti generici ufficiali CREA)
  // ============================================
  if (nome) {
    const searchTerm = nome.trim().toLowerCase();

    // Funzione per pulire il nome: rimuove parentesi, aggettivi di cottura, e parti superflue
    function extractKeywords(name) {
      let clean = name.toLowerCase();
      clean = clean.replace(/\([^)]*\)/g, '');
      clean = clean.replace(/\b(a julienne|a bastoncini|a fette|a cubetti|a pezzi|a rondelle|grattuggiato|tritato|affettato|tagliato|scottato|scottate|alla griglia|al forno|in padella|alla piastra|saltato|soffritto|fritto|lesso|lessato|condito|condita|surgelato|fresco|freschi|fresche|crudo|cruda|crudi|crude|cotto|cotta|cotti|cotte|bollito|bollita|bolliti|bollite|porzione|misto|mista|misti|miste)\b/g, '');
      clean = clean.replace(/\b(il|lo|la|le|gli|i|un|una|del|della|dello|dei|delle|degli|di|da|in|con|su|per|tra|fra|al|alla|allo|alle|agli|ai|e|o|ed)\b/g, '');
      clean = clean.replace(/\s+/g, ' ').trim();
      return clean;
    }

    const keywords = extractKeywords(searchTerm).split(' ').filter(w => w.length > 2);

    // Cerca un fattore di conversione cotto/crudo specifico (CREA Tabella C).
    async function trovaFattoreCottura(nomeAlimento) {
      try {
        const { data: fattoriMatches } = await supabase
          .from('fattori_cottura')
          .select('alimento, categoria, yield_factor, alias')
          .limit(100);
        if (!fattoriMatches?.length) return { yieldFactor: null, yieldFactorFonte: null };
        const nomeNorm = nomeAlimento.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
        const paroleNome = nomeNorm.split(' ');
        let miglioreMatch = null;
        let miglioreSpecificita = 0;
        for (const f of fattoriMatches) {
          const aliasTrovato = (f.alias || []).find(al => {
            const paroleAlias = al.toLowerCase().split(' ');
            return paroleAlias.every(pa => paroleNome.includes(pa));
          });
          const canonicoHit = nomeNorm.includes(f.alimento.toLowerCase());
          const termine = aliasTrovato || (canonicoHit ? f.alimento : null);
          const specificita = termine ? termine.split(' ').length : 0;
          if (termine && specificita > miglioreSpecificita) {
            miglioreSpecificita = specificita;
            miglioreMatch = f;
          }
        }
        return miglioreMatch
          ? { yieldFactor: miglioreMatch.yield_factor, yieldFactorFonte: miglioreMatch.alimento }
          : { yieldFactor: null, yieldFactorFonte: null };
      } catch (e) {
        return { yieldFactor: null, yieldFactorFonte: null };
      }
    }

    // Trova il miglior match per parole chiave in un array di righe già recuperate
    // (usato sia per "alimenti" che per "crea_alimenti", stessa logica di scoring).
    function migliorMatchPerKeyword(righe) {
      if (!righe.length) return null;
      const sorted = [...righe].sort((a, b) => {
        const score = (item) => keywords.filter(kw => item.nome.toLowerCase().includes(kw)).length;
        return score(b) - score(a);
      });
      const best = sorted[0];
      const scoreBest = keywords.filter(kw => best.nome.toLowerCase().includes(kw)).length;
      const minKeywords = Math.max(2, Math.ceil(keywords.length * 0.5));
      if (scoreBest < minKeywords && !best.nome.toLowerCase().includes(searchTerm)) return null;
      return { best, alternatives: sorted.slice(1, 4) };
    }

    // ── STEP 1: cerca in "alimenti" — prodotti confezionati verificati ──
    // (dopo la ripulitura, questa tabella contiene SOLO openfoodfacts/etichetta/manuale:
    // qualsiasi match qui è automaticamente verificato, niente più controlli su nome_tipo)
    const { data: alimEsatto } = await supabase
      .from('alimenti').select('*').eq('user_id', userId).ilike('nome', searchTerm).limit(1);

    if (alimEsatto?.length > 0) {
      await supabase.from('alimenti').update({ ultimo_uso: new Date().toISOString() }).eq('id', alimEsatto[0].id);
      const { yieldFactor, yieldFactorFonte } = await trovaFattoreCottura(alimEsatto[0].nome);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          found: true, source: alimEsatto[0].fonte, verified: true,
          fonte_dettaglio: alimEsatto[0].fonte_dettaglio, alimento: alimEsatto[0],
          yield_factor: yieldFactor, yield_factor_fonte: yieldFactorFonte, alternatives: [],
        }),
      };
    }

    const { data: alimFuzzy } = await supabase
      .from('alimenti').select('*').eq('user_id', userId).ilike('nome', `%${searchTerm}%`).limit(10);

    let alimKeyword = alimFuzzy || [];
    if (keywords.length > 0) {
      for (const kw of keywords) {
        const { data: km } = await supabase.from('alimenti').select('*').eq('user_id', userId).ilike('nome', `%${kw}%`).limit(10);
        if (km?.length > 0) {
          const ids = new Set(alimKeyword.map(m => m.id));
          for (const k of km) if (!ids.has(k.id)) { alimKeyword.push(k); ids.add(k.id); }
        }
      }
    }

    const matchAlimenti = migliorMatchPerKeyword(alimKeyword);
    if (matchAlimenti) {
      const best = matchAlimenti.best;
      await supabase.from('alimenti').update({ ultimo_uso: new Date().toISOString() }).eq('id', best.id);
      const { yieldFactor, yieldFactorFonte } = await trovaFattoreCottura(best.nome);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          found: true, source: best.fonte, verified: true,
          fonte_dettaglio: best.fonte_dettaglio, alimento: best,
          yield_factor: yieldFactor, yield_factor_fonte: yieldFactorFonte,
          alternatives: matchAlimenti.alternatives.map(a => ({ id: a.id, nome: a.nome, carbo_per_100g: a.carbo_per_100g, fonte: a.fonte, verificato: true })),
        }),
      };
    }

    // ── STEP 2: nessun confezionato trovato → cerca in "crea_alimenti" (898 alimenti ufficiali) ──
    const { data: creaEsatto } = await supabase
      .from('crea_alimenti').select('*').ilike('nome', searchTerm).limit(1);

    if (creaEsatto?.length > 0) {
      const { yieldFactor, yieldFactorFonte } = await trovaFattoreCottura(creaEsatto[0].nome);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          found: true, source: 'crea', verified: true,
          fonte_dettaglio: creaEsatto[0].fonte_dettaglio, alimento: creaEsatto[0],
          categoria: creaEsatto[0].categoria,
          yield_factor: yieldFactor, yield_factor_fonte: yieldFactorFonte, alternatives: [],
        }),
      };
    }

    const { data: creaFuzzy } = await supabase
      .from('crea_alimenti').select('*').ilike('nome', `%${searchTerm}%`).limit(10);

    let creaKeyword = creaFuzzy || [];
    if (keywords.length > 0) {
      for (const kw of keywords) {
        const { data: km } = await supabase.from('crea_alimenti').select('*').ilike('nome', `%${kw}%`).limit(10);
        if (km?.length > 0) {
          const ids = new Set(creaKeyword.map(m => m.id));
          for (const k of km) if (!ids.has(k.id)) { creaKeyword.push(k); ids.add(k.id); }
        }
      }
    }

    const matchCrea = migliorMatchPerKeyword(creaKeyword);
    if (matchCrea) {
      const best = matchCrea.best;
      const { yieldFactor, yieldFactorFonte } = await trovaFattoreCottura(best.nome);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          found: true, source: 'crea', verified: true,
          fonte_dettaglio: best.fonte_dettaglio, alimento: best, categoria: best.categoria,
          yield_factor: yieldFactor, yield_factor_fonte: yieldFactorFonte,
          alternatives: matchCrea.alternatives.map(a => ({ id: a.id, nome: a.nome, carbo_per_100g: a.carbo_per_100g, fonte: 'crea', verificato: true })),
        }),
      };
    }

    // Nessun match, né tra i confezionati né in CREA
    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        found: false, source: null,
        message: 'Alimento non trovato né tra i prodotti verificati né in CREA.',
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
