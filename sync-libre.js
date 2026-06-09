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

function request(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname, path, method,
      headers: {
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'version': '4.7.0',
        'product': 'llu.ios',
        'Accept': 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        const decompress = encoding === 'gzip' ? zlib.gunzipSync :
                          encoding === 'deflate' ? zlib.inflateSync : null;
        try {
          const text = decompress ? decompress(buffer).toString() : buffer.toString();
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch(e) {
          resolve({ status: res.statusCode, data: buffer.toString() });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function getHostname() {
  return REGION ? `api-${REGION}.libreview.io` : 'api.libreview.io';
}

async function login() {
  console.log('🔐 Login LibreLinkUp...');
  let res = await request('api.libreview.io', '/llu/auth/login', 'POST', {}, { email: EMAIL, password: PASSWORD });
  
  // Handle redirect
  if (res.data?.data?.redirect && res.data?.data?.region) {
    REGION = res.data.data.region;
    console.log(`🌍 Redirect a regione: ${REGION}`);
    res = await request(getHostname(), '/llu/auth/login', 'POST', {}, { email: EMAIL, password: PASSWORD });
  }

  const token = res.data?.data?.authTicket?.token;
  if (token) {
    console.log('✅ Login OK');
    return token;
  }
  throw new Error('Login fallito: ' + JSON.stringify(res.data).substring(0, 200));
}

async function getConnections(token) {
  const res = await request(getHostname(), '/llu/connections', 'GET', { 'Authorization': `Bearer ${token}` });
  return res.data?.data || [];
}

async function getGraph(token, patientId) {
  const res = await request(getHostname(), `/llu/connections/${patientId}/graph`, 'GET', { 'Authorization': `Bearer ${token}` });
  return res.data?.data?.graphData || [];
}

async function main() {
  try {
    const token = await login();
    const connections = await getConnections(token);
    console.log(`👥 Connessioni trovate: ${connections.length}`);

    let graphData = [];
    if (connections.length > 0) {
      const patient = connections[0];
      console.log(`👤 Paziente: ${patient.firstName || patient.patientId}`);
      graphData = await getGraph(token, patient.patientId);
    } else {
      console.log('ℹ️ Nessuna connessione — prova con dati propri non supportati da questa API');
    }

    console.log(`📊 Letture ricevute: ${graphData.length}`);

    // Leggi esistenti
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
