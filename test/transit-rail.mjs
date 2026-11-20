// transit-rail.mjs — v1.11 全台多運具大眾運輸（台鐵、高鐵、捷運、輕軌、公車）：資料轉換、轉乘、RAPTOR、票價、線型、即時誤點
// 資料：test/fixtures/rail-fixture.mjs（**模擬資料**，欄位照使用者提供的 OAS）；步行：test/fixtures/osm/tw-mini.osm.pbf 的真 OSM 拓樸（台中附近小格子）
// 這是整合測試（資料轉換→資料庫→轉乘→路由→分段），不是真實 TDX 資料測試。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTopology } from '../server/osm/topology.mjs';
import { OsmRouter } from '../server/osm/router.mjs';
import { createTransitData } from '../server/transit/snapshot.mjs';
import { parseWkt } from '../server/transit/rail-provider.mjs';
import { makeContext, setTransitData, transitPlan, resetTransit } from '../server/transit-engine.mjs';
import { planTransit } from '../server/transit/raptor.mjs';
import { railFixture, fakeTdx, PLACES, DATE } from './fixtures/rail-fixture.mjs';

let fails = 0; const ok = (name, cond, info = '') => { console.log(`  ${cond ? '✓' : '✗'} ${name}${info ? '｜' + info : ''}`); if (!cond) fails++; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const g = buildTopology(ROOT + '/test/fixtures/osm/tw-mini.osm.pbf'), R = new OsmRouter(g);
const NOW = Date.parse(`${DATE}T07:50:00+08:00`), dep = h => Date.parse(`${DATE}T${h}:00+08:00`);

async function load(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'rail-')), fx = railFixture(opts), fk = fakeTdx(fx);
  const td = createTransitData({ dir, city: 'Taichung', operators: ['KRTC', 'KLRT', 'NTALRT'], rail: ['TRA', 'THSR'], extras: true, fetchJson: fk.fetchJson, now: () => NOW });
  const r = await td.refresh({ force: true }); rmSync(dir, { recursive: true, force: true });
  return { td, fk, r };
}
console.log('① 資料轉換（TransitDataAdapter）');
const { td, fk } = await load(), S = td.store;
ok('只問 OAS 有列的業者（KLRT 沒有 Frequency、NTALRT 沒有 S2STravelTime）', !fk.seen.some(p => p.startsWith('/Rail/Metro/Frequency/KLRT') || p.startsWith('/Rail/Metro/S2STravelTime/NTALRT')) && fk.seen.some(p => p.startsWith('/Rail/Metro/S2STravelTime/KLRT')));
ok('當日時刻表路徑含日期；GIS 圖資走 v3', fk.seen.some(p => p.startsWith(`/Rail/TRA/DailyTimetable/TrainDate/${DATE}`)) && fk.seen.some(p => p.startsWith('/V3/Map/Rail/Network/Line/OperatorCode/THSR')));
ok('各運具的站：台鐵 2、高鐵 2、捷運 3、輕軌 4、公車 2（不因站名相同而合併）', S.stats.byMode.tra === 2 && S.stats.byMode.thsr === 2 && S.stats.byMode.metro === 3 && S.stats.byMode.lrt === 4 && S.stats.byMode.bus === 2, JSON.stringify(S.stats.byMode));
const traP = S.patterns.filter(p => p.mode === 'tra'), t199 = traP.flatMap(p => p.trips).find(t => t.trainNo === '199'), t103 = traP.flatMap(p => p.trips).find(t => t.trainNo === '103');
ok('跨午夜：23:50 開、00:10 到 → 營運日 24:10（87000 秒）', t199 && t199.arr[1] === 87000, t199 && String(t199.arr));
ok('當日停駛（SuspendedFlag=1）的 103 次不收', !t103);
const lrtP = S.patterns.find(p => p.operator === 'KLRT');
ok('輕軌：站別時刻表接到型態上（C14 有 5 個發車時刻）', lrtP && lrtP.stationDeps && lrtP.stationDeps[0][0].deps.length === 5 && lrtP.mode === 'lrt');
ok('共站（TransferStations）轉乘：R14 ↔ C14', S.transfers.some(t => t.from === 'KRTC-R14' && t.to === 'KLRT-C14'));
ok('GIS 線型：WKT 解析', td.extra.shapes.length === 1 && td.extra.shapes[0].lines[0].length === 3 && JSON.stringify(parseWkt('MULTILINESTRING((1 2, 3 4),(5 6, 7 8))')) === '[[[1,2],[3,4]],[[5,6],[7,8]]]');
const day = S.day(DATE), ntaInfo = day.info[S.patterns.findIndex(p => p.operator === 'NTALRT')];
ok('沒有班次／班距的型態標示「資訊不足」（none），不是停駛', ntaInfo === 'none');

