// 介面與流程
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const LS_SET = 'imgtool.settings', LS_PRE = 'imgtool.presets';

  // ---------- 狀態 ----------
  let S = loadSettings();
  let items = [];            // {id, file, name, w, h, thumb, pos:{key:{x,y}}|null}
  let cur = -1, bmp = null, selToken = 0;
  let mode = 'image';        // 'image' | 'video'：兩種模式各有自己的檔案清單
  const modeState = { image: { items: [], cur: -1 }, video: { items: [], cur: -1 }, pdf: { items: [], cur: -1 } };
  let wmList = [];           // {id, name, blob}
  const wmImgs = {};         // id -> ImageBitmap
  const hiddenKeys = new Set(); // 預覽中隱藏的裁切框
  let dirHandle = null;
  let running = false, cancelled = false;
  const vHolder = { conv: null };
  let G = { s: 1, ox: 0, oy: 0 };

  function loadSettings() {
    try { return prune(DEFAULTS, deepMerge(DEFAULTS, JSON.parse(localStorage.getItem(LS_SET)))); } catch { return deepMerge(DEFAULTS, {}); }
  }
  const save = () => { try { localStorage.setItem(LS_SET, JSON.stringify(S)); } catch { } };
  const E = () => effective(S, mode);
  const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
  const setPath = (o, p, v) => { const ks = p.split('.'); const l = ks.pop(); ks.reduce((a, k) => a[k], o)[l] = v; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const posOf = (it, key) => (it && it.pos && it.pos[key]) || S.pos[key] || { x: 0.5, y: 0.5, z: 1 };
  const curItem = () => items[cur];
  let textWm = { key: '', cv: null };
  function textWmCanvas() {
    const t = (S.wm.text || '').trim();
    if (!t) return null;
    const key = t + '|' + S.wm.color;
    if (textWm.key !== key) {
      const fs = 160, c = document.createElement('canvas'), x = c.getContext('2d'), font = `bold ${fs}px "Microsoft JhengHei", "PingFang TC", sans-serif`;
      x.font = font;
      c.width = Math.ceil(x.measureText(t).width + fs * 0.4); c.height = Math.ceil(fs * 1.4);
      x.font = font; x.fillStyle = S.wm.color; x.textBaseline = 'middle';
      x.shadowColor = 'rgba(0,0,0,.35)'; x.shadowBlur = fs * 0.06;
      x.fillText(t, fs * 0.2, c.height / 2);
      textWm = { key, cv: c };
    }
    return textWm.cv;
  }
  const curWmImg = () => (!S.wm.on ? null : S.wm.src === 'text' ? textWmCanvas() : ((S.wm.id && wmImgs[S.wm.id]) || null));
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
        const sub = k.startsWith('wm.') ? k.slice(3) : null;
        if (sub && WM_GEOM.includes(sub)) setWm(sub === 'margin' ? { margin: v, custom: false } : { [sub]: v });
        else setPath(S, k, v);
        changed();
      });
    });
  }

  function syncUI() {
    $$('[data-k]').forEach(el => {
      const v = getVal(el.dataset.k);
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    });
    renderRatioList();
    renderWmLib();
    syncDependent();
  }

  function syncDependent() {
    $$('[data-o]').forEach(el => el.textContent = getVal(el.dataset.o));
    $$('.card[data-toggle]').forEach(c => c.classList.toggle('on', !!getPath(S, c.dataset.toggle)));
    $$('[data-mode]').forEach(el => el.hidden = el.dataset.mode !== S.resize.mode);
    $$('[data-pres]').forEach(el => el.hidden = el.dataset.pres !== S.pdf.resMode);
    $$('[data-pmode]').forEach(el => el.hidden = el.dataset.pmode !== S.pdf.mode);
    $$('[data-pout]').forEach(el => el.hidden = el.dataset.pout !== S.pdf.out);
    $$('[data-wmsrc]').forEach(el => el.hidden = el.dataset.wmsrc !== S.wm.src);
    $$('[data-pn]').forEach(el => el.hidden = !S.pdf.pnOn);
    $('#dpiPreset').value = String(S.pdf.dpi);
    $('#customRow').hidden = !S.specs.includes('custom');
    $('#ratioList').style.opacity = S.cropOn ? 1 : .5;
    syncWmControls();
    syncWmScopeUI();
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
      b.addEventListener('click', () => { setWm({ anchor: i, custom: false }); changed(); });
      g.appendChild(b);
    }
  }

  function updateWmXY() {
    const img = curWmImg(), x = $('#wmX'), y = $('#wmY'), f = frames()[0];
    if (!img || !f) { if (document.activeElement !== x) x.value = ''; if (document.activeElement !== y) y.value = ''; return; }
    const p = wmPlacement(f.c.w, f.c.h, wmView(), img);
    if (document.activeElement !== x) x.value = (p.cx / f.c.w * 100).toFixed(1);
    if (document.activeElement !== y) y.value = (p.cy / f.c.h * 100).toFixed(1);
  }
  function wmXYInput() {
    const x = parseFloat($('#wmX').value), y = parseFloat($('#wmY').value);
    const img = curWmImg(), f = frames()[0], v = wmView(), patch = { custom: true };
    if (img && f && !v.custom) { const p = wmPlacement(f.c.w, f.c.h, v, img); patch.x = p.cx / f.c.w; patch.y = p.cy / f.c.h; }
    if (!isNaN(x)) patch.x = clamp(x / 100, 0, 1);
    if (!isNaN(y)) patch.y = clamp(y / 100, 0, 1);
    setWm(patch); save(); draw(); scheduleEstimate(); updatePresetBadge();
    $$('#grid button').forEach(b => b.classList.remove('on'));
  }

  // ---------- 浮水印：個別／多選設定（圖片模式）----------
  // 全域設定在 S.wm；每個檔案可有個別覆寫 it.wm（位置、大小、透明度、旋轉，或 skip＝不加浮水印）
  const WM_GEOM = ['anchor', 'custom', 'margin', 'x', 'y', 'size', 'opacity', 'rot'];
  const selIds = new Set();
  let selAnchor = -1, wmScope = 'all';
  const wmFor = it => (it && it.wm ? { ...S.wm, ...it.wm } : S.wm);
  const wmOff = it => !!(it && it.wm && it.wm.skip);
  const eW = (it, e) => ({ ...e, wm: { ...wmFor(it), on: S.wm.on && !wmOff(it) } });
  function scopeTargets() {
    if (mode !== 'image' || wmScope !== 'sel') return null;
    const t = items.filter(i => selIds.has(i.id));
    return t.length ? t : (curItem() ? [curItem()] : null);
  }
  const wmView = () => (scopeTargets() ? wmFor(curItem()) : S.wm);
  function setWm(patch) {
    const t = scopeTargets();
    if (t) t.forEach(it => { it.wm = { ...(it.wm || {}), ...patch }; });
    else Object.assign(S.wm, patch);
  }
  const getVal = k => (k.startsWith('wm.') && WM_GEOM.includes(k.slice(3)) ? wmView()[k.slice(3)] : getPath(S, k));
  function syncWmControls() {
    const v = wmView();
    $$('[data-k^="wm."]').forEach(el => { const s = el.dataset.k.slice(3); if (WM_GEOM.includes(s)) el.value = v[s]; });
    $$('[data-o^="wm."]').forEach(el => { const s = el.dataset.o.slice(3); if (WM_GEOM.includes(s)) el.textContent = v[s]; });
    $$('#grid button').forEach((b, i) => b.classList.toggle('on', !v.custom && v.anchor === i));
  }
  function syncWmScopeUI() {
    const t = scopeTargets(), nOv = items.filter(i => i.wm).length;
    $$('[data-scope]').forEach(b => b.classList.toggle('on', b.dataset.scope === wmScope));
    $('#selCount').textContent = selIds.size;
    $('#wmOvRow').hidden = mode !== 'image' || !(t || nOv);
    $('#btnWmSkip').hidden = !t;
    if (t) $('#btnWmSkip').textContent = t.every(wmOff) ? '恢復加浮水印' : '選取的檔案不加浮水印';
    $('#btnWmReset').textContent = t ? '選取的檔案還原為統一設定' : `清除所有個別設定（${nOv}）`;
    $('#btnWmReset').hidden = !(t ? t.some(i => i.wm) : nOv);
    $('#wmScopeNote').textContent = t ? `目前調整的是「選取的 ${t.length} 個檔案」，其他檔案不受影響。` : (nOv ? `有 ${nOv} 個檔案使用個別設定，不受「全部檔案」的位置／大小調整影響。` : '');
  }
  function selectRow(i, e) {
    const it = items[i]; if (!it) return;
    if (e.shiftKey && selAnchor >= 0) { const a = Math.min(selAnchor, i), b = Math.max(selAnchor, i); selIds.clear(); items.slice(a, b + 1).forEach(x => selIds.add(x.id)); }
    else if (e.ctrlKey || e.metaKey) { selIds.has(it.id) ? selIds.delete(it.id) : selIds.add(it.id); selAnchor = i; }
    else { selIds.clear(); selIds.add(it.id); selAnchor = i; }
    if (selIds.size >= 2) wmScope = 'sel';
  }
  function refreshSel() { updateList(); syncDependent(); draw(); scheduleEstimate(); }

  // ---------- 檔案加入 ----------
  const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
  const fmtDur = s => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  async function addFiles(files) {
    let wrong = 0;
    for (const f of files) {
      if (!f) continue;
      const vid = Media.isVideo(f), pdf = Pdf.isPdf(f), img = !vid && !pdf && (f.type.startsWith('image/') || IMG_RE.test(f.name));
      if (!vid && !pdf && !img) continue;
      if ((mode === 'image' && (vid || pdf)) || (mode === 'video' && (img || pdf)) || (mode === 'pdf' && vid)) { wrong++; continue; }
      if (mode === 'pdf') await addPdfDoc(f); else if (vid) await addVideo(f); else await addImage(f);
      if (items.length && cur < 0) await select(0);
    }
    if (wrong) logMsg(`已略過 ${wrong} 個不屬於「${MODE_NAME[mode]}」模式的檔案，請從右上角切換模式後再加入。`, true);
    updateList();
  }
  async function addImage(f) {
    try {
      let file = f, b;
      try { b = await createImageBitmap(f); }
      catch (err) {
        if (!Media.isHeic(f)) throw err;
        $('#count').textContent = `轉換 HEIC：${f.name} …`;
        file = await Media.heicToJpeg(f); b = await createImageBitmap(file);
      }
      const sc = 96 / Math.max(b.width, b.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(b.width * sc)); c.height = Math.max(1, Math.round(b.height * sc));
      c.getContext('2d').drawImage(b, 0, 0, c.width, c.height);
      items.push({ id: uid(), kind: 'image', file, name: f.name, w: b.width, h: b.height, thumb: c.toDataURL('image/jpeg', 0.7), pos: null });
      b.close();
    } catch { logMsg(`無法讀取：${f.name}${Media.isHeic(f) ? '（HEIC 轉換失敗）' : ''}`, true); }
  }
  async function addVideo(f) {
    $('#count').textContent = `讀取影片：${f.name} …`;
    try {
      const v = await Media.probeVideo(f);
      items.push({ id: uid(), kind: 'video', file: f, name: f.name, w: v.w, h: v.h, thumb: v.thumb, pos: null, dur: v.dur, t0: v.t0, rate: v.rate, hasAudio: v.hasAudio, audioBps: v.audioBps, tPrev: 0 });
    } catch (err) { const m = String(err.message || err); logMsg(`無法加入影片 ${f.name}：${/unsupported or unrecognizable|Invalid|corrupt/i.test(m) ? '檔案格式無法辨識或已損毀' : m}`, true); }
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

  // 上一個／下一個：PDF 模式切換頁面（到頭換檔案），其他模式切換檔案
  async function step(dir) {
    if (mode !== 'pdf') { const j = cur + dir; if (j >= 0 && j < items.length) await select(j); return; }
    const d = curItem(); if (!d) return;
    let j = (d.curPage || 0) + dir;
    while (j >= 0 && j < d.pages.length && d.pages[j].del) j += dir;
    if (j >= 0 && j < d.pages.length) { d.curPage = j; await select(cur); return; }
    let i = cur + dir;
    while (i >= 0 && i < items.length && !Pdf.keptPages(items[i]).length) i += dir;
    if (i < 0 || i >= items.length) return;
    const nd = items[i], kept = nd.pages.map((p, k) => k).filter(k => !nd.pages[k].del);
    nd.curPage = dir > 0 ? kept[0] : kept[kept.length - 1]; nd.open = true;
    await select(i);
  }

  // ---------- PDF 清單 ----------
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const MODE_NAME = { image: '圖片', video: '影片', pdf: 'PDF' };
  async function addPdfDoc(f) {
    $('#count').textContent = `讀取：${f.name} …`;
    try {
      const d = await Pdf.openDoc(f, (name, wrong) => prompt(`「${name}」需要密碼${wrong ? '（密碼錯誤，請重試）' : ''}：`));
      const it = { id: uid(), file: f, name: f.name, base: f.name.replace(/\.[^.]+$/, ''), ...d, thumb: '', pos: null, open: items.length === 0, curPage: 0 };
      it.thumb = await Pdf.thumb(it, it.pages[0]);
      it.pages[0].thumb = it.thumb;
      items.push(it);
    } catch (err) { logMsg(`無法讀取 ${f.name}：${err && err.name === 'PasswordException' ? '需要密碼或密碼錯誤' : (err.message || err)}`, true); }
  }
  function updatePdfList() {
    let kept = 0, total = 0;
    items.forEach(d => { kept += Pdf.keptPages(d).length; total += d.pages.length; });
    const n = E().specs.length;
    $('#count').textContent = items.length ? `共 ${items.length} 個檔案，保留 ${kept} / ${total} 頁 × ${n} 種規格` : '尚未加入檔案';
    $('#pageTools').hidden = !items.length;
    const cd = curItem(); $('#pageToolsTitle').textContent = cd ? `頁面：${cd.name}` : '目前檔案頁面';
    $('#list').innerHTML = items.map((d, i) => {
      const k = Pdf.keptPages(d).length;
      const row = `<div class="docrow"><button class="tg" data-tg="${i}" title="展開/收合頁面">${d.open ? '▾' : '▸'}</button><div class="item doc ${i === cur ? 'sel' : ''}" data-i="${i}"><img src="${d.thumb || BLANK}"><div class="meta"><div class="nm" title="${d.name}">${d.kind === 'pdf' ? '📄' : '🖼'} ${d.name}</div><small>${k}/${d.pages.length} 頁${d.pos ? ' · 已手動調整' : ''}</small></div><button class="x" data-x="${i}" title="移除">✕</button></div></div>`;
      if (!d.open || (d.kind === 'image' && d.pages.length < 2)) return row;
      const grid = d.pages.map((pg, j) => `<div class="pg ${pg.del ? 'del' : ''} ${i === cur && j === d.curPage ? 'sel' : ''}" draggable="true" data-d="${i}" data-k="${j}"><img src="${pg.thumb || BLANK}"><span class="no">${pg.i + 1}</span><span class="ops"><button data-rot title="旋轉">↻</button><button data-pdel title="${pg.del ? '還原' : '刪除'}">${pg.del ? '↺' : '✕'}</button></span></div>`).join('');
      return row + `<div class="pgs">${grid}</div>`;
    }).join('');
    $('#empty').hidden = items.length > 0;
    loadThumbs();
    const sel = $('.pg.sel'); if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }
  let thumbBusy = false;
  async function loadThumbs() {
    if (thumbBusy) return;
    thumbBusy = true;
    try {
      for (let guard = 0; guard < 5000 && mode === 'pdf'; guard++) {
        let target = null;
        for (let i = 0; i < items.length && !target; i++) if (items[i].open) for (let j = 0; j < items[i].pages.length; j++) if (!items[i].pages[j].thumb) { target = [i, j]; break; }
        if (!target) break;
        const d = items[target[0]], pg = d.pages[target[1]];
        pg.thumb = (await Pdf.thumb(d, pg)) || BLANK;
        const el = $(`.pg[data-d="${target[0]}"][data-k="${target[1]}"] img`);
        if (el) el.src = pg.thumb;
      }
    } finally { thumbBusy = false; }
  }

  function updateList() {
    if (mode === 'pdf') return updatePdfList();
    const n = E().specs.length;
    $('#count').textContent = items.length ? `共 ${items.length} 個檔案 × ${n} 種規格 = ${items.length * n} 個輸出` : '尚未加入檔案';
    $('#list').innerHTML = items.map((it, i) =>
      `<div class="item ${i === cur ? 'sel' : ''} ${selIds.has(it.id) ? 'msel' : ''}" data-i="${i}">${mode === 'image' ? `<input type="checkbox" class="rs" data-s="${i}" title="勾選（可多選，Ctrl／Shift 也行）" ${selIds.has(it.id) ? 'checked' : ''}>` : ''}<img src="${it.thumb}"><div class="meta"><div class="nm" title="${it.name}">${it.kind === 'video' ? '🎞 ' : ''}${it.name}</div><small>${it.w}×${it.h}${it.kind === 'video' ? ' · ' + fmtDur(it.dur) : ''}${it.pos ? ' · 已手動調整' : ''}${it.wm ? (it.wm.skip ? ' · 無浮水印' : ' · 個別浮水印') : ''}</small></div><button class="x" data-x="${i}" title="移除">✕</button></div>`).join('');
    $('#empty').hidden = items.length > 0;
  }

  async function select(i) {
    if (i < 0 || i >= items.length) { cur = -1; selToken++; Media.closePreview(); bmp && bmp.close(); bmp = null; $('#seekWrap').hidden = true; draw(); updateList(); return; }
    cur = i;
    const tk = ++selToken, it = items[i];
    let b = null;
    if (mode === 'pdf') {
      Media.closePreview();
      try { b = await Pdf.previewBitmap(it, it.pages[Math.min(it.curPage || 0, it.pages.length - 1)]); } catch (err) { logMsg(`無法預覽：${err.message || err}`, true); }
    } else if (it.kind === 'video') {
      try { await Media.openPreview(it); b = await Media.frameBitmap(it, it.tPrev || 0); } catch (err) { logMsg(`無法預覽影片：${err.message || err}`, true); }
    } else { Media.closePreview(); b = await createImageBitmap(it.file); }
    if (tk !== selToken) { b && b.close(); return; }
    bmp && bmp.close(); bmp = b;
    $('#seekWrap').hidden = it.kind !== 'video';
    if (it.kind === 'video') { $('#seek').value = Math.round((it.tPrev || 0) * 1000); updateSeekText(); }
    updateList(); syncDependent(); draw(); scheduleEstimate();
  }
  let seekTimer = 0;
  function updateSeekText() { const it = curItem(); if (it && it.kind === 'video') $('#seekT').textContent = `${fmtDur((it.tPrev || 0) * it.dur)} / ${fmtDur(it.dur)}`; }
  function onSeek() {
    const it = curItem(); if (!it || it.kind !== 'video') return;
    it.tPrev = $('#seek').value / 1000; updateSeekText();
    clearTimeout(seekTimer);
    seekTimer = setTimeout(async () => {
      const tk = ++selToken;
      try { const b = await Media.frameBitmap(it, it.tPrev); if (tk !== selToken || !b) { b && b.close(); return; } bmp && bmp.close(); bmp = b; draw(); } catch { }
    }, 80);
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
        if (!wmOff(curItem())) drawWm(ctx, f.c.w, f.c.h, wmFor(curItem()), wi);
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

  function updateNav() {
    const nav = $('#stageNav'), it = curItem();
    nav.hidden = mode !== 'pdf' || !bmp || !it;   // 只在 PDF 模式顯示
    if (nav.hidden) return;
    if (mode === 'pdf') {
      const j = Math.min(it.curPage || 0, it.pages.length - 1);
      $('#navText').textContent = `第 ${j + 1} / ${it.pages.length} 頁${items.length > 1 ? `（檔案 ${cur + 1}/${items.length}）` : ''}`;
    }
  }
  function updateInfo() {
    updateNav();
    if (!bmp) { $('#info').textContent = ''; return; }
    if (mode === 'pdf') {
      const d = curItem(), pg = d.pages[Math.min(d.curPage || 0, d.pages.length - 1)], dm = Pdf.pageDims(pg);
      $('#info').textContent = `${d.name} ｜ 第 ${pg.i + 1} 頁 ｜ ${Math.round(dm.w)}×${Math.round(dm.h)} pt（約 ${Math.round(dm.w / 72 * 25.4)}×${Math.round(dm.h / 72 * 25.4)} mm）`;
      return;
    }
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
      if (mode === 'pdf') {
        let kept = 0, total = 0;
        items.forEach(d => { kept += Pdf.keptPages(d).length; total += d.pages.length; });
        $('#estimate').textContent = `將輸出 ${kept} 頁（已刪除 ${total - kept} 頁）× ${e.specs.length} 種規格；實際大小在處理後顯示`;
        return;
      }
      if (it.kind === 'video') {
        const parts = frames().map(f => { const p = Media.videoPlan(it, f.spec, e, posOf(it, f.key)), by = Media.estimateBytes(it, p); return `${f.spec.suffix} ${p.W}×${p.H}${by ? ' 約 ' + fmtSize(by) : ''}`; });
        $('#estimate').textContent = parts.length ? `此影片預估（${String(e.out.vfmt || 'mp4').toUpperCase()}，${fmtDur(it.dur)}）：${parts.join('　｜　')}` : '';
        return;
      }
      try {
        for (const f of frames()) {
          const mime = mimeFor(e, it.file);
          const out = renderOutput(bmp, posOf(it, f.key), eW(it, e), f.spec, curWmImg(), mime);
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
    if (wi && !wmOff(curItem())) for (const f of fr) {
      const p = wmPlacement(f.c.w, f.c.h, wmFor(curItem()), wi), rx = pt.x - f.c.x, ry = pt.y - f.c.y;
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
      setWm({ custom: true, x: clamp((pt.x - c.x - drag.ox) / c.w, 0, 1), y: clamp((pt.y - c.y - drag.oy) / c.h, 0, 1) });
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
  // 代號：{n} 流水號、{i} 原檔序號、{p} 頁碼 可用 {n:5} 指定位數；未指定時用「位數」欄位
  function makeBase(tpl, ctx) {
    const d = new Date();
    const v = { ...ctx, date: `${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}`, time: `${z2(d.getHours())}${z2(d.getMinutes())}${z2(d.getSeconds())}` };
    const out = tpl.replace(/\{(\w+)(?::(\d+))?\}/g, (m, k, w) => {
      if (!(k in v)) return m;
      const val = v[k];
      if (['n', 'i', 'p'].includes(k) && val !== '' && !isNaN(val)) return String(val).padStart(Math.min(12, w ? +w : S.out.seqPad), '0');
      return val;
    });
    return safe(out) || 'file';
  }
  const padN = (n, p) => String(n).padStart(p, '0');
  function updateNameExample() {
    const it = curItem() || { name: 'photo.jpg' }, e = E(), key = e.specs[0] || 'orig', spec = specFor(key, S);
    const ext = mode === 'pdf' ? (S.pdf.out === 'images' ? S.pdf.imgFmt : 'pdf') : mode === 'video' ? (['mov', 'webm', 'avi'].includes(S.out.vfmt) ? S.out.vfmt : 'mp4') : EXT[mimeFor(e, it.file)];
    const nm = makeBase(S.out.tpl, { name: it.name.replace(/\.[^.]+$/, ''), ratio: spec.suffix, w: 1080, h: 1350, n: S.out.seqStart, i: 1, p: 1, pages: '1-3' });
    $('#nameEx').textContent = `範例：${nm}.${ext}`;
  }

  // ---------- 輸出 ----------
  function logMsg(t, err) {
    const l = $('#log'); l.hidden = false;
    const d = document.createElement('div'); if (err) d.className = 'err'; d.textContent = t; l.appendChild(d); l.scrollTop = l.scrollHeight;
  }
  function updateOutputUI() { }
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

  // 輸出目的地：本機路徑（輔助程式）／瀏覽器選的資料夾／下載（多檔打包 ZIP）
  async function openSink() {
    const useHelper = false;
    let dh = null;
    if (!useHelper && dirHandle) {
      try {
        let p = await dirHandle.queryPermission({ mode: 'readwrite' });
        if (p !== 'granted') p = await dirHandle.requestPermission({ mode: 'readwrite' });
        if (p === 'granted') dh = dirHandle; else { alert('未取得輸出資料夾的寫入權限'); return null; }
      } catch { alert('輸出資料夾無法使用，請重新選擇'); return null; }
    }
    const used = new Set(), collected = [];
    return {
      async save(base, ext, blob) {
        const name = await uniqueName(base, ext, dh, used);
        if (name === null) return 'skipped';
        if (dh) { const fh = await dh.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(blob); await w.close(); }
        else collected.push({ name, blob });
        return 'saved';
      },
      async finish() {
        if (!useHelper && !dh && collected.length) {
          if (collected.length === 1) download(collected[0].blob, collected[0].name);
          else {
            const d = new Date();
            download(await Zip.build(collected), `輸出_${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}-${z2(d.getHours())}${z2(d.getMinutes())}.zip`);
          }
        }
        return dh ? `（已存入資料夾：${dh.name}）` : '（已下載）';
      },
    };
  }
  function startRun() {
    running = true; cancelled = false;
    $('#btnStart').disabled = true; $('#btnCancel').hidden = false; $('#progressWrap').hidden = false; $('#log').innerHTML = '';
  }
  function finishRun() {
    running = false; $('#btnStart').disabled = false; $('#btnCancel').hidden = true;
    setTimeout(() => { $('#progressWrap').hidden = true; $('#bar').style.width = '0'; $('#progressText').textContent = ''; }, 2500);
  }
  const setProgress = (frac, text) => { $('#bar').style.width = (Math.min(1, frac) * 100) + '%'; $('#progressText').textContent = text; };

  async function run() {
    if (running) return;
    if (mode === 'pdf') return runPdf();
    const e = E();
    if (!items.length) { alert('請先加入檔案'); return; }
    if (!e.specs.length) { alert('請至少勾選一種裁切規格，或關閉「比例裁切」'); return; }
    if (S.wm.on && !curWmImg()) { alert('已啟用浮水印，但尚未選擇浮水印圖片或輸入文字'); return; }
    const sink = await openSink(); if (!sink) return;
    startRun();
    const wmImg = curWmImg();
    const total = items.length * e.specs.length;
    let done = 0, fail = 0, skipped = 0, over = 0, saved = 0, seq = S.out.seqStart, fatal = false;
    for (let ii = 0; ii < items.length && !cancelled && !fatal; ii++) {
      const it = items[ii];
      let b = null;
      try {
        if (it.kind !== 'video') b = await createImageBitmap(it.file);
        for (const key of e.specs) {
          if (cancelled) break;
          const spec = specFor(key, S);
          let blob, ext, ow, oh;
          if (it.kind === 'video') {
            const v = await Media.processVideo(it, spec, e, S.wm, wmImg, posOf(it, key), p => setProgress((done + p) / total, `${done + 1} / ${total}（影片 ${Math.round(p * 100)}%）`), vHolder);
            blob = v.blob; ext = v.ext; ow = v.w; oh = v.h;
            if (v.over) over++;
            if (v.warn) logMsg(`${it.name}：${v.warn}`);
          } else {
            const mime = mimeFor(e, it.file);
            const out = await renderOutputQ(b, posOf(it, key), eW(it, e), spec, wmImg, mime);
            const r = await encodeCanvas(out, mime, e);
            if (r.over) over++;
            blob = r.blob; ext = EXT[mime]; ow = out.width; oh = out.height;
          }
          const base = makeBase(S.out.tpl, { name: it.name.replace(/\.[^.]+$/, ''), ratio: spec.suffix, w: ow, h: oh, n: seq++, i: ii + 1 });
          if (await sink.save(base, ext, blob) === 'skipped') skipped++; else saved++;
          done++;
          setProgress(done / total, `${done} / ${total}`);
          await new Promise(r => setTimeout(r, 0));
        }
      } catch (err) {
        if (err.fatal) { logMsg(err.message, true); fatal = true; }
        else if (!cancelled) { fail++; logMsg(`失敗：${it.name}（${err.message || err}）`, true); }
      } finally { b && b.close(); }
    }
    const where = await sink.finish();
    logMsg(`${fatal ? '已中止' : cancelled ? '已取消' : '完成'}：輸出 ${saved} 個${skipped ? `，略過 ${skipped}` : ''}${fail ? `，失敗 ${fail} 個` : ''}${over ? `，${over} 個仍超過大小上限` : ''}${where}`, fail > 0 || fatal);
    finishRun();
  }

  async function runPdf() {
    const e = E(), P = S.pdf;
    const docs = items.filter(d => Pdf.keptPages(d).length);
    if (!docs.length) { alert('沒有可輸出的頁面：請先加入檔案，並至少保留一頁'); return; }
    if (!e.specs.length) { alert('請至少勾選一種裁切規格，或關閉「比例裁切」'); return; }
    if (S.wm.on && !curWmImg()) { alert('已啟用浮水印，但尚未選擇浮水印圖片或輸入文字'); return; }
    const sink = await openSink(); if (!sink) return;
    startRun();
    const wmImg = curWmImg(), asImages = P.out === 'images';
    const jobs = asImages ? docs.map(d => ({ name: d.base, doc: d, refs: Pdf.keptPages(d).map(pg => ({ doc: d, pg })), part: 0, label: '' })) : Pdf.plan(docs, P);
    const total = jobs.reduce((a, j) => a + j.refs.length, 0) * e.specs.length;
    let done = 0, fail = 0, skipped = 0, over = 0, saved = 0, seq = S.out.seqStart, fatal = false;
    const tplHas = re => re.test(S.out.tpl);
    for (const job of jobs) {
      if (cancelled || fatal) break;
      for (const key of e.specs) {
        if (cancelled || fatal) break;
        const spec = specFor(key, S), first = job.refs[0].pg, d0 = Pdf.pageDims(first);
        const cfg = { S, wmImg, posFor: (doc, k) => posOf(doc, k), cancelled: () => cancelled, onProgress: p => setProgress((done + p * job.refs.length) / total, `${Math.round((done + p * job.refs.length) / total * 100)}%　${job.name}`) };
        try {
          if (asImages) {
            const files = await Pdf.renderImages(job.refs, spec, cfg);
            for (const f of files) {
              let base = makeBase(S.out.tpl, { name: job.name, ratio: spec.suffix, w: f.w, h: f.h, n: seq++, i: jobs.indexOf(job) + 1, p: f.page, pages: String(f.page) });
              if (!tplHas(/\{(p|n|pages)(:\d+)?\}/)) base += `_p${padN(f.page, S.out.seqPad)}`;
              if (await sink.save(base, f.ext, f.blob) === 'skipped') skipped++; else saved++;
            }
          } else {
            const r = await Pdf.buildPdf(job.refs, spec, cfg);
            r.notes.forEach(n => logMsg(n));
            if (r.over) over++;
            let base = makeBase(S.out.tpl, { name: job.name, ratio: spec.suffix, w: Math.round(d0.w), h: Math.round(d0.h), n: seq++, i: jobs.indexOf(job) + 1, p: '', pages: job.label });
            if (job.part > 0 && !tplHas(/\{(pages|n)(:\d+)?\}/)) base += `_${job.label}`;
            const orig = P.merge ? 0 : job.doc.file.size;
            if (await sink.save(base, 'pdf', r.blob) === 'skipped') skipped++; else saved++;
            const st = r.stat && r.stat.total ? `（圖片 ${r.stat.changed}/${r.stat.total} 張已重新壓縮）` : '';
            logMsg(`${base}.pdf：${orig ? fmtSize(orig) + ' → ' : ''}${fmtSize(r.blob.size)}${st}`);
          }
        } catch (err) {
          if (err.fatal) { logMsg(err.message, true); fatal = true; }
          else if (!cancelled) { fail++; logMsg(`失敗：${job.name}（${err.message || err}）`, true); }
        }
        done += job.refs.length;
        await new Promise(r => setTimeout(r, 0));
      }
    }
    const where = await sink.finish();
    logMsg(`${fatal ? '已中止' : cancelled ? '已取消' : '完成'}：輸出 ${saved} 個檔案${skipped ? `，略過 ${skipped}` : ''}${fail ? `，失敗 ${fail} 個` : ''}${over ? `，${over} 個未達容量上限` : ''}${where}`, fail > 0 || fatal);
    finishRun();
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
      const cb = e.target.closest('[data-s]');
      if (cb && mode === 'image') {
        const k = +cb.dataset.s, it0 = items[k];
        selIds.has(it0.id) ? selIds.delete(it0.id) : selIds.add(it0.id); selAnchor = k;
        if (selIds.size >= 2) wmScope = 'sel';
        refreshSel(); return;
      }
      const x = e.target.closest('[data-x]');
      if (x) {
        const i = +x.dataset.x; selIds.delete(items[i].id); if (mode === 'pdf') Pdf.dispose(items[i]); items.splice(i, 1);
        if (!items.length) await select(-1); else await select(Math.min(cur > i ? cur - 1 : cur, items.length - 1));
        updateList(); return;
      }
      const it = e.target.closest('.item'); if (it) { if (mode === 'image') selectRow(+it.dataset.i, e); await select(+it.dataset.i); }
    });
    $('#btnSort').addEventListener('click', () => { const c = items[cur]; items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); cur = items.indexOf(c); updateList(); });
    $('#btnClear').addEventListener('click', async () => { if (items.length && confirm(`清空${MODE_NAME[mode]}清單？`)) { if (mode === 'pdf') items.forEach(Pdf.dispose); selIds.clear(); items = []; await select(-1); } });
    $('#navPrev').addEventListener('click', () => step(-1));
    $('#navNext').addEventListener('click', () => step(1));
    document.addEventListener('keydown', e => {
      if (e.target.closest && e.target.closest('input,select,textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
      if (mode !== 'pdf') return;
      if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
    });
    $('#btnPrev').addEventListener('click', () => step(-1));
    $('#btnNext').addEventListener('click', () => step(1));
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

    // ---- PDF 頁面清單 ----
    $('#list').addEventListener('click', async e => {
      if (mode !== 'pdf') return;
      const tg = e.target.closest('[data-tg]');
      if (tg) { const d = items[+tg.dataset.tg]; d.open = !d.open; updatePdfList(); return; }
      const cell = e.target.closest('.pg');
      if (!cell) return;
      const i = +cell.dataset.d, j = +cell.dataset.k, d = items[i], pg = d.pages[j];
      if (e.target.closest('[data-rot]')) { pg.rot = (pg.rot + 90) % 360; pg.thumb = ''; if (i === cur && j === d.curPage) await select(i); else updatePdfList(); return; }
      if (e.target.closest('[data-pdel]')) { pg.del = !pg.del; updatePdfList(); scheduleEstimate(); return; }
      d.curPage = j; await select(i);
    });
    let dragPg = null;
    const pgOf = e => (e.target.closest ? e.target.closest('.pg') : null);
    $('#list').addEventListener('dragstart', e => { const c = pgOf(e); if (!c) return; dragPg = { d: +c.dataset.d, k: +c.dataset.k }; e.dataTransfer.setData('text/plain', 'pg'); e.dataTransfer.effectAllowed = 'move'; });
    $('#list').addEventListener('dragover', e => { const c = pgOf(e); if (!dragPg || !c || +c.dataset.d !== dragPg.d) return; e.preventDefault(); $$('.pg.over').forEach(x => x.classList.remove('over')); c.classList.add('over'); });
    $('#list').addEventListener('drop', e => {
      const c = pgOf(e);
      if (!dragPg || !c || +c.dataset.d !== dragPg.d) { dragPg = null; return; }
      e.preventDefault(); e.stopPropagation();
      const d = items[dragPg.d], to = +c.dataset.k, from = dragPg.k; dragPg = null;
      if (from === to) return;
      const [mv] = d.pages.splice(from, 1); d.pages.splice(to, 0, mv);
      if (d.curPage === from) d.curPage = to; else if (from < d.curPage && to >= d.curPage) d.curPage--; else if (from > d.curPage && to <= d.curPage) d.curPage++;
      updatePdfList();
    });
    $('#list').addEventListener('dragend', () => { dragPg = null; $$('.pg.over').forEach(x => x.classList.remove('over')); });
    const rangeSet = d => { const s = Pdf.parseRange($('#pageRange').value, d.pages.length); if (!s || !s.size) { alert('請輸入有效的頁碼，例如 1-3,5,8-（以頁面角落的原始頁碼為準）'); return null; } return s; };
    $('#btnKeepRange').addEventListener('click', () => { const d = curItem(); if (!d) return; const s = rangeSet(d); if (!s) return; d.pages.forEach(pg => pg.del = !s.has(pg.i)); updatePdfList(); scheduleEstimate(); });
    $('#btnDelRange').addEventListener('click', () => { const d = curItem(); if (!d) return; const s = rangeSet(d); if (!s) return; d.pages.forEach(pg => { if (s.has(pg.i)) pg.del = true; }); updatePdfList(); scheduleEstimate(); });
    $('#btnRestore').addEventListener('click', () => { const d = curItem(); if (!d) return; d.pages.forEach(pg => pg.del = false); updatePdfList(); scheduleEstimate(); });
    $('#dpiPreset').addEventListener('change', e => { S.pdf.dpi = +e.target.value; syncUI(); changed(); });

    $$('[data-scope]').forEach(b => b.addEventListener('click', () => { wmScope = b.dataset.scope; syncDependent(); draw(); }));
    $('#btnSelAll').addEventListener('click', () => { items.forEach(i => selIds.add(i.id)); if (selIds.size >= 2) wmScope = 'sel'; refreshSel(); });
    $('#btnWmSkip').addEventListener('click', () => {
      const t = scopeTargets(); if (!t) return;
      const off = !t.every(wmOff);
      t.forEach(it => { it.wm = { ...(it.wm || {}), skip: off }; if (!off) delete it.wm.skip; if (!Object.keys(it.wm).length) delete it.wm; });
      changed();
    });
    $('#btnWmReset').addEventListener('click', () => {
      const t = scopeTargets();
      (t || items).forEach(it => { delete it.wm; });
      changed();
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
    $('#btnStart').addEventListener('click', run);
    $('#btnCancel').addEventListener('click', () => { cancelled = true; if (vHolder.conv) vHolder.conv.cancel().catch(() => { }); });
    $('#seek').addEventListener('input', onSeek);

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

  // ---------- 左右欄寬度（可拖曳調整）----------
  function initResize() {
    const root = document.documentElement.style;
    const DEF = { lw: 260, rw: 340 }, KEY = 'imgtool.widths';
    let w = { ...DEF };
    try { w = { ...DEF, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { }
    const apply = () => { root.setProperty('--lw', w.lw + 'px'); root.setProperty('--rw', w.rw + 'px'); };
    const clampW = (v, other) => Math.max(200, Math.min(v, 640, window.innerWidth - other - 320));
    w.lw = clampW(w.lw, w.rw); w.rw = clampW(w.rw, w.lw); apply();
    const bind = (id, side) => {
      const h = $(id);
      h.addEventListener('pointerdown', e => {
        e.preventDefault(); h.setPointerCapture(e.pointerId);
        h.classList.add('on'); document.body.classList.add('resizing');
        const x0 = e.clientX, start = w[side];
        const move = ev => {
          const dx = ev.clientX - x0;
          w[side] = clampW(side === 'lw' ? start + dx : start - dx, side === 'lw' ? w.rw : w.lw);
          apply();
        };
        const up = () => {
          h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
          h.classList.remove('on'); document.body.classList.remove('resizing');
          try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { }
        };
        h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
      });
      h.addEventListener('dblclick', () => { w[side] = DEF[side]; apply(); try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { } });
    };
    bind('#rzL', 'lw'); bind('#rzR', 'rw');
  }

  // ---------- 區塊收納 ----------
  function initCollapse() {
    let st = []; try { st = JSON.parse(localStorage.getItem('imgtool.collapsed')) || []; } catch { }
    $$('.card[data-collapse]').forEach(card => {
      const id = card.dataset.collapse;
      card.classList.toggle('collapsed', st.includes(id));
      card.querySelector('header').addEventListener('click', e => {
        if (e.target.closest('button,input,select')) return;
        card.classList.toggle('collapsed');
        const now = $$('.card.collapsed[data-collapse]').map(c => c.dataset.collapse);
        try { localStorage.setItem('imgtool.collapsed', JSON.stringify(now)); } catch { }
      });
    });
  }

  // ---------- 圖片 / 影片模式 ----------
  async function setMode(m, first) {
    if (!first) {
      if (m === mode) return;
      if (running) { alert('處理中，請等完成後再切換模式'); return; }
      modeState[mode].items = items; modeState[mode].cur = cur;
    }
    mode = m;
    try { localStorage.setItem('imgtool.mode', m); } catch { }
    // 第一次進入 PDF 模式：預設關閉比例裁切（避免整份 PDF 被意外裁成正方形）
    try { if (m === 'pdf' && !localStorage.getItem('imgtool.pdfInit')) { localStorage.setItem('imgtool.pdfInit', '1'); S.cropOn = false; save(); syncUI(); } } catch { }
    items = modeState[m].items;
    const want = modeState[m].cur;
    cur = -1;
    $$('#modeTabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === m));
    $$('[data-only]').forEach(el => el.hidden = !el.dataset.only.split(' ').includes(m));
    $('#fileInput').accept = m === 'video' ? 'video/*,.mkv,.mov' : m === 'pdf' ? 'application/pdf,.pdf,image/*,.heic,.heif' : 'image/*,.heic,.heif';
    $('#dropTitle').textContent = { image: '拖曳圖片或資料夾到這裡', video: '拖曳影片或資料夾到這裡', pdf: '拖曳 PDF（或圖片）到這裡' }[m];
    $('#btnAddFiles').textContent = { image: '加入圖片', video: '加入影片', pdf: '加入 PDF' }[m];
    $('#btnPrev').title = $('#navPrev').title = m === 'pdf' ? '上一頁（←）' : '上一個檔案（←）'; $('#btnNext').title = $('#navNext').title = m === 'pdf' ? '下一頁（→）' : '下一個檔案（→）';
    $('#log').innerHTML = ''; $('#log').hidden = true;
    hiddenKeys.clear();
    syncDependent();
    if (items.length) await select(Math.min(Math.max(want, 0), items.length - 1)); else await select(-1);
    updateList();
  }
  function initMode() {
    let m = 'image'; try { const sv = localStorage.getItem('imgtool.mode'); m = ['video', 'pdf'].includes(sv) ? sv : 'image'; } catch { }
    $('#modeTabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) setMode(b.dataset.tab); });
    return setMode(m, true);
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
    initTheme(); initCollapse(); initResize();
    if (!Media.videoSupported()) { const n = $('#vidNote'); n.classList.add('bad'); n.innerHTML += '<br>⚠ 目前的瀏覽器不支援影片處理，只能處理圖片。請改用 Chrome 或 Edge 電腦版。'; }
    buildGrid(); bindSettings(); wire();
    await loadWmLib();
    try { dirHandle = await DB.kvGet('outDir'); } catch { }
    showDir(); renderPresets(); syncUI(); await initMode(); updateList(); draw();
  })();
})();
