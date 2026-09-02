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
  // 페이지(HTML) 자체는 HTTP 캐시까지 건너뛰고 항상 서버 최신본 — 배포가 잦은 베타 대응
  const req = e.request.mode === 'navigate' ? new Request(e.request.url, { cache: 'no-store' }) : e.request;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // 성공하면 최신본을 캐시에 갱신해두고 그대로 반환
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request)) // 오프라인일 때만 캐시 사용
  );
});
