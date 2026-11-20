// bus-plan.js
import { State } from './state.js';
import { BOARD_WAIT_S, CLS, GROUP_WALK_S, MAX_BUS_OPTS, METRO_ACCESS_S, METRO_WAIT_S, WALK_MAX_M, WALK_MPS, YB_DOCK_M, YB_MAX_S, YB_MIN_M, YB_RENT_S, YB_RETURN_S, YB_STOPS, YB_WALK_M } from './constants.js';
import { MinHeap } from './heap.js';
import { nearbyStops, routeKindOf } from './bus-core.js';
import { worldDistM, worldToLonLat } from './geo.js';
import { qc } from './ctx.js';
import { ensureRA } from './road-attrs.js';
import { DEFAULT_LIMIT, VEHICLES } from './vehicle.js';
import { DELAY, FLOW } from './eta-params.js';
import { ubNear } from './ubike.js';

// 以「邊」為狀態的 Dijkstra：換路線加罰時 TRANSFER_S；同站群（對向站牌）可步行轉乘；多起點、多終點

// 一串連續的邊 → 方案中的「搭乘段」（同一路線且連續站才算同一段）
function ridesOf(edges) {
  const bs = State.bus, rides = []; let cur = null;
  for (const e of edges) {
    const r = bs.eRoute[e];
    if (cur && r >= 0 && cur.rid === r && cur.last === bs.eFrom[e]) { cur.stops.push(bs.eTo[e]); cur.sec += bs.eTime[e]; cur.last = bs.eTo[e]; }
    else { cur = { rid: r, label: r >= 0 ? bs.routeLabels[r] : '公車', stops: [bs.eFrom[e], bs.eTo[e]], sec: bs.eTime[e], last: bs.eTo[e] }; rides.push(cur); }
  }
  return rides;
}
const GROUP_WALK_M = GROUP_WALK_S * WALK_MPS;          // 同站群步行轉乘的假設距離（公尺）
export const waitOf = r => (State.bus.routeKind && State.bus.routeKind[r] === 'metro') ? METRO_WAIT_S : BOARD_WAIT_S;   // 公車：預設候車；捷運：假設班距的一半（系統推估）
// 捷運站：從街道進站到月台（或出站）要時間；起點走進捷運站、在捷運站下車走到終點都要加上（系統推估）
const accessS = i => (State.bus.stopKind[i] === 'metro' ? METRO_ACCESS_S : 0);
// 轉乘連結（捷運 ↔ 公車、捷運跨線；依道路步行距離，見 transit.js）。公車對向站牌仍走原本的「同站群」規則
const linksOf = v => (State.bus.xfer && State.bus.xfer.get(v)) || [];
export function walkLink(a, z) {
  const b = State.bus; if (a === z) return { m: 0, sec: 0, src: '同一站' };
  const l = linksOf(a).find(x => x.to === z); if (l) return { m: l.m, sec: l.sec, src: l.src };
  if (b.group[a] >= 0 && b.group[a] === b.group[z]) return { m: GROUP_WALK_M, sec: GROUP_WALK_S, src: '同站群（對向站牌，固定推估）' };
  return null;
}
export function suggestBus(fx, fy, tx, ty, collect, opts) {
  const ban = opts && opts.ban, only = opts && opts.only, first = opts && opts.first, okE = e => (!ban || !ban.has(State.bus.eRoute[e])) && (only === undefined || State.bus.eRoute[e] === only);
  // opts.src／opts.dst：改用指定的上車／下車站與到站時間（YouBike 接駁用；每筆 { i, sec, dm, bike }）
  const b = State.bus, S = (opts && opts.src) || nearbyStops(fx, fy, 6, WALK_MAX_M, 'out'), Tt = (opts && opts.dst) || nearbyStops(tx, ty, 6, WALK_MAX_M, 'in');
  if (!S.length) return { error: opts && opts.src ? '騎 YouBike 可到的範圍內沒有可上車的站' : `起點 ${WALK_MAX_M} 公尺內沒有公車站` };
  if (!Tt.length) return { error: opts && opts.dst ? '騎 YouBike 可到的範圍內沒有可下車的站' : `終點 ${WALK_MAX_M} 公尺內沒有公車站` };
  const tw = new Map(Tt.map(t => [t.i, t.dm])), sw = new Map(S.map(s => [s.i, s.dm]));
  const sCost = s => (s.sec != null ? s.sec : s.dm / WALK_MPS + accessS(s.i)), tc = new Map(Tt.map(t => [t.i, t.sec != null ? t.sec : t.dm / WALK_MPS + accessS(t.i)]));
  const m = b.eTo.length, dist = new Float64Array(m).fill(Infinity), prev = new Int32Array(m).fill(-1), pq = new MinHeap();
  for (const s of S) for (let e = b.off[s.i]; e < b.off[s.i+1]; e++) {
    if (!okE(e) || (first !== undefined && b.eRoute[e] !== first)) continue;      // first：第一段必須搭這條路線（之後可換乘）
    const c = sCost(s) + waitOf(b.eRoute[e]) + b.eTime[e]; if (c < dist[e]) { dist[e] = c; pq.push(c, e); }
  }
  let best = Infinity, bestE = -1;
  while (pq.size) {
    const [d, e] = pq.pop();
    if (d > dist[e]) continue;
    if (d >= (collect ? best * 1.25 : best)) break;                // 收集模式：多掃一點，找出可能相關的路線
    if (collect && b.eRoute[e] >= 0 && collect.size < 20) collect.add(b.eRoute[e]);
    const v = b.eTo[e], r = b.eRoute[e], wc = tc.get(v);
    if (wc !== undefined && d + wc < best) { best = d + wc; bestE = e; }
    const mem = b.group[v] >= 0 ? b.members[b.group[v]] : [v], lk = linksOf(v);
    for (let q = 0; q < mem.length + lk.length; q++) {
      const u = q < mem.length ? mem[q] : lk[q - mem.length].to, extra = q < mem.length ? (u === v ? 0 : GROUP_WALK_S) : lk[q - mem.length].sec;
      for (let e2 = b.off[u]; e2 < b.off[u+1]; e2++) {
        if (!okE(e2)) continue;
        const nd = d + extra + (u === v && r >= 0 && b.eRoute[e2] === r ? 0 : waitOf(b.eRoute[e2])) + b.eTime[e2];
        if (nd < dist[e2]) { dist[e2] = nd; prev[e2] = e; pq.push(nd, e2); }
      }
    }
  }
  if (bestE < 0) return { error: '公車網路中找不到連線（不同系統或資料未接通）' };
  const edges = []; for (let e = bestE; e >= 0; e = prev[e]) edges.push(e); edges.reverse();
  const rides = ridesOf(edges);
  const s0 = edges.length ? b.eFrom[edges[0]] : -1, sN = b.eTo[bestE], bi = opts && opts.src ? S.find(x => x.i === s0) : null, bo = opts && opts.dst ? Tt.find(x => x.i === sN) : null;
  return { kind: rides.length > 1 ? 'transfer' : 'direct', rides, sec: best, transfers: rides.length - 1, walkIn: sw.get(s0) ?? 0,
           walkOut: tw.get(sN) ?? 0, ox: fx, oy: fy, dx: tx, dy: ty, ...(bi && bi.bike ? { bikeIn: bi.bike } : {}), ...(bo && bo.bike ? { bikeOut: bo.bike } : {}) };
}

