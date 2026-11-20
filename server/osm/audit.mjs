// audit.mjs — RoadGraphValidator：全台 OSM 道路圖的品質稽核（拓樸、幾何、各運具連通性、跨縣市可達性）
//
// 與 validate.mjs（建圖時的基本報告）互補，這裡做比較重的檢查，給 tools/osm/osm-audit.mjs 使用：
//  ① 拓樸：重複邊（同兩端點、幾何相同）／平行邊（同兩端點、幾何不同，通常正常）、長度為 0、自我迴圈、
//     未合併的重複節點（座標完全相同但 OSM node 不同）、道路端點離另一條路 ≤ 3 m 卻沒相接（undershoot）
//  ② 幾何：不合理的長度（依道路類別）、單一線段過長（可能缺 node）、折返尖刺（spike）
//  ③ 交叉：兩條道路幾何上相交但沒有共用 node 時，分成
//       ・立體交叉（不同高度層，或任一條是橋／隧道）→ 正常，不相連是對的
//       ・同一高度、都是車道 → 疑似漏接路口（資料可能有誤）
//       ・同一高度、其中一條是人行道／小徑／自行車道 → 疑似缺穿越點（行人模式可能繞路）
//  ④ 各運具（有向與無向分開）：可用頂點／邊、弱連通分量（無向）、強連通分量（有向）、最大分量比例、
//     孤立頂點、只因方向性受限的頂點（在最大弱連通區內，但進得去出不來／出得來進不去——多半是單行、出口車道，不一定是錯誤）、
//     無法連通的區域（不含渡輪時的島嶼與本島內的孤立區塊，附範圍）
//  ⑤ 跨縣市：各縣市代表點之間實際用路由器規劃（真實資料測試）
// 全部是唯讀計算，不修改圖。
import { PROFILES, access4 } from './access.mjs';
import { HIGHWAYS } from './tags.mjs';
import { distE7 } from './grow.mjs';
import { compileCondition } from './conditional.mjs';

const PATHISH = new Set(['footway', 'path', 'cycleway', 'steps', 'corridor', 'bridleway', 'pedestrian']);
const NONROAD = new Set(['ferry', 'pier_link']);
// 「不合理長度」門檻（公尺）：一條邊（兩個路口之間）長於這個值就列出。國道、快速公路、山區產業道路可以很長，門檻放寬
const LONG_EDGE_M = { motorway: 40000, trunk: 30000, primary: 25000, secondary: 25000, tertiary: 20000, unclassified: 20000, track: 15000, path: 15000, footway: 8000, residential: 5000, living_street: 2000, service: 5000, steps: 500, corridor: 1000, default: 15000 };
const GAP_M = 2000;                     // 一段幾何（兩個連續 node）超過 2 km：多半是缺 node、或畫錯
const SPIKE_DEG = 170, SPIKE_MIN_M = 15; // 折返角 > 170°、兩段都 ≥ 15 m：尖刺
const UNDERSHOOT_M = 3;                 // 死路端點離別條同高度道路 ≤ 3 m 卻沒接上

// 已知的離島範圍（判斷「不連通區域」是島嶼還是本島內的孤立區塊；範圍是粗略的方框，只用來命名）
export const ISLANDS = [
  ['澎湖', 119.30, 23.15, 119.75, 23.80], ['金門', 118.13, 24.36, 118.52, 24.53], ['馬祖（連江）', 119.88, 25.93, 120.53, 26.40], ['綠島', 121.45, 22.63, 121.52, 22.70],
  ['蘭嶼', 121.48, 21.98, 121.62, 22.10], ['小琉球', 120.35, 22.32, 120.40, 22.37], ['龜山島', 121.94, 24.83, 121.97, 24.85], ['烏坵', 119.43, 24.97, 119.48, 25.01],
  ['東沙', 116.68, 20.67, 116.76, 20.74], ['太平島', 114.35, 10.36, 114.38, 10.39], ['基隆嶼／北方三島', 121.75, 25.18, 122.12, 25.65]
];
export const regionOf = (lon, lat) => { for (const [n, a, b, c, d] of ISLANDS) if (lon >= a && lon <= c && lat >= b && lat <= d) return n; return lon > 119.9 && lon < 122.1 && lat > 21.85 && lat < 25.35 ? '台灣本島' : '其他（海外／遠洋）'; };

