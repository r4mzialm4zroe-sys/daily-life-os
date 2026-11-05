// Offline worker. Bump CACHE on every release so phones pick up the update.
const PREFIX = 'dlos-';
const CACHE = PREFIX + '3.1.1';
// Quran fonts/layout never change between releases: own cache, kept across updates.
const QCACHE = PREFIX + 'quran-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icons/apple-touch-icon.png',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './adhan.m4a', './adhkar.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // Only our own old caches: another app on this origin keeps its files.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE && k !== QCACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// iPhone Safari loads audio in byte ranges and rejects a full 200 reply from a service worker.
async function rangeResponse(req) {
  const cached = await caches.match(req.url, { ignoreSearch: true });
  if (!cached) return fetch(req);
  const buf = await cached.arrayBuffer();
  const m = /bytes=([0-9]*)-([0-9]*)/.exec(req.headers.get('range') || '');
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = Math.min(m && m[2] ? Number(m[2]) : buf.byteLength - 1, buf.byteLength - 1);
  return new Response(buf.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers: {
    'Content-Type': cached.headers.get('Content-Type') || 'audio/mp4', 'Accept-Ranges': 'bytes',
    'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`, 'Content-Length': String(end - start + 1) } });
}
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.headers.has('range')) { e.respondWith(rangeResponse(req)); return; }
  if (req.mode === 'navigate') {
    // Online: fresh page (and refresh the cache). Offline: cached page.
    e.respondWith(fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; })
      .catch(() => caches.match('./index.html')));
    return;
  }
  if (new URL(req.url).pathname.includes('/quran/')) {
    e.respondWith(caches.open(QCACHE).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res.ok) c.put(req, res.clone()); return res; }))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});

// Push: the server sends only {id, at}; the text comes from IndexedDB written by the app.
function reminderText(id) {
  return new Promise(resolve => {
    try {
      const r = indexedDB.open('dlos-push', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('reminders', { keyPath: 'id' });
      r.onerror = () => resolve(null);
      r.onsuccess = () => {
        try {
          const g = r.result.transaction('reminders', 'readonly').objectStore('reminders').get(id);
          g.onsuccess = () => resolve(g.result || null);
          g.onerror = () => resolve(null);
        } catch (err) { resolve(null); }
      };
    } catch (err) { resolve(null); }
  });
}
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (err) {}
    const item = d.test ? null : await reminderText(d.id);
    const title = d.test ? d.title : (item && item.title) || 'Daily Life OS';
    const body = d.test ? d.body : (item && item.body) || 'عندك تذكير جديد · You have a reminder';
    await self.registration.showNotification(title, {
      body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
      tag: 'dlos-' + (d.test ? 'test' : d.id), data: { view: (item && item.view) || (d.test ? 'settings' : 'today') },
    });
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const view = (e.notification.data && e.notification.data.view) || 'today';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { c.postMessage({ type: 'open-view', view, fromNotification: true }); return c.focus(); }
    return self.clients.openWindow(new URL('./?from=notification#' + view, self.registration.scope).href);
  }));
});
