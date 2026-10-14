// 處理核心：比例、裁切、浮水印、縮放、編碼（預覽與輸出共用）
const RATIOS = [
  { key: 'orig', label: '原圖比例（不裁切）', note: '保留原圖', r: null, suffix: 'orig' },
  { key: '1:1', label: '1:1', note: 'PMax 正方', r: 1 },
  { key: '2:3', label: '2:3', note: '直式相片', r: 2 / 3 },
  { key: '3:2', label: '3:2', note: '橫式相片', r: 3 / 2 },
  { key: '1.91:1', label: '1.91:1', note: 'PMax 橫式', r: 1.91 },
  { key: '4:5', label: '4:5', note: 'PMax 直式、IG 貼文', r: 4 / 5 },
  { key: '9:16', label: '9:16', note: 'IG/FB 限動', r: 9 / 16 },
  { key: 'custom', label: '自訂', note: '手動填寫比例', r: null },
];

// 預覽中各規格裁切框的顏色
const COLORS = { orig: '#ffffff', '1:1': '#ff5a5a', '2:3': '#ffb020', '3:2': '#35c46b', '1.91:1': '#29b6f6', '4:5': '#b06cff', '9:16': '#ff6fb5', custom: '#ffe14d' };

const DEFAULTS = {
  cropOn: true, specs: ['1:1'], custom: { w: 16, h: 9 }, pos: {},
  wm: { on: false, src: 'image', text: '', color: '#777777', id: null, anchor: 8, custom: false, margin: 3, x: 0.9, y: 0.9, size: 20, opacity: 80, rot: 0 },
  resize: { on: false, mode: 'long', long: 1920, width: 1080, height: 1080, percent: 50, exactW: 1080, exactH: 1350, noUp: true },
  pdf: { on: true, mode: 'smart', dpi: 150, quality: 75, targetMB: 0, gray: false, resOn: false, resMode: 'percent', resPercent: 100, resLong: 297, out: 'pdf', imgFmt: 'jpg', imgDpi: 150, merge: false, split: 0, pnOn: false, pnPos: 'bc', pnSize: 10, pnFmt: '{n} / {N}', pnStart: 1 },
  out: { on: true, fmt: 'orig', von: true, vfmt: 'mp4', vquality: 70, vtargetKB: 0, fps: 0, quality: 90, targetKB: 0, bg: '#ffffff', tpl: '{name}_{ratio}', seqStart: 1, seqPad: 3, conflict: 'rename' },
};

// 移除舊版殘留、不在預設結構內的欄位（pos 例外）
function prune(base, obj) {
  for (const k of Object.keys(obj)) {
    if (!(k in base)) delete obj[k];
    else if (k !== 'pos' && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && obj[k] && typeof obj[k] === 'object') prune(base[k], obj[k]);
  }
  return obj;
}

// 實際生效的設定（區塊未啟用時使用中性值）
function effective(S, mode = 'image') {
  const o = S.out;
  let out;
  if (mode === 'video') out = o.von ? { ...o, on: true, quality: o.vquality, targetKB: o.vtargetKB } : { ...o, on: false, targetKB: 0 };
  else out = o.on ? o : { ...o, fmt: 'orig', quality: 92, targetKB: 0 };
  return {
    ...S,
    specs: S.cropOn ? S.specs : ['orig'],
    resize: S.resize.on ? S.resize : { ...S.resize, mode: 'none' },
    out,
  };
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    if (base && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = deepMerge(base[k], over[k]);
    else out[k] = over[k];
  }
  return out;
}

function specFor(key, S) {
  if (key === 'custom') {
    const w = +S.custom.w || 1, h = +S.custom.h || 1;
    return { key, ratio: w / h, suffix: `${w}x${h}`, label: `自訂 ${w}:${h}` };
  }
  const d = RATIOS.find(r => r.key === key) || RATIOS[0];
  return { key: d.key, ratio: d.r, suffix: d.suffix || d.key.replace(':', 'x'), label: d.label };
}

// 在原圖中取該比例的最大區域；px,py 為 0~1，表示在可移動範圍內的位置（0.5=置中）
// z 為縮放（0.05~1，1＝最大區域；縮小＝裁得更小、等同放大主體）
function cropRect(iw, ih, ratio, px, py, z = 1) {
  if (!ratio) return { x: 0, y: 0, w: iw, h: ih };
  let w, h;
  if (iw / ih > ratio) { h = ih; w = Math.round(ih * ratio); } else { w = iw; h = Math.round(iw / ratio); }
  z = Math.max(0.05, Math.min(1, z || 1));
  w = Math.max(1, Math.min(Math.round(w * z), iw)); h = Math.max(1, Math.min(Math.round(h * z), ih));
  return { x: Math.round((iw - w) * px), y: Math.round((ih - h) * py), w, h };
}

