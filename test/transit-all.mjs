// transit-all.mjs — 全台公車（v1.16）：來源（22 縣市＋公路客運＋台灣好行）、資料清單（OAS 列舉、舊檔名相容）、多來源合併（台灣好行與縣市路線重複）、
// 同步＋建資料（假的 TDX）、RAPTOR 用到公路客運並標示、轉乘（公車鄰站上限、軌道站直線推估、存檔與失效）
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
console.info = () => {}; console.warn = () => {};
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const S = await import('../server/transit/snapshot.mjs'), T = await import('../server/transit/transfer-engine.mjs');
const { makeContext } = await import('../server/transit-engine.mjs'), { planTransit } = await import('../server/transit/raptor.mjs');

console.log('① 來源與資料清單');
ok('all → 22 縣市＋公路客運＋台灣好行', S.busSources('all').length === 24 && S.busSources('all').includes('InterCity') && S.busSources('全台').includes('TaiwanTrip'));
ok('逗號／空白分隔（PowerShell 會拆開）', JSON.stringify(S.busSources('Taipei, NewTaipei InterCity')) === '["Taipei","NewTaipei","InterCity"]');
{ const L = S.datasetList('all', []), names = new Set(L.map(d => d.name));
  ok('全台：68 個資料集（不問 OAS 沒列的當日班表、市區／公路客運的站間時間）', L.length === 68 && !names.has('bus.Taipei.daily') && names.has('bus.Taichung.daily') && !names.has('bus.Taipei.s2s') && names.has('bus.TaiwanTrip.s2s'), String(L.length));
  ok('路徑：縣市 /Bus/…/City/X、公路客運 /Bus/…/InterCity、台灣好行 /Tourism/Bus/…/TaiwanTrip（站間時間是 S2TravelTime）',
    L.find(d => d.name === 'bus.NewTaipei.stopOfRoute').path === '/Bus/StopOfRoute/City/NewTaipei?%24format=JSON' && L.find(d => d.name === 'bus.InterCity.schedule').path === '/Bus/Schedule/InterCity?%24format=JSON' && L.find(d => d.name === 'bus.TaiwanTrip.s2s').path === '/Tourism/Bus/S2TravelTime/TaiwanTrip?%24format=JSON'); }
ok('單一縣市：沿用舊檔名 bus.<種類>（既有快取不必重抓）', S.datasetList('Taichung', []).filter(d => d.group === 'bus').map(d => d.name).join() === 'bus.stopOfRoute,bus.schedule,bus.daily,bus.s2s');

// ---------- 假的 TDX：兩個縣市＋公路客運＋台灣好行（台灣好行的路線就是台北市的 R1）----------
const pos = (lat, lon) => ({ PositionLat: lat, PositionLon: lon });
const route = (city, uid, name, stops, extra = {}) => ({ RouteUID: uid, RouteID: uid, RouteName: name == null ? undefined : { Zh_tw: name }, SubRouteUID: uid + '01', SubRouteName: { Zh_tw: name || 'T1' }, Direction: 0, City: city,
  Stops: stops.map(([id, n, la, lo], i) => ({ StopUID: id, StopID: id, StopName: { Zh_tw: n }, StopSequence: i + 1, StopPosition: pos(la, lo) })), ...extra });
