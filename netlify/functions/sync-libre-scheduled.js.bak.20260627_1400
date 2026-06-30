const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function request(hostname, path, method, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'User-Agent': 'LibreLinkUp/4.16.0 CFNetwork/1492.0.1 Darwin/23.3.0',
      'Content-Type': 'application/json',
      'version': '4.16.0',
      'product': 'llu.ios',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      ...extraHeaders,
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    };
    const req = https.request({ hostname, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const parse = (buf) => {
          try { return { status: res.statusCode, data: JSON.parse(buf.toString()) }; }
          catch(e) { return { status: res.statusCode, raw: buf.toString().substring(0, 500) }; }
        };
        if (encoding === 'gzip') zlib.gunzip(buffer, (err, d) => resolve(err ? { status: res.statusCode, raw: 'gzip error' } : parse(d)));
        else if (encoding === 'deflate') zlib.inflate(buffer, (err, d) => resolve(err ? { status: res.statusCode, raw: 'deflate error' } : parse(d)));
        else resolve(parse(buffer));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function syncUser(supabase, user_id, email, password) {
  try {
    let REGION = '';
    let accountIdHash = '';
    const host = () => REGION ? `api-${REGION}.libreview.io` : 'api.libreview.io';

    let res = await request(host(), '/llu/auth/login', 'POST', {}, { email, password });
    if (res.data?.data?.redirect && res.data?.data?.region) {
      REGION = res.data.data.region;
      res = await request(host(), '/llu/auth/login', 'POST', {}, { email, password });
    }

    const token = res.data?.data?.authTicket?.token;
    const userId = res.data?.data?.user?.id || '';
    if (!token) return { user_id, success: false, error: 'Login fallito' };
    if (userId) accountIdHash = sha256(userId);

    const connRes = await request(host(), '/llu/connections', 'GET', {
      'Authorization': `Bearer ${token}`,
      'account-id': accountIdHash,
    });

    const connections = Array.isArray(connRes.data?.data) ? connRes.data.data : [];
    if (connections.length === 0) return { user_id, success: true, added: 0 };

    const patient = connections[0];
    const patientId = patient.patientId || patient.id;

    const graphRes = await request(host(), `/llu/connections/${patientId}/graph`, 'GET', {
      'Authorization': `Bearer ${token}`,
      'account-id': accountIdHash,
    });

    const graphData = graphRes.data?.data?.graphData || graphRes.data?.graphData || [];
    if (!Array.isArray(graphData) || graphData.length === 0) return { user_id, success: true, added: 0 };

    const { data: existing } = await supabase
      .from('libre_data')
      .select('date')
      .eq('user_id', user_id)
      .order('date', { ascending: false })
      .limit(1);

    const lastTimestamp = existing?.[0]?.date ? new Date(existing[0].date).getTime() : 0;
    const INTERVAL_MS = 110 * 60 * 1000; // ~2 ore
    let lastTime = lastTimestamp;
    const toInsert = [];

    for (const g of graphData) {
      const ts = g.Timestamp || g.timestamp || g.FactoryTimestamp;
      if (!ts) continue;
      const dt = new Date(ts);
      if (isNaN(dt.getTime())) continue;
      const val = parseInt(g.Value || g.value);
      if (!val || val < 30 || val > 500) continue;
      if (dt.getTime() - lastTime < INTERVAL_MS) continue;
      toInsert.push({ id: dt.getTime(), user_id, value: val, date: dt.toISOString() });
      lastTime = dt.getTime();
    }

    if (toInsert.length > 0) {
      const { error } = await supabase.from('libre_data').insert(toInsert);
      if (error) return { user_id, success: false, error: error.message };
    }

    // Aggiorna last_sync
    await supabase.from('libre_config').update({ last_sync: new Date().toISOString() }).eq('user_id', user_id);

    return { user_id, success: true, added: toInsert.length };
  } catch (err) {
    return { user_id, success: false, error: err.message };
  }
}

// Netlify Scheduled Function — eseguita ogni 4 ore
// netlify.toml: [functions."sync-libre-scheduled"] schedule = "0 */4 * * *"
exports.handler = async function(event, context) {
  console.log('🔄 Avvio sync Libre schedulato:', new Date().toISOString());

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Leggi tutti gli utenti con credenziali LibreLink
  const { data: configs, error } = await supabase
    .from('libre_config')
    .select('user_id, libre_email, libre_password')
    .not('libre_email', 'is', null)
    .not('libre_password', 'is', null);

  if (error) {
    console.error('Errore lettura libre_config:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  console.log(`👥 Utenti da sincronizzare: ${configs?.length || 0}`);

  const results = [];
  for (const config of (configs || [])) {
    const result = await syncUser(supabase, config.user_id, config.libre_email, config.libre_password);
    results.push(result);
    console.log(`✅ ${config.user_id}: +${result.added || 0} letture`);
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ synced: results.length, results })
  };
};