// 縣市代表點（車站或縣市政府附近，WGS84；只用來測試跨縣市可達性，路由器會吸附到最近的道路）
export const COUNTY_POINTS = {
  基隆市: [25.1319, 121.7400], 臺北市: [25.0478, 121.5170], 新北市: [25.0120, 121.4650], 桃園市: [24.9894, 121.3133], 新竹縣: [24.8270, 121.0130], 新竹市: [24.8016, 120.9715],
  苗栗縣: [24.5703, 120.8225], 臺中市: [24.1370, 120.6865], 彰化縣: [24.0818, 120.5386], 南投縣: [23.9020, 120.6904], 雲林縣: [23.7116, 120.5414], 嘉義縣: [23.4590, 120.3330],
  嘉義市: [23.4792, 120.4410], 臺南市: [22.9971, 120.2128], 高雄市: [22.6394, 120.3025], 屏東縣: [22.6693, 120.4862], 臺東縣: [22.7936, 121.1231], 花蓮縣: [23.9930, 121.6013],
  宜蘭縣: [24.7547, 121.7581], 澎湖縣: [23.5650, 119.5790], 金門縣: [24.4330, 118.3180], 連江縣: [26.1600, 119.9500]
};
// 相鄰縣市（本島）＋幾條長距離；離島的預期：澎湖有渡輪（汽車只有標明可載車的航線），金門、馬祖從本島沒有陸路
export const COUNTY_PAIRS = [
  ['基隆市', '臺北市'], ['臺北市', '新北市'], ['新北市', '桃園市'], ['桃園市', '新竹縣'], ['新竹縣', '新竹市'], ['新竹市', '苗栗縣'], ['苗栗縣', '臺中市'], ['臺中市', '彰化縣'],
  ['臺中市', '南投縣'], ['彰化縣', '雲林縣'], ['南投縣', '雲林縣'], ['雲林縣', '嘉義縣'], ['嘉義縣', '嘉義市'], ['嘉義縣', '臺南市'], ['臺南市', '高雄市'], ['高雄市', '屏東縣'],
  ['屏東縣', '臺東縣'], ['臺東縣', '花蓮縣'], ['花蓮縣', '宜蘭縣'], ['宜蘭縣', '新北市'], ['臺北市', '高雄市'], ['臺北市', '臺東縣'], ['臺中市', '澎湖縣'], ['臺北市', '金門縣'], ['臺北市', '連江縣']
];

const r4 = x => Math.round(x * 1e4) / 1e4;

