// router.js
import { State } from './state.js';
import { COS30 } from './constants.js';
import { isGeo, nodeDist } from './geo.js';
import { MinHeap } from './heap.js';
import { ensureFrom } from './graph-core.js';

export function dijkstra(startIdx, endIdx, weightFn) {   // weightFn(edgeId, defaultW) → 數字；可回 Infinity 表示禁行
  const dist = new Float64Array(State.N).fill(Infinity);
  const prev = new Int32Array(State.N).fill(-1);
  const prevEdge = new Int32Array(State.N).fill(-1);
  dist[startIdx] = 0;
  const pq = new MinHeap();
  pq.push(0, startIdx);
  while (pq.size > 0) {
    const [d, u] = pq.pop();
    if (u === endIdx) break;
    if (d > dist[u]) continue;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k];
      const nd = d + (weightFn ? weightFn(State.adjEid[k], State.adjW[k], k) : State.adjW[k]);
      if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevEdge[v] = k; pq.push(nd, v); }
    }
  }
  if (!isFinite(dist[endIdx])) return null;
  const path = [], edgePath = [];
  let cur = endIdx;
  while (cur !== -1) {
    path.push(cur);
    if (prevEdge[cur] >= 0) edgePath.push(prevEdge[cur]);
    cur = prev[cur];
  }
  path.reverse(); edgePath.reverse();
  let len = 0; for (const k of edgePath) len += State.adjW[k];      // 實際長度（不受權重函式影響）
  return { distance: len, cost: dist[endIdx], path, edgePath,
           coords: path.map(i => [State.nodeXY[i*5+2], State.nodeXY[i*5+3]]) };
}

// 座標單位未必等於權重單位（例如座標是 cm、權重是 m），所以用全圖 min(w / 幾何距離) 校準，保證不高估

export function calibrateHeuristic() {
  let m = Infinity;
  for (let u = 0; u < State.N; u++) {
    if (State.nodeXY[u*5+2] === 0 && State.nodeXY[u*5+3] === 0) continue;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k];
      if (v < u || (State.nodeXY[v*5+2] === 0 && State.nodeXY[v*5+3] === 0)) continue;
      const d = nodeDist(u, v);
      if (d > 0) { const r = State.adjW[k] / d; if (r < m) m = r; }
    }
  }
  State.hScale = isFinite(m) ? m : 0;
  console.info(`ℹ 啟發校準 hScale = ${State.hScale}（權重/座標單位下界）`);
}

export function heuristic(nodeIdx, targetIdx) {
  if (State.hScale === null) calibrateHeuristic();
  return 0.9 * State.hScale * nodeDist(nodeIdx, targetIdx);
}

export function packRoute(path, edgePath, cost) {
  let len = 0; for (const k of edgePath) len += State.adjW[k];
  return { distance: len, cost, path, edgePath, coords: path.map(i => [State.nodeXY[i*5+2], State.nodeXY[i*5+3]]) };
}

export function astar(startIdx, endIdx, weightFn) {      // weightFn 只能「加大」權重（如避開=Infinity），啟發才仍成立
  if (State.hScale === null) calibrateHeuristic();
  const g = new Float64Array(State.N).fill(Infinity), prev = new Int32Array(State.N).fill(-1), pe = new Int32Array(State.N).fill(-1);
  const closed = new Uint8Array(State.N);
  g[startIdx] = 0;
  const pq = new MinHeap(); pq.push(heuristic(startIdx, endIdx), startIdx);
  while (pq.size > 0) {
    const u = pq.pop()[1];
    if (closed[u]) continue;
    closed[u] = 1;
    if (u === endIdx) break;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k]; if (closed[v]) continue;
      const ng = g[u] + (weightFn ? weightFn(State.adjEid[k], State.adjW[k], k) : State.adjW[k]);
      if (ng < g[v]) { g[v] = ng; prev[v] = u; pe[v] = k; pq.push(ng + heuristic(v, endIdx), v); }
    }
  }
  if (!isFinite(g[endIdx])) return null;
  const path = [], edgePath = [];
  for (let c = endIdx; c !== -1; c = prev[c]) { path.push(c); if (pe[c] >= 0) edgePath.push(pe[c]); }
  return packRoute(path.reverse(), edgePath.reverse(), g[endIdx]);
}

