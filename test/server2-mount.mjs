// bus-planner 掛在 server_2（Express）裡的整合測試：在 server_2 根目錄執行
//   node bus-planner/test/server2-mount.mjs
// 檢查：原本的路由行為不變、/bus-planner/ 底下的網頁／資料／API／TDX 代理都正常、bus-planner 的請求不吃掉原本的限流額度與 body
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const HERE = path.dirname(fileURLToPath(import.meta.url)), APP = path.resolve(HERE, '../../app.js');
if (!existsSync(APP)) { console.log('略過：這個測試要放在 server_2 裡（找不到 ../../app.js）'); process.exit(0); }
const log0 = console.log; console.info = () => {};
let fails = 0; const ok = (n, c, x = '') => { log0((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
// ---- 測試資料：小格子路網、假的 token.txt、假的 TDX ----
const T = mkdtempSync(path.join(tmpdir(), 'bp-s2-')); mkdirSync(T + '/graph');
const { lonLatToTWD97: tw } = await import('../js/geo.js');
const LON0 = 120.67, LAT0 = 24.12, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180), G = 400, N = 4, ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
const nodes = [], edges = [], roads = {}; let eid = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const [lo, la] = ll(i * G, j * G), [e, n] = tw(lo, la); nodes.push({ id: `n${i}_${j}`, x: Math.round(e * 100), y: Math.round(n * 100) }); }
const addE = (a, b, nm) => { for (const [x, y] of [[a, b], [b, a]]) { edges.push({ from: x, to: y, w: G, edgeId: eid }); (roads[nm] = roads[nm] || { edgeIds: [] }).edgeIds.push(eid++); } };
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i + 1 < N) addE(`n${i}_${j}`, `n${i+1}_${j}`, `東西${j}路`); if (j + 1 < N) addE(`n${i}_${j}`, `n${i}_${j+1}`, `南北${i}路`); }
for (const [f, d] of [['nodes', nodes], ['edges', edges], ['roads', roads]]) writeFileSync(`${T}/graph/${f}.json`, JSON.stringify(d));
writeFileSync(T + '/token.txt', 'TOKEN-FROM-SERVER2\n');
const up = []; const tdx = http.createServer((q, r) => { up.push({ url: q.url, auth: q.headers.authorization }); r.writeHead(200, { 'Content-Type': 'application/json' }); r.end('[{"EstimateTime":60}]'); });
await new Promise(r => tdx.listen(0, '127.0.0.1', r));
Object.assign(process.env, { TOKEN_FILE: T + '/token.txt', BUS_PLANNER_DATA_DIR: T, BUS_PLANNER_CACHE_DIR: T + '/cache', BUS_PLANNER_TDX_UPSTREAM: `http://127.0.0.1:${tdx.address().port}`, API_KEY: 'k' });
async function boot(extra = {}) {
  Object.assign(process.env, extra);
  const { createApp } = await import(APP + '?v=' + Math.random()); const s = createApp().listen(0); await new Promise(r => s.once('listening', r));
  const B = `http://127.0.0.1:${s.address().port}`; for (let i = 0; i < 50; i++) { const h = await (await fetch(B + '/bus-planner/api/v1/health')).json(); if (h.data.graph) break; await new Promise(r => setTimeout(r, 50)); }
  return { s, B };
}
const raw = (B, p, headers = {}, method = 'GET', body) => new Promise((res, rej) => { const q = http.request(B + p, { method, headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }); q.on('error', rej); if (body) q.write(body); q.end(); });

let { s, B } = await boot();
log0('① 原本的 server_2 路由不變');
{ const a = await raw(B, '/api/airports'); ok('GET /api/airports 照舊', a.status === 200 && !!JSON.parse(a.body).airports);
  const c = await raw(B, '/api/metro/cities'); ok('GET /api/metro/cities 照舊（原本寫死 /home/rsmn 路徑的 /api/metro/:city 不在本測試範圍）', c.status === 200 && JSON.parse(c.body).length === 3);
  ok('POST /tokens 驗證規則照舊（401／403／400）', (await raw(B, '/tokens', {}, 'POST')).status === 401 && (await raw(B, '/tokens', { authorization: 'Bearer x', 'x-timestamp': '1' }, 'POST')).status === 403 && (await raw(B, '/tokens', { authorization: 'Bearer k' }, 'POST')).status === 400);
  const t = await raw(B, '/tokens', { authorization: 'Bearer k', 'x-timestamp': '1' }, 'POST'); ok('POST /tokens 回傳 token.txt（照舊）', t.status === 200 && JSON.parse(t.body).token === 'TOKEN-FROM-SERVER2');
  const nf = await raw(B, '/nope'); ok('不存在的路徑 → { error: "Not found" }（原本的錯誤處理）', nf.status === 404 && JSON.parse(nf.body).error === 'Not found');
  ok('原本的 CORS 設定照舊', (await raw(B, '/api/airports', { origin: 'http://localhost:8080' })).h['access-control-allow-origin'] === 'http://localhost:8080'); }

