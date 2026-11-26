const autoToggle = document.getElementById('autoToggle');
const autoSendToggle = document.getElementById('autoSendToggle');
const statusDiv = document.getElementById('status');
const queueInput = document.getElementById('queueInput');
const paymentSelect = document.getElementById('paymentSelect');

// Ubah array queue dari config.js menjadi format teks baris per baris
const DEFAULT_QUEUE_TEXT = (typeof JKT48_DEFAULT_CONFIG !== 'undefined' ? JKT48_DEFAULT_CONFIG.queue : [])
  .map(item => `${item.date} | ${item.session} | ${item.member} | ${item.quantity}`)
  .join('\n');

const DEFAULT_PAYMENT = (typeof JKT48_DEFAULT_CONFIG !== 'undefined' && JKT48_DEFAULT_CONFIG.paymentMethod)
  ? JKT48_DEFAULT_CONFIG.paymentMethod
  : 'JKT48 Point';

// Muat pengaturan tersimpan khusus untuk browser ini (atau pakai default dari config.js)
chrome.storage.local.get({
  autoReceive: true,
  autoSendOnOpen: true,
  jkt48QueueText: DEFAULT_QUEUE_TEXT,
  jkt48Payment: DEFAULT_PAYMENT
}, (res) => {
  autoToggle.checked = res.autoReceive;
  autoSendToggle.checked = res.autoSendOnOpen;
  queueInput.value = res.jkt48QueueText;
  paymentSelect.value = res.jkt48Payment;
});

autoToggle.addEventListener('change', () => {
  chrome.storage.local.set({ autoReceive: autoToggle.checked });
});

autoSendToggle.addEventListener('change', () => {
  chrome.storage.local.set({ autoSendOnOpen: autoSendToggle.checked });
});

// Simpan daftar member khusus browser ini
document.getElementById('saveQueueBtn').addEventListener('click', () => {
  const rawText = queueInput.value.trim();

  // Jika kotak dikosongkan lalu klik Simpan, otomatis muat ulang default dari config.js
  if (!rawText) {
    chrome.storage.local.remove(['jkt48QueueText', 'jkt48Queue', 'jkt48Payment'], () => {
      queueInput.value = DEFAULT_QUEUE_TEXT;
      paymentSelect.value = DEFAULT_PAYMENT;
      statusDiv.style.color = '#188038';
      statusDiv.textContent = 'Reset ke daftar terbaru dari config.js!';
    });
    return;
  }

  const parsedQueue = rawText.split('\n')
  // ... lanjutkan kode parsing seperti sebelumnya
  
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [date, session, member, qty] = line.split('|').map(s => (s || '').trim());
      return {
        date: date || '',
        session: session || '',
        member: member || '',
        quantity: Number(qty) || 1
      };
    })
    .filter(item => item.date && item.session && item.member);

  if (parsedQueue.length === 0) {
    statusDiv.style.color = 'red';
    statusDiv.textContent = 'Format antrean tidak valid!';
    return;
  }

  chrome.storage.local.set({
    jkt48QueueText: rawText,
    jkt48Queue: parsedQueue,
    jkt48Payment: paymentSelect.value
  }, () => {
    statusDiv.style.color = '#188038';
    statusDiv.textContent = `Tersimpan (${parsedQueue.length} member) khusus browser ini!`;
  });
});

function getTargetHost(urlStr) {
  const urlObj = new URL(urlStr);
  const parts = urlObj.hostname.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : urlObj.hostname;
}

async function sendToServer(targetHost, cookies, options = {}) {
  const { disableAutoReceive = true, closePopup = true } = options;

  if (disableAutoReceive) {
    await chrome.storage.local.set({ autoReceive: false });
    autoToggle.checked = false;
  }

  try {
    const res = await fetch('http://127.0.0.1:3456/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetHost, cookies })
    });

    if (res.ok) {
      statusDiv.style.color = '#188038';
      statusDiv.textContent = `Terkirim (${cookies.length} cookie) ke semua!`;
      if (closePopup) setTimeout(() => window.close(), 700);
    } else {
      statusDiv.style.color = 'red';
      statusDiv.textContent = 'Gagal mengirim ke server.';
    }
  } catch (e) {
    statusDiv.style.color = 'red';
    statusDiv.textContent = 'Server lokal belum aktif!';
  }
}

