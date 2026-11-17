// bus-provider.mjs — TDX 公車資料 → 正規化的「站牌／路線型態／班次」。純函式、無 I/O。
//
// 原則（對應需求）：
// ・路線型態（pattern）以「SubRouteUID（沒有才用 RouteUID）＋ Direction」為單位，絕不以顯示名稱當鍵，也絕不混合去回程
// ・站序只看 StopSequence
// ・班次時刻只取資料裡真的有的；缺的站留空（NaN），之後只有在有「站間行駛時間」資料時才推算，並標示 est（推估）
// ・看不懂／對不上的資料一律計數並寫進 warnings，不默默丟掉、也不補假資料
//
// 支援的 TDX 資料形狀（欄位以實際回應為準；tools/tdx-audit.mjs 會列出你的帳號實際拿到哪些欄位）：
//   StopOfRoute        [{RouteUID, RouteID, RouteName, SubRouteUID, SubRouteID, SubRouteName, Direction, Operators, Stops:[{StopUID, StopID, StopName, StopSequence, StopPosition, StationID, StationGroupID}]}]
//   Schedule/DailyTimeTable [{RouteUID, SubRouteUID, Direction, Timetables:[{TripID, ServiceDay, StopTimes:[{StopSequence, StopUID, ArrivalTime, DepartureTime}]}], Frequencys:[{StartTime, EndTime, MinHeadwayMins, MaxHeadwayMins, ServiceDay}]}]
//   DailyStopTimeTable [{RouteUID?, SubRouteUID?, Direction?, BusDate, Stops:[{StopUID, StopID, TimeTables:[{Sequence, ArrivalTime, DepartureTime}]}]}]
//   S2STravelTime      [{RouteUID, SubRouteUID, Direction, TravelTimes:[{FromStopID|FromStopUID, ToStopID|ToStopUID, RunTime}]}]
import { dayMask, parseDateOnly, parseHms, parseStamp, DAY_S } from './time.mjs';

const zh = o => (o && typeof o === 'object' ? (o.Zh_tw ?? o.zh_tw ?? o.En ?? null) : (typeof o === 'string' ? o : null));
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : NaN));
export const patternKey = (subRouteUID, routeUID, direction) => `${subRouteUID || routeUID}|${direction ?? '?'}`;

function counter() { const c = {}; return { add: (k, n = 1) => { c[k] = (c[k] || 0) + n; }, all: c }; }

// ---------- 1. 站序：StopOfRoute → stops + patterns ----------
export function normalizeStopOfRoute(rows, { source = 'TDX Bus/StopOfRoute', fetchedAt = null } = {}) {
  const stops = new Map(), patterns = [], byKey = new Map(), warnings = [], cnt = counter();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || !(r.SubRouteUID || r.RouteUID)) { cnt.add('路線缺少 RouteUID／SubRouteUID'); continue; }
    if (r.Direction === undefined || r.Direction === null) cnt.add('路線缺少 Direction');
    const raw = (r.Stops || []).filter(s => s && s.StopUID);
    if ((r.Stops || []).length !== raw.length) cnt.add('站牌缺少 StopUID', (r.Stops || []).length - raw.length);
    const withSeq = raw.filter(s => Number.isFinite(num(s.StopSequence)));
    if (withSeq.length !== raw.length) cnt.add('站牌缺少 StopSequence', raw.length - withSeq.length);
    withSeq.sort((a, b) => num(a.StopSequence) - num(b.StopSequence));
    const seqs = [], uids = [];
    for (const s of withSeq) {
      const q = num(s.StopSequence);
      if (seqs.length && q === seqs[seqs.length - 1]) { cnt.add('StopSequence 重複'); continue; }
      seqs.push(q); uids.push(s.StopUID);
      const lat = num(s.StopPosition?.PositionLat), lon = num(s.StopPosition?.PositionLon);
      if (!stops.has(s.StopUID)) stops.set(s.StopUID, { uid: s.StopUID, stopId: s.StopID ?? null, mode: 'bus', name: zh(s.StopName), lat: Number.isFinite(lat) ? lat : null, lon: Number.isFinite(lon) ? lon : null,
        stationId: s.StationID ?? null, stationGroup: s.StationGroupID ?? null, operator: null, source });
      else if (Number.isFinite(lat) && stops.get(s.StopUID).lat === null) Object.assign(stops.get(s.StopUID), { lat, lon });
    }
    if (uids.length < 2) { cnt.add('路線型態少於 2 站'); continue; }
    let key = patternKey(r.SubRouteUID, r.RouteUID, r.Direction);
    if (byKey.has(key)) {                                                 // 同一個 SubRouteUID＋Direction 出現第二份站序
      const old = byKey.get(key);
      if (old.stops.join() === uids.join()) { cnt.add('重複的路線型態（內容相同，略過）'); continue; }
      let k = 2; while (byKey.has(`${key}#${k}`)) k++; key = `${key}#${k}`; cnt.add('同 SubRouteUID＋Direction 有不同站序（另存為獨立型態）');
    }
    const p = { id: key, mode: 'bus', routeUID: r.RouteUID ?? null, routeId: r.RouteID ?? null, subRouteUID: r.SubRouteUID ?? null, subRouteId: r.SubRouteID ?? null,
      direction: r.Direction ?? null, name: zh(r.RouteName), subName: zh(r.SubRouteName), headsign: null,
      operator: (r.Operators || []).map(o => o.OperatorID ?? o.OperatorCode ?? zh(o.OperatorName)).filter(Boolean)[0] ?? r.OperatorID ?? null, city: r.City ?? null,
      stops: uids, seqs, trips: [], freqs: [], runTimes: null, runSource: null, source, updatedAt: Number.isFinite(parseStamp(r.UpdateTime)) ? parseStamp(r.UpdateTime) : fetchedAt };
    patterns.push(p); byKey.set(key, p);
  }
  for (const [k, n] of Object.entries(cnt.all)) warnings.push(`StopOfRoute：${k} ×${n}`);
  return { stops: [...stops.values()], patterns, warnings };
}