// 裁切後再做縮放規劃：回傳來源子區域(相對裁切區)與輸出尺寸
function targetPlan(R, cw, ch) {
  let sx = 0, sy = 0, sw = cw, sh = ch, sc = 1, W, H;
  if (R.mode === 'exact') {
    const ar = R.exactW / R.exactH;
    if (cw / ch > ar) { sw = Math.round(ch * ar); sx = Math.round((cw - sw) / 2); }
    else { sh = Math.round(cw / ar); sy = Math.round((ch - sh) / 2); }
    sc = R.exactW / sw;
    if (R.noUp) sc = Math.min(1, sc);
    W = Math.round(sw * sc); H = Math.round(sh * sc);
  } else {
    if (R.mode === 'long') sc = R.long / Math.max(cw, ch);
    else if (R.mode === 'width') sc = R.width / cw;
    else if (R.mode === 'height') sc = R.height / ch;
    else if (R.mode === 'percent') sc = R.percent / 100;
    if (R.noUp) sc = Math.min(1, sc);
    W = Math.round(cw * sc); H = Math.round(ch * sc);
  }
  return { sx, sy, sw, sh, W: Math.max(1, W), H: Math.max(1, H) };
}

function wmPlacement(W, H, wm, img) {
  const w = W * wm.size / 100, h = w * img.height / img.width;
  let cx, cy;
  if (wm.custom) { cx = wm.x * W; cy = wm.y * H; }
  else {
    const m = Math.min(W, H) * wm.margin / 100, col = wm.anchor % 3, row = Math.floor(wm.anchor / 3);
    cx = col === 0 ? m + w / 2 : col === 1 ? W / 2 : W - m - w / 2;
    cy = row === 0 ? m + h / 2 : row === 1 ? H / 2 : H - m - h / 2;
  }
  return { cx, cy, w, h };
}

function drawWm(ctx, W, H, wm, img) {
  const p = wmPlacement(W, H, wm, img);
  ctx.save();
  ctx.globalAlpha = wm.opacity / 100;
  ctx.translate(p.cx, p.cy);
  ctx.rotate(wm.rot * Math.PI / 180);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -p.w / 2, -p.h / 2, p.w, p.h);
  ctx.restore();
}

function mimeFor(S, file) {
  const f = S.out.fmt;
  if (f === 'jpg') return 'image/jpeg';
  if (f === 'png') return 'image/png';
  if (f === 'webp') return 'image/webp';
  if (f === 'gif') return 'image/gif';
  const t = file && file.type;
  return t === 'image/jpeg' || t === 'image/webp' || t === 'image/gif' ? t : 'image/png';
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function renderOutput(bmp, pos, S, spec, wmImg, mime) {
  const c = cropRect(bmp.width, bmp.height, spec.ratio, pos.x, pos.y, pos.z);
  const p = targetPlan(S.resize, c.w, c.h);
  const cv = document.createElement('canvas');
  cv.width = p.W; cv.height = p.H;
  const ctx = cv.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = S.out.bg; ctx.fillRect(0, 0, p.W, p.H); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, c.x + p.sx, c.y + p.sy, p.sw, p.sh, 0, 0, p.W, p.H);
  if (S.wm.on && wmImg) drawWm(ctx, p.W, p.H, S.wm, wmImg);
  return cv;
}