log0('② /bus-planner/ 底下');
{ const r = await raw(B, '/bus-planner'); ok('/bus-planner → 301 /bus-planner/（相對路徑才正確）', r.status === 301 && r.h.location === '/bus-planner/');
  const i = await raw(B, '/bus-planner/', { 'accept-encoding': 'br' }); ok('/bus-planner/ → 網頁（br 壓縮）', i.status === 200 && zlib.brotliDecompressSync(i.body).toString().includes('<html'));
  ok('sw.js、manifest、圖示', (await raw(B, '/bus-planner/sw.js')).status === 200 && (await raw(B, '/bus-planner/manifest.webmanifest')).status === 200 && (await raw(B, '/bus-planner/icons/icon-192.png')).status === 200);
  const d = await raw(B, '/bus-planner/data/graph/nodes.json'); ok('路網資料 /bus-planner/data/graph/*.json', d.status === 200 && JSON.parse(d.body).length === 16);
  const h = JSON.parse((await raw(B, '/bus-planner/api/v1/health')).body).data; ok('health：路網已載入、TDX 用 server_2 的 token.txt', h.graph.nodes === 16 && h.tdx.configured && h.tdx.source === 'token.txt');
  const [o0, a0] = ll(0, 0), [o1, a1] = ll(1200, 800); const rt = JSON.parse((await raw(B, `/bus-planner/api/v1/route?from=${a0},${o0}&to=${a1},${o1}&mode=car`)).body);
  ok('GET /bus-planner/api/v1/route', rt.ok && rt.data.routes.some(x => x.ok && x.distanceM === 2000), rt.ok ? rt.data.routes.map(x => x.key + ':' + x.distanceM).join(' ') : JSON.stringify(rt.error));
  const post = await raw(B, '/bus-planner/api/v1/route', { 'content-type': 'application/json' }, 'POST', JSON.stringify({ from: { lat: a0, lon: o0 }, to: { lat: a1, lon: o1 }, mode: 'walk' }));
  ok('POST JSON 也正常（body 沒有被 express.json() 先讀走）', post.status === 200 && JSON.parse(post.body).ok);
  const td = await raw(B, '/bus-planner/tdx/api/Bus/EstimatedTimeOfArrival/City/Taichung/307'); ok('TDX 代理用 server_2 的 token.txt（網頁拿不到 token）', td.status === 200 && up.at(-1).auth === 'Bearer TOKEN-FROM-SERVER2' && !td.body.toString().includes('TOKEN-FROM'));
  ok('bus-planner 的 404 不會掉進原本的錯誤處理', (await raw(B, '/bus-planner/nope.txt')).status === 404);
  ok('../ 路徑穿越被擋（拿不到 server_2 的 .env、程式）', [(await raw(B, '/bus-planner/../.env')).status, (await raw(B, '/bus-planner/%2e%2e/app.js')).status, (await raw(B, '/bus-planner/server/server.mjs')).status, (await raw(B, '/bus-planner/package.json')).status].every(x => x === 404 || x === 400)); }

log0('③ 互不干擾');
{ const before = (await raw(B, '/api/airports')).h['ratelimit-remaining'] ?? (await raw(B, '/api/airports')).h['x-ratelimit-remaining'];
  for (let i = 0; i < 30; i++) await raw(B, '/bus-planner/api/v1/health');
  const r2 = await raw(B, '/api/airports'), after = r2.h['ratelimit-remaining'] ?? r2.h['x-ratelimit-remaining'];
  ok('bus-planner 的 30 個請求不吃原本的限流額度（100／15 分鐘）', before != null && Number(before) - Number(after) <= 2, `剩餘 ${before} → ${after}`);
  ok('bus-planner 回應沒有被原本的 compression 重複壓縮', (await raw(B, '/bus-planner/', { 'accept-encoding': 'gzip' })).h['content-encoding'] === 'gzip'); }
s.close();

log0('④ 沒有 dist（例如被 .gitignore 排除）→ 直接提供原始碼');
({ s, B } = await boot({ BUS_PLANNER_STATIC_DIR: path.resolve(HERE, '..') }));
{ const i = (await raw(B, '/bus-planner/')).body.toString(); ok('index.html 使用 ES Modules（js/main.js）', /src="js\/main\.js"/.test(i) || /js\/main\.js/.test(i));
  ok('js／css 可讀取', (await raw(B, '/bus-planner/js/main.js')).status === 200 && (await raw(B, '/bus-planner/css/app.css')).status === 200);
  ok('原始碼模式也不會送出伺服器程式與 package.json', (await raw(B, '/bus-planner/server/engine.mjs')).status === 404 && (await raw(B, '/bus-planner/package.json')).status === 404); }
s.close(); tdx.close(); log0(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