// ---------- ① ② ③ 拓樸與幾何 ----------
export function auditTopology(g, router, { log = () => {}, sampleN = 20 } = {}) {
  const { V, E, W, G } = g, NG = G.lat.length, hwOf = e => HIGHWAYS[W.hw[E.way[e]]];
  const out = { edges: E.n, vertices: V.n, ways: W.n, geometryPoints: NG };
  const sample = (arr, x) => { if (arr.length < sampleN) arr.push(x); };
  // 點 → 邊
  const pe = new Int32Array(NG); for (let e = 0; e < E.n; e++) for (let k = E.goff[e]; k < E.goff[e + 1]; k++) pe[k] = e;
  const deg = new Int32Array(V.n); for (let e = 0; e < E.n; e++) { deg[E.u[e]]++; deg[E.v[e]]++; }

  // 長度為 0、自我迴圈、不合理長度、過長的單一線段、尖刺
  const z = { zeroLength: 0, zeroSamples: [], selfLoops: 0, selfLoopLegit: 0, selfLoopSamples: [], longEdges: 0, longSamples: [], gaps: 0, gapSamples: [], spikes: 0, spikeSamples: [], dupPoints: 0 };
  for (let e = 0; e < E.n; e++) {
    const hw = hwOf(e), L = E.len[e], w = E.way[e];
    if (L < 0.05) { z.zeroLength++; sample(z.zeroSamples, { way: W.id[w], highway: hw }); }
    if (E.u[e] === E.v[e]) { z.selfLoops++; if (L >= 20) z.selfLoopLegit++; else sample(z.selfLoopSamples, { way: W.id[w], highway: hw, m: +L.toFixed(1) }); }
    if (!NONROAD.has(hw) && L > (LONG_EDGE_M[hw] ?? LONG_EDGE_M.default)) { z.longEdges++; sample(z.longSamples, { way: W.id[w], highway: hw, km: +(L / 1000).toFixed(1), name: router.wayName(w) }); }
    const g0 = E.goff[e], g1 = E.goff[e + 1];
    for (let k = g0; k + 1 < g1; k++) {
      const d = distE7(G.lat[k], G.lon[k], G.lat[k + 1], G.lon[k + 1]);
      if (d === 0) z.dupPoints++;
      if (d > GAP_M && !NONROAD.has(hw)) { z.gaps++; sample(z.gapSamples, { way: W.id[w], highway: hw, m: Math.round(d), at: [G.lat[k] / 1e7, G.lon[k] / 1e7].map(r4) }); }
      if (k + 2 < g1) {
        const d2 = distE7(G.lat[k + 1], G.lon[k + 1], G.lat[k + 2], G.lon[k + 2]); if (d < SPIKE_MIN_M || d2 < SPIKE_MIN_M) continue;
        const kx = Math.cos(G.lat[k + 1] * 1e-7 * Math.PI / 180), ax = (G.lon[k + 1] - G.lon[k]) * kx, ay = G.lat[k + 1] - G.lat[k], bx = (G.lon[k + 2] - G.lon[k + 1]) * kx, by = G.lat[k + 2] - G.lat[k + 1];
        const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
        // 行進方向轉了 > 170°：幾乎原路折返
        if (Math.acos(Math.max(-1, Math.min(1, c))) * 180 / Math.PI > SPIKE_DEG) { z.spikes++; sample(z.spikeSamples, { way: W.id[w], highway: hw, node: G.node[k + 1], at: [G.lat[k + 1] / 1e7, G.lon[k + 1] / 1e7].map(r4) }); }
      }
    }
  }
  out.geometry = z;
  log(`  幾何：長度 0 的邊 ${z.zeroLength}、自我迴圈 ${z.selfLoops}、過長邊 ${z.longEdges}、過長線段 ${z.gaps}、尖刺 ${z.spikes}`);

  // 重複邊／平行邊：同一對端點（不分方向）
  const keyOf = e => { const a = E.u[e], b = E.v[e]; return a < b ? a * 2097152 + b : b * 2097152 + a; };
  const idx = Int32Array.from({ length: E.n }, (_, i) => i).sort((x, y) => keyOf(x) - keyOf(y));
  const dup = { duplicateEdges: 0, duplicateSameWay: 0, parallelEdges: 0, samples: [] };
  const sameGeom = (e, f) => {
    const a0 = E.goff[e], a1 = E.goff[e + 1], b0 = E.goff[f], b1 = E.goff[f + 1]; if (a1 - a0 !== b1 - b0) return false;
    let fw = true, bw = true; for (let i = 0; i < a1 - a0; i++) { if (G.node[a0 + i] !== G.node[b0 + i]) fw = false; if (G.node[a0 + i] !== G.node[b1 - 1 - i]) bw = false; if (!fw && !bw) return false; }
    return true;
  };
  for (let i = 0; i < idx.length;) {
    let j = i + 1; const k = keyOf(idx[i]); while (j < idx.length && keyOf(idx[j]) === k) j++;
    if (j - i > 1 && E.u[idx[i]] !== E.v[idx[i]]) {
      for (let a = i; a < j; a++) for (let b = a + 1; b < j; b++) {
        const e = idx[a], f = idx[b];
        if (sameGeom(e, f)) { dup.duplicateEdges++; if (E.way[e] === E.way[f]) dup.duplicateSameWay++; sample(dup.samples, { ways: [W.id[E.way[e]], W.id[E.way[f]]], highway: [hwOf(e), hwOf(f)] }); }
        else dup.parallelEdges++;
      }
    }
    i = j;
  }
  out.duplicates = dup;
  log(`  重複邊 ${dup.duplicateEdges}（同一條 way ${dup.duplicateSameWay}）、平行邊（幾何不同，通常正常）${dup.parallelEdges}`);

  // 未合併的重複節點：不同 OSM node、座標完全相同、同一高度層（只看頂點與幾何點；不同高度層的重疊是正常的）
  {
    const same = (a, b) => G.lat[a] === G.lat[b] && G.lon[a] === G.lon[b];                    // 兩個鍵分開比較（打包成一個數字會超過 2^53 失真）
    const ord = Int32Array.from({ length: NG }, (_, i) => i).sort((a, b) => G.lat[a] - G.lat[b] || G.lon[a] - G.lon[b]);
    let pairs = 0, sameLevel = 0, endpoints = 0; const s = [], isEnd = k => k === E.goff[pe[k]] || k === E.goff[pe[k] + 1] - 1;
    for (let i = 0; i < NG;) {
      let j = i + 1; while (j < NG && same(ord[j], ord[i])) j++;
      if (j - i > 1) {
        const ids = new Map(); for (let t = i; t < j; t++) { const k = ord[t], id = G.node[k]; if (!ids.has(id)) ids.set(id, W.level[E.way[pe[k]]]); }
        if (ids.size > 1) { pairs++; const lv = [...ids.values()]; if (lv.some((x, q) => lv.indexOf(x) !== q)) { sameLevel++; let ne = 0; const seenN = new Set(); for (let t = i; t < j; t++) { const k = ord[t]; if (isEnd(k) && !seenN.has(G.node[k])) { seenN.add(G.node[k]); ne++; } } if (ne >= 2) endpoints++; if (s.length < sampleN) s.push({ nodes: [...ids.keys()].slice(0, 4), at: [G.lat[ord[i]] / 1e7, G.lon[ord[i]] / 1e7].map(r4) }); } }
      }
      i = j;
    }
    out.coincidentNodes = { locations: pairs, sameLevel, endpointBoth: endpoints, samples: s };
    log(`  座標相同但 node 不同的位置 ${pairs}（同高度層 ${sameLevel}：疑似未合併）`);
  }

  // ③ 交叉＋undershoot：線段格網（約 110 m），(格子, 線段) 打包成一個數字排序
  const C = 10000, segOk = k => k + 1 < NG && pe[k] === pe[k + 1];
  // 格子編號以資料本身的範圍為原點：(格子 × 2^24 + 線段) 必須 < 2^53 才能精確（用全球原點會超過，打包的數字失真）
  let cnt = 0, lat0 = Infinity, lon0 = Infinity, lat1 = -Infinity, lon1 = -Infinity;
  for (let k = 0; k < NG; k++) { if (G.lat[k] < lat0) lat0 = G.lat[k]; if (G.lat[k] > lat1) lat1 = G.lat[k]; if (G.lon[k] < lon0) lon0 = G.lon[k]; if (G.lon[k] > lon1) lon1 = G.lon[k]; }
  lat0 -= 2 * C; lon0 -= 2 * C; const NX = Math.floor((lon1 - lon0) / C) + 3, NY = Math.floor((lat1 - lat0) / C) + 3;
  if (NX * NY * 2 ** 24 >= 2 ** 53) throw new Error('範圍太大，格網打包會失去精度');
  const cellOf = (la, lo) => Math.floor((la - lat0) / C) * NX + Math.floor((lo - lon0) / C);
  for (let k = 0; k < NG; k++) if (segOk(k)) { const a = Math.floor((Math.min(G.lat[k], G.lat[k + 1]) - lat0) / C), b = Math.floor((Math.max(G.lat[k], G.lat[k + 1]) - lat0) / C), c = Math.floor((Math.min(G.lon[k], G.lon[k + 1]) - lon0) / C), d = Math.floor((Math.max(G.lon[k], G.lon[k + 1]) - lon0) / C); cnt += (b - a + 1) * (d - c + 1); }
  const pack = new Float64Array(cnt); let p = 0; const SEG = 2 ** 24;
  for (let k = 0; k < NG; k++) if (segOk(k)) {
    const a = Math.floor((Math.min(G.lat[k], G.lat[k + 1]) - lat0) / C), b = Math.floor((Math.max(G.lat[k], G.lat[k + 1]) - lat0) / C), c = Math.floor((Math.min(G.lon[k], G.lon[k + 1]) - lon0) / C), d = Math.floor((Math.max(G.lon[k], G.lon[k + 1]) - lon0) / C);
    for (let y = a; y <= b; y++) for (let x = c; x <= d; x++) pack[p++] = (y * NX + x) * SEG + k;
  }
  if (NG >= SEG) throw new Error('幾何點太多（超過 2^24），格網打包需要調整');
  pack.sort();
  log(`  交叉檢查：${p.toLocaleString()} 筆（格子, 線段）`);
  const X = { gradeSeparated: 0, suspectedMissingJunction: 0, pathCrossingNoNode: 0, overlapping: 0, missingByPair: {}, pathByPair: {}, samplesMissing: [], samplesPath: [], samplesOverlap: [] };
  const kxAt = Math.cos(23.7 * Math.PI / 180);
  const levelOf = e => W.level[E.way[e]], bt = e => W.bridge[E.way[e]] || W.tunnel[E.way[e]];
  for (let i = 0; i < p;) {
    const cell = Math.floor(pack[i] / SEG); let j = i + 1; while (j < p && Math.floor(pack[j] / SEG) === cell) j++;
    for (let a = i; a < j; a++) {
      const k = pack[a] - cell * SEG, e = pe[k], he = hwOf(e); if (NONROAD.has(he)) continue;
      const ax = G.lon[k] * kxAt, ay = G.lat[k], bx = G.lon[k + 1] * kxAt, by = G.lat[k + 1];
      for (let b = a + 1; b < j; b++) {
        const m = pack[b] - cell * SEG, f = pe[m]; if (e === f && Math.abs(k - m) <= 1) continue;
        const hf = hwOf(f); if (NONROAD.has(hf)) continue;
        const n1 = G.node[k], n2 = G.node[k + 1], n3 = G.node[m], n4 = G.node[m + 1];
        if (n1 === n3 || n1 === n4 || n2 === n3 || n2 === n4) continue;           // 共用 node：真正的路口
        const cx = G.lon[m] * kxAt, cy = G.lat[m], dx = G.lon[m + 1] * kxAt, dy = G.lat[m + 1];
        const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx), d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        if (d1 === 0 && d2 === 0) {                                                // 共線：檢查是否重疊（重複畫線）
          const L = Math.hypot(bx - ax, by - ay); if (!L) continue;
          const t1 = ((cx - ax) * (bx - ax) + (cy - ay) * (by - ay)) / (L * L), t2 = ((dx - ax) * (bx - ax) + (dy - ay) * (by - ay)) / (L * L);
          const ov = Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2));
          if (ov * L > 50 && levelOf(e) === levelOf(f)) { const mx = (ax + bx) / 2, my = (ay + by) / 2; if (cellOf(my, mx / kxAt) !== cell) continue; X.overlapping++; sample(X.samplesOverlap, { ways: [W.id[E.way[e]], W.id[E.way[f]]], at: [my / 1e7, mx / kxAt / 1e7].map(r4) }); }
          continue;
        }
        if ((d1 > 0) === (d2 > 0) || (d3 > 0) === (d4 > 0) || d1 === 0 || d2 === 0 || d3 === 0 || d4 === 0) continue;   // 沒有真正交叉（端點剛好碰到另一條線的不算，交給 undershoot）
        const t = d1 / (d1 - d2), ix = ax + (bx - ax) * t, iy = ay + (by - ay) * t;
        if (cellOf(iy, ix / kxAt) !== cell) continue;                            // 同一個交點只在它所在的格子算一次
        const at = [iy / 1e7, ix / kxAt / 1e7].map(r4);
        if (levelOf(e) !== levelOf(f) || bt(e) || bt(f)) X.gradeSeparated++;
        else if (PATHISH.has(he) || PATHISH.has(hf)) { X.pathCrossingNoNode++; const pk = [he, hf].sort().join('×'); X.pathByPair[pk] = (X.pathByPair[pk] || 0) + 1; sample(X.samplesPath, { ways: [W.id[E.way[e]], W.id[E.way[f]]], highway: [he, hf], at }); }
        else { X.suspectedMissingJunction++; const pk = [he, hf].sort().join('×'); X.missingByPair[pk] = (X.missingByPair[pk] || 0) + 1; sample(X.samplesMissing, { ways: [W.id[E.way[e]], W.id[E.way[f]]], highway: [he, hf], names: [router.wayName(E.way[e]), router.wayName(E.way[f])], at }); }
      }
    }
    i = j;
  }
  out.crossings = X;
  log(`  交叉不共用 node：立體交叉 ${X.gradeSeparated}、疑似漏接路口 ${X.suspectedMissingJunction}、人行／小徑缺穿越點 ${X.pathCrossingNoNode}、重疊 ${X.overlapping}`);

  // undershoot：死路端點離別條同高度道路的線段 ≤ 3 m，但沒有接上
  const lowerBound = key => { let lo = 0, hi = p; while (lo < hi) { const m = (lo + hi) >> 1; if (pack[m] < key) lo = m + 1; else hi = m; } return lo; };
  const U = { deadEnds: 0, undershoots: 0, samples: [], byClass: {} };
  for (let v = 0; v < V.n; v++) {
    if (deg[v] !== 1) continue; U.deadEnds++;
    let e0 = -1; for (let k = router.outStart[v]; k < router.outStart[v + 1]; k++) e0 = router.outArc[k] >> 1;
    if (e0 < 0) continue; const hw0 = hwOf(e0); if (NONROAD.has(hw0)) continue;
    const la = V.lat[v], lo = V.lon[v], lv = levelOf(e0), node = V.osm[v], kx = Math.cos(la * 1e-7 * Math.PI / 180);
    const cy = Math.floor((la - lat0) / C), cx = Math.floor((lo - lon0) / C); let best = Infinity, bestE = -1;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      const c = y * NX + x; for (let t = lowerBound(c * SEG); t < p && pack[t] < (c + 1) * SEG; t++) {
        const k = pack[t] - c * SEG, f = pe[k]; if (f === e0 || G.node[k] === node || G.node[k + 1] === node || NONROAD.has(hwOf(f)) || levelOf(f) !== lv) continue;
        const ax = (G.lon[k] - lo) * kx, ay = G.lat[k] - la, bx = (G.lon[k + 1] - lo) * kx, by = G.lat[k + 1] - la, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
        const tt = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + dx * tt, ay + dy * tt) * 0.0111;   // 1e-7 度 ≈ 0.0111 m
        if (d < best) { best = d; bestE = f; }
      }
    }
    if (best <= UNDERSHOOT_M) { U.undershoots++; U.byClass[hw0] = (U.byClass[hw0] || 0) + 1; sample(U.samples, { node, way: W.id[E.way[e0]], highway: hw0, nearWay: W.id[E.way[bestE]], nearHighway: hwOf(bestE), m: +best.toFixed(2), at: [la / 1e7, lo / 1e7].map(r4) }); }
  }
  out.undershoots = U;
  log(`  死路端點 ${U.deadEnds}，其中離同高度的另一條路 ≤ ${UNDERSHOOT_M} m 卻沒接上 ${U.undershoots}`);
  out.layerConflictNodes = g.stats?.layerConflictNodes ?? null;
  return out;
}

