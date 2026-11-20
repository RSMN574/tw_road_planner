// metro-transit.mjs — 大眾運輸裡的捷運：資料、圖結構、轉乘、靜態搜尋、時刻表搜尋（RAPTOR／CSA）、API 回傳
// 測試城市見 metro-city.mjs：真實的綠線車站（data/metro.json）＋ 只存在於測試的藍線 TB ＋ 合成的密集公車
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, done } from './helpers.mjs';
import * as C from './metro-city.mjs';
const quiet = f => { const a = console.info, b = console.warn; console.info = console.warn = () => {}; try { return f(); } finally { console.info = a; console.warn = b; } };
const geo = await import('../js/geo.js');
await import('../js/main.js');
const { State } = await import('../js/state.js'), { buildGraph } = await import('../js/loader.js'), T = await import('../js/transit.js');
const BP = await import('../js/bus-plan.js'), BC = await import('../js/bus-core.js'), TT = await import('../js/timetable.js');

const G = C.greenLine(), B = C.testBlueLine(), S = id => C.st([...G, ...B], id), W = p => geo.lonLatToWorld(p.lon, p.lat);

console.log('① 捷運資料');
{ const g = T.metroToGraph(G), L = g.lines[0], nE = Object.values(g.adjacency).reduce((a, x) => a + x.length, 0);
  ok('綠線 18 站載入、線代碼 G', g.lines.length === 1 && L.id === 'G' && L.stations.length === 18);
  ok('依站序建立相鄰車站連線：17 段 × 雙向 = 34 條邊', nE === 34);
  ok('站序（G8 → G8a → G9、G10 → G10a → G11）', L.stations.slice(6, 9).join() === '文華高中,文心櫻花,市政府' && L.stations.slice(9, 12).join() === '水安宮,文心森林公園,南屯', L.stations.join('→'));
  ok('每個車站都有線代碼與業者', Object.values(g.nodes).every(n => n.line === 'G' && n.operator === 'TMRT'));
  // TDX 原始物件格式：真正的站序（故意打亂輸入順序）、站間時間、跨線轉乘時間
  const sol = [{ LineID: 'G', Stations: [...G].reverse().map((s, i) => ({ Sequence: 18 - i, StationID: s.StationID })) }];
  const g2 = T.metroToGraph({ Stations: [...G].reverse(), StationOfLine: sol, S2STravelTime: [{ LineID: 'G', TravelTimes: [{ FromStationID: 'G0', ToStationID: 'G3', RunTime: 150, StopTime: 30 }] }], LineTransfer: [{ FromStationID: 'G9', ToStationID: 'TB4', TransferTime: 5 }] });
  ok('有 StationOfLine 就用 TDX 站序', g2.meta.order === 'TDX StationOfLine' && g2.lines[0].stations[0] === '北屯總站' && g2.lines[0].stations[17] === '高鐵臺中站');
  ok('有 S2STravelTime 就用真實站間時間（其餘標示推估）', g2.adjacency['TMRT-G0'][0].travel_times[0].run_time === 180 && /部分 TDX/.test(g2.meta.runSrc));
  let err = null; try { T.metroToGraph(JSON.parse(readFileSync(new URL('../data/metro.json', import.meta.url))).map(s => ({ id: s.StationID, x: 1, y: 2 }))); } catch (e) { err = e.message; }
  ok('不支援的格式（例如示意圖座標 x/y）明確報錯，不會默默載入', /找不到站點/.test(err || ''), err);
  const g3 = T.metroToGraph([...G, { StationUID: 'TMRT-X', StationID: '中央', StationName: { Zh_tw: '怪站' }, StationPosition: { PositionLat: 24.15, PositionLon: 120.65 } }]);
  ok('無法判斷站序的車站列出來（不連邊）', g3.meta.lone.includes('怪站'));
}

console.log('② 圖結構（捷運節點、邊、轉乘、孤立）');
const city = C.makeMetroCity({ toTWD97: geo.lonLatToTWD97 });
quiet(() => { buildGraph(city.road); T.loadBus(city.bus); T.loadMetro(city.metro); });
const b = State.bus, M = [...Array(b.n).keys()].filter(i => b.stopKind[i] === 'metro');
let mE = 0; for (let e = 0; e < b.eTo.length; e++) if (b.eRoute[e] >= 0 && b.routeKind[b.eRoute[e]] === 'metro') mE++;
const iso = M.filter(i => b.off[i + 1] === b.off[i] && b.inDeg[i] === 0).length, xs = b.xferStats;
console.log(`   捷運節點 ${M.length}｜捷運邊 ${mE}｜捷運↔公車轉乘 ${xs.metroBus}（雙向各一條）｜跨線轉乘 ${xs.metroMetro}｜孤立捷運節點 ${iso}｜沒有轉乘的捷運站 ${xs.metroNoLink.length}（${xs.metroNoLink.join('、')}）`);
ok('捷運站全部加入大眾運輸圖（綠 18 ＋ 藍 6）', M.length === 24);
ok('捷運邊：綠 34 ＋ 藍 10', mE === 44);
ok('沒有孤立的捷運節點', iso === 0);
ok('捷運站與公車站之間有步行轉乘連結', xs.metroBus > 50 && xs.metroWithLink >= 20);
const iG9 = b.names.indexOf('市政府'), iTB = b.names.indexOf('測試藍4'), lk = (b.xfer.get(iG9) || []).find(l => l.to === iTB);
ok('跨線轉乘：市政府（G9）↔ 測試藍4（不同站名，靠位置與道路步行距離連結）', !!lk && lk.kind === 'metro-metro' && /換月台/.test(lk.src), lk && `${Math.round(lk.m)} m、${Math.round(lk.sec)} 秒`);
ok('同一條線的車站之間不建立轉乘連結', !(b.xfer.get(iG9) || []).some(l => b.stopLine[l.to] === 'G'));
let notStraight = 0, total = 0; for (const i of M) for (const l of b.xfer.get(i) || []) { total++; const d = geo.worldDistM(b.x[i], b.y[i], b.x[l.to], b.y[l.to]); if (l.m >= d - 0.5 && l.src.startsWith('道路步行距離') && l.sec > l.m / 1.2) notStraight++; }
ok('轉乘距離是道路步行距離（不短於直線），時間另含進出站／換月台', notStraight === total, `${notStraight}/${total}`);
const mStop = M.find(i => b.names[i] === '舊社'), [gx, gy] = W(S('G3'));
ok('捷運站位置正確（與 TDX 經緯度一致）', geo.worldDistM(b.x[mStop], b.y[mStop], gx, gy) < 0.5);