// Helper: salin teks ke clipboard (fallback untuk browser yang memblokir Clipboard API)
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}

const isWaitingRoomCookie = name =>
  name.startsWith('__cfwaitingroom') || name.startsWith('_cfwaitingroom');

// Cari tab JKT48 HANYA di jendela (window) yang sedang aktif sekarang
async function findJkt48Tab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active && active.url && active.url.includes('jkt48.com')) return active;

  // Cari tab JKT48 lain di jendela yang SAMA (currentWindow: true), bukan jendela lain
  try {
    const sameWindowTabs = await chrome.tabs.query({ currentWindow: true });
    const foundInWindow = sameWindowTabs.find(t => t.url && t.url.includes('jkt48.com'));
    if (foundInWindow) return foundInWindow;
  } catch (_) {}

  return active || null;
}

// Kumpulkan cookie JKT48 HANYA dari cookieStoreId milik jendela aktif (tidak mencampur Incognito/Normal)
async function collectJkt48Cookies(tab) {
  if (!tab) return [];

  const storeFilter = tab.cookieStoreId ? { storeId: tab.cookieStoreId } : {};

  const filters = [];
  if (tab.url && /^https?:/i.test(tab.url)) {
    filters.push({ url: tab.url, ...storeFilter });
    filters.push({ url: tab.url, ...storeFilter, partitionKey: {} });
  }
  filters.push({ domain: 'jkt48.com', ...storeFilter });
  filters.push({ domain: 'jkt48.com', ...storeFilter, partitionKey: {} });
  filters.push({ ...storeFilter });
  filters.push({ ...storeFilter, partitionKey: {} });

  const map = new Map();
  for (const f of filters) {
    let list = [];
    try {
      list = await chrome.cookies.getAll(f);
    } catch (_) {
      continue;
    }

    const scoped = ('url' in f) || ('domain' in f);
    for (const c of list) {
      if (!scoped && !(c.domain || '').toLowerCase().includes('jkt48')) continue;

      // Jika ada duplikat (misal normal vs partitioned), ambil yang expirationDate paling baru
      const existing = map.get(c.name);
      if (!existing || (c.expirationDate || 0) > (existing.expirationDate || 0)) {
        map.set(c.name, c);
      }
    }
  }

  return [...map.values()];
}

// Helper: ambil value cookie dari tab JKT48 tanpa perlu buka Inspect
async function getCookieFromActiveTab(name) {
  const tab = await findJkt48Tab();
  if (!tab) throw new Error('Tidak ada tab JKT48 yang terbuka.');

  const cookies = await collectJkt48Cookies(tab);

  // Prioritas: nama persis dulu, lalu nama terpendek
  // (mis. __cfwaitingroom dipilih, bukan __cfwaitingroom_abc123)
  const exact = cookies.find(c => c.name === name);
  if (exact) return exact;

  if (name === '__cfwaitingroom' || name === '_cfwaitingroom') {
    const related = cookies.filter(c => isWaitingRoomCookie(c.name));
    if (related.length > 0) {
      related.sort((a, b) => a.name.length - b.name.length);
      return related[0];
    }
  }

  return null;
}

// Cookie yang memang dipakai untuk sync (sama seperti filter di background.js)
const isRelevantCookie = c =>
  isWaitingRoomCookie(c.name) || c.name === 'cf_clearance' || c.name === 'cbcd';

// Ambil semua cookie penting sekaligus: 1 waiting room + cf_clearance + cbcd
async function getRelevantCookiesToSend() {
  const tab = await findJkt48Tab();
  if (!tab) throw new Error('Tidak ada tab JKT48 yang terbuka.');

  const cookies = await collectJkt48Cookies(tab);
  const result = [];

  const wrExact = cookies.find(c => c.name === '__cfwaitingroom' || c.name === '_cfwaitingroom');
  const waitingRoom = wrExact ||
    cookies.filter(c => isWaitingRoomCookie(c.name)).sort((a, b) => a.name.length - b.name.length)[0];
  if (waitingRoom) result.push(waitingRoom);

  const clearance = cookies.find(c => c.name === 'cf_clearance');
  if (clearance) result.push(clearance);

  const cbcd = cookies.find(c => c.name === 'cbcd');
  if (cbcd) result.push(cbcd);

  return { tab, cookies: result };
}