// ---------- YouBike 接駁（第一／最後一哩）----------
// 在道路網上騎腳踏車的時間：每段 長度 ÷（min(速限, 腳踏車上限) × 腳踏車車流係數），路口另加延遲——與導航 ETA 的腳踏車模型相同（eta-engine.js）。
// 禁行：步道、國道、快速道路（同 vehicle.js 的腳踏車設定）。沒有即時可借車輛／空位資料：只用站點位置，介面標示「未含即時車輛」。
let ybCache = null;
function ybGraph() {
  const ra = ensureRA(); if (ybCache && ybCache.adjTo === State.adjTo && ybCache.ra === ra) return ybCache;      // 路網或道路屬性換了才重建
  const m = State.adjTo.length, N = State.N, ban = new Set(VEHICLES.bike.ban), cap = VEHICLES.bike.cap, t = new Float32Array(m), len = new Float32Array(m), deg = new Uint8Array(N), XY = State.nodeXY;
  // 路段長度：權重 w 是公尺（與幾何長度相符）就用它（含彎曲）；不是（例如單位不同）就用兩端點的距離
  let sw = 0, sg = 0; for (let u = 0; u < N; u++) for (let k = State.adjOffset[u]; k < State.adjOffset[u + 1]; k++) { const v = State.adjTo[k]; len[k] = worldDistM(XY[u*5+2], XY[u*5+3], XY[v*5+2], XY[v*5+3]); sw += State.adjW[k]; sg += len[k]; }
  const useW = sg > 0 && sw / sg >= 0.95 && sw / sg <= 1.6; if (useW) for (let k = 0; k < m; k++) len[k] = State.adjW[k];
  for (let k = 0; k < m; k++) { const cl = ra.cls[k]; if (ban.has(cl)) { t[k] = Infinity; continue; }
    const lim = ra.limit[k], kmh = cl === CLS.bike ? cap : Math.min(Number.isFinite(lim) ? lim : (DEFAULT_LIMIT[cl] ?? 30), cap); t[k] = len[k] / Math.max(1, kmh / 3.6 * (FLOW.bike[cl] ?? 0.85)); }
  for (let v = 0; v < N; v++) { const a = State.adjOffset[v], z = State.adjOffset[v + 1]; let c = 0;               // 相異鄰居數（路口岔數）
    for (let k = a; k < z; k++) { let dup = false; for (let q = a; q < k; q++) if (State.adjTo[q] === State.adjTo[k]) { dup = true; break; } if (!dup) c++; } deg[v] = Math.min(255, c); }
  // 反向鄰接（最後一哩：從終點附近的還車站「倒著」找）
  const rOff = new Int32Array(N + 1), rFrom = new Int32Array(m), rEdge = new Int32Array(m);
  for (let k = 0; k < m; k++) rOff[State.adjTo[k] + 1]++;
  for (let v = 0; v < N; v++) rOff[v + 1] += rOff[v];
  const fill = rOff.slice(0, N);
  for (let u = 0; u < N; u++) for (let k = State.adjOffset[u]; k < State.adjOffset[u + 1]; k++) { const j = fill[State.adjTo[k]]++; rFrom[j] = u; rEdge[j] = k; }
  return (ybCache = { adjTo: State.adjTo, ra, t, len, deg, rOff, rFrom, rEdge });
}
const jDelay = d => (d >= 4 ? DELAY.bike.j4 : d === 3 ? DELAY.bike.j3 : 0);
// 從節點 s 出發（reverse＝到達節點 s），騎乘 maxS 秒內可到的節點 → Map(node → { s 秒, m 公尺, p 前一個節點 })
export function bikeTree(s, maxS, reverse = false) {
  const G = ybGraph(), out = new Map([[s, { s: 0, m: 0, p: -1 }]]), pq = new MinHeap(); pq.push(0, s);
  while (pq.size) {
    const [d, u] = pq.pop(), cu = out.get(u); if (d > cu.s) continue;
    const a = reverse ? G.rOff[u] : State.adjOffset[u], z = reverse ? G.rOff[u + 1] : State.adjOffset[u + 1];
    for (let j = a; j < z; j++) {
      const k = reverse ? G.rEdge[j] : j, v = reverse ? G.rFrom[j] : State.adjTo[k], tk = G.t[k]; if (!isFinite(tk)) continue;
      const nd = d + tk + jDelay(G.deg[reverse ? u : v]); if (nd > maxS) continue;
      const cv = out.get(v); if (!cv || nd < cv.s) { out.set(v, { s: nd, m: cu.m + G.len[k], p: u }); pq.push(nd, v); }
    }
  }
  return out;
}
const ybInfo = i => { const U = State.UB, [lon, lat] = worldToLonLat(U.x[i], U.y[i]); return { idx: i, uid: U.uid[i], name: U.name[i], lon: +lon.toFixed(7), lat: +lat.toFixed(7), cap: U.cap[i] || null, kind: 'ubike' }; };
function treePath(tree, node, reverse) { const out = []; for (let v = node, n = 0; v >= 0 && n < 100000; v = tree.get(v).p, n++) out.push(v); if (!reverse) out.reverse(); return out.map(v => [State.nodeXY[v * 5 + 2], State.nodeXY[v * 5 + 3]]); }
// dir='in'：起點 → 借車站 →（騎）→ 還車站 → 上車站；dir='out'：下車站 → 借車站 →（騎）→ 還車站 → 終點
export function bikeLinks(x, y, dir = 'in') {
  const U = State.UB; if (!U || !U.x || !State.N || !State.bus) return [];
  const homes = ubNear(x, y, YB_WALK_M).map(i => ({ i, dm: worldDistM(x, y, U.x[i], U.y[i]) })).sort((a, c) => a.dm - c.dm).slice(0, 3);
  const best = new Map(), stByNode = new Map();
  for (let i = 0; i < U.n; i++) if (U.node[i] >= 0 && U.nd[i] <= 150) { const a = stByNode.get(U.node[i]); if (a) a.push(i); else stByNode.set(U.node[i], [i]); }
  for (const h of homes) {
    if (!(U.node[h.i] >= 0)) continue;
    const tree = bikeTree(U.node[h.i], YB_MAX_S, dir === 'out');
    for (const [node, r] of tree) {
      if (r.m < YB_MIN_M) continue;                                                           // 太近：直接走路就好
      for (const o of stByNode.get(node) || []) {
        if (o === h.i) continue;
        for (const st of nearbyStops(U.x[o], U.y[o], 4, YB_DOCK_M, dir === 'in' ? 'out' : 'in')) {
          if (worldDistM(x, y, State.bus.x[st.i], State.bus.y[st.i]) <= WALK_MAX_M) continue;   // 本來就走得到的站不需要騎車
          const walkA = h.dm, walkB = st.dm, sec = walkA / WALK_MPS + YB_RENT_S + r.s + YB_RETURN_S + walkB / WALK_MPS + accessS(st.i);
          const cur = best.get(st.i); if (cur && cur.sec <= sec) continue;
          best.set(st.i, { i: st.i, dm: walkA + walkB, sec, bike: { rent: dir === 'in' ? h.i : o, ret: dir === 'in' ? o : h.i, bikeM: Math.round(r.m), bikeS: Math.round(r.s), walkToRentM: Math.round(dir === 'in' ? walkA : walkB), walkFromReturnM: Math.round(dir === 'in' ? walkB : walkA), sec: Math.round(sec), _tree: tree, _node: node, _rev: dir === 'out' } });
        }
      }
    }
  }
  const all = [...best.values()].sort((a, c) => a.sec - c.sec), metro = all.filter(x => State.bus.stopKind[x.i] === 'metro').slice(0, 4), out = all.slice(0, YB_STOPS);
  for (const m of metro) if (!out.includes(m)) out.push(m);                                  // 捷運站優先保留（YouBike＋捷運最常見）
  for (const o of out) { const bk = o.bike; bk.path = treePath(bk._tree, bk._node, bk._rev); delete bk._tree; delete bk._node; delete bk._rev; }
  return out;
}

