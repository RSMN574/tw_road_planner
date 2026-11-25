// bus-realtime.mjs — 公車即時（v1.19）：RealtimeDataCache、站牌到站的配對與狀態、車輛位置（吸附、過期、下一站）、站牌靜態資訊
// 全部用假的 TDX 回應（照 2026-11-25 實際呼叫看到的欄位），不需要金鑰；數字只代表測試資料
import { ok, done } from './helpers.mjs';
const { createRealtimeCache } = await import('../server/transit/realtime-cache.mjs');
const { createBusRealtime, parseLineWkt, projectOnLine, busRtPath } = await import('../server/transit/bus-realtime.mjs');
const { stopInfo, stopsInBBox, routeInfo, serviceDay } = await import('../server/transit/stop-info.mjs');
const { createEtaStore } = await import('../server/transit/eta-store.mjs');

let T = Date.parse('2026-11-25T09:30:00Z');                     // 台灣時間 17:30
const now = () => T, iso = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';

console.log('① RealtimeDataCache：快取、合併、錯誤冷卻、呼叫上限');
{ let calls = 0; const c = createRealtimeCache({ now, maxCallsPerMin: 3 });
  const slow = () => new Promise(r => setTimeout(() => r(++calls), 20));
  const [a, b] = await Promise.all([c.get('k', { ttlMs: 10e3 }, slow), c.get('k', { ttlMs: 10e3 }, slow)]);
  ok('同時兩個相同請求 → 上游只打一次', calls === 1 && a.value === 1 && b.value === 1);
  const h = await c.get('k', { ttlMs: 10e3 }, slow); ok('ttl 內回快取', h.cached && calls === 1);
  T += 11e3; const f = await c.get('k', { ttlMs: 10e3 }, () => Promise.reject(new Error('TDX HTTP 500')));
  ok('上游失敗：回上一筆資料並標示 stale＋錯誤', f.stale && f.value === 1 && /500/.test(f.error));
  const g = await c.get('k', { ttlMs: 10e3 }, slow); ok('錯誤冷卻期間不再打上游', calls === 1 && g.stale);
  await c.get('a', { ttlMs: 1 }, slow); let err = null; try { await c.get('b', { ttlMs: 1 }, slow); } catch (e) { err = e; }
  ok('每分鐘呼叫上限：沒有舊資料 → 503 REALTIME_BUDGET', err && err.code === 'REALTIME_BUDGET' && c.stats.budgetDenied === 1);
  T += 61e3; const z = await c.get('b', { ttlMs: 1 }, slow); ok('一分鐘後恢復', z.value > 1);
  const to = createRealtimeCache({ now }); const r = await to.get('t', { ttlMs: 1, timeoutMs: 30 }, () => new Promise(() => {})); ok('上游逾時 → 回錯誤，不卡住', /逾時/.test(r.error) && to.stats.timeouts === 1); }

console.log('② eta-store：不同子路線不混');
{ const e = createEtaStore({ now });
  e.ingest([{ RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, StopUID: 'S1', EstimateTime: 300, StopStatus: 0, SrcUpdateTime: iso(T) }], T);
  ok('同一個 SubRouteUID：查得到', e.get({ subRouteUID: 'R1A', routeUID: 'R1', direction: 0, stopUID: 'S1' }, T).kind === 'live');
  ok('同路線另一個子路線（R1B）：不會拿到 R1A 的到站', e.get({ subRouteUID: 'R1B', routeUID: 'R1', direction: 0, stopUID: 'S1' }, T).kind === 'none');
  ok('同路線反方向：不會拿到', e.get({ subRouteUID: 'R1A', routeUID: 'R1', direction: 1, stopUID: 'S1' }, T).kind === 'none'); }

