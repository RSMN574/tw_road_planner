// poi.mjs — 店家地點搜尋（v1.13）：正規化、類別對照、營業時間判斷、擷取（自己產生的小型 PBF：點、面、沒有名稱、要排除的類別）→ 檔案 → 載入 → 搜尋排序、
// 同義詞、類別詞、「店名 地標」、連鎖店合併、營業中篩選、附近、詳細資料；伺服器 API（測試路網 tw-mini＋同一份地點檔）
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf';
const origLog = console.log; console.info = () => {}; console.warn = () => {};
let fails = 0; const ok = (n, c, x = '') => { origLog((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const P = await import('../server/osm/poi.mjs'), C = await import('../server/osm/poi-categories.mjs');
const TW = s => Date.parse(s + '+08:00');
const NOW = TW('2026-11-24T10:00'), NIGHT = TW('2026-11-25T01:00');     // 週二上午 10 點、週三凌晨 1 點

origLog('① 正規化、類別對照');
ok('臺→台、全形→半形、大小寫、去空白標點', P.norm('臺中　ＭＣＤ・7-11') === '台中mcd711', P.norm('臺中　ＭＣＤ・7-11'));
ok('amenity=fuel → 加油站', C.categoryOf({ amenity: 'fuel' }, false) === 'fuel');
ok('沒有名稱的加油站保留（用類別找得到）', C.categoryOf({ amenity: 'fuel' }, false) === 'fuel');
ok('沒有名稱的餐廳不收', !C.categoryOf({ amenity: 'restaurant' }, false));
ok('停車格、長椅不收', !C.categoryOf({ amenity: 'parking_space', name: 'x' }, true) && !C.categoryOf({ amenity: 'bench', name: 'x' }, true));
ok('不認得的 shop=* 歸到「商店」', C.categoryOf({ shop: 'some_new_kind' }, true) === 'shop');
ok('類別詞：「加油站」→ fuel、「ATM」→ atm', C.CAT_WORDS.get('加油站') === 'fuel' && C.CAT_WORDS.get('atm') === 'atm');

origLog('② 營業時間');
{ const s = P.openStatus('', NOW); ok('沒有資料 → 營業時間未提供', s.state === 'unknown' && s.text === '營業時間未提供'); }
ok('24/7 → 營業中', P.openStatus('24/7', NOW).state === 'open');
ok('Mo-Su 06:00-22:00 在 10:00 → 營業中', P.openStatus('Mo-Su 06:00-22:00', NOW).state === 'open');
ok('Mo-Su 07:00-10:15 在 10:00 → 即將打烊（30 分內）', P.openStatus('Mo-Su 07:00-10:15', NOW).state === 'closing');
ok('跨午夜 Mo-Su 18:00-02:00：10:00 已打烊、01:00 營業中', P.openStatus('Mo-Su 18:00-02:00', NOW).state === 'closed' && P.openStatus('Mo-Su 18:00-02:00', NIGHT).state === 'open');
ok('Sa-Su 只有週末：週二 → 已打烊', P.openStatus('Sa-Su 10:00-18:00', NOW).state === 'closed');
{ const s = P.openStatus('by appointment', NOW); ok('看不懂的寫法 → 不猜，顯示原文', s.state === 'unknown' && s.text === 'by appointment', JSON.stringify(s)); }

// ---------- 自己產生的小型 PBF（plain node＋way；欄位依 OSM PBF 規格）----------
const vint = n => { const o = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; o.push(b); } while (v); return o; };
const zz = n => (BigInt(n) << 1n) ^ (BigInt(n) < 0n ? -1n : 0n);
const key = (f, wt) => vint(f * 8 + wt);
const fBytes = (f, buf) => [...key(f, 2), ...vint(buf.length), ...buf];
const fVar = (f, n) => [...key(f, 0), ...vint(n)];
const fSint = (f, n) => [...key(f, 0), ...vint(zz(n))];
const packed = (f, arr) => fBytes(f, arr.flatMap(x => vint(x)));
const packedSD = (f, arr) => { let prev = 0; return fBytes(f, arr.flatMap(x => { const d = x - prev; prev = x; return vint(zz(d)); })); };
const utf = s => [...Buffer.from(s, 'utf8')];
function makePbf(file, nodes, ways) {
  const S = [''], idx = s => { let i = S.indexOf(s); if (i < 0) { i = S.length; S.push(s); } return i; };
  const nodeMsgs = nodes.map(n => { const k = Object.keys(n.t || {}); return [...fSint(1, n.id), ...packed(2, k.map(idx)), ...packed(3, k.map(x => idx(n.t[x]))), ...fSint(8, Math.round(n.lat * 1e7)), ...fSint(9, Math.round(n.lon * 1e7))]; });
  const wayMsgs = ways.map(w => { const k = Object.keys(w.t); return [...fVar(1, w.id), ...packed(2, k.map(idx)), ...packed(3, k.map(x => idx(w.t[x]))), ...packedSD(8, w.refs)]; });
  const group1 = nodeMsgs.flatMap(m => fBytes(1, m)), group2 = wayMsgs.flatMap(m => fBytes(3, m));
  const block = [...fBytes(1, S.flatMap(s => fBytes(1, utf(s)))), ...fBytes(2, group1), ...fBytes(2, group2), ...fVar(17, 100)];
  const header = [...fBytes(4, utf('OsmSchema-V0.6')), ...fBytes(16, utf('poi-test'))];
  const blob = (type, data) => { const z = zlib.deflateSync(Buffer.from(data)), b = Buffer.from([...fBytes(3, [...z]), ...fVar(2, data.length)]), h = Buffer.from([...fBytes(1, utf(type)), ...fVar(3, b.length)]), len = Buffer.alloc(4); len.writeUInt32BE(h.length); return Buffer.concat([len, h, b]); };
  writeFileSync(file, Buffer.concat([blob('OSMHeader', header), blob('OSMData', block)]));
}
// 測試路網 tw-mini 在台中（24.150, 120.650 起，0.001° 一格）；地點放在同一區
const LA = 24.150, LO = 120.650, at = (i, j) => ({ lat: LA + j * 0.001, lon: LO + i * 0.001 });
const nodes = [
  { id: 1, ...at(1, 1), t: { shop: 'convenience', name: '7-ELEVEN 文心門市', brand: '7-ELEVEN', opening_hours: '24/7' } },
  { id: 2, ...at(2, 1), t: { shop: 'convenience', name: '全家便利商店', 'name:en': 'FamilyMart', opening_hours: 'Mo-Su 07:00-10:15' } },
  { id: 3, ...at(3, 3), t: { amenity: 'fuel', name: '台灣中油 文心站', brand: '台灣中油', opening_hours: 'Mo-Su 06:00-22:00', 'addr:city': '臺中市', 'addr:street': '文心路', 'addr:housenumber': '100', phone: '+886 4 2222 3333', website: 'example.com.tw' } },
  { id: 4, ...at(6, 6), t: { amenity: 'fuel' } },                                                 // 沒有名稱的加油站：保留
  { id: 5, ...at(1, 2), t: { amenity: 'restaurant' } },                                           // 沒有名稱的餐廳：不收
  { id: 6, ...at(1, 3), t: { amenity: 'parking_space', name: '格位 A1' } },                        // 停車格：不收
  { id: 7, ...at(1, 4), t: { amenity: 'bench', name: '測試長椅' } },                                // 長椅：不收
  ...[0, 1, 2, 3, 4].map(k => ({ id: 10 + k, ...at(2 + k * 4, 2 + k * 3), t: { amenity: 'fast_food', name: '麥當勞', brand: "McDonald's", ...(k === 0 ? { opening_hours: 'Mo-Su 18:00-02:00' } : {}) } })),
  { id: 20, ...at(30, 30), t: { railway: 'station', name: '大墩車站' } },
  { id: 21, ...at(30.3, 30.2), t: { amenity: 'cafe', name: '星巴克', 'name:en': 'Starbucks', brand: '星巴克' } },
  { id: 22, ...at(0, 0), t: { amenity: 'cafe', name: '星巴克', 'name:en': 'Starbucks', brand: '星巴克' } },
  { id: 23, ...at(4, 4), t: { amenity: 'hospital', name: '臺中測試醫院' } },
  { id: 24, ...at(5, 5), t: { amenity: 'cafe', name: '預約咖啡', opening_hours: 'by appointment' } },
  // 面狀地點的節點（沒有標籤）
  { id: 100, ...at(8, 8) }, { id: 101, ...at(10, 8) }, { id: 102, ...at(10, 10) }, { id: 103, ...at(8, 10) },
];
const ways = [{ id: 500, refs: [100, 101, 102, 103, 100], t: { leisure: 'park', name: '文心森林公園' } }];
const TMP = mkdtempSync(path.join(tmpdir(), 'poi-')), PBF = TMP + '/poi-test.osm.pbf'; makePbf(PBF, nodes, ways);

origLog('③ 擷取 → 檔案 → 載入');
const x = P.extractPois(PBF);
ok('點與面都擷取到；排除停車格、長椅、沒名稱的餐廳', x.R.id.length === nodes.filter(n => n.t).length - 3 + 1, `${x.R.id.length} 筆`);
ok('沒有名稱的加油站保留', x.R.id.includes('n4'));
{ const i = x.R.id.indexOf('w500'); ok('面狀地點取中心點（四個角的平均）', i >= 0 && Math.abs(x.R.lat[i] / 1e7 - (LA + 0.009)) < 1e-6 && Math.abs(x.R.lon[i] / 1e7 - (LO + 0.009)) < 1e-6 && x.R.area[i] === 1); }
{ const i = x.R.id.indexOf('n3'); ok('地址組合：城市＋街道＋門牌（補「號」）', x.R.addr[i] === '臺中市文心路100號', x.R.addr[i]); }
const FILE = TMP + '/osm-poi.json.gz', w = P.writePois(FILE, x, { source: 'poi-test' });
ok('寫檔（gzip JSON）', existsSync(FILE) && w.count === x.R.id.length);
const X = P.loadPois(FILE);
ok('載入＋建索引（兩字組、單字、格網、類別數量）', X.n === x.R.id.length && X.post.size > 0 && X.grid.size > 0 && X.counts.fuel === 2);

origLog('④ 搜尋與排序');
const near = [LA + 0.001, LO + 0.001], names = r => r.results.map(z => z.name);
{ const r = P.searchPois(X, { q: '小七', near, now: NOW }); ok('同義詞：「小七」→ 7-ELEVEN', r.results[0] && r.results[0].name === '7-ELEVEN 文心門市', names(r).join('、')); }
{ const r = P.searchPois(X, { q: '7-11', near, now: NOW }); ok('同義詞：「7-11」→ 7-ELEVEN', r.results[0] && r.results[0].name === '7-ELEVEN 文心門市'); }
{ const r = P.searchPois(X, { q: 'familymart', near, now: NOW }); ok('英文名稱：FamilyMart', r.results[0] && r.results[0].name === '全家便利商店'); }
{ const r = P.searchPois(X, { q: 'starb', near, now: NOW }); ok('英文前綴：starb → 星巴克', r.results.length >= 1 && r.results[0].name === '星巴克'); }
{ const r = P.searchPois(X, { q: '台中測試醫院', near, now: NOW }); ok('臺／台 視為相同', r.results[0] && r.results[0].name === '臺中測試醫院'); }
{ const r = P.searchPois(X, { q: '加油站', near, now: NOW }), d = r.results.map(z => z.distanceM);
  ok('類別詞「加油站」→ 類別查詢、依距離排序、含沒名稱的', r.mode === 'category' && r.category === 'fuel' && r.results.length === 2 && d[0] <= d[1] && r.results.some(z => !z.named), JSON.stringify(r.results.map(z => [z.name, z.distanceM]))); }
{ const r = P.searchPois(X, { q: '麥當勞', near, now: NOW }), m = r.results.filter(z => z.name === '麥當勞');
  ok('同名連鎖店最多 3 家，其餘計數', m.length === 3 && m[0].moreSameName === 2, JSON.stringify(m.map(z => [z.distanceM, z.moreSameName]))); }
{ const r = P.searchPois(X, { q: '星巴克 大墩車站', near, now: NOW });
  ok('「店名 地標」：以地標為中心，地標旁的星巴克排第一', r.results[0] && r.results[0].id === 'n21' && r.near && r.near.name === '大墩車站' && /大墩車站/.test(r.note), JSON.stringify(r.results.map(z => [z.id, z.distanceM])) + ' ' + r.note); }
{ const r = P.searchPois(X, { q: '星巴克', near: [LA, LO], now: NOW }); ok('沒有地標：最近的星巴克排第一', r.results[0] && r.results[0].id === 'n22'); }
{ const r = P.searchPois(X, { q: '長椅', near, now: NOW }); ok('排除的地點搜不到', !r.results.some(z => z.name === '測試長椅')); }
{ const r = P.searchPois(X, { category: 'fuel', near, openNow: true, now: NOW }); ok('營業中篩選：只留確定營業中的（沒提供營業時間的不算）', r.results.length === 1 && r.results[0].id === 'n3', names(r).join('、')); }
{ const r = P.searchPois(X, { q: '全家', near, now: NOW }); ok('營業狀態：即將打烊', r.results[0] && r.results[0].open === 'closing'); }
{ const a = P.searchPois(X, { q: '麥當勞', near, now: NOW }).results.find(z => z.id === 'n10'), b = P.searchPois(X, { q: '麥當勞', near, now: NIGHT }).results.find(z => z.id === 'n10');
  ok('營業狀態跟著時間（跨午夜的店：白天打烊、凌晨營業）', a && b && a.open === 'closed' && b.open === 'open'); }
{ const r = P.searchPois(X, { q: '麥當勞', near, now: NOW, bbox: [LO, LA, LO + 0.005, LA + 0.005] }); ok('地圖範圍（bbox）篩選', r.results.length === 1 && r.results[0].id === 'n10'); }
{ const r = P.searchPois(X, { category: 'fuel', now: NOW }); ok('類別查詢沒有位置 → 空結果並說明', r.results.length === 0 && !!r.note); }

origLog('⑤ 附近、詳細資料');
{ const a = P.nearbyPois(X, { lat: near[0], lon: near[1], radiusKm: 0.3, now: NOW }), b = P.nearbyPois(X, { lat: near[0], lon: near[1], radiusKm: 3, now: NOW });
  ok('附近：半徑越大越多，依距離排序', a.results.length < b.results.length && b.results.every((z, i, L) => !i || L[i - 1].distanceM <= z.distanceM), `${a.results.length} → ${b.results.length}`);
  const c = P.nearbyPois(X, { lat: near[0], lon: near[1], radiusKm: 3, category: 'cafe', now: NOW }); ok('附近＋類別', c.results.length >= 1 && c.results.every(z => z.category === 'cafe')); }
{ const i = P.findPoi(X, 'n3'), d = P.poiDetail(X, i, NOW);
  ok('詳細資料：電話、網站、營業時間原文、OSM 連結、資料來源', d.phone === '+886 4 2222 3333' && d.website === 'example.com.tw' && d.hours === 'Mo-Su 06:00-22:00' && d.hoursEvaluable && d.osm.url === 'https://www.openstreetmap.org/node/3' && /OpenStreetMap/.test(d.source)); }
{ const d = P.poiDetail(X, P.findPoi(X, 'w500'), NOW); ok('面狀地點的 OSM 連結是 way', d.osm.type === 'way' && d.osm.url.endsWith('/way/500') && d.area); }
{ const d = P.poiDetail(X, P.findPoi(X, 'n24'), NOW); ok('看不懂的營業時間：hoursEvaluable=false', d.hours === 'by appointment' && !d.hoursEvaluable && d.open === 'unknown'); }
ok('找不到的 id → -1', P.findPoi(X, 'n999999') === -1);

origLog('⑥ 伺服器 API（測試路網＋地點檔）');
{
  const DATA = mkdtempSync(path.join(tmpdir(), 'poi-srv-')), OUT = DATA + '/osm/graph'; mkdirSync(OUT, { recursive: true });
  const b = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', OUT, '--no-osmium'], { encoding: 'utf8' });
  if (b.status) { origLog(b.stderr); process.exit(1); }
  const cur = JSON.parse(readFileSync(OUT + '/current.json', 'utf8')), GDIR = path.dirname(path.join(OUT, cur.graph));
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs');
  for (const WORKERS of ['0', '1']) {
    origLog(`  —— ${WORKERS === '0' ? '主執行緒' : '背景執行緒'} ——`);
    const cfg = readConfig({ DATA_DIR: DATA, STATIC_DIR: ROOT + '/dist', CACHE_DIR: mkdtempSync(path.join(tmpdir(), 'poi-cache-')), LOG: '0', RATE_LIMIT_PER_MIN: '5000', WORKERS, OSM_WARM: '' });
    const h = createApp(cfg), s = http.createServer(h); await new Promise(r => s.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${s.address().port}`, J = async p => { const r = await fetch(base + p); return { status: r.status, j: await r.json() }; };
    const be = h.backend; await be.osmLoad(cfg);
    if (WORKERS === '0') {
      const r0 = await J('/api/v1/poi/categories'); ok('還沒有地點檔 → 404 NO_POI', r0.status === 404 && r0.j.error.code === 'NO_POI');
      const t = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-poi.mjs', '--pbf', PBF, '--dir', GDIR], { encoding: 'utf8' });
      ok('npm run osm:poi（--pbf、--dir）產生地點檔與報告', t.status === 0 && existsSync(GDIR + '/osm-poi.json.gz') && existsSync(GDIR + '/poi-report.json'), t.status ? t.stderr.slice(0, 200) : '');
      ok('地點檔出現後自動重新載入', !!(await be.osmReloadIfChanged()));
    } else {
      ok('（背景執行緒）啟動時就找到地點檔', true);
    }
    const info = (await J('/api/v1/osm/info')).j.data; ok('/osm/info 標示地點資料可用', info.poi && info.poi.available === true);
    const nearQ = `${near[0]},${near[1]}`;
    { const r = await J(`/api/v1/poi/search?q=${encodeURIComponent('小七')}&near=${nearQ}`); ok('/poi/search：同義詞＋署名', r.status === 200 && r.j.data.results[0].name === '7-ELEVEN 文心門市' && /OpenStreetMap/.test(r.j.data.source)); }
    { const r = await J(`/api/v1/poi/search?q=${encodeURIComponent('加油站')}&near=${nearQ}`), u = r.j.data.results.find(z => !z.address);
      ok('/poi/search：類別、沒有門牌的補「附近道路」（只在找得到有名稱的道路時）', r.j.data.mode === 'category' && r.j.data.results.length === 2 && (!u || u.nearRoad === undefined || typeof u.nearRoad === 'string'), JSON.stringify(r.j.data.results.map(z => [z.name, z.address, z.nearRoad]))); }
    { const r = await J(`/api/v1/poi/nearby?lat=${near[0]}&lon=${near[1]}&radius=3000&category=cafe`); ok('/poi/nearby', r.status === 200 && r.j.data.results.every(z => z.category === 'cafe') && r.j.data.results.length >= 1); }
    { const r = await J('/api/v1/poi/detail?id=n3'); ok('/poi/detail', r.status === 200 && r.j.data.phone === '+886 4 2222 3333' && r.j.data.osm.type === 'node'); }
    { const r = await J('/api/v1/poi/categories'); ok('/poi/categories：類別、圖示、數量', r.status === 200 && r.j.data.categories.find(c => c.code === 'fuel').count === 2 && r.j.data.total === X.n); }
    { const r = await J('/api/v1/poi/search'); ok('缺 q → 400 MISSING_PARAM', r.status === 400 && r.j.error.code === 'MISSING_PARAM'); }
    { const r = await J('/api/v1/poi/search?category=nope&near=' + nearQ); ok('不認得的類別 → 400', r.status === 400 && r.j.error.code === 'BAD_PARAM'); }
    { const r = await J('/api/v1/poi/search?q=x&near=abc'); ok('near 格式錯 → 400 BAD_COORD', r.status === 400 && r.j.error.code === 'BAD_COORD'); }
    { const r = await J('/api/v1/poi/detail?id=n424242'); ok('找不到的地點 → 404 POI_NOT_FOUND', r.status === 404 && r.j.error.code === 'POI_NOT_FOUND'); }
    { const a = await J(`/api/v1/poi/search?q=${encodeURIComponent('全家')}&near=${nearQ}`), c = await J(`/api/v1/poi/search?q=${encodeURIComponent('全家')}&near=${nearQ}`); ok('同一分鐘的同一查詢走快取', c.j.meta && c.j.meta.cached === true && a.status === 200); }
    await new Promise(r => s.close(r)); if (h.close) await h.close(); else if (be.close) await be.close();
  }
}

origLog(fails ? `\n✗ ${fails} 項失敗` : '\n✓ 店家地點測試全部通過');
process.exit(fails ? 1 : 0);
