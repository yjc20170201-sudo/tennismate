// WASB-SBDT 테니스 공 탐지 모델 (NTT Communications, MIT — licenses/WASB-SBDT-LICENSE.md) 브라우저 추론
// 입력: 연속 3프레임 → 512×288 RGB, ImageNet 정규화, [1,9,288,512] → 출력 히트맵 [1,3,288,512] (sigmoid 적용됨)
window.WASB = (function () {
  const W = 512, H = 288, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/';
  let session = null, backend = null, loading = null, modelFile = 'wasb_tennis.onnx'; // v0.87: 모델 파일 선택 + 추론 시간 통계
  const stats = { n: 0, ms: 0 };
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('스크립트 로드 실패: ' + src)); document.head.appendChild(s); });
  }
  async function load(base, onStatus, file) {
    if (file && file !== modelFile) { modelFile = file; session = null; backend = null; }
    if (session) return session;
    if (loading) return loading;
    loading = (async () => {
      const gpu = !!(navigator.gpu); // Android Chrome 121+, iOS 18+ Safari — 있으면 WebGPU 번들
      if (!window.ort) await loadScript(ORT_BASE + (gpu ? 'ort.webgpu.min.js' : 'ort.min.js'));
      ort.env.wasm.wasmPaths = ORT_BASE;
      ort.env.wasm.numThreads = 1; // GitHub Pages는 COOP/COEP 헤더가 없어 멀티스레드 불가
      const buf = await fetch((base || '') + modelFile).then(r => { if (!r.ok) throw new Error('모델 다운로드 실패 ' + r.status); return r.arrayBuffer(); });
      const tryEP = async eps => { // 세션 생성 + 워밍업 1회 (webgl은 생성은 되고 실행에서 미지원 연산이 터질 수 있음 → wasm으로 폴백)
        try {
          const s = await ort.InferenceSession.create(buf, { executionProviders: eps, graphOptimizationLevel: 'all' });
          await s.run({ frames: new ort.Tensor('float32', new Float32Array(9 * W * H), [1, 9, H, W]) });
          backend = eps[0]; return s;
        } catch (e) { return null; }
      };
      session = (gpu ? await tryEP(['webgpu']) : null) || await tryEP(['webgl']) || await tryEP(['wasm']);
      if (!session) throw new Error('onnxruntime 세션 생성 실패');
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
  // sources: [f(t-2), f(t-1), f(t)] 드로어블 3개 → 마지막 프레임 공 위치 {x, y, conf} (원본 좌표) | null. all=true면 3프레임 결과 배열
  async function detectFrames(sources, vw, vh, opts) {
    opts = opts || {};
    const thr = opts.thr || 0.5;
    if (!session) await load(opts.base);
    const arr = new Float32Array(9 * W * H);
    sources.forEach((s, k) => frameToArray(s, arr, k));
    const input = new ort.Tensor('float32', arr, [1, 9, H, W]);
    const tRun = performance.now();
    const out = await session.run({ frames: input });
    stats.n++; stats.ms += performance.now() - tRun;
    const hm = out.heatmaps.data; // [3,H,W]
    const plane = W * H, sx = vw / W, sy = vh / H;
    const res = [];
    const K = opts.topk || 3; // 프레임당 후보 최대 3개 (바닥에 놓인 공·오탐과 진짜 공을 앱에서 움직임으로 가림, v0.81)
    for (let k = 0; k < 3; k++) {
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
    return opts.all ? res : res[2];
  }
  return { load, detectFrames, get backend() { return backend; }, get model() { return modelFile; }, get avgMs() { return stats.n ? stats.ms / stats.n : 0; }, resetStats() { stats.n = 0; stats.ms = 0; }, W, H };
})();