// ---------- Lanczos3 縮小（比瀏覽器內建縮放銳利、細節保留較好）----------
// 自成一體的函式：同時用在背景執行緒與主執行緒備援。src 為 RGBA（straight alpha）。
function lanczosResize(src, sw, sh, W, H) {
  const lan = t => { t = Math.abs(t); if (t >= 3) return 0; if (t < 1e-8) return 1; const p = Math.PI * t; return 3 * Math.sin(p) * Math.sin(p / 3) / (p * p); };
  const weights = (sIn, sOut) => {
    const sc = sIn / sOut, f = Math.max(1, sc), sup = 3 * f, out = [];
    for (let o = 0; o < sOut; o++) {
      const c = (o + 0.5) * sc, lo = Math.max(0, Math.floor(c - sup)), hi = Math.min(sIn - 1, Math.ceil(c + sup));
      const w = new Float32Array(hi - lo + 1); let s = 0;
      for (let i = lo; i <= hi; i++) { const v = lan((i + 0.5 - c) / f); w[i - lo] = v; s += v; }
      for (let k = 0; k < w.length; k++) w[k] /= s;
      out.push({ lo, w });
    }
    return out;
  };
  const wx = weights(sw, W), wy = weights(sh, H);
  const tmp = new Float32Array(W * sh * 4);          // 水平縮小後（alpha 預乘）
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4, orow = y * W * 4;
    for (let x = 0; x < W; x++) {
      const { lo, w } = wx[x];
      let r = 0, g = 0, b = 0, a = 0, idx = row + lo * 4;
      for (let k = 0; k < w.length; k++, idx += 4) {
        const wk = w[k], al = src[idx + 3];
        if (al === 255) { r += src[idx] * wk; g += src[idx + 1] * wk; b += src[idx + 2] * wk; a += 255 * wk; }
        else if (al) { const f = al / 255 * wk; r += src[idx] * f; g += src[idx + 1] * f; b += src[idx + 2] * f; a += al * wk; }
      }
      const o = orow + x * 4; tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4), acc = new Float32Array(W * 4);
  for (let y = 0; y < H; y++) {
    const { lo, w } = wy[y];
    acc.fill(0);
    for (let k = 0; k < w.length; k++) {
      const wk = w[k], base = (lo + k) * W * 4;
      for (let i = 0; i < W * 4; i++) acc[i] += tmp[base + i] * wk;
    }
    const orow = y * W * 4;
    for (let x = 0; x < W; x++) {
      const i = x * 4, a = acc[i + 3];
      if (a > 0.5) { const inv = 255 / a; out[orow + i] = acc[i] * inv; out[orow + i + 1] = acc[i + 1] * inv; out[orow + i + 2] = acc[i + 2] * inv; out[orow + i + 3] = a; }
    }
  }
  return out;
}
let _lanWorker = null, _lanSeq = 0;
function lanczosAsync(buf, sw, sh, W, H) {
  return new Promise((resolve, reject) => {
    const fallback = () => { try { resolve(lanczosResize(new Uint8ClampedArray(buf), sw, sh, W, H)); } catch (e) { reject(e); } };
    try {
      if (!_lanWorker) {
        const code = 'const lanczosResize=' + lanczosResize.toString() + ';self.onmessage=e=>{const d=e.data;const o=lanczosResize(new Uint8ClampedArray(d.buf),d.sw,d.sh,d.W,d.H);self.postMessage({id:d.id,out:o},[o.buffer])};';
        _lanWorker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      }
      const id = ++_lanSeq, w = _lanWorker;
      const done = e => { if (e.data.id !== id) return; w.removeEventListener('message', done); w.removeEventListener('error', fail); resolve(e.data.out); };
      const fail = () => { w.removeEventListener('message', done); w.removeEventListener('error', fail); _lanWorker = null; fallback(); };
      w.addEventListener('message', done); w.addEventListener('error', fail);
      w.postMessage({ id, buf, sw, sh, W, H }, [buf]);
    } catch { _lanWorker = null; fallback(); }
  });
}

// 與 renderOutput 相同，但縮小幅度明顯時改用 Lanczos3（輸出用；預估大小時仍用較快的 renderOutput）
async function renderOutputQ(bmp, pos, S, spec, wmImg, mime) {
  const c = cropRect(bmp.width, bmp.height, spec.ratio, pos.x, pos.y, pos.z);
  const p = targetPlan(S.resize, c.w, c.h);
  if (!(p.W < p.sw * 0.9 || p.H < p.sh * 0.9)) return renderOutput(bmp, pos, S, spec, wmImg, mime);
  const srcCv = document.createElement('canvas'); srcCv.width = p.sw; srcCv.height = p.sh;
  const sctx = srcCv.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(bmp, c.x + p.sx, c.y + p.sy, p.sw, p.sh, 0, 0, p.sw, p.sh);
  const data = sctx.getImageData(0, 0, p.sw, p.sh).data;
  srcCv.width = srcCv.height = 1;                       // 釋放記憶體
  const px = await lanczosAsync(data.buffer, p.sw, p.sh, p.W, p.H);
  const tmp = document.createElement('canvas'); tmp.width = p.W; tmp.height = p.H;
  tmp.getContext('2d').putImageData(new ImageData(px, p.W, p.H), 0, 0);
  const cv = document.createElement('canvas'); cv.width = p.W; cv.height = p.H;
  const ctx = cv.getContext('2d');
  if (mime === 'image/jpeg') { ctx.fillStyle = S.out.bg; ctx.fillRect(0, 0, p.W, p.H); }
  ctx.drawImage(tmp, 0, 0);
  if (S.wm.on && wmImg) drawWm(ctx, p.W, p.H, S.wm, wmImg);
  return cv;
}

const toBlob = (cv, mime, q) => new Promise(res => cv.toBlob(res, mime, q));

// 編碼；若設定檔案大小上限，二分搜尋品質。回傳 {blob, over}
async function encodeCanvas(cv, mime, S) {
  const q = S.out.quality / 100;
  const target = (+S.out.targetKB || 0) * 1024;
  if (mime === 'image/gif') return { blob: await Media.encodeGif(cv), over: false };
  if (mime === 'image/png' || !target) return { blob: await toBlob(cv, mime, q), over: false };
  const first = await toBlob(cv, mime, q);
  if (first.size <= target) return { blob: first, over: false };
  let lo = 0.4, hi = q, best = null;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2, b = await toBlob(cv, mime, mid);
    if (b.size <= target) { best = b; lo = mid; } else hi = mid;
  }
  if (best) return { blob: best, over: false };
  return { blob: await toBlob(cv, mime, 0.4), over: true };
}
