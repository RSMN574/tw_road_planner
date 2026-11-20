// timetable.js
import { State } from './state.js';
import { KIND_TT, METRO_ACCESS_S, METRO_HEADWAY_S, TT_BUF_MS, WALK_MAX_M, WALK_MPS } from './constants.js';
import { hhmm, todayStr } from './util.js';
import { worldDistM } from './geo.js';
import { busNearIdx, nearbyStops } from './bus-core.js';
import { suggestBus } from './bus-plan.js';
import { describeTdxError, tdxCached } from './tdx.js';

export const getDepMs = () => { const dv = document.getElementById('depTime').value, now = State.tdxNow(); return dv ? Date.parse(`${todayStr(now)}T${dv}:00+08:00`) : now; };

export async function buildNet(fx, fy, tx, ty, force) {
  const b = State.bus;
  if (!b._k2s) { b._k2s = new Map(); b.uids.forEach((u, i) => { for (const k of [u, b.stopIds[i], b.stopIds[i] ? 'TXG' + b.stopIds[i] : '']) if (k) { const a = b._k2s.get(k); if (a) a.push(i); else b._k2s.set(k, [i]); } }); }
  const col = new Set(); suggestBus(fx, fy, tx, ty, col);                                       // 方案相關路線 + 起終點附近站牌的路線（上限 18 條，避免 API 暴增）
  const routesAt = i => { const r = []; for (let e = b.off[i]; e < b.off[i+1]; e++) if (b.eRoute[e] >= 0 && b.routeKind[b.eRoute[e]] !== 'metro') r.push(b.eRoute[e]); return r; };   // 公車路線向 TDX 取時刻表；捷運另外以班距加入（見 metroPatterns）
  for (const s of [...nearbyStops(fx, fy, 6, WALK_MAX_M, 'any'), ...nearbyStops(tx, ty, 6, WALK_MAX_M, 'any')]) for (const r of routesAt(s.i)) col.add(r);
  if (!b._rs) { b._rs = new Map(); for (let k = 0; k < b.eTo.length; k++) { const r = b.eRoute[k]; if (r < 0) continue; let a = b._rs.get(r); if (!a) b._rs.set(r, a = new Set()); a.add(b.eFrom[k]); a.add(b.eTo[k]); } }
  for (const r of [...col]) for (const st of [...(b._rs.get(r) || [])].slice(0, 80)) {            // 走路換乘（150 m 內）：把「換乘站附近」的路線也納入
    if (col.size >= 18) break; for (const j of busNearIdx(b.x[st], b.y[st], 150)) for (const r2 of routesAt(j)) if (col.size < 18) col.add(r2);
  }
  const labels = [...col].filter(r => b.routeKind[r] !== 'metro').slice(0, 18).map(r => b.routeLabels[r]), recs = await Promise.all(labels.map(l => tdxCached(KIND_TT, l, force)));
  const pats = [], at = new Map(), errors = [...new Set(recs.filter(r => r.error).map(r => describeTdxError(r.error)))];
  recs.forEach((rec, li) => {
    for (const p of rec.data || []) {
      const st = (p.Stops || []).map(s => { const m = b._k2s.get(s.StopUID) || b._k2s.get(s.StopID); return m ? { idx: m[0], tt: s.TimeTables || [] } : null; }).filter(Boolean);   // 對不到的站牌略過
      if (st.length < 2) continue;
      const seqs = [...new Set(st.flatMap(s => s.tt.map(x => x.Sequence)))].sort((x, y) => x - y), trips = [];
      for (const sq of seqs) {
        const dep = new Float64Array(st.length).fill(NaN), arr = new Float64Array(st.length).fill(NaN);
        st.forEach((s, i) => { const x = s.tt.find(y => y.Sequence === sq); if (x) { arr[i] = hhmm(p.BusDate, x.ArrivalTime || x.DepartureTime); dep[i] = hhmm(p.BusDate, x.DepartureTime || x.ArrivalTime); } });
        if (dep.filter(isFinite).length >= 2) trips.push({ dep, arr, seq: sq });
      }
      if (!trips.length) continue;
      const f0 = tr => tr.dep.find(isFinite); trips.sort((x, y) => f0(x) - f0(y));
      const pi = pats.length; pats.push({ label: labels[li], dest: p.DestinationStopName?.Zh_tw || '', stops: st.map(s => s.idx), trips });
      st.forEach((s, i) => { const a = at.get(s.idx); if (a) a.push([pi, i]); else at.set(s.idx, [[pi, i]]); });
    }
  });
  const metro = metroPatterns(pats, at, labels);
  const fc = new Map(), isM = i => b.stopKind[i] === 'metro';
  const foot = s => {
    let a = fc.get(s); if (a) return a; a = []; const seen = new Set([s]);
    // 公車 ↔ 公車：維持原本規則。牽涉捷運站的步行一律用轉乘連結（道路步行距離＋進出站／換月台），不用直線距離
    if (!isM(s)) for (const j of busNearIdx(b.x[s], b.y[s], 200)) if (!seen.has(j) && !isM(j) && at.has(j)) { seen.add(j); a.push({ to: j, sec: Math.max(30, worldDistM(b.x[s], b.y[s], b.x[j], b.y[j]) / WALK_MPS) }); }
    if (b.group[s] >= 0) for (const j of b.members[b.group[s]]) if (!seen.has(j) && at.has(j)) { seen.add(j); a.push({ to: j, sec: 60 }); }
    for (const l of (b.xfer && b.xfer.get(s)) || []) if (!seen.has(l.to) && at.has(l.to)) { seen.add(l.to); a.push({ to: l.to, sec: l.sec, m: l.m, src: l.src }); }
    fc.set(s, a); return a;
  };
  return { pats, at, foot, labels, errors, metro };
}

// ---------- 捷運：以「班距」加入時刻表搜尋 ----------
// 每條捷運線、每個方向一個型態。沒有逐班時刻：RAPTOR 在上車站以「現在＋平均候車（班距的一半）」上車；CSA 以班距產生等間隔的推估班次。
// 班距：metro.json 有 TDX Frequency 就依時段與星期取；否則用 METRO_HEADWAY_S（系統推估）。
// 首末班：有 TDX FirstLastTimetable 才判斷，超出營運時間不能上車；沒有資料就標示「營運時間未知」，不自行假設。
const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const tpeParts = ms => { const d = new Date(ms + 8 * 3600e3); return { wd: d.getUTCDay(), sec: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds(), day0: ms - (d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()) * 1000 - d.getUTCMilliseconds() }; };
const hms = t => { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? +m[1] * 3600 + +m[2] * 60 : NaN; };
function metroPatterns(pats, at, labels) {
  const b = State.bus, mj = State.metroJson; if (!mj || !mj.lines) return { n: 0 };
  const idx = new Map(b.uids.map((u, i) => [u, i])), meta = mj.meta || {}, out = { n: 0, freqSrc: meta.frequency ? 'TDX Frequency' : '系統推估（固定班距）', hoursKnown: !!meta.firstLast };
  for (const ln of mj.lines) {
    const st = (ln.uids || []).map(u => idx.get(u)).filter(i => i !== undefined); if (st.length < 2) continue;
    for (const dir of [st, [...st].reverse()]) {
      const offArr = [0], offDep = [0];                             // 從本方向第一站發車起算：到達／離開第 i 站的秒數（含停站）
      for (let i = 1; i < dir.length; i++) { let rt = NaN; for (let e = b.off[dir[i-1]]; e < b.off[dir[i-1]+1]; e++) if (b.eTo[e] === dir[i] && b.routeKind[b.eRoute[e]] === 'metro') { rt = b.eTime[e]; break; } if (!isFinite(rt)) break; offArr.push(offDep[i-1] + rt); offDep.push(offArr[i]); }
      if (offArr.length < 2) continue;
      const stops = dir.slice(0, offArr.length), uidsDir = stops.map(i => b.uids[i]), pi = pats.length;
      pats.push({ label: ln.line, dest: b.names[stops[stops.length - 1]], stops, trips: [], metro: true, lineId: ln.id, freq: { offArr, offDep, line: ln.id, uids: uidsDir } });
      stops.forEach((s, i) => { const a = at.get(s); if (a) a.push([pi, i]); else at.set(s, [[pi, i]]); });
      out.n++;
    }
    if (!labels.includes(ln.line)) labels.push(ln.line);
  }
  return out;
}
// 這條線在 tMs 的班距（秒）與來源
export function metroHeadway(line, tMs) {
  const F = State.metroJson && State.metroJson.meta && State.metroJson.meta.frequency, { wd, sec } = tpeParts(tMs);
  if (Array.isArray(F)) for (const f of F) {
    if (String(f.LineID ?? f.LineNo ?? '') !== String(line)) continue;
    if (f.ServiceDay && f.ServiceDay[WEEK[wd]] !== undefined && !(+f.ServiceDay[WEEK[wd]] === 1 || f.ServiceDay[WEEK[wd]] === true)) continue;
    for (const h of f.Headways || []) { let s0 = hms(h.StartTime), s1 = hms(h.EndTime); if (s1 <= s0) s1 += 86400; const lo = +h.MinHeadwayMins, hi = +h.MaxHeadwayMins;
      if (isFinite(s0) && isFinite(s1) && (sec >= s0 && sec < s1 || sec + 86400 >= s0 && sec + 86400 < s1) && (lo > 0 || hi > 0)) return { sec: ((lo > 0 ? lo : hi) + (hi > 0 ? hi : lo)) / 2 * 60, src: 'TDX Frequency' }; }
  }
  return { sec: METRO_HEADWAY_S, src: Array.isArray(F) ? '系統推估（TDX 班距沒有涵蓋此時段）' : '系統推估（固定班距）' };
}
// 某站往這個方向在 tMs 的營運狀態：{ state: 'open' | 'closed' | 'unknown', firstMs }。closed 且還沒到首班 → firstMs＝當天首班時刻（可以等）
export function metroStatus(P, i, tMs) {
  const FL = State.metroJson && State.metroJson.meta && State.metroJson.meta.firstLast; if (!Array.isArray(FL)) return { state: 'unknown' };
  const idOf = u => (u.includes('-') ? u.slice(u.indexOf('-') + 1) : u), id = idOf(P.freq.uids[i]), ahead = new Set(P.freq.uids.slice(i + 1).map(idOf)), { sec, day0 } = tpeParts(tMs);
  // 只看「往這個方向」的首末班：終點站（TDX 欄位拼字為 DestinationStaionID）必須在本站之後
  const rows = FL.filter(f => String(f.StationID) === id && ahead.has(String(f.DestinationStaionID ?? f.DestinationStationID)));
  if (!rows.length) return { state: 'unknown' };
  let first = Infinity;
  for (const f of rows) { const a = hms(f.FirstTrainTime); let z = hms(f.LastTrainTime); if (z < a) z += 86400;
    if ((sec >= a && sec <= z) || (sec + 86400 >= a && sec + 86400 <= z)) return { state: 'open' };
    if (sec < a) first = Math.min(first, a); }
  return { state: 'closed', firstMs: isFinite(first) ? day0 + first * 1000 : null };
}
export const metroOpen = (P, i, tMs) => { const s = metroStatus(P, i, tMs).state; return s === 'unknown' ? null : s === 'open'; };
// RAPTOR 在 i 站、ready 之後上捷運：回傳一個「推估班次」（各站時刻＝上車時刻＋累計行駛時間）。還沒到首班就等首班；末班之後不能上車
function metroBoard(P, i, ready) {
  const st = metroStatus(P, i, ready); let dep, h = metroHeadway(P.freq.line, ready), wait;
  if (st.state === 'closed') { if (!st.firstMs) return null; dep = st.firstMs; wait = (dep - ready) / 1000; }
  else { dep = ready + h.sec / 2 * 1000; wait = h.sec / 2; }
  const base = dep - P.freq.offDep[i] * 1000, n = P.stops.length, D = new Float64Array(n), A = new Float64Array(n);
  for (let j = 0; j < n; j++) { D[j] = base + P.freq.offDep[j] * 1000; A[j] = base + P.freq.offArr[j] * 1000; }
  return { dep: D, arr: A, est: true, waitS: wait, src: st.state === 'closed' ? '等首班車（TDX FirstLastTimetable）' : h.src, hoursKnown: st.state !== 'unknown' };
}

export function raptor(net, orig, targ, maxK = 4) {
  const INF = Infinity, best = new Map(), R = [new Map()]; let marked = new Set();
  const footRelax = (cur, set) => { for (const s of [...set]) { const l = cur.get(s); if (!l || l.kind === 'foot') continue; for (const f of net.foot(s)) { const t = l.t + f.sec * 1000; if (t < (best.get(f.to) ?? INF)) { best.set(f.to, t); cur.set(f.to, { t, kind: 'foot', from: s, prev: l }); set.add(f.to); } } } };
  for (const o of orig) { R[0].set(o.stop, { t: o.t, kind: 'start' }); best.set(o.stop, o.t); marked.add(o.stop); }
  footRelax(R[0], marked);
  for (let k = 1; k <= maxK; k++) {
    const cur = new Map(R[k-1]), Q = new Map(), nm = new Set(); R.push(cur);
    for (const s of marked) for (const [pi, idx] of net.at.get(s) || []) if (!Q.has(pi) || Q.get(pi) > idx) Q.set(pi, idx);
    for (const [pi, i0] of Q) {
      const P = net.pats[pi]; let trip = null, bi = -1;
      for (let i = i0; i < P.stops.length; i++) {
        const s = P.stops[i];
        if (trip && isFinite(trip.arr[i]) && trip.arr[i] < (best.get(s) ?? INF)) { best.set(s, trip.arr[i]); cur.set(s, { t: trip.arr[i], kind: 'ride', pi, trip, bi, ai: i, prev: R[k-1].get(P.stops[bi]) }); nm.add(s); }
        const pl = R[k-1].get(s);
        if (pl) { const ready = pl.t + (pl.kind === 'ride' ? TT_BUF_MS : 0), t2 = P.freq ? (i < P.stops.length - 1 ? metroBoard(P, i, ready) : null) : P.trips.find(x => isFinite(x.dep[i]) && x.dep[i] >= ready); if (t2 && (!trip || t2.dep[i] < trip.dep[i])) { trip = t2; bi = i; } }
      }
    }
    footRelax(cur, nm); marked = nm; if (!marked.size) break;
  }
  const out = []; let bestArr = INF;
  for (let k = 1; k < R.length; k++) {                                       // 每個回合（轉乘次數）取最早抵達；只保留「更早」者 → Pareto
    let bt = INF, bl = null;
    for (const t of targ) { const l = R[k].get(t.stop); if (l && l.t + t.sec * 1000 < bt) { bt = l.t + t.sec * 1000; bl = l; } }
    if (bl && bt < bestArr) { bestArr = bt; out.push({ arriveMs: bt, legs: unwind(net, bl) }); }
  }
  return out;
}