// 四個目標：總時間(秒)、步行距離(公尺)、轉乘次數、候車時間(秒)——規則與 suggestBus 完全一致
export function critOf(o) {
  let wait = 0, walk = o.walkIn + o.walkOut;
  o.rides.forEach((r, i) => { wait += waitOf(r.rid); if (i && o.rides[i-1].last !== r.stops[0]) { const l = walkLink(o.rides[i-1].last, r.stops[0]); walk += l ? l.m : GROUP_WALK_M; } });
  return { time: o.sec, walk, transfers: o.transfers, wait };
}
const CK = ['time', 'walk', 'transfers', 'wait'];
export const dominates = (a, c) => CK.every(k => a[k] <= c[k] + (k === 'time' ? 1 : 0)) && CK.some(k => a[k] < c[k] - (k === 'time' ? 1 : 0));   // 時間差 1 秒內視為相同

// 多目標 A*（標籤設定）：每個狀態保留 Pareto 標籤（ε-支配、每狀態上限），以「剩餘直線距離 ÷ 最高速度」作時間下界；
// 只有「被已找到的結果嚴格支配」才剪枝，其餘保留 → 找出 時間×步行×轉乘×候車 的 Pareto 最優行程
export function moaStar(fx, fy, tx, ty, opt = {}) {
  const b = State.bus, S = nearbyStops(fx, fy, 6, WALK_MAX_M, 'out'), Tt = nearbyStops(tx, ty, 6, WALK_MAX_M, 'in');
  if (!S.length || !Tt.length) return [];
  const eps = opt.eps ?? 0.02, cap = opt.cap ?? 6, maxPops = opt.maxPops ?? 60000, tw = new Map(Tt.map(t => [t.i, t.dm])), sw = new Map(S.map(s => [s.i, s.dm]));
  if (!b._vmaxT) { let v = WALK_MPS; for (let e = 0; e < b.eTo.length; e++) if (b.eTime[e] > 0 && b.eDist[e] > 0) v = Math.max(v, b.eDist[e] / b.eTime[e]); b._vmaxT = v; }
  const hOf = v => worldDistM(b.x[v], b.y[v], tx, ty) / b._vmaxT;                       // 時間下界：直線距離 ÷ 全網最高速度（步行更慢，所以不會高估）
  const dom = (a, c, e) => a[0] <= c[0] * (1 + e) + 1e-9 && a[1] <= c[1] * (1 + e) + 1e-9 && a[2] <= c[2] && a[3] <= c[3] * (1 + e) + 1e-9;
  const strict = (a, c) => dom(a, c, 0) && (a[0] < c[0] || a[1] < c[1] || a[2] < c[2] || a[3] < c[3]);
  const LAB = [], at = new Map(), res = [], pq = new MinHeap(); let pops = 0, bestT = Infinity;
  const add = (e, c, par) => {
    const f = c[0] + hOf(b.eTo[e]);
    if (f > bestT * 1.8 + 600) return;
    const lb = [f, c[1], c[2], c[3]];
    for (const r of res) if (strict(r.c, lb)) return;
    let arr = at.get(e); if (!arr) at.set(e, arr = []);
    for (const id of arr) if (!LAB[id].dead && dom(LAB[id].c, c, eps)) return;
    for (const id of arr) if (!LAB[id].dead && strict(c, LAB[id].c)) LAB[id].dead = true;
    const live = arr.filter(id => !LAB[id].dead); if (live.length >= cap) return;
    const id = LAB.push({ e, c, par, dead: false }) - 1; arr.length = 0; arr.push(...live, id); pq.push(f, id);
  };
  for (const s of S) for (let e = b.off[s.i]; e < b.off[s.i+1]; e++) { const w = waitOf(b.eRoute[e]); add(e, [s.dm / WALK_MPS + accessS(s.i) + w + b.eTime[e], s.dm, 0, w], -1); }
  while (pq.size && pops++ < maxPops) {
    const id = pq.pop()[1], L = LAB[id]; if (L.dead) continue;
    const v = b.eTo[L.e], r = b.eRoute[L.e], wd = tw.get(v);
    if (wd !== undefined) {
      const c = [L.c[0] + wd / WALK_MPS + accessS(v), L.c[1] + wd, L.c[2], L.c[3]];
      if (!res.some(x => strict(x.c, c) || (x.c[0] === c[0] && x.c[1] === c[1] && x.c[2] === c[2] && x.c[3] === c[3]))) {
        for (let i = res.length - 1; i >= 0; i--) if (strict(c, res[i].c)) res.splice(i, 1);
        res.push({ c, id, wd }); bestT = Math.min(bestT, c[0]);
      }
    }
    const mem = b.group[v] >= 0 ? b.members[b.group[v]] : [v], lk = linksOf(v);
    for (let q = 0; q < mem.length + lk.length; q++) {
      const u = q < mem.length ? mem[q] : lk[q - mem.length].to, extra = q < mem.length ? (u === v ? 0 : GROUP_WALK_S) : lk[q - mem.length].sec, wx = q < mem.length ? (u === v ? 0 : GROUP_WALK_M) : lk[q - mem.length].m;
      for (let e2 = b.off[u]; e2 < b.off[u+1]; e2++) {
        const same = u === v && r >= 0 && b.eRoute[e2] === r, w2 = same ? 0 : waitOf(b.eRoute[e2]);
        add(e2, [L.c[0] + extra + w2 + b.eTime[e2], L.c[1] + wx, L.c[2] + (same ? 0 : 1), L.c[3] + w2], id);
      }
    }
  }
  const out = [];
  for (const x of res) {
    const edges = []; for (let i = x.id; i >= 0; i = LAB[i].par) edges.push(LAB[i].e); edges.reverse();
    const rides = ridesOf(edges), o = { kind: rides.length > 1 ? 'transfer' : 'direct', rides, sec: x.c[0], transfers: rides.length - 1, walkIn: sw.get(b.eFrom[edges[0]]) ?? 0, walkOut: tw.get(b.eTo[edges[edges.length - 1]]) ?? 0, ox: fx, oy: fy, dx: tx, dy: ty, moa: true };
    out.push(o);
  }
  out.pops = pops; return out;
}

