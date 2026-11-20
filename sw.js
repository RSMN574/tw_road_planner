// sw.js — Service Worker：離線快取靜態資源與已載入的路網資料
// 策略：頁面（導航請求）網路優先、失敗用快取；js/css/圖示 stale-while-revalidate；data/*.json 同樣 SWR（大檔，失敗不影響使用）；
// 跨網域（TDX、代理）與非 GET 一律不攔截——即時資料絕不從快取回放，離線時前端會明確顯示「離線」。
// 伺服器 API（api/v1/…）不攔截（路線、健康狀態每次都問伺服器）；只有 OSM 地圖圖磚（網址帶圖檔版本）快取優先，最多留 TILE_MAX 張，離線時看過的地圖仍可顯示
const VERSION = 'taiwantong-v1.4.0', CORE = `${VERSION}-core`, RUNTIME = `${VERSION}-rt`, TILES = `${VERSION}-tiles`, TILE_MAX = 3000;
const SHELL = ['./', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CORE).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
async function swr(req) {
  const cache = await caches.open(RUNTIME), hit = await cache.match(req);
  const net = fetch(req).then(r => { if (r && r.ok) cache.put(req, r.clone()).catch(() => {}); return r; }).catch(() => null);   // 空間不足時 put 會失敗，忽略
  return hit || (await net) || new Response('離線且尚未快取', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
async function tile(req) {
  const cache = await caches.open(TILES), hit = await cache.match(req); if (hit) return hit;
  const r = await fetch(req).catch(() => null);
  if (r && r.ok) { cache.put(req, r.clone()).then(() => trimTiles(cache)).catch(() => {}); return r; }
  return r || new Response('{"ok":false}', { status: 503, headers: { 'Content-Type': 'application/json' } });
}
let trimming = false;
async function trimTiles(cache) { if (trimming) return; trimming = true; try { const ks = await cache.keys(); for (const k of ks.slice(0, Math.max(0, ks.length - TILE_MAX))) await cache.delete(k); } finally { trimming = false; } }
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/\/api\/v1\/osm\/tiles\//.test(url.pathname)) { e.respondWith(tile(req)); return; }
  if (/\/api\//.test(url.pathname)) return;                                      // 其他 API：一律走網路
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CORE).then(x => x.put('index.html', c)).catch(() => {}); return r; })
      .catch(async () => (await caches.match('index.html')) || (await caches.match('./')) || new Response('離線', { status: 503 })));
    return;
  }
  e.respondWith(swr(req));
});
