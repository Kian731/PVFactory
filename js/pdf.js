// PDF 支援：pdf.js（讀取/轉圖）＋ pdf-lib（改 PDF 結構），需要時才載入
const Pdf = (() => {
  let ready = null;
  function libs() {
    if (!ready) ready = (async () => {
      await Media.loadScript('js/vendor/pdf.min.js');
      await Media.loadScript('js/vendor/pdf-lib.min.js');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';
    })();
    return ready;
  }
  const isPdf = f => /application\/pdf/.test(f.type || '') || /\.pdf$/i.test(f.name);
  const PTS_PER_PX = 0.75;     // 圖片轉 PDF：96dpi → pt
  const pageDims = pg => (pg.rot % 180 ? { w: pg.h, h: pg.w } : { w: pg.w, h: pg.h });
  const keptPages = doc => doc.pages.filter(p => !p.del);

  // ---------- 開啟 ----------
  async function openDoc(file, askPassword) {
    await libs();
    if (isPdf(file)) {
      const data = new Uint8Array(await file.arrayBuffer());
      const task = pdfjsLib.getDocument({ data, cMapUrl: 'js/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'js/vendor/pdfjs/standard_fonts/' });
      let password = null;
      task.onPassword = (update, reason) => {
        const pw = askPassword(file.name, reason === 2);
        if (pw == null) task.destroy(); else { password = pw; update(pw); }
      };
      const pdf = await task.promise;
      const pages = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 1 });
        pages.push({ i: i - 1, rot: 0, del: false, w: vp.width, h: vp.height, base: pg.rotate || 0, thumb: '' });
        pg.cleanup();
      }
      return { kind: 'pdf', pdf, password, pages };
    }
    let bmp;
    try { bmp = await createImageBitmap(file); }
    catch (err) { if (!Media.isHeic(file)) throw err; bmp = await createImageBitmap(await Media.heicToJpeg(file)); }
    return { kind: 'image', bmp, pages: [{ i: 0, rot: 0, del: false, w: bmp.width * PTS_PER_PX, h: bmp.height * PTS_PER_PX, base: 0, thumb: '' }] };
  }
  function dispose(doc) { try { doc.pdf && doc.pdf.destroy(); doc.bmp && doc.bmp.close(); } catch { } }

  // ---------- 頁面畫成圖 ----------
  // region：顯示座標（pt）下的取樣範圍；scale：每 pt 幾像素
  async function renderCanvas(doc, pg, scale, region) {
    const d = pageDims(pg), r = region || { l: 0, t: 0, w: d.w, h: d.h };
    const W = Math.max(1, Math.round(r.w * scale)), H = Math.max(1, Math.round(r.h * scale));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (doc.kind === 'pdf') {
      const page = await doc.pdf.getPage(pg.i + 1);
      const vp = page.getViewport({ scale, rotation: (pg.base + pg.rot) % 360 });
      await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -r.l * scale, -r.t * scale] }).promise;
      page.cleanup();
    } else {
      ctx.save();
      ctx.scale(scale, scale); ctx.translate(-r.l, -r.t);
      ctx.translate(d.w / 2, d.h / 2); ctx.rotate(pg.rot * Math.PI / 180);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(doc.bmp, -pg.w / 2, -pg.h / 2, pg.w, pg.h);
      ctx.restore();
    }
    return cv;
  }
  async function previewBitmap(doc, pg) {
    const d = pageDims(pg), cv = await renderCanvas(doc, pg, 1400 / Math.max(d.w, d.h), null);
    return createImageBitmap(cv);
  }
  async function thumb(doc, pg) {
    const d = pageDims(pg);
    try { return (await renderCanvas(doc, pg, 96 / Math.max(d.w, d.h), null)).toDataURL('image/jpeg', 0.6); } catch { return ''; }
  }

  // ---------- 頁碼範圍 ----------
  // "1-3,5,8-" → Set(0 起算的頁索引)
  function parseRange(text, total) {
    const out = new Set();
    for (const part of String(text).split(/[,，、;\s]+/).filter(Boolean)) {
      const m = part.match(/^(\d*)\s*[-~－]\s*(\d*)$/);
      if (m) {
        const a = m[1] ? +m[1] : 1, b = m[2] ? +m[2] : total;
        for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(total, Math.max(a, b)); i++) out.add(i - 1);
      } else if (/^\d+$/.test(part) && +part >= 1 && +part <= total) out.add(+part - 1);
      else return null;
    }
    return out;
  }
  function describeRange(nums) { // [1,2,3,5] → "1-3,5"
    const a = [...nums].sort((x, y) => x - y), out = [];
    for (let i = 0; i < a.length;) { let j = i; while (j + 1 < a.length && a[j + 1] === a[j] + 1) j++; out.push(j > i ? `${a[i]}-${a[j]}` : `${a[i]}`); i = j + 1; }
    return out.join(',');
  }

  // ---------- 輸出規劃 ----------
  // 回傳工作清單：每項 = 一個要輸出的 PDF（合併、拆分已套用）
  function plan(docs, P) {
    const groups = [];
    if (P.merge) {
      const refs = [];
      docs.forEach(d => keptPages(d).forEach(pg => refs.push({ doc: d, pg })));
      if (refs.length) groups.push({ name: docs.length > 1 ? '合併' : docs[0].base, doc: docs[0], refs });
    } else {
      docs.forEach(d => { const refs = keptPages(d).map(pg => ({ doc: d, pg })); if (refs.length) groups.push({ name: d.base, doc: d, refs }); });
    }
    const jobs = [];
    for (const g of groups) {
      const n = +P.split > 0 ? +P.split : 0;
      if (!n || g.refs.length <= n) { jobs.push({ ...g, part: 0, label: `1-${g.refs.length}` }); continue; }
      for (let s = 0, k = 1; s < g.refs.length; s += n, k++) {
        const refs = g.refs.slice(s, s + n);
        jobs.push({ name: g.name, doc: g.doc, refs, part: k, label: `${s + 1}-${s + refs.length}` });
      }
    }
    return jobs;
  }

  // ---------- 共用幾何 ----------
  function cropRegion(pg, spec, pos) {
    const d = pageDims(pg);
    if (!spec.ratio) return { l: 0, t: 0, w: d.w, h: d.h };
    const r = cropRect(Math.round(d.w * 100), Math.round(d.h * 100), spec.ratio, pos.x, pos.y, pos.z);
    return { l: r.x / 100, t: r.y / 100, w: r.w / 100, h: r.h / 100 };
  }
  function scaleFactor(P, cw, ch) {
    if (!P.resOn) return 1;
    if (P.resMode === 'percent') return Math.max(0.05, P.resPercent / 100);
    return Math.max(0.05, (P.resLong / 25.4 * 72) / Math.max(cw, ch));      // 長邊 mm
  }
  // 顯示座標(u 向右, v 向下) → 頁面 user space；R 為頁面順時針旋轉角
  function d2u(R, b, u, v) {
    switch (R) {
      case 90: return [b.x + v, b.y + u];
      case 180: return [b.x + b.width - u, b.y + v];
      case 270: return [b.x + b.width - v, b.y + b.height - u];
      default: return [b.x + u, b.y + b.height - v];
    }
  }
  const dispOf = (R, b) => (R % 180 ? { w: b.height, h: b.width } : { w: b.width, h: b.height });
  const pnText = (P, idx, total) => String(P.pnFmt || '{n}').replace('{n}', (+P.pnStart || 1) + idx).replace('{N}', (+P.pnStart || 1) + total - 1);
  function imgBytes(img, type, q) {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return new Promise(res => c.toBlob(async b => res(new Uint8Array(await b.arrayBuffer())), type, q));
  }

  // ---------- 轉圖片式：每頁畫成圖再組成 PDF ----------
  async function rasterCanvas(ref, spec, cfg, dpi, idx, total) {
    const { S, wmImg, posFor } = cfg, P = S.pdf, { doc, pg } = ref;
    const reg = cropRegion(pg, spec, posFor(doc, spec.key));
    const f = scaleFactor(P, reg.w, reg.h), outW = reg.w * f, outH = reg.h * f;
    let scale = (dpi / 72) * f;                                  // 每個來源 pt 的像素數
    if (doc.kind === 'image') scale = Math.min(scale, 1 / PTS_PER_PX);   // 圖片來源不放大
    let cv = await renderCanvas(doc, pg, scale, reg);
    if (P.on && P.gray) cv = toGray(cv);
    const ctx = cv.getContext('2d');
    if (S.wm.on && wmImg) drawWm(ctx, cv.width, cv.height, S.wm, wmImg);
    if (P.pnOn) stampCanvas(ctx, cv.width, cv.height, P, idx, total, scale / f);
    return { cv, outW, outH, f };
  }
  function toGray(cv) {
    const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d');
    x.drawImage(cv, 0, 0);
    const im = x.getImageData(0, 0, c.width, c.height), d = im.data;
    for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = d[i + 1] = d[i + 2] = g; }
    x.putImageData(im, 0, 0);
    return c;
  }
  function stampCanvas(ctx, W, H, P, idx, total, pxPerPt) {
    const size = Math.max(6, P.pnSize * pxPerPt), m = Math.min(W, H) * 0.04, txt = pnText(P, idx, total);
    ctx.font = `${size}px sans-serif`; ctx.fillStyle = '#333'; ctx.textBaseline = 'alphabetic';
    const tw = ctx.measureText(txt).width, pos = P.pnPos || 'bc';
    const x = pos[1] === 'l' ? m : pos[1] === 'r' ? W - m - tw : (W - tw) / 2, y = pos[0] === 't' ? m + size * 0.8 : H - m;
    ctx.fillText(txt, x, y);
  }
  async function jpegBytes(cv, q) { return new Uint8Array(await (await new Promise(r => cv.toBlob(r, 'image/jpeg', q))).arrayBuffer()); }

  // 有容量上限時，用樣本頁試出合適的（解析度、品質）
  async function pickRasterParams(refs, spec, cfg) {
    const P = cfg.S.pdf, target = P.targetMB * 1048576;
    let dpi = P.dpi, q = P.quality / 100;
    if (!(P.on && target > 0) || !refs.length) return { dpi, q };
    const idxs = [...new Set([0, Math.floor(refs.length / 2), refs.length - 1])];
    const samples = [];
    for (const i of idxs) samples.push((await rasterCanvas(refs[i], spec, cfg, dpi, i, refs.length)).cv);
    const perPage = target / refs.length;
    const sizeAt = async (k, qq) => { let s = 0; for (const cv of samples) { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(cv.width * k)); c.height = Math.max(1, Math.round(cv.height * k)); const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cv, 0, 0, c.width, c.height); s += (await jpegBytes(c, qq)).length; } return s / samples.length; };
    for (const k of [1, 0.8, 0.65, 0.5, 0.4]) {
      if ((await sizeAt(k, 0.4)) > perPage) continue;       // 這個解析度連最低品質都超過
      let lo = 0.4, hi = q, best = 0.4;
      if ((await sizeAt(k, hi)) <= perPage) best = hi;
      else for (let i = 0; i < 5; i++) { const m = (lo + hi) / 2; if ((await sizeAt(k, m)) <= perPage) { best = m; lo = m; } else hi = m; }
      return { dpi: dpi * k, q: best };
    }
    return { dpi: dpi * 0.4, q: 0.4, over: true };
  }

  // ---------- 智慧壓縮：重新壓縮 PDF 內的圖片（保留文字與向量）----------
  const N = n => PDFLib.PDFName.of(n);
  function nameList(ctx, v) {
    v = ctx.lookup(v);
    if (!v) return [];
    if (v instanceof PDFLib.PDFName) return [v.asString()];
    if (v instanceof PDFLib.PDFArray) return v.asArray().map(x => { const y = ctx.lookup(x); return y instanceof PDFLib.PDFName ? y.asString() : '?'; });
    return ['?'];
  }
  function collectImages(out) {
    const ctx = out.context, all = [], skip = new Set();
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFLib.PDFRawStream)) continue;
      const sm = obj.dict.get(N('SMask')), mk = obj.dict.get(N('Mask'));
      if (sm instanceof PDFLib.PDFRef) skip.add(sm.toString());
      if (mk instanceof PDFLib.PDFRef) skip.add(mk.toString());
    }
    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFLib.PDFRawStream) || skip.has(ref.toString())) continue;
      const d = obj.dict, sub = ctx.lookup(d.get(N('Subtype')));
      if (!sub || sub.asString() !== '/Image') continue;
      const im = ctx.lookup(d.get(N('ImageMask')));
      if (im && im.asBoolean && im.asBoolean()) continue;
      if (d.has(N('Decode')) || ctx.lookup(d.get(N('Mask'))) instanceof PDFLib.PDFArray) continue;
      const w = ctx.lookup(d.get(N('Width'))), h = ctx.lookup(d.get(N('Height'))), bpc = ctx.lookup(d.get(N('BitsPerComponent')));
      if (!w || !h || !bpc || bpc.asNumber() !== 8) continue;
      const filters = nameList(ctx, d.get(N('Filter')));
      if (filters.length !== 1 || !['/DCTDecode', '/FlateDecode'].includes(filters[0])) continue;
      let cs = ctx.lookup(d.get(N('ColorSpace'))), comps = 0;
      if (cs instanceof PDFLib.PDFName) comps = { '/DeviceRGB': 3, '/DeviceGray': 1 }[cs.asString()] || 0;
      else if (cs instanceof PDFLib.PDFArray && cs.size() >= 2) {
        const t = ctx.lookup(cs.get(0)), st = ctx.lookup(cs.get(1));
        if (t && t.asString() === '/ICCBased' && st && st.dict) { const n = ctx.lookup(st.dict.get(N('N'))); comps = n && [1, 3].includes(n.asNumber()) ? n.asNumber() : 0; }
      }
      if (!comps) continue;
      const len = obj.contents.length;
      if (len < 8 * 1024) continue;
      all.push({ ref, orig: obj, dct: filters[0] === '/DCTDecode', w: w.asNumber(), h: h.asNumber(), comps, len });
    }
    return all;
  }
  async function decodeImage(c, cache) {
    const key = c.ref.toString();
    if (cache.has(key)) return cache.get(key);
    let src;
    if (c.dct) src = await createImageBitmap(new Blob([c.orig.contents], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    else {
      const raw = PDFLib.decodePDFRawStream(c.orig).decode();
      if (raw.length < c.w * c.h * c.comps) throw new Error('size');
      const im = new ImageData(c.w, c.h), d = im.data;
      for (let i = 0, p = 0, n = c.w * c.h; i < n; i++, p += c.comps) {
        if (c.comps === 3) { d[i * 4] = raw[p]; d[i * 4 + 1] = raw[p + 1]; d[i * 4 + 2] = raw[p + 2]; } else d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = raw[p];
        d[i * 4 + 3] = 255;
      }
      src = await createImageBitmap(im);
    }
    if (cache.budget > 0 && src.width * src.height < cache.budget) { cache.budget -= src.width * src.height; cache.set(key, src); }
    return src;
  }
  function jpegStream(out, orig, bytes, w, h) {
    const ctx = out.context;
    const d = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Length: bytes.length });
    const drop = ['Type', 'Subtype', 'Width', 'Height', 'ColorSpace', 'BitsPerComponent', 'Filter', 'DecodeParms', 'Decode', 'Length', 'DL'];
    for (const [k, v] of orig.dict.entries()) if (!drop.includes(k.asString().slice(1))) d.set(k, v);
    return PDFLib.PDFRawStream.of(d, bytes);
  }
  // 以參數處理所有圖片；回傳位元組變化量（負＝變小）
  async function applyImages(out, cands, prm, cache) {
    let delta = 0, changed = 0;
    for (const c of cands) {
      let stream = c.orig;
      try {
        const long = Math.max(c.w, c.h), k = Math.min(1, prm.maxLong / long);
        const src = await decodeImage(c, cache);
        const w = Math.max(1, Math.round(c.w * k)), h = Math.max(1, Math.round(c.h * k));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        const x = cv.getContext('2d');
        if (prm.gray && 'filter' in x) x.filter = 'grayscale(1)';
        x.imageSmoothingQuality = 'high'; x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
        x.drawImage(src, 0, 0, w, h);
        const bytes = await jpegBytes(cv, prm.q);
        if (bytes.length < c.len * 0.92) { stream = jpegStream(out, c.orig, bytes, w, h); delta += bytes.length - c.len; changed++; }
      } catch { /* 無法處理的圖片維持原狀 */ }
      out.context.assign(c.ref, stream);
    }
    return { delta, changed };
  }
  async function recompress(out, cfg, maxPagePts, ctl) {
    const P = cfg.S.pdf, cands = collectImages(out);
    if (!cands.length) return { changed: 0, total: 0 };
    const target = P.targetMB * 1048576, cache = new Map(); cache.budget = 150e6;
    const dpiMax = P.dpi, qMax = P.quality / 100;
    const prmOf = a => ({ q: qMax - a * (qMax - 0.35), maxLong: Math.round(dpiMax * (1 - 0.55 * a) * maxPagePts / 72), gray: P.gray });
    let a = 0, res;
    if (target > 0) {
      const base = (await out.save({ useObjectStreams: true })).length;
      res = await applyImages(out, cands, prmOf(0), cache);
      let over = base + res.delta > target;
      if (over) {
        res = await applyImages(out, cands, prmOf(1), cache);
        if (base + res.delta > target) { a = 1; ctl.over = true; }
        else {
          let lo = 0, hi = 1; a = 1;
          for (let i = 0; i < 5; i++) { const m = (lo + hi) / 2; res = await applyImages(out, cands, prmOf(m), cache); if (base + res.delta <= target) { a = m; hi = m; } else lo = m; if (ctl.cancelled()) throw new Error('canceled'); }
        }
        res = await applyImages(out, cands, prmOf(a), cache);
      }
    } else res = await applyImages(out, cands, prmOf(0), cache);
    for (const b of cache.values()) b.close();
    return { changed: res.changed, total: cands.length };
  }

  // ---------- 組出 PDF ----------
  // refs: [{doc, pg}]；cfg: {S, wmImg, posFor, onProgress, cancelled}
  async function buildPdf(refs, spec, cfg) {
    await libs();
    const { S, wmImg } = cfg, P = S.pdf, wm = S.wm;
    const out = await PDFLib.PDFDocument.create();
    const srcCache = new Map(), notes = [];
    let wmEmbed = null, font = null, maxPagePts = 1;
    const ctl = { over: false, cancelled: cfg.cancelled };
    const smartMode = !(P.on && P.mode === 'raster');
    let rp = null;                                       // 轉圖片式的參數（延後算）
    const getSrc = async doc => {
      if (srcCache.has(doc.id)) return srcCache.get(doc.id);
      let pdf = null;
      try { pdf = await PDFLib.PDFDocument.load(new Uint8Array(await doc.file.arrayBuffer()), { updateMetadata: false }); }
      catch { notes.push(`${doc.name} 無法以智慧模式處理（可能加密或結構特殊），改用轉圖片式`); }
      srcCache.set(doc.id, pdf); return pdf;
    };
    // 同一個來源檔的頁面要「一次」複製，pdf-lib 才會共用字型/圖片等資源（逐頁複製會讓檔案暴增）
    const copied = new Map();
    const getCopied = async (doc, src) => {
      if (!copied.has(doc.id)) {
        const idx = [...new Set(refs.filter(r => r.doc === doc).map(r => r.pg.i))];
        const pgs = await out.copyPages(src, idx);
        copied.set(doc.id, new Map(idx.map((i, k) => [i, pgs[k]])));
      }
      return copied.get(doc.id);
    };
    if (wm.on && wmImg) wmEmbed = await out.embedPng(await imgBytes(wmImg, 'image/png'));
    if (P.pnOn) font = await out.embedFont(PDFLib.StandardFonts.Helvetica);

    for (let idx = 0; idx < refs.length; idx++) {
      if (cfg.cancelled()) throw new Error('canceled');
      const ref = refs[idx], { doc, pg } = ref;
      const src = doc.kind === 'pdf' && smartMode ? await getSrc(doc) : null;
      if (src) {
        const page = out.addPage((await getCopied(doc, src)).get(pg.i));
        let R = ((page.getRotation().angle || 0) + pg.rot) % 360;
        page.setRotation(PDFLib.degrees(R));
        let b = page.getCropBox();
        const d0 = dispOf(R, b), reg = cropRegion({ ...pg, w: d0.w, h: d0.h, rot: 0 }, spec, cfg.posFor(doc, spec.key));
        if (spec.ratio) {
          const p1 = d2u(R, b, reg.l, reg.t), p2 = d2u(R, b, reg.l + reg.w, reg.t + reg.h);
          const nb = { x: Math.min(p1[0], p2[0]), y: Math.min(p1[1], p2[1]), width: Math.abs(p2[0] - p1[0]), height: Math.abs(p2[1] - p1[1]) };
          page.setMediaBox(nb.x, nb.y, nb.width, nb.height); page.setCropBox(nb.x, nb.y, nb.width, nb.height);
          for (const k of ['TrimBox', 'BleedBox', 'ArtBox']) page.node.delete(N(k));
          b = nb;
        }
        // pdf-lib 的 translate/scale 會作用在整個頁面內容（含之後新增的內容），
        // 所以浮水印、頁碼先以「縮放前」的座標與尺寸繪製，最後再一起縮放。
        const f = scaleFactor(P, dispOf(R, b).w, dispOf(R, b).h);
        const dd = dispOf(R, b);
        if (wmEmbed) {
          const pl = wmPlacement(dd.w, dd.h, wm, { width: wmEmbed.width, height: wmEmbed.height });
          const [ux, uy] = d2u(R, b, pl.cx, pl.cy), th = (R - wm.rot) * Math.PI / 180;
          page.drawImage(wmEmbed, { x: ux - pl.w / 2 * Math.cos(th) + pl.h / 2 * Math.sin(th), y: uy - pl.w / 2 * Math.sin(th) - pl.h / 2 * Math.cos(th), width: pl.w, height: pl.h, rotate: PDFLib.degrees(((R - wm.rot) % 360 + 360) % 360), opacity: wm.opacity / 100 });
        }
        if (font) {
          const size = Math.max(6, P.pnSize) / f, txt = pnText(P, idx, refs.length), tw = font.widthOfTextAtSize(txt, size), m = Math.min(dd.w, dd.h) * 0.04, pos = P.pnPos || 'bc';
          const u = pos[1] === 'l' ? m : pos[1] === 'r' ? dd.w - m - tw : (dd.w - tw) / 2, v = pos[0] === 't' ? m + size * 0.8 : dd.h - m;
          const [ux, uy] = d2u(R, b, u, v);
          page.drawText(txt, { x: ux, y: uy, size, font, color: PDFLib.rgb(0.2, 0.2, 0.2), rotate: PDFLib.degrees(R) });
        }
        if (Math.abs(f - 1) > 1e-6) {
          page.translateContent(-b.x, -b.y);
          page.setMediaBox(0, 0, b.width, b.height); page.setCropBox(0, 0, b.width, b.height);
          page.scale(f, f);
          b = { x: 0, y: 0, width: b.width * f, height: b.height * f };
        }
        maxPagePts = Math.max(maxPagePts, b.width, b.height);
      } else {
        if (!rp) rp = await pickRasterParams(refs, spec, cfg);
        if (rp.over) ctl.over = true;
        const r = await rasterCanvas(ref, spec, cfg, rp.dpi, idx, refs.length);
        const jpg = await out.embedJpg(await jpegBytes(r.cv, P.on ? rp.q : 0.9));
        const page = out.addPage([r.outW, r.outH]);
        page.drawImage(jpg, { x: 0, y: 0, width: r.outW, height: r.outH });
        maxPagePts = Math.max(maxPagePts, r.outW, r.outH);
      }
      cfg.onProgress((idx + 1) / refs.length * (smartMode && P.on ? 0.6 : 1));
      await new Promise(r => setTimeout(r, 0));
    }

    out.setProducer(''); out.setCreator('');
    let stat = null;
    if (smartMode && P.on) {
      stat = await recompress(out, cfg, maxPagePts, ctl);
      cfg.onProgress(0.95);
    }
    const bytes = await out.save({ useObjectStreams: true, updateFieldAppearances: false });
    return { blob: new Blob([bytes], { type: 'application/pdf' }), notes, over: ctl.over || (P.on && P.targetMB > 0 && bytes.length > P.targetMB * 1048576 * 1.08), stat };
  }

  // ---------- PDF 轉圖片 ----------
  async function renderImages(refs, spec, cfg) {
    const { S } = cfg, P = S.pdf, files = [];
    const mime = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[P.imgFmt] || 'image/jpeg';
    for (let idx = 0; idx < refs.length; idx++) {
      if (cfg.cancelled()) throw new Error('canceled');
      const r = await rasterCanvas(refs[idx], spec, cfg, P.imgDpi, idx, refs.length);
      const blob = await new Promise(res => r.cv.toBlob(res, mime, Math.min(0.95, Math.max(0.3, S.pdf.quality / 100))));
      files.push({ blob, ext: P.imgFmt, w: r.cv.width, h: r.cv.height, page: refs[idx].pg.i + 1, idx });
      cfg.onProgress((idx + 1) / refs.length);
      await new Promise(r => setTimeout(r, 0));
    }
    return files;
  }

  return { isPdf, openDoc, dispose, pageDims, keptPages, previewBitmap, thumb, parseRange, describeRange, plan, buildPdf, renderImages, cropRegion };
})();
