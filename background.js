let lastSyncedId = 0;
let isConnecting = false;
let lastAutoBroadcastTime = 0;

// Pastikan koneksi tetap terjaga jika terputus
chrome.alarms.create('reconnectCheck', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  if (!isConnecting) connectStream();
});

async function connectStream() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const response = await fetch('http://127.0.0.1:3456/stream', {
      cache: 'no-store'
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.replace('data: ', '').trim();
          const data = JSON.parse(jsonStr);
          if (data.id) {
            await handleIncomingCookies(data);
          }
        }
      }
    }
  } catch (err) {
    // Jika server mati atau koneksi putus, coba sambung ulang dalam 2 detik
  } finally {
    isConnecting = false;
    setTimeout(connectStream, 2000);
  }
}

async function handleIncomingCookies(data) {
  if (!data.id || data.id === lastSyncedId) return;
  lastSyncedId = data.id;

  const { autoReceive = true } = await chrome.storage.local.get('autoReceive');
  if (!autoReceive) return;

  // Abaikan echo dari broadcast yang dikirim oleh browser ini sendiri
  const { lastSentCookieName, lastSentCookieValue } =
    await chrome.storage.local.get(['lastSentCookieName', 'lastSentCookieValue']);
  if (lastSentCookieName && lastSentCookieValue && Array.isArray(data.cookies) && data.cookies.length > 0) {
    const names = data.cookies.map(c => c.name).join(',');
    const values = data.cookies.map(c => c.value).join('|');
    if (names === lastSentCookieName && values === lastSentCookieValue) return;
  }

  const tabs = await chrome.tabs.query({});
  const matchingTabs = tabs.filter(t => {
    if (!t.url) return false;
    try {
      return new URL(t.url).hostname.includes(data.targetHost);
    } catch {
      return false;
    }
  });

  if (matchingTabs.length > 0) {
    // Kumpulkan semua storeId unik (misal: "0" untuk normal, "1" untuk Incognito/InPrivate)
    const storeMap = new Map();
    for (const tab of matchingTabs) {
      if (!storeMap.has(tab.cookieStoreId)) {
        storeMap.set(tab.cookieStoreId, tab.url);
      }
    }

    for (const [storeId, targetUrl] of storeMap.entries()) {
      for (const c of data.cookies) {
        const isWaitingRoom = c.name.startsWith('__cfwaitingroom') || c.name.startsWith('_cfwaitingroom');
        const isAllowed = isWaitingRoom || c.name === 'cf_clearance' || c.name === 'cbcd';

        if (!isAllowed) continue;

        let sameSite = c.sameSite;
        if (!sameSite || sameSite === 'unspecified') {
          sameSite = 'lax';
        }

        // Hapus cookie lama di storeId tersebut agar tidak bentrok
        await chrome.cookies.remove({
          url: targetUrl,
          name: c.name,
          storeId: storeId
        }).catch(() => {});

        const cookieData = {
          url: targetUrl,
          name: c.name,
          value: c.value,
          path: c.path || '/',
          secure: sameSite === 'no_restriction' ? true : Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          sameSite: sameSite,
          storeId: storeId
        };

        if (!c.hostOnly && c.domain) {
          cookieData.domain = c.domain;
        }
        if (c.expirationDate) {
          cookieData.expirationDate = c.expirationDate;
        }

        try {
          await chrome.cookies.set(cookieData);
        } catch (err) {
          console.error('Gagal set cookie:', c.name, 'storeId:', storeId, err);
        }
      }
    }

    // Tandai waktu penerimaan agar browser penerima tidak mengirim balik (anti-looping)
    await chrome.storage.local.set({ justReceivedSync: Date.now() });

    // Reload atau arahkan semua tab yang cocok (baik normal maupun Incognito/InPrivate)
    for (const tab of matchingTabs) {
      if (data.redirectUrl) {
        chrome.tabs.update(tab.id, { url: data.redirectUrl });
      } else {
        chrome.tabs.reload(tab.id);
      }
    }
  }
}

// Deteksi otomatis saat tab JKT48 berhasil tembus Waiting Room (tanpa perlu buka popup)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete' || !tab.url) return;

  const isJkt48Target =
    tab.url.includes('jkt48.com/what-are-exclusive') ||
    tab.url.includes('jkt48.com/purchase/exclusive');

  if (!isJkt48Target) return;

  const { justReceivedSync = 0 } = await chrome.storage.local.get({ justReceivedSync: 0 });

  // Jika baru saja menerima sync dari server dalam 10 detik terakhir, jangan kirim balik
  if (Date.now() - justReceivedSync < 10000) return;

  // Cooldown 5 detik agar tidak spam server saat halaman reload
  if (Date.now() - lastAutoBroadcastTime < 5000) return;

  // Pastikan halaman bukan layar Waiting Room Cloudflare
  if (tab.title && tab.title.toLowerCase().includes('waiting room')) return;

  lastAutoBroadcastTime = Date.now();

  const storeFilter = tab.cookieStoreId ? { storeId: tab.cookieStoreId } : {};
  const [normalCookies, partitionedCookies] = await Promise.all([
    chrome.cookies.getAll({ domain: 'jkt48.com', ...storeFilter }),
    chrome.cookies.getAll({ domain: 'jkt48.com', ...storeFilter, partitionKey: {} }).catch(() => [])
  ]);

  const allCookies = [...(normalCookies || []), ...(partitionedCookies || [])];
  const relevantCookies = allCookies.filter(c =>
    c.name.startsWith('__cfwaitingroom') ||
    c.name.startsWith('_cfwaitingroom') ||
    c.name === 'cf_clearance' ||
    c.name === 'cbcd'
  );

  if (relevantCookies.length === 0) return;

  // Matikan autoReceive di browser pemenang ini agar tidak tertimpa broadcast lain
  await chrome.storage.local.set({
    autoReceive: false,
    lastSentCookieName: relevantCookies.map(c => c.name).join(','),
    lastSentCookieValue: relevantCookies.map(c => c.value).join('|')
  });

  try {
    await fetch('http://127.0.0.1:3456/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetHost: 'jkt48.com',
        redirectUrl: tab.url,
        cookies: relevantCookies
      })
    });
    console.log('[AUTO-SYNC] Tembus Waiting Room! Otomatis kirim cookie & URL ke semua browser.');
  } catch (e) {
    // Abaikan jika server.js sedang tidak aktif
  }
});

// Teruskan log tahapan dari content.js ke server lokal CMD
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'CMD_LOG') {
    const browserTag = sender.tab
      ? `${sender.tab.incognito ? 'Incognito' : 'Normal'}-Tab#${sender.tab.id}`
      : 'Browser';

    fetch('http://127.0.0.1:3456/log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        step: msg.step,
        browser: browserTag,
        detail: msg.detail
      })
    }).catch(() => {});
  }
});
// Mulai koneksi instan saat ekstensi dijalankan
connectStream();