// ---- 假的路線：東西向直線 3 站（120.600 → 120.610，緯度 24.100），子路線 R1A 去程、R1B（同名、不同子路線）
const LAT = 24.1, lonAt = m => 120.6 + m / (111320 * Math.cos(LAT * Math.PI / 180));
const stops = [{ uid: 'S1', name: '甲站', lat: LAT, lon: lonAt(0), mode: 'bus' }, { uid: 'S2', name: '乙站', lat: LAT, lon: lonAt(500), mode: 'bus' }, { uid: 'S3', name: '丙站', lat: LAT, lon: lonAt(1000), mode: 'bus' }];
const mkP = (id, sub, dir, uids, extra = {}) => ({ id, mode: 'bus', routeUID: 'R1', subRouteUID: sub, direction: dir, name: '1', subName: sub === 'R1B' ? '1副' : '1', city: 'Taichung', operator: 'X', stops: uids, seqs: uids.map((_, i) => i + 1), trips: [], freqs: [], ...extra });
const patterns = [mkP('R1A|0', 'R1A', 0, ['S1', 'S2', 'S3']), mkP('R1B|0', 'R1B', 0, ['S1', 'S2', 'S3']), mkP('R1A|1', 'R1A', 1, ['S3', 'S2', 'S1'])];
const stopIndex = new Map(stops.map((s, i) => [s.uid, i])), stopPatterns = stops.map(() => []); patterns.forEach((p, pi) => p.stops.forEach((u, pos) => stopPatterns[stopIndex.get(u)].push([pi, pos])));
const U = -2147483648, { date, startMs } = serviceDay(T);
// 今天的班表：R1A|0 在 S2（pos 1）17:40、18:10、末班 21:00；R1B 沒有班表
const daySec = h => Math.round((Date.parse(`${date}T${h}:00+08:00`) - startMs) / 1000);
const dep = [daySec('17:30'), daySec('17:40'), daySec('17:50'), daySec('18:00'), daySec('18:10'), daySec('18:20'), daySec('20:50'), daySec('21:00'), daySec('21:10')];
const store = { version: 't1', stops, stopIndex, patterns, stopPatterns, UNKNOWN: U, freqAt: () => null,
  day: d => d === date ? { info: ['daily', 'none', 'none'], groupsOf: [[0], [], []], groups: [{ p: 0, S: 3, n: 3, dep: Int32Array.from(dep), arr: Int32Array.from(dep), flags: new Uint8Array(3) }] } : { info: ['none', 'none', 'none'], groupsOf: [[], [], []], groups: [] } };

console.log('③ 站牌靜態資訊（背景執行緒）');
{ const info = stopInfo(store, 'S2', T);
  ok('經過站牌的路線：以子路線＋方向為單位（同名 1 與 1副、去回程各自一筆）', info.routes.length === 3 && new Set(info.routes.map(r => r.pattern)).size === 3);
  const a = info.routes.find(r => r.pattern === 'R1A|0');
  ok('預定時刻：下兩班 17:40、18:10，末班 21:00（台灣時間）', a.scheduled.source === 'daily' && a.scheduled.next.length === 3 && new Date(a.scheduled.next[0].ms + 8 * 3600e3).toISOString().slice(11, 16) === '17:40' && new Date(a.scheduled.last.ms + 8 * 3600e3).toISOString().slice(11, 16) === '21:00');
  ok('目的地＝路線型態的最後一站（去回程不同）', a.destination === '丙站' && info.routes.find(r => r.pattern === 'R1A|1').destination === '甲站');
  ok('在終點站的路線標示 terminal', stopInfo(store, 'S3', T).routes.find(r => r.pattern === 'R1A|0').terminal === true && !a.terminal);
  ok('站牌範圍查詢', stopsInBBox(store, [120.599, 24.09, 120.606, 24.11]).stops.length === 2);
  ok('路線站序', routeInfo(store, 'R1A|1').stops.map(s => s.uid).join() === 'S3,S2,S1');
  ok('查不到的站牌 → null', stopInfo(store, 'NOPE', T) === null); }

// ---- 假的 TDX
const seen = []; let fake = {};
const fetchJson = async path => { seen.push(decodeURIComponent(path)); for (const [k, v] of Object.entries(fake)) if (path.includes(k)) return typeof v === 'function' ? v(path) : { status: 200, data: v }; return { status: 200, data: [] }; };
const mkRt = () => createBusRealtime({ fetchJson, cache: createRealtimeCache({ now }), now });

