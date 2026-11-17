// 伺服器：靜態檔（壓縮、ETag、白名單）、API（統一格式、錯誤碼、快取、限流）、TDX 代理（token 快取、去重、401 重試、金鑰不外流）、熱重載、大眾運輸、多運具
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const origLog = console.log, origInfo = console.info, origWarn = console.warn; console.info = () => {}; console.warn = () => {};
const { createApp } = await import('../server/server.mjs'); const { readConfig } = await import('../server/config.mjs'); const engine = await import('../server/engine.mjs');
const { lonLatToTWD97: tw } = await import('../js/geo.js'); const { simplify } = engine;
let fails = 0; const ok = (n, c, x = '') => { origLog((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
// ---- 資料 A：5×5 格子（間距 400 m，第 2 列是「國道一號」），TWD97 公分 ----
const DATA = mkdtempSync(path.join(tmpdir(), 'tt-data-')), CACHE = mkdtempSync(path.join(tmpdir(), 'tt-cache-')); mkdirSync(DATA + '/graph');
const LON0 = 120.67, LAT0 = 24.12, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180), G = 400, N = 5, ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
function writeGrid() { const nodes = [], edges = [], roads = {}; let eid = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const [lo, la] = ll(i * G, j * G), [e, n] = tw(lo, la); nodes.push({ id: `n${i}_${j}`, x: Math.round(e * 100), y: Math.round(n * 100) }); }
  const addE = (a, b, name) => { for (const [x, y] of [[a, b], [b, a]]) { edges.push({ from: x, to: y, w: G, edgeId: eid }); (roads[name] = roads[name] || { segments: 0, totalLength: 0, edgeIds: [] }).edgeIds.push(eid++); } };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i + 1 < N) addE(`n${i}_${j}`, `n${i+1}_${j}`, j === 2 ? '國道一號' : `東西${j}路`); if (j + 1 < N) addE(`n${i}_${j}`, `n${i}_${j+1}`, `南北${i}路`); }
  for (const [f, d] of [['nodes', nodes], ['edges', edges], ['roads', roads]]) writeFileSync(`${DATA}/graph/${f}.json`, JSON.stringify(d)); }
writeGrid();
const STATIC = mkdtempSync(path.join(tmpdir(), 'tt-static-')); cpSync(ROOT + '/dist', STATIC, { recursive: true });
writeFileSync(STATIC + '/secret.txt', 'SECRET'); writeFileSync(DATA + '/notes.txt', 'SECRET');
// ---- 假的 TDX（token 端點＋資料端點）----
const up = { token: 0, data: 0, expireNext: false };
const upstream = http.createServer((q, r) => {
  if (q.url === '/token' && q.method === 'POST') { up.token++; up.lastAuth = q.headers.authorization; r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify({ access_token: 'TOKEN' + up.token, expires_in: 3600 })); }
  if (q.url.startsWith('/tdx/')) { if (q.headers.authorization !== 'Bearer TOKEN' + up.token || up.expireNext) { up.expireNext = false; r.writeHead(401); return r.end('expired'); } up.data++; setTimeout(() => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify([{ RouteName: { Zh_tw: '307' }, EstimateTime: 120, path: q.url }])); }, 60); return; }
  r.writeHead(404); r.end();
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r)); const UP = `http://127.0.0.1:${upstream.address().port}`;
const env = { DATA_DIR: DATA, STATIC_DIR: STATIC, CACHE_DIR: CACHE, LOG: '0', RATE_LIMIT_PER_MIN: '1000', ADMIN_TOKEN: 'adm1n', TDX_TOKEN_URL: UP + '/token', TDX_API_KEY: 'SUPER-SECRET-KEY', TDX_UPSTREAM: UP + '/tdx', TDX_CACHE_MS: '300' };
async function boot(extra = {}) { const cfg = { ...readConfig({ ...env, ...extra }), memLimit: 3000 }; engine.loadData(cfg); const h = createApp(cfg), s = http.createServer(h); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { s, h, base: `http://127.0.0.1:${s.address().port}` }; }
const { s: srv, h: app, base: B } = await boot();
const get = (p, o = {}) => fetch(B + p, o), J = async (p, o) => { const r = await get(p, o); return { status: r.status, h: r.headers, j: await r.json() }; };
const raw = (p, headers = {}) => new Promise((res, rej) => http.get(B + p, { headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
const rawPath = p => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: new URL(B).port, path: p, method: 'GET' }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(c).toString() })); }); q.on('error', rej); q.end(); });
const A = (la, lo) => `${la},${lo}`, [o0, a0] = ll(0, 0), [o1, a1] = ll(1600, 1200);
const FROM = A(a0, o0), TO = A(a1, o1);