export function unwind(net, l) {
  const legs = [];
  while (l && l.kind !== 'start') {
    if (l.kind === 'ride') { const P = net.pats[l.pi]; legs.push({ type: 'ride', label: P.label, dest: P.dest, board: P.stops[l.bi], alight: P.stops[l.ai], dep: l.trip.dep[l.bi], arr: l.trip.arr[l.ai], metro: !!P.metro, lineId: P.lineId || null, stops: l.ai - l.bi, est: !!l.trip.est, waitS: l.trip.waitS ?? null, src: l.trip.src || '預定時刻', hoursKnown: l.trip.hoursKnown ?? null }); }
    else legs.push({ type: 'foot', from: l.from });
    l = l.prev;
  }
  return legs.reverse();
}

// CSA 需要逐班連線：捷運以班距在搜尋時段內產生等間隔的推估班次（標示 est）；超出已知營運時間的不產生
function metroTrips(P, t0, spanMs = 4 * 3600e3) {
  const out = [], last = P.stops.length - 1;
  for (let t = t0 - P.freq.offDep[last] * 1000; t <= t0 + spanMs;) {
    const h = metroHeadway(P.freq.line, t), first = t + h.sec / 2 * 1000;
    if (metroOpen(P, 0, first) !== false) { const D = new Float64Array(P.stops.length), A = new Float64Array(P.stops.length); for (let j = 0; j <= last; j++) { D[j] = first + P.freq.offDep[j] * 1000; A[j] = first + P.freq.offArr[j] * 1000; } out.push({ dep: D, arr: A, est: true, waitS: h.sec / 2, src: h.src }); }
    t += h.sec * 1000;
  }
  return out;
}
export function csa(net, orig, targ) {
  const conns = [], t00 = Math.min(...orig.map(o => o.t));
  net.pats.forEach((P, pi) => (P.freq ? metroTrips(P, t00) : P.trips).forEach((T, ti) => { for (let i = 0; i < P.stops.length - 1; i++) if (isFinite(T.dep[i]) && isFinite(T.arr[i+1])) conns.push({ a: P.stops[i], b: P.stops[i+1], td: T.dep[i], ta: T.arr[i+1], id: pi + '.' + ti, pi, bi: i, ai: i + 1, trip: T }); }));
  conns.sort((x, y) => x.td - y.td);
  const best = new Map(), lab = new Map(), tb = new Map(), t0 = Math.min(...orig.map(o => o.t));
  const footRelax = s => { const l = lab.get(s); if (!l || l.kind === 'foot') return; for (const f of net.foot(s)) { const t = l.t + f.sec * 1000; if (t < (best.get(f.to) ?? Infinity)) { best.set(f.to, t); lab.set(f.to, { t, kind: 'foot', from: s, prev: l }); } } };
  for (const o of orig) { best.set(o.stop, o.t); lab.set(o.stop, { t: o.t, kind: 'start' }); }
  for (const o of orig) footRelax(o.stop);
  let bestT = Infinity, bestL = null;
  for (const c of conns) {
    if (c.td < t0) continue; if (c.td > bestT) break;
    const l = lab.get(c.a); let tr = tb.get(c.id);
    if (!tr && l && l.t + (l.kind === 'ride' ? TT_BUF_MS : 0) <= c.td) { tr = { c, prev: l }; tb.set(c.id, tr); }
    if (!tr || !(c.ta < (best.get(c.b) ?? Infinity))) continue;
    best.set(c.b, c.ta); lab.set(c.b, { t: c.ta, kind: 'ride', c, tr }); footRelax(c.b);
    for (const t of targ) { const l2 = lab.get(t.stop); if (l2 && l2.t + t.sec * 1000 < bestT) { bestT = l2.t + t.sec * 1000; bestL = l2; } }
  }
  if (!bestL) return [];
  const legs = []; let l = bestL;
  while (l && l.kind !== 'start') {
    if (l.kind === 'ride') { const P = net.pats[l.c.pi]; legs.push({ type: 'ride', label: P.label, dest: P.dest, board: l.tr.c.a, alight: l.c.b, dep: l.tr.c.td, arr: l.c.ta, metro: !!P.metro, lineId: P.lineId || null, stops: l.c.ai - l.tr.c.bi, est: !!l.c.trip.est, waitS: l.c.trip.waitS ?? null, src: l.c.trip.src || '預定時刻' }); l = l.tr.prev; }
    else { legs.push({ type: 'foot', from: l.from }); l = l.prev; }
  }
  return [{ arriveMs: bestT, legs: legs.reverse() }];
}

