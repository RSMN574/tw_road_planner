// 伺服器：靜態檔（壓縮、ETag、白名單）、API（統一格式、錯誤碼、限流）、TDX 代理（token 快取、去重、401 重試、金鑰不外流）、管理用重新載入
// v1.18：舊的台中路網（engine.mjs）與它的 API 已移除——這裡改測「舊 API 回 410 並指向新 API」、「不再提供 data/」；OSM 路線、大眾運輸在 server-osm.mjs、transit-*.mjs、via.mjs 測
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origLog = console.log, origInfo = console.info, origWarn = console.warn; console.info = () => {}; console.warn = () => {};
const { createApp } = await import('../server/server.mjs'); const { readConfig } = await import('../server/config.mjs');
let fails = 0; const ok = (n, c, x = '') => { origLog((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
// ---- 資料夾：沒有 OSM 圖檔（OSM API 回 503）；data/ 裡放一個 JSON，確認不會被當成靜態檔送出去 ----
const DATA = mkdtempSync(path.join(tmpdir(), 'tt-data-')), CACHE = mkdtempSync(path.join(tmpdir(), 'tt-cache-')); mkdirSync(DATA + '/graph');
writeFileSync(DATA + '/graph/nodes.json', '[]'); writeFileSync(DATA + '/metro.json', '{}');
const STATIC = mkdtempSync(path.join(tmpdir(), 'tt-static-')); cpSync(ROOT + '/dist', STATIC, { recursive: true });
writeFileSync(STATIC + '/secret.txt', 'SECRET'); const SMALL = '// small\n' + 'const x = 1;\n'.repeat(150); mkdirSync(STATIC + '/js', { recursive: true }); writeFileSync(STATIC + '/js/small.js', SMALL); writeFileSync(DATA + '/notes.txt', 'SECRET');
// ---- 假的 TDX（token 端點＋資料端點）----
const up = { token: 0, data: 0, expireNext: false };
const upstream = http.createServer((q, r) => {
  if (q.url === '/token' && q.method === 'POST') { up.token++; up.lastAuth = q.headers.authorization; r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ access_token: 'TOKEN' + up.token, expires_in: 3600 })); }
  if (q.url.startsWith('/tdx/')) { if (q.headers.authorization !== 'Bearer TOKEN' + up.token || up.expireNext) { up.expireNext = false; r.writeHead(401); return r.end('expired'); } up.data++; setTimeout(() => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify([{ RouteName: { Zh_tw: '307' }, EstimateTime: 120, path: q.url }])); }, 60); return; }
  r.writeHead(404); r.end();
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r)); const UP = `http://127.0.0.1:${upstream.address().port}`;
const env = { DATA_DIR: DATA, STATIC_DIR: STATIC, CACHE_DIR: CACHE, LOG: '0', RATE_LIMIT_PER_MIN: '1000', ADMIN_TOKEN: 'adm1n', TDX_TOKEN_URL: UP + '/token', TDX_API_KEY: 'SUPER-SECRET-KEY', TDX_UPSTREAM: UP + '/tdx', TDX_CACHE_MS: '300' };
async function boot(extra = {}) { const cfg = { ...readConfig({ ...env, OSM: '0', ...extra }), memLimit: 3000 }; const h = createApp(cfg), s = http.createServer(h); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { s, h, base: `http://127.0.0.1:${s.address().port}` }; }
const { s: srv, h: app, base: B } = await boot();
const get = (p, o = {}) => fetch(B + p, o), J = async (p, o) => { const r = await get(p, o); return { status: r.status, h: r.headers, j: await r.json() }; };
const raw = (p, headers = {}) => new Promise((res, rej) => http.get(B + p, { headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
const rawPath = p => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: new URL(B).port, path: p, method: 'GET' }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString() })); }); q.on('error', rej); q.end(); });
origLog('① 靜態檔（網頁）');
{ const r = await raw('/'); ok('GET / → 首頁', r.status === 200 && r.body.toString().includes('<html') && /text\/html/.test(r.h['content-type']));
  const jb = await raw('/js/small.js', { 'accept-encoding': 'br, gzip' }); ok('小檔：記憶體 br 壓縮', jb.status === 200 && jb.h['content-encoding'] === 'br' && zlib.brotliDecompressSync(jb.body).toString() === SMALL);
  const jg = await raw('/js/small.js', { 'accept-encoding': 'gzip' }); ok('不支援 br 的瀏覽器 → gzip', jg.h['content-encoding'] === 'gzip' && zlib.gunzipSync(jg.body).toString() === SMALL);
  const d1 = await raw('/index.html', { 'accept-encoding': 'gzip' }); ok('大檔（超過記憶體快取上限）：第一次先送原始檔（背景壓縮中）', d1.status === 200 && !d1.h['content-encoding'] && d1.body.toString().includes('<html'));
  await new Promise(r => setTimeout(r, 500)); const d2 = await raw('/index.html', { 'accept-encoding': 'gzip' });
  ok('之後送磁碟上的 gzip 快取（壓縮一次、重複使用）', d2.h['content-encoding'] === 'gzip' && zlib.gunzipSync(d2.body).toString() === d1.body.toString(), `${d1.body.length} → ${d2.body.length} bytes`);
  const r2 = await raw('/', { 'if-none-match': r.h.etag }); ok('ETag 相同 → 304，不重送', r2.status === 304 && r2.body.length === 0);
  const sw = await raw('/sw.js'); ok('sw.js：Cache-Control no-cache（Service Worker 才能更新）', sw.status === 200 && sw.h['cache-control'] === 'no-cache' && /javascript/.test(sw.h['content-type']));
  const mf = await raw('/manifest.webmanifest'); ok('manifest MIME 正確', mf.h['content-type'].startsWith('application/manifest+json'));
  const ic = await raw('/icons/icon-192.png'); ok('圖示：長快取', ic.status === 200 && /max-age=604800/.test(ic.h['cache-control']));
  const dd = await Promise.all(['/data/graph/nodes.json', '/data/metro.json', '/data/graph/graph.bin'].map(p => raw(p)));
  ok('v1.18：data/ 不再當成靜態檔提供（舊的本機路網已移除；OSM 圖檔不公開下載）', dd.every(x => x.status === 404 && !x.body.toString().includes('[]')), dd.map(x => x.status).join('、'));
  const sec = await raw('/'); ok('安全標頭：nosniff、Permissions-Policy 只允許本站定位', sec.h['x-content-type-options'] === 'nosniff' && /geolocation=\(self\)/.test(sec.h['permissions-policy']));
  const bad = ['/package.json', '/server/server.mjs', '/.env', '/secret.txt', '/data/notes.txt', '/data/../package.json', '/%2e%2e/package.json', '/data/..%2f..%2f.env', '/js/../server/config.mjs', '/js/%2e%2e/%2e%2e/package.json', '/build.mjs', '/data/.hidden.json'];
  const rs = await Promise.all(bad.map(p => rawPath(p))); ok('白名單外的檔案一律拿不到（伺服器程式、.env、../ 穿越）', rs.every(r => r.status === 404 || r.status === 400 || (r.status === 200 && r.body.includes('<html') && !r.body.includes('SECRET'))) && rs.every(r => !r.body.includes('SECRET') && !r.body.includes('"scripts"') && !r.body.includes('createApp')), rs.map(r => r.status).join(','));
  const nf = await raw('/navigate/somewhere'); ok('不存在的路徑 → 404 JSON（與原 server_2 相同格式）', nf.status === 404 && JSON.parse(nf.body).error === 'Not found'); }