origLog('① 靜態檔（網頁與路網資料）');
{ const r = await raw('/'); ok('GET / → 首頁', r.status === 200 && r.body.toString().includes('<html') && /text\/html/.test(r.h['content-type']));
  const nb = await raw('/data/graph/nodes.json', { 'accept-encoding': 'br, gzip' }); ok('小檔：記憶體 br 壓縮', nb.h['content-encoding'] === 'br' && JSON.parse(zlib.brotliDecompressSync(nb.body)).length === 25);
  const ng = await raw('/data/graph/nodes.json', { 'accept-encoding': 'gzip' }); ok('不支援 br 的瀏覽器 → gzip', ng.h['content-encoding'] === 'gzip' && JSON.parse(zlib.gunzipSync(ng.body)).length === 25);
  const r2 = await raw('/', { 'if-none-match': r.h.etag }); ok('ETag 相同 → 304，不重送', r2.status === 304 && r2.body.length === 0);
  const sw = await raw('/sw.js'); ok('sw.js：Cache-Control no-cache（Service Worker 才能更新）', sw.status === 200 && sw.h['cache-control'] === 'no-cache' && /javascript/.test(sw.h['content-type']));
  const mf = await raw('/manifest.webmanifest'); ok('manifest MIME 正確', mf.h['content-type'].startsWith('application/manifest+json'));
  const ic = await raw('/icons/icon-192.png'); ok('圖示：長快取', ic.status === 200 && /max-age=604800/.test(ic.h['cache-control']));
  const d1 = await raw('/data/graph/edges.json', { 'accept-encoding': 'gzip' }); ok('大型路網檔：第一次先送原始檔（背景壓縮中）', d1.status === 200 && JSON.parse(d1.body).length === 80);
  await new Promise(r => setTimeout(r, 300)); const d2 = await raw('/data/graph/edges.json', { 'accept-encoding': 'gzip' });
  ok('之後送磁碟上的 gzip 快取（壓縮一次、重複使用）', d2.h['content-encoding'] === 'gzip' && JSON.parse(zlib.gunzipSync(d2.body)).length === 80, `${d1.body.length} → ${d2.body.length} bytes`);
  ok('路網資料：no-cache＋ETag（更新後瀏覽器會拿到新版，沒變就 304）', d2.h['cache-control'] === 'no-cache' && !!d2.h.etag);
  const d3 = await raw('/data/graph/edges.json', { 'if-none-match': d2.h.etag }); ok('路網資料 304', d3.status === 304);
  const sec = await raw('/'); ok('安全標頭：nosniff、Permissions-Policy 只允許本站定位', sec.h['x-content-type-options'] === 'nosniff' && /geolocation=\(self\)/.test(sec.h['permissions-policy']));
  const bad = ['/package.json', '/server/server.mjs', '/.env', '/secret.txt', '/data/notes.txt', '/data/../package.json', '/%2e%2e/package.json', '/data/graph/..%2f..%2f.env', '/js/../server/config.mjs', '/js/%2e%2e/%2e%2e/package.json', '/build.mjs', '/data/.hidden.json'];
  const rs = await Promise.all(bad.map(p => rawPath(p))); ok('白名單外的檔案一律拿不到（伺服器程式、.env、../ 穿越）', rs.every(r => r.status === 404 || r.status === 400 || (r.status === 200 && r.body.includes('<html') && !r.body.includes('SECRET'))) && rs.every(r => !r.body.includes('SECRET') && !r.body.includes('"scripts"') && !r.body.includes('createApp')), rs.map(r => r.status).join(','));
  const nf = await raw('/navigate/somewhere'); ok('不存在的路徑 → 404 JSON（與原 server_2 相同格式）', nf.status === 404 && JSON.parse(nf.body).error === 'Not found'); }