// ---------- 2. 班次 ----------
// 找出這筆時刻資料屬於哪一個路線型態；Direction 有給就必須一致，沒給才用站序判斷（上車站必須在下車站之前）
function findPatterns(index, r) {
  const d = r.Direction, base = r.SubRouteUID || r.RouteUID; if (!base) return [];
  if (d !== undefined && d !== null) return index.byKey.get(`${base}|${d}`) || (r.SubRouteUID ? [] : (index.byRoute.get(`${r.RouteUID}|${d}`) || []));
  return [...(index.bySub.get(base) || index.byRouteAny.get(base) || [])];
}
export function indexPatterns(patterns) {
  const ix = { byKey: new Map(), byRoute: new Map(), bySub: new Map(), byRouteAny: new Map() }, push = (m, k, p) => { if (!k) return; const a = m.get(k); if (a) a.push(p); else m.set(k, [p]); };
  for (const p of patterns) {
    push(ix.byKey, p.id.replace(/#\d+$/, ''), p);
    if (p.routeUID) { push(ix.byRoute, `${p.routeUID}|${p.direction ?? '?'}`, p); push(ix.byRouteAny, p.routeUID, p); }
    if (p.subRouteUID) push(ix.bySub, p.subRouteUID, p);
  }
  return ix;
}
// 一個班次在某型態上的時刻：依 StopSequence（優先）或 StopUID 對到站序位置；回傳 null 表示對不上
function alignTrip(p, stopTimes) {
  const n = p.stops.length, arr = new Array(n).fill(NaN), dep = new Array(n).fill(NaN), seqPos = new Map(p.seqs.map((q, i) => [q, i]));
  let hit = 0, cursor = 0;
  for (const st of stopTimes) {
    let i = -1; const q = num(st.StopSequence);
    if (Number.isFinite(q) && seqPos.has(q) && (!st.StopUID || p.stops[seqPos.get(q)] === st.StopUID)) i = seqPos.get(q);
    else if (st.StopUID) { i = p.stops.indexOf(st.StopUID, cursor); }                                    // 環狀線同一站出現兩次：從上一個位置之後找
    if (i < 0) continue;
    const a = parseHms(st.ArrivalTime), d = parseHms(st.DepartureTime);
    if (!Number.isFinite(a) && !Number.isFinite(d)) continue;
    arr[i] = Number.isFinite(a) ? a : d; dep[i] = Number.isFinite(d) ? d : a; hit++; cursor = i + 1;
  }
  if (!hit) return null;
  let last = -Infinity, shift = 0;                                                                         // 時間必須沿站序不遞減；過午夜（突然少了半天以上）→ 加 24 小時
  for (let i = 0; i < n; i++) for (const A of [arr, dep]) {
    if (!Number.isFinite(A[i])) continue;
    let v = A[i] + shift; if (v < last - DAY_S / 2) { shift += DAY_S; v += DAY_S; }
    if (v < last) return { bad: true };
    A[i] = v; last = v;
  }
  return { arr, dep, known: hit };
}
// Schedule／DailyTimeTable（Timetables[].StopTimes）與 DailyStopTimeTable（Stops[].TimeTables）→ 掛到 patterns 上
// kind：'schedule'（依星期幾的固定班表）或 'daily'（指定日期的當日班表）。兩者分開標示，不互相覆蓋。
export function attachTimetables(patterns, rows, { kind = 'schedule', source = null, fetchedAt = null, index = indexPatterns(patterns) } = {}) {
  const cnt = counter(), src = source || (kind === 'daily' ? 'TDX Bus/DailyTimeTable' : 'TDX Bus/Schedule'); let trips = 0, freqs = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const cands = findPatterns(index, r);
    if (!cands.length) { cnt.add('時刻資料找不到對應的路線型態（RouteUID／SubRouteUID／Direction 對不上）'); continue; }
    const date = kind === 'daily' ? parseDateOnly(r.BusDate ?? r.ServiceDate ?? r.Date) : null;
    if (kind === 'daily' && !date) cnt.add('當日班表缺少日期（BusDate）');
    const upd = Number.isFinite(parseStamp(r.UpdateTime)) ? parseStamp(r.UpdateTime) : fetchedAt;
    const put = (stopTimes, id, mask) => {
      let best = null, bestP = null, bad = false;
      for (const p of cands) { const a = alignTrip(p, stopTimes); if (a?.bad) { bad = true; continue; } if (a && (!best || a.known > best.known)) { best = a; bestP = p; } }
      if (!best) { cnt.add(bad ? '班次時刻沿站序倒退（已略過）' : '班次的站牌對不上站序（已略過）'); return; }
      bestP.trips.push({ id: id ?? null, days: mask, date, arr: best.arr, dep: best.dep, partial: best.known < bestP.stops.length, est: false, kind, source: src, updatedAt: upd }); trips++;
    };
    for (const t of r.Timetables || []) put(t.StopTimes || [], t.TripID, dayMask(t.ServiceDay));
    if (Array.isArray(r.Stops) && r.Stops.some(s => Array.isArray(s.TimeTables))) {                         // DailyStopTimeTable：把各站同一個 Sequence 的時刻組成一班
      const bySeq = new Map();
      r.Stops.forEach((s, k) => { for (const x of s.TimeTables || []) { const a = bySeq.get(x.Sequence) || []; a.push({ StopUID: s.StopUID, StopSequence: s.StopSequence, ArrivalTime: x.ArrivalTime, DepartureTime: x.DepartureTime, _k: k }); bySeq.set(x.Sequence, a); } });
      for (const [sq, st] of bySeq) put(st.sort((a, b) => a._k - b._k), sq, null);
    }
    for (const f of r.Frequencys || r.Frequencies || []) {                                                  // 只有班距、沒有逐班時刻的路線
      const s = parseHms(f.StartTime), e = parseHms(f.EndTime), lo = num(f.MinHeadwayMins), hi = num(f.MaxHeadwayMins);
      if (!Number.isFinite(s) || !Number.isFinite(e) || !(lo > 0 || hi > 0)) { cnt.add('班距資料不完整（已略過）'); continue; }
      const p = cands[0]; p.freqs.push({ start: s, end: e <= s ? e + DAY_S : e, minS: (lo > 0 ? lo : hi) * 60, maxS: (hi > 0 ? hi : lo) * 60, days: dayMask(f.ServiceDay), date, kind, source: src, updatedAt: upd }); freqs++;
    }
  }
  return { trips, freqs, warnings: Object.entries(cnt.all).map(([k, n]) => `${src}：${k} ×${n}`) };
}

// ---------- 3. 站間行駛時間（S2STravelTime）----------
// 每個相鄰站間取資料中的中位數；完全沒有資料的站間維持 null（不用距離亂猜）
export function attachRunTimes(patterns, rows, stops, { source = 'TDX Bus/S2STravelTime', index = indexPatterns(patterns) } = {}) {
  const idToUid = new Map(); for (const s of stops) if (s.stopId != null) idToUid.set(String(s.stopId), s.uid);
  const cnt = counter(); let filled = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const cands = findPatterns(index, r); if (!cands.length) { cnt.add('找不到對應的路線型態'); continue; }
    const seg = new Map();
    for (const t of r.TravelTimes || []) {
      const run = num(t.RunTime); if (!(run > 0)) continue;
      const f = t.FromStopUID ?? idToUid.get(String(t.FromStopID)), to = t.ToStopUID ?? idToUid.get(String(t.ToStopID)); if (!f || !to) { cnt.add('站間資料的站牌代碼對不上'); continue; }
      const k = f + '>' + to, a = seg.get(k); if (a) a.push(run); else seg.set(k, [run]);
    }
    for (const p of cands) {
      const rt = p.runTimes || new Array(p.stops.length - 1).fill(null); let any = false;
      for (let i = 0; i < p.stops.length - 1; i++) { const a = seg.get(p.stops[i] + '>' + p.stops[i + 1]); if (a) { a.sort((x, y) => x - y); rt[i] = a[a.length >> 1]; any = true; } }
      if (any) { p.runTimes = rt; p.runSource = source; filled++; }
    }
  }
  return { patterns: filled, warnings: Object.entries(cnt.all).map(([k, n]) => `${source}：${k} ×${n}`) };
}