// ---------- ④ 各運具連通性（有向、無向分開）----------
export function auditConnectivity(g, router, { log = () => {}, regionMin = 20 } = {}) {
  const { V, E, W } = g, out = {}, ferryHw = HIGHWAYS.indexOf('ferry'), pierHw = HIGHWAYS.indexOf('pier_link');
  for (const pr of PROFILES) {
    const key = pr.key, P = router.profile(key), C = router.components(key), n = V.n;
    let usableV = 0, arcs = 0, edgesAny = 0, edgesBoth = 0;
    for (let v = 0; v < n; v++) if (C.usable[v]) usableV++;
    const acc4 = {}; for (let a = 0; a < 2 * E.n; a++) { const x = access4(router.status(a, P.pi)), k = x.state + (x.state === 'allowed' || x.state === 'prohibited' ? '/' + x.source : ''); acc4[k] = (acc4[k] || 0) + E.len[a >> 1] / 1000; }
    for (const k in acc4) acc4[k] = +acc4[k].toFixed(1);
    for (let e = 0; e < E.n; e++) { const f = P.cost[2 * e] < Infinity, b = P.cost[2 * e + 1] < Infinity; if (f) arcs++; if (b) arcs++; if (f || b) edgesAny++; if (f && b) edgesBoth++; }
    // 弱連通（無向）：含渡輪、不含渡輪各算一次
    const wccStats = withFerry => {
      const par = Int32Array.from({ length: n }, (_, i) => i), find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
      for (let e = 0; e < E.n; e++) {
        if (!(P.cost[2 * e] < Infinity || P.cost[2 * e + 1] < Infinity)) continue;
        const h = W.hw[E.way[e]]; if (!withFerry && (h === ferryHw || h === pierHw)) continue;
        const x = find(E.u[e]), y = find(E.v[e]); if (x !== y) par[x] = y;
      }
      const size = new Map(), bbox = new Map(), sumV = new Map();
      for (let v = 0; v < n; v++) { if (!C.usable[v]) continue; const r = find(v); size.set(r, (size.get(r) || 0) + 1);
        let b = bbox.get(r); if (!b) bbox.set(r, b = [Infinity, Infinity, -Infinity, -Infinity]); const lo = V.lon[v] / 1e7, la = V.lat[v] / 1e7; if (lo < b[0]) b[0] = lo; if (la < b[1]) b[1] = la; if (lo > b[2]) b[2] = lo; if (la > b[3]) b[3] = la;
        const s = sumV.get(r) || [0, 0]; s[0] += lo; s[1] += la; sumV.set(r, s); }
      const comps = [...size.entries()].sort((a, b) => b[1] - a[1]), main = comps[0] ? comps[0][1] : 0;
      const singles = comps.filter(c => c[1] === 1).length, small = comps.filter(c => c[1] > 1 && c[1] < 10).length;
      const regions = comps.slice(1).filter(c => c[1] >= regionMin).slice(0, 40).map(([r, s]) => { const [sx, sy] = sumV.get(r), cx = sx / s, cy = sy / s; return { vertices: s, region: regionOf(cx, cy), center: [r4(cy), r4(cx)], bbox: bbox.get(r).map(r4) }; });
      const byRegion = {}; for (const [r, s] of comps.slice(1)) { const [sx, sy] = sumV.get(r), reg = regionOf(sx / s, sy / s); const o = byRegion[reg] || (byRegion[reg] = { components: 0, vertices: 0 }); o.components++; o.vertices += s; }
      return { components: comps.length, largest: main, largestPct: +(100 * main / Math.max(1, usableV)).toFixed(3), singletons: singles, smallUnder10: small, regions, byRegion };
    };
    const wF = wccStats(true), wL = wccStats(false);
    // 強連通（有向）：主幹＝最大的 SCC；只因方向性受限的頂點（在主幹的弱連通區內，但不能雙向互通）
    let mainScc = 0; for (let c = 0; c < C.count; c++) if (C.size[c] > C.size[mainScc]) mainScc = c;
    let inMainWcc = 0, trapIn = 0, trapOut = 0, neither = 0, sccSingles = 0;
    let mainW = -1; for (let v = 0; v < n; v++) if (C.usable[v] && C.comp[v] === mainScc) { mainW = C.wcc[v]; break; }
    for (let c = 0; c < C.count; c++) if (C.size[c] === 1) sccSingles++;
    // fromCore/toCore 以「每個弱連通區最大的 SCC」為核心
    for (let v = 0; v < n; v++) {
      if (!C.usable[v] || C.wcc[v] !== mainW) continue; inMainWcc++;
      if (C.comp[v] === mainScc) continue;
      const f = C.fromCore[v], t = C.toCore[v];
      if (f && !t) trapIn++; else if (!f && t) trapOut++; else if (!f && !t) neither++;
    }
    out[key] = { label: pr.label, usableVertices: usableV, directedArcs: arcs, edgesAnyDirection: edgesAny, edgesBothDirections: edgesBoth,
      weak: { withFerry: wF, landOnly: wL },
      strong: { components: C.count, largest: C.size[mainScc], largestPct: +(100 * C.size[mainScc] / Math.max(1, usableV)).toFixed(3), singletons: sccSingles,
        directionalOnly: { inMainWeakComponent: inMainWcc, enterOnly: trapIn, exitOnly: trapOut, neither, note: '在最大弱連通區內、但不在最大強連通區：進得去出不來（enterOnly）、出得來進不去（exitOnly）。多半是單行道、停車場出口、只出不進的車道或轉向限制造成的「方向性限制」，不等於資料錯誤；要人工抽查。' } },
      accessKm: acc4, isolatedVertices: wF.singletons, restrictionsUsed: P.used, conditionalRestrictionsNotApplied: P.condSkipped };
    log(`  ${pr.label}：可用頂點 ${usableV.toLocaleString()}、弱連通 ${wF.components}（最大 ${wF.largestPct}%；不含渡輪 ${wL.largestPct}%）、強連通 ${C.count}（最大 ${out[key].strong.largestPct}%）、方向性受限 ${trapIn + trapOut + neither}`);
  }
  return out;
}

