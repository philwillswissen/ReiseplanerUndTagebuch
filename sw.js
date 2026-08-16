/**
 * Service Worker – Skandinavien Reiseplaner
 * Strategie:
 *  - App-Shell (HTML/CSS/JS/CDN-Libs/Icons): Cache-first, damit die App
 *    auch offline sofort startet. Wird im Hintergrund aktualisiert.
 *  - Firestore/Storage-Daten (Live-Reisedaten, Fotos): Network-first,
 *    damit Admins immer den aktuellen Stand sehen; nur bei Offline
 *    wird auf den letzten bekannten Cache-Stand zurückgefallen.
 *
 * Versionierung: CACHE_VERSION bei jedem Deploy hochzählen, damit alte
 * Caches sauber entfernt werden (siehe 'activate').
 */

const CACHE_VERSION = 'v5';   // v5: KI-basierte Aufenthaltsdauer-Gewichtung, Vergangenheitsschutz, Validitätsprüfung
const SHELL_CACHE = `reiseplaner-shell-${CACHE_VERSION}`;
const DATA_CACHE = `reiseplaner-data-${CACHE_VERSION}`;
const IMAGE_CACHE = `reiseplaner-images-${CACHE_VERSION}`;

// Die App-Shell: alles, was für den reinen App-Start nötig ist.
// index.html wird per Network-first-mit-Cache-Fallback behandelt (siehe unten),
// damit neue Deploys schnell ankommen, ohne offline unbrauchbar zu werden.
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  // JS-Module (Task 3) - ohne diese startet die App offline nicht
  '/js/main.js',
  '/js/state.js',
  '/js/utils.js',
  '/js/geo.js',
  '/js/firebase.js',
  '/js/settings.js',
  '/js/duration.js',
  '/js/segments.js',
  '/js/weather.js',
  '/js/pois.js',
  '/js/map.js',
  '/js/stations.js',
  '/js/media.js',
  '/js/diary.js',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-144.png',
  '/icons/icon-152.png',
  '/icons/icon-192.png',
  '/icons/icon-384.png',
  '/icons/icon-512.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/exifr/dist/full.umd.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@latest/Sortable.min.js',
];

// Hosts, deren Anfragen als "Live-Daten" gelten -> Network-first
const NETWORK_FIRST_HOSTS = [
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebase.googleapis.com',
  'www.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'api.open-meteo.com',           // Punkt 7: Wetter soll immer frisch sein, nicht gecacht
  'nominatim.openstreetmap.org',  // Ortssuche beim Hinzufügen neuer Stationen
  'generativelanguage.googleapis.com', // Gemini KI-Anfragen (Enrichment, Blog, POI-Vorschläge)
];

// Hosts für hochgeladene Foto-Binärdaten -> eigener Cache, "stale-while-revalidate"
const IMAGE_HOSTS = [
  'firebasestorage.googleapis.com',
  'firebasestorage.app',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      // addAll bricht komplett ab, wenn eine URL fehlschlägt (z.B. CDN kurz down).
      // Deshalb einzeln laden und Fehler pro Asset tolerieren.
      return Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Shell-Asset konnte nicht gecacht werden:', url, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => ![SHELL_CACHE, DATA_CACHE, IMAGE_CACHE].includes(key))
          .map((key) => {
            console.log('[SW] Entferne alten Cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

function isNetworkFirstRequest(url) {
  return NETWORK_FIRST_HOSTS.some((host) => url.hostname.includes(host));
}

function isImageRequest(url, request) {
  if (request.destination === 'image') return true;
  return IMAGE_HOSTS.some((host) => url.hostname.includes(host));
}

// Cache-first: erst Cache, bei Miss -> Netzwerk (und dabei Cache füllen)
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    // Im Hintergrund aktualisieren (stale-while-revalidate light), ohne den
    // Response abzuwarten -> App bleibt schnell.
    fetchAndCache(request, cacheName).catch(() => {});
    return cached;
  }
  return fetchAndCache(request, cacheName);
}

async function fetchAndCache(request, cacheName) {
  const response = await fetch(request);
  if (response && response.ok) {
    const cache = await caches.open(cacheName);
    cache.put(request, response.clone());
  }
  return response;
}

// Network-first: erst Netzwerk (aktuelle Live-Daten), bei Fehler/Offline -> Cache
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw err;
  }
}

// Für die Navigation (index.html): Network-first mit Cache-Fallback,
// damit neue Deploys sofort greifen, App aber offline trotzdem startet.
async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/index.html', response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match('/index.html');
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // Schreibende Requests (Firestore writes laufen eh über WS/HTTP2 Streams) nicht anfassen

  const url = new URL(request.url);

  // HTML-Navigation (App-Aufruf / Reload)
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Live-Daten (Firestore/Auth) -> immer möglichst aktuell
  if (isNetworkFirstRequest(url)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Foto-Uploads/Downloads -> eigener Cache, Cache-first (Fotos ändern sich nicht rückwirkend)
  if (isImageRequest(url, request)) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  // Alles andere (CSS/JS/Fonts/CDN-Libs) -> App-Shell, Cache-first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

// Erlaubt der App, den SW sofort zu aktivieren (z.B. nach "Update verfügbar"-Hinweis)
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