// Info bantuan kalau cookie tidak ketemu (untuk memastikan penyebabnya)
async function describeCookies(tab) {
  let all = [];
  try {
    all = await chrome.cookies.getAll({});
  } catch (_) {}

  const jktNames = [...new Set(
    all.filter(c => (c.domain || '').toLowerCase().includes('jkt48')).map(c => c.name)
  )];

  let host = '(tab bukan JKT48)';
  try { host = new URL(tab.url).hostname; } catch (_) {}

  return `tab ${host}, total ${all.length} cookie, cookie jkt48: ${jktNames.join(', ') || '(tidak ada)'}`;
}

const cookieNameSelect = document.getElementById('cookieNameSelect');
const autoCookieValue = document.getElementById('autoCookieValue');
const manualValueInput = document.getElementById('manualValueInput');

let lastAutoValue = '';

// Isi kolom otomatis sesuai pilihan dropdown, langsung dari cookie asli di browser
async function refreshAutoCookieValue(showStatus = false) {
  const name = cookieNameSelect.value;
  autoCookieValue.value = '';

  try {
    const cookie = await getCookieFromActiveTab(name);

    if (!cookie) {
      const info = await describeCookies(await findJkt48Tab());
      console.warn('[JKT48 SYNC] Cookie tidak ditemukan:', name, '|', info);
      autoCookieValue.placeholder = `Cookie "${name}" tidak ditemukan di tab ini.`;
      if (showStatus) {
        statusDiv.style.color = 'red';
        statusDiv.textContent = `Cookie "${name}" tidak ditemukan (${info}).`;
      }
      return null;
    }

    autoCookieValue.value = cookie.value;
    autoCookieValue.title = cookie.name;

    // Salin juga ke kotak manual (hanya jika belum diubah user) supaya tombol kirim siap pakai
    if (!manualValueInput.value || manualValueInput.value === lastAutoValue) {
      manualValueInput.value = cookie.value;
    }
    lastAutoValue = cookie.value;

    if (showStatus) {
      statusDiv.style.color = '#188038';
      statusDiv.textContent = `Cookie ${cookie.name} terbaca otomatis (${cookie.value.length} karakter).`;
    }

    return cookie;
  } catch (err) {
    autoCookieValue.placeholder = err.message || 'Gagal membaca cookie dari tab aktif.';
    if (showStatus) {
      statusDiv.style.color = 'red';
      statusDiv.textContent = 'Gagal membaca cookie: ' + err.message;
    }
    return null;
  }
}

// Muat otomatis saat popup dibuka, lalu perbarui setiap dropdown diganti
refreshAutoCookieValue();
cookieNameSelect.addEventListener('change', () => refreshAutoCookieValue());

// 0. Copy value cookie dari kolom otomatis ke clipboard (tanpa Inspect manual)
document.getElementById('copyCookieBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const cookie = await refreshAutoCookieValue(true);
  if (!cookie) return;

  const copied = await copyToClipboard(cookie.value);
  statusDiv.style.color = '#188038';
  statusDiv.textContent = copied
    ? `Cookie ${cookie.name} ter-copy (${cookie.value.length} karakter)!`
    : `Cookie ${cookie.name} terbaca, tapi gagal copy ke clipboard.`;

  btn.textContent = 'Tersalin!';
  btn.classList.add('copied');
  setTimeout(() => {
    btn.textContent = 'Copy Value Cookie dari Tab Ini';
    btn.classList.remove('copied');
  }, 1500);
});

