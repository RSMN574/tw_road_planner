// bus-plan.js
import { State } from './state.js';
import { BOARD_WAIT_S, GROUP_WALK_S, MAX_BUS_OPTS, METRO_WAIT_S, WALK_MAX_M, WALK_MPS } from './constants.js';
import { MinHeap } from './heap.js';
import { nearbyStops } from './bus-core.js';
import { worldDistM } from './geo.js';

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
const waitOf = r => (State.bus.routeKind && State.bus.routeKind[r] === 'metro') ? METRO_WAIT_S : BOARD_WAIT_S;   // 公車：預設候車；捷運：假設班距的一半（系統推估）
export function suggestBus(fx, fy, tx, ty, collect, opts) {
  const ban = opts && opts.ban, only = opts && opts.only, first = opts && opts.first, okE = e => (!ban || !ban.has(State.bus.eRoute[e])) && (only === undefined || State.bus.eRoute[e] === only);
  const b = State.bus, S = nearbyStops(fx, fy, 6, WALK_MAX_M, 'out'), Tt = nearbyStops(tx, ty, 6, WALK_MAX_M, 'in');
  if (!S.length) return { error: `起點 ${WALK_MAX_M} 公尺內沒有公車站` };
  if (!Tt.length) return { error: `終點 ${WALK_MAX_M} 公尺內沒有公車站` };
  const tw = new Map(Tt.map(t => [t.i, t.dm])), sw = new Map(S.map(s => [s.i, s.dm]));
  const m = b.eTo.length, dist = new Float64Array(m).fill(Infinity), prev = new Int32Array(m).fill(-1), pq = new MinHeap();
  for (const s of S) for (let e = b.off[s.i]; e < b.off[s.i+1]; e++) {
    if (!okE(e) || (first !== undefined && b.eRoute[e] !== first)) continue;      // first：第一段必須搭這條路線（之後可換乘）
    const c = s.dm/WALK_MPS + waitOf(b.eRoute[e]) + b.eTime[e]; if (c < dist[e]) { dist[e] = c; pq.push(c, e); }
  }
  let best = Infinity, bestE = -1;
  while (pq.size) {
    const [d, e] = pq.pop();
    if (d > dist[e]) continue;
    if (d >= (collect ? best * 1.25 : best)) break;                // 收集模式：多掃一點，找出可能相關的路線
    if (collect && b.eRoute[e] >= 0 && collect.size < 20) collect.add(b.eRoute[e]);
    const v = b.eTo[e], r = b.eRoute[e], wd = tw.get(v);
    if (wd !== undefined && d + wd/WALK_MPS < best) { best = d + wd/WALK_MPS; bestE = e; }
    const mem = b.group[v] >= 0 ? b.members[b.group[v]] : [v];
    for (const u of mem) {
      const extra = u === v ? 0 : GROUP_WALK_S;
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
  return { kind: rides.length > 1 ? 'transfer' : 'direct', rides, sec: best, transfers: rides.length - 1, walkIn: sw.get(edges.length ? b.eFrom[edges[0]] : -1) ?? 0,
           walkOut: tw.get(b.eTo[bestE]) ?? 0, ox: fx, oy: fy, dx: tx, dy: ty };
}

// 四個目標：總時間(秒)、步行距離(公尺)、轉乘次數、候車時間(秒)——規則與 suggestBus 完全一致
export function critOf(o) {
  let wait = 0, walk = o.walkIn + o.walkOut;
  o.rides.forEach((r, i) => { wait += waitOf(r.rid); if (i && o.rides[i-1].last !== r.stops[0]) walk += GROUP_WALK_M; });
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
  for (const s of S) for (let e = b.off[s.i]; e < b.off[s.i+1]; e++) { const w = waitOf(b.eRoute[e]); add(e, [s.dm / WALK_MPS + w + b.eTime[e], s.dm, 0, w], -1); }
  while (pq.size && pops++ < maxPops) {
    const id = pq.pop()[1], L = LAB[id]; if (L.dead) continue;
    const v = b.eTo[L.e], r = b.eRoute[L.e], wd = tw.get(v);
    if (wd !== undefined) {
      const c = [L.c[0] + wd / WALK_MPS, L.c[1] + wd, L.c[2], L.c[3]];
      if (!res.some(x => strict(x.c, c) || (x.c[0] === c[0] && x.c[1] === c[1] && x.c[2] === c[2] && x.c[3] === c[3]))) {
        for (let i = res.length - 1; i >= 0; i--) if (strict(c, res[i].c)) res.splice(i, 1);
        res.push({ c, id, wd }); bestT = Math.min(bestT, c[0]);
      }
    }
    for (const u of b.group[v] >= 0 ? b.members[b.group[v]] : [v]) {
      const extra = u === v ? 0 : GROUP_WALK_S, wx = u === v ? 0 : GROUP_WALK_M;
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
  const base = suggestBus(fx, fy, tx, ty); if (base.error) return [base];
  const sig = o => o.rides.map(r => r.label + ':' + r.stops[0] + '>' + r.stops[r.stops.length - 1]).join('|'), seen = new Map(), put = o => { if (o && !o.error && !seen.has(sig(o))) seen.set(sig(o), o); };
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
  const all = [...seen.values()].sort((a, c) => a.sec - c.sec);
  for (const o of all) o.crit = critOf(o);
  for (const o of all) o.pareto = !all.some(x => x !== o && dominates(x.crit, o.crit));              // Pareto 最優 = 沒有任何方案在四個目標上都不輸、且至少一項更好
  const par = all.filter(o => o.pareto).slice(0, 12), out = [...par];
  for (const o of all) if (out.length < MAX_BUS_OPTS && !out.includes(o)) out.push(o);
  return out.sort((a, c) => a.sec - c.sec);
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
