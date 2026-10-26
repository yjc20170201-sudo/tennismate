// 테니스메이트 서비스 워커 — 네트워크 우선 (배포가 잦아 캐시는 오프라인 대비용으로만)
const CACHE = 'tm-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // v1.76 C2: 예전에 캐시된 Supabase 응답(회원 목록·기록·클립 사본) 지우기 — 처리방침 3장 '서버에서 받은 회원 정보·클립은 저장하지 않음'
  e.waitUntil((async () => {
    try { const c = await caches.open(CACHE); const ks = await c.keys(); await Promise.all(ks.filter((r) => { try { return /(^|\.)supabase\.co$/i.test(new URL(r.url).hostname); } catch (err) { return false; } }).map((r) => c.delete(r))); } catch (err) {}
    await self.clients.claim();
  })());
});

// v1.70b: 페이지는 쿼리(?u=시각 등)를 뺀 주소로 캐시 — 앱이 주소창의 ?u=를 지우므로, 인터넷 없는 코트에서 다시 열 때 마지막 최신본이 나오게
function navKey(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch (err) { return u; } }

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  try { if (/(^|\.)supabase\.co$/i.test(new URL(e.request.url).hostname)) return; } catch (err) {} // v1.76 C2: Supabase 응답은 캐시하지 않음(브라우저가 그대로 처리)
  const nav = e.request.mode === 'navigate';
  // 페이지(HTML) 자체는 HTTP 캐시까지 건너뛰고 항상 서버 최신본 — 배포가 잦은 베타 대응
  const req = nav ? new Request(e.request.url, { cache: 'no-store' }) : e.request;
  const key = nav ? navKey(e.request.url) : e.request;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // 성공하면 최신본을 캐시에 갱신해두고 그대로 반환
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || (nav ? caches.match(e.request) : r))) // 오프라인일 때만 캐시 사용
  );
});