origLog('② API：格式、錯誤、已移除的舊 API');
{ const h = await J('/api/v1/health'); ok('health：版本、OSM 狀態、TDX 已設定（但不含金鑰）；不再有舊路網欄位', h.j.ok && h.j.data.version && h.j.data.osm && h.j.data.osm.loaded === false && h.j.data.status === 'loading' && h.j.data.tdx.configured && !('graph' in h.j.data) && !JSON.stringify(h.j).includes('SUPER-SECRET'));
  ok('meta 帶 OSM 版本，不再有 graphVersion', 'osmVersion' in h.j.meta && !('graphVersion' in h.j.meta));
  const gone = [['/api/v1/route?from=24.1,120.6&to=24.2,120.7', '/api/v1/osm/route'], ['/api/v1/transit', '/api/v1/transit/plan'], ['/api/v1/multimodal', '/api/v1/transit/plan'], ['/api/v1/geocode?q=x', '/api/v1/osm/search'], ['/api/v1/reverse', '/api/v1/osm/nearest'], ['/api/v1/nearby-roads', '/api/v1/osm/nearest'], ['/api/v1/traffic', '/api/v1/traffic/flow']];
  const gr = await Promise.all(gone.map(([p]) => J(p)));
  ok('舊路網的 API → 410 GONE，訊息指出新的 API', gr.every((r, i) => r.status === 410 && r.j.error.code === 'GONE' && r.j.error.message.includes(gone[i][1])), gr.map(r => r.status).join('、'));
  const gp = await J('/api/v1/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); ok('POST 舊 API 也是 410', gp.status === 410);
  const o = await J('/api/v1/osm/route?from=24.1,120.6&to=24.2,120.7'); ok('沒有 OSM 圖檔 → 503 OSM_NOT_LOADED（明確說明）', o.status === 503 && o.j.error.code === 'OSM_NOT_LOADED');
  const ts = await Promise.all(['/api/v1/transit/stops?bbox=120.6,24.1,120.61,24.11', '/api/v1/transit/stop?uid=TXG1', '/api/v1/transit/vehicles?pattern=TXG1%7C0'].map(p => J(p)));
  ok('v1.19 公車站牌、到站、車輛 API：沒有 OSM 圖檔 → 503（不回假資料）', ts.every(r => r.status === 503 && r.j.error.code === 'OSM_NOT_LOADED'), ts.map(r => r.status).join('、'));
  const e4 = await J('/api/v1/nope'); ok('不存在的 API → 404 JSON（含 requestId）', e4.status === 404 && e4.j.error.code === 'NOT_FOUND' && e4.j.meta.requestId && e4.h.get('x-request-id') === e4.j.meta.requestId);
  const e5 = await J('/api/v1/osm/search', { method: 'POST' }); ok('方法不對 → 405', e5.status === 405 && e5.j.error.code === 'METHOD_NOT_ALLOWED');
  const e6 = await J('/api/v1/osm/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }); ok('壞掉的 JSON → 400 BAD_JSON', e6.status === 400 && e6.j.error.code === 'BAD_JSON');
  const e7 = await J('/api/v1/osm/route', { method: 'POST', body: 'x'.repeat(70000) }); ok('請求太大 → 413', e7.status === 413 && e7.j.error.code === 'BODY_TOO_LARGE'); }

origLog('④ 限流');
{ const { s, base } = await boot({ RATE_LIMIT_PER_MIN: '3' }); const rs = []; for (let i = 0; i < 5; i++) rs.push(await fetch(`${base}/api/v1/osm/search?q=國道`));
  ok('超過每分鐘上限 → 429 RATE_LIMITED＋Retry-After', rs.slice(0, 3).every(r => r.status !== 429) && rs[3].status === 429 && +rs[3].headers.get('retry-after') > 0 && (await rs[4].json()).error.code === 'RATE_LIMITED');
  ok('health 不受限流', (await fetch(`${base}/api/v1/health`)).status === 200); s.close(); }

origLog('⑤ TDX 代理');
{ const p = '/tdx/api/Bus/EstimatedTimeOfArrival/City/Taichung/307?%24format=JSON';
  const rs = await Promise.all([1, 2, 3, 4].map(() => raw(p)));
  ok('同時 4 個相同請求 → 上游只被打 1 次（請求去重）', rs.every(r => r.status === 200) && up.data === 1 && up.token === 1, `上游 ${up.data} 次、token ${up.token} 次`);
  ok('上游收到正確的 Bearer 金鑰（只在伺服器端）', up.lastAuth === 'Bearer SUPER-SECRET-KEY');
  ok('回應不含金鑰與 token', rs.every(r => !r.body.toString().includes('SUPER-SECRET') && !r.body.toString().includes('TOKEN1')) && !JSON.stringify(rs[0].h).includes('SUPER-SECRET'));
  const c = await raw(p); ok('短時間內重複 → 伺服器快取（X-Cache: HIT）', c.h['x-cache'] === 'HIT' && up.data === 1);
  await new Promise(r => setTimeout(r, 350)); up.expireNext = true; const e = await raw(p); ok('token 過期（401）→ 自動換新 token 重試', e.status === 200 && up.token === 2, `token ${up.token} 次`);
  const bp = await rawPath('/tdx/api/Bus/../../etc/passwd'); ok('路徑含 .. → 400（不轉送到上游）', bp.status === 400 && /BAD_PATH/.test(bp.body));
  const np = await J('/tdx/api/Bus/X', { method: 'POST' }); ok('TDX 代理只接受 GET', np.status === 405);
  const { s, base } = await boot({ TDX_TOKEN_URL: '', TDX_API_KEY: '' }); const nr = await fetch(`${base}/tdx/api/Bus/X`); const nj = await nr.json();
  ok('沒設定金鑰 → 503 TDX_NOT_CONFIGURED（明確說明）', nr.status === 503 && nj.error.code === 'TDX_NOT_CONFIGURED'); s.close(); }

origLog('⑥ 管理用重新載入');
{ ok('沒有管理 token → 401', (await J('/api/v1/admin/reload', { method: 'POST' })).status === 401);
  ok('token 錯誤 → 401', (await J('/api/v1/admin/reload', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status === 401);
  const rl = await J('/api/v1/admin/reload', { method: 'POST', headers: { Authorization: 'Bearer adm1n' } }); ok('POST admin/reload：重新載入 OSM 道路圖（這裡沒有圖檔 → loaded=false 並說明原因）', rl.j.ok && rl.j.data.reloaded && rl.j.data.osm && rl.j.data.osm.loaded === false, rl.j.ok ? String(rl.j.data.osm.reason || rl.j.data.osm.error || '') : rl.j.error.code); }

srv.close(); upstream.close(); origLog(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