console.log('④ 站牌到站：配對與六種狀態');
{ fake = { EstimatedTimeOfArrival: [
    { RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, StopUID: 'S2', StopSequence: 2, EstimateTime: 240, StopStatus: 0, Estimates: [{ PlateNumb: 'AAA-1', EstimateTime: 240, IsLastBus: false }, { PlateNumb: 'BBB-2', EstimateTime: 1500, IsLastBus: true }], SrcUpdateTime: iso(T - 20e3) },
    { RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 1, StopUID: 'S2', StopSequence: 2, StopStatus: 3, SrcUpdateTime: iso(T - 20e3) }] };
  const rt = mkRt(), info = stopInfo(store, 'S2', T), d = await rt.stopArrivals(info), by = id => d.routes.find(r => r.pattern === id).rt;
  ok('只用 StopUID 查一次（$filter），不抓整個縣市', seen.length === 1 && /EstimatedTimeOfArrival\/City\/Taichung\?\$filter=StopUID eq 'S2'/.test(seen[0]), seen[0]);
  ok('即時：240 秒後、下一班 1500 秒（末班車）', by('R1A|0').state === 'realtime' && by('R1A|0').arrivals[0].etaS === 220 && by('R1A|0').arrivals[1].last === true, JSON.stringify(by('R1A|0').arrivals));
  ok('反方向 StopStatus 3 → 末班車已過（ended）', by('R1A|1').state === 'ended');
  ok('同名子路線（1副）沒有即時資料 → 不借用 1 的到站，也不判定停駛（沒有時刻表 → 尚無資料）', by('R1B|0').state === 'nodata', by('R1B|0').state);
  T += 200e3; const d2 = await mkRt().stopArrivals(stopInfo(store, 'S2', T));
  ok('資料超過 180 秒 → 過期（stale），不當成即時', d2.routes.find(r => r.pattern === 'R1A|0').rt.state === 'stale');
  T -= 200e3;
  fake = { EstimatedTimeOfArrival: [{ RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, StopUID: 'S2', StopStatus: 4, SrcUpdateTime: iso(T) }, { RouteUID: 'R1', SubRouteUID: 'R1B', Direction: 0, StopUID: 'S2', StopStatus: 1, NextBusTime: iso(T + 1200e3), SrcUpdateTime: iso(T) }] };
  const d3 = await mkRt().stopArrivals(stopInfo(store, 'S2', T)), b3 = id => d3.routes.find(r => r.pattern === id).rt;
  ok('StopStatus 4 → 今日未營運（suspended）；1 → 尚未發車＋業者預告發車時間', b3('R1A|0').state === 'suspended' && b3('R1B|0').state === 'notDeparted' && b3('R1B|0').nextBusMs === T + 1200e3);
  fake = {}; const d4 = await mkRt().stopArrivals(stopInfo(store, 'S2', T));
  ok('完全沒有即時資料但有時刻表 → 預定時刻（scheduled），不是「沒有營運」', d4.routes.find(r => r.pattern === 'R1A|0').rt.state === 'scheduled');
  fake = { EstimatedTimeOfArrival: () => ({ status: 503, data: null, detail: 'busy' }) }; const d5 = await mkRt().stopArrivals(stopInfo(store, 'S2', T)), b5 = d5.routes.find(r => r.pattern === 'R1A|0').rt;
  ok('TDX 失敗 → 標示「即時資料暫時無法取得」，有時刻表就顯示時刻表', b5.state === 'scheduled' && /暫時無法取得/.test(b5.label) && d5.errors.length === 1);
  ok('在終點站 → 終點站（下車）', (await mkRt().stopArrivals(stopInfo(store, 'S3', T))).routes.find(r => r.pattern === 'R1A|0').rt.state === 'terminal'); }

