// bus-core.js
import { Hooks, State } from './state.js';
import { BUS_MPS, SNAP_MAX_M, WALK_MAX_M, legCache } from './constants.js';
import { autoUnit, isGeo, lonLatToTWD97, worldDistM, worldHaversine } from './geo.js';
import { MinHeap } from './heap.js';
import { findNearestNode, snapEdge } from './graph-core.js';
import { ensureRA } from './road-attrs.js';

export function parseBus(json) {
  let nr = json.nodes || {};
  if (Array.isArray(nr)) nr = Object.fromEntries(nr.map(n => [n.node_uid ?? n.uid ?? n.id ?? n.stop_id, n]));
  const uids = Object.keys(nr), n = uids.length, idx = new Map(uids.map((u, i) => [u, i]));
  if (!n) throw new Error('找不到 nodes');
  const b = { n, uids, stopIds: new Array(n), stopKind: new Array(n), names: new Array(n), lat: new Float64Array(n), lng: new Float64Array(n),
              group: new Int32Array(n).fill(-1), members: [], routeLabels: [], routeKind: [] };
  const gmap = new Map();
  uids.forEach((u, i) => {
    const o = nr[u] || {};
    b.names[i] = o.node_name || o.name || u; b.stopIds[i] = String(o.stop_id ?? o.stopId ?? ''); b.stopKind[i] = o.kind === 'metro' ? 'metro' : 'bus';
    b.lat[i] = parseFloat(o.latitude ?? o.lat); b.lng[i] = parseFloat(o.longitude ?? o.lng ?? o.lon);
    const g = o.station_group_id ?? o.station_id ?? null;
    if (g != null && g !== '') { let id = gmap.get(g); if (id === undefined) { id = b.members.length; gmap.set(g, id); b.members.push([]); } b.group[i] = id; b.members[id].push(i); }
  });
  const raw = json.adjacency ?? json.edges ?? json.links ?? json.graph?.adjacency;
  if (!raw) throw new Error('找不到 adjacency / edges');
  const F = [], T = [], D = [], R = [], TM = [], rmap = new Map();
  const add = (f, e) => {
    const to = e.to ?? e.target ?? e.node ?? e.node_uid ?? e.to_node_uid ?? e.to_stop_id ?? e.uid ?? e.id ?? e.next ?? e.stop_uid;
    const i = idx.get(String(f)), j = idx.get(String(to));
    if (i === undefined || j === undefined) return;
    let d = Number(e.distance_meters ?? e.distance ?? e.dist ?? e.weight ?? e.w);
    if (!isFinite(d)) d = worldHaversine(b.lng[i], b.lat[i], b.lng[j], b.lat[j]);
    const label = e.subroute_name || e.route_name || e.subroute_id || e.route_id || e.route || e.line || e.subroute_uid || e.route_uid || null;
    const key = e.subroute_uid || e.route_uid || e.subroute_id || e.route_id || label;
    let rid = -1;
    if (key != null) { rid = rmap.get(String(key)); if (rid === undefined) { rid = b.routeLabels.length; rmap.set(String(key), rid); b.routeLabels.push(String(label ?? key)); b.routeKind.push(e.mode === 'metro' ? 'metro' : 'bus'); } }
    const tt = (e.travel_times ?? e.travelTimes ?? e.times ?? []).map(t => Number(t.run_time)).filter(x => x > 0);
    F.push(i); T.push(j); D.push(d); R.push(rid); TM.push(tt.length ? tt.reduce((x, y) => x + y, 0) / tt.length : d / BUS_MPS);
  };
  if (Array.isArray(raw)) for (const e of raw) { if (e && typeof e === 'object') add(e.from_node_uid ?? e.from ?? e.source ?? e.u ?? e.from_uid, e); }
  else for (const f in raw) {
    const l = raw[f];
    if (Array.isArray(l)) for (const e of l) add(f, Array.isArray(e) ? { to: e[0], distance: e[1] } : (typeof e === 'object' ? e : { to: e }));
    else if (l && typeof l === 'object') for (const t in l) add(f, { ...(typeof l[t] === 'object' ? l[t] : { distance: l[t] }), to: t });
  }
  if (!F.length) throw new Error('解析到 0 條邊');
  return Object.assign(b, buildCSR(n, F, T, R, TM, D));
}