export function reverseEdge(k, u, v) {                    // k 為 u→v 的鄰接邊；找 v→u 的那一條
  for (let j = State.adjOffset[v]; j < State.adjOffset[v+1]; j++)
    if (State.adjTo[j] === u && State.adjEid[j] === State.adjEid[k] && State.adjW[j] === State.adjW[k]) return j;
  return k;
}

export function bidirectionalDijkstra(startIdx, endIdx, weightFn) {
  if (startIdx === endIdx) return packRoute([startIdx], [], 0);
  const mk = () => ({ d: new Float64Array(State.N).fill(Infinity), prev: new Int32Array(State.N).fill(-1),
                      pe: new Int32Array(State.N).fill(-1), done: new Uint8Array(State.N), pq: new MinHeap() });
  const F = mk(), B = mk();
  F.d[startIdx] = 0; F.pq.push(0, startIdx); B.d[endIdx] = 0; B.pq.push(0, endIdx);
  let best = Infinity, meet = -1;
  while (F.pq.size > 0 && B.pq.size > 0) {
    if (F.pq.top() + B.pq.top() >= best) break;        // 標準終止條件（比 min(topf,topb)≥best 更早且同樣正確）
    const S = F.pq.top() <= B.pq.top() ? F : B, O = S === F ? B : F;   // 擴展頂端較小的一側
    const [d, u] = S.pq.pop();
    if (S.done[u] || d > S.d[u]) continue;
    S.done[u] = 1;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k], nd = d + (weightFn ? weightFn(State.adjEid[k], State.adjW[k], k) : State.adjW[k]);
      if (nd < S.d[v]) {
        S.d[v] = nd; S.prev[v] = u; S.pe[v] = k; S.pq.push(nd, v);
        if (O.d[v] < Infinity && nd + O.d[v] < best) { best = nd + O.d[v]; meet = v; }   // 雙邊相遇 → 候選最短路
      }
    }
  }
  if (meet < 0) return null;
  const path = [], edgePath = [];
  for (let c = meet; c !== -1; c = F.prev[c]) { path.push(c); if (F.pe[c] >= 0) edgePath.push(F.pe[c]); }
  path.reverse(); edgePath.reverse();
  for (let c = meet; c !== endIdx; ) { const u = B.prev[c]; edgePath.push(reverseEdge(B.pe[c], u, c)); path.push(u); c = u; }
  return packRoute(path, edgePath, best);
}

// Console 手動執行：對比三種演算法

export function compareRouters(s0, e0) {
  const rows = {};
  for (const [name, f] of [['dijkstra', dijkstra], ['astar', astar], ['bidir', bidirectionalDijkstra]]) {
    const t = performance.now(), r = f(s0, e0);
    rows[name] = { ms: +(performance.now() - t).toFixed(1), distance: r ? r.distance : null };
  }
  console.table(rows);
  const ds = Object.values(rows).map(r => r.distance);
  if (ds.some(d => d === null || Math.abs(d - ds[0]) > 1e-6)) console.warn('⚠ 三種演算法距離不一致', rows);
}

// 以「有向邊」為狀態的 Dijkstra：轉彎（夾角>30°）加罰 pen（與權重同單位）；不原路折返

