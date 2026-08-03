// sw.js – Service Worker corrigé
const CACHE_NAME = 'gestpro-v1';

// Fichiers à mettre en cache (uniquement statiques)
const urlsToCache = [
    '/',
    '/index.html',
    '/store.html',
    '/manifest.json',
    'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css',
    'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css',
    'https://cdn.jsdelivr.net/npm/chart.js'
];

// Installation : mise en cache des fichiers statiques
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

// Activation : nettoyage des anciens caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        })
    );
});

// Interception des requêtes : on laisse passer les appels API
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // ✅ Si la requête est vers /api, on la laisse passer directement (pas de cache)
    if (url.pathname.startsWith('/api')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Pour les autres requêtes (HTML, CSS, JS, images) : on utilise le cache
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                if (response) {
                    return response;
                }
                return fetch(event.request);
            })
    );
});