origLog('② API：格式、查詢、錯誤');
{ const h = await J('/api/v1/health'); ok('health：ok、路網資訊、TDX 已設定（但不含金鑰）', h.j.ok && h.j.data.graph.nodes === 25 && h.j.data.tdx.configured && !JSON.stringify(h.j).includes('SUPER-SECRET'));
  const g = await J(`/api/v1/geocode?q=${encodeURIComponent(FROM)}`); ok('geocode：經緯度 → 最近道路', g.j.ok && g.j.data.results[0].type === 'coordinate' && /路|國道/.test(g.j.data.results[0].road), g.j.data.results[0].road);
  const g2 = await J(`/api/v1/geocode?q=${encodeURIComponent('國道')}`); ok('geocode：路名比對', g2.j.ok && g2.j.data.results[0].name === '國道一號' && Math.abs(g2.j.data.results[0].lat - 24.127) < 0.01);
  const [ox, oy] = ll(800 + 3, 800 + 150); const rv = await J(`/api/v1/reverse?lat=${oy}&lon=${ox}`); ok('reverse：吸附到最近道路並回傳路名與距離', rv.j.ok && rv.j.data.road === '南北2路' && rv.j.data.distanceM <= 5, `${rv.j.data.road} ${rv.j.data.distanceM} m`);
  const nb = await J(`/api/v1/nearby-roads?lat=${oy}&lon=${ox}&radius=300`); ok('nearby-roads：半徑內道路依距離排序', nb.j.ok && nb.j.data.roads.length >= 2 && nb.j.data.roads.every((r, i, a) => !i || a[i - 1].distanceM <= r.distanceM), nb.j.data.roads.map(r => r.name).join('、'));
  const r = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car`), R = r.j.data;
  ok('route（汽車）：比較三條候選，含距離／時間／幾何／逐步導航', r.j.ok && ['shortest', 'fastest', 'pref'].every(k => R.routes.some(x => x.key === k && x.ok)) && R.routes.every(x => x.geometry.length >= 2 && x.steps[0].type === 'start' && x.steps.at(-1).type === 'arrive'));
  const f = R.routes.find(x => x.key === 'fastest'); ok('最快路線走國道並標示收費長度', f.tollM > 0 && f.roads.includes('國道一號'), `${f.distanceM} m、${f.durationS} s、國道 ${f.tollM} m`);
  ok('幾何是 WGS84 經緯度、落在路網範圍內', f.geometry.every(([lo, la]) => lo > 120.66 && lo < 120.69 && la > 24.11 && la < 24.14));
  ok('起點吸附資訊', R.from.snapM <= 2 && R.from.node === 'n0_0');
  const t = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car&avoidToll=1`); ok('避開國道：每條收費長度 0', t.j.data.routes.every(x => !x.ok || x.tollM === 0));
  const w = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=walk`); ok('步行：不走國道', w.j.ok && w.j.data.routes.every(x => !x.ok || !x.roads.includes('國道一號')));
  const k = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car&goal=alt&k=4`); ok('goal=alt：Yen 多條替代路線', k.j.ok && k.j.data.routes.length >= 2 && k.j.data.routes[0].key === 'k0', k.j.ok ? k.j.data.routes.map(x => x.key + ':' + x.durationS + 's').join(' ') : JSON.stringify(k.j.error));
  const pa = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=bike&goal=pareto`); ok('goal=pareto：多目標', pa.j.ok && pa.j.data.routes.length >= 1);
  const post = await J('/api/v1/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: { lat: a0, lon: o0 }, to: { lat: a1, lon: o1 }, mode: 'car' }) });
  ok('POST JSON（物件座標）結果與 GET 一致', post.j.ok && post.j.data.routes.find(x => x.key === 'fastest').distanceM === f.distanceM);
  const again = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car`); ok('相同查詢第二次走快取（meta.cached）', again.j.meta.cached === true && again.j.meta.graphVersion === r.j.meta.graphVersion);
  const ns = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car&steps=0&simplify=0`); ok('steps=0 不回逐步；simplify=0 回完整幾何', !ns.j.data.routes[0].steps && ns.j.data.routes[0].geometryPoints.original === ns.j.data.routes[0].geometry.length);
  const e1 = await J(`/api/v1/route?to=${TO}`); ok('缺起點 → 400 BAD_COORD（統一錯誤格式含 requestId）', e1.status === 400 && e1.j.ok === false && e1.j.error.code === 'BAD_COORD' && e1.j.meta.requestId && e1.h.get('x-request-id') === e1.j.meta.requestId);
  const e2 = await J(`/api/v1/route?from=25.03,121.56&to=${TO}`); ok('起點在路網範圍外（台北）→ 422 OUT_OF_COVERAGE', e2.status === 422 && e2.j.error.code === 'OUT_OF_COVERAGE');
  const e3 = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=plane`); ok('不支援的交通方式 → 400 BAD_MODE', e3.status === 400 && e3.j.error.code === 'BAD_MODE');
  const e4 = await J('/api/v1/nope'); ok('不存在的 API → 404 JSON', e4.status === 404 && e4.j.error.code === 'NOT_FOUND');
  const e5 = await J('/api/v1/geocode', { method: 'POST' }); ok('方法不對 → 405', e5.status === 405 && e5.j.error.code === 'METHOD_NOT_ALLOWED');
  const e6 = await J('/api/v1/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' }); ok('壞掉的 JSON → 400 BAD_JSON', e6.status === 400 && e6.j.error.code === 'BAD_JSON');
  const e7 = await J('/api/v1/route', { method: 'POST', body: 'x'.repeat(70000) }); ok('請求太大 → 413', e7.status === 413 && e7.j.error.code === 'BODY_TOO_LARGE');
  const e8 = await J('/api/v1/traffic'); ok('即時交通：沒有資料來源 → 501（不給假資料）', e8.status === 501 && e8.j.error.code === 'NO_DATA_SOURCE');
  const e9 = await J(`/api/v1/transit?from=${FROM}&to=${TO}`); ok('沒有公車／捷運資料 → 503 NO_TRANSIT_DATA', e9.status === 503 && e9.j.error.code === 'NO_TRANSIT_DATA');
  const e10 = await J(`/api/v1/route?from=${FROM}&to=${FROM}`); ok('起訖同點 → 422 SAME_POINT', e10.status === 422 && e10.j.error.code === 'SAME_POINT'); }

