// rail-provider.mjs — TransitDataAdapter（軌道）：TDX 台鐵／高鐵／捷運站別時刻表／轉乘／GIS 線型 → timetable-store 的「車站／路線型態／班次」
// 欄位全部依使用者提供的 OAS（docs/oas/tdx-rail-v2.json「公共運輸-軌道 v2」、docs/oas/tdx-gis-v3.json「GIS圖資 v3」）；純函式、無 I/O。
//
//   台鐵 TRA  v2：Station、GeneralTimetable（定期，含 ServiceDay）、DailyTimetable/TrainDate/{date}（當日，含停駛 SuspendedFlag）、ODFare、LiveTrainDelay（即時誤點）
//   高鐵 THSR v2：Station、GeneralTimetable（含 ServiceDay、EffectiveDate／ExpiringDate）、DailyTimetable/TrainDate/{date}、ODFare（TicketType／FareClass／CabinClass）
//   捷運／輕軌 v2：StationTimeTable（站別發車時刻，依 ServiceDay）→ 加到 metro-provider 的型態上，作為「該站實際發車時刻」
//                  StationTransfer（RailTransfers：MinTransferTime 分、IsOnSiteTransfer）、TransferStations（共站站點）→ 轉乘
//   GIS v3：Map/Rail/Network/Line/OperatorCode/{op}（Geometry 是 WKT 字串）→ 畫乘車段的軌道線型；沒有時用站與站之間的直線（標示）
//
// 原則：時刻只用資料裡有的；當日班表有今天的資料就用它（含停駛），沒有才用定期班表依星期判斷；兩者都沒有＝資訊不足，不是停駛。
import { dayMask, parseHms, parseStamp, parseDateOnly, DAY_S } from './time.mjs';

const zh = o => (o && typeof o === 'object' ? (o.Zh_tw ?? o.En ?? null) : (typeof o === 'string' ? o : null));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : NaN));
export const RAIL_MODE = { TRA: 'tra', THSR: 'thsr' };
// 捷運系統 → 本系統運具（輕軌獨立成 lrt，結果分段為 LIGHT_RAIL_RIDE）
export const LRT_OPS = new Set(['KLRT', 'NTDLRT', 'NTALRT']);
export const metroModeOf = op => (LRT_OPS.has(op) ? 'lrt' : 'metro');

// ---------- WKT（GIS 圖資的 Geometry 欄位）----------
// 支援 POINT、LINESTRING、MULTILINESTRING（可有 SRID=4326; 前綴）；回傳 [[[lon, lat], …], …]（多條線）或 null
export function parseWkt(s) {
  if (typeof s !== 'string') return null; const t = s.replace(/^SRID=\d+;/i, '').trim(), m = /^(POINT|LINESTRING|MULTILINESTRING)\s*(?:Z|M|ZM)?\s*\((.*)\)\s*$/is.exec(t); if (!m) return null;
  const pts = str => str.split(',').map(p => p.trim().split(/\s+/).map(Number)).filter(a => a.length >= 2 && Number.isFinite(a[0]) && Number.isFinite(a[1])).map(a => [a[0], a[1]]);
  const kind = m[1].toUpperCase();
  if (kind === 'POINT') { const p = pts(m[2]); return p.length ? [p] : null; }
  if (kind === 'LINESTRING') { const p = pts(m[2]); return p.length >= 2 ? [p] : null; }
  const lines = [...m[2].matchAll(/\(([^()]*)\)/g)].map(x => pts(x[1])).filter(l => l.length >= 2); return lines.length ? lines : null;
}

// ---------- 台鐵、高鐵：車站 ----------
function stationsOf(list, op, mode, src) {
  const stops = [], byId = new Map(), bad = { noId: 0, noCoord: 0, dup: 0 };
  for (const s of list || []) {
    if (!s || !s.StationID) { bad.noId++; continue; }
    const uid = s.StationUID || `${op}-${s.StationID}`; if (byId.has(String(s.StationID))) { bad.dup++; continue; }
    const lat = num(s.StationPosition?.PositionLat), lon = num(s.StationPosition?.PositionLon); if (!Number.isFinite(lat) || !Number.isFinite(lon)) bad.noCoord++;
    const st = { uid, stopId: s.StationID, mode, name: zh(s.StationName), lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, stationId: String(s.StationID), operator: op, city: s.LocationCity ?? null, cls: s.StationClass ?? null, source: src, versionId: s.VersionID ?? null, updatedAt: parseStamp(s.UpdateTime) || null };
    stops.push(st); byId.set(String(s.StationID), st);
  }
  return { stops, byId, bad };
}
// 停靠時間 → 營運日秒數（跨夜：比前一站早就加一天）
function stopTimes(list, byId) {
  const st = [...(list || [])].filter(x => x && x.StationID != null).sort((a, b) => num(a.StopSequence) - num(b.StopSequence));
  const uids = [], arr = [], dep = [], susp = []; let last = -Infinity, day = 0, missing = 0;
  for (const x of st) {
    const s = byId.get(String(x.StationID)); if (!s) { missing++; continue; }
    let a = parseHms(x.ArrivalTime), d = parseHms(x.DepartureTime); if (!Number.isFinite(a)) a = d; if (!Number.isFinite(d)) d = a;
    if (Number.isFinite(a)) { a += day; if (a < last - 1800) { day += DAY_S; a += DAY_S; } }                       // 比前一站早 30 分以上＝跨過午夜
    if (Number.isFinite(d)) { d += day; if (Number.isFinite(a) && d < a - 1800) { day += DAY_S; d += DAY_S; } if (Number.isFinite(a) && d < a) d = a; }
    uids.push(s.uid); arr.push(Number.isFinite(a) ? a : NaN); dep.push(Number.isFinite(d) ? d : NaN); susp.push(Number(x.SuspendedFlag) === 1);
    last = Number.isFinite(d) ? d : Number.isFinite(a) ? a : last;
  }
  return { uids, arr, dep, susp, missing };
}
// 一個列車 → 加進「停站序列相同」的型態（同一組停靠站＝同一個 RAPTOR route；不同停靠模式的列車是不同型態）
function addTrip(pmap, patterns, { op, mode, info, times, kind, date, days, src, upd, effective }) {
  const key = times.uids.join('>'); let p = pmap.get(key);
  if (!p) {
    p = { id: `${op}|${patterns.length}`, mode, routeUID: `${op}-${info.TrainTypeID ?? info.Direction ?? ''}`, routeId: null, subRouteUID: null, subRouteId: null, lineId: null, direction: num(info.Direction) || 0,
      name: op === 'THSR' ? '高鐵' : (zh(info.TrainTypeName) || '台鐵'), subName: null, headsign: zh(info.EndingStationName), operator: op, city: null, stops: times.uids, seqs: times.uids.map((_, i) => i + 1),
      trips: [], freqs: [], firstLast: null, runTimes: null, dwell: null, runSource: `TDX Rail/${op}/${src}`, runEstimated: 0, source: `TDX Rail/${op}`, updatedAt: upd ?? null, trainTypes: new Set() };
    pmap.set(key, p); patterns.push(p);
  }
  p.trainTypes.add(zh(info.TrainTypeName) || (op === 'THSR' ? '高鐵' : ''));
  p.trips.push({ id: `${op}-${info.TrainNo}`, trainNo: String(info.TrainNo), kind, date: date ?? null, days, dep: times.dep.map((d, i) => (times.susp[i] ? NaN : d)), arr: times.arr.map((a, i) => (times.susp[i] ? NaN : a)), est: false,
    trainType: zh(info.TrainTypeName) || null, headsign: info.TripHeadsign || zh(info.EndingStationName) || null, effective: effective || null, source: `TDX Rail/${op}/${src}` });
}
// raw：{ station, general, daily }（各為 TDX 回應陣列）；dailyDate：當日班表是哪一天（'YYYY-MM-DD'）
export function buildRail(raw, { operator, fetchedAt = null, dailyDate = null } = {}) {
  const op = operator, mode = RAIL_MODE[op]; if (!mode) throw new Error('buildRail 只支援 TRA、THSR');
  const warnings = [], missing = [], cnt = {}, add = (k, n = 1) => { cnt[k] = (cnt[k] || 0) + n; };
  if (!raw.station?.length) missing.push('Station（車站）');
  if (!raw.general?.length && !raw.daily?.length) missing.push('GeneralTimetable／DailyTimetable（時刻表）');
  const { stops, byId, bad } = stationsOf(raw.station, op, mode, `TDX Rail/${op}/Station`);
  if (bad.noCoord) add('車站缺少座標', bad.noCoord); if (bad.dup) add('StationID 重複', bad.dup);
  const pmap = new Map(), patterns = []; let suspended = 0, partial = 0;
  // 定期時刻表：TRA 的 GeneralTimetable 包在 { GeneralTimetable: { GeneralTrainInfo, StopTimes, ServiceDay } }；THSR 另有 EffectiveDate／ExpiringDate
  for (const g of raw.general || []) {
    const gt = g.GeneralTimetable || g; const info = gt.GeneralTrainInfo; if (!info || !info.TrainNo) { add('定期時刻表缺車次'); continue; }
    const t = stopTimes(gt.StopTimes, byId); if (t.missing) add('停靠站不在車站清單', t.missing); if (t.uids.length < 2) { add('停靠站不足 2 站'); continue; }
    const days = dayMask(gt.ServiceDay), eff = g.EffectiveDate || g.ExpiringDate ? { from: parseDateOnly(String(g.EffectiveDate || '').replace(/:/g, '-')), to: parseDateOnly(String(g.ExpiringDate || '').replace(/:/g, '-')) } : null;
    addTrip(pmap, patterns, { op, mode, info, times: t, kind: 'schedule', days, src: 'GeneralTimetable', upd: parseStamp(gt.SrcUpdateTime) || fetchedAt, effective: eff });
  }
  // 當日時刻表：{ TrainDate, DailyTrainInfo, StopTimes }；停駛（SuspendedFlag=1）不收、部分停駛的站標成不停
  for (const d of raw.daily || []) {
    const info = d.DailyTrainInfo; if (!info || !info.TrainNo) { add('當日時刻表缺車次'); continue; }
    if (Number(info.SuspendedFlag) === 1) { suspended++; continue; } if (Number(info.SuspendedFlag) === 2) partial++;
    const t = stopTimes(d.StopTimes, byId); if (t.missing) add('停靠站不在車站清單', t.missing); if (t.uids.length < 2) continue;
    const date = parseDateOnly(String(d.TrainDate || dailyDate || '').replace(/:/g, '-')) || dailyDate;
    addTrip(pmap, patterns, { op, mode, info, times: t, kind: 'daily', date, days: null, src: 'DailyTimetable', upd: parseStamp(d.UpdateTime) || fetchedAt });
  }
  for (const p of patterns) { p.name = [...p.trainTypes].filter(Boolean).join('／') || p.name; delete p.trainTypes; }
  if (suspended) warnings.push(`${op}：當日停駛 ${suspended} 班（不列入）`); if (partial) warnings.push(`${op}：部分停駛 ${partial} 班（停駛的站不停）`);
  for (const [k, n] of Object.entries(cnt)) warnings.push(`${op}：${k} ×${n}`);
  if (missing.length) warnings.push(`${op} 缺少資料：${missing.join('、')}`);
  return { stops, patterns, transfers: [], exits: [], warnings, missing, stats: { stops: stops.length, patterns: patterns.length, trips: patterns.reduce((a, p) => a + p.trips.length, 0), suspended, partial } };
}

// ---------- 捷運／輕軌：站別時刻表（StationTimeTable）→ 型態上的「各站發車時刻」----------
// 回傳加了幾個站的時刻；型態的 stationDeps[pos] = [{ days, deps: Int32Array(已排序的營運日秒數), source }]
export function attachStationTimetables(metro, list, { operator } = {}) {
  let hit = 0, miss = 0; const byStop = new Map(); metro.stops.forEach(s => byStop.set(String(s.stationId), s.uid));
  for (const r of list || []) {
    const u = byStop.get(String(r.StationID)); if (!u) { miss++; continue; }
    const deps = (r.Timetables || []).map(t => parseHms(t.DepartureTime || t.ArrivalTime)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!deps.length) continue; for (let i = 1; i < deps.length; i++) if (deps[i] < deps[i - 1] - 6 * 3600) deps[i] += DAY_S;   // 跨午夜
    deps.sort((a, b) => a - b);
    const sd = r.ServiceDay || {}, days = dayMask({ Sunday: sd.Sunday, Monday: sd.Monday, Tuesday: sd.Tuesday, Wednesday: sd.Wednesday, Thursday: sd.Thursday, Friday: sd.Friday, Saturday: sd.Saturday });
    const dest = byStop.get(String(r.DestinationStaionID ?? r.DestinationStationID ?? ''));
    for (const p of metro.patterns) {
      const i = p.stops.indexOf(u); if (i < 0 || i === p.stops.length - 1) continue;
      if (dest) { const j = p.stops.indexOf(dest); if (j <= i) continue; } else if (r.Direction != null && Number(r.Direction) !== Number(p.direction)) continue;
      if (r.LineID && p.lineId && String(r.LineID) !== String(p.lineId)) continue;
      (p.stationDeps ||= p.stops.map(() => []))[i].push({ days, deps: Int32Array.from(deps), source: `TDX Rail/Metro/StationTimeTable/${operator}`, tag: sd.ServiceTag || null }); hit++;
    }
  }
  return { attached: hit, unmatched: miss };
}

