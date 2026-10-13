// 介面與流程
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const LS_SET = 'imgtool.settings', LS_PRE = 'imgtool.presets';

  // ---------- 狀態 ----------
  let S = loadSettings();
  let items = [];            // {id, file, name, w, h, thumb, pos:{key:{x,y}}|null}
  let cur = -1, bmp = null, selToken = 0;
  let wmList = [];           // {id, name, blob}
  const wmImgs = {};         // id -> ImageBitmap
  const hiddenKeys = new Set(); // 預覽中隱藏的裁切框
  let dirHandle = null, helper = false;
  let running = false, cancelled = false;
  let G = { s: 1, ox: 0, oy: 0 };

  function loadSettings() {
    try { return prune(DEFAULTS, deepMerge(DEFAULTS, JSON.parse(localStorage.getItem(LS_SET)))); } catch { return deepMerge(DEFAULTS, {}); }
  }
  const save = () => { try { localStorage.setItem(LS_SET, JSON.stringify(S)); } catch { } };
  const E = () => effective(S);
  const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const posOf = (it, key) => (it && it.pos && it.pos[key]) || S.pos[key] || { x: 0.5, y: 0.5, z: 1 };
  const curItem = () => items[cur];
  const curWmImg = () => (S.wm.on && S.wm.id && wmImgs[S.wm.id]) || null;
  const colorOf = k => COLORS[k] || '#fff';

  // 目前預覽中可見的裁切框
  function frames() {
    if (!bmp) return [];
    const it = curItem();
    return E().specs.filter(k => !hiddenKeys.has(k)).map(key => {
      const spec = specFor(key, S), p = posOf(it, key);
      return { key, spec, color: colorOf(key), c: cropRect(bmp.width, bmp.height, spec.ratio, p.x, p.y, p.z) };
    });
  }

  // ---------- 設定綁定 ----------
  function bindSettings() {
    $$('[data-k]').forEach(el => {
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' || el.type === 'color' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        const k = el.dataset.k;
        let v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number' || el.type === 'range') { v = parseFloat(el.value); if (isNaN(v)) return; }
        else v = el.value;
        setPath(S, k, v);
        if (k === 'wm.margin') S.wm.custom = false;
        changed();
      });
    });
  }

  function syncUI() {
    $$('[data-k]').forEach(el => {
      const v = getPath(S, el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    renderRatioList();
    renderWmLib();
    syncDependent();
  }

  function syncDependent() {
    $$('[data-o]').forEach(el => el.textContent = getPath(S, el.dataset.o));
    $$('.card[data-toggle]').forEach(c => c.classList.toggle('on', !!getPath(S, c.dataset.toggle)));
    $$('[data-mode]').forEach(el => el.hidden = el.dataset.mode !== S.resize.mode);
    $('#customRow').hidden = !S.specs.includes('custom');
    $('#ratioList').style.opacity = S.cropOn ? 1 : .5;
    $$('#grid button').forEach((b, i) => b.classList.toggle('on', !S.wm.custom && S.wm.anchor === i));
    renderChips();
    updateWmXY();
    updateNameExample();
    updatePresetBadge();
    updateOutputUI();
  }

  function changed() { save(); syncDependent(); draw(); scheduleEstimate(); updateList(); }

  function renderRatioList() {
    $('#ratioList').innerHTML = RATIOS.map(r =>
      `<label><input type="checkbox" value="${r.key}" ${S.specs.includes(r.key) ? 'checked' : ''}><span class="sw" style="background:${colorOf(r.key)}"></span> ${r.label} <small>${r.note}</small></label>`).join('');
    $$('#ratioList input').forEach(cb => cb.addEventListener('change', () => {
      S.specs = RATIOS.map(r => r.key).filter(k => $$('#ratioList input:checked').some(i => i.value === k));
      changed();
    }));
  }

  function renderChips() {
    const keys = E().specs;
    $('#chips').innerHTML = keys.length ? keys.map(k => `<span class="chip ${hiddenKeys.has(k) ? 'off' : ''}" data-key="${k}" style="--c:${colorOf(k)}" title="點擊顯示/隱藏"><i></i>${specFor(k, S).label}</span>`).join('') : '<span class="muted">（未勾選規格）</span>';
  }

  function buildGrid() {
    const g = $('#grid');
    for (let i = 0; i < 9; i++) {
      const b = document.createElement('button');
      b.textContent = '·';
      b.title = ['左上', '上中', '右上', '左中', '正中', '右中', '左下', '下中', '右下'][i];
      b.addEventListener('click', () => { S.wm.anchor = i; S.wm.custom = false; changed(); });
      g.appendChild(b);
    }
  }

  function updateWmXY() {
    const img = curWmImg(), x = $('#wmX'), y = $('#wmY'), f = frames()[0];
    if (!img || !f) { if (document.activeElement !== x) x.value = ''; if (document.activeElement !== y) y.value = ''; return; }
    const p = wmPlacement(f.c.w, f.c.h, S.wm, img);
    if (document.activeElement !== x) x.value = (p.cx / f.c.w * 100).toFixed(1);
    if (document.activeElement !== y) y.value = (p.cy / f.c.h * 100).toFixed(1);
  }
  function wmXYInput() {
    const x = parseFloat($('#wmX').value), y = parseFloat($('#wmY').value);
    const img = curWmImg(), f = frames()[0];
    if (img && f) { const p = wmPlacement(f.c.w, f.c.h, S.wm, img); if (!S.wm.custom) { S.wm.x = p.cx / f.c.w; S.wm.y = p.cy / f.c.h; } }
    if (!isNaN(x)) S.wm.x = clamp(x / 100, 0, 1);
    if (!isNaN(y)) S.wm.y = clamp(y / 100, 0, 1);
    S.wm.custom = true; save(); draw(); scheduleEstimate(); updatePresetBadge();
    $$('#grid button').forEach(b => b.classList.remove('on'));
  }

  // ---------- 檔案加入 ----------
  const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
  async function addFiles(files) {
    for (const f of files) {
      if (!f || !(f.type.startsWith('image/') || IMG_RE.test(f.name))) continue;
      try {
        const b = await createImageBitmap(f);
        const sc = 96 / Math.max(b.width, b.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(b.width * sc)); c.height = Math.max(1, Math.round(b.height * sc));
        c.getContext('2d').drawImage(b, 0, 0, c.width, c.height);
        items.push({ id: uid(), file: f, name: f.name, w: b.width, h: b.height, thumb: c.toDataURL('image/jpeg', 0.7), pos: null });
        b.close();
      } catch { logMsg(`無法讀取：${f.name}`, true); }
      if (items.length && cur < 0) await select(0);
    }
    updateList();
  }

  // 同步取出 dataTransfer 內容（await 之後 Chrome 會清空），有資料夾才遞迴
  async function filesFromDrop(dt) {
    const direct = [...(dt.files || [])];
    const entries = [...(dt.items || [])].map(i => (i.kind === 'file' && i.webkitGetAsEntry) ? i.webkitGetAsEntry() : null).filter(Boolean);
    if (!entries.some(en => en.isDirectory)) return direct;
    const out = [];
    async function walk(en) {
      if (en.isFile) { const f = await new Promise(r => en.file(r, () => r(null))); if (f) out.push(f); }
      else if (en.isDirectory) {
        const rd = en.createReader();
        for (;;) {
          const batch = await new Promise(r => rd.readEntries(r, () => r([])));
          if (!batch.length) break;
          for (const e of batch) await walk(e);
        }
      }
    }
    for (const e of entries) await walk(e);
    return out;
  }

  function updateList() {
    const n = E().specs.length;
    $('#count').textContent = items.length ? `共 ${items.length} 張 × ${n} 種規格 = ${items.length * n} 個輸出` : '尚未加入圖片';
    $('#list').innerHTML = items.map((it, i) =>
      `<div class="item ${i === cur ? 'sel' : ''}" data-i="${i}"><img src="${it.thumb}"><div class="meta"><div class="nm" title="${it.name}">${it.name}</div><small>${it.w}×${it.h}${it.pos ? ' · 已手動調整' : ''}</small></div><button class="x" data-x="${i}" title="移除">✕</button></div>`).join('');
    $('#empty').hidden = items.length > 0;
  }

  async function select(i) {
    if (i < 0 || i >= items.length) { cur = -1; selToken++; bmp && bmp.close(); bmp = null; draw(); updateList(); return; }
    cur = i;
    const tk = ++selToken;
    const b = await createImageBitmap(items[i].file);
    if (tk !== selToken) { b.close(); return; }
    bmp && bmp.close(); bmp = b;
    updateList(); syncDependent(); draw(); scheduleEstimate();
  }

  // ---------- 預覽繪製 ----------
  const cv = $('#cv'), ctx = cv.getContext('2d');
  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    updateInfo();
    if (!bmp) return;
    const pad = 12, s = Math.min((w - pad * 2) / bmp.width, (h - pad * 2) / bmp.height);
    G = { s, ox: (w - bmp.width * s) / 2, oy: (h - bmp.height * s) / 2 };
    const iw = bmp.width * s, ih = bmp.height * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, G.ox, G.oy, iw, ih);
    const fr = frames(), crops = fr.filter(f => f.spec.ratio);
    if (crops.length) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(G.ox, G.oy, iw, ih);
      for (const f of crops) ctx.drawImage(bmp, f.c.x, f.c.y, f.c.w, f.c.h, G.ox + f.c.x * s, G.oy + f.c.y * s, f.c.w * s, f.c.h * s);
    }
    const wi = curWmImg();
    ctx.font = '12px system-ui, sans-serif'; ctx.textBaseline = 'top';
    for (const f of fr) {
      const cx = G.ox + f.c.x * s, cy = G.oy + f.c.y * s, cw = f.c.w * s, ch = f.c.h * s;
      if (wi) {
        ctx.save();
        ctx.beginPath(); ctx.rect(cx, cy, cw, ch); ctx.clip();
        ctx.translate(cx, cy); ctx.scale(s, s);
        drawWm(ctx, f.c.w, f.c.h, S.wm, wi);
        ctx.restore();
      }
      ctx.strokeStyle = f.color; ctx.lineWidth = 2; ctx.strokeRect(cx, cy, cw, ch);
      if (f.spec.ratio) {
        ctx.fillStyle = '#fff';
        for (const [hx, hy] of [[cx, cy], [cx + cw, cy], [cx, cy + ch], [cx + cw, cy + ch]]) { ctx.fillRect(hx - 5, hy - 5, 10, 10); ctx.strokeRect(hx - 5, hy - 5, 10, 10); }
      }
      const label = f.spec.label.replace('（不裁切）', '');
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = f.color; ctx.fillRect(cx, cy, tw, 18);
      ctx.fillStyle = '#000'; ctx.fillText(label, cx + 5, cy + 3);
    }
    updateWmXY();
  }

  function updateInfo() {
    if (!bmp) { $('#info').textContent = ''; return; }
    const parts = frames().map(f => {
      const p = targetPlan(E().resize, f.c.w, f.c.h);
      return `${f.spec.label.replace('（不裁切）', '')}：${f.c.w}×${f.c.h} → ${p.W}×${p.H}`;
    });
    $('#info').textContent = `${curItem().name} ｜ 原圖 ${bmp.width}×${bmp.height} ｜ ` + (parts.join('　') || '（沒有顯示的裁切框）');
  }

  let estTimer = 0, estTok = 0;
  function scheduleEstimate() {
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      if (!bmp) { $('#estimate').textContent = ''; return; }
      const tk = ++estTok, it = curItem(), e = E(), res = [];
      try {
        for (const f of frames()) {
          const mime = mimeFor(e, it.file);
          const out = renderOutput(bmp, posOf(it, f.key), e, f.spec, curWmImg(), mime);
          const r = await encodeCanvas(out, mime, e);
          if (tk !== estTok) return;
          res.push(`${f.spec.suffix} ${out.width}×${out.height} ${fmtSize(r.blob.size)}${r.over ? '⚠' : ''}`);
        }
        $('#estimate').textContent = res.length ? `此張預估（${EXT[mimeFor(e, it.file)].toUpperCase()}）：${res.join('　｜　')}` : '';
      } catch { }
    }, 350);
  }
  const fmtSize = b => b > 1048576 ? (b / 1048576).toFixed(2) + ' MB' : Math.round(b / 1024) + ' KB';

  // ---------- 預覽拖曳 ----------
  let drag = null;
  const toImg = e => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - G.ox) / G.s, y: (e.clientY - r.top - G.oy) / G.s }; };
  const maxRect = ratio => cropRect(bmp.width, bmp.height, ratio, 0.5, 0.5, 1);
  // 把裁切矩形(圖片座標)存回該規格的 pos（x,y 為可移動範圍內的比例）
  function storeRect(key, x, y, w, h) {
    const m = maxRect(specFor(key, S).ratio), it = curItem();
    const fx = bmp.width - w, fy = bmp.height - h;
    it.pos = { ...(it.pos || {}), [key]: { x: fx > 0 ? clamp(x / fx, 0, 1) : 0.5, y: fy > 0 ? clamp(y / fy, 0, 1) : 0.5, z: clamp(w / m.w, 0.05, 1) } };
  }
  function hitTest(pt) {
    const fr = frames().slice().reverse(), wi = curWmImg(), hr = 10 / G.s;
    // 四角縮放把手
    for (const f of fr) {
      if (!f.spec.ratio) continue;
      const { x, y, w, h } = f.c;
      for (const [cx, cy, dx, dy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]])
        if (Math.abs(pt.x - cx) <= hr && Math.abs(pt.y - cy) <= hr) return { type: 'resize', f, ax: dx > 0 ? x : x + w, ay: dy > 0 ? y : y + h, dx, dy };
    }
    if (wi) for (const f of fr) {
      const p = wmPlacement(f.c.w, f.c.h, S.wm, wi), rx = pt.x - f.c.x, ry = pt.y - f.c.y;
      if (Math.abs(rx - p.cx) <= p.w / 2 && Math.abs(ry - p.cy) <= p.h / 2 && rx >= 0 && ry >= 0 && rx <= f.c.w && ry <= f.c.h) return { type: 'wm', f, ox: rx - p.cx, oy: ry - p.cy };
    }
    for (const f of fr) if (f.spec.ratio && pt.x >= f.c.x && pt.x <= f.c.x + f.c.w && pt.y >= f.c.y && pt.y <= f.c.y + f.c.h) return { type: 'crop', f };
    return null;
  }
  cv.addEventListener('pointerdown', e => {
    if (!bmp) return;
    const pt = toImg(e), h = hitTest(pt);
    if (!h) return;
    drag = { ...h, sx: pt.x, sy: pt.y, pos: { ...posOf(curItem(), h.f.key) } };
    cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing';
  });
  cv.addEventListener('pointermove', e => {
    if (!bmp) return;
    const pt = toImg(e);
    if (!drag) {
      const h = hitTest(pt);
      cv.style.cursor = !h ? '' : h.type === 'resize' ? (h.dx * h.dy > 0 ? 'nwse-resize' : 'nesw-resize') : 'grab';
      return;
    }
    const c = drag.f.c;
    if (drag.type === 'resize') {
      const ratio = drag.f.spec.ratio, m = maxRect(ratio), { ax, ay, dx, dy } = drag;
      const limit = Math.min(dx > 0 ? bmp.width - ax : ax, (dy > 0 ? bmp.height - ay : ay) * ratio, m.w);
      const nw = clamp(Math.max(Math.abs(pt.x - ax), Math.abs(pt.y - ay) * ratio), m.w * 0.05, limit);
      const nh = nw / ratio;
      storeRect(drag.f.key, dx > 0 ? ax : ax - nw, dy > 0 ? ay : ay - nh, Math.round(nw), Math.round(nh));
      draw();
    } else if (drag.type === 'wm') {
      S.wm.custom = true;
      S.wm.x = clamp((pt.x - c.x - drag.ox) / c.w, 0, 1);
      S.wm.y = clamp((pt.y - c.y - drag.oy) / c.h, 0, 1);
      draw();
    } else {
      const fx = bmp.width - c.w, fy = bmp.height - c.h, np = { ...drag.pos };
      if (fx > 0) np.x = clamp((c.x + pt.x - drag.sx) / fx, 0, 1);
      if (fy > 0) np.y = clamp((c.y + pt.y - drag.sy) / fy, 0, 1);
      const it = curItem(); it.pos = { ...(it.pos || {}), [drag.f.key]: np };
      draw();
    }
  });
  const endDrag = () => { if (!drag) return; const t = drag.type; drag = null; cv.style.cursor = ''; save(); if (t !== 'wm') updateList(); syncDependent(); scheduleEstimate(); };
  // 滾輪：在裁切框上縮放（以框中心為準）
  cv.addEventListener('wheel', e => {
    if (!bmp) return;
    const h = hitTest(toImg(e));
    if (!h || !h.f.spec.ratio) return;
    e.preventDefault();
    const { x, y, w, h: ch } = h.f.c, m = maxRect(h.f.spec.ratio);
    const nw = clamp(w * (e.deltaY < 0 ? 0.94 : 1 / 0.94), m.w * 0.05, m.w), nh = nw * ch / w;
    const cx = x + w / 2, cy = y + ch / 2;
    storeRect(h.f.key, clamp(cx - nw / 2, 0, bmp.width - nw), clamp(cy - nh / 2, 0, bmp.height - nh), Math.round(nw), Math.round(nh));
    draw(); save(); updateList(); syncDependent(); scheduleEstimate();
  }, { passive: false });
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  new ResizeObserver(draw).observe($('#stage'));

  // ---------- 浮水印圖庫 ----------
  async function loadWmLib() {
    wmList = await DB.wmAll();
    for (const w of wmList) { try { wmImgs[w.id] = await createImageBitmap(w.blob); } catch { } }
    renderWmLib();
  }
  function renderWmLib() {
    $('#wmLib').innerHTML = wmList.length ? wmList.map(w => `<div class="wmItem ${w.id === S.wm.id ? 'sel' : ''}" data-id="${w.id}" title="${w.name}"><img src="${URL.createObjectURL(w.blob)}"><b data-del="${w.id}">×</b></div>`).join('') : '<small class="muted">尚無浮水印，請上傳（建議透明背景 PNG）</small>';
  }
  async function addWm(file, id) {
    const b = await createImageBitmap(file);
    const rec = { id: id || uid(), name: file.name || 'watermark', blob: file };
    wmImgs[rec.id] = b; wmList.push(rec); await DB.wmPut(rec);
    return rec;
  }

  // ---------- 檔名 ----------
  const safe = s => s.replace(/[\\/:*?"<>|]/g, '_');
  const z2 = n => String(n).padStart(2, '0');
  function makeBase(tpl, ctx) {
    const d = new Date();
    const v = { ...ctx, date: `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}`, time: `${z2(d.getHours())}${z2(d.getMinutes())}${z2(d.getSeconds())}` };
    return safe(tpl.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m)) || 'image';
  }
  const padN = (n, p) => String(n).padStart(p, '0');
  function updateNameExample() {
    const it = curItem() || { name: 'photo.jpg' }, e = E(), key = e.specs[0] || 'orig', spec = specFor(key, S);
    const mime = mimeFor(e, it.file);
    const nm = makeBase(S.out.tpl, { name: it.name.replace(/\.[^.]+$/, ''), ratio: spec.suffix, w: 1080, h: 1350, n: padN(S.out.seqStart, S.out.seqPad), i: padN(1, S.out.seqPad) });
    $('#nameEx').textContent = `範例：${nm}.${EXT[mime]}`;
  }

  // ---------- 輸出 ----------
  function logMsg(t, err) {
    const l = $('#log'); l.hidden = false;
    const d = document.createElement('div'); if (err) d.className = 'err'; d.textContent = t; l.appendChild(d); l.scrollTop = l.scrollHeight;
  }
  const API = (p, opt = {}) => fetch(p, { method: 'POST', ...opt, headers: { 'X-Imgtool': '1', ...(opt.headers || {}) } }).then(r => r.json());
  async function detectHelper() {
    if (!location.protocol.startsWith('http')) return false;
    try { const r = await fetch('/api/ping', { headers: { 'X-Imgtool': '1' } }); return (await r.json()).ok === true; } catch { return false; }
  }
  function updateOutputUI() {
    const path = $('#outPath');
    path.disabled = !helper; $('#btnBrowse').hidden = !helper;
    path.placeholder = helper ? '貼上資料夾路徑，如 D:\\輸出' : '需用「啟動.bat」開啟才能貼路徑';
    $('#helperNote').textContent = helper
      ? '已連線本機輔助程式：可貼上任意路徑（資料夾不存在會自動建立）。路徑留空則用下方方式/下載。'
      : '目前是純網頁模式（雙擊 index.html）：瀏覽器不允許網頁直接寫入任意路徑。想貼路徑與開啟資料夾，請改用「啟動.bat」開啟；或用下方「用瀏覽器選資料夾」，再不然完成後會自動下載。';
    $('#dirRow').hidden = helper && !!S.out.path.trim();
    $('#btnOpenDir').disabled = !(helper && S.out.path.trim());
    $('#btnOpenDir').title = $('#btnOpenDir').disabled ? '需用「啟動.bat」開啟並設定輸出路徑' : '';
  }
  function showDir() {
    $('#dirName').textContent = dirHandle ? `已選資料夾：${dirHandle.name}` : (window.showDirectoryPicker ? '未選擇資料夾：完成後自動下載（多張打包 ZIP）' : '此瀏覽器：完成後自動下載（多張打包 ZIP）');
  }
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  // 決定不重複的檔名；回傳 null 代表略過
  async function uniqueName(base, ext, dh, used) {
    for (let n = 0; ; n++) {
      const name = n ? `${base} (${n}).${ext}` : `${base}.${ext}`, key = name.toLowerCase();
      const inRun = used.has(key);
      let exists = inRun;
      if (dh && !inRun) { try { await dh.getFileHandle(name); exists = true; } catch { exists = false; } }
      if (!exists) { used.add(key); return name; }
      if (!inRun && S.out.conflict === 'overwrite') { used.add(key); return name; }
      if (!inRun && S.out.conflict === 'skip') return null;
    }
  }

  async function run() {
    if (running) return;
    const e = E();
    if (!items.length) { alert('請先加入圖片'); return; }
    if (!e.specs.length) { alert('請至少勾選一種裁切規格，或關閉「比例裁切」'); return; }
    if (S.wm.on && !curWmImg()) { alert('已啟用浮水印，但尚未選擇浮水印圖片'); return; }
    const outPath = S.out.path.trim();
    const useHelper = helper && !!outPath;
    let dh = null;
    if (!useHelper && dirHandle) {
      try {
        let p = await dirHandle.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted') p = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (p === 'granted') dh = dirHandle; else { alert('未取得輸出資料夾的寫入權限'); return; }
      } catch { alert('輸出資料夾無法使用，請重新選擇'); return; }
    }
    running = true; cancelled = false;
    $('#btnStart').disabled = true; $('#btnCancel').hidden = false; $('#progressWrap').hidden = false; $('#log').innerHTML = '';
    const wmImg = curWmImg(), used = new Set(), collected = [];
    const total = items.length * e.specs.length;
    let done = 0, fail = 0, skipped = 0, over = 0, saved = 0, seq = S.out.seqStart, fatal = false;
    for (let ii = 0; ii < items.length && !cancelled && !fatal; ii++) {
      const it = items[ii];
      let b;
      try {
        b = await createImageBitmap(it.file);
        for (const key of e.specs) {
          if (cancelled) break;
          const spec = specFor(key, S), mime = mimeFor(e, it.file);
          const out = renderOutput(b, posOf(it, key), e, spec, wmImg, mime);
          const r = await encodeCanvas(out, mime, e);
          if (r.over) over++;
          const base = makeBase(S.out.tpl, { name: it.name.replace(/\.[^.]+$/, ''), ratio: spec.suffix, w: out.width, h: out.height, n: padN(seq++, S.out.seqPad), i: padN(ii + 1, S.out.seqPad) });
          const ext = EXT[mime];
          if (useHelper) {
            const want = `${base}.${ext}`, inRun = used.has(want.toLowerCase());
            const q = new URLSearchParams({ dir: outPath, name: want, conflict: inRun ? 'rename' : S.out.conflict });
            const j = await API('/api/write?' + q, { body: r.blob });
            if (j.error) { logMsg(j.error, true); fatal = true; break; }
            if (j.skipped) skipped++; else { used.add(j.name.toLowerCase()); saved++; }
          } else {
            const name = await uniqueName(base, ext, dh, used);
            if (name === null) skipped++;
            else if (dh) { const fh = await dh.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(r.blob); await w.close(); saved++; }
            else { collected.push({ name, blob: r.blob }); saved++; }
          }
          done++;
          $('#bar').style.width = (done / total * 100) + '%';
          $('#progressText').textContent = `${done} / ${total}`;
          await new Promise(r => setTimeout(r, 0));
        }
      } catch (err) {
        fail++; logMsg(`失敗：${it.name}（${err.message || err}）`, true);
      } finally { b && b.close(); }
    }
    if (!useHelper && !dh && collected.length) {
      if (collected.length === 1) download(collected[0].blob, collected[0].name);
      else {
        const d = new Date();
        download(await Zip.build(collected), `圖片輸出_${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}-${z2(d.getHours())}${z2(d.getMinutes())}.zip`);
      }
    }
    const where = useHelper ? `（已存到 ${outPath}）` : dh ? `（已存入資料夾：${dh.name}）` : '（已下載）';
    logMsg(`${fatal ? '已中止' : cancelled ? '已取消' : '完成'}：輸出 ${saved} 個${skipped ? `，略過 ${skipped}` : ''}${fail ? `，失敗 ${fail} 張` : ''}${over ? `，${over} 個仍超過大小上限` : ''}${where}`, fail > 0 || fatal);
    running = false; $('#btnStart').disabled = false; $('#btnCancel').hidden = true;
    setTimeout(() => { $('#progressWrap').hidden = true; $('#bar').style.width = '0'; $('#progressText').textContent = ''; }, 2500);
  }

  // ---------- 預設 ----------
  const getPresets = () => { try { return JSON.parse(localStorage.getItem(LS_PRE)) || {}; } catch { return {}; } };
  const putPresets = p => { try { localStorage.setItem(LS_PRE, JSON.stringify(p)); } catch { } };
  const norm = o => JSON.stringify(prune(DEFAULTS, deepMerge(DEFAULTS, o)));
  function renderPresets() {
    const names = Object.keys(getPresets());
    $('#presetSel').innerHTML = names.length ? names.map(n => `<option>${n}</option>`).join('') : '<option value="">（尚無預設）</option>';
    updatePresetBadge();
  }
  // 目前設定與某個預設完全一致才顯示名稱；改過任何設定就不顯示
  function updatePresetBadge() {
    const cur = norm(S), p = getPresets();
    const name = Object.keys(p).find(n => norm(p[n]) === cur);
    const b = $('#presetBadge');
    b.hidden = !name; if (name) b.textContent = `目前使用：${name}`;
  }
  const blobToDataURL = b => new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });

  // ---------- 事件 ----------
  function wire() {
    $('#dropzone').addEventListener('click', () => $('#fileInput').click());
    $('#btnAddFiles').addEventListener('click', () => $('#fileInput').click());
    $('#btnAddDir').addEventListener('click', () => $('#dirInput').click());
    $('#fileInput').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; await addFiles(fs); });
    $('#dirInput').addEventListener('change', async e => { const fs = [...e.target.files]; e.target.value = ''; await addFiles(fs); });

    let dc = 0;
    const hasFiles = e => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    document.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dc++; document.body.classList.add('dragging'); });
    document.addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dc <= 0) { dc = 0; document.body.classList.remove('dragging'); } });
    document.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    document.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault(); dc = 0; document.body.classList.remove('dragging');
      const p = filesFromDrop(e.dataTransfer);   // 同步階段先取出資料
      p.then(addFiles).catch(err => logMsg('拖曳加入失敗：' + (err.message || err), true));
    });

    $('#list').addEventListener('click', async e => {
      const x = e.target.closest('[data-x]');
      if (x) {
        const i = +x.dataset.x; items.splice(i, 1);
        if (!items.length) await select(-1); else await select(Math.min(cur > i ? cur - 1 : cur, items.length - 1));
        updateList(); return;
      }
      const it = e.target.closest('.item'); if (it) select(+it.dataset.i);
    });
    $('#btnSort').addEventListener('click', () => { const c = items[cur]; items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); cur = items.indexOf(c); updateList(); });
    $('#btnClear').addEventListener('click', async () => { if (items.length && confirm('清空圖片清單？')) { items = []; await select(-1); } });
    $('#btnPrev').addEventListener('click', () => select(cur - 1));
    $('#btnNext').addEventListener('click', () => select(cur + 1));
    $('#chips').addEventListener('click', e => {
      const c = e.target.closest('.chip'); if (!c) return;
      const k = c.dataset.key; hiddenKeys.has(k) ? hiddenKeys.delete(k) : hiddenKeys.add(k);
      renderChips(); draw(); scheduleEstimate();
    });
    $('#btnCenter').addEventListener('click', () => { const it = curItem(); if (!it) return; it.pos = {}; E().specs.forEach(k => it.pos[k] = { x: 0.5, y: 0.5, z: 1 }); updateList(); draw(); scheduleEstimate(); });
    $('#btnApplyAll').addEventListener('click', () => {
      const it = curItem(); if (!it) return;
      E().specs.forEach(k => { S.pos[k] = { ...posOf(it, k) }; });
      items.forEach(i => i.pos = null); save(); updateList(); draw(); scheduleEstimate(); updatePresetBadge();
    });

    $('#wmX').addEventListener('input', wmXYInput);
    $('#wmY').addEventListener('input', wmXYInput);
    $('#btnWmUpload').addEventListener('click', () => $('#wmInput').click());
    $('#wmInput').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { const r = await addWm(f); S.wm.id = r.id; S.wm.on = true; syncUI(); changed(); } catch { alert('無法讀取這張圖片'); }
    });
    $('#wmLib').addEventListener('click', async e => {
      const d = e.target.closest('[data-del]');
      if (d) {
        const id = d.dataset.del; await DB.wmDel(id); wmList = wmList.filter(w => w.id !== id); wmImgs[id] && wmImgs[id].close(); delete wmImgs[id];
        if (S.wm.id === id) S.wm.id = null; renderWmLib(); changed(); return;
      }
      const w = e.target.closest('.wmItem'); if (w) { S.wm.id = w.dataset.id; S.wm.on = true; syncUI(); changed(); }
    });

    $('#tokens').addEventListener('click', e => {
      const b = e.target.closest('[data-tok]'); if (!b) return;
      const t = $('#tpl'), s = t.selectionStart ?? t.value.length, en = t.selectionEnd ?? s;
      t.value = t.value.slice(0, s) + `{${b.dataset.tok}}` + t.value.slice(en);
      t.focus(); t.selectionStart = t.selectionEnd = s + b.dataset.tok.length + 2;
      t.dispatchEvent(new Event('input'));
    });

    $('#btnDir').addEventListener('click', async () => {
      if (!window.showDirectoryPicker) { alert('此瀏覽器不支援直接選資料夾，處理完成後會自動下載（多張時打包成 ZIP）。建議電腦使用 Chrome 或 Edge。'); return; }
      try { dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); await DB.kvPut('outDir', dirHandle); showDir(); } catch { }
    });
    $('#btnDirClear').addEventListener('click', async () => { dirHandle = null; await DB.kvDel('outDir'); showDir(); });
    $('#btnBrowse').addEventListener('click', async () => {
      const b = $('#btnBrowse'); b.disabled = true; b.textContent = '請在彈出視窗選擇…';
      try { const j = await API('/api/pick'); if (j.path) { S.out.path = j.path; syncUI(); changed(); } else if (j.error) alert(j.error); } catch { alert('無法開啟選擇視窗，請直接貼上路徑'); }
      b.disabled = false; b.textContent = '瀏覽…';
    });
    $('#btnOpenDir').addEventListener('click', async () => {
      try { const j = await API('/api/open?' + new URLSearchParams({ dir: S.out.path.trim() })); if (j.error) alert(j.error); } catch { alert('無法開啟資料夾'); }
    });
    $('#btnStart').addEventListener('click', run);
    $('#btnCancel').addEventListener('click', () => { cancelled = true; });

    $('#btnPresetSave').addEventListener('click', () => {
      const n = $('#presetName').value.trim(); if (!n) { alert('請輸入預設名稱'); return; }
      const p = getPresets();
      if (p[n] && !confirm(`預設「${n}」已存在，要覆蓋嗎？`)) return;
      p[n] = JSON.parse(JSON.stringify(S)); putPresets(p); renderPresets(); $('#presetSel').value = n;
    });
    $('#btnPresetLoad').addEventListener('click', () => {
      const n = $('#presetSel').value, p = getPresets()[n]; if (!p) return;
      S = prune(DEFAULTS, deepMerge(DEFAULTS, p)); if (S.wm.id && !wmImgs[S.wm.id]) S.wm.id = null;
      items.forEach(i => i.pos = null);
      $('#presetName').value = n; syncUI(); changed();
    });
    $('#btnPresetDel').addEventListener('click', () => {
      const n = $('#presetSel').value; if (!n || !confirm(`刪除預設「${n}」？`)) return;
      const p = getPresets(); delete p[n]; putPresets(p); renderPresets();
    });
    $('#btnExport').addEventListener('click', async () => {
      const wms = []; for (const w of wmList) wms.push({ id: w.id, name: w.name, data: await blobToDataURL(w.blob) });
      download(new Blob([JSON.stringify({ app: 'imgtool', settings: S, presets: getPresets(), watermarks: wms })], { type: 'application/json' }), '圖片工具設定.json');
    });
    $('#btnImport').addEventListener('click', () => $('#importInput').click());
    $('#importInput').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try {
        const j = JSON.parse(await f.text());
        if (j.app !== 'imgtool') throw 0;
        for (const w of j.watermarks || []) if (!wmImgs[w.id]) { const b = await (await fetch(w.data)).blob(); await addWm(new File([b], w.name, { type: b.type }), w.id); }
        putPresets({ ...getPresets(), ...(j.presets || {}) });
        if (j.settings) S = prune(DEFAULTS, deepMerge(DEFAULTS, j.settings));
        renderPresets(); syncUI(); changed(); alert('匯入完成');
      } catch { alert('無法匯入，請確認是本工具匯出的設定檔'); }
    });
  }

  // ---------- 介面主題 ----------
  function setTheme(t) {
    try { localStorage.setItem('imgtool.theme', t); } catch { }
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    $$('#themeBar button').forEach(b => b.classList.toggle('on', b.dataset.theme === t));
  }
  function initTheme() {
    let t = 'auto'; try { t = localStorage.getItem('imgtool.theme') || 'auto'; } catch { }
    setTheme(t);
    $('#themeBar').addEventListener('click', e => { const b = e.target.closest('[data-theme]'); if (b) setTheme(b.dataset.theme); });
  }

  // ---------- 初始化 ----------
  (async function init() {
    initTheme();
    buildGrid(); bindSettings(); wire();
    helper = await detectHelper();
    await loadWmLib();
    try { dirHandle = await DB.kvGet('outDir'); } catch { }
    showDir(); renderPresets(); syncUI(); updateList(); draw();
  })();
})();
