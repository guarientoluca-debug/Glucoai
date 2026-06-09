const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const EMAIL = process.env.LIBRE_EMAIL;
const PASSWORD = process.env.LIBRE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ LIBRE_EMAIL e LIBRE_PASSWORD sono richiesti');
  process.exit(1);
}

let REGION = '';

function request(hostname, path, method, extraHeaders, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'version': '4.7.0',
      'product': 'llu.ios',
      'Accept': 'application/json',
      ...extraHeaders,
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    };
    // No Accept-Encoding = no compression
    
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data }); }
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
  if (token) { console.log('✅ Login OK'); return token; }
  
  console.log('Risposta completa:', JSON.stringify(res.data || res.raw || '').substring(0, 300));
  throw new Error('Token non trovato nella risposta');
}

async function getConnections(token) {
  const res = await request(host(), '/llu/connections', 'GET', { 'Authorization': `Bearer ${token}` });
  return res.data?.data || [];
}

async function getGraph(token, patientId) {
  const res = await request(host(), `/llu/connections/${patientId}/graph`, 'GET', { 'Authorization': `Bearer ${token}` });
  return res.data?.data?.graphData || [];
}

async function main() {
  try {
    const token = await login();
    const connections = await getConnections(token);
    console.log(`👥 Connessioni: ${connections.length}`);

    let graphData = [];
    if (connections.length > 0) {
      console.log(`👤 Paziente: ${connections[0].firstName || connections[0].patientId}`);
      graphData = await getGraph(token, connections[0].patientId);
    }
    console.log(`📊 Letture ricevute: ${graphData.length}`);

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