export async function ttSearch(algo, force) {
  const b = State.bus, f = State.nodeXY, fx = f[State.fromPoint.idx*5+2], fy = f[State.fromPoint.idx*5+3], tx = f[State.toPoint.idx*5+2], ty = f[State.toPoint.idx*5+3], dep = getDepMs();
  const net = await buildNet(fx, fy, tx, ty, force);
  const acc = i => (b.stopKind[i] === 'metro' ? METRO_ACCESS_S : 0);                                   // 捷運：進站／出站時間（推估）
  const orig = nearbyStops(fx, fy, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, t: dep + (s.dm / WALK_MPS + acc(s.i)) * 1000 })), targ = nearbyStops(tx, ty, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, sec: s.dm / WALK_MPS + acc(s.i) }));
  const t0 = performance.now(), runA = os => orig.length && targ.length ? (algo === 'csa' ? csa(net, os, targ) : raptor(net, os, targ)) : [];
  const js = runA(orig), later = [], sigOf = j => j.legs.filter(l => l.type === 'ride').map(l => l.label + l.dep).join('|'), seenJ = new Set(js.map(sigOf));
  for (const off of [15, 30, 45]) for (const j of runA(orig.map(o => ({ ...o, t: o.t + off * 60e3 })))) if (!seenJ.has(sigOf(j))) { seenJ.add(sigOf(j)); later.push(j); }   // 較晚出發的選項
  return { algo, dep, net, js, later, ms: performance.now() - t0, nOrig: orig.length, nTarg: targ.length };
}

export function journeyToSug(net, j, fx, fy, tx, ty) {
  const rides = j.legs.filter(l => l.type === 'ride').map(l => ({ label: l.label, stops: [l.board, l.alight], sec: (l.arr - l.dep) / 1000 }));
  const first = j.legs.find(l => l.type === 'ride'), last = [...j.legs].reverse().find(l => l.type === 'ride');
  return { rides, walkIn: worldDistM(fx, fy, State.bus.x[first.board], State.bus.y[first.board]), walkOut: worldDistM(State.bus.x[last.alight], State.bus.y[last.alight], tx, ty) };
}
