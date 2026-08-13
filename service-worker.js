const CACHE_NAME = 'card-cashback-v3';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json',
  './data/cards.json',
  './data/stores.json',
  './icons/icon.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 還元率データの鮮度が本質的に重要なため、オンライン時は常にネットワークを優先し、
// オフライン時のみキャッシュにフォールバックする(cache-firstにすると更新後も
// 古い還元率が表示され続けてしまう)。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return; // POST等はService Workerが関与しない

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        // エラーレスポンス(404/500等)をキャッシュすると、その後オフライン時に
        // 壊れた内容が固定化されてしまうため、成功時のみ保存する。
        if (res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return Response.error();
      })
  );
});