// 邊陣列 → CSR（依起點排序）＋入度
export function buildCSR(n, F, T, R, TM, D) {
  const m = F.length, off = new Int32Array(n + 1); for (const f of F) off[f + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const pos = off.slice(0, n), eFrom = new Int32Array(m), eTo = new Int32Array(m), eRoute = new Int32Array(m), eTime = new Float32Array(m), eDist = new Float32Array(m);
  for (let k = 0; k < m; k++) { const q = pos[F[k]]++; eFrom[q] = F[k]; eTo[q] = T[k]; eRoute[q] = R[k]; eTime[q] = TM[k]; eDist[q] = D[k]; }
  const inDeg = new Int32Array(n); for (let k = 0; k < m; k++) inDeg[T[k]]++;
  return { off, eFrom, eTo, eRoute, eTime, eDist, inDeg };
}

// 合併兩份解析後的公車圖（例如 公車 ＋ 捷運）
export function mergeParsed(a, b) {
  const cat = (A, B, C) => { const c = new C(A.length + B.length); c.set(A); c.set(B, A.length); return c; }, gOff = a.members.length, rOff = a.routeLabels.length;
  const m = { n: a.n + b.n, uids: [...a.uids, ...b.uids], stopIds: [...a.stopIds, ...b.stopIds], names: [...a.names, ...b.names], stopKind: [...a.stopKind, ...b.stopKind],
    lat: cat(a.lat, b.lat, Float64Array), lng: cat(a.lng, b.lng, Float64Array),
    group: cat(a.group, Int32Array.from(b.group, g => g < 0 ? -1 : g + gOff), Int32Array),
    members: [...a.members, ...b.members.map(ms => ms.map(i => i + a.n))], routeLabels: [...a.routeLabels, ...b.routeLabels], routeKind: [...a.routeKind, ...b.routeKind] };
  const F = [], T = [], R = [], TM = [], D = [];
  for (const [x, off, ro] of [[a, 0, 0], [b, a.n, rOff]]) for (let i = 0; i < x.n; i++) for (let e = x.off[i]; e < x.off[i+1]; e++) { F.push(i + off); T.push(x.eTo[e] + off); R.push(x.eRoute[e] < 0 ? -1 : x.eRoute[e] + ro); TM.push(x.eTime[e]); D.push(x.eDist[e]); }
  return Object.assign(m, buildCSR(m.n, F, T, R, TM, D));
}

// 這一段搭的是不是捷運（顯示與搜尋都要分開處理：不貼合道路、沒有 TDX 公車 API）
export function routeKindOf(ride) {
  const b = State.bus; if (!b || !b.routeKind) return 'bus';
  const rid = ride.rid !== undefined ? ride.rid : b.routeLabels.indexOf(ride.label);
  return b.routeKind[rid] || 'bus';
}

export function stopXY(i, f, unit) {
  const lon = f.swap ? State.bus.lat[i] : State.bus.lng[i], lat = f.swap ? State.bus.lng[i] : State.bus.lat[i];
  if (isGeo()) return [lon, lat];
  const [e, n] = lonLatToTWD97(lon, lat); return [(e + f.dE) / unit, (n + f.dN) / unit];
}

export function sampleDev(f) {                           // 抽樣約 200 站，量「站點到最近道路節點」的公尺距離
  const unit = f.unit ?? autoUnit(), step = Math.max(1, Math.floor(State.bus.n / 200)), ds = [];
  for (let i = 0; i < State.bus.n; i += step) {
    if (!isFinite(State.bus.lat[i]) || !isFinite(State.bus.lng[i]) || State.bus.stopKind[i] === 'metro') continue;
    const [x, y] = stopXY(i, f, unit), k = findNearestNode(x, y);
    const saved = State.projUnit; State.projUnit = unit;
    ds.push(k < 0 ? Infinity : snapEdge(x, y, k).dm);        // 量到最近「道路線段」，不是最近節點（節點稀疏時才不會高估）
    State.projUnit = saved;
  }
  ds.sort((a, b) => a - b); const q = p => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))];
  return { med: q(0.5), p90: q(0.9), within50: ds.filter(d => d <= 50).length / (ds.length || 1) };
}

