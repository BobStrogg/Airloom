// Airloom viewer service worker — cache-first so the page works
// even when the host LAN server is no longer reachable.
const CACHE = 'airloom-v3';

self.addEventListener('install', (event) => {
  // Activate immediately, don't wait for old SW to retire
  self.skipWaiting();
  // Pre-cache the root page (best-effort — don't let a failure block installation)
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.add('./').catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  // Claim all open tabs so the SW starts intercepting fetches right away
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Evict old caches from previous versions
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      ),
    ])
  );
});

// Minimal offline HTML returned when no cached assets are available at all.
const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0a">
<title>Airloom – Offline</title>
<style>body{margin:0;background:#0a0a0a;color:#e0e0e0;font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100dvh;text-align:center}
.c{padding:2rem}h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#888;margin:.25rem 0}
button{margin-top:1.5rem;padding:.6rem 1.5rem;border:1px solid #333;border-radius:8px;background:#111;color:#e0e0e0;font-size:.9rem;cursor:pointer}</style>
</head><body><div class="c"><h1>Airloom</h1><p>You're offline and cached assets aren't available yet.</p>
<p>Reconnect to the host network and open the viewer link again.</p>
<button onclick="location.reload()">Retry</button></div></body></html>`;

/** Try every possible cache key for the navigation HTML shell. */
async function matchShell(cache) {
  // Try the SW scope URL (e.g. http://host:port/viewer/)
  const scopeHit = await cache.match(self.registration.scope, { ignoreVary: true });
  if (scopeHit) return scopeHit;
  // Try relative './' (the key used by cache.add('./') in install)
  const relHit = await cache.match('./', { ignoreVary: true });
  if (relHit) return relHit;
  // Brute-force: find any cached HTML response for our scope
  const keys = await cache.keys();
  for (const req of keys) {
    if (req.url.startsWith(self.registration.scope)) {
      const resp = await cache.match(req, { ignoreVary: true });
      if (resp && resp.headers.get('content-type')?.includes('text/html')) return resp;
    }
  }
  return null;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only cache same-origin viewer assets (HTML, JS, CSS).
  // Don't cache API calls, WebSocket upgrades, or cross-origin requests (Ably SDK).
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Navigation requests (page refresh / direct visit): serve the cached SPA
  // shell so Safari doesn't show its own "server unavailable" page.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        // Try exact URL match first (ignoreVary helps with Express's Vary header)
        const exact = await cache.match(event.request, { ignoreVary: true });
        if (exact) return exact;
        // Fall back to any cached HTML shell for this scope
        const shell = await matchShell(cache);
        if (shell) return shell;
        // Last resort: network, then offline page
        try {
          const response = await fetch(event.request);
          if (response.ok) cache.put(event.request, response.clone());
          return response;
        } catch {
          return new Response(OFFLINE_HTML, {
            status: 503,
            headers: { 'Content-Type': 'text/html' },
          });
        }
      })
    );
    return;
  }

  // Sub-resource requests (JS, CSS, images): cache-first
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreVary: true });
      if (cached) return cached;
      try {
        const response = await fetch(event.request);
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      } catch {
        return new Response('', { status: 503 });
      }
    })
  );
});
