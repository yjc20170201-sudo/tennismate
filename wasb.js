// WASB-SBDT 테니스 공 탐지 모델 (NTT Communications, MIT — licenses/WASB-SBDT-LICENSE.md) 브라우저 추론
// 입력: 연속 3프레임 → 512×288 RGB, ImageNet 정규화, [1,9,288,512] → 출력 히트맵 [1,3,288,512] (sigmoid 적용됨)
window.WASB = (function () {
  const W = 512, H = 288, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
  let session = null, backend = null, loading = null, modelFile = 'wasb_tennis.onnx', batchOK = false; // v0.87: 모델 파일 선택 + 추론 시간 통계 / v0.92: 배치 자가 검증
  const stats = { n: 0, ms: 0 };
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('스크립트 로드 실패: ' + src)); document.head.appendChild(s); });
  }
  let epPref = 'auto';
  async function load(base, onStatus, file, ep) { // ep: auto | wasm (v0.89 백엔드 강제)
    ep = ep || 'auto';
    if ((file && file !== modelFile) || ep !== epPref) { modelFile = file || modelFile; epPref = ep; session = null; backend = null; }
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      const gpu = !!(navigator.gpu); // Android Chrome 121+, iOS 18+ Safari — 있으면 WebGPU 번들
      if (!window.ort) await loadScript(ORT_BASE + (gpu ? 'ort.webgpu.min.js' : 'ort.min.js'));
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1; // GitHub Pages는 COOP/COEP 헤더가 없어 멀티스레드 불가
      const buf = await fetch((base || '') + modelFile + '?v=' + encodeURIComponent(typeof APP_VERSION !== 'undefined' ? APP_VERSION : Date.now())) /* v0.91: 모델 파일도 캐시 버스터 */.then(r => { if (!r.ok) throw new Error('모델 다운로드 실패 ' + r.status); return r.arrayBuffer(); });
      const tryEP = async eps => { // 세션 생성 + 워밍업 1회 (webgl은 생성은 되고 실행에서 미지원 연산이 터질 수 있음 → wasm으로 폴백)
        try {
          const s = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all' });
          await s.run({ frames: new ort.Tensor('float32', new Float32Array(9 * W * H), [1, 9, H, W]) });
          backend = eps[0]; return s;
        } catch (e) { console.warn("WASB EP " + eps[0] + " 실패:", e && e.message || e); return null; }
      };
      // v0.92: 자가 검증 — GPU 백엔드 출력을 wasm 기준과 비교(틀리면 wasm), 배치(2묶음) 출력이 단일과 같아야 배치 사용 (폴드3 WebGPU가 배치에서 빈 결과)
      const plane = W * H; const probe = new Float32Array(9 * plane); let seed = 12345; for (let i = 0; i < probe.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; probe[i] = (seed / 0x7fffffff) * 2 - 1; }
      const runOn = async (s, nb) => { const inp = new Float32Array(nb * 9 * plane); for (let b = 0; b < nb; b++) inp.set(probe, b * 9 * plane); const o = await s.run({ frames: new ort.Tensor('float32', inp, [nb, 9, H, W]) }); return o.heatmaps.data; };
      const maxDiff = (a, b, n) => { let m = 0; for (let i = 0; i < n; i += 7) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
      const wasmS = await tryEP(['wasm']); if (!wasmS) throw new Error('onnxruntime 세션 생성 실패');
      const ref = await runOn(wasmS, 1);
      let chosen = wasmS; backend = 'wasm';
      if (epPref !== 'wasm') {
        const gpuS = (gpu ? await tryEP(['webgpu']) : null) || await tryEP(['webgl']);
        if (gpuS) { try { const out1 = await runOn(gpuS, 1); const d1 = maxDiff(out1, ref, 3 * plane); if (out1.length === 3 * plane && d1 < 0.05) { chosen = gpuS; } else console.warn('WASB ' + backend + ' 단일 출력이 wasm과 다름(diff ' + d1.toFixed(3) + ') → wasm 사용'); } catch (e) { console.warn('WASB GPU 검증 실패:', e && e.message || e); } }
        if (chosen === wasmS) backend = 'wasm';
      }
      session = chosen;
      try { const out2 = await runOn(session, 2); batchOK = out2.length === 6 * plane && maxDiff(out2, ref, 3 * plane) < 0.05 && maxDiff(out2.subarray(3 * plane), ref, 3 * plane) < 0.05; } catch (e) { batchOK = false; }
      if (!batchOK) console.warn('WASB 배치 미사용 (' + backend + ')');
      stats.n = 0; stats.ms = 0;
      if (onStatus) onStatus('모델 준비 완료 (' + modelFile.replace('.onnx', '') + ' · ' + backend + ')');
      return session;
    })();
    try { return await loading; } finally { loading = null; }
  }
  function frameToArray(src, out, k) { // src: video/img/canvas → out[k*3+c][H][W]
    cx.drawImage(src, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data;
    const plane = W * H;
    for (let c = 0; c < 3; c++) {
      const o = (k * 3 + c) * plane, m = MEAN[c], s = STD[c];
      for (let i = 0, p = c; i < plane; i++, p += 4) out[o + i] = (d[p] / 255 - m) / s;
    }
  }
  // sources: 드로어블 3k개(3프레임 묶음 k개, v0.90 배치) → all=true면 프레임별 결과 배열(길이 3k), 아니면 마지막 프레임 결과. 모델이 고정 배치(1)면 묶음마다 따로 실행
  async function detectFrames(sources, vw, vh, opts) {
    opts = opts || {};
    const thr = opts.thr || 0.5;
    if (!session) await load(opts.base);
    const nb = Math.max(1, Math.floor(sources.length / 3));
    const plane0 = W * H;
    let hm;
    try {
      if (nb > 1 && !batchOK) throw new Error('batch disabled');
      const arr = new Float32Array(nb * 9 * plane0);
      sources.slice(0, nb * 3).forEach((s, i) => frameToArray(s, arr.subarray(Math.floor(i / 3) * 9 * plane0, (Math.floor(i / 3) + 1) * 9 * plane0), i % 3));
      const tRun = performance.now();
      const out = await session.run({ frames: new ort.Tensor('float32', arr, [nb, 9, H, W]) });
      stats.n += nb; stats.ms += performance.now() - tRun;
      hm = out.heatmaps.data; // [nb*3,H,W]
      if (!hm || hm.length !== nb * 3 * plane0) throw new Error('batch output size mismatch ' + (hm ? hm.length : 0)); // 고정 배치 모델이 잘못된 크기를 내면 폴백
    } catch (e) { // 고정 배치 모델(WASB) 또는 배치 실패: 묶음마다 따로
      if (nb === 1) throw e;
      const parts = [];
      for (let b = 0; b < nb; b++) { const arr = new Float32Array(9 * plane0); sources.slice(b * 3, b * 3 + 3).forEach((s, k) => frameToArray(s, arr, k)); const tRun = performance.now(); const out = await session.run({ frames: new ort.Tensor('float32', arr, [1, 9, H, W]) }); stats.n++; stats.ms += performance.now() - tRun; parts.push(out.heatmaps.data); }
      hm = new Float32Array(nb * 3 * plane0); parts.forEach((p, b) => hm.set(p, b * 3 * plane0));
    }
    const plane = W * H, sx = vw / W, sy = vh / H;
    const res = [];
    const K = opts.topk || 3; // 프레임당 후보 최대 3개 (바닥에 놓인 공·오탐과 진짜 공을 앱에서 움직임으로 가림, v0.81)
    for (let k = 0; k < nb * 3; k++) {
      const o = k * plane; const cands = [];
      const h2 = hm.subarray(o, o + plane); const taken = new Uint8Array(plane);
      for (let c = 0; c < K; c++) {
        let best = 0, bi = -1;
        for (let i = 0; i < plane; i++) { const v = h2[i]; if (v > best && !taken[i]) { best = v; bi = i; } }
        if (best < thr) break;
        // 최고점 주변 ±12px 안의 임계 초과 픽셀 무게중심 (멀리 떨어진 오탐 덩어리 배제) + 그 영역은 다음 후보에서 제외
        const bx = bi % W, by = (bi / W) | 0; let wx = 0, wy = 0, ws = 0;
        for (let y = Math.max(0, by - 12); y <= Math.min(H - 1, by + 12); y++) for (let x = Math.max(0, bx - 12); x <= Math.min(W - 1, bx + 12); x++) {
          const j = y * W + x; taken[j] = 1; const v = h2[j]; if (v > thr) { wx += x * v; wy += y * v; ws += v; }
        }
        cands.push({ x: (wx / ws) * sx, y: (wy / ws) * sy, conf: best });
      }
      res.push(cands.length ? Object.assign({}, cands[0], { cands }) : null);
    }
    return opts.all ? res : res[res.length - 1];
  }
  return { load, detectFrames, get backend() { return backend; }, get batchOK() { return batchOK; }, get model() { return modelFile; }, get avgMs() { return stats.n ? stats.ms / stats.n : 0; }, resetStats() { stats.n = 0; stats.ms = 0; }, W, H };
})();
