const http = require('http');

const PORT = 3456;
const clients = new Set();
let syncCounter = 0;

function getTime() {
  return new Date().toLocaleTimeString('id-ID', { hour12: false });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. Stream SSE ke semua browser
  if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    res.write(':\n\n');

    clients.add(res);
    console.log(`[${getTime()}] [+] Browser tersambung (Total standby: ${clients.size} browser)`);

    req.on('close', () => {
      clients.delete(res);
      console.log(`[${getTime()}] [-] Browser terputus (Total standby: ${clients.size} browser)`);
    });
    return;
  }

  // 2. Endpoint Notifikasi Progres (Pilih Event, Member, Pembayaran, Success)
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { step = 'INFO', browser = 'Browser', detail = '' } = JSON.parse(body || '{}');
        const label = step.toUpperCase();

        if (label === 'SUCCESS') {
          // Bunyi beep 2x di CMD saat tiket berhasil dibeli
          process.stdout.write('\x07\x07');
          console.log('============================================================');
          console.log(`[${getTime()}] [SUCCESS!] (${browser}) -> ${detail}`);
          console.log('============================================================');
        } else {
          console.log(`[${getTime()}] [${label}] (${browser}) -> ${detail}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  // 3. Endpoint Sinkronisasi Cookie & URL Antar-Browser
  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        syncCounter += 1;

        const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
        const cookieNames = cookies.map(c => c.name).join(', ') || '(tanpa cookie)';
        const payload = JSON.stringify({
          id: syncCounter,
          targetHost: parsed.targetHost || 'jkt48.com',
          redirectUrl: parsed.redirectUrl || '',
          cookies
        });

        process.stdout.write('\x07');
        console.log('------------------------------------------------------------');
        console.log(`[${getTime()}] [TEMBUS / SYNC #${syncCounter}]`);
        console.log(`  -> Cookie : ${cookies.length} (${cookieNames})`);
        if (parsed.redirectUrl) {
          console.log(`  -> URL    : ${parsed.redirectUrl}`);
        }
        console.log(`  -> Target : Disebar ke ${clients.size} browser aktif!`);
        console.log('------------------------------------------------------------');

        for (const client of clients) {
          client.write(`data: ${payload}\n\n`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sentTo: clients.size }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('============================================================');
  console.log(`Server Instant Cookie Sync berjalan di port ${PORT}`);
  console.log('@tidak_berubah');
  console.log('Menunggu browser tersambung...');
  console.log('============================================================');
});