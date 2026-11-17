// metro-provider.mjs — TDX 捷運資料 → 正規化的「車站／路線型態／班距／首末班車／轉乘／出入口」。純函式、無 I/O。
//
// 每一種資料都是「有才用」：缺哪一種，就在 missing 與 warnings 裡明講，對應的結果會標示為推估或資訊不足，不會默默補假資料。
//   Station            車站與座標（必要）
//   StationOfRoute     營運路線的站序（優先；有分支／區間車的系統需要）
//   StationOfLine      路線的站序（沒有 StationOfRoute 時使用，去回程各建一個型態）
//   S2STravelTime      站間行駛時間 RunTime 與停站時間 StopTime（沒有 → 以距離推估並標示）
//   Frequency          各時段班距（沒有 → 候車時間「資訊不足」）
//   FirstLastTimetable 各站首末班車（沒有 → 無法判斷是否已收班，標示出來）
//   LineTransfer       站內跨線轉乘時間
//   StationExit        出入口座標
// 欄位名稱依 TDX Metro v2 文件；實際回應以 tools/tdx-audit.mjs 的稽核結果為準（例如 TDX 的 DestinationStaionID 拼字）。
import { dayMask, parseHms, parseStamp, DAY_S } from './time.mjs';

const zh = o => (o && typeof o === 'object' ? (o.Zh_tw ?? o.En ?? null) : (typeof o === 'string' ? o : null));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : NaN));
const hav = (a, b) => { const R = 6371000, r = d => d * Math.PI / 180, x = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
// 沒有 S2STravelTime 時的推估參數（結果一律標示「推估」）
export const METRO_EST = { mps: 9.7, curve: 1.15, dwellS: 30 };

export function buildMetro(raw, { operator = null, fetchedAt = null } = {}) {
  const warnings = [], missing = [], cnt = {}, add = k => { cnt[k] = (cnt[k] || 0) + 1; };
  const has = k => Array.isArray(raw[k]) && raw[k].length > 0;
  for (const [k, label] of [['station', 'Station（車站）'], ['s2s', 'S2STravelTime（站間行駛時間）'], ['frequency', 'Frequency（班距）'], ['firstLast', 'FirstLastTimetable（首末班車）'], ['lineTransfer', 'LineTransfer（站內轉乘）'], ['stationExit', 'StationExit（出入口）']]) if (!has(k)) missing.push(label);
  if (!has('stationOfRoute') && !has('stationOfLine')) missing.push('StationOfRoute／StationOfLine（站序）');

  // ---- 車站 ----
  const stops = [], byId = new Map(), byUid = new Map();
  for (const s of raw.station || []) {
    if (!s || !s.StationID) { add('車站缺少 StationID'); continue; }
    const op = operator || (s.StationUID && s.StationUID.includes('-') ? s.StationUID.slice(0, s.StationUID.indexOf('-')) : null), uid = s.StationUID || (op ? `${op}-${s.StationID}` : s.StationID);
    const lat = num(s.StationPosition?.PositionLat), lon = num(s.StationPosition?.PositionLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) add('車站缺少座標');
    const st = { uid, stopId: s.StationID, mode: 'metro', name: zh(s.StationName), lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null, stationId: s.StationID, stationGroup: null, operator: op, source: 'TDX Metro/Station' };
    if (byUid.has(uid)) { add('StationUID 重複'); continue; }
    stops.push(st); byUid.set(uid, st); byId.set(String(s.StationID), st);
  }
  const uidOf = id => byId.get(String(id))?.uid ?? null;

  // ---- 站間行駛時間 ----
  const run = new Map();                                                       // 'A>B' → { run, stop }
  for (const r of raw.s2s || []) for (const t of r.TravelTimes || []) {
    const a = uidOf(t.FromStationID), b = uidOf(t.ToStationID), rt = num(t.RunTime); if (!a || !b || !(rt > 0)) { add('站間行駛時間對不上車站或缺少 RunTime'); continue; }
    const st = num(t.StopTime); if (!run.has(a + '>' + b)) run.set(a + '>' + b, { run: rt, stop: Number.isFinite(st) && st >= 0 ? st : null });
  }

  // ---- 站序 → 路線型態（每個方向一個）----
  const patterns = [];
  const mk = (id, lineId, routeId, direction, name, uids, src) => {
    if (uids.length < 2) return;
    const runTimes = [], dwell = []; let est = 0, noCoord = false;
    for (let i = 0; i < uids.length - 1; i++) {
      const k = uids[i] + '>' + uids[i + 1], f = run.get(k) || run.get(uids[i + 1] + '>' + uids[i]);                   // 只有單向資料時，反向用同一站間的值
      if (f) { runTimes.push(f.run); dwell.push(f.stop); continue; }
      const A = byUid.get(uids[i]), B = byUid.get(uids[i + 1]);
      if (A?.lat == null || B?.lat == null) { runTimes.push(null); dwell.push(null); noCoord = true; continue; }
      runTimes.push(Math.round(hav(A, B) * METRO_EST.curve / METRO_EST.mps)); dwell.push(METRO_EST.dwellS); est++;
    }
    if (noCoord) add('有站間既無行駛時間也無座標（該段無法搭乘）');
    patterns.push({ id, mode: 'metro', routeUID: operator ? `${operator}-${lineId}` : String(lineId), routeId: routeId ?? null, subRouteUID: null, subRouteId: null, lineId, direction, name, subName: null,
      headsign: byUid.get(uids[uids.length - 1])?.name ?? null, operator, city: null, stops: uids, seqs: uids.map((_, i) => i + 1), trips: [], freqs: [], firstLast: uids.map(() => []),
      runTimes, dwell, runSource: est === 0 ? 'TDX Metro/S2STravelTime' : est === uids.length - 1 ? '推估（距離÷平均速度）' : '部分推估（缺少的站間以距離推估）', runEstimated: est,
      source: src, updatedAt: fetchedAt });
  };
  const lineName = new Map(); for (const l of raw.line || []) if (l?.LineID) lineName.set(String(l.LineID), zh(l.LineName));
  const ordered = (list) => (list || []).filter(s => s && s.StationID && Number.isFinite(num(s.Sequence))).sort((a, b) => num(a.Sequence) - num(b.Sequence)).map(s => uidOf(s.StationID)).filter((u, i, a) => u ? true : (add('站序裡的車站不在 Station 清單'), false));
  if (has('stationOfRoute')) for (const r of raw.stationOfRoute) {
    const uids = ordered(r.Stations), line = String(r.LineID ?? r.LineNo ?? ''), d = r.Direction ?? 0;
    mk(`${operator ?? ''}-${line}-${r.RouteID ?? 'R'}|${d}`, line, r.RouteID, d, lineName.get(line) || zh(r.RouteName) || line, uids, 'TDX Metro/StationOfRoute');
  }
  else for (const r of raw.stationOfLine || []) {
    const uids = ordered(r.Stations), line = String(r.LineID ?? r.LineNo ?? '');
    mk(`${operator ?? ''}-${line}|0`, line, null, 0, lineName.get(line) || line, uids, 'TDX Metro/StationOfLine');
    mk(`${operator ?? ''}-${line}|1`, line, null, 1, lineName.get(line) || line, [...uids].reverse(), 'TDX Metro/StationOfLine');
  }
  const byLine = new Map(); for (const p of patterns) { const a = byLine.get(p.lineId); if (a) a.push(p); else byLine.set(p.lineId, [p]); }

  // ---- 班距（依時段、依星期）----
  for (const f of raw.frequency || []) {
    const ps = (byLine.get(String(f.LineID ?? f.LineNo ?? '')) || []).filter(p => !f.RouteID || !p.routeId || p.routeId === f.RouteID); if (!ps.length) { add('班距資料找不到對應路線'); continue; }
    const days = dayMask(f.ServiceDay), upd = parseStamp(f.UpdateTime);
    for (const h of f.Headways || []) {
      const s = parseHms(h.StartTime), e = parseHms(h.EndTime), lo = num(h.MinHeadwayMins), hi = num(h.MaxHeadwayMins);
      if (!Number.isFinite(s) || !Number.isFinite(e) || !(lo > 0 || hi > 0)) { add('班距時段不完整（已略過）'); continue; }
      for (const p of ps) p.freqs.push({ start: s, end: e <= s ? e + DAY_S : e, minS: (lo > 0 ? lo : hi) * 60, maxS: (hi > 0 ? hi : lo) * 60, days, date: null, peak: h.PeakFlag ?? null, kind: 'frequency', source: 'TDX Metro/Frequency', updatedAt: Number.isFinite(upd) ? upd : fetchedAt });
    }
  }
  // ---- 首末班車：依「往哪個終點」判斷屬於哪個方向（終點站在這個型態中位於本站之後）----
  for (const f of raw.firstLast || []) {
    const u = uidOf(f.StationID), dest = uidOf(f.DestinationStaionID ?? f.DestinationStationID), first = parseHms(f.FirstTrainTime), last = parseHms(f.LastTrainTime);
    if (!u || (!Number.isFinite(first) && !Number.isFinite(last))) { add('首末班車資料不完整（已略過）'); continue; }
    let hit = false;
    for (const p of byLine.get(String(f.LineID ?? f.LineNo ?? '')) || []) {
      const i = p.stops.indexOf(u); if (i < 0 || i === p.stops.length - 1) continue;
      if (dest) { const j = p.stops.indexOf(dest); if (j <= i) continue; } else if (f.Direction != null && f.Direction !== p.direction) continue;
      p.firstLast[i].push({ first: Number.isFinite(first) ? first : null, last: Number.isFinite(last) ? (Number.isFinite(first) && last < first ? last + DAY_S : last) : null, days: dayMask(f.ServiceDay), dest: dest ?? null, source: 'TDX Metro/FirstLastTimetable' }); hit = true;
    }
    if (!hit) add('首末班車資料對不上任何方向');
  }
  // ---- 站內轉乘、出入口（交給 Transfer Engine 使用）----
  const transfers = [];
  for (const t of raw.lineTransfer || []) {
    const a = uidOf(t.FromStationID), b = uidOf(t.ToStationID), min = num(t.TransferTime); if (!a || !b) { add('轉乘資料對不上車站'); continue; }
    transfers.push({ from: a, to: b, fromLine: t.FromLineID ?? null, toLine: t.ToLineID ?? null, sec: Number.isFinite(min) ? min * 60 : null, onSite: t.IsOnSiteTransfer == null ? null : Number(t.IsOnSiteTransfer) === 1, source: 'TDX Metro/LineTransfer' });
  }
  const exits = [];
  for (const e of raw.stationExit || []) {
    const u = uidOf(e.StationID), lat = num(e.ExitPosition?.PositionLat), lon = num(e.ExitPosition?.PositionLon); if (!u || !Number.isFinite(lat) || !Number.isFinite(lon)) { add('出入口資料缺少車站或座標'); continue; }
    exits.push({ station: u, id: e.ExitID ?? null, name: zh(e.ExitName), lat, lon, elevator: e.Elevator ?? null, source: 'TDX Metro/StationExit' });
  }
  for (const [k, n] of Object.entries(cnt)) warnings.push(`Metro${operator ? '（' + operator + '）' : ''}：${k} ×${n}`);
  if (missing.length) warnings.push(`Metro${operator ? '（' + operator + '）' : ''} 缺少資料：${missing.join('、')}`);
  const estP = patterns.filter(p => p.runEstimated).length;
  return { stops, patterns, transfers, exits, warnings, missing, stats: { stops: stops.length, patterns: patterns.length, withFreq: patterns.filter(p => p.freqs.length).length, runEstimatedPatterns: estP, transfers: transfers.length, exits: exits.length } };
}
