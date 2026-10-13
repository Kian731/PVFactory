// 影片與 HEIC 支援（需要時才載入對應函式庫）
// 影片：Mediabunny（WebCodecs），HEIC：heic2any（libheif）。函式庫放在 js/vendor/。
const Media = (() => {
  const loaded = {};
  const loadScript = src => loaded[src] || (loaded[src] = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => { delete loaded[src]; rej(new Error('無法載入 ' + src)); };
    document.head.appendChild(s);
  }));

  const VIDEO_RE = /\.(mp4|m4v|mov|webm|mkv)$/i, HEIC_RE = /\.(heic|heif)$/i;
  const isVideo = f => (f.type || '').startsWith('video/') || VIDEO_RE.test(f.name);
  const isHeic = f => /image\/hei[cf]/.test(f.type || '') || HEIC_RE.test(f.name);
  const videoSupported = () => typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  async function mb() { await loadScript('js/vendor/mediabunny.min.js'); return Mediabunny; }
  const newInput = (M, file) => new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });

  // ---------- HEIC ----------
  async function heicToJpeg(file) {
    await loadScript('js/vendor/heic2any.min.js');
    let r = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.95 });
    if (Array.isArray(r)) r = r[0];
    return new File([r], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }

  // ---------- 影片資訊 ----------
  async function probeVideo(file) {
    if (!videoSupported()) throw new Error('此瀏覽器不支援影片處理，請使用 Chrome 或 Edge 電腦版');
    const M = await mb(), input = newInput(M, file);
    try {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) throw new Error('找不到影像軌');
      if (!(await vt.canDecode())) throw new Error(`此瀏覽器無法解碼這支影片（${vt.codec}）。H.265/HEVC 需要電腦的顯卡或系統解碼支援`);
      const dur = await input.computeDuration(), t0 = await vt.getFirstTimestamp();
      let rate = 30;
      try { const st = await vt.computePacketStats(60); if (st.averagePacketRate > 0) rate = st.averagePacketRate; } catch { }
      const at = await input.getPrimaryAudioTrack();
      let audioBps = 0;
      if (at) { try { audioBps = (await at.computePacketStats(60)).averageBitrate || 128000; } catch { audioBps = 128000; } }
      // 縮圖
      const sink = new M.CanvasSink(vt, { width: 96, height: 96, fit: 'cover' });
      const wc = await sink.getCanvas(t0);
      let thumb = '';
      if (wc) { const c = document.createElement('canvas'); c.width = 96; c.height = 96; c.getContext('2d').drawImage(wc.canvas, 0, 0, 96, 96); thumb = c.toDataURL('image/jpeg', 0.7); }
      return { w: vt.displayWidth, h: vt.displayHeight, dur, t0, rate, hasAudio: !!at, audioBps, codec: vt.codec, thumb };
    } finally { input.dispose(); }
  }

  // ---------- 預覽（拖動時間軸取畫面）----------
  let pv = null;
  function closePreview() { if (pv) { try { pv.input.dispose(); } catch { } pv = null; } }
  async function openPreview(item) {
    closePreview();
    const M = await mb(), input = newInput(M, item.file), track = await input.getPrimaryVideoTrack();
    pv = { id: item.id, input, sink: new M.CanvasSink(track) };
  }
  // frac: 0~1 的時間位置；回傳 ImageBitmap（呼叫端負責 close）
  async function frameBitmap(item, frac) {
    const p = pv; if (!p || p.id !== item.id) return null;
    const ts = Math.min(item.t0 + frac * item.dur, item.t0 + Math.max(0, item.dur - 0.05));
    const w = await p.sink.getCanvas(ts) || await p.sink.getCanvas(item.t0);
    if (!w || pv !== p) return null;
    return createImageBitmap(w.canvas);
  }

  // ---------- 輸出規劃（預覽估算與實際轉檔共用）----------
  function videoPlan(it, spec, e, pos) {
    const c = cropRect(it.w, it.h, spec.ratio, pos.x, pos.y, pos.z);
    const p = targetPlan(e.resize, c.w, c.h);
    const even = n => Math.max(2, n & ~1);
    const W = even(p.W), H = even(p.H), o = e.out;
    const crop = { left: c.x + p.sx, top: c.y + p.sy, width: p.sw, height: p.sh };
    const full = crop.left === 0 && crop.top === 0 && crop.width === it.w && crop.height === it.h;
    let fps = it.rate || 30;
    const cap = +o.fps || 0;
    if (o.on && cap > 0) fps = Math.min(fps, cap);
    let br = null;
    if (o.on) {
      const q = o.quality / 100;
      br = W * H * fps * (0.02 + q * q * 0.14);
      if (+o.targetKB > 0) br = Math.min(br, Math.max(30000, o.targetKB * 1024 * 8 / Math.max(it.dur, 0.1) - (it.hasAudio ? it.audioBps : 0)));
      br = Math.round(br);
    }
    return { crop: full ? null : crop, W, H, resized: W !== it.w || H !== it.h, fps, capFps: o.on && cap > 0 && (it.rate || 30) > cap ? cap : 0, br, fmt: ['mov', 'webm', 'avi'].includes(o.vfmt) ? o.vfmt : 'mp4', q: Math.min(0.95, Math.max(0.05, (o.on ? o.quality : 85) / 100)), target: o.on && +o.targetKB > 0 ? o.targetKB * 1024 : 0 };
  }
  function estimateBytes(it, plan) {
    if (plan.fmt === 'avi') {
      const pcm = it.hasAudio ? 44100 * 4 * it.dur : 0;
      const est = plan.fps * it.dur * plan.W * plan.H * (0.5 + 2.5 * plan.q * plan.q) / 8 + pcm;
      return plan.target ? Math.min(est, Math.max(plan.target, pcm)) : est;
    }
    return plan.br ? (plan.br + (it.hasAudio ? it.audioBps : 0)) * it.dur / 8 : null;
  }

  // ---------- GIF（單張，最多 256 色）----------
  async function encodeGif(cv) {
    await loadScript('js/vendor/gifenc.js');
    const { GIFEncoder, quantize, applyPalette } = gifenc;
    const w = cv.width, h = cv.height, data = cv.getContext('2d').getImageData(0, 0, w, h).data;
    let alpha = false;
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) { alpha = true; break; }
    const gif = GIFEncoder();
    if (alpha) {
      const palette = quantize(data, 256, { format: 'rgba4444', oneBitAlpha: true });
      const ti = palette.findIndex(c => c[3] === 0);
      gif.writeFrame(applyPalette(data, palette, 'rgba4444'), w, h, { palette, transparent: ti >= 0, transparentIndex: Math.max(ti, 0) });
    } else {
      const palette = quantize(data, 256);
      gif.writeFrame(applyPalette(data, palette), w, h, { palette });
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
  }

  // ---------- AVI（MJPEG 影像 + PCM 聲音；瀏覽器無內建 AVI 編碼，自行封裝）----------
  const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const fcc = s => Uint8Array.from(s, c => c.charCodeAt(0));
  const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
  const nums = (...v) => cat(v.map(u32));
  const riffChunk = (id, data) => cat([fcc(id), u32(data.length), data, new Uint8Array(data.length & 1)]);
  const riffList = (type, ...kids) => { const body = cat([fcc(type), ...kids]); return cat([fcc('LIST'), u32(body.length), body]); };

  async function processAvi(M, it, plan, e, wm, wmImg, onProgress, holder) {
    let stop = false;
    holder.conv = { cancel: async () => { stop = true; } };
    const input = newInput(M, it.file);
    try {
      const vt = await input.getPrimaryVideoTrack();
      const sink = new M.CanvasSink(vt);
      const fps = Math.max(1, Math.min(120, plan.fps || 30));
      const nFrames = Math.max(1, Math.round(it.dur * fps)), W = plan.W, H = plan.H;
      const crop = plan.crop || { left: 0, top: 0, width: it.w, height: it.h };

      // 聲音 → 16-bit PCM
      let pcm = null, ch = 0, sr = 0;
      const at = await input.getPrimaryAudioTrack();
      if (at && await at.canDecode()) {
        ch = Math.min(2, at.numberOfChannels); sr = at.sampleRate;
        pcm = new Int16Array((Math.round(nFrames * sr / fps) + sr) * ch);
        const asink = new M.AudioBufferSink(at);
        for await (const { buffer, timestamp } of asink.buffers()) {
          if (stop) throw new Error('canceled');
          let off = Math.round((timestamp - it.t0) * sr);
          const n = buffer.length, chans = [];
          for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
          for (let i = 0; i < n; i++, off++) {
            if (off < 0) continue;
            if (off * ch + ch > pcm.length) break;
            for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); pcm[off * ch + c] = v < 0 ? v * 0x8000 : v * 0x7FFF; }
          }
          onProgress(Math.min(0.1, (timestamp - it.t0) / it.dur * 0.1));
        }
      }
      const totalSamples = pcm ? Math.round(nFrames * sr / fps) : 0, pcmBytes = totalSamples * ch * 2;

      const out = new OffscreenCanvas(W, H), ctx = out.getContext('2d');
      const draw = src => {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        if (src) ctx.drawImage(src, crop.left, crop.top, crop.width, crop.height, 0, 0, W, H);
        if (wm.on && wmImg) drawWm(ctx, W, H, wm, wmImg);
      };
      const jpeg = q => out.convertToBlob({ type: 'image/jpeg', quality: q });

      // 畫質：有大小上限時，用中間一格試出能達標的 JPEG 品質
      let q = Math.min(0.95, Math.max(0.05, (e.out.on ? e.out.quality : 85) / 100));
      const target = (e.out.on && +e.out.targetKB > 0) ? e.out.targetKB * 1024 : 0;
      if (target) {
        const mid = await sink.getCanvas(it.t0 + it.dur / 2);
        if (mid) {
          draw(mid.canvas);
          const budget = Math.max(2000, (target - pcmBytes - nFrames * 16) / nFrames);
          let lo = 0.05, hi = 0.95;
          q = lo;
          for (let i = 0; i < 6; i++) { const m = (lo + hi) / 2; if ((await jpeg(m)).size <= budget) { q = m; lo = m; } else hi = m; }
        }
      }

      // 逐格（固定幀率）
      const frames = [], index = [];
      let pos = 4, maxChunk = 0, last = null, k = 0;
      const times = function* () { for (let i = 0; i < nFrames; i++) yield Math.min(it.t0 + i / fps, it.t0 + it.dur - 0.001); };
      const add = (id, parts, size) => {
        const pad = size & 1 ? [new Uint8Array(1)] : [];
        frames.push(fcc(id), u32(size), ...parts, ...pad);
        index.push(cat([fcc(id), nums(0x10, pos, size)]));
        pos += 8 + size + (size & 1); maxChunk = Math.max(maxChunk, size);
        if (pos > 2.0e9) throw new Error('AVI 格式上限約 2GB，請降低畫質、尺寸或改用其他格式');
      };
      for await (const w of sink.canvasesAtTimestamps(times())) {
        if (stop) throw new Error('canceled');
        if (w) last = w.canvas;
        draw(last);
        const b = await jpeg(q);
        add('00dc', [b], b.size);
        if (pcm) {
          const s0 = Math.round(k * sr / fps), s1 = k === nFrames - 1 ? totalSamples : Math.round((k + 1) * sr / fps);
          const bytes = new Uint8Array(pcm.buffer, s0 * ch * 2, Math.max(0, s1 - s0) * ch * 2).slice();
          add('01wb', [bytes], bytes.length);
        }
        k++;
        onProgress(0.1 + 0.9 * k / nFrames);
      }

      // 檔頭
      const ba = ch * 2, hasA = !!pcm, sugg = maxChunk + 1024;
      const avih = nums(Math.round(1e6 / fps), 0, 0, 0x10, k, 0, hasA ? 2 : 1, sugg, W, H, 0, 0, 0, 0);
      const strhV = cat([fcc('vids'), fcc('MJPG'), nums(0, 0, 0, 1000, Math.round(fps * 1000), 0, k, sugg, 0xFFFFFFFF, 0), new Uint8Array(8)]);
      const strfV = cat([nums(40, W, H, 1 | (24 << 16)), fcc('MJPG'), nums(W * H * 3, 0, 0, 0, 0)]);
      const kids = [riffChunk('avih', avih), riffList('strl', riffChunk('strh', strhV), riffChunk('strf', strfV))];
      if (hasA) {
        const strhA = cat([fcc('auds'), nums(0, 0, 0, 0, ba, sr * ba, 0, totalSamples, 65536, 0xFFFFFFFF, ba), new Uint8Array(8)]);
        const wf = new DataView(new ArrayBuffer(18));
        wf.setUint16(0, 1, true); wf.setUint16(2, ch, true); wf.setUint32(4, sr, true); wf.setUint32(8, sr * ba, true); wf.setUint16(12, ba, true); wf.setUint16(14, 16, true); wf.setUint16(16, 0, true);
        kids.push(riffList('strl', riffChunk('strh', strhA), riffChunk('strf', new Uint8Array(wf.buffer))));
      }
      const hdrl = riffList('hdrl', ...kids);
      const idx1 = riffChunk('idx1', cat(index));
      const moviLen = pos;
      const riffLen = 4 + hdrl.length + 8 + moviLen + idx1.length;
      if (riffLen > 2.1e9) throw new Error('AVI 格式上限約 2GB，請降低畫質、尺寸或改用其他格式');
      const blob = new Blob([fcc('RIFF'), u32(riffLen), fcc('AVI '), hdrl, fcc('LIST'), u32(moviLen), fcc('movi'), ...frames, idx1], { type: 'video/x-msvideo' });
      const warn = (it.hasAudio && !hasA) ? '聲音無法解碼，已略過' : '';
      return { blob, ext: 'avi', w: W, h: H, over: !!target && blob.size > target * 1.08, warn };
    } finally { holder.conv = null; input.dispose(); }
  }

  // ---------- 轉檔 ----------
  async function processVideo(it, spec, e, wm, wmImg, pos, onProgress, holder) {
    const M = await mb();
    const plan = videoPlan(it, spec, e, pos);
    if (plan.fmt === 'avi') return processAvi(M, it, plan, e, wm, wmImg, onProgress, holder);
    const target = (e.out.on && +e.out.targetKB > 0) ? e.out.targetKB * 1024 : 0;
    for (let attempt = 0; ; attempt++) {
      const input = newInput(M, it.file);
      const output = new M.Output({ format: plan.fmt === 'webm' ? new M.WebMOutputFormat() : plan.fmt === 'mov' ? new M.MovOutputFormat() : new M.Mp4OutputFormat(), target: new M.BufferTarget() });
      try {
        const useWm = wm.on && wmImg;
        const video = {};
        if (plan.crop) video.crop = plan.crop;
        if (plan.resized || plan.crop) { video.width = plan.W; video.height = plan.H; video.fit = 'fill'; }
        if (plan.capFps) video.frameRate = plan.capFps;
        if (plan.br) video.bitrate = plan.br;
        if (e.out.on) video.forceTranscode = true;
        if (e.out.on || plan.crop || plan.resized || plan.capFps || useWm || plan.fmt === 'webm') video.codec = plan.fmt === 'webm' ? 'vp9' : 'avc';
        if (useWm) {
          const cv = new OffscreenCanvas(plan.W, plan.H), ctx = cv.getContext('2d');
          video.process = s => { ctx.clearRect(0, 0, plan.W, plan.H); s.draw(ctx, 0, 0, plan.W, plan.H); drawWm(ctx, plan.W, plan.H, wm, wmImg); return cv; };
          video.processedWidth = plan.W; video.processedHeight = plan.H;
        }
        const conv = await M.Conversion.init({ input, output, video, tags: {} });
        if (!conv.isValid) throw new Error('此影片無法轉換：' + conv.discardedTracks.map(d => d.reason).join('、'));
        const warn = conv.discardedTracks.some(d => d.track.type === 'audio') ? '聲音無法保留，已略過' : '';
        holder.conv = conv;
        conv.onProgress = p => onProgress(p);
        await conv.execute();
        holder.conv = null;
        const blob = new Blob([output.target.buffer], { type: plan.fmt === 'webm' ? 'video/webm' : plan.fmt === 'mov' ? 'video/quicktime' : 'video/mp4' });
        // 超過大小上限就依比例降低位元率再轉一次（最多一次）
        if (target && blob.size > target * 1.08 && attempt === 0 && plan.br) {
          plan.br = Math.max(30000, Math.round(plan.br * (target / blob.size) * 0.93));
          continue;
        }
        return { blob, ext: plan.fmt, w: plan.W, h: plan.H, over: !!target && blob.size > target * 1.08, warn };
      } finally { holder.conv = null; input.dispose(); }
    }
  }

  return { loadScript, isVideo, isHeic, videoSupported, heicToJpeg, probeVideo, openPreview, closePreview, frameBitmap, videoPlan, estimateBytes, processVideo, encodeGif };
})();