console.log('⑤ 路線車輛：配對、吸附線形、過期、下一站');
{ const wkt = `LINESTRING(${lonAt(-50)} ${LAT},${lonAt(1050)} ${LAT})`;
  ok('WKT 解析與投影', parseLineWkt(wkt)[0].length === 2 && Math.abs(projectOnLine(parseLineWkt(wkt)[0], lonAt(300), LAT + 20 / 110574).distM - 20) < 0.5);
  const a1 = (plate, m, dLat, o = {}) => ({ PlateNumb: plate, RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, BusPosition: { PositionLon: lonAt(m), PositionLat: LAT + dLat / 110574 }, Speed: 20, Azimuth: 90, DutyStatus: 0, BusStatus: 0, GPSTime: iso(T - 30e3), ...o });
  fake = { RealTimeByFrequency: [a1('ON-1', 300, 8), a1('FAR-2', 600, 150), a1('OLD-3', 700, 0, { GPSTime: iso(T - 400e3) }), a1('GONE-4', 800, 0, { GPSTime: iso(T - 900e3) }),
      a1('BACK-5', 400, 0, { Direction: 1 }), a1('SUB-6', 400, 0, { SubRouteUID: 'R1B' })],
    RealTimeNearStop: [{ PlateNumb: 'ON-1', RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, StopUID: 'S1', StopSequence: 1, A2EventType: 0, GPSTime: iso(T - 60e3) }],
    'EstimatedTimeOfArrival': [{ RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, StopUID: 'S2', Estimates: [{ PlateNumb: 'ON-1', EstimateTime: 50 }], SrcUpdateTime: iso(T - 10e3) }],
    Shape: [{ RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 0, Geometry: wkt }, { RouteUID: 'R1', SubRouteUID: 'R1A', Direction: 1, Geometry: 'LINESTRING(0 0,1 1)' }] };
  seen.length = 0; const rt = mkRt(), d = await rt.routeVehicles(routeInfo(store, 'R1A|0')), v = p => d.vehicles.find(x => x.plate === p);
  ok('只抓這條路線（RouteUID 篩選）：A1、A2、N1、線形各一次', seen.length === 4 && seen.every(s => /RouteUID eq 'R1'/.test(s)));
  ok('反方向、不同子路線的車不顯示', !v('BACK-5') && !v('SUB-6'));
  ok('離線形 8 m → 吸附到路線上', v('ON-1').snapped && Math.abs(v('ON-1').pos[1] - LAT) < 1e-7 && v('ON-1').offRouteM === 8);
  ok('離線形 150 m → 不吸附，顯示原始 GPS 並標示距離', !v('FAR-2').snapped && v('FAR-2').offRouteM === 150);
  ok('GPS 400 秒前 → 顯示但標示過期；900 秒前 → 不顯示（不把舊位置當即時位置）', v('OLD-3').stale && !v('GONE-4') && d.hiddenOld === 1);
  ok('下一站：A2 剛離開甲站 → 乙站，ETA 取同一台車的 N1（扣掉資料經過的時間）', v('ON-1').next.uid === 'S2' && v('ON-1').next.how === 'A2' && v('ON-1').next.etaS === 40 && v('ON-1').current.event === '離站', JSON.stringify(v('ON-1').next));
  ok('沒有 A2 的車：依線形上的位置推算下一站（並標示）', v('FAR-2').next === null || v('FAR-2').next.how !== 'A2');
  const d2 = await mkRt().routeVehicles(routeInfo(store, 'R1A|0')); ok('有線形（依子路線＋方向挑選）', d2.shape && d2.shape.coords.length === 2 && d2.shape.coords[0][1] === LAT);
  fake = { RealTimeByFrequency: [a1('ON-1', 300, 8)] };
  const d3 = await mkRt().routeVehicles(routeInfo(store, 'R1A|0')); ok('沒有線形 → 不吸附並說明', !d3.shape && !d3.vehicles[0].snapped && /沒有這條路線的線形/.test(d3.note));
  ok('公路客運、台灣好行用各自的 TDX 路徑', busRtPath({ kind: 'InterCity' }, 'Shape') === '/Bus/Shape/InterCity' && busRtPath({ kind: 'TaiwanTrip' }, 'Shape') === '/Tourism/Bus/Shape/TaiwanTrip' && busRtPath({ kind: 'City', city: null }, 'Shape') === null); }
done();