export function suggestBusMulti(fx, fy, tx, ty) {
  const base = suggestBus(fx, fy, tx, ty), ybOn = !!(State.UB && State.UB.x && qc('ubikeLink', true));
  if (base.error && !ybOn) return [base];
  const sig = o => (o.bikeIn ? 'B' + o.bikeIn.rent + '-' + o.bikeIn.ret + '|' : '') + o.rides.map(r => r.label + ':' + r.stops[0] + '>' + r.stops[r.stops.length - 1]).join('|') + (o.bikeOut ? '|B' + o.bikeOut.rent + '-' + o.bikeOut.ret : ''), seen = new Map(), put = o => { if (o && !o.error && !seen.has(sig(o))) seen.set(sig(o), o); };
  if (!base.error) {
    put(base);
    const S = nearbyStops(fx, fy, 8, WALK_MAX_M, 'out'), routes = new Set();
    for (const s0 of S) for (let e = State.bus.off[s0.i]; e < State.bus.off[s0.i+1]; e++) if (State.bus.eRoute[e] >= 0) routes.add(State.bus.eRoute[e]);
    for (const r of [...routes].slice(0, 14)) put(suggestBus(fx, fy, tx, ty, null, { first: r }));       // 起點附近每條路線：各找一個「以它開頭」的最佳方案（直達或換乘）
    let frontier = [{ ban: new Set(), o: base }], searches = 0;
    for (let depth = 0; depth < 1 && searches < 16; depth++) {                                           // 禁用已用路線 → 換不同的路線組合
      const next = [];
      for (const { ban, o } of frontier) for (const r of o.rides.map(x => x.rid)) {
        if (searches++ >= 16 || r < 0) continue;
        const ban2 = new Set([...ban, r]), o2 = suggestBus(fx, fy, tx, ty, null, { ban: ban2 });
        if (!o2.error) { put(o2); next.push({ ban: ban2, o: o2 }); }
      }
      frontier = next;
    }
    for (const o of moaStar(fx, fy, tx, ty)) put(o);                                                   // 多目標 A*：補上「時間不是最短、但步行／轉乘／候車較好」的方案
  }
  // YouBike 接駁：起點騎到較遠的站上車、下車後騎到終點、或兩頭都騎（有 YouBike 站點資料、且沒有關掉時）。
  // 起點或終點附近走路到不了任何站時，這是唯一的方案來源
  if (ybOn) {
    const bi = bikeLinks(fx, fy, 'in'), bo = bikeLinks(tx, ty, 'out');
    if (bi.length) put(suggestBus(fx, fy, tx, ty, null, { src: bi }));
    if (bo.length) put(suggestBus(fx, fy, tx, ty, null, { dst: bo }));
    if (bi.length && bo.length) put(suggestBus(fx, fy, tx, ty, null, { src: bi, dst: bo }));
  }
  if (!seen.size) return [base.error ? base : { error: '找不到大眾運輸方案' }];
  let all = [...seen.values()].sort((a, c) => a.sec - c.sec);
  for (const o of all) o.crit = critOf(o);
  for (const o of all) o.pareto = !all.some(x => x !== o && dominates(x.crit, o.crit));              // Pareto 最優 = 沒有任何方案在四個目標上都不輸、且至少一項更好
  all = all.filter(o => o.pareto || !(o.bikeIn || o.bikeOut));                                       // 騎車方案只在「有好處」（不被其他方案全面勝過）時列出
  const par = all.filter(o => o.pareto).slice(0, 12), out = [...par];
  for (const o of all) if (out.length < MAX_BUS_OPTS && !out.includes(o)) out.push(o);
  return out.sort((a, c) => a.sec - c.sec);
}

