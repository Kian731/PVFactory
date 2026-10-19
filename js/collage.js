// 拼接（拼貼／長圖）引擎：樣板、幾何、預覽與高品質輸出
const Collage = (() => {
  const MAX = 10;
  const range = n => Array.from({ length: n }, (_, i) => i);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const bal = (n, r) => range(r).map(i => Math.floor(n / r) + (i < n % r ? 1 : 0));   // 把 n 張盡量平均分成 r 組

  // ---------- 樣板（用樹表示：數字＝第幾張照片；{t:'h'|'v', k:[{w,c}]}）----------
  const wa = (asp, i) => clamp(asp[i], 0.45, 2.2);
  function rowsTree(counts, asp, uniform, start = 0) {
    let idx = start; const rows = [];
    for (const cnt of counts) {
      const ids = range(cnt).map(() => idx++);
      const node = cnt === 1 ? ids[0] : { t: 'h', k: ids.map(id => ({ w: uniform ? 1 : wa(asp, id), c: id })) };
      rows.push({ w: uniform ? 1 : 1 / ids.reduce((a, id) => a + wa(asp, id), 0), c: node });
    }
    return rows.length === 1 ? rows[0].c : { t: 'v', k: rows };
  }
  function colsTree(counts, asp, uniform, start = 0) {
    let idx = start; const cols = [];
    for (const cnt of counts) {
      const ids = range(cnt).map(() => idx++);
      const node = cnt === 1 ? ids[0] : { t: 'v', k: ids.map(id => ({ w: uniform ? 1 : 1 / wa(asp, id), c: id })) };
      cols.push({ w: uniform ? 1 : 1 / ids.reduce((a, id) => a + 1 / wa(asp, id), 0), c: node });
    }
    return cols.length === 1 ? cols[0].c : { t: 'h', k: cols };
  }
  function bigTree(n, asp, uniform, pos) {
    const m = n - 1, side = pos === 'left' || pos === 'right';
    let rest;
    if (m === 1) rest = 1;
    else if (side) rest = m <= 3 ? { t: 'v', k: range(m).map(i => ({ w: 1, c: i + 1 })) } : rowsTree(bal(m, 2 + (m > 6 ? 1 : 0)), asp, true, 1);
    else rest = m <= 4 ? { t: 'h', k: range(m).map(i => ({ w: 1, c: i + 1 })) } : colsTree(bal(m, m > 8 ? 3 : 2), asp, true, 1);
    const big = { w: side ? 1.5 : 1.4, c: 0 }, other = { w: 1, c: rest };
    return { t: side ? 'h' : 'v', k: pos === 'right' || pos === 'bottom' ? [other, big] : [big, other] };
  }
  // 依照片張數與長寬比產生可選樣板（照片比例差異大時，自動依比例分配寬高，減少裁切）
  function templatesFor(n, asp, ratio) {
    const out = [], add = (name, tree) => out.push({ name, tree });
    if (n <= 1) { add('單張', 0); return out; }
    const uniform = Math.max(...asp) / Math.min(...asp) < 1.25;
    for (let r = 1; r <= Math.min(n, 4); r++) {
      const c = bal(n, r);
      add(r === 1 ? '一排' : `${r} 排`, rowsTree(c, asp, uniform));
      if (r > 1 && new Set(c).size > 1) add(`${r} 排（反向）`, rowsTree([...c].reverse(), asp, uniform));
    }
    for (let c = 2; c <= Math.min(n - 1, 4); c++) add(`${c} 欄`, colsTree(bal(n, c), asp, uniform));
    if (n >= 3) for (const p of ['left', 'top', 'right']) add({ left: '左大圖', top: '上大圖', right: '右大圖' }[p], bigTree(n, asp, uniform, p));
    // 依「照片被裁掉的程度」由小到大排序：第一個就是最適合的樣板
    if (ratio) {
      const W = 1000, H = W / ratio;
      out.forEach(t => { const rs = layout(t.tree, { x: 0, y: 0, w: W, h: H }, 0, n); t.score = rs.reduce((a, r, i) => a + Math.abs(Math.log((r.w / r.h) / asp[i])), 0) / n; });
      out.sort((a, b) => a.score - b.score);
      out[0].name += '（推薦）';
    }
    return out.slice(0, 14);
  }
  function layout(node, r, gap, count) {
    const out = new Array(count);
    (function go(nd, rect) {
      if (typeof nd === 'number') { out[nd] = rect; return; }
      const k = nd.k, n = k.length, tot = k.reduce((a, x) => a + x.w, 0), horiz = nd.t === 'h';
      const avail = Math.max(1, (horiz ? rect.w : rect.h) - gap * (n - 1));
      let pos = horiz ? rect.x : rect.y;
      for (const ch of k) {
        const sz = avail * ch.w / tot;
        go(ch.c, horiz ? { x: pos, y: rect.y, w: sz, h: rect.h } : { x: rect.x, y: pos, w: rect.w, h: sz });
        pos += sz + gap;
      }
    })(node, r);
    return out;
  }

  // ---------- 照片在框內的位置 ----------
  // cl：{fit:'cover'|'contain', zoom, px, py}；回傳照片繪製範圍、與框相交的目的地、對應的來源範圍
  function place(box, iw, ih, cl) {
    const base = cl.fit === 'contain' ? Math.min(box.w / iw, box.h / ih) : Math.max(box.w / iw, box.h / ih);
    const zoom = Math.max(cl.fit === 'contain' ? 0.2 : 1, cl.zoom || 1), s = base * zoom;
    const dw = iw * s, dh = ih * s, x0 = box.x + (box.w - dw) * cl.px, y0 = box.y + (box.h - dh) * cl.py;
    const x1 = Math.max(box.x, x0), y1 = Math.max(box.y, y0), x2 = Math.min(box.x + box.w, x0 + dw), y2 = Math.min(box.y + box.h, y0 + dh);
    return { s, dw, dh, x0, y0, dest: { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, src: { x: (x1 - x0) / s, y: (y1 - y0) / s, w: (x2 - x1) / s, h: (y2 - y1) / s } };
  }
  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function rotateCanvas(src, rot, cap) {
    const w = src.width, h = src.height, sw = rot % 180 ? h : w, sh = rot % 180 ? w : h, k = Math.min(1, cap / Math.max(sw, sh));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
    x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.scale(k, k); x.drawImage(src, -w / 2, -h / 2);
    return c;
  }

  // ---------- 預覽（用縮小版照片，快）----------
  // srcOf(i) 回傳該照片已套用旋轉的預覽畫布
  function drawPreview(ctx, geom, items, srcOf, bgColor) {
    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, geom.W, geom.H); }
    for (const i of geom.order) {
      const src = srcOf(i), rect = geom.rects[i], pl = place(rect, src.width, src.height, items[i].cl);
      if (pl.dest.w < 1 || pl.dest.h < 1) continue;
      ctx.save(); roundRectPath(ctx, pl.dest.x, pl.dest.y, pl.dest.w, pl.dest.h, geom.radius); ctx.clip();
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, pl.src.x, pl.src.y, pl.src.w, pl.src.h, pl.dest.x, pl.dest.y, pl.dest.w, pl.dest.h);
      ctx.restore();
    }
  }

  // ---------- 高品質輸出 ----------
  async function drawPhotoHQ(ctx, it, rect, radius) {
    const bmp = await createImageBitmap(it.file);
    try {
      let src = bmp, iw = bmp.width, ih = bmp.height;
      if (it.cl.rot) { src = rotateCanvas(bmp, it.cl.rot, 4096); iw = src.width; ih = src.height; }
      const pl = place(rect, iw, ih, it.cl);
      const d = { x: Math.round(pl.dest.x), y: Math.round(pl.dest.y), w: Math.max(1, Math.round(pl.dest.w)), h: Math.max(1, Math.round(pl.dest.h)) };
      const sx = clamp(Math.floor(pl.src.x), 0, iw - 1), sy = clamp(Math.floor(pl.src.y), 0, ih - 1);
      const sw = clamp(Math.round(pl.src.w), 1, iw - sx), sh = clamp(Math.round(pl.src.h), 1, ih - sy);
      const tmp = document.createElement('canvas'); tmp.width = d.w; tmp.height = d.h;
      if (d.w < sw * 0.9 || d.h < sh * 0.9) {                       // 縮小：Lanczos3（較清晰）
        const sc = document.createElement('canvas'); sc.width = sw; sc.height = sh;
        const sctx = sc.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
        const px = await lanczosAsync(sctx.getImageData(0, 0, sw, sh).data.buffer, sw, sh, d.w, d.h);
        tmp.getContext('2d').putImageData(new ImageData(px, d.w, d.h), 0, 0);
      } else { const t = tmp.getContext('2d'); t.imageSmoothingQuality = 'high'; t.drawImage(src, sx, sy, sw, sh, 0, 0, d.w, d.h); }
      ctx.save(); roundRectPath(ctx, d.x, d.y, d.w, d.h, radius); ctx.clip(); ctx.drawImage(tmp, d.x, d.y); ctx.restore();
    } finally { bmp.close(); }
  }
  async function renderGrid(items, geom, bgColor, onProgress) {
    const W = Math.round(geom.W), H = Math.round(geom.H);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
    for (let k = 0; k < geom.order.length; k++) {
      const i = geom.order[k];
      await drawPhotoHQ(ctx, items[i], geom.rects[i], geom.radius);
      if (onProgress) onProgress((k + 1) / geom.order.length);
    }
    return cv;
  }
  async function renderLong(items, geom, bgColor, onProgress) {
    const W = Math.round(geom.W), H = Math.round(geom.H);
    if (W * H > 150e6 || Math.max(W, H) > 30000) throw new Error(`長圖尺寸過大（${W}×${H}），請縮小寬度/高度或減少照片`);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    if (bgColor) { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, W, H); }
    for (let i = 0; i < items.length; i++) {
      const it = { ...items[i], cl: { ...items[i].cl, fit: 'cover', zoom: 1, px: 0.5, py: 0.5 } };
      await drawPhotoHQ(ctx, it, geom.rects[i], geom.radius);
      if (onProgress) onProgress((i + 1) / items.length);
    }
    return cv;
  }
  // 長圖依比例切成多張（垂直長圖切高度，水平長圖切寬度）；最後一張不足的部分補背景
  function sliceCanvas(cv, ratio, vertical, bgColor) {
    const out = [], sl = vertical ? Math.max(1, Math.round(cv.width / ratio)) : Math.max(1, Math.round(cv.height * ratio));
    const total = vertical ? cv.height : cv.width, n = Math.max(1, Math.ceil(total / sl));
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas'); c.width = vertical ? cv.width : sl; c.height = vertical ? sl : cv.height;
      const x = c.getContext('2d');
      if (bgColor) { x.fillStyle = bgColor; x.fillRect(0, 0, c.width, c.height); }
      const len = Math.min(sl, total - i * sl);
      if (vertical) x.drawImage(cv, 0, i * sl, cv.width, len, 0, 0, cv.width, len); else x.drawImage(cv, i * sl, 0, len, cv.height, 0, 0, len, cv.height);
      out.push(c);
    }
    return out;
  }

  return { MAX, templatesFor, layout, place, roundRectPath, drawPreview, renderGrid, renderLong, sliceCanvas };
})();