// 0b. Auto-kirim cookie ke semua browser begitu popup dibuka
async function autoSendOnOpen() {
  const { autoSendOnOpen: enabled = true } = await chrome.storage.local.get({ autoSendOnOpen: true });
  autoSendToggle.checked = enabled;
  if (!enabled) return;

  const tab = await findJkt48Tab();
  if (!tab || !tab.url || !tab.url.includes('jkt48.com')) return;

  // Kolom otomatis tetap mengikuti dropdown
  await refreshAutoCookieValue();

  let cookies = [];
  try {
    cookies = (await getRelevantCookiesToSend()).cookies;
  } catch (_) {
    cookies = [];
  }

  if (cookies.length === 0) {
    statusDiv.style.color = '#b45309';
    statusDiv.textContent = 'Tidak ada cookie waiting room / cf_clearance di browser ini — auto-kirim dilewati.';
    return;
  }

  // Penanda agar background tidak memproses echo dari broadcast browser ini sendiri
  await chrome.storage.local.set({
    lastSentCookieName: cookies.map(c => c.name).join(','),
    lastSentCookieValue: cookies.map(c => c.value).join('|')
  });

  const names = cookies.map(c => c.name).join(' + ');
  statusDiv.style.color = '#188038';
  statusDiv.textContent = `Mengirim ${names} otomatis...`;

  await sendToServer(getTargetHost(tab.url), cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '',
    hostOnly: Boolean(c.hostOnly),
    path: c.path || '/',
    secure: Boolean(c.secure),
    httpOnly: Boolean(c.httpOnly),
    sameSite: (!c.sameSite || c.sameSite === 'unspecified') ? 'lax' : c.sameSite,
    expirationDate: c.expirationDate
  })), { disableAutoReceive: false, closePopup: false });
}

autoSendOnOpen();

// 1. Kirim otomatis semua cookie dari tab aktif
document.getElementById('broadcastBtn').addEventListener('click', async () => {
  const tab = await findJkt48Tab();
  if (!tab || !tab.url) return;

  const targetHost = getTargetHost(tab.url);
  const cookies = await chrome.cookies.getAll({
    url: tab.url,
    storeId: tab.cookieStoreId
  });
  await sendToServer(targetHost, cookies);
});

// Kirim URL tab saat ini (misal: /purchase/exclusive?code=EX120F) ke semua browser
document.getElementById('broadcastUrlBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  await chrome.storage.local.set({ autoReceive: false });
  autoToggle.checked = false;

  try {
    const res = await fetch('http://127.0.0.1:3456/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetHost: getTargetHost(tab.url),
        redirectUrl: tab.url,
        cookies: []
      })
    });

    if (res.ok) {
      statusDiv.style.color = '#188038';
      statusDiv.textContent = 'URL dikirim ke semua browser!';
      setTimeout(() => window.close(), 600);
    }
  } catch (e) {
    statusDiv.style.color = 'red';
    statusDiv.textContent = 'Server lokal belum aktif!';
  }
});

// 2. Kirim 1 cookie dari input form manual ke semua browser
document.getElementById('manualSendBtn').addEventListener('click', async () => {
  const tab = await findJkt48Tab();
  if (!tab || !tab.url) return;

  const name = document.getElementById('cookieNameSelect').value;
  const value = document.getElementById('manualValueInput').value.trim();

  if (!value) {
    statusDiv.style.color = 'red';
    statusDiv.textContent = 'Value cookie masih kosong!';
    return;
  }

  const targetHost = getTargetHost(tab.url);

  const existingCookies = await chrome.cookies.getAll({
    url: tab.url,
    storeId: tab.cookieStoreId
  });
  const existingWr = existingCookies.find(
    c => c.name.startsWith('__cfwaitingroom') || c.name.startsWith('_cfwaitingroom')
  );

  const cookieName = (name === '__cfwaitingroom' && existingWr) ? existingWr.name : name;

  await chrome.cookies.remove({
    url: tab.url,
    name: cookieName,
    storeId: tab.cookieStoreId
  }).catch(() => {});

  const cookiePayload = {
    url: tab.url,
    name: cookieName,
    value: value,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    storeId: tab.cookieStoreId,
    expirationDate: Math.floor(Date.now() / 1000) + 86400
  };

  if (existingWr && !existingWr.hostOnly && existingWr.domain) {
    cookiePayload.domain = existingWr.domain;
  }

  try {
    await chrome.cookies.set(cookiePayload);
  } catch (err) {
    statusDiv.style.color = 'red';
    statusDiv.textContent = 'Error: ' + err.message;
    return;
  }

  await sendToServer(targetHost, [{
    name: cookieName,
    value: value,
    domain: existingWr ? existingWr.domain : '',
    hostOnly: existingWr ? existingWr.hostOnly : true,
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: Math.floor(Date.now() / 1000) + 86400
  }]);

  chrome.tabs.reload(tab.id);
});