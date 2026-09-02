// TrackNet 브라우저 러너 — 테니스공 전용 딥러닝 추적
// 원본 모델·가중치: ArtLabss/tennis-tracking (The Unlicense, 퍼블릭 도메인)
// 입력: 640×360 BGR 원시값(0~255) / 출력: 픽셀별 밝기 클래스(0~255) 히트맵 → 127 초과 영역 중심 = 공
window.TrackNet = (function () {
  let ready = false;
  let convs = [], bns = [];
  // tracknet.py의 레이어 순서: c=conv+relu+bn, p=maxpool, u=upsample
  const OPS = ['c','c','p','c','c','p','c','c','c','p','c','c','c','u','c','c','c','u','c','c','u','c','c','c'];

  async function load(base) {
    if (ready) return;
    if (!window.tf) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4/dist/tf.min.js';
        s.onload = res; s.onerror = () => rej(new Error('tfjs 로드 실패'));
        document.head.appendChild(s);
      });
    }
    const [mani, bin] = await Promise.all([
      fetch(base + 'tn-manifest.json').then(r => { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); }),
      fetch(base + 'tn-weights.bin').then(r => { if (!r.ok) throw new Error('weights ' + r.status); return r.arrayBuffer(); })
    ]);
    const u8 = new Uint8Array(bin);
    const get = m => { // uint8 → float32 복원
      const f = new Float32Array(m.n);
      for (let i = 0; i < m.n; i++) f[i] = u8[m.off + i] * m.scale + m.min;
      return tf.tensor(f, m.shape);
    };
    const L = mani.layers;
    convs = []; bns = [];
    for (let i = 0; i < L.length; i++) {
      if (L[i].w === 'kernel') convs.push({ k: get(L[i]), b: get(L[i + 1]) });
      if (L[i].w === 'gamma') bns.push({ g: get(L[i]), be: get(L[i + 1]), mu: get(L[i + 2]), va: get(L[i + 3]) });
    }
    if (convs.length !== 18 || bns.length !== 18) throw new Error('가중치 구성이 예상과 달라요: ' + convs.length + '/' + bns.length);
    ready = true;
  }

  function forward(input) { // input [1,H,W,3] → argmax 히트맵 [1,H,W]
    return tf.tidy(() => {
      let x = input, ci = 0;
      OPS.forEach(op => {
        if (op === 'c') {
          x = tf.conv2d(x, convs[ci].k, 1, 'same').add(convs[ci].b);
          x = tf.relu(x);
          // 원본 모델의 BN은 (기본 axis=-1 실수로) 채널이 아니라 "너비" 축을 정규화한 채 학습됨 — 그대로 재현해야 함
          const bn = bns[ci];
          const W = x.shape[2];
          const rs = t => t.reshape([1, 1, W, 1]);
          x = x.sub(rs(bn.mu)).div(rs(bn.va).reshape([1, 1, W, 1]).add(0.001).sqrt()).mul(rs(bn.g)).add(rs(bn.be));
          ci++;
        } else if (op === 'p') {
          x = tf.maxPool(x, 2, 2, 'same');
        } else {
          x = tf.image.resizeNearestNeighbor(x, [x.shape[1] * 2, x.shape[2] * 2]);
        }
      });
      return tf.argMax(x, 3);
    });
  }

  async function detectPixels(pixels, w, h) { // ImageData.data(RGBA) → {x, y(입력 좌표계), n} | null
    const f = new Float32Array(w * h * 3);
    for (let i = 0, p = 0; i < w * h; i++, p += 4) {
      f[i * 3] = pixels[p + 2];     // B (원본이 OpenCV BGR 학습)
      f[i * 3 + 1] = pixels[p + 1]; // G
      f[i * 3 + 2] = pixels[p];     // R
    }
    const input = tf.tensor4d(f, [1, h, w, 3]);
    const outT = forward(input);
    const out = await outT.data();
    input.dispose(); outT.dispose();
    let sx = 0, sy = 0, n = 0;
    for (let i = 0; i < out.length; i++) {
      if (out[i] > 127) { sx += i % w; sy += (i / w) | 0; n++; }
    }
    if (n < 2 || n > 1500) return null; // 너무 크면 오검출
    return { x: sx / n, y: sy / n, n };
  }

  async function detect(video) { // 비디오 현재 프레임에서 공 위치 (원본 픽셀 좌표) | null
    const W = 640, H = 360;
    const cv = detect._cv || (detect._cv = document.createElement('canvas'));
    cv.width = W; cv.height = H;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(video, 0, 0, W, H);
    const img = cx.getImageData(0, 0, W, H).data;
    const d = await detectPixels(img, W, H);
    if (!d) return null;
    return { x: d.x * (video.videoWidth / W), y: d.y * (video.videoHeight / H), conf: Math.min(1, d.n / 30) };
  }

  return { load, detect, detectPixels, get ready() { return ready; } };
})();