// ---------- 轉乘（站內）----------
// StationTransfer：{ StationTransfers: [{ StationID, Transfers: [{ RailTransfers: [{ OperatorCode, StationID, MinTransferTime（分）, IsOnSiteTransfer }] }] }] }
// TransferStations：[{ SystemID, TransferStationID, Stations: [{ StationID }] }]（共站：同一個實體車站、不同系統代碼）
export function railTransfers({ stationTransfer = [], transferStations = [] } = {}, uidOf) {
  const out = [], seen = new Set(), push = (a, b, sec, onSite, src) => { if (!a || !b || a === b) return; const k = a + '>' + b; if (seen.has(k)) return; seen.add(k); out.push({ from: a, to: b, sec, onSite, source: src }); };
  const wraps = Array.isArray(stationTransfer) ? stationTransfer : [stationTransfer];
  for (const w of wraps) for (const s of (w && w.StationTransfers) || []) {
    const op0 = w.AuthorityCode || null;
    for (const t of s.Transfers || []) for (const r of t.RailTransfers || []) {
      const a = uidOf(s.StationID, op0), b = uidOf(r.StationID, r.OperatorCode), min = num(r.MinTransferTime);
      push(a, b, Number.isFinite(min) ? min * 60 : null, r.IsOnSiteTransfer == null ? null : Number(r.IsOnSiteTransfer) === 1, 'TDX Rail/Metro/StationTransfer'); push(b, a, Number.isFinite(min) ? min * 60 : null, r.IsOnSiteTransfer == null ? null : Number(r.IsOnSiteTransfer) === 1, 'TDX Rail/Metro/StationTransfer');
    }
  }
  for (const g of transferStations || []) {
    const ids = (g.Stations || []).map(s => uidOf(s.StationID, null)).filter(Boolean);
    for (const a of ids) for (const b of ids) push(a, b, null, true, 'TDX Rail/Metro/TransferStations（共站，沒有轉乘時間）');
  }
  return out;
}

// ---------- 票價 ----------
// TRA ODFare：Fares[{ TicketType（字串）, Price }]——票種名稱照原樣保留，不猜哪一種是「全票」，回傳最低～最高
// THSR ODFare：Fares[{ TicketType 1 單程, FareClass 1 成人, CabinClass 1 標準 / 3 自由, Price }]
export function railFares(list, operator) {
  const m = new Map();
  for (const r of list || []) {
    const a = r.OriginStationID, b = r.DestinationStationID; if (a == null || b == null) continue; const fs = r.Fares || [];
    let e;
    if (operator === 'THSR') { const pick = c => fs.find(f => Number(f.TicketType) === 1 && Number(f.FareClass) === 1 && Number(f.CabinClass) === c); const s = pick(1), f = pick(3); e = { standard: s ? num(s.Price) : null, nonReserved: f ? num(f.Price) : null, currency: 'TWD', source: 'TDX Rail/THSR/ODFare（成人單程）' }; }
    else { const ps = fs.map(f => ({ type: String(f.TicketType ?? ''), price: num(f.Price) })).filter(f => Number.isFinite(f.price)); if (!ps.length) continue; e = { min: Math.min(...ps.map(f => f.price)), max: Math.max(...ps.map(f => f.price)), types: ps, currency: 'TWD', source: `TDX Rail/${operator}/ODFare（票種依原始資料）` }; }
    m.set(`${a}>${b}`, e);
  }
  return m;
}

// ---------- 即時：台鐵誤點（LiveTrainDelay）----------
export function traDelays(list, now = Date.now(), maxAgeMs = 15 * 60e3) {
  const m = new Map(); let stale = 0;
  for (const r of list || []) { if (!r || r.TrainNo == null) continue; const t = parseStamp(r.UpdateTime || r.SrcUpdateTime); if (Number.isFinite(t) && now - t > maxAgeMs) { stale++; continue; } const d = num(r.DelayTime); if (!Number.isFinite(d)) continue; m.set(String(r.TrainNo), { delayMin: d, station: r.StationID ?? null, updatedAt: Number.isFinite(t) ? t : null, source: 'TDX Rail/TRA/LiveTrainDelay' }); }
  return { delays: m, stale };
}

// ---------- 軌道線型（GIS v3 Line／v2 Shape）----------
// 回傳 [{ op, lineId, name, lines: [[[lon,lat],…],…], source }]
export function railShapes(list, op, source) {
  const out = []; for (const r of list || []) { const g = parseWkt(r.Geometry || r.Shape); if (!g) continue; out.push({ op, lineId: r.LineID ?? null, name: zh(r.LineName) ?? r.LineName ?? null, lines: g, source }); }
  return out;
}