console.log('③ 搜尋：六種情境');
const kinds = o => o.rides.map(r => BC.routeKindOf(r)).join('>'), plans = (a, z) => { const [fx, fy] = W(a), [tx, ty] = W(z); return BP.suggestBusMulti(fx, fy, tx, ty); };
const has = (rs, re) => rs.filter(o => !o.error && re.test(kinds(o)));
{ // 1. 捷運站 A → 捷運站 B
  const r = plans(C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60)), best = r[0], L = BP.legsOf(best);
  ok('1. 捷運站 A → 捷運站 B：最快方案是捷運直達', kinds(best) === 'metro', `${Math.round(best.sec / 60)} 分`);
  ok('   分段：步行 → METRO_RIDE（綠線 G，舊社 → 烏日，15 站）→ 步行', L.map(l => l.type).join() === 'WALK,METRO_RIDE,WALK' && L[1].lineId === 'G' && b.names[L[1].from] === '舊社' && b.names[L[1].to] === '烏日' && L[1].stops === 15);
  ok('   起終點步行含進出站時間', /進站/.test(L[0].note) && /出站/.test(L[2].note));
}
{ // 2. 公車站 A → 捷運站 B
  const r = plans(C.near(S('G6'), 2400, -2400), C.near(S('G14'), 40, -30)), m = has(r, /bus.*metro$/);
  ok('2. 公車站 A → 捷運站 B：有「公車轉捷運」方案', m.length > 0, m[0] && `${Math.round(m[0].sec / 60)} 分`);
  const t = m.length && BP.legsOf(m[0]).find((l, i, a) => l.type === 'TRANSFER' && a[i + 1].type === 'METRO_RIDE');
  ok('   公車 → 捷運的轉乘：步行距離取自道路、時間含進站', !!t && t.m > 0 && t.src === '道路步行距離' && t.sec >= t.m / 1.2 + 89, t && `${t.m} m、${t.sec} 秒`);
}
{ // 3. 捷運站 A → 公車站 B
  const r = plans(C.near(S('G4'), 50, 20), C.near(S('G12'), -3800, 2600));
  ok('3. 捷運站 A → 公車站 B：有「捷運為第一段、接著搭公車」的方案', has(r, /^metro>.*bus/).length > 0);
}
{ // 4. 公車 → 捷運 → 步行
  const r = plans(C.near(S('G0'), 900, -1200), C.near(S('G17'), 80, 50)), m = has(r, /bus>.*metro$/), L = m.length ? BP.legsOf(m[0]) : [];
  ok('4. 公車 → 捷運 → 步行：最後一段是捷運、下車後步行到終點', m.length > 0 && L[L.length - 1].type === 'WALK' && L[L.length - 2].type === 'METRO_RIDE' && L[L.length - 1].m > 0, m[0] && `${Math.round(m[0].sec / 60)} 分`);
}
{ // 5. 捷運跨線轉乘
  const r = plans(C.near(S('TB1'), 40, 30), C.near(S('G4'), -60, 40)), m = r.find(o => !o.error && kinds(o) === 'metro>metro'), L = m ? BP.legsOf(m) : [];
  ok('5. 捷運跨線轉乘：藍線 → 綠線，中間不必搭公車', !!m, m && `${Math.round(m.sec / 60)} 分`);
  ok('   分段含 TRANSFER（換月台），兩段的線代碼不同', L.map(l => l.type).join() === 'WALK,METRO_RIDE,TRANSFER,METRO_RIDE,WALK' && L[1].lineId === 'TB' && L[3].lineId === 'G' && /換月台/.test(L[2].src));
}
{ // 6. 起終點附近沒有捷運
  const r = plans(C.near({ lat: C.LAT0, lon: C.LON0 }, 600, 8400), C.near({ lat: C.LAT0, lon: C.LON0 }, 900, 500));
  ok('6. 起終點附近沒有捷運：照常給公車方案，不會為了捷運繞遠路', r.length > 1 && !r[0].error && has(r, /metro/).length === 0 && r.every(o => o.error || /bus/.test(kinds(o))));
}
{ // 捷運當中間段
  const r = plans(C.near(S('G4'), 1800, 0), C.near(S('G14'), 0, -1500));
  ok('捷運可以是中間段（公車 → 捷運 → 公車）', has(r, /^bus>metro>bus/).length > 0, has(r, /^bus>metro>bus/).map(kinds)[0]);
}
{ // 捷運站被密集的公車站擋住：最近 6 站之外的捷運站仍是候選
  const [x, y] = W(C.near(S('G9'), 320, 260)), near6 = BC.nearbyStops(x, y, 6, 500, 'out'), all = BC.nearbyStops(x, y, 99, 500, 'out');
  ok('起點附近公車站很多時，500 m 內的捷運站仍在候選內', near6.some(o => b.stopKind[o.i] === 'metro') && all.filter(o => b.stopKind[o.i] === 'bus').length > 6);
}