// ---------- ⑤ 跨縣市可達性（真實路由）----------
export function auditCounties(router, { log = () => {}, profiles = ['car', 'moto', 'bike', 'foot'], pairs = COUNTY_PAIRS } = {}) {
  const rows = [];
  for (const [a, b] of pairs) {
    const A = COUNTY_POINTS[a], B = COUNTY_POINTS[b], row = { from: a, to: b, results: {} };
    for (const p of profiles) {
      const far = Math.hypot(A[0] - B[0], A[1] - B[1]) > 1.2;
      if (p === 'foot' && far) { row.results[p] = { skipped: '步行長距離不測' }; continue; }
      const t0 = Date.now(), r = router.route({ from: A, to: B, profile: p });
      row.results[p] = r.error ? { ok: false, error: r.error, ms: Date.now() - t0 } : { ok: true, km: +(r.distanceM / 1000).toFixed(1), min: Math.round(r.durationS / 60), ferries: (r.ferries || []).length, ms: Date.now() - t0 };
    }
    rows.push(row); log(`  ${a} → ${b}：${Object.entries(row.results).map(([k, v]) => `${k} ${v.skipped ? '略' : v.ok ? v.km + ' km' : v.error}`).join('、')}`);
  }
  return rows;
}

// ---------- 時段條件的轉向限制：能不能判斷 ----------
export function auditConditional(g, at = Date.now()) {
  const byRel = new Map(); for (const r of g.restrictions.rules) if (r.cond) byRel.set(r.rel, r.cond);
  let ok = 0, active = 0, holiday = 0; const bad = new Map();
  for (const c of byRel.values()) { const f = compileCondition(c), v = f(at); if (v == null) bad.set(c, (bad.get(c) || 0) + 1); else { ok++; if (v) active++; } if (f.info.ignoredHolidayException) holiday++; }
  return { relations: byRel.size, evaluable: ok, activeAt: { at: new Date(at).toISOString(), count: active }, ignoredHolidayException: holiday, unevaluable: [...bad].sort((x, y) => y[1] - x[1]).map(([cond, n]) => ({ cond, n })) };
}

