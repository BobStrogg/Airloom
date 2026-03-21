// Airloom viewer service worker.
// Network-first: always fetch fresh content when online so updates appear immediately.
// Cache is populated on successful fetches and used only as an offline fallback,
// allowing the PWA to open from the home screen even if the host is temporarily unreachable.
const CACHE = 'airloom-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([
    self.clients.claim(),
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ),
  ]));
});

const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0a"><title>Airloom – Offline</title>
<style>body{margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;text-align:center}
.c{padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#888;margin:.25rem 0}
button{margin-top:1.5rem;padding:.6rem 1.5rem;border:1px solid #333;border-radius:8px;background:#111;color:#e0e0e0;font-size:.9rem;cursor:pointer}
</style></head><body><div class="c"><h1>Airloom</h1>
<p>Cannot reach the host. Make sure it is running and you are on the same network.</p>
<button onclick="location.reload()">Retry</button></div></body></html>`;

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Network-first: fetch from network, update cache, fall back to cache when offline.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreVary: true });
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html' } });
        }
        return new Response('', { status: 503 });
      })
  );
});