console.log('④ 公車資料的座標修正不影響捷運');
{ const sw = JSON.parse(JSON.stringify(city.bus)); for (const n of Object.values(sw.nodes)) [n.latitude, n.longitude] = [n.longitude, n.latitude];
  quiet(() => { T.loadBus(sw); });
  const i = State.bus.names.indexOf('市政府'), [x, y] = W(S('G9'));
  ok('公車檔經緯度對調（系統自動改用對調修正）時，捷運站仍在正確位置', State.bus.diag.adopted === '經緯度欄位對調' && geo.worldDistM(State.bus.x[i], State.bus.y[i], x, y) < 0.5, State.bus.diag.adopted);
  const r = plans(C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60)); ok('   這時仍找得到捷運方案', has(r, /metro/).length > 0);
  quiet(() => T.loadBus(city.bus));
}

console.log('⑤ 時刻表搜尋（RAPTOR／CSA）包含捷運');
const ttRun = async (algo, depMs, a, z) => {
  const [fx, fy] = W(a), [tx, ty] = W(z), net = await TT.buildNet(fx, fy, tx, ty, true), acc = i => (b.stopKind[i] === 'metro' ? 90 : 0);
  const orig = BC.nearbyStops(fx, fy, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, t: depMs + (s.dm / 1.2 + acc(s.i)) * 1000 }));
  const targ = BC.nearbyStops(tx, ty, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, sec: s.dm / 1.2 + acc(s.i) }));
  return { net, js: algo === 'csa' ? TT.csa(net, orig, targ) : TT.raptor(net, orig, targ) };
};
const dep = Date.parse('2026-11-18T09:00:00+08:00');
for (const algo of ['raptor', 'csa']) {
  const { net, js } = await ttRun(algo, dep, C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60)), j = js[js.length - 1], rides = j ? j.legs.filter(l => l.type === 'ride') : [];
  ok(`${algo.toUpperCase()}：捷運以班距加入（兩條線 × 兩個方向）`, net.metro.n === 4);
  ok(`${algo.toUpperCase()}：找到捷運行程，標示為班距推估`, rides.length === 1 && rides[0].metro && rides[0].est && rides[0].lineId === 'G' && rides[0].stops === 15, j && `抵達 ${new Date(j.arriveMs + 8 * 3600e3).toISOString().slice(11, 16)}`);
  ok(`${algo.toUpperCase()}：時間可行（上車不早於出發、下車晚於上車）`, rides.length && rides[0].dep >= dep && rides[0].arr > rides[0].dep);
}
{ const { js } = await ttRun('raptor', dep, C.near(S('TB1'), 40, 30), C.near(S('G4'), -60, 40)), j = js.find(x => x.legs.filter(l => l.type === 'ride').length === 2);
  ok('RAPTOR：捷運跨線轉乘（藍 → 綠）', !!j && j.legs.filter(l => l.type === 'ride').map(l => l.lineId).join() === 'TB,G'); }
// 有 TDX 班距與首末班資料時（測試資料）：依時段取班距、收班後不能搭
{ const fr = [{ LineID: 'G', ServiceDay: { Sunday: 1, Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1 }, Headways: [{ StartTime: '07:00', EndTime: '09:00', MinHeadwayMins: 4, MaxHeadwayMins: 6 }, { StartTime: '09:00', EndTime: '23:59', MinHeadwayMins: 10, MaxHeadwayMins: 10 }] }];
  const fl = G.flatMap(s => [{ LineID: 'G', StationID: s.StationID, DestinationStaionID: 'G17', FirstTrainTime: '06:00', LastTrainTime: '23:30' }, { LineID: 'G', StationID: s.StationID, DestinationStaionID: 'G0', FirstTrainTime: '06:00', LastTrainTime: '23:30' }]);
  quiet(() => T.loadMetro({ Stations: city.metro, Frequency: fr, FirstLastTimetable: fl }));
  ok('班距依時段：08:00 尖峰 5 分、12:00 離峰 10 分（來源 TDX Frequency）', TT.metroHeadway('G', Date.parse('2026-11-18T08:00:00+08:00')).sec === 300 && TT.metroHeadway('G', Date.parse('2026-11-18T12:00:00+08:00')).sec === 600 && TT.metroHeadway('G', dep).src === 'TDX Frequency');
  const late = await ttRun('raptor', Date.parse('2026-11-18T23:50:00+08:00'), C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60));
  ok('末班車之後：時刻表搜尋不會給出捷運行程', !late.js.some(j => j.legs.some(l => l.metro)));
  const early = await ttRun('raptor', Date.parse('2026-11-18T05:30:00+08:00'), C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60)), ej = early.js.find(j => j.legs.some(l => l.metro));
  ok('首班車之前出發：要等到首班才上車', !!ej && ej.legs.find(l => l.metro).dep >= Date.parse('2026-11-18T06:00:00+08:00'));
  quiet(() => T.loadMetro(city.metro));
  ok('沒有首末班資料：不判斷收班（hoursKnown = false），由介面標示', (await ttRun('raptor', dep, C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60))).js.some(j => j.legs.some(l => l.metro && l.hoursKnown === false)));
}

