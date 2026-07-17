const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = 'https://zynytvhmlnvlvswuhtse.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async function(event, context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  try {
    let body;
    try { body = JSON.parse(event.body); }
    catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON non valido' }) }; }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Chiave API non configurata su Netlify' }) };

    let messages;

    // ── Modalità 7: lettura etichetta nutrizionale (DEVE stare PRIMA del check imageBase64) ──
    if (body.analysisType === 'read-label' && body.imageBase64) {
      const { imageBase64, mediaType } = body;
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: `Leggi la tabella nutrizionale in questa foto di un prodotto alimentare confezionato.

Estrai i valori PER 100g dalla tabella. Se ci sono solo valori "per porzione", converti a per 100g usando il peso della porzione indicato.

Rispondi SOLO con JSON valido senza markdown:
{"nome_prodotto":"nome del prodotto se visibile","carbo_per_100g":15.7,"di_cui_zuccheri_per_100g":1.8,"proteine_per_100g":10,"grassi_per_100g":12.9,"fibre_per_100g":0.89,"kcal_per_100g":303,"sale_per_100g":0.89,"porzione_g":125,"note":"eventuali note"}

Se non riesci a leggere chiaramente un valore, metti null. Il campo più importante è carbo_per_100g — assicurati che sia corretto.` }
        ]
      }];

    // ── Modalità 1a: analisi foto pasto ──────────────────────────────────────
    // ── Modalità 1b: descrizione testuale pasto (senza foto) ─────────────────
    } else if (body.imageBase64 || body.textDescription) {

      // Cerca correzioni nutrizionali nel DB condiviso
      let correzioniDb = '';
      if (SUPABASE_KEY) {
        try {
          const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
          const { data: corrections } = await supabase
            .from('food_corrections')
            .select('nome_normalizzato, carbo_per_100g, proteine_per_100g, grassi_per_100g, kcal_per_100g, conferme')
            .gte('conferme', 2)
            .order('conferme', { ascending: false })
            .limit(50);
          if (corrections?.length > 0) {
            correzioniDb = '\n\nVALORI NUTRIZIONALI VALIDATI DALLA COMMUNITY (usa questi con priorità rispetto alle stime):\n' +
              corrections.map(c => `- ${c.nome_normalizzato}: ${c.carbo_per_100g}g carbo/100g${c.conferme > 1 ? ` (${c.conferme} conferme)` : ''}`).join('\n');
          }
        } catch(e) { console.log('Errore food_corrections lookup:', e.message); }
      }

      const FOOD_ANALYSIS_PROMPT = `Sei un nutrizionista clinico esperto, specializzato in conteggio carboidrati per pazienti diabetici di tipo 1.

OBIETTIVO PRINCIPALE:
Il dato PIÙ IMPORTANTE è "carbo_per_100g": DEVE essere il valore nutrizionale REALE dell'alimento, preso dalle tabelle nutrizionali ufficiali (CREA/INRAN, etichette, banche dati). NON stimare: usa valori di riferimento certi.

PRODOTTI CONFEZIONATI O DI MARCA:
Se riconosci un prodotto confezionato/industriale, usa i valori nutrizionali tipici per quella CATEGORIA di prodotto (es. bastoncini di pesce impanati: ~15-17g carbo/100g, merendine: ~55-65g carbo/100g). NON usare i valori dell'ingrediente base (es. non usare i carbo della mozzarella pura per degli stick di mozzarella impanati). Nelle note, suggerisci all'utente di verificare sull'etichetta.

REGOLA FONDAMENTALE PER PASTA, RISO, CEREALI, LEGUMI:
Questi alimenti hanno valori nutrizionali MOLTO diversi tra crudo e cotto. DEVI SEMPRE specificare lo stato nel campo "stato_cottura":
- Pasta CRUDA: ~70-75g carbo/100g → Pasta COTTA: ~25-31g carbo/100g (dipende dal formato)
- Riso CRUDO: ~78-80g carbo/100g → Riso COTTO: ~28-32g carbo/100g
- Legumi SECCHI: ~45-60g carbo/100g → Legumi COTTI: ~15-22g carbo/100g
- Couscous CRUDO: ~70g carbo/100g → Couscous COTTO: ~23g carbo/100g
Se il paziente indica il peso CRUDO, i carbo_per_100g devono riferirsi al prodotto CRUDO. Se indica il peso COTTO (o dalla foto si vede nel piatto), usa i valori del COTTO.
Nel campo "nome" specifica sempre "(cotto/a)" o "(crudo/a)" — es. "Spaghetti cotti", "Riso basmati crudo".

VALORI DI RIFERIMENTO carbo_per_100g (USA QUESTI, NON INVENTARE):
- Pasta di semola cotta: 30.3g | cruda: 72g
- Pasta integrale cotta: 26.7g | cruda: 66g
- Riso bianco cotto: 28.7g | crudo: 80g
- Riso basmati cotto: 28g | crudo: 78g
- Pane bianco: 49g | Pane integrale: 44g
- Focaccia/pizza bianca: 52-54g
- Patate bollite: 16g | Patate fritte: 29g
- Banana (con buccia): 15.5g | (senza buccia): 20.1g
- Mela: 11g | Arancia: 8g
- Cornetto semplice: 48g | Cornetto farcito: 52-58g
- Biscotti frollini: 68-72g
- Latte intero: 4.7g | Yogurt bianco: 4.3g
- Gelato: 24-33g (varia molto per tipo)
Se conosci il valore specifico più preciso per l'alimento in foto, usalo. In caso di dubbio, preferisci la fonte CREA/INRAN.

STIMA DELLE PORZIONI${body.imageBase64 ? ' (DALLA FOTO)' : ''}:
${body.imageBase64 ? `IMPORTANTE — STIMA DEL PESO:
Se nella foto è visibile una MANO accanto al cibo:
${body.handSize ? `- La larghezza del palmo del paziente è ESATTAMENTE ${body.handSize} cm (misurata con righello).` : '- Larghezza palmo stimata: ~8-9 cm.'}
- PROCEDURA OBBLIGATORIA: 
  1. Misura visivamente quante volte il palmo (${body.handSize || '8.5'} cm) entra nella lunghezza/larghezza dell'alimento
  2. Calcola le dimensioni reali dell'alimento in cm
  3. Stima il volume e converti in grammi usando la densità tipica dell'alimento
  4. ESEMPIO: se un panino è largo quanto 1.5 palmi = ${Math.round((body.handSize || 8.5) * 1.5)} cm, e alto circa mezzo palmo = ${Math.round((body.handSize || 8.5) * 0.5)} cm → volume ~300 cm³ → pane ha densità ~0.3 g/cm³ → peso ~90g
  5. ATTENZIONE: tendi a SOVRASTIMARE il peso. Se sei incerto, scegli il valore PIÙ BASSO della tua stima.

Se NON c'è una mano nella foto, usa questi riferimenti:
- Piatto piano standard: diametro 26-28 cm
- Piatto fondo standard: diametro 20-22 cm  
- Posate standard: forchetta ~20 cm, cucchiaio ~18 cm
- Bicchiere standard: 200-250 ml
- Fetta di pane: 25-30g
- Porzione tipica di pasta cotta nel piatto: 180-250g (= 70-100g di pasta cruda)
Se non ci sono riferimenti di scala, usa porzioni standard italiane.` : 'Il paziente ha descritto il pasto a parole. Chiedi conferma del peso se ambiguo. Se indica solo il nome dell\'alimento senza peso, usa le porzioni standard italiane più comuni.'}

FORMATO RISPOSTA — rispondi SOLO con JSON valido senza markdown:
{"alimenti":[{"nome":"Spaghetti cotti","quantita_g":220,"carbo_per_100g":30.3,"carbo_g":66.7,"stato_cottura":"cotto","proteine_per_100g":5.3,"grassi_per_100g":0.4,"fibre_per_100g":1.2,"kcal_per_100g":137,"categoria":"salato","indice_glicemico":"lento"}],"totale_carbo_g":66.7,"totale_proteine_g":11.7,"totale_grassi_g":0.9,"totale_fibre_g":2.6,"totale_kcal":301,"note":"Valori riferiti alla pasta cotta. Peso crudo stimato: ~88g."}

CAMPI PER OGNI ALIMENTO:
- nome: nome preciso con stato (cotto/crudo) quando rilevante
- quantita_g: peso stimato in grammi
- stima_peso_note: breve spiegazione di come hai stimato il peso (es. "circa 1.2 palmi di lunghezza = 10cm, altezza 4cm, densità pane ~0.3 → ~50g" oppure "porzione standard italiana")
- carbo_per_100g: valore da tabelle nutrizionali (NON stimato)
- carbo_g: carbo totali della porzione = (quantita_g × carbo_per_100g) / 100
- stato_cottura: "cotto" | "crudo" | null (per alimenti dove non si applica)
- proteine_per_100g, grassi_per_100g, fibre_per_100g, kcal_per_100g
- categoria: "dolce" | "salato"
- indice_glicemico: "lento" (pasta, legumi, riso basmati, verdure, cereali integrali) | "medio" (riso bianco, frutta matura, pane integrale, patate bollite) | "veloce" (focaccia, pizza, pane bianco, dolci, succhi, cornetti, crackers, patate fritte)`;

      if (body.imageBase64) {
        const { imageBase64, mediaType } = body;
        messages = [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: FOOD_ANALYSIS_PROMPT + correzioniDb }
          ]
        }];
      } else {
        // Modalità testo: il paziente descrive il pasto
        const descrizione = body.textDescription;
        messages = [{
          role: 'user',
          content: `${FOOD_ANALYSIS_PROMPT}${correzioniDb}

DESCRIZIONE DEL PASTO DAL PAZIENTE:
"${descrizione}"

Analizza la descrizione, identifica ogni alimento e applica i valori nutrizionali da tabelle ufficiali. Se il paziente indica un peso, usalo. Se non indica il peso, usa porzioni standard italiane e segnalalo nelle note.`
        }];
      }

    // ── Modalità 2: calcolo rapporto insulina/carbo ──────────────────────────
    } else if (body.analysisType === 'insulin-ratio') {
      const { meals, insulin, readings, currentConfig } = body.data;

      // Costruisci sommario dati storici
      const pairs = meals.map(m => {
        const mealTime = new Date(m.date).getTime();
        // Insulina rapida entro 30 min prima o dopo il pasto
        const dose = insulin
          .filter(i => i.type === 'rapida' && Math.abs(new Date(i.date).getTime() - mealTime) <= 30 * 60000)
          .sort((a,b) => Math.abs(new Date(a.date).getTime()-mealTime) - Math.abs(new Date(b.date).getTime()-mealTime))[0];
        // Glicemia post-pasto entro 3h
        const postGlucose = readings
          .filter(r => r.timing === 'post-pasto' && new Date(r.date).getTime() > mealTime && new Date(r.date).getTime() - mealTime <= 3*3600000)
          .sort((a,b) => new Date(a.date)-new Date(b.date))[0];
        if (m.carbs > 0 && dose) {
          return { carbo: m.carbs, unita: dose.units, glicemiaPost: postGlucose?.value || null, data: m.date.slice(0,10) };
        }
        return null;
      }).filter(Boolean);

      if (pairs.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Dati insufficienti: registra almeno un pasto con carboidrati e la relativa dose di insulina rapida' }) };
      }

      const datiTesto = pairs.map(p =>
        `- ${p.data}: ${p.carbo}g carbo → ${p.unita}U rapida${p.glicemiaPost ? ` → glicemia post ${p.glicemiaPost} mg/dL` : ''}`
      ).join('\n');

      const configTesto = currentConfig.targetGlucose
        ? `Glicemia target del paziente: ${currentConfig.targetGlucose} mg/dL. ISF attuale: ${currentConfig.isf} mg/dL per unità.`
        : '';

      messages = [{
        role: 'user',
        content: `Sei un diabetologo esperto. Analizza questi dati reali di un paziente diabetico e calcola il rapporto ottimale insulina/carboidrati (quanti grammi di carboidrati coprono 1 unità di insulina rapida).

${configTesto}

Dati storici (${pairs.length} pasti con insulina):
${datiTesto}

Calcola il rapporto ottimale basandoti sui casi in cui la glicemia post-pasto era più vicina al target. Se non ci sono glicemie post disponibili, usa la media dei rapporti osservati.

Rispondi SOLO con JSON valido senza markdown, formato:
{"rapporto_g_per_u": 10, "confidenza": "alta|media|bassa", "spiegazione": "breve spiegazione in italiano", "note_cliniche": "eventuali osservazioni utili", "campioni_usati": 5}`
      }];

    // ── Modalità 3: assistente pasto ────────────────────────────────────────
    } else if (body.analysisType === 'meal-assistant') {
      const { glicemiaAttuale, carbo, doseIpotizzata, config } = body.data;

      const doseCarbo = carbo / config.carbRatio;
      const doseCorrezione = config.isf ? (glicemiaAttuale - config.targetGlucose) / config.isf : 0;
      const doseSuggerita = Math.max(0, doseCarbo + doseCorrezione);

      messages = [{
        role: 'user',
        content: `Sei un assistente diabetologo che parla in italiano semplice e diretto. 
        
Il paziente sta per mangiare e ha questi dati:
- Glicemia attuale: ${glicemiaAttuale} mg/dL (target: ${config.targetGlucose} mg/dL)
- Carboidrati del pasto: ${carbo}g
- Dose minima prescritta dal medico: ${config.rapidaBase}U di insulina rapida
- Dose che sta pensando di fare: ${doseIpotizzata}U
- Rapporto insulina/carbo: 1U ogni ${config.carbRatio}g
- ISF: 1U abbassa la glicemia di ${config.isf} mg/dL

Calcolo matematico:
- Per i carbo: ${carbo}g ÷ ${config.carbRatio}g/U = ${doseCarbo.toFixed(1)}U
- Correzione glicemica: (${glicemiaAttuale} - ${config.targetGlucose}) ÷ ${config.isf} = ${doseCorrezione.toFixed(1)}U
- Dose totale suggerita: ${doseSuggerita.toFixed(1)}U (arrotondata: ${Math.round(doseSuggerita * 2) / 2}U)

Valuta se la dose ipotizzata di ${doseIpotizzata}U è appropriata. Tieni conto che la dose minima prescritta dal medico è ${config.rapidaBase}U.

Rispondi SOLO con JSON valido senza markdown:
{"dose_consigliata": ${Math.round(doseSuggerita * 2) / 2}, "valutazione": "giusta|leggermente_bassa|troppo_bassa|leggermente_alta|troppo_alta", "messaggio": "messaggio breve e diretto in italiano (max 2 righe)", "dettaglio": "spiegazione del calcolo in italiano semplice"}`
      }];

    // ── Modalità 4: correzione iperglicemia ─────────────────────────────────
    } else if (body.analysisType === 'correction') {
      const { glicemiaAttuale, doseIpotizzata, config } = body.data;
      const diff = glicemiaAttuale - config.targetGlucose;
      const doseSuggerita = Math.max(0, Math.round((diff / config.isf) * 2) / 2);

      messages = [{
        role: 'user',
        content: `Sei un assistente diabetologo che parla in italiano semplice e diretto.

Il paziente ha un'iperglicemia e vuole correggerla con insulina rapida:
- Glicemia attuale: ${glicemiaAttuale} mg/dL
- Glicemia target: ${config.targetGlucose} mg/dL
- Eccesso: ${diff} mg/dL sopra il target
- ISF: 1U abbassa la glicemia di ${config.isf} mg/dL
- Dose di correzione calcolata: ${doseSuggerita}U
- Dose che il paziente pensa di fare: ${doseIpotizzata}U

Valuta se la dose ipotizzata è appropriata per questa correzione. Non sta mangiando, è solo una correzione glicemica.

Rispondi SOLO con JSON valido senza markdown:
{"dose_consigliata": ${doseSuggerita}, "valutazione": "giusta|leggermente_bassa|troppo_bassa|leggermente_alta|troppo_alta", "messaggio": "messaggio breve e diretto in italiano (max 2 righe)", "dettaglio": "spiegazione del calcolo in italiano semplice"}`
      }];

    // ── Modalità 5: analisi pattern glicemici ───────────────────────────────
    } else if (body.analysisType === 'pattern-analysis') {
      const { events, config, stats } = body.data;

      const datiTesto = events.map(e =>
        `- ${e.date} ${e.timing}: ${e.carbs}g carbo${e.dose ? ` → ${e.dose}U insulina` : ' (no insulina registrata)'}${e.pre ? ` | pre: ${e.pre} mg/dL` : ''}${e.post ? ` | post: ${e.post} mg/dL` : ''}`
      ).join('\n');

      messages = [{
        role: 'user',
        content: `Sei un diabetologo esperto. Analizza i pattern glicemici di questo paziente diabetico.

CONFIGURAZIONE:
- Rapporto insulina/carbo: ${config.carbRatio || '?'}g per 1U
- Target glicemia: ${config.targetGlucose || 120} mg/dL
- ISF: ${config.isf || 50} mg/dL per U
- Dosi prescritte: colazione ${config.dosePerPasto?.colazione || '?'}U, pranzo ${config.dosePerPasto?.pranzo || '?'}U, cena ${config.dosePerPasto?.cena || '?'}U

DATI PASTI (${events.length} eventi):
${datiTesto}

Analizza i pattern e identifica:
1. Per ogni tipo di pasto (colazione/pranzo/cena/spuntino) valuta se le dosi funzionano
2. Identifica pattern problematici (es. ipoglicemie serali ricorrenti)
3. Suggerisci aggiustamenti specifici al rapporto insulina/carbo se necessario

Rispondi SOLO con JSON valido senza markdown:
{
  "sintesi": "valutazione generale in 2-3 frasi",
  "pattern_per_pasto": [
    {
      "pasto": "colazione|pranzo|cena|spuntino",
      "severita": "positivo|attenzione|critico",
      "osservazione": "cosa noti",
      "suggerimento": "cosa fare (opzionale)"
    }
  ],
  "raccomandazione_rapporto": "suggerimento sul rapporto insulina/carbo (opzionale)"
}`
      }];

    // ── Modalità 6: chat medico (assistente clinico per il portale medico) ──
    } else if (body.analysisType === 'medico-chat') {
      const { messaggio, storia, paziente } = body.data;

      const datiPaziente = `
PAZIENTE: ${paziente.nome || 'N/D'}
Peso: ${paziente.peso || 'non registrato'} kg
ISF attuale: ${paziente.isf || 'non calcolato'} mg/dL per unità
Dosi prescritte: colazione ${paziente.config?.colazione || '?'}U, pranzo ${paziente.config?.pranzo || '?'}U, cena ${paziente.config?.cena || '?'}U, notte ${paziente.config?.notte || '?'}U

ULTIME GLICEMIE (max 40, ultimi 14gg): ${(paziente.readings_recenti || []).map(r => `${r.value}mg/dL(${r.timing || '?'})`).join(', ') || 'nessuna'}

ULTIME DOSI INSULINA (max 40, ultimi 14gg): ${(paziente.insulin_recenti || []).map(i => `${i.units}U ${i.type}`).join(', ') || 'nessuna'}

ULTIMI PASTI (max 40, ultimi 14gg): ${(paziente.meals_recenti || []).map(m => `${m.carbs}g carbo (${m.timing || '?'})`).join(', ') || 'nessuno'}
`.trim();

      const storiaTesto = (storia || []).map(m => `${m.role === 'user' ? 'Medico' : 'Assistente'}: ${m.content}`).join('\n');

      messages = [{
        role: 'user',
        content: `Sei un assistente clinico AI all'interno di un portale per diabetologi. Parli con un MEDICO (non con il paziente), in italiano professionale e diretto. Il medico sta consultando i dati di un suo paziente diabetico e può chiederti analisi oppure darti istruzioni dirette per aggiornare i parametri di terapia (ISF, dosi prescritte).

${datiPaziente}

${storiaTesto ? 'CONVERSAZIONE PRECEDENTE:\n' + storiaTesto + '\n' : ''}

MESSAGGIO DEL MEDICO:
${messaggio}

ISTRUZIONI:
- Se il medico chiede un'analisi (es. "come sta andando questo paziente?"), rispondi con un'osservazione clinica concisa basata sui dati forniti.
- Se il medico dà un'istruzione esplicita per modificare un parametro (es. "abbassa l'ISF a 45", "porta la dose di pranzo a 8 unità", "aumenta la dose serale di 2 unità"), CALCOLA il nuovo valore esatto e restituiscilo nel campo parametri_da_aggiornare. Usa SOLO queste chiavi quando applicabile: isf, dose_colazione, dose_pranzo, dose_cena, dose_notte.
- Se il messaggio è ambiguo o ti manca un dato per applicare la modifica con sicurezza, NON modificare nulla: chiedi chiarimento nella risposta testuale e lascia parametri_da_aggiornare vuoto.
- Non modificare mai più di quanto richiesto esplicitamente o chiaramente implicato dal medico.
- Sii sintetico: 2-4 frasi per le analisi, 1-2 frasi per confermare una modifica applicata.

Rispondi SOLO con JSON valido senza markdown, formato:
{"risposta": "testo della risposta per il medico", "parametri_da_aggiornare": {}}`
      }];

    } else {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Parametri mancanti: imageBase64 o analysisType richiesto' }) };
    }

    // ── Chiamata API Anthropic ───────────────────────────────────────────────
    const isFoodAnalysis = (!!body.imageBase64 || !!body.textDescription) && body.analysisType !== 'read-label';
    const isLabelReading = body.analysisType === 'read-label';
    const isPhotoAnalysis = !!body.imageBase64;
    const isTextOnly = !!body.textDescription && !body.imageBase64;

    // Foto cibo/etichetta → Sonnet (serve vision). Testo puro → Haiku (più veloce)
    const model = (isPhotoAnalysis || isLabelReading) ? 'claude-sonnet-4-6' : 
                  isTextOnly ? 'claude-haiku-4-5-20251001' :
                  (body.analysisType === 'pattern-analysis' || body.analysisType === 'medico-chat') ? 'claude-haiku-4-5-20251001' : 'claude-haiku-4-5-20251001';

    const payloadObj = {
      model,
      max_tokens: body.analysisType === 'pattern-analysis' ? 2000 : ((isFoodAnalysis || isLabelReading) ? 1500 : (body.analysisType === 'medico-chat' ? 1200 : 1000)),
      messages
    };

    const payload = JSON.stringify(payloadObj);

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      let data = '';
      const req = https.request(options, (res) => {
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', e => reject(e));
      req.setTimeout(25000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(payload);
      req.end();
    });

    let anthropicResponse;
    try { anthropicResponse = JSON.parse(result); }
    catch(e) { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta API non valida' }) }; }

    if (anthropicResponse.error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: anthropicResponse.error.message || 'Errore Anthropic' }) };
    }

    // Estrai testo dalla risposta (può avere più blocchi con web_search)
    const textBlocks = (anthropicResponse?.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text);
    const text = textBlocks.join('\n');
    if (!text) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Risposta vuota da Claude' }) };

    // Estrai JSON dalla risposta — potrebbe essere avvolto in testo o markdown
    let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    
    // Se il testo contiene JSON mescolato a testo, prova ad estrarlo
    let jsonResult;
    try {
      jsonResult = JSON.parse(clean);
    } catch(e) {
      // Cerca il primo { e l'ultimo } per estrarre il JSON
      const firstBrace = clean.indexOf('{');
      const lastBrace = clean.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        const jsonCandidate = clean.substring(firstBrace, lastBrace + 1);
        try {
          jsonResult = JSON.parse(jsonCandidate);
        } catch(e2) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude non ha restituito JSON valido', raw: clean.slice(0, 300) }) };
        }
      } else {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Claude non ha restituito JSON valido', raw: clean.slice(0, 300) }) };
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify(jsonResult) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