console.log('② 轉乘（TransferEngine）與 RAPTOR');
const ctx = makeContext(S, td.extra, R, undefined, { radiusM: 160 }), W = 150;   // 小格子路網：轉乘半徑 160 m、起終點步行 150 m，才會真的用到各種運具
ok('轉乘：OSM 步行路徑＋TDX 共站；沒有直線推估', ctx.tr.stats.osmPairs > 0 && ctx.tr.stats.crowPairs === 0 && ctx.tr.stats.colocated >= 1, JSON.stringify(ctx.tr.stats));
const t0 = Date.now(), res = planTransit(ctx, { from: PLACES.O, to: PLACES.D, departMs: dep('08:00'), maxWalkM: W }), ms = Date.now() - t0;
const fast = res.itineraries.find(it => it.tags.includes('fastest')), rides = fast ? fast.legs.filter(l => /_RIDE$/.test(l.type)) : [];
ok('最快：台鐵 → 高鐵 → 捷運 → 輕軌（3 次轉乘）', rides.map(l => l.type).join(',') === 'TRAIN_RIDE,THSR_RIDE,METRO_RIDE,LIGHT_RAIL_RIDE' && fast.transfers === 3, rides.map(l => l.type + ':' + (l.trainNo || l.routeName)).join(' → '));
ok('台鐵 101 次 08:05；高鐵 0803 次 08:25', rides[0] && rides[0].trainNo === '101' && rides[0].departAt.includes('T00:05') && rides[1].trainNo === '0803' && rides[1].departAt.includes('T00:25'), rides.slice(0, 2).map(l => l.departAt).join(' '));
const xfer = fast && fast.legs.find(l => (l.type === 'WALK' || l.type === 'TRANSFER') && l.from && l.from.mode === 'tra' && l.to.mode === 'thsr');
ok('台鐵轉高鐵：站外步行（OSM 步行路徑）', xfer && xfer.source === 'OSM 步行路徑' && xfer.distanceM > 30, xfer && `${xfer.distanceM} m／${xfer.durationS} 秒`);
ok('捷運只有班距：時間標示「依班距推估」；輕軌用站別時刻表 09:30', rides[2] && rides[2].timing.kind === 'frequency' && rides[2].timing.estimated && rides[3] && rides[3].timing.kind === 'stationTimetable' && rides[3].departAt.includes('T01:30'), rides[3] && rides[3].departAt);
ok('捷運轉輕軌：TDX 共站', fast && fast.legs.some(l => l.type === 'TRANSFER' && /TransferStations/.test(l.source)));
ok('等候段（WAIT）與總時間、步行距離', fast.legs.some(l => l.type === 'WAIT') && fast.durationS > 0 && fast.walkM > 0 && Date.parse(fast.arriveAt) < dep('09:45'), `抵達 ${fast.arriveAt}、步行 ${fast.walkM} m`);
ok('票價：高鐵 790、捷運 25；台鐵票種不確定 → 總價不算', rides[1].fare.price === 790 && rides[2].fare.price === 25 && rides[0].fare.price === null && fast.fare && fast.fare.complete === false);
ok('高鐵乘車段沿 GIS 線型', rides[1].geometry.source.includes('GIS') && rides[1].geometry.coords.length >= 3);
const few = res.itineraries.find(it => it.tags.includes('fewestTransfers'));
ok('最少轉乘：公車直達（0 次轉乘）', few && few.transfers === 0 && few.legs.some(l => l.type === 'BUS_RIDE'), few && few.arriveAt);
ok('有綜合建議與最少步行', res.itineraries.some(it => it.tags.includes('recommended')) && res.itineraries.some(it => it.tags.includes('leastWalking')));
ok(`查詢時間 ${ms} ms（模擬資料、小路網）`, ms < 3000);

console.log('③ 即時誤點、運具篩選、找不到');
const { td: td2 } = await load({ delay101: 6 }), ctx2 = makeContext(td2.store, td2.extra, R, undefined, { radiusM: 160 });
const r2 = planTransit(ctx2, { from: PLACES.O, to: PLACES.D, departMs: dep('08:00'), maxWalkM: W }), f2 = r2.itineraries.find(it => it.tags.includes('fastest')), rr2 = f2.legs.filter(l => /_RIDE$/.test(l.type));
const usesThsr0805 = rr2.some(l => l.trainNo === '0805'), tra2 = rr2.find(l => l.type === 'TRAIN_RIDE');
ok('台鐵 101 誤點 6 分：趕不上 0803，改搭 0805（或改走其他方式）', (usesThsr0805 || !rr2.some(l => l.trainNo === '0803')) && Date.parse(f2.arriveAt) > Date.parse(fast.arriveAt), `${f2.arriveAt}${tra2 && tra2.timing.delayMin ? `；101 誤點 ${tra2.timing.delayMin} 分` : ''}`);
const onlyBus = planTransit(ctx, { from: PLACES.O, to: PLACES.D, departMs: dep('08:00'), modes: ['bus'], maxWalkM: W });
ok('只選公車：結果只有公車', onlyBus.itineraries.length >= 1 && onlyBus.itineraries.every(it => it.modes.every(m => m === 'bus')));
const late = planTransit(ctx, { from: PLACES.O, to: PLACES.D, departMs: dep('10:20'), maxWalkM: W });
ok('太晚（公車、高鐵都沒了）：沒有方案，不捏造', late.itineraries.length === 0);
const far = planTransit(ctx, { from: [24.30, 120.80], to: PLACES.D, departMs: dep('08:00') });
ok('起點附近沒有站：明確說明', far.itineraries.length === 0 && far.notes.some(n => n.includes('起點')));

console.log('④ API 層（transit-engine：注入資料＋OSM 步行路徑）');
setTransitData(td.store, td.extra, R);
const api = transitPlan({ from: PLACES.O, to: PLACES.D, departMs: dep('08:00'), modes: [] }, R), a0 = api.itineraries.find(it => it.tags.includes('fastest'));
ok('步行段有實際路徑幾何（OSM 步行）', a0 && a0.legs.filter(l => l.type === 'WALK').every(l => l.geometry && l.geometry.coords.length >= 2));
ok('回應含資料版本與轉乘統計', api.data && api.data.version && api.data.transfers && api.modeLabels.thsr === '高鐵');
resetTransit();

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
