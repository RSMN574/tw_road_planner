// timetable.js
import { State } from './state.js';
import { KIND_TT, TT_BUF_MS, WALK_MAX_M, WALK_MPS } from './constants.js';
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
  const routesAt = i => { const r = []; for (let e = b.off[i]; e < b.off[i+1]; e++) if (b.eRoute[e] >= 0 && b.routeKind[b.eRoute[e]] !== 'metro') r.push(b.eRoute[e]); return r; };   // 捷運沒有時刻資料，不納入
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
  const fc = new Map();
  const foot = s => {
    let a = fc.get(s); if (a) return a; a = []; const seen = new Set([s]);
    for (const j of busNearIdx(b.x[s], b.y[s], 200)) if (!seen.has(j) && at.has(j)) { seen.add(j); a.push({ to: j, sec: Math.max(30, worldDistM(b.x[s], b.y[s], b.x[j], b.y[j]) / WALK_MPS) }); }
    if (b.group[s] >= 0) for (const j of b.members[b.group[s]]) if (!seen.has(j) && at.has(j)) { seen.add(j); a.push({ to: j, sec: 60 }); }
    fc.set(s, a); return a;
  };
  return { pats, at, foot, labels, errors };
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
        if (pl) { const ready = pl.t + (pl.kind === 'ride' ? TT_BUF_MS : 0), t2 = P.trips.find(x => isFinite(x.dep[i]) && x.dep[i] >= ready); if (t2 && (!trip || t2.dep[i] < trip.dep[i])) { trip = t2; bi = i; } }
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
    if (l.kind === 'ride') { const P = net.pats[l.pi]; legs.push({ type: 'ride', label: P.label, dest: P.dest, board: P.stops[l.bi], alight: P.stops[l.ai], dep: l.trip.dep[l.bi], arr: l.trip.arr[l.ai] }); }
    else legs.push({ type: 'foot', from: l.from });
    l = l.prev;
  }
  return legs.reverse();
}

export function csa(net, orig, targ) {
  const conns = [];
  net.pats.forEach((P, pi) => P.trips.forEach((T, ti) => { for (let i = 0; i < P.stops.length - 1; i++) if (isFinite(T.dep[i]) && isFinite(T.arr[i+1])) conns.push({ a: P.stops[i], b: P.stops[i+1], td: T.dep[i], ta: T.arr[i+1], id: pi + '.' + ti, pi, bi: i, ai: i + 1, trip: T }); }));
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
    if (l.kind === 'ride') { const P = net.pats[l.c.pi]; legs.push({ type: 'ride', label: P.label, dest: P.dest, board: l.tr.c.a, alight: l.c.b, dep: l.tr.c.td, arr: l.c.ta }); l = l.tr.prev; }
    else { legs.push({ type: 'foot', from: l.from }); l = l.prev; }
  }
  return [{ arriveMs: bestT, legs: legs.reverse() }];
}

export async function ttSearch(algo, force) {
  const b = State.bus, f = State.nodeXY, fx = f[State.fromPoint.idx*5+2], fy = f[State.fromPoint.idx*5+3], tx = f[State.toPoint.idx*5+2], ty = f[State.toPoint.idx*5+3], dep = getDepMs();
  const net = await buildNet(fx, fy, tx, ty, force);
  const orig = nearbyStops(fx, fy, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, t: dep + s.dm / WALK_MPS * 1000 })), targ = nearbyStops(tx, ty, 8, 500, 'any').filter(s => net.at.has(s.i)).map(s => ({ stop: s.i, sec: s.dm / WALK_MPS }));
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
