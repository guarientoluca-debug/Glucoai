const https = require('https');
const zlib = require('zlib');
const fs = require('fs');

const EMAIL = process.env.LIBRE_EMAIL;
const PASSWORD = process.env.LIBRE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('❌ LIBRE_EMAIL e LIBRE_PASSWORD sono richiesti');
  process.exit(1);
}

function request(hostname, path, method, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const allHeaders = {
      'User-Agent': 'Mozilla/5.0',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      ...headers,
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
    };

    const req = https.request({ hostname, path, method, headers: allHeaders }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];

        const parse = (buf) => {
          try { return { status: res.statusCode, data: JSON.parse(buf.toString()) }; }
          catch(e) { return { status: res.statusCode, raw: buf.toString().substring(0, 500) }; }
        };

        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => resolve(err ? { status: res.statusCode, raw: 'gzip error' } : parse(decoded)));
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => resolve(err ? { status: res.statusCode, raw: 'deflate error' } : parse(decoded)));
        } else {
          resolve(parse(buffer));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    // Step 1: Login su LibreView
    console.log('🔐 Login su LibreView...');
    const loginRes = await request('api.libreview.io', '/llu/auth/login', 'POST', {
      'product': 'llu.ios',
      'version': '4.16.0',
    }, { email: EMAIL, password: PASSWORD });

    console.log('Login status:', loginRes.status);

    // Gestisci redirect regionale
    let token, userId;
    if (loginRes.data?.data?.redirect) {
      const region = loginRes.data.data.region;
      console.log('🌍 Redirect regione:', region);
      const loginRes2 = await request(`api-${region}.libreview.io`, '/llu/auth/login', 'POST', {
        'product': 'llu.ios',
        'version': '4.16.0',
      }, { email: EMAIL, password: PASSWORD });
      console.log('Login EU status:', loginRes2.status);
      token = loginRes2.data?.data?.authTicket?.token;
      userId = loginRes2.data?.data?.user?.id;
    } else {
      token = loginRes.data?.data?.authTicket?.token;
      userId = loginRes.data?.data?.user?.id;
    }

    if (!token) throw new Error('Token non trovato');
    console.log('✅ Login OK, userId:', userId?.substring(0, 8) + '...');

    // Step 2: Letture glucosio via API LibreView diretta
    console.log('📊 Recupero letture glucosio...');
    const region = loginRes.data?.data?.region || 'eu';
    const hostname = `api-${region}.libreview.io`;

    const readingsRes = await request(hostname, '/llu/connections', 'GET', {
      'Authorization': `Bearer ${token}`,
      'product': 'llu.ios',
      'version': '4.16.0',
    });

    console.log('Readings status:', readingsRes.status);
    console.log('Readings raw:', JSON.stringify(readingsRes.data || readingsRes.raw || '').substring(0, 400));

    // Step 3: Prova endpoint alternativo per dati diretti paziente
    const cgmRes = await request(hostname, '/glucosemeasurements', 'GET', {
      'Authorization': `Bearer ${token}`,
      'product': 'llu.ios',
      'version': '4.16.0',
    });
    console.log('CGM status:', cgmRes.status);
    console.log('CGM raw:', JSON.stringify(cgmRes.data || cgmRes.raw || '').substring(0, 400));

    // Scrivi risultato per ora
    fs.writeFileSync('libre-data.json', JSON.stringify([], null, 2));
    console.log('✅ Debug completato — analizza i log per trovare endpoint corretto');

  } catch(err) {
    console.error('❌ Errore:', err.message);
    process.exit(1);
  }
}

main();