export function dijkstraTurns(s0, e0, fn, pen) {
  if (s0 === e0) return packRoute([s0], [], 0);
  const from = ensureFrom(), m = State.adjTo.length, dist = new Float64Array(m).fill(Infinity), prev = new Int32Array(m).fill(-1), pq = new MinHeap();
  const kx = isGeo() ? Math.cos(State.nodeXY[s0*5+3] * Math.PI/180) : 1;
  for (let k = State.adjOffset[s0]; k < State.adjOffset[s0+1]; k++) { const c = fn(State.adjEid[k], State.adjW[k], k); if (c < dist[k]) { dist[k] = c; pq.push(c, k); } }
  let endK = -1;
  while (pq.size) {
    const [d, k] = pq.pop(); if (d > dist[k]) continue;
    const u = from[k], v = State.adjTo[k];
    if (v === e0) { endK = k; break; }
    const ax = (State.nodeXY[v*5+2]-State.nodeXY[u*5+2])*kx, ay = State.nodeXY[v*5+3]-State.nodeXY[u*5+3], al = Math.hypot(ax, ay);
    for (let k2 = State.adjOffset[v]; k2 < State.adjOffset[v+1]; k2++) {
      const w = State.adjTo[k2]; if (w === u) continue;
      const bx = (State.nodeXY[w*5+2]-State.nodeXY[v*5+2])*kx, by = State.nodeXY[w*5+3]-State.nodeXY[v*5+3], bl = Math.hypot(bx, by);
      const nd = d + fn(State.adjEid[k2], State.adjW[k2], k2) + (al > 0 && bl > 0 && ax*bx + ay*by < COS30*al*bl ? pen : 0);
      if (nd < dist[k2]) { dist[k2] = nd; prev[k2] = k; pq.push(nd, k2); }
    }
  }
  if (endK < 0) return null;
  const edgePath = []; for (let k = endK; k >= 0; k = prev[k]) edgePath.push(k); edgePath.reverse();
  const path = [s0]; for (const k of edgePath) path.push(State.adjTo[k]);
  return packRoute(path, edgePath, dist[endK]);
}

export function spSearch(s0, t0, fn, useH) {                // 世代戳記的 A*：不必為每次搜尋配置 N 大小的陣列（Yen 要做上百次局部搜尋）
  if (s0 === t0) return packRoute([s0], [], 0);
  if (useH === true && State.hScale === null) calibrateHeuristic();
  if (!State.SCH || State.SCH.n !== State.N) State.SCH = { n: State.N, gen: 0, st: new Uint32Array(State.N), cl: new Uint32Array(State.N), g: new Float64Array(State.N), p: new Int32Array(State.N), pe: new Int32Array(State.N) };
  const gen = ++State.SCH.gen, { st, cl, g, p, pe } = State.SCH, pq = new MinHeap(), h = typeof useH === 'function' ? useH : useH ? v => heuristic(v, t0) : () => 0;   // useH 也可以是自訂啟發函式（廣義成本用）
  let expanded = 0;
  st[s0] = gen; g[s0] = 0; p[s0] = -1; pe[s0] = -1; pq.push(h(s0), s0);
  while (pq.size) {
    const u = pq.pop()[1]; if (cl[u] === gen) continue; cl[u] = gen; expanded++; if (u === t0) break;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k]; if (cl[v] === gen) continue;
      const c = fn ? fn(State.adjEid[k], State.adjW[k], k) : State.adjW[k]; if (c === Infinity) continue;
      const ng = g[u] + c;
      if (st[v] !== gen || ng < g[v]) { st[v] = gen; g[v] = ng; p[v] = u; pe[v] = k; pq.push(ng + h(v), v); }
    }
  }
  State.lastExpanded = expanded;
  if (cl[t0] !== gen) return null;
  const path = [], edgePath = []; for (let c = t0; c !== -1; c = p[c]) { path.push(c); if (pe[c] >= 0) edgePath.push(pe[c]); }
  return packRoute(path.reverse(), edgePath.reverse(), g[t0]);
}

export function overlapRatio(a, b) {                        // 以邊長度計的共用比例（相對於較短的那條）
  const ids = new Set(a.edgePath.map(k => State.adjEid[k])); let sh = 0, la = 0, lb = 0;
  for (const k of a.edgePath) la += State.adjW[k];
  for (const k of b.edgePath) { lb += State.adjW[k]; if (ids.has(State.adjEid[k])) sh += State.adjW[k]; }
  return sh / Math.max(1e-9, Math.min(la, lb));
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  window.benchRouters = () => compareRouters(State.fromPoint.idx, State.toPoint.idx);
}