// 沒有 S2S 資料時，從「完整的班次」學站間行駛時間（各站間取中位數）——來源仍是時刻表本身，不是憑空估計
export function learnRunTimes(patterns) {
  let learned = 0;
  for (const p of patterns) {
    const n = p.stops.length, rt = p.runTimes ? [...p.runTimes] : new Array(n - 1).fill(null); let changed = false;
    for (let i = 0; i < n - 1; i++) {
      if (rt[i] != null) continue;
      const v = []; for (const t of p.trips) if (!t.est && Number.isFinite(t.dep[i]) && Number.isFinite(t.arr[i + 1])) v.push(t.arr[i + 1] - t.dep[i]);
      if (v.length) { v.sort((a, b) => a - b); rt[i] = v[v.length >> 1]; changed = true; }
    }
    if (changed) { p.runTimes = rt; p.runSource = p.runSource ? p.runSource + '＋時刻表中位數' : '時刻表中位數'; learned++; }
  }
  return learned;
}

// 只有部分站有時刻的班次（常見：只給起站發車時間）：有站間行駛時間才往後推算，並標示 est=true（推估）。沒有就維持空白。
export function fillPartialTrips(patterns) {
  let filled = 0, left = 0;
  for (const p of patterns) for (const t of p.trips) {
    if (!t.partial) continue;
    const n = p.stops.length; let changed = false;
    for (let i = 0; i < n - 1; i++) {
      if (!Number.isFinite(t.dep[i]) || Number.isFinite(t.arr[i + 1])) continue;
      const run = p.runTimes?.[i]; if (run == null) break;
      t.arr[i + 1] = t.dep[i] + run; if (!Number.isFinite(t.dep[i + 1])) t.dep[i + 1] = t.arr[i + 1]; changed = true;
    }
    for (let i = 0; i < n; i++) if (Number.isFinite(t.arr[i]) && !Number.isFinite(t.dep[i])) t.dep[i] = t.arr[i];
    if (changed) { t.est = true; filled++; }
    t.partial = t.arr.some(x => !Number.isFinite(x)); if (t.partial) left++;
  }
  return { filled, stillPartial: left };
}

