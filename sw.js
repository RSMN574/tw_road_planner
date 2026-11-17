// sw.js — Service Worker：離線快取靜態資源與已載入的路網資料
// 策略：頁面（導航請求）網路優先、失敗用快取；js/css/圖示 stale-while-revalidate；data/*.json 同樣 SWR（大檔，失敗不影響使用）；
// 跨網域（TDX、代理）與非 GET 一律不攔截——即時資料絕不從快取回放，離線時前端會明確顯示「離線」。
const VERSION = 'taiwantong-v1.3.0', CORE = `${VERSION}-core`, RUNTIME = `${VERSION}-rt`;
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
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(CORE).then(x => x.put('index.html', c)).catch(() => {}); return r; })
      .catch(async () => (await caches.match('index.html')) || (await caches.match('./')) || new Response('離線', { status: 503 })));
    return;
  }
  e.respondWith(swr(req));
});
