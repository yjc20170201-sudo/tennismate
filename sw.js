// 테니스메이트 서비스 워커 — 네트워크 우선 (배포가 잦아 캐시는 오프라인 대비용으로만)
const CACHE = 'tm-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 성공하면 최신본을 캐시에 갱신해두고 그대로 반환
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)) // 오프라인일 때만 캐시 사용
  );
});
