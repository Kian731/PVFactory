// 本機輔助程式（選用）：提供網頁介面 + 寫入指定路徑 + 開啟資料夾
// 只監聽 127.0.0.1，不連外。用「啟動.bat」執行。
const http = require('http'), fs = require('fs'), path = require('path');
const { spawn, execFile } = require('child_process');

const ROOT = __dirname, PORT = +process.env.PORT || 8765, HOST = '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const OK_EXT = new Set(['.jpg', '.png', '.webp']);

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { const a = []; req.on('data', c => a.push(c)); req.on('end', () => ok(Buffer.concat(a))); req.on('error', no); });

function openFolder(dir) {
  if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}
function openUrl(url) {
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function api(req, res, u) {
  const host = (req.headers.host || '').split(':')[0];
  if ((host !== '127.0.0.1' && host !== 'localhost') || req.headers['x-imgtool'] !== '1') return json(res, 403, { error: 'forbidden' });
  const p = u.pathname, q = u.searchParams;
  if (p === '/api/ping') return json(res, 200, { ok: true, platform: process.platform });

  if (p === '/api/write' && req.method === 'POST') {
    const dir = q.get('dir') || '', name = q.get('name') || '', mode = q.get('conflict') || 'rename';
    if (!path.isAbsolute(dir)) return json(res, 400, { error: '路徑必須是完整路徑（例如 D:\\輸出）' });
    if (name !== path.basename(name) || !OK_EXT.has(path.extname(name).toLowerCase())) return json(res, 400, { error: '檔名不合法' });
    const body = await readBody(req);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 500, { error: '無法建立資料夾：' + e.message }); }
    const ext = path.extname(name), base = name.slice(0, -ext.length);
    let final = name;
    for (let n = 1; fs.existsSync(path.join(dir, final)); n++) {
      if (mode === 'overwrite') break;
      if (mode === 'skip') return json(res, 200, { skipped: true, name });
      final = `${base} (${n})${ext}`;
    }
    try { fs.writeFileSync(path.join(dir, final), body); } catch (e) { return json(res, 500, { error: '寫入失敗：' + e.message }); }
    return json(res, 200, { name: final });
  }

  if (p === '/api/open' && req.method === 'POST') {
    const dir = q.get('dir') || '';
    try { if (!path.isAbsolute(dir)) throw 0; fs.mkdirSync(dir, { recursive: true }); openFolder(dir); return json(res, 200, { ok: true }); }
    catch { return json(res, 400, { error: '路徑無效' }); }
  }

  if (p === '/api/pick' && req.method === 'POST') {
    if (process.platform !== 'win32') return json(res, 400, { error: '此系統請直接貼上路徑' });
    const ps = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;Add-Type -AssemblyName System.Windows.Forms;$f=New-Object System.Windows.Forms.FolderBrowserDialog;$f.Description='選擇輸出資料夾';if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}";
    return execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { encoding: 'utf8' }, (err, out) => json(res, 200, { path: err ? '' : out.trim() }));
  }
  json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname.startsWith('/api/')) return await api(req, res, u);
    let rel = decodeURIComponent(u.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep) || path.basename(file) === 'server.js') { res.writeHead(404); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
});

const url = `http://${HOST}:${PORT}/`;
server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log('工具已在執行，開啟瀏覽器…'); if (!process.env.NO_OPEN) openUrl(url); setTimeout(() => process.exit(0), 500); }
  else { console.error(e); process.exit(1); }
});
server.listen(PORT, HOST, () => {
  console.log(`圖片處理工具已啟動：${url}\n（關閉此視窗即結束；瀏覽器分頁關閉後可重新開啟網址）`);
  if (!process.env.NO_OPEN) openUrl(url);
});