export function diagnoseBus() {                          // 比較幾種常見假設，挑最吻合路網的
  const al = autoUnit() === 1 ? 0.01 : 1, F = (o) => ({ swap: false, unit: null, dE: 0, dN: 0, ...o });
  const cands = [['預設', F({})], ['單位互換(m↔cm)', F({ unit: al })], ['經緯度欄位對調', F({ swap: true })], ['TWD67 偏移(−828E/+207N)', F({ dE: -828, dN: 207 })]]
    .filter(c => !(isGeo() && (c[1].unit != null || c[1].dE)));
  const rows = cands.map(([name, f]) => ({ name, f, ...sampleDev(f) }));
  const best = rows.reduce((a, b) => (b.med < a.med ? b : a)), base0 = rows[0];
  const adopt = best !== base0 && best.med < base0.med * 0.5;      // 明顯更好才改用
  State.busFix = adopt ? best.f : base0.f;
  const cur = adopt ? best : base0;
  State.bus.diag = { med: cur.med, p90: cur.p90, within50: cur.within50, adopted: adopt ? best.name : '',
    table: rows.map(r => ({ 方案: r.name, 中位數m: isFinite(r.med) ? +r.med.toFixed(1) : null, P90m: isFinite(r.p90) ? +r.p90.toFixed(1) : null, '50m內': Math.round((r.within50 || 0) * 100) + '%' })) };   // 站點全在路網外時沒有樣本（med 為空）：不能讓建圖失敗
}

export function projectBusStops() {                      // 站點經緯度 → 道路圖座標系；建站點格網索引
  if (!State.bus || !State.N || State.coordType === 'unknown') return false;
  diagnoseBus();
  State.projUnit = State.busFix.unit ?? autoUnit();
  State.bus.x = new Float64Array(State.bus.n); State.bus.y = new Float64Array(State.bus.n);
  const cell = isGeo() ? 0.005 : WALK_MAX_M / State.projUnit, grid = new Map(); State.bus.cell = cell; State.bus.grid = grid;
  for (let i = 0; i < State.bus.n; i++) {
    if (!isFinite(State.bus.lat[i]) || !isFinite(State.bus.lng[i])) { State.bus.x[i] = State.bus.y[i] = NaN; continue; }
    [State.bus.x[i], State.bus.y[i]] = stopXY(i, State.busFix, State.projUnit);
    const key = Math.floor(State.bus.x[i]/cell) * 100000 + Math.floor(State.bus.y[i]/cell);
    let a = grid.get(key); if (!a) grid.set(key, a = []); a.push(i);
  }
  State.bus.node = new Int32Array(State.bus.n).fill(-1); State.bus.sx = Float64Array.from(State.bus.x); State.bus.sy = Float64Array.from(State.bus.y);   // sx/sy：吸附到道路後的「顯示座標」
  let snapped = 0;
  for (let i = 0; i < State.bus.n; i++) {
    if (!(State.bus.x[i] === State.bus.x[i]) || State.bus.stopKind[i] === 'metro') continue;               // 捷運站不吸附到道路
    const k = findNearestNode(State.bus.x[i], State.bus.y[i]); State.bus.node[i] = k; if (k < 0) continue;
    const sn = snapEdge(State.bus.x[i], State.bus.y[i], k);
    if (sn.dm <= SNAP_MAX_M) { State.bus.sx[i] = sn.px; State.bus.sy[i] = sn.py; snapped++; }
  }
  State.bus.snapPct = State.bus.n ? snapped / Math.max(1, State.bus.stopKind.filter(k => k !== 'metro').length) : 0; legCache.clear();
  return true;
}

