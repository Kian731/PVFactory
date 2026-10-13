// IndexedDB 簡易封裝：浮水印圖庫(wm)、其他資料(kv，如輸出資料夾 handle)
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('imgtool', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('wm', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    wmAll: () => tx('wm', 'readonly', s => s.getAll()).catch(() => []),
    wmPut: v => tx('wm', 'readwrite', s => s.put(v)),
    wmDel: id => tx('wm', 'readwrite', s => s.delete(id)),
    kvGet: k => tx('kv', 'readonly', s => s.get(k)).catch(() => null),
    kvPut: (k, v) => tx('kv', 'readwrite', s => s.put(v, k)),
    kvDel: k => tx('kv', 'readwrite', s => s.delete(k)),
  };
})();