// 方案 → 分段（API 與畫面共用）：WALK（起終點步行）、BUS_RIDE、METRO_RIDE、TRANSFER（兩段之間的步行轉乘）
// 時間是系統推估（候車＝假設值；捷運沒有時刻資料時，班距與行駛時間也是推估），每段都附來源
export function legsOf(o) {
  const b = State.bus, L = [], R = o.rides; if (!R || !R.length) return L;
  const s0 = R[0].stops[0], sN = R[R.length - 1].stops[R[R.length - 1].stops.length - 1];
  const bikeLegs = (bk, a, z) => { const A = ybInfo(bk.rent), Z = ybInfo(bk.ret);
    return [{ type: 'WALK', from: a, to: A, m: bk.walkToRentM, sec: Math.round(bk.walkToRentM / WALK_MPS), note: '' },
      { type: 'BIKE', from: A, to: Z, m: bk.bikeM, sec: Math.round(YB_RENT_S + bk.bikeS + YB_RETURN_S), rideS: bk.bikeS, path: bk.path, src: `YouBike：腳踏車道路時間（速限×車流係數＋路口延遲）＋借還車各 ${YB_RENT_S} 秒，皆為推估；未含即時可借車輛／空位`, estimate: true },
      { type: 'WALK', from: Z, to: z, m: bk.walkFromReturnM, sec: Math.round(bk.walkFromReturnM / WALK_MPS + (typeof z === 'number' ? accessS(z) : 0)), note: '' }]; };
  if (o.bikeIn) L.push(...bikeLegs(o.bikeIn, 'origin', s0));
  else L.push({ type: 'WALK', from: 'origin', to: s0, m: Math.round(o.walkIn), sec: Math.round(o.walkIn / WALK_MPS + accessS(s0)), note: accessS(s0) ? `含進站 ${METRO_ACCESS_S} 秒（推估）` : '' });
  R.forEach((r, i) => {
    if (i) { const a = R[i - 1].stops[R[i - 1].stops.length - 1], z = r.stops[0], l = walkLink(a, z) || { m: GROUP_WALK_M, sec: GROUP_WALK_S, src: '推估' };
      L.push({ type: 'TRANSFER', from: a, to: z, m: Math.round(l.m), sec: Math.round(l.sec), src: l.src, sameStop: a === z }); }
    const metro = routeKindOf(r) === 'metro', key = b.routeKeys ? b.routeKeys[r.rid] : null, mm = State.metroJson && State.metroJson.meta;
    const fr = metro && mm && mm.fares && b.uids ? mm.fares[b.uids[r.stops[0]] + '>' + b.uids[r.stops[r.stops.length - 1]]] : null;   // 票價：只有 TDX ODFare 有的起訖站才顯示
    L.push({ type: metro ? 'METRO_RIDE' : 'BUS_RIDE', rid: r.rid, route: r.label, lineId: metro && key ? String(key).replace(/^MRT-/, '') : null, routeKey: key, from: r.stops[0], to: r.stops[r.stops.length - 1],
      stops: r.stops.length - 1, via: r.stops, rideS: Math.round(r.sec), waitS: waitOf(r.rid), estimate: true, src: metro ? (mm && mm.runSrc === 'TDX S2STravelTime' ? '行駛時間 TDX S2STravelTime；候車依班距推估' : mm && /S2S/.test(mm.runSrc || '') ? '行駛時間部分 TDX、部分推估；候車依班距推估' : '系統推估（班距、行駛時間）') : '系統推估（候車為假設值）',
      ...(fr ? { fare: { single: fr[0], card: fr[1], src: 'TDX ODFare（全票）' } } : {}) });
  });
  if (o.bikeOut) { const bl = bikeLegs(o.bikeOut, sN, 'destination'); bl[0].sec += accessS(sN); L.push(...bl); }
  else L.push({ type: 'WALK', from: sN, to: 'destination', m: Math.round(o.walkOut), sec: Math.round(o.walkOut / WALK_MPS + accessS(sN)), note: accessS(sN) ? `含出站 ${METRO_ACCESS_S} 秒（推估）` : '' });
  return L;
}

// 依「目標」挑出推薦方案：fastest＝總時間最短；fewer＝轉乘最少（同分取較快）；lesswalk＝步行最短；pareto＝只看 Pareto 最優，取其中最快
export function pickRecommended(opts, goal) {
  if (!opts.length || opts[0].error) return -1;
  const walkOf = o => o.crit ? o.crit.walk : (o.walkIn || 0) + (o.walkOut || 0), idx = [...opts.keys()];
  const by = (f, pool = idx) => pool.reduce((a, i) => { const x = f(opts[i]), y = f(opts[a]); return x < y - 1e-9 || (Math.abs(x - y) <= 1e-9 && opts[i].sec < opts[a].sec) ? i : a; }, pool[0]);
  if (goal === 'fewer') return by(o => o.transfers);
  if (goal === 'lesswalk') return by(walkOf);
  if (goal === 'pareto') { const pool = idx.filter(i => opts[i].pareto); return by(o => o.sec, pool.length ? pool : idx); }
  return by(o => o.sec);
}
