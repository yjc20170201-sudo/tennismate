// 테니스메이트 서비스 워커 — 네트워크 우선 (배포가 잦아 캐시는 오프라인 대비용으로만)
const CACHE = 'tm-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  // v1.76 C2: 예전에 캐시된 Supabase 응답(회원 목록·기록·클립 사본) 지우기 — 처리방침 3장 '서버에서 받은 회원 정보·클립은 저장하지 않음'
  e.waitUntil((async () => {
    try { const c = await caches.open(CACHE); const ks = await c.keys(); await Promise.all(ks.filter((r) => { try { return /(^|\.)supabase\.co$/i.test(new URL(r.url).hostname); } catch (err) { return false; } }).map((r) => c.delete(r))); } catch (err) {}
    try { await tidyOld(); } catch (err) {} // v1.82: 그동안 쌓인 version.json?t=… 항목과 옛 ?v= 사본 지우기
    await self.clients.claim();
  })());
});

// v1.70b: 페이지는 쿼리(?u=시각 등)를 뺀 주소로 캐시 — 앱이 주소창의 ?u=를 지우므로, 인터넷 없는 코트에서 다시 열 때 마지막 최신본이 나오게
function navKey(u) { try { const x = new URL(u); return x.origin + x.pathname; } catch (err) { return u; } }

// v1.82: 캐시에 두지 않는 것 — version.json과 ?t=<시각>이 붙은 같은 출처 요청(확인할 때마다 새 주소라 항목이 끝없이 늘어남)
function noKeep(x) { return x.origin === self.location.origin && (/\/version\.json$/i.test(x.pathname) || x.searchParams.has('t')); }
// v1.82: 같은 출처의 ?v=<앱 버전> 파일(wasb.js·모델)은 넣을 때 같은 경로의 옛 버전 사본을 지움 — 옛 버전 사본이 판마다 쌓이지 않게(지금 판 것은 그대로라 오프라인 동작은 같음)
// v1.82b: 한쪽으로만 — 방금 넣은 것보다 버전이 '낮은' 사본만 지움. 전에는 '다른' 사본을 다 지워, 버전이 다른 앱 창 둘(바쁜 옛 판 탭 + 새 탭, 스토어 앱 + 크롬 탭)이 서로의 사본을 지웠고 동시에 받으면 하나도 안 남았음.
//   버전은 숫자로 견줌(vNum: 'v1.82' → 1·82, 'v1.74e'의 끝 글자는 그다음 자리) — 읽지 못하는 버전이면 아무것도 지우지 않음.
//   앱 창이 둘 이상 열려 있는 동안은 지우지 않고 미룸(열려 있는 옛 판도 인터넷 없이 자기 사본을 씀) — 창이 하나일 때 다음에 넣으면서 정리됨
function vNum(s) { const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?([a-z]?)$/i.exec(s || ''); return m ? [+m[1], +m[2], +(m[3] || 0), m[4] ? m[4].toLowerCase().charCodeAt(0) - 96 : 0] : null; }
function vLess(a, b) { for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; }
function dropOldV(c, x) {
  const v = vNum(x.searchParams.get('v')); if (!v) return null;
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => (ws.length > 1 ? null : c.keys(x.origin + x.pathname, { ignoreSearch: true, ignoreVary: true }).then((ks) => Promise.all(ks.filter((r) => { try { const w = vNum(new URL(r.url).searchParams.get('v')); return !!w && vLess(w, v); } catch (err) { return false; } }).map((r) => c.delete(r))))));
}
// v1.82: 새 워커가 켜질 때 한 번 — 이미 쌓인 version.json·?t= 항목을 지우고, ?v= 파일은 경로마다 가장 높은 버전만 남김
//   v1.82b: 넣은 순서가 아니라 버전 숫자로 견줌(옛 판 탭이 나중에 넣은 낮은 버전이 남고 새 판 것이 지워지지 않게) — 버전을 읽지 못하는 사본은 그대로 둠
async function tidyOld() {
  const c = await caches.open(CACHE); const ks = await c.keys(); const top = {}; const del = [];
  for (const r of ks) {
    let x; try { x = new URL(r.url); } catch (err) { continue; }
    if (x.origin !== self.location.origin) continue;
    if (noKeep(x)) { del.push(r); continue; }
    const v = vNum(x.searchParams.get('v')); if (!v) continue;
    const t = top[x.pathname];
    if (!t || vLess(t.v, v)) { if (t) del.push(t.r); top[x.pathname] = { r, v }; } else if (vLess(v, t.v)) del.push(r);
  }
  await Promise.all(del.map((r) => c.delete(r)));
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  try { if (/(^|\.)supabase\.co$/i.test(new URL(e.request.url).hostname)) return; } catch (err) {} // v1.76 C2: Supabase 응답은 캐시하지 않음(브라우저가 그대로 처리)
  const nav = e.request.mode === 'navigate';
  let x = null; try { x = new URL(e.request.url); } catch (err) {}
  if (!nav && x && noKeep(x)) return; // v1.82: version.json·?t= 요청은 캐시에 두지 않음(브라우저가 그대로 처리 — 오프라인이면 예전처럼 실패)
  // 페이지(HTML) 자체는 HTTP 캐시까지 건너뛰고 항상 서버 최신본 — 배포가 잦은 베타 대응
  // v1.82: redirect 'manual' — 서버가 다른 주소로 돌리면(app.tennismate.kr은 *.html을 308로 확장자 없는 주소에) 따라가지 않고 그 답을 그대로 브라우저에 넘김.
  //   전에는 따라간 응답을 페이지 요청에 넘겨 net::ERR_FAILED였음(페이지 요청은 돌려진 응답을 받지 못함)
  const req = nav ? new Request(e.request.url, { cache: 'no-store', redirect: 'manual' }) : e.request;
  const key = nav ? navKey(e.request.url) : e.request;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.type === 'opaqueredirect') return res; // v1.82: 돌림 답은 캐시에 넣지 않고 그대로 — 브라우저가 새 주소로 다시 요청하고, 그 요청이 여기서 캐시됨
        if (nav && res.status >= 500) return caches.match(key).then((r) => r || caches.match(e.request)).then((r) => (r && r.ok && !r.redirected ? r : res), () => res); // v1.82b: 서버가 500번대를 주면 캐시에 있는 그 페이지(앱 화면)를 대신 — 없으면 서버 답 그대로
        if (!res.ok && res.type !== 'opaque') return res; // v1.82b: 실패한 답(404·503…)은 캐시에 넣지 않음 — 전에는 오류 페이지가 오프라인 사본을 덮어썼음. opaque(CDN <script>, 상태를 볼 수 없음)는 v1.81처럼 넣음
        // 성공하면 최신본을 캐시에 갱신해두고 그대로 반환
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(key, copy).then(() => (!nav && x && x.origin === self.location.origin && x.searchParams.has('v') ? dropOldV(c, x) : null))).catch(() => {}); // v1.82: ?v= 파일은 옛 사본 지우기
        return res;
      })
      .catch(() => caches.match(key).then((r) => r || (nav ? caches.match(e.request) : r))) // 오프라인일 때만 캐시 사용
  );
});
