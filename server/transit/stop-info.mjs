// stop-info.mjs — 站牌與路線的「靜態」資訊（v1.19，在背景執行緒用 timetable-store 算；即時資料在主執行緒的 bus-realtime.mjs 合併）
// ・站牌附近：格網索引，只回傳畫面範圍內的公車站牌
// ・經過某站牌的路線：以路線型態（SubRouteUID＋Direction）為單位，絕不以路線名稱合併；同名不同方向、不同子路線各自一筆
// ・預定時刻：今天（台灣時間的營運日）的班表在這一站的下兩班、末班；班距型路線給班距；沒有資料就照實說「沒有時刻資料」
import { BUS_SOURCE_LABEL } from './snapshot.mjs';

const TPE = 8 * 3600e3, CELL = 0.01;                                       // 格網：約 1 公里
const index = new WeakMap();
function gridOf(store) {
  let g = index.get(store); if (g) return g;
  g = new Map();
  store.stops.forEach((s, i) => { if (s.mode !== 'bus' || s.lat == null || s.lon == null) return; const k = Math.floor(s.lon / CELL) + ',' + Math.floor(s.lat / CELL); const a = g.get(k); if (a) a.push(i); else g.set(k, [i]); });
  index.set(store, g); return g;
}
// 路線型態的資料來源：城市公車（City/{City}）、公路客運（InterCity）、台灣好行（Tourism TaiwanTrip）
export function sourceOf(p) {
  const id = String(p.id || '');
  if (id.endsWith('@InterCity')) return { kind: 'InterCity', city: null, label: BUS_SOURCE_LABEL.InterCity };
  if (id.endsWith('@TaiwanTrip')) return { kind: 'TaiwanTrip', city: null, label: BUS_SOURCE_LABEL.TaiwanTrip };
  return { kind: 'City', city: p.city || null, label: '市區公車' };
}
export function stopsInBBox(store, [w, s, e, n], { limit = 600 } = {}) {
  const g = gridOf(store), out = []; let more = false;
  for (let x = Math.floor(w / CELL); x <= Math.floor(e / CELL); x++) for (let y = Math.floor(s / CELL); y <= Math.floor(n / CELL); y++) {
    for (const i of g.get(x + ',' + y) || []) { const st = store.stops[i]; if (st.lon < w || st.lon > e || st.lat < s || st.lat > n) continue; if (out.length >= limit) { more = true; break; } out.push({ uid: st.uid, name: st.name, lat: st.lat, lon: st.lon, routes: store.stopPatterns[i].length }); }
  }
  return { stops: out, truncated: more };
}
// 台灣時間的營運日與「今天 0 點」的 UTC 毫秒
export function serviceDay(nowMs) { const d = new Date(nowMs + TPE).toISOString().slice(0, 10); return { date: d, startMs: Date.parse(d + 'T00:00:00Z') - TPE }; }

function scheduledAt(store, pi, pos, nowMs) {
  if (typeof store.day !== 'function') return { source: 'none' };
  const out = [];
  for (const back of [1, 0]) {                                                            // 昨天的營運日（跨午夜的班次）＋今天
    const { date, startMs } = serviceDay(nowMs - back * 86400e3), v = store.day(date), info = v.info[pi];
    if (!back) out.push({ info, date });
    for (const gi of v.groupsOf[pi]) {
      const g = v.groups[gi];
      for (let k = 0; k < g.n; k++) { const d = g.dep[k * g.S + pos] !== store.UNKNOWN ? g.dep[k * g.S + pos] : g.arr[k * g.S + pos]; if (d === store.UNKNOWN) continue; out.push({ ms: startMs + d * 1000, est: !!(g.flags[k] & 1), date }); }
    }
  }
  const today = out.find(x => x.info !== undefined), times = out.filter(x => x.ms != null).sort((a, b) => a.ms - b.ms);
  const { date } = serviceDay(nowMs), todays = times.filter(x => x.date === date);
  const r = { source: today ? today.info : 'none', next: times.filter(x => x.ms >= nowMs - 60e3).slice(0, 3).map(x => ({ ms: x.ms, est: x.est })) };
  if (todays.length) { const l = todays[todays.length - 1]; r.last = { ms: l.ms, est: l.est }; r.first = { ms: todays[0].ms, est: todays[0].est }; }
  if (r.source === 'frequency' && typeof store.freqAt === 'function') { const f = store.freqAt(pi, date, Math.round((nowMs - serviceDay(nowMs).startMs) / 1000)); if (f) r.freq = { minS: f.minS, maxS: f.maxS, dayUncertain: f.dayUncertain }; }
  return r;
}
const nameOf = (store, uid) => { const i = store.stopIndex.get(uid); return i == null ? null : store.stops[i].name; };

// 經過站牌 uid 的公車路線（每個路線型態一筆）
export function stopInfo(store, uid, nowMs = Date.now()) {
  const i = store.stopIndex.get(uid); if (i == null) return null;
  const st = store.stops[i], routes = [];
  for (const [pi, pos] of store.stopPatterns[i]) {
    const p = store.patterns[pi]; if (p.mode !== 'bus') continue;
    const src = sourceOf(p), last = p.stops.length - 1;
    routes.push({ pattern: p.id, routeUID: p.routeUID, subRouteUID: p.subRouteUID, direction: p.direction, name: p.name, subName: p.subName && p.subName !== p.name ? p.subName : null,
      busKind: p.busKind || null, operator: p.operator, source: src, destination: nameOf(store, p.stops[last]), origin: nameOf(store, p.stops[0]),
      pos, seq: p.seqs ? p.seqs[pos] : pos + 1, stops: p.stops.length, terminal: pos === last, scheduled: scheduledAt(store, pi, pos, nowMs) });
  }
  routes.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hant', { numeric: true }) || (a.direction ?? 9) - (b.direction ?? 9));
  return { stop: { uid: st.uid, name: st.name, lat: st.lat, lon: st.lon, mode: st.mode }, routes, version: store.version };
}
// 一個路線型態的站序（公車位置、下一站要用）
export function routeInfo(store, id) {
  const p = store.patterns.find(x => x.id === id && x.mode === 'bus'); if (!p) return null;
  return { pattern: p.id, routeUID: p.routeUID, subRouteUID: p.subRouteUID, direction: p.direction, name: p.name, subName: p.subName, busKind: p.busKind || null, operator: p.operator, source: sourceOf(p),
    stops: p.stops.map((u, k) => { const s = store.stops[store.stopIndex.get(u)]; return { uid: u, name: s.name, lat: s.lat, lon: s.lon, seq: p.seqs ? p.seqs[k] : k + 1 }; }),
    destination: nameOf(store, p.stops[p.stops.length - 1]), version: store.version };
}