origLog('③ 幾何簡化');
{ const line = Array.from({ length: 50 }, (_, i) => [120.6 + i * 1e-4, 24.1]); ok('共線的 50 點 → 只剩兩端點', simplify(line, 1).length === 2);
  const zig = [[120.6, 24.1], [120.6005, 24.10003], [120.601, 24.1]]; ok('偏離 3.3 m 的轉折：容差 2 m 保留、5 m 移除', simplify(zig, 2).length === 3 && simplify(zig, 5).length === 2); }

origLog('④ 限流');
{ const { s, base } = await boot({ RATE_LIMIT_PER_MIN: '3' }); const rs = []; for (let i = 0; i < 5; i++) rs.push(await fetch(`${base}/api/v1/geocode?q=國道`));
  ok('超過每分鐘上限 → 429 RATE_LIMITED＋Retry-After', rs.slice(0, 3).every(r => r.status === 200) && rs[3].status === 429 && +rs[3].headers.get('retry-after') > 0 && (await rs[4].json()).error.code === 'RATE_LIMITED');
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

origLog('⑥ 熱重載與大眾運輸（公車＋捷運，真實 metro.json）');
{ const P = { G6: [120.68486, 24.17219], G9: [120.64903, 24.16199], G17: [120.61405, 24.11011] }, m2 = (m, lat) => m / (111320 * Math.cos(lat * Math.PI / 180)), nd = (lo, la) => { const [e, n] = tw(lo, la); return { x: Math.round(e * 100), y: Math.round(n * 100) }; };
  const oLon = P.G6[0] + m2(60, 24.17), oLat = P.G6[1], dLon = P.G17[0] + m2(80, 24.11), dLat = P.G17[1];
  writeFileSync(DATA + '/graph/nodes.json', JSON.stringify([{ id: 'o', ...nd(oLon, oLat) }, { id: 'd', ...nd(dLon, dLat) }]));
  writeFileSync(DATA + '/graph/edges.json', JSON.stringify([{ from: 'o', to: 'd', w: 9000, edgeId: 'e' }, { from: 'd', to: 'o', w: 9000, edgeId: 'e2' }])); writeFileSync(DATA + '/graph/roads.json', JSON.stringify({ 文心路: { edgeIds: ['e', 'e2'] } }));
  cpSync(ROOT + '/test/fixtures/metro.json', DATA + '/metro.json'); mkdirSync(DATA + '/bus', { recursive: true });
  writeFileSync(DATA + '/bus/graph.json', JSON.stringify({ nodes: { BA: { node_name: '公車起點', latitude: oLat, longitude: oLon + m2(40, 24.17) }, BB: { node_name: '公車終點', latitude: P.G9[1], longitude: P.G9[0] + m2(70, 24.16) } }, adjacency: { BA: [{ to: 'BB', distance_meters: 4200, route_name: 'B1', route_uid: 'uB1', travel_times: [{ run_time: 900 }] }] } }));
  const v0 = (await J('/api/v1/health')).j.data.graph.graphVersion;
  ok('沒有管理 token → 401', (await J('/api/v1/admin/reload', { method: 'POST' })).status === 401);
  const rl = await J('/api/v1/admin/reload', { method: 'POST', headers: { Authorization: 'Bearer adm1n' } }); ok('POST admin/reload：重新建圖並載入公車＋捷運', rl.j.ok && rl.j.data.nodes === 2 && rl.j.data.data.metro && rl.j.data.data.bus);
  const h = (await J('/api/v1/health')).j.data; ok('health：路網版本改變、提供 metro／bus 檔案網址給網頁自動載入', h.graph.graphVersion > v0 && h.files.metro === 'data/metro.json' && h.files.bus === 'data/bus/graph.json');
  ok('網頁可下載同一份 metro.json', (await raw('/data/metro.json')).status === 200);
  const T = await J(`/api/v1/transit?from=${oLat},${oLon}&to=${dLat},${dLon}&goal=fastest`);
  ok('transit：回傳多種方案與推薦', T.j.ok && T.j.data.options.length >= 1 && T.j.data.options[T.j.data.recommended].recommended, T.j.ok ? T.j.data.options.map(o => o.rides.map(r => (r.kind === 'metro' ? '🚇' : '🚌') + r.route).join('→') + ` ${Math.round(o.totalS / 60)}分`).join('｜') : JSON.stringify(T.j.error));
  const mo = T.j.ok && T.j.data.options.find(o => o.rides.some(r => r.kind === 'metro')); ok('含捷運方案，站名與經緯度正確', !!mo && /文心崇德|G6/.test(JSON.stringify(mo)) && mo.rides[0].geometry.length >= 2, mo ? mo.rides.map(r => `${r.from.name}→${r.to.name}`).join('、') : '');
  ok('標示為系統推估', /推估/.test(T.j.data.estimate));
  const T2 = await J(`/api/v1/transit?from=${oLat},${oLon}&to=${dLat},${dLon}&goal=lesswalk`); ok('goal=lesswalk：推薦步行最短的方案', T2.j.ok && T2.j.data.options[T2.j.data.recommended].walkM === Math.min(...T2.j.data.options.map(o => o.walkM)));
  const M = await J(`/api/v1/multimodal?from=${oLat},${oLon}&to=${dLat},${dLon}&modes=car,walk,transit`); ok('multimodal：各交通方式最快一條，依時間排序', M.j.ok && M.j.data.options.length === 3 && M.j.data.options.filter(o => o.ok).every((o, i, a) => !i || a[i - 1].durationS <= o.durationS), M.j.ok ? M.j.data.options.map(o => `${o.mode}:${o.ok ? Math.round(o.durationS / 60) + '分' : o.error.code}`).join('、') : '');
  const old = await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car`); ok('換資料後舊快取不會被用到（舊座標現在超出範圍）', old.status === 422 && old.j.error.code === 'OUT_OF_COVERAGE'); }

origLog('⑦ 大路網：A* 地標多組快取（比較模式不再每次重建）');
{ const n = 150, nodes = [], edges = []; let eid = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const [lo, la] = ll(i * 100, j * 100), [e, nn] = tw(lo, la); nodes.push({ id: `g${i}_${j}`, x: Math.round(e * 100), y: Math.round(nn * 100) }); }
  const add = (a, b) => { for (const [x, y] of [[a, b], [b, a]]) edges.push({ from: x, to: y, w: 100 + (eid % 7) * 3, edgeId: eid++ }); };
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { if (i + 1 < n) add(`g${i}_${j}`, `g${i+1}_${j}`); if (j + 1 < n) add(`g${i}_${j}`, `g${i}_${j+1}`); }
  writeFileSync(DATA + '/graph/nodes.json', JSON.stringify(nodes)); writeFileSync(DATA + '/graph/edges.json', JSON.stringify(edges)); writeFileSync(DATA + '/graph/roads.json', '{}');
  await J('/api/v1/admin/reload', { method: 'POST', headers: { Authorization: 'Bearer adm1n' } });
  let builds = 0; console.info = m => { if (/ALT 地標預處理/.test(String(m))) builds++; };
  const q = (a, b) => J(`/api/v1/route?from=${A(ll(a, a)[1], ll(a, a)[0])}&to=${A(ll(b, b * 0.7)[1], ll(b, b * 0.7)[0])}&mode=car&steps=0&algo=astar`);
  const r1 = await q(200, 12000), b1 = builds, r2 = await q(900, 13500), r3 = await q(1500, 11000);
  const d = await J(`/api/v1/route?from=${A(ll(1500, 1500)[1], ll(1500, 1500)[0])}&to=${A(ll(11000, 7700)[1], ll(11000, 7700)[0])}&mode=car&steps=0&algo=dijkstra`);
  ok('第一次查詢建好 3 組地標（最短／最快／依偏好），之後不再重建', b1 === 3 && builds === 3, `建立 ${builds} 次`);
  ok('A* 結果與 Dijkstra 相同（啟發式只用下界）', r3.j.data.routes.every((x, i) => x.distanceM === d.j.data.routes[i].distanceM && x.durationS === d.j.data.routes[i].durationS));
  ok('之後的查詢比第一次快很多', r2.j.meta.ms < r1.j.meta.ms / 3, `第一次 ${r1.j.meta.ms} ms → ${r2.j.meta.ms} ms、${r3.j.meta.ms} ms（Dijkstra ${d.j.meta.ms} ms）`); console.info = () => {}; }

origLog('⑫ 路網封包 graph.bin（網頁優先下載；伺服器重啟直接讀封包）');
{ const { readPackHeader } = await import('../js/graph-pack.js'); const { gunzipSync, brotliDecompressSync } = await import('node:zlib');
  await engine.graphPack().ready;
  const r0 = await raw('/data/graph/graph.bin', { 'accept-encoding': 'identity' }), hd = readPackHeader(r0.body).head;
  ok('graph.bin 可下載、是路網封包、節點數正確', r0.status === 200 && hd.N === engine.dataInfo().nodes && r0.h['content-type'] === 'application/octet-stream', `${r0.body.length} bytes`);
  const rb = await raw('/data/graph/graph.bin', { 'accept-encoding': 'br, gzip' }), rg = await raw('/data/graph/graph.bin', { 'accept-encoding': 'gzip' });
  ok('支援 br／gzip 壓縮傳輸，解壓後內容相同', rb.h['content-encoding'] === 'br' && rg.h['content-encoding'] === 'gzip' && Buffer.compare(brotliDecompressSync(rb.body), r0.body) === 0 && Buffer.compare(gunzipSync(rg.body), r0.body) === 0, `br ${rb.body.length}／gzip ${rg.body.length}`);
  const r304 = await raw('/data/graph/graph.bin', { 'if-none-match': r0.h.etag }); ok('ETag 沒變 → 304', r304.status === 304);
  const hh = await J('/api/v1/health'); ok('health 顯示封包大小', hh.j.data.graph.pack && hh.j.data.graph.pack.bytes === r0.body.length);
  const before = (await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car&steps=0`)).j.data.routes.map(x => [x.distanceM, x.durationS]).join();
  const info = engine.loadData({ ...readConfig(env), memLimit: 3000 });
  const after = (await J(`/api/v1/route?from=${FROM}&to=${TO}&mode=car&steps=0&_=2`)).j.data.routes.map(x => [x.distanceM, x.durationS]).join();
  ok('重新載入：直接讀快取的封包，路線結果與從 JSON 建圖時相同', info.loadedFrom === 'pack' && before === after, `來源 ${info.loadedFrom}`);
  const e0 = r0.h.etag; writeGrid(); const t = new Date(Date.now() + 5000); (await import('node:fs')).utimesSync(`${DATA}/graph/edges.json`, t, t);
  const info2 = engine.loadData({ ...readConfig(env), memLimit: 3000 }), r2 = await raw('/data/graph/graph.bin', { 'accept-encoding': 'identity' });
  ok('路網 JSON 有變動：重新從 JSON 建圖並產生新封包（ETag 改變）', info2.loadedFrom === 'json' && r2.h.etag !== e0);
  const files = (await import('node:fs')).readdirSync(CACHE).filter(f => /^graph-.*\.bin$/.test(f)); ok('舊的封包快取會被清掉（只留一份）', files.length === 1, files.join(','));
}

srv.close(); upstream.close(); origLog(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
