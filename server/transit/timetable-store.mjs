// timetable-store.mjs — 統一的大眾運輸資料庫（公車＋捷運），給搜尋引擎用的唯讀結構。
//
// 對應「Multimodal Transit Graph」：
//   節點 = stops[]（公車站牌、捷運站各自獨立，絕不因名稱相同而合併；每個節點保留 uid／運具／座標／業者／名稱／來源）
//   搭乘邊 = patterns[]（一個路線型態 = 一條有方向、有站序的路線）＋ 每個營運日的班次表 day(date)
//   候車 = 由班次時刻或班距在搜尋時算出（不是固定值）
//   步行／轉乘邊 = 由 Transfer Engine（階段 2）另外建立
// 班次以 Int32Array 攤平、依發車時間預先排序，找「最早搭得上的一班」是二分搜尋。
import { createHash } from 'node:crypto';
import { DAY_S, runsOn } from './time.mjs';

const UNKNOWN = -1;

export function createStore({ bus = null, metros = [], builtAt = Date.now(), datasetHashes = {} } = {}) {
  const stops = [], stopIndex = new Map(), warnings = [], patterns = [];
  const addStops = list => { for (const s of list || []) { if (stopIndex.has(s.uid)) { warnings.push(`站點 UID 重複，保留第一筆：${s.uid}`); continue; } stopIndex.set(s.uid, stops.length); stops.push(s); } };
  if (bus) addStops(bus.stops); for (const m of metros) addStops(m.stops);
  const srcPatterns = [...(bus?.patterns || []), ...metros.flatMap(m => m.patterns)];
  const stopPatterns = stops.map(() => []);
  let dropped = 0;
  for (const p of srcPatterns) {
    const idx = p.stops.map(u => stopIndex.get(u)); if (idx.some(i => i === undefined)) { dropped++; continue; }
    const pi = patterns.length, n = idx.length;
    // 班距型路線用的累計時間：offArr[i]＝從起站發車到抵達第 i 站、offDep[i]＝到從第 i 站發車；任何一段沒有行駛時間 → 之後的站都是未知
    let offArr = null, offDep = null;
    if (p.runTimes) { offArr = new Float64Array(n).fill(NaN); offDep = new Float64Array(n).fill(NaN); offArr[0] = offDep[0] = 0;
      for (let i = 1; i < n; i++) { const r = p.runTimes[i - 1]; if (r == null || Number.isNaN(offDep[i - 1])) break; offArr[i] = offDep[i - 1] + r; offDep[i] = offArr[i] + (p.dwell?.[i] ?? p.dwell?.[i - 1] ?? 0); } }
    patterns.push({ ...p, index: pi, stopIdx: Int32Array.from(idx), offArr, offDep });
    idx.forEach((s, pos) => stopPatterns[s].push([pi, pos]));
  }
  if (dropped) warnings.push(`有 ${dropped} 個路線型態含有不存在的站點，已排除`);
  const version = createHash('sha1').update(JSON.stringify([datasetHashes, stops.length, patterns.map(p => [p.id, p.stops.length, p.trips.length, p.freqs.length])])).digest('hex').slice(0, 12);

  // ---- 某個營運日的班次表 ----
  const dayCache = new Map();
  function day(dateStr) {
    let v = dayCache.get(dateStr); if (v) { dayCache.delete(dateStr); dayCache.set(dateStr, v); return v; }
    const groups = [], groupsOf = patterns.map(() => []), info = patterns.map(() => 'none'); let nTrips = 0, uncertain = 0;
    patterns.forEach((p, pi) => {
      if (!p.trips.length) { info[pi] = p.freqs.length ? 'frequency' : 'none'; return; }
      // 當日班表（daily）有今天的資料就只用它；沒有才用固定班表（schedule）依星期幾判斷。兩者都沒有 → 'none'（資訊不足，不是停駛）
      const daily = p.trips.filter(t => t.kind === 'daily' && t.date === dateStr);
      let use = daily, src = 'daily';
      if (!use.length) { src = 'schedule'; use = p.trips.filter(t => t.kind === 'schedule' && runsOn(t.days, dateStr) !== false); }
      if (!use.length) { info[pi] = p.trips.some(t => t.kind === 'schedule' && t.days != null) ? 'not-today' : (p.freqs.length ? 'frequency' : 'none'); return; }
      info[pi] = src;
      const S = p.stops.length, first = t => { for (let i = 0; i < S; i++) if (Number.isFinite(t.dep[i])) return t.dep[i]; return Infinity; };
      const sorted = [...use].sort((a, b) => first(a) - first(b)), open = [];                                // open：尚可接續的群組
      for (const t of sorted) {
        const mask = t.dep.map(x => (Number.isFinite(x) ? '1' : '0')).join('');
        let g = open.find(o => o.mask === mask && o.last.every((x, i) => !Number.isFinite(t.dep[i]) || (t.dep[i] >= x.dep && t.arr[i] >= x.arr)));   // 同一群組內不可超車（RAPTOR 的前提）
        if (!g) { g = { mask, trips: [], last: [] }; open.push(g); }
        g.trips.push(t); g.last = t.dep.map((d, i) => ({ dep: Number.isFinite(d) ? d : -Infinity, arr: Number.isFinite(t.arr[i]) ? t.arr[i] : -Infinity }));
      }
      for (const g of open) {
        const n = g.trips.length, dep = new Int32Array(n * S), arr = new Int32Array(n * S), flags = new Uint8Array(n);
        g.trips.forEach((t, k) => { for (let i = 0; i < S; i++) { dep[k * S + i] = Number.isFinite(t.dep[i]) ? Math.round(t.dep[i]) : UNKNOWN; arr[k * S + i] = Number.isFinite(t.arr[i]) ? Math.round(t.arr[i]) : UNKNOWN; }
          flags[k] = (t.est ? 1 : 0) | (t.days == null && t.kind === 'schedule' ? 2 : 0); if (flags[k] & 2) uncertain++; });
        groupsOf[pi].push(groups.length); groups.push({ p: pi, S, n, dep, arr, flags, ids: g.trips.map(t => t.id), src }); nTrips += n;
      }
    });
    v = { date: dateStr, groups, groupsOf, info, trips: nTrips, uncertainDayTrips: uncertain };
    dayCache.set(dateStr, v); if (dayCache.size > 4) dayCache.delete(dayCache.keys().next().value);
    return v;
  }
  // 群組 g 在站序位置 pos、時間 tSec（營運日秒數）之後最早發車的班次編號；沒有回傳 -1。二分搜尋。
  function earliest(g, pos, tSec) {
    if (!g.n || g.dep[pos] === UNKNOWN) return -1;
    let lo = 0, hi = g.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (g.dep[m * g.S + pos] >= tSec) hi = m; else lo = m + 1; }
    return lo < g.n ? lo : -1;
  }
  // 群組 g 在站序位置 pos、時間 tSec 之前最晚抵達的班次（給「指定抵達時間」的反向搜尋）
  function latest(g, pos, tSec) {
    if (!g.n || g.arr[pos] === UNKNOWN) return -1;
    let lo = 0, hi = g.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (g.arr[m * g.S + pos] <= tSec) lo = m + 1; else hi = m; }
    return lo - 1;
  }
  // 班距型路線在 tSec 的班距；回傳 null＝這個時段沒有班距資料（資訊不足）。dayUncertain＝資料沒說適用星期幾。
  function freqAt(pi, dateStr, tSec) {
    let best = null;
    for (const f of patterns[pi].freqs) {
      if (f.date && f.date !== dateStr) continue;
      const on = runsOn(f.days, dateStr); if (on === false) continue;
      for (const t of [tSec, tSec + DAY_S]) if (t >= f.start && t < f.end && (!best || (best.dayUncertain && on === true))) best = { minS: f.minS, maxS: f.maxS, start: f.start, end: f.end, source: f.source, dayUncertain: on === null, updatedAt: f.updatedAt };
    }
    return best;
  }
  // 捷運在某站某時刻是否在營運時間內：'open'／'closed'／'unknown'（沒有首末班車資料）
  function serviceState(pi, pos, dateStr, tSec) {
    const fl = patterns[pi].firstLast?.[pos]; if (!fl || !fl.length) return { state: 'unknown' };
    const use = fl.filter(x => runsOn(x.days, dateStr) !== false); if (!use.length) return { state: 'unknown' };
    for (const x of use) if ((x.first == null || tSec >= x.first) && (x.last == null || tSec <= x.last)) return { state: 'open', first: x.first, last: x.last, source: x.source };
    const x = use[0]; return { state: 'closed', first: x.first, last: x.last, source: x.source, before: x.first != null && tSec < x.first };
  }
  const stats = { stops: stops.length, busStops: stops.filter(s => s.mode === 'bus').length, metroStations: stops.filter(s => s.mode === 'metro').length, patterns: patterns.length,
    busPatterns: patterns.filter(p => p.mode === 'bus').length, metroPatterns: patterns.filter(p => p.mode === 'metro').length,
    trips: patterns.reduce((a, p) => a + p.trips.length, 0), estimatedTrips: patterns.reduce((a, p) => a + p.trips.filter(t => t.est).length, 0),
    noServiceInfo: patterns.filter(p => !p.trips.length && !p.freqs.length).length };
  return { version, builtAt, stops, stopIndex, patterns, stopPatterns, warnings: [...(bus?.warnings || []), ...metros.flatMap(m => m.warnings), ...warnings],
    transfers: metros.flatMap(m => m.transfers || []), exits: metros.flatMap(m => m.exits || []), stats, day, earliest, latest, freqAt, serviceState, UNKNOWN };
}