const sched = (uid, stops, starts) => ({ RouteUID: uid, SubRouteUID: uid + '01', Direction: 0, Timetables: starts.map((t0, k) => ({ TripID: String(k + 1), ServiceDay: { Sunday: 1, Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1 },
  StopTimes: stops.map((s, i) => { const m = t0 + i * 10, hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0'); return { StopSequence: i + 1, StopUID: s[0], ArrivalTime: `${hh}:${mm}`, DepartureTime: `${hh}:${mm}` }; }) })) });
const A = [['TPE1', '台北甲', 25.000, 121.500], ['TPE2', '台北乙', 25.000, 121.510], ['TPE3', '台北轉運站', 25.000, 121.520]];
const IC = [['THB1', '台北轉運站（客運）', 25.0002, 121.5202], ['THB2', '新竹轉運站', 24.800, 121.000]];
const B = [['HSZ1', '新竹站前', 24.8002, 121.0002], ['HSZ2', '新竹科學園區', 24.780, 121.010]];
const data = {
  '/Bus/StopOfRoute/City/Taipei': [route('Taipei', 'TPE100', '100', A)], '/Bus/Schedule/City/Taipei': [sched('TPE100', A, [8 * 60, 9 * 60])],
  '/Bus/StopOfRoute/City/Hsinchu': [route('Hsinchu', 'HSZ200', '200', B)], '/Bus/Schedule/City/Hsinchu': [sched('HSZ200', B, [9 * 60 + 40, 10 * 60 + 40])],
  '/Bus/StopOfRoute/InterCity': [route(null, 'THB1819', '1819', IC)], '/Bus/Schedule/InterCity': [sched('THB1819', IC, [8 * 60 + 30, 9 * 60 + 30].map(x => x))],
  '/Tourism/Bus/StopOfRoute/TaiwanTrip': [route('Taipei', 'TPE100', null, A, { TaiwanTripName: { Zh_tw: '測試好行線' } }), route('Hsinchu', 'HSZ999', null, [B[0], ['HSZ9', '新竹好行終點', 24.79, 121.02]], { TaiwanTripName: { Zh_tw: '新竹好行線' } })],
};
// 公路客運：台北轉運站 08:30 出發、新竹轉運站 08:40 到（測試用的時刻，只在測試裡）
const calls = []; const fake = async p => { calls.push(p); const k = p.split('?')[0]; return k in data ? { status: 200, data: data[k] } : { status: 404, data: null, detail: 'Resouce Not Found' }; };

console.log('② 同步與建資料（假的 TDX）');
const dir = mkdtempSync(path.join(tmpdir(), 'bus-all-')), td = S.createTransitData({ dir, city: 'Taipei,Hsinchu,InterCity,TaiwanTrip', operators: [], rail: [], fetchJson: fake, now: () => Date.parse('2026-11-25T08:00:00+08:00') });
const r = await td.refresh(); const st = td.store;
ok('每個來源各自一組檔案（bus.<來源>.<種類>）', existsSync(path.join(dir, 'raw', 'bus.InterCity.stopOfRoute.json.gz')) && existsSync(path.join(dir, 'raw', 'bus.TaiwanTrip.stopOfRoute.json.gz')) && r.report.some(x => x.name === 'bus.Taipei.stopOfRoute' && x.action === 'updated'));
ok('只問存在的端點：台北不問當日班表；新竹問（OAS 列舉）', !calls.some(p => /DailyTimeTable\/City\/Taipei/.test(p)) && calls.some(p => /DailyTimeTable\/City\/Hsinchu/.test(p)));
ok('合併：站牌（台北 3＋公路客運 2＋新竹 2＋台灣好行獨有 1）', st.stats.busStops === 8, String(st.stats.busStops));
const pat = id => st.patterns.find(p => p.id.startsWith(id));
ok('台灣好行與台北 100 是同一條路線：不重複，標示「台灣好行」與路線名稱', st.patterns.filter(p => p.routeUID === 'TPE100').length === 1 && pat('TPE10001').busKind === '台灣好行' && pat('TPE10001').tourName === '測試好行線 T1' && st.detail.bus.taiwanTripMerged === 1);
ok('台灣好行獨有的路線：保留，名稱用 TaiwanTripName', pat('HSZ99901') && pat('HSZ99901').name.startsWith('新竹好行線') && pat('HSZ99901').busKind === '台灣好行');
ok('公路客運：標示來源類別', pat('THB181901').busKind === '公路客運' && /公路客運/.test(pat('THB181901').source));
ok('各來源的統計分開', st.detail.bus.bySource && st.detail.bus.bySource.InterCity && st.detail.bus.bySource.Taipei.patterns === 1);

console.log('③ 規劃：跨縣市用公路客運，路線名稱標示');
{ const ctx = makeContext(st, td.extra, null), res = planTransit(ctx, { from: [25.000, 121.500], to: [24.780, 121.010], departMs: Date.parse('2026-11-25T07:55:00+08:00'), modes: [], maxWalkM: 800 });
  const it = res.itineraries[0], rides = it ? it.legs.filter(l => /RIDE/.test(l.type)) : [];
  ok('台北甲 → 新竹科學園區：台北公車 → 公路客運 → 新竹公車', rides.length === 3 && rides.some(l => l.busKind === '公路客運'), JSON.stringify(rides.map(l => l.routeName)));
  ok('路線名稱：公路客運 1819、台灣好行 測試好行線 T1（100）', rides.some(l => l.routeName === '公路客運 1819') && rides.some(l => l.routeName === '台灣好行 測試好行線 T1（100）'), JSON.stringify(rides.map(l => l.routeName))); }

console.log('④ 轉乘：公車鄰站上限、軌道站直線推估、存檔');
{ // 15 個公車站排在一條線上（每 30 m），加 2 個相距 300 m 的火車站（步行路網走不到它們之間）
  const stops = Array.from({ length: 15 }, (_, i) => ({ uid: 'B' + i, mode: 'bus', lat: 25, lon: 121 + i * 0.0003 })).concat([{ uid: 'R1', mode: 'tra', lat: 25.001, lon: 121.001 }, { uid: 'R2', mode: 'thsr', lat: 25.0037, lon: 121.001 }]);
  const store = { stops, transfers: [], stopIndex: new Map(stops.map((s, i) => [s.uid, i])) };
  const hav = (a, b) => Math.hypot((a.lat - b.lat) * 110574, (a.lon - b.lon) * 111320 * Math.cos(25 * Math.PI / 180));
  const fakeRouter = { g: { head: { created: 'test-graph' } }, footSnap: (lat, lon) => ({ lat, lon }),
    footReach: s => ({ at: t => { const a = { lat: s.lat, lon: s.lon }, b = { lat: t.lat, lon: t.lon }, rail = x => x.lat > 25.0005; if (rail(a) && rail(b)) return null; const d = hav(a, b); return d / 1.2 <= 480 ? { s: Math.round(d / 1.2), m: Math.round(d) } : null; } }) };
  const tr = T.buildTransfers(store, fakeRouter, { maxBusPairs: 4 }), nb = i => { const o = []; for (let k = tr.start[i]; k < tr.start[i + 1]; k++) o.push(stops[tr.to[k]].uid); return o; };
  ok('公車站只留最近的 4 個公車鄰站（另加軌道站）', nb(7).filter(u => u[0] === 'B').length === 4 && tr.stats.prunedBusPairs > 0, nb(7).join(','));
  ok('連到軌道站的不刪', nb(3).includes('R1') || nb(4).includes('R1'));
  const r1 = stops.findIndex(s => s.uid === 'R1'), k = (() => { for (let q = tr.start[r1]; q < tr.start[r1 + 1]; q++) if (stops[tr.to[q]].uid === 'R2') return q; return -1; })();
  ok('兩個火車站 450 m 內、步行路網走不到 → 直線推估並標示（kind 2）', k >= 0 && tr.kind[k] === 2 && tr.stats.crowRail >= 1);
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'tr-')), 'transfers.json.gz');
  const a = T.buildTransfersCached(store, fakeRouter, { cacheFile: f, maxBusPairs: 4 }), b = T.buildTransfersCached(store, fakeRouter, { cacheFile: f, maxBusPairs: 4 });
  ok('存檔：第二次直接讀檔，內容相同', !a.stats.cached && b.stats.cached && [...a.to].join() === [...b.to].join() && [...a.sec].join() === [...b.sec].join() && b.snaps.length === a.snaps.length);
  stops[0].lat += 0.001; const c = T.buildTransfersCached(store, fakeRouter, { cacheFile: f, maxBusPairs: 4 });
  ok('站點座標變了 → 鍵不同，重新計算', !c.stats.cached); }

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n✓ 全台公車測試全部通過');
process.exit(fails ? 1 : 0);
