// Offline app shell: static files are served from cache and refreshed in the background; the API is never cached.
const CACHE = 'mymusic-shell-v6';
const SHELL = ['/', '/manifest.json', '/taste.js', '/fonts/roboto-400.woff2', '/fonts/roboto-500.woff2', '/fonts/roboto-700.woff2', '/assets/ui-icons.json', '/assets/icon.png', '/assets/icon.svg', '/assets/empty.png', '/assets/default-art.jpg'];
self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request);
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    return hit ?? net;
  }));
});
