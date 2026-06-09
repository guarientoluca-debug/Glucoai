const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');

const EMAIL = process.env.LIBRE_EMAIL;
const PASSWORD = process.env.LIBRE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ LIBRE_EMAIL e LIBRE_PASSWORD sono richiesti');
  process.exit(1);
}

let REGION = '';
let accountIdHash = '';

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
          catch(e) { return { status: res.statusCode, raw: buf.toString().substring(0,500) }; }
        };
        if (encoding === 'gzip') zlib.gunzip(buffer, (err, d) => resolve(err ? {status:res.statusCode,raw:'gzip error'} : parse(d)));
        else if (encoding === 'deflate') zlib.inflate(buffer, (err, d) => resolve(err ? {status:res.statusCode,raw:'deflate error'} : parse(d)));
        else resolve(parse(buffer));
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function host() {
  return REGION ? `api-${REGION}.libreview.io` : 'api.libreview.io';
}

async function login() {
  console.log('🔐 Login su', host());
  let res = await request(host(), '/llu/auth/login', 'POST', {}, { email: EMAIL, password: PASSWORD });
  console.log('Status:', res.status);

  if (res.data?.data?.redirect && res.data?.data?.region) {
    REGION = res.data.data.region;
    console.log('🌍 Redirect a regione:', REGION);
    res = await request(host(), '/llu/auth/login', 'POST', {}, { email: EMAIL, password: PASSWORD });
    console.log('Status dopo redirect:', res.status);
  }

  const token = res.data?.data?.authTicket?.token;
  const userId = res.data?.data?.user?.id || '';

  if (userId) {
    accountIdHash = sha256(userId);
    console.log('🔑 account-id hash calcolato');
  }

  if (token) { console.log('✅ Login OK'); return token; }

  console.log('Risposta login:', JSON.stringify(res.data || res.raw || '').substring(0, 500));
  throw new Error('Token non trovato nella risposta');
}

async function getConnections(token) {
  const res = await request(host(), '/llu/connections', 'GET', {
    'Authorization': `Bearer ${token}`,
    'account-id': accountIdHash,
  });
  console.log('Connections status:', res.status);
  if (res.status !== 200) {
    console.log('Connections error:', JSON.stringify(res.data || res.raw || '').substring(0, 300));
  }
  const data = res.data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

async function getGraph(token, patientId) {
  const res = await request(host(), `/llu/connections/${patientId}/graph`, 'GET', {
    'Authorization': `Bearer ${token}`,
    'account-id': accountIdHash,
  });
  console.log('Graph status:', res.status);
  const data = res.data;
  const graphData = data?.data?.graphData || data?.graphData || [];
  console.log('📊 Letture ricevute:', Array.isArray(graphData) ? graphData.length : 'non array');
  return Array.isArray(graphData) ? graphData : [];
}

async function main() {
  try {
    const token = await login();
    const connections = await getConnections(token);
    console.log(`👥 Connessioni: ${connections.length}`);

    let graphData = [];
    if (connections.length > 0) {
      const patient = connections[0];
      const patientId = patient.patientId || patient.id;
      console.log(`👤 Paziente: ${patient.firstName || patientId}`);
      graphData = await getGraph(token, patientId);
    } else {
      console.log('⚠️ Nessuna connessione trovata');
    }

    let existing = [];
    if (fs.existsSync('libre-data.json')) {
      try { existing = JSON.parse(fs.readFileSync('libre-data.json', 'utf8')); } catch(e) {}
    }

    const INTERVAL_MS = 150 * 60 * 1000;
    let lastTime = existing.length > 0 ? new Date(existing[existing.length-1].date).getTime() : 0;
    const newReadings = [];

    for (const g of graphData) {
      const ts = g.Timestamp || g.timestamp || g.FactoryTimestamp;
      if (!ts) continue;
      const dt = new Date(ts);
      if (isNaN(dt.getTime())) continue;
      const val = parseInt(g.Value || g.value);
      if (!val || val < 30 || val > 500) continue;
      if (dt.getTime() - lastTime < INTERVAL_MS) continue;
      newReadings.push({ id: dt.getTime(), value: val, date: dt.toISOString() });
      lastTime = dt.getTime();
    }

    const merged = [...existing, ...newReadings]
      .sort((a,b) => new Date(a.date) - new Date(b.date))
      .filter((r,i,arr) => i===0 || r.id !== arr[i-1].id);

    fs.writeFileSync('libre-data.json', JSON.stringify(merged, null, 2));
    console.log(`✅ Aggiunte ${newReadings.length} nuove letture (tot. ${merged.length})`);

  } catch(err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
