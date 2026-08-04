// Urban Loop 360° — Service Worker v3
// Para publicar una actualización: cambiá el número de APP_VERSION
const APP_VERSION = '3.0.0';
const CACHE = `ul360-v${APP_VERSION}`;

const PRECACHE = ['/'];

// ── Instalación ──
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE))
  );
  self.skipWaiting();
});

// ── Activación: limpia cachés viejos y avisa a los clientes ──
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => {
      // Avisarle a todas las pestañas abiertas que hay nueva versión
      return self.clients.matchAll({ includeUncontrolled: true }).then(clients => {
        clients.forEach(client => client.postMessage({ type: 'NEW_VERSION', version: APP_VERSION }));
      });
    })
  );
  self.clients.claim();
});

// ── Fetch: network-first para HTML, cache-first para el resto ──
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // No cachear Firebase, APIs externas ni mapas
  if (
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('maptiler') ||
    url.hostname.includes('openstreetmap') ||
    url.hostname.includes('bigdatacloud') ||
    url.hostname.includes('nominatim') ||
    url.hostname.includes('jsdelivr') ||
    url.hostname.includes('anthropic')
  ) return;

  const isHTML = e.request.destination === 'document' || url.pathname === '/' || url.pathname.endsWith('.html');

  if (isHTML) {
    // Network-first para HTML: siempre busca la versión más nueva
    e.respondWith(
      fetch(e.request)
        .then(response => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(e.request).then(cached => cached || caches.match('/')))
    );
  } else {
    // Cache-first para assets (JS, CSS, imágenes, fuentes)
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(response => {
          if (!response || response.status !== 200 || response.type === 'opaque') return response;
          const clone = response.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
          return response;
        });
      }).catch(() => {
        if (e.request.destination === 'document') return caches.match('/');
      })
    );
  }
});