// ---- ALT（地標＋三角不等式）：預先算好少數地標到所有節點的「成本」，A* 的下界 = max |c(L,t) − c(L,v)| ----
// 地標必須用「和查詢相同的成本函式」計算（例如車種＋偏好）：只用距離建地標、再乘上最快車速的每公尺成本，下界太鬆，完全沒有加速效果
function distAll(s0, fn) {
  const N = State.N, d = new Float64Array(N).fill(Infinity), pq = new MinHeap(); d[s0] = 0; pq.push(0, s0);   // 搜尋用 Float64：若用 Float32，舍入後的值會小於佇列裡的鍵，被誤判為過期而提前結束
  while (pq.size) {
    const [dd, u] = pq.pop(); if (dd > d[u]) continue;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const c = fn(State.adjEid[k], State.adjW[k], k); if (c === Infinity) continue;
      const v = State.adjTo[k], nd = dd + c; if (nd < d[v]) { d[v] = nd; pq.push(nd, v); }
    }
  }
  return Float32Array.from(d);                                          // 儲存用 Float32 省一半記憶體
}
export function buildLandmarks(key, fn, L = 8) {          // 成本對稱（兩個方向相同）時成立；若查詢再額外禁行更多道路，真實成本只會更大，下界仍然成立
  // 多組快取：「比較」模式一次會用 3 種成本（最短／最快／依偏好），只存一組會每次查詢都重建（實測慢 6 倍）
  const C = State.altCache || (State.altCache = new Map()), A = C.get(key);
  if (A && A.n === State.N && A.w === State.adjW && A.ver === State.graphVersion) { C.delete(key); C.set(key, A); State.alt = A; return A; }
  const t0 = performance.now(), N = State.N, lm = [], ds = [], minD = new Float32Array(N).fill(Infinity);
  let start = 0; while (start < N && State.adjOffset[start+1] === State.adjOffset[start]) start++;
  const d0 = distAll(start, fn); let far = start; for (let i = 0; i < N; i++) if (isFinite(d0[i]) && d0[i] > d0[far]) far = i;      // 第一個地標：離任意點最遠的節點
  for (let l = 0; l < L && far >= 0; l++) {
    const dl = distAll(far, fn); lm.push(far); ds.push(dl);
    let nxt = -1, best = -1; for (let i = 0; i < N; i++) { if (dl[i] < minD[i]) minD[i] = dl[i]; if (isFinite(minD[i]) && minD[i] > best) { best = minD[i]; nxt = i; } }   // 之後每個地標：離已選地標最遠
    far = nxt;
  }
  State.alt = { key, n: N, w: State.adjW, ver: State.graphVersion, lm, ds, ms: performance.now() - t0 };
  C.set(key, State.alt); while (C.size > (State.altMax || 4)) C.delete(C.keys().next().value);       // 每組約 N×8×4 bytes（140 萬節點 ≈ 45 MB）
  console.info(`ℹ ALT 地標預處理（${key}）：${lm.length} 個地標，${Math.round(State.alt.ms)} ms，${(lm.length * N * 4 / 1048576).toFixed(0)} MB`);
  return State.alt;
}
// 廣義成本的啟發函式：max(mper × 歐氏距離下界, ALT 成本下界)；兩者都不高估
export function makeHeuristic(t0, mper, alt) {
  if (State.hScale === null) calibrateHeuristic();
  const hs = State.hScale;
  return v => {
    let b = mper * hs * nodeDist(v, t0);
    if (alt) for (const dl of alt.ds) { const x = dl[t0], y = dl[v]; if (x !== Infinity && y !== Infinity) { const z = (x > y ? x - y : y - x) * (1 - 1e-6); if (z > b) b = z; } }   // 留 1e-6 安全餘量：Float32 舍入不可使下界高估
    return b;
  };
}