console.log('⑥ API（/api/v1/transit）');
{ const D = mkdtempSync(path.join(os.tmpdir(), 'bp-metro-')); mkdirSync(D + '/graph'); mkdirSync(D + '/bus');
  for (const k of ['nodes', 'edges', 'roads']) writeFileSync(`${D}/graph/${k}.json`, JSON.stringify(city.road[k]));
  writeFileSync(D + '/bus/graph.json', JSON.stringify(city.bus)); writeFileSync(D + '/metro.json', JSON.stringify(city.metro));
  const { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
  const info = quiet(() => engine.loadData(readConfig({ DATA_DIR: D, CACHE_DIR: D + '/.c', LOG: '0' })));
  const q = p => `${p.lat},${p.lon}`, r = engine.transit({ from: q(C.near(S('G3'), 60, 40)), to: q(C.near(S('G16'), -50, 60)) }), o = r.options[r.recommended], ml = o.legs.find(l => l.type === 'METRO_RIDE');
  ok('回傳 METRO_RIDE，含線代碼、路線名稱、上下車站、站數、乘車時間', !!ml && ml.lineId === 'G' && ml.route === '捷運綠線' && ml.from.name === '舊社' && ml.to.name === '烏日' && ml.stops === 15 && ml.rideS > 0 && ml.from.line === 'G');
  ok('原有欄位不變（rides、kind: metro），另加 lineId', o.rides[0].kind === 'metro' && o.rides[0].lineId === 'G' && typeof o.totalS === 'number');
  const r5 = engine.transit({ from: q(C.near(S('TB1'), 40, 30)), to: q(C.near(S('G4'), -60, 40)) }), x = r5.options.find(op => op.legs.some(l => l.type === 'TRANSFER' && l.from.kind === 'metro' && l.to.kind === 'metro'));
  ok('跨線方案回傳 TRANSFER（步行距離、時間、來源）', !!x && x.legs.find(l => l.type === 'TRANSFER').walkM > 0);
  const ts = info.transit;
  ok('資料統計：捷運節點、捷運邊、轉乘數、孤立數', ts.metroStations === 24 && ts.metroEdges === 44 && ts.metroBusTransfers > 0 && ts.metroLineTransfers > 0 && ts.metroIsolated === 0, JSON.stringify({ n: ts.metroStations, e: ts.metroEdges, xb: ts.metroBusTransfers, xm: ts.metroLineTransfers, iso: ts.metroIsolated }));
  writeFileSync(D + '/metro.json', JSON.stringify({ id: 'taichung', stations: [{ id: '103a', x: 1, y: 2 }] }));
  const bad = quiet(() => engine.loadData(readConfig({ DATA_DIR: D, CACHE_DIR: D + '/.c', LOG: '0' })));
  ok('捷運檔格式不對：健康資訊顯示「未載入」並列出原因（以前會顯示已載入）', bad.data.metro === false && bad.warnings.some(w => /metro：找不到站點/.test(w)), bad.warnings.join(' / '));
  rmSync(D, { recursive: true, force: true });
}
done();