// ---------- 報告 ----------
export function auditMarkdown(rep) {
  const L = [], f = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x)), T = rep.topology, C = rep.connectivity;
  L.push('# OSM 道路圖稽核報告（RoadGraphValidator）', '', `- 圖檔：${rep.graph}`, `- 資料時間：${rep.dataTimestamp || '—'}`, `- 稽核時間：${rep.auditedAt}（${rep.seconds} 秒）`, '- 資料類型：**真實資料**（Geofabrik 台灣 OSM 擷取）', '');
  if (T) {
    const g = T.geometry, d = T.duplicates, X = T.crossings, U = T.undershoots;
    L.push('## 拓樸與幾何', '', '| 項目 | 數量 | 說明 |', '|---|---:|---|');
    L.push(`| 頂點／邊／幾何點 | ${f(T.vertices)}／${f(T.edges)}／${f(T.geometryPoints)} | |`);
    L.push(`| 長度為 0 的邊 | ${f(g.zeroLength)} | |`, `| 自我迴圈 | ${f(g.selfLoops)} | 其中 ≥ 20 m 的 ${f(g.selfLoopLegit)} 是環狀道路（正常）|`);
    L.push(`| 重複邊（兩端點相同、node 序列相同） | ${f(d.duplicateEdges)} | 同一條 way ${f(d.duplicateSameWay)}；其餘是兩條 way 重疊畫線 |`, `| 平行邊（兩端點相同、幾何不同） | ${f(d.parallelEdges)} | 通常正常（例如兩條路連接相同路口）|`);
    L.push(`| 座標相同但 OSM node 不同 | ${f(T.coincidentNodes.locations)} | 同高度層 ${f(T.coincidentNodes.sameLevel)}；其中兩個以上是道路端點／路口 ${f(T.coincidentNodes.endpointBoth)}（**看起來相接、其實斷開**，影響連通性）|`);
    L.push(`| 高度層衝突 node（建圖時已拆開） | ${f(T.layerConflictNodes ?? 0)} | 不同 layer／橋／隧道在中間點共用 node |`);
    L.push(`| 不合理的長邊 | ${f(g.longEdges)} | 依道路類別門檻 |`, `| 單一線段 > ${GAP_M} m | ${f(g.gaps)} | 可能缺 node |`, `| 折返尖刺（> ${SPIKE_DEG}°） | ${f(g.spikes)} | |`, `| 重複的連續點 | ${f(g.dupPoints)} | |`);
    L.push(`| 死路端點 | ${f(U.deadEnds)} | |`, `| 端點離同高度道路 ≤ ${UNDERSHOOT_M} m 卻沒接上 | ${f(U.undershoots)} | 疑似 undershoot；${Object.entries(U.byClass).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join('、')} |`);
    L.push('', '### 幾何相交但沒有共用 node（區分「真的路口」與「只是幾何相交」）', '', '| 類型 | 數量 | 判斷 |', '|---|---:|---|');
    L.push(`| 立體交叉（不同高度層，或任一條是橋／隧道） | ${f(X.gradeSeparated)} | 正常：不相連是對的 |`, `| 同高度、兩條都是車道 | ${f(X.suspectedMissingJunction)} | **疑似漏接路口**（或漏標橋／隧道／layer），要人工確認 |`,
      `| 同高度、其中一條是人行道／小徑／自行車道 | ${f(X.pathCrossingNoNode)} | 疑似缺穿越點：步行／自行車可能被迫繞路 |`, `| 同高度、共線重疊 > 50 m | ${f(X.overlapping)} | 重複畫線 |`);
    const top = o => Object.entries(o || {}).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} ${f(v)}`).join('、');
    L.push('', `疑似漏接路口的道路類別組合（前 12）：${top(X.missingByPair)}`, '', `缺穿越點的類別組合（前 12）：${top(X.pathByPair)}`);
    const sm = (t, a) => { if (a && a.length) L.push('', `<details><summary>${t}（前 ${a.length} 筆）</summary>`, '', ...a.map(x => '- `' + JSON.stringify(x) + '`'), '', '</details>'); };
    sm('疑似漏接路口', X.samplesMissing); sm('人行／小徑缺穿越點', X.samplesPath); sm('undershoot', U.samples); sm('重複邊', d.samples); sm('未合併的重複節點', T.coincidentNodes.samples); sm('過長的單一線段', g.gapSamples); sm('不合理的長邊', g.longSamples); sm('折返尖刺', g.spikeSamples);
  }
  if (C) {
    L.push('', '## 各運具連通性（有向、無向分開）', '', '弱連通＝不管方向（看路網有沒有斷開）；強連通＝依單行與通行權的方向（看能不能來回）。方向性受限的頂點不一定是錯誤。', '',
      '| 運具 | 可用頂點 | 可用邊（任一方向）| 有向邊 | 弱連通分量 | 最大弱連通 | 不含渡輪最大 | 孤立頂點 | 強連通分量 | 最大強連通 | 進得去出不來 | 出得來進不去 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [k, o] of Object.entries(C)) L.push(`| ${o.label} | ${f(o.usableVertices)} | ${f(o.edgesAnyDirection)} | ${f(o.directedArcs)} | ${f(o.weak.withFerry.components)} | ${o.weak.withFerry.largestPct}% | ${o.weak.landOnly.largestPct}% | ${f(o.isolatedVertices)} | ${f(o.strong.components)} | ${o.strong.largestPct}% | ${f(o.strong.directionalOnly.enterOnly)} | ${f(o.strong.directionalOnly.exitOnly)} |`);
    L.push('', '### 通行權四態（有向公里數；allowed/prohibited 後面是來源：tag＝OSM 標籤、default＝依道路類別與法規推定、oneway＝單行反向）', '', '| 運具 | allowed/tag | allowed/default | restricted | prohibited/tag | prohibited/default | prohibited/oneway | unknown |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const o of Object.values(C)) { const a = o.accessKm || {}; L.push(`| ${o.label} | ${f(a['allowed/tag'] || 0)} | ${f(a['allowed/default'] || 0)} | ${f(a.restricted || 0)} | ${f(a['prohibited/tag'] || 0)} | ${f(a['prohibited/default'] || 0)} | ${f(a['prohibited/oneway'] || 0)} | ${f(a.unknown || 0)} |`); }
    for (const [k, o] of Object.entries(C)) {
      L.push('', `### ${o.label}：無法連通的區域（不含渡輪，≥ 20 個頂點）`, '', '| 區域 | 分量數 | 頂點 |', '|---|---:|---:|');
      for (const [r, s] of Object.entries(o.weak.landOnly.byRegion).sort((a, b) => b[1].vertices - a[1].vertices)) L.push(`| ${r} | ${f(s.components)} | ${f(s.vertices)} |`);
      const top = o.weak.landOnly.regions.slice(0, 10); if (top.length) L.push('', '最大的幾個：' + top.map(x => `${x.region} ${x.vertices} 點（中心 ${x.center.join(', ')}）`).join('；'));
    }
  }
  if (rep.conditional) {
    const c = rep.conditional;
    L.push('', '## 時段條件的轉向限制（restriction:conditional、day_on/hour_on）', '', `- relation：${c.relations}；可判斷 ${c.evaluable}（${Math.round(100 * c.evaluable / Math.max(1, c.relations))}%）；在 ${c.activeAt.at} 適用 ${c.activeAt.count}`, `- 含「, PH off」（國定假日例外）${c.ignoredHolidayException} 筆：沒有國定假日日曆，照平日判斷（保守：寧可多繞，不違規）`, `- 無法判斷（不套用、路線結果回報數量）：${c.unevaluable.length} 種寫法：${c.unevaluable.map(x => '`' + x.cond + '`×' + x.n).join('、')}`);
  }
  if (rep.counties) {
    L.push('', '## 跨縣市可達性（真實路由）', '', '| 起 | 迄 | 汽車 | 機車 | 自行車 | 步行 |', '|---|---|---|---|---|---|');
    const c = r => !r ? '—' : r.skipped ? '（不測）' : r.ok ? `${r.km} km／${r.min} 分${r.ferries ? '（渡輪）' : ''}` : `✗ ${r.error}`;
    for (const r of rep.counties) L.push(`| ${r.from} | ${r.to} | ${c(r.results.car)} | ${c(r.results.moto)} | ${c(r.results.bike)} | ${c(r.results.foot)} |`);
    L.push('', '金門與本島之間 OSM 沒有道路或渡輪航線連接，`NO_ROUTE` 是正確結果。標「（渡輪）」的路線含渡輪航段：OSM 大多沒標航線能不能載車（通行權「未知」，選路時成本 ×3 並警告），所以汽機車經渡輪到澎湖、馬祖的結果**不代表該航線真的可載車**，要查船公司。');
  }
  return L.join('\n') + '\n';
}