// 一次做完：raw = { stopOfRoute, schedule, daily, dailyStop, s2s }
export function buildBus(raw, meta = {}) {
  const base = normalizeStopOfRoute(raw.stopOfRoute || [], { fetchedAt: meta.fetchedAt }), index = indexPatterns(base.patterns), warnings = [...base.warnings], stats = {};
  for (const [key, kind, source] of [['schedule', 'schedule', 'TDX Bus/Schedule'], ['daily', 'daily', 'TDX Bus/DailyTimeTable'], ['dailyStop', 'daily', 'TDX Bus/DailyStopTimeTable']]) {
    if (!raw[key]) continue;
    const r = attachTimetables(base.patterns, raw[key], { kind, source, fetchedAt: meta.fetchedAt, index }); warnings.push(...r.warnings); stats[key] = { trips: r.trips, freqs: r.freqs };
  }
  if (raw.s2s) { const r = attachRunTimes(base.patterns, raw.s2s, base.stops, { index }); warnings.push(...r.warnings); stats.s2s = r.patterns; }
  stats.learnedRunTimes = learnRunTimes(base.patterns);
  Object.assign(stats, fillPartialTrips(base.patterns));
  const noService = base.patterns.filter(p => !p.trips.length && !p.freqs.length).length;
  if (noService) warnings.push(`有 ${noService} 個路線型態沒有任何班次或班距資料（標示為「時刻資訊不足」，不代表停駛）`);
  stats.stops = base.stops.length; stats.patterns = base.patterns.length; stats.trips = base.patterns.reduce((a, p) => a + p.trips.length, 0); stats.noService = noService;
  return { stops: base.stops, patterns: base.patterns, warnings, stats };
}
