// router-multi.js
import { State } from './state.js';
import { CLS } from './constants.js';
import { isGeo, worldDistM } from './geo.js';
import { MinHeap } from './heap.js';
import { ensureFrom } from './graph-core.js';
import { ensureRA } from './road-attrs.js';
import { edgeCov } from './analysis.js';
import { astar, bidirectionalDijkstra, dijkstra, heuristic, overlapRatio, packRoute, spSearch } from './router.js';

export const solve = (s0, e0, fn, hf) => State.routerMode === 'mlevel' ? multiLevel(s0, e0, fn, hf) : State.routerMode === 'astar' ? (hf ? spSearch(s0, e0, fn, hf) : astar(s0, e0, fn)) : State.routerMode === 'bidir' ? bidirectionalDijkstra(s0, e0, fn) : dijkstra(s0, e0, fn);

export function yenK(s0, e0, fn, K, strideMax = 30, overlapMax = 0.85, hf = true) {   // hf：true＝距離啟發；函式＝廣義成本的下界啟發（時間成本用）
  const first = spSearch(s0, e0, fn, hf); if (!first) return [];
  const sig = r => r.edgePath.map(k => State.adjEid[k]).join('|'), A = [first], B = [], seen = new Set([sig(first)]);
  for (let k = 1; k < K; k++) {
    const prev = A[k-1], L = prev.path.length, stride = Math.max(1, Math.floor((L - 1) / strideMax));    // 路線很長時只取樣部分 spur 節點
    for (let i = 0; i < L - 1; i += stride) {
      let rootCost = 0; for (let q = 0; q < i; q++) rootCost += fn(State.adjEid[prev.edgePath[q]], State.adjW[prev.edgePath[q]], prev.edgePath[q]);
      if (!isFinite(rootCost)) continue;
      const blockedE = new Set(), blockedN = new Set(prev.path.slice(0, i));
      for (const a of A) if (a.path.length > i + 1 && a.path.slice(0, i + 1).every((v, q) => v === prev.path[q])) blockedE.add(a.edgePath[i]);
      const sp = spSearch(prev.path[i], e0, (eid, w, kk) => (blockedE.has(kk) || blockedN.has(State.adjTo[kk])) ? Infinity : fn(eid, w, kk), typeof hf === 'function' ? v => hf(v) : true);
      if (!sp) continue;
      const cand = packRoute(prev.path.slice(0, i).concat(sp.path), prev.edgePath.slice(0, i).concat(sp.edgePath), rootCost + sp.cost), sg = sig(cand);
      if (!seen.has(sg)) { seen.add(sg); B.push(cand); }
    }
    B.sort((a, b) => a.cost - b.cost);
    const j = B.findIndex(c => A.every(a => overlapRatio(a, c) <= overlapMax));          // 要求與已選路線「實際不同」
    if (j < 0) break; A.push(B.splice(j, 1)[0]);
  }
  return A;
}

// 多層級 Dijkstra（近似）：靠近起終點可走所有道路；離開後逐級只走較寬的道路；找不到時退回精確搜尋

export function multiLevel(s0, e0, fn, hf) {
  const ra = ensureRA(), from = ensureFrom(), sx = State.nodeXY[s0*5+2], sy = State.nodeXY[s0*5+3], tx = State.nodeXY[e0*5+2], ty = State.nodeXY[e0*5+3];
  const d = worldDistM(sx, sy, tx, ty), R0 = Math.max(1500, d * 0.05), R1 = Math.max(4000, d * 0.2);
  const u0 = isGeo() ? 1 : State.projUnit, R0c = (R0 / u0) ** 2, R1c = (R1 / u0) ** 2, kx = isGeo() ? Math.cos(sy * Math.PI/180) : 1;   // 以「座標單位的平方距離」比較，避免每次松弛都算 hypot／haversine
  const lvl = k => (ra.cls[k] === CLS.major || ra.width[k] >= 12) ? 2 : ra.width[k] >= 8 ? 1 : 0;
  const fn2 = (eid, w, k) => {
    const c = fn ? fn(eid, w, k) : w; if (c === Infinity) return c;
    const u = from[k], x = State.nodeXY[u*5+2], y = State.nodeXY[u*5+3];
    const m2 = Math.min(((x - sx) * kx) ** 2 + (y - sy) ** 2, ((x - tx) * kx) ** 2 + (y - ty) ** 2);
    return lvl(k) >= (m2 <= R0c ? 0 : m2 <= R1c ? 1 : 2) ? c : Infinity;      // 近端：所有道路；中段：寬度≥8；遠段：只走幹道
  };
  const r = spSearch(s0, e0, fn2, hf || true);
  if (r) { r.approx = true; return r; }
  return spSearch(s0, e0, fn, true);
}

