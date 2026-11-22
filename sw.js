const CACHE = 'belege-v4';
const FILES = ['./', './index.html', './app.js', './pdf.js', './vendor/pdf-lib.min.js',
  './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Netzwerk zuerst (damit Updates ankommen), sonst Cache (offline).
// Android: Dateien, die über das Teilen-Menü an die App geschickt werden
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    e.respondWith((async () => {
      try {
        const form = await e.request.formData();
        const cache = await caches.open('shared-inbox');
        let i = 0;
        for (const f of form.getAll('files')) {
          if (!(f instanceof File)) continue;
          await cache.put(`./shared/${Date.now()}-${i++}`, new Response(f, { headers: { 'Content-Type': f.type, 'X-Name': encodeURIComponent(f.name) } }));
        }
      } catch (err) { /* ignorieren */ }
      return Response.redirect('./?shared=1', 303);
    })());
  }
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