export function nearbyStops(x, y, limit = 6, maxM = WALK_MAX_M, mode = 'out') {   // mode: out=能上車（有出邊）/ in=能下車（有入邊）/ any
  const c = State.bus.cell, cx = Math.floor(x/c), cy = Math.floor(y/c), out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const i of State.bus.grid.get((cx+dx)*100000 + cy+dy) || []) {
      const dm = worldDistM(x, y, State.bus.x[i], State.bus.y[i]); if (dm <= maxM && (mode === 'any' || (mode === 'out' ? State.bus.off[i+1] > State.bus.off[i] : State.bus.inDeg[i] > 0))) out.push({ i, dm });
    }
  }
  return out.sort((a, b) => a.dm - b.dm).slice(0, limit);
}


export function busNearIdx(x, y, R) {
  const c = State.bus.cell, cx = Math.floor(x/c), cy = Math.floor(y/c), out = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    for (const i of State.bus.grid.get((cx+dx)*100000 + cy+dy) || []) if (worldDistM(x, y, State.bus.x[i], State.bus.y[i]) <= R) out.push(i);
  return out;
}

export function localPath(s0, t0, limit) {                 // 道路圖上的局部最短路（排除公車禁行邊），以世代戳記避免每次配置 N 大小陣列
  if (s0 === t0) return [s0];
  if (!State.SCR || State.SCR.n !== State.N) State.SCR = { n: State.N, gen: 0, st: new Uint32Array(State.N), d: new Float64Array(State.N), p: new Int32Array(State.N) };
  const g = ++State.SCR.gen, { st, d, p } = State.SCR, forb = ensureRA().forb, pq = new MinHeap();
  st[s0] = g; d[s0] = 0; p[s0] = -1; pq.push(0, s0);
  while (pq.size) {
    const [dd, u] = pq.pop();
    if (dd > d[u]) continue; if (u === t0) break; if (dd > limit) return null;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      if (forb[k]) continue;
      const v = State.adjTo[k], nd = dd + State.adjW[k];
      if (st[v] !== g || nd < d[v]) { st[v] = g; d[v] = nd; p[v] = u; pq.push(nd, v); }
    }
  }
  if (st[t0] !== g || d[t0] === Infinity) return null;
  const out = []; for (let c = t0; c !== -1; c = p[c]) out.push(c);
  return out.reverse();
}

export function legCoordsOf(ride) {                        // 一段公車的顯示折線：相鄰站牌之間沿道路連接；找不到合理路徑才退回直線
  const b = State.bus, out = [];
  if (routeKindOf(ride) === 'metro') return ride.stops.map(i => [b.x[i], b.y[i]]);   // 捷運：高架／地下軌道，直接連站，不沿道路
  for (let q = 0; q < ride.stops.length - 1; q++) {
    const a = ride.stops[q], c = ride.stops[q+1], key = a + '>' + c; let leg = legCache.get(key);
    if (!leg) {
      const A = [b.sx[a], b.sy[a]], C = [b.sx[c], b.sy[c]], straight = worldDistM(A[0], A[1], C[0], C[1]);
      const path = b.node[a] >= 0 && b.node[c] >= 0 ? localPath(b.node[a], b.node[c], Math.max(300, straight * 3 + 200)) : null;
      leg = path ? [A, ...path.map(n => [State.nodeXY[n*5+2], State.nodeXY[n*5+3]]), C] : [A, C];
      legCache.set(key, leg);
    }
    out.push(...(q ? leg.slice(1) : leg));
  }
  return out;
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  window.busDiag = () => { if (State.bus && State.bus.diag) { console.table(State.bus.diag.table); return { busFix: State.busFix, projUnit: State.projUnit, coordType: State.coordType }; } };
}