// Label Setting（Martins）：準則 = [距離, 不適宜長度, YouBike 缺口長度]；ε-支配 + 每節點標籤上限 + 距離上界，避免標籤爆炸

export function labelSetting(s0, e0, fn, o) {
  const ra = ensureRA(), useUb = !!(State.UB && State.UB.x), base = spSearch(s0, e0, fn, o.hf || true); if (!base) return [];
  const h0 = o.h0 || (v => heuristic(v, e0)), limit = (o.crit ? base.cost : base.distance) * o.bound,   // o.crit：自訂準則（第 0 項須與 fn 同單位，例如秒）；預設＝距離×不適宜×YouBike
   critOf = o.crit || (k => { const len = State.adjW[k]; return [len, len * (1 - ra.suit[k] / 100), useUb ? len * (1 - edgeCov(k, 'ub') / 3) : 0]; }),
   LAB = [], at = new Map(), tgt = [], pq = new MinHeap(); let pops = 0;
  const dom = (a, b, e) => a[0] <= b[0] * (1 + e) + 1e-9 && a[1] <= b[1] * (1 + e) + 1e-9 && a[2] <= b[2] * (1 + e) + 1e-9;
  const add = (v, c, par, k) => {
    if (c[0] + h0(v) > limit) return;
    for (const t of tgt) if (!LAB[t].dead && dom(LAB[t].c, c, 0)) return;
    let arr = at.get(v); if (!arr) at.set(v, arr = []);
    for (const id of arr) if (!LAB[id].dead && dom(LAB[id].c, c, o.eps)) return;
    for (const id of arr) if (!LAB[id].dead && dom(c, LAB[id].c, 0)) LAB[id].dead = true;
    const live = arr.filter(id => !LAB[id].dead); if (live.length >= o.maxLab) return;
    const id = LAB.push({ v, c, par, k, dead: false }) - 1; arr.length = 0; arr.push(...live, id); pq.push(c[0], id); if (v === e0) tgt.push(id);
  };
  add(s0, [0, 0, 0], -1, -1);
  while (pq.size && pops++ < 400000) {
    const id = pq.pop()[1], L = LAB[id]; if (L.dead || L.v === e0) continue;
    for (let k = State.adjOffset[L.v]; k < State.adjOffset[L.v+1]; k++) {
      if (fn(State.adjEid[k], State.adjW[k], k) === Infinity) continue;
      const ci = critOf(k); add(State.adjTo[k], [L.c[0] + ci[0], L.c[1] + ci[1], L.c[2] + ci[2]], id, k);
    }
  }
  const out = [];
  for (const id of tgt) {
    if (LAB[id].dead) continue;
    const edgePath = []; for (let l = id; LAB[l].par >= 0; l = LAB[l].par) edgePath.push(LAB[l].k); edgePath.reverse();
    const path = [s0]; for (const k of edgePath) path.push(State.adjTo[k]);
    const r = packRoute(path, edgePath, LAB[id].c[0]); r.crit = LAB[id].c; out.push(r);
  }
  out.sort((a, b) => a.crit[0] - b.crit[0]);
  const kept = [];                                                  // 先保留各準則的極值解，再用「與已選不太重疊」的解補滿到 6 條
  for (let d = 0; d < 3; d++) { const m = out.reduce((a, r) => r.crit[d] < a.crit[d] - 1e-9 ? r : a, out[0]); if (m && !kept.includes(m)) kept.push(m); }
  for (const r of out) if (kept.length < 6 && !kept.includes(r) && kept.every(x => overlapRatio(x, r) <= 0.9)) kept.push(r);
  kept.sort((a, b) => a.crit[0] - b.crit[0]);
  kept.pops = pops; return kept;
}
