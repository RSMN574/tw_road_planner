// server-osm.mjs — 伺服器的全台 OSM 道路圖 API：路線、最近道路、路名搜尋、地圖圖磚（快取、ETag、壓縮）、沒有圖檔時 503、重建後自動換新圖
// 測試圖：test/fixtures/osm/tw-mini.osm.pbf 用 tools/osm/osm-build.mjs 建到暫存的 DATA_DIR/osm/graph
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf';
const origLog = console.log; console.info = () => {}; console.warn = () => {};
const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs');
let fails = 0; const ok = (n, c, x = '') => { origLog((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const LAT0 = 24.150, LON0 = 120.650, D = 0.001, at = (i, j) => [LAT0 + j * D, LON0 + i * D], ll = p => p.join(',');

// 建圖（不用 osmium，結果與用 osmium 相同；見 osm-graph.mjs）
const DATA = mkdtempSync(path.join(tmpdir(), 'osm-srv-')), OUT = DATA + '/osm/graph'; mkdirSync(OUT, { recursive: true });
const b = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', OUT, '--no-osmium'], { encoding: 'utf8' });
if (b.status) { origLog(b.stderr); process.exit(1); }
const env = { DATA_DIR: DATA, STATIC_DIR: ROOT + '/dist', CACHE_DIR: mkdtempSync(path.join(tmpdir(), 'osm-cache-')), LOG: '0', RATE_LIMIT_PER_MIN: '2000', ADMIN_TOKEN: 'adm1n', OSM_WARM: 'car,walk' };

async function boot(extra = {}) {
  const cfg = readConfig({ ...env, ...extra }), h = createApp(cfg), s = http.createServer(h);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const J = async (p, o) => { const r = await fetch(base + p, o); return { status: r.status, h: r.headers, j: await r.json() }; };
  const raw = (p, headers = {}) => new Promise((res, rej) => http.get(base + p, { headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, h: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
  return { cfg, h, s, be: h.backend, J, raw };
}

for (const WORKERS of ['0', '1']) {
  origLog(`\n===== ${WORKERS === '0' ? '主執行緒（WORKERS=0）' : '背景執行緒（WORKERS=1）'} =====`);
  const { cfg, s, be, J, raw } = await boot({ WORKERS });
  origLog('① 還沒載入：OSM API 回 503，其他照常');
  { const r = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}`); ok('沒載入 → 503 OSM_NOT_LOADED（統一錯誤格式）', r.status === 503 && r.j.ok === false && r.j.error.code === 'OSM_NOT_LOADED');
    const t = await raw('/api/v1/osm/tiles/16/54732/28524.json'); ok('圖磚也 503', t.status === 503); }
  const info = await be.osmLoad(cfg);
  ok('載入：頂點、邊、地標表（ALT）、資料時間、版本', info.loaded && info.vertices > 50 && info.alt && info.alt.includes('car') && !!info.version, `${info.vertices} 頂點、ALT ${info.alt}`);
  ok('預熱', (await be.osmWarmup(cfg.osm.warm)) >= 0);

  origLog('② 路線');
  { const h = await J('/api/v1/health'); ok('health 有 osm 欄位', h.j.ok && h.j.data.osm.loaded === true && h.j.data.osm.vertices === info.vertices);
    const i = await J('/api/v1/osm/info'); ok('/osm/info', i.j.ok && i.j.data.loaded && i.j.data.modes.includes('car') && i.j.data.modes.includes('walk'));
    const r = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=car`), R = r.j.data;
    const f = R && R.routes[0];
    ok('汽車：最快（＋最短，若不同）；距離、時間、幾何、逐步、時間組成、資料時間與來源', r.j.ok && R.engine === 'osm' && f.key === 'fastest' && f.distanceM > 0 && f.durationS > 0 && f.geometry.length >= 2 && f.steps[0].type === 'start' && f.steps.at(-1).type === 'arrive' && f.timing && /OpenStreetMap/.test(R.data.source), r.j.ok ? `${f.distanceM} m、${f.durationS} 秒、${R.routes.length} 條` : JSON.stringify(r.j.error));
    ok('幾何是 [經度, 緯度]，在測試範圍內；起終點吸附資訊', f.geometry.every(([lo, la]) => lo > 120.64 && lo < 120.69 && la > 24.14 && la < 24.17) && f.snap && f.snap.fromM < 5);
    ok('每段的時間（給前端 ETA 用）：segS 數量＝幾何段數', Array.isArray(f.timing.segS) && f.timing.segS.length === f.geometry.length - 1 && Math.abs(f.timing.segS.reduce((a, x) => a + x, 0) - f.driveS) < 2, `${f.timing.segS.length} 段`);
    ok('meta 帶 OSM 版本（不是台中路網的版本）', r.j.meta.osmVersion === info.version && r.j.meta.graphVersion === undefined);
    const again = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=car`); ok('相同查詢第二次走快取', again.j.meta.cached === true && JSON.stringify(again.j.data) === JSON.stringify(R));
    const post = await J('/api/v1/osm/route', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: { lat: at(0, 0)[0], lon: at(0, 0)[1] }, to: { lat: at(4, 4)[0], lon: at(4, 4)[1] }, mode: 'car' }) });
    ok('POST JSON（物件座標）結果與 GET 相同', post.j.ok && post.j.data.routes[0].distanceM === f.distanceM);
    const lng = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=car&alternatives=all`); ok('alternatives=all：一定另算最短距離', lng.j.ok && (lng.j.data.routes.length === 2 || lng.j.data.routes[0].alsoShortest));
    const one = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=car&alternatives=0&steps=0`); ok('alternatives=0 只回最快；steps=0 不回逐步', one.j.ok && one.j.data.routes.length === 1 && !one.j.data.routes[0].steps);
    const p = [LAT0, LON0 + 0.0015], e = await J(`/api/v1/osm/route?from=${ll(p)}&to=${ll(at(4, 0))}&mode=car&heading=90&alternatives=0`), w = await J(`/api/v1/osm/route?from=${ll(p)}&to=${ll(at(4, 0))}&mode=car&heading=270&alternatives=0`);
    ok('heading（偏航重新規劃）：車頭反向的時間較長', e.j.ok && w.j.ok && w.j.data.routes[0].durationS > e.j.data.routes[0].durationS, e.j.ok && w.j.ok ? `${e.j.data.routes[0].durationS} / ${w.j.data.routes[0].durationS} 秒` : '');
    const fw = await J(`/api/v1/osm/route?from=${ll(at(4, 4))}&to=${ll([LAT0 + 0.004, LON0 + 0.022])}&mode=walk&alternatives=0`);
    ok('步行搭渡輪到小島：ferries 有航線、註明不含候船', fw.j.ok && fw.j.data.mode === 'walk' && fw.j.data.routes[0].ferries.length === 1 && /不含候船/.test(fw.j.data.routes[0].ferries[0].note));
    const fc = await J(`/api/v1/osm/route?from=${ll(at(4, 4))}&to=${ll([LAT0 + 0.004, LON0 + 0.022])}&mode=car`); ok('汽車到不了只載人的渡輪小島 → 404 NO_ROUTE', fc.status === 404 && fc.j.error.code === 'NO_ROUTE');
    const e1 = await J(`/api/v1/osm/route?to=${ll(at(4, 4))}`); ok('缺起點 → 400 BAD_COORD', e1.status === 400 && e1.j.error.code === 'BAD_COORD');
    const e2 = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=plane`); ok('不支援的運具 → 400 BAD_MODE', e2.status === 400 && e2.j.error.code === 'BAD_MODE');
    const e3 = await J(`/api/v1/osm/route?from=23.5,119.0&to=${ll(at(4, 4))}`); ok('起點附近沒有道路 → 422 NO_NEARBY_ROAD', e3.status === 422 && e3.j.error.code === 'NO_NEARBY_ROAD', e3.j.error && e3.j.error.code);
    const e4 = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&heading=abc`); ok('heading 不是數字 → 400', e4.status === 400 && e4.j.error.code === 'BAD_PARAM'); }

  origLog('③ 最近道路、路名搜尋');
  { const n = await J(`/api/v1/osm/nearest?lat=${at(2, 2)[0] + 0.0001}&lon=${at(2, 2)[1] + 0.0003}`); ok('nearest：路名、道路類別、距離、速限來源、各運具通行狀態', n.j.ok && typeof n.j.data.name === 'string' && n.j.data.highway && n.j.data.distanceM < 30 && n.j.data.access.car && n.j.data.limitSrc, n.j.ok ? `${n.j.data.name || '（無名）'} ${n.j.data.highway} ${n.j.data.distanceM} m` : JSON.stringify(n.j.error));
    const far = await J('/api/v1/osm/nearest?lat=23.5&lon=119&radius=200'); ok('附近沒有路 → 404', far.status === 404 && far.j.error.code === 'NO_ROAD_NEARBY');
    const s0 = await J(`/api/v1/osm/search?q=${encodeURIComponent('路')}&near=${ll(at(0, 0))}`); ok('search：部分比對、依距離排序', s0.j.ok && s0.j.data.results.length >= 1 && s0.j.data.results.every((x, i, a) => !i || a[i - 1].exact > x.exact || a[i - 1].km <= x.km), s0.j.ok ? s0.j.data.results.slice(0, 3).map(x => x.name).join('、') : '');
    const s1 = await J('/api/v1/osm/search'); ok('search 缺 q → 400', s1.status === 400); }

  origLog('④ 地圖圖磚');
  { const lon = LON0 + 0.002, lat = LAT0 + 0.002, z = 16, x = Math.floor((lon + 180) / 360 * 2 ** z), y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
    const t = await raw(`/api/v1/osm/tiles/${z}/${x}/${y}.json`, { 'accept-encoding': 'gzip' });
    const body = t.h['content-encoding'] === 'gzip' ? zlib.gunzipSync(t.body) : t.body, T = JSON.parse(body);
    ok('圖磚：道路折線（圖磚內格點、差值編碼）、道路類別表、單行方向', t.status === 200 && T.v === 2 && T.extent === 4096 && T.roads.length > 0 && T.hw.length > 0 && T.roads.every(r => Array.isArray(r[3]) && r[3].length % 2 === 0 && r[3].length >= 4), `${T.roads.length} 條、${t.body.length} bytes`);
    const [w, so, e, n] = T.bbox, pts = T.roads.flatMap(r => { const c = r[3], o = []; let px = c[0], py = c[1]; o.push([px, py]); for (let i = 2; i < c.length; i += 2) { px += c[i]; py += c[i + 1]; o.push([px, py]); } return o.map(([qx, qy]) => [w + qx / 4096 * (e - w), n - qy / 4096 * (n - so)]); });
    ok('還原後的座標落在測試範圍、靠近圖磚', pts.every(([lo, la]) => lo > 120.6 && lo < 120.7 && la > 24.1 && la < 24.2) && pts.some(([lo, la]) => lo >= w && lo <= e && la >= so && la <= n));
    // 同一條 way 的相鄰邊接成一條線：台灣大道（way 200 有好幾段邊）在這張圖磚裡只出現一次
    const big = await raw(`/api/v1/osm/tiles/14/${x >> 2}/${y >> 2}.json`), B2 = JSON.parse(big.body), ix = B2.names.indexOf('台灣大道') + 1;
    ok('同一條 way 的相鄰邊接成一條線（不是每段各一條）', ix > 0 && B2.roads.filter(r => r[1] === ix).length <= 2, `台灣大道 ${B2.roads.filter(r => r[1] === ix).length} 條線`);
    ok('快取標頭：public max-age、ETag', /public, max-age=86400/.test(t.h['cache-control']) && !!t.h.etag);
    const t2 = await raw(`/api/v1/osm/tiles/${z}/${x}/${y}.json`, { 'if-none-match': t.h.etag }); ok('ETag 相同 → 304', t2.status === 304 && t2.body.length === 0);
    const lo = await raw(`/api/v1/osm/tiles/8/${Math.floor((lon + 180) / 360 * 256)}/${Math.floor(y / 256)}.json`), L = JSON.parse(lo.body);
    ok('低縮放（z=8）只有高速公路、快速公路、主要道路與渡輪；同類道路首尾相接的合併成一條線', lo.status === 200 && L.hw.every(h => ['motorway', 'trunk', 'primary', 'ferry'].includes(h)) && L.roads.length < 20, L.hw.join(',') + '、' + L.roads.length + ' 條線');
    const bad = await raw('/api/v1/osm/tiles/16/99999999/1.json'); ok('超出範圍的圖磚 → 400 或 404', bad.status === 400 || bad.status === 404, String(bad.status));
    const bad2 = await raw('/api/v1/osm/tiles/16/1/2.png'); ok('不是 .json 的圖磚路徑 → 404', bad2.status === 404); }

  if (WORKERS === '1') {
    origLog('⑤ 重建圖之後自動換新（版本變了、快取失效）');
    const cur = JSON.parse(readFileSync(OUT + '/current.json', 'utf8')), v0 = (await J('/api/v1/osm/info')).j.data.version;
    writeFileSync(OUT + '/current.json.tmp', JSON.stringify({ ...cur, builtAt: new Date(Date.now() + 1000).toISOString() })); renameSync(OUT + '/current.json.tmp', OUT + '/current.json');
    const changed = await be.osmReloadIfChanged(), v1 = (await J('/api/v1/osm/info')).j.data.version;
    ok('osmReloadIfChanged：偵測到 current.json 改變、重新載入、版本不同', changed === true && v1 !== v0);
    const r = await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}&mode=car`); ok('新版本的路線不走舊快取', r.j.ok && r.j.meta.cached === false && r.j.meta.osmVersion === v1);
    const adm = await J('/api/v1/admin/reload', { method: 'POST', headers: { Authorization: 'Bearer adm1n' } }); ok('admin reload 也重新載入 OSM', adm.j.ok && adm.j.data.osm && adm.j.data.osm.loaded === true);
  }
  await new Promise(r => s.close(r)); await be.close();
}

{ origLog('\n⑥ OSM=0：停用'); const { cfg, s, be, J } = await boot({ WORKERS: '0', OSM: '0' }); const i = await be.osmLoad(cfg);
  ok('停用時不載入、API 503', i.loaded === false && i.disabled && (await J(`/api/v1/osm/route?from=${ll(at(0, 0))}&to=${ll(at(4, 4))}`)).status === 503);
  await new Promise(r => s.close(r)); await be.close(); }

{ origLog('\n⑦ 只重建地標表（npm run osm:alt）');
  const a = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-alt.mjs', '--graph-root', OUT, '--profile', 'car'], { encoding: 'utf8' });
  const { cfg, s, be } = await boot({ WORKERS: '0' }), i = await be.osmLoad(cfg), man = JSON.parse(readFileSync(OUT + '/' + JSON.parse(readFileSync(OUT + '/current.json', 'utf8')).dir + '/manifest.json', 'utf8'));
  ok('osm-alt：只建汽車的地標表，伺服器載入時只有 car；manifest 一併更新', a.status === 0 && i.loaded && JSON.stringify(i.alt) === '["car"]' && man.alt && Object.keys(man.alt.profiles).join() === 'car', a.status ? a.stderr.slice(0, 200) : JSON.stringify(i.alt));
  await new Promise(r => s.close(r)); await be.close(); }

origLog(fails ? `\n❌ ${fails} 項失敗` : '\n✅ 全部通過'); process.exit(fails ? 1 : 0);
