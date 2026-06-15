// ═══════════════════════════════════════════════════════════════
//  Urban Loop 360° — Service Worker
//  v1.0 | Offline cache + Map tiles + Background Sync
// ═══════════════════════════════════════════════════════════════

const APP_VERSION   = 'ul360-v1';
const CACHE_STATIC  = `${APP_VERSION}-static`;
const CACHE_TILES   = `${APP_VERSION}-tiles`;
const TILES_MAX     = 500;   // máximo de tiles en cache (~50MB)

// ── Assets estáticos a pre-cachear en install ──
const STATIC_ASSETS = [
  '/',
  '/index.html',
  'https://fonts.googleapis.com/css2?family=Bai+Jamjuree:wght@400;600;700;800&display=swap',
];

// ── Patrones de URLs ──
const isTile      = url => url.includes('maptiler.com') || url.includes('/tiles/');
const isFirebase  = url => url.includes('firestore.googleapis.com') ||
                           url.includes('firebase') ||
                           url.includes('identitytoolkit');
const isFont      = url => url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com');
const isStatic    = url => url.includes('/index.html') || url === self.location.origin + '/';


// ═══════════════════════════
//  INSTALL — pre-cache static
// ═══════════════════════════
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC)
      .then(cache => cache.addAll(STATIC_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});


// ═══════════════════════════
//  ACTIVATE — limpiar caches viejos
// ═══════════════════════════
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k.startsWith('ul360-') && k !== CACHE_STATIC && k !== CACHE_TILES)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});


// ═══════════════════════════
//  FETCH — estrategia por tipo
// ═══════════════════════════
self.addEventListener('fetch', event => {
  const { url } = event.request;

  // Firebase/Firestore → siempre network (SDK maneja su propia cache offline)
  if (isFirebase(url)) return;

  // Tiles del mapa → Cache First con límite de tamaño
  if (isTile(url)) {
    event.respondWith(tileStrategy(event.request));
    return;
  }

  // Fuentes Google → Cache First
  if (isFont(url)) {
    event.respondWith(cacheFirst(event.request, CACHE_STATIC));
    return;
  }

  // index.html → Network First (siempre la versión más nueva)
  if (isStatic(url) || event.request.mode === 'navigate') {
    event.respondWith(networkFirstWithOfflineFallback(event.request));
    return;
  }

  // Todo lo demás → Network First con fallback a cache
  event.respondWith(networkFirst(event.request));
});

// Cache First
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName || CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cached || new Response('Sin conexión', { status: 503 });
  }
}

// Network First
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Sin conexión', { status: 503 });
  }
}

// Network First con fallback offline (para navegación / index.html)
async function networkFirstWithOfflineFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_STATIC);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request) ||
                   await caches.match('/index.html') ||
                   await caches.match('/');
    return cached || new Response(offlinePage(), {
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

// Tiles: Cache First + límite de 500 tiles
async function tileStrategy(request) {
  const cache  = await caches.open(CACHE_TILES);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      await trimTileCache(cache);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return cached || new Response('', { status: 503 });
  }
}

// Limitar tiles a TILES_MAX entradas
async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length >= TILES_MAX) {
    // Borrar los más viejos (primeros en la lista)
    const toDelete = keys.slice(0, keys.length - TILES_MAX + 50);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}


// ═══════════════════════════
//  BACKGROUND SYNC — loops offline
// ═══════════════════════════
self.addEventListener('sync', event => {
  if (event.tag === 'sync-loops') {
    event.waitUntil(notifyClientsToSync('loops'));
  }
  if (event.tag === 'sync-fotoloops') {
    event.waitUntil(notifyClientsToSync('fotoloops'));
  }
});

// El SW no puede acceder a Firebase directamente —
// notifica a la app abierta para que ella haga el upload
async function notifyClientsToSync(type) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  clients.forEach(client => client.postMessage({ type: 'BG_SYNC', payload: type }));
}


// ═══════════════════════════
//  PUSH NOTIFICATIONS (futuro)
// ═══════════════════════════
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || 'Urban Loop 360°', {
      body:    data.body    || '',
      icon:    data.icon    || '/assets/icon-192x192.png',
      badge:   '/assets/icon-192x192.png',
      vibrate: [200, 100, 200],
      data:    { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    self.clients.openWindow(event.notification.data?.url || '/')
  );
});


// ═══════════════════════════
//  OFFLINE FALLBACK PAGE
// ═══════════════════════════
function offlinePage() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Urban Loop 360° — Sin conexión</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #0a0f1a; color: #f0ede6;
           display: flex; flex-direction: column; align-items: center; justify-content: center;
           min-height: 100vh; padding: 24px; text-align: center; }
    .icon { width: 72px; height: 72px; background: #FF5F00; border-radius: 18px;
            display: flex; align-items: center; justify-content: center; font-size: 36px; margin-bottom: 20px; }
    h1 { font-size: 22px; font-weight: 700; margin-bottom: 8px; }
    p  { font-size: 14px; color: #6e7a8a; line-height: 1.6; max-width: 300px; margin-bottom: 24px; }
    button { background: #FF5F00; color: #fff; border: none; border-radius: 10px;
             padding: 14px 28px; font-size: 14px; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <div class="icon">📡</div>
  <h1>Sin conexión</h1>
  <p>No hay internet disponible. Tus loops grabados se van a sincronizar automáticamente cuando vuelva la señal.</p>
  <button onclick="location.reload()">Reintentar</button>
</body>
</html>`;
}
