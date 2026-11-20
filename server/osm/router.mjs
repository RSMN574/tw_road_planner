// router.mjs — 在 OSM 道路圖上做路徑搜尋（以「有向邊」為狀態的 A*，才能正確處理轉向限制）
//
// ・單行道、各運具通行狀態：access.mjs 的狀態碼；禁止的方向成本＝∞
// ・未知（UNKNOWN）、有條件（LIMITED）依政策處理（預設：可走但成本加倍，結果列出警告）
// ・轉向限制：via node 的 no_*／only_*；via way 的限制檢查前面走過的有向邊序列
// ・有時段條件的限制（restriction:conditional）預設不套用，結果會提示
// ・障礙物（barrier）：不能通過的點不能穿越（起點、終點本身可以）
// ・迴轉：只在死路允許
// ・起訖點吸附到最近的「路段」（投影點，不是最近的路口），第一段與最後一段只算走到的部分
// ・避開孤立的小區塊：最近的路段若和另一端不在同一個強連通分量（例如地下停車場出口、只出不進的車道、
//   沒接上路網的室內步道），改用附近（最近距離＋500 m 內）兩端能互通的路段，結果會註明改吸附了多遠
//
// 時間模型（與網頁導航的 ETA 同一套參數，見 js/eta-params.js）：
//   路段時間 ＝ 長度 ÷（速限 × 該運具在該類道路的平均／速限比例）＋ 路段中間的號誌
//   速限：way 的 maxspeed（含 :forward／:backward）＞ 區域速限代碼（TW:urban → 法定 50）＞ 依道路類別推估（結果標示）
//   經過路口：號誌等待、沒有號誌的路口（轉彎或從小路穿越大路）、轉向延遲（台灣靠右：左轉較久，機車左轉多為兩段式）
//   渡輪：OSM duration 標籤（沒有就用平均航速推估），不含候船與班次時間（結果標示）
// 選路成本 ＝ 時間 ×（未知／有條件通行的係數）×（道路等級係數：汽機車少走巷弄、自行車少走大馬路，只影響選路、不影響時間）＋ 上渡輪的成本
// 長距離：有地標表（alt.mjs）時用 ALT 下界加速；沒有就用「直線距離 ÷ 最高速度」
import { MinHeap } from '../../js/heap.js';
import { FLOW, DELAY } from '../../js/eta-params.js';
import { PROFILES, PROFILE_IX, ST, COND, costFactor, isBlocked, DEFAULT_POLICY } from './access.mjs';
import { HIGHWAYS, isFreewayTW, isExpresswayTW } from './tags.mjs';
import { distE7, bearingE7 } from './grow.mjs';
import { NF, WF } from './topology.mjs';
import { scc } from './scc.mjs';
import { conditionActive } from './conditional.mjs';

// 沒標速限時，依道路類別推估的速限（km/h）
export const DEFAULT_KMH = { motorway: 100, motorway_link: 60, trunk: 70, trunk_link: 50, primary: 50, primary_link: 40, secondary: 50, secondary_link: 40, tertiary: 40, tertiary_link: 30,
  unclassified: 40, residential: 30, living_street: 15, service: 20, road: 30, track: 15, pedestrian: 10, footway: 10, path: 10, cycleway: 18, steps: 3, bridleway: 10, corridor: 5, busway: 50, escape: 20, ferry: 25, pier_link: 10 };
// 運具 → eta-params 的名稱
export const VK = { car: 'car', heavy: 'heavy', moto: 'moto', bike: 'bike', foot: 'walk' };
// 各運具：速度上限（km/h）
export const PROFILE_SPEED = {
  car:   { cap: Infinity },
  heavy: { cap: Infinity },
  moto:  { cap: 50 },                                     // 機車上限 50 km/h：與既有系統相同的假設值
  bike:  { cap: 18, walkKmh: 4.5 },                       // 有條件（例如要牽車）的路段用步行速度
  foot:  { cap: 4.5 }
};
// 道路等級係數（≥1；只影響選路，不影響時間）
export const CLASS_COST = {
  car:   { residential: 1.25, living_street: 1.5, service: 1.5, unclassified: 1.1, road: 1.2, track: 2 },
  heavy: { residential: 1.25, living_street: 1.5, service: 1.5, unclassified: 1.1, road: 1.2, track: 2 },
  moto:  { residential: 1.1, living_street: 1.3, service: 1.3, track: 1.8 },
  bike:  { trunk: 1.4, trunk_link: 1.4, primary: 1.25, primary_link: 1.25, secondary: 1.1 },
  foot:  {}
};
export const FERRY_BOARD_COST = 1800;                     // 上渡輪的選路成本（秒，不算進時間）：有陸路時優先走陸路
export const FERRY_KMH = [1, 80];                         // duration 換算的航速若超出這個範圍視為標錯，改用範圍邊界
export const TURN = { straight: 30, slight: 60, turn: 120, sharp: 150 };   // 與網頁 generateManeuvers 相同的角度門檻
const RANK = [0, 2, 4, 3, 1, 1, 0, 0, 5, 5];              // 道路類別的「大小」（判斷小路穿越大路）
// 模型參數的指紋：地標表（alt.mjs）記錄它，參數改了就不用舊的表（下界可能不再成立）
export const MODEL_KEY = JSON.stringify({ FLOW, DELAY, DEFAULT_KMH, PROFILE_SPEED, FERRY_KMH, CLASS_COST, FERRY_BOARD_COST, DEFAULT_POLICY, v: 3 });

// OSM highway → 道路類別（eta-params 的 CLS：0 未知、1 一般、2 主要、3 次要、4 巷弄、5 自行車道、6 步行道、7 特殊、8 國道、9 快速道路）
export function clsOf(hw, t) {
  switch (hw) {
    case 'motorway': case 'motorway_link': return isFreewayTW(t) || !isExpresswayTW(t) ? 8 : 9;
    case 'trunk': case 'trunk_link': return isExpresswayTW(t) ? 9 : 2;
    case 'primary': case 'primary_link': return 2;
    case 'secondary': case 'secondary_link': return 3;
    case 'tertiary': case 'tertiary_link': case 'unclassified': case 'road': return 1;
    case 'residential': case 'living_street': case 'service': return 4;
    case 'cycleway': return 5;
    case 'footway': case 'path': case 'pedestrian': case 'steps': case 'corridor': case 'bridleway': return 6;
    default: return 7;
  }
}
const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; };
const hav = (lo1, la1, lo2, la2) => { const R = Math.PI / 180, h = Math.sin((la2 - la1) * R / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin((lo2 - lo1) * R / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))); };

export class OsmRouter {
  constructor(g, { policy = DEFAULT_POLICY, applyConditional = false, ignoreRestrictions = false, alt = null } = {}) {
    this.g = g; this.policy = policy; this.applyConditional = applyConditional; this.ignoreRestrictions = ignoreRestrictions;   // ignoreRestrictions：只供比較／除錯
    this.altSource = alt;                                                            // (key) → 地標表或 null（見 alt.mjs）；也可以是 { [key]: 表 }
    const { V, E, W, strings } = g, M = 2 * E.n;
    // 有向邊 CSR：outStart[x]…outStart[x+1] 是從 x 出發的有向邊
    const start = new Int32Array(V.n + 1); for (let e = 0; e < E.n; e++) { start[E.u[e] + 1]++; start[E.v[e] + 1]++; }
    for (let x = 0; x < V.n; x++) start[x + 1] += start[x];
    const fill = start.slice(0, V.n), out = new Int32Array(M); for (let e = 0; e < E.n; e++) { out[fill[E.u[e]]++] = 2 * e; out[fill[E.v[e]]++] = 2 * e + 1; }
    this.outStart = start; this.outArc = out; this.M = M; this.prof = {}; this.alt = {};
    this.stamp = new Int32Array(M); this.gen = 0; this.gc = new Float64Array(M); this.pred = new Int32Array(M);
    this.hStamp = new Int32Array(V.n); this.hVal = new Float64Array(V.n);
    this.ferryHw = HIGHWAYS.indexOf('ferry'); this.pierHw = HIGHWAYS.indexOf('pier_link');
    this.wcls = new Uint8Array(W.n);
    for (let w = 0; w < W.n; w++) { const hw = HIGHWAYS[W.hw[w]]; this.wcls[w] = clsOf(hw, { highway: hw, ref: strings[W.ref[w]], name: strings[W.name[w]], motorroad: W.flags[w] & WF.MOTORROAD ? 'yes' : undefined }); }
  }
  head(a) { const e = a >> 1; return a & 1 ? this.g.E.u[e] : this.g.E.v[e]; }
  tail(a) { const e = a >> 1; return a & 1 ? this.g.E.v[e] : this.g.E.u[e]; }
  status(a, pi) { const acc = this.g.W.acc[this.g.E.way[a >> 1] * PROFILES.length + pi]; return a & 1 ? acc >> 4 : acc & 15; }
  isFerry(a) { return this.g.W.hw[this.g.E.way[a >> 1]] === this.ferryHw; }
  wayName(w) { const s = this.g.strings; return s[this.g.W.name[w]] || s[this.g.W.ref[w]] || ''; }
  // 速限（km/h）與來源：'tag'（maxspeed）、'zone'（區域速限代碼）、null（依道路類別推估）
  limitOf(a) {
    const { W, E } = this.g, w = E.way[a >> 1], hw = HIGHWAYS[W.hw[w]], dir = a & 1 ? W.maxB[w] : W.maxF[w], tag = Number.isFinite(dir) ? dir : W.maxspeed[w];
    if (Number.isFinite(tag) && tag > 0) return { kmh: tag, src: 'tag' };
    const z = W.zoneMax ? W.zoneMax[w] : 0; if (z > 0) return { kmh: Math.min(z, DEFAULT_KMH[hw] ?? 30), src: 'zone' };
    return { kmh: DEFAULT_KMH[hw] ?? 30, src: null };
  }
  // 渡輪：整條航線的長度（duration 是整條航線的時間，依長度分給各段）
  ferryLen(w) { const { W, E } = this.g; this.fl = this.fl || new Map(); let L = this.fl.get(w); if (L == null) { L = 0; for (let e = W.edgeOff[w]; e < W.edgeOff[w + 1]; e++) L += E.len[e]; this.fl.set(w, L); } return L; }
  // 單一運具的時間表與成本表（第一次用時建立）
  profile(key) {
    if (this.prof[key]) return this.prof[key];
    const pi = PROFILE_IX[key]; if (pi == null) throw new Error('未知的運具：' + key);
    const { E, W, V } = this.g, sp = PROFILE_SPEED[key], vk = VK[key], F = FLOW[vk], D = DELAY[vk], CC = CLASS_COST[key] || {}, M = this.M;
    const time = new Float32Array(M), cost = new Float32Array(M);
    let unknownSpeed = 0, vmax = 0.5;
    for (let a = 0; a < M; a++) {
      const e = a >> 1, w = E.way[e], s = this.status(a, pi), f = costFactor(s, this.policy), hwi = W.hw[w], hw = HIGHWAYS[hwi], cl = this.wcls[w], L = Math.max(0.1, E.len[e]);
      let t;
      if (hwi === this.ferryHw) {
        const fs = W.ferryS ? W.ferryS[w] : NaN, tot = this.ferryLen(w);
        t = Number.isFinite(fs) && fs > 0 && tot > 0 ? Math.min(L / (FERRY_KMH[0] / 3.6), Math.max(L / (FERRY_KMH[1] / 3.6), fs * L / tot)) : L / (DEFAULT_KMH.ferry / 3.6);
      } else {
        const lim = this.limitOf(a); let kmh;
        if (key === 'foot') kmh = hw === 'steps' ? 2.5 : sp.cap;
        else if (key === 'bike') kmh = (s & 7) === ST.LIMITED ? sp.walkKmh : hw === 'steps' ? 2 : Math.min(sp.cap, lim.kmh) * (F[cl] ?? F[0]);
        else { if (!lim.src) unknownSpeed++; kmh = Math.min(sp.cap, lim.kmh) * (F[cl] ?? F[0]); }
        t = L / (Math.max(1, kmh) / 3.6) + (E.sig[e] || 0) * D.j4;
      }
      time[a] = t; cost[a] = f === Infinity ? Infinity : t * Math.max(1, f) * (hwi === this.ferryHw ? 1 : (CC[hw] || 1));
      if (cost[a] < Infinity && L / t > vmax) vmax = L / t;
    }
    // 轉向限制（依運具）：via node 的禁止／只准，via way 的序列
    const bit = 1 << pi, no = new Map(), only = new Map(), viaWay = new Map(); let condSkipped = 0, used = 0;
    for (const r of this.ignoreRestrictions ? [] : this.g.restrictions.rules) {
      if (!(r.mask & bit)) continue;
      if (r.cond && !this.applyConditional) { condSkipped++; continue; }
      used++;
      if (r.viaArcs) { const k = r.viaArcs[r.viaArcs.length - 1]; (viaWay.get(k) || viaWay.set(k, []).get(k)).push(r); continue; }
      const m = r.kind === 'only' ? only : no; (m.get(r.from) || m.set(r.from, new Set()).get(r.from)).add(r.to);
    }
    const bar = new Uint8Array(V.n); for (const [v, acc] of V.barrier) if (isBlocked(acc[pi]) || costFactor(acc[pi], this.policy) === Infinity) bar[v] = 1;
    return (this.prof[key] = { key, pi, sp, vk, F, D, time, cost, costD: null, vmax, no, only, viaWay, bar, condSkipped, used, unknownSpeedArcs: unknownSpeed });
  }
  // 依時間判斷有條件的轉向限制（restriction:conditional、day_on/hour_on）：現在適用的才套用；看不懂的條件不套用並回報（不猜）
  // 回傳一個共用時間／成本表、只換轉向限制表的 profile；同一組「適用的規則」會快取
  profileAt(key, ms) {
    const P = this.profile(key), bit = 1 << P.pi; if (ms == null || !Number.isFinite(+ms)) return P;
    const act = [], st = { active: 0, inactive: 0, unknown: 0 };
    for (let i = 0; i < this.g.restrictions.rules.length; i++) { const r = this.g.restrictions.rules[i]; if (!(r.mask & bit) || !r.cond || this.ignoreRestrictions) continue;
      const v = conditionActive(r.cond, +ms); if (v === true) { st.active++; act.push(i); } else if (v === false) st.inactive++; else st.unknown++; }
    const sig = key + '|' + act.join(','); this.profAt = this.profAt || new Map(); let Q = this.profAt.get(sig);
    if (!Q) {
      const no = new Map([...P.no].map(([k, v]) => [k, new Set(v)])), only = new Map([...P.only].map(([k, v]) => [k, new Set(v)])), viaWay = new Map([...P.viaWay].map(([k, v]) => [k, [...v]]));
      for (const i of act) { const r = this.g.restrictions.rules[i];
        if (r.viaArcs) { const k = r.viaArcs[r.viaArcs.length - 1]; (viaWay.get(k) || viaWay.set(k, []).get(k)).push(r); continue; }
        const m = r.kind === 'only' ? only : no; (m.get(r.from) || m.set(r.from, new Set()).get(r.from)).add(r.to); }
      Q = { ...P, no, only, viaWay, condSkipped: 0, used: P.used + act.length };
      if (this.profAt.size > 16) this.profAt.delete(this.profAt.keys().next().value); this.profAt.set(sig, Q);
    }
    return Object.assign(Object.create(Q), { condAt: { at: new Date(+ms).toISOString(), applied: st.active, notActive: st.inactive, unevaluable: st.unknown } });
  }
  // ---- 步行可達範圍（大眾運輸的轉乘與接駁用，v1.11）----
  // 一個點吸附到最近的可步行路段（≤ maxSnapM），回傳 { e, along, L, snapM }；離路網的那一小段以 1.2 m/s 直線計
  footSnap(lat, lon, maxSnapM = 300, key = 'foot') { const c = this.snapCandidates(lat, lon, key, { windowM: 0, maxM: maxSnapM })[0]; return c ? { e: c.e, along: c.along, L: this.g.E.len[c.e], snapM: c.distM, lat7: c.lat7, lon7: c.lon7 } : null; }
  // 從 s（footSnap 的結果）出發，在步行路網上做有上限的 Dijkstra（秒）；回傳 { at(snap) → { s, m } | null }
  // 只用「實際的步行路徑」（通行權禁止的不走、障礙物不穿越）；行人不受轉向限制
  footReach(s, { maxS = 900, key = 'foot', walkMps = 1.2 } = {}) {
    if (!s) return null;
    const P = this.profile(key), { E, V } = this.g, n = V.n, fr = this._fr || (this._fr = { t: new Float64Array(n), m: new Float64Array(n), st: new Int32Array(n), gen: 0 });
    if (++fr.gen > 2e9) { fr.st.fill(0); fr.gen = 1; }
    const gen = fr.gen, pq = new MinHeap(1024), base = s.snapM / walkMps, u = E.u[s.e], v = E.v[s.e], k = s.L > 0 ? s.along / s.L : 0;
    const seed = (x, t, m) => { if (t > maxS) return; if (fr.st[x] !== gen || t < fr.t[x]) { fr.st[x] = gen; fr.t[x] = t; fr.m[x] = m; pq.push(t, x); } };
    if (P.cost[2 * s.e + 1] < Infinity) seed(u, base + P.time[2 * s.e + 1] * k, s.snapM + s.along);
    if (P.cost[2 * s.e] < Infinity) seed(v, base + P.time[2 * s.e] * (1 - k), s.snapM + (s.L - s.along));
    let settled = 0;
    while (pq.n) {
      const [t, x] = pq.pop(); if (fr.st[x] !== gen || t > fr.t[x] + 1e-9) continue; settled++;
      if (P.bar[x] && settled > 2) continue;
      for (let q = this.outStart[x]; q < this.outStart[x + 1]; q++) {
        const a = this.outArc[q]; if (!(P.cost[a] < Infinity)) continue;
        const y = this.head(a), nt = t + P.time[a]; if (nt > maxS) continue;
        if (fr.st[y] !== gen || nt < fr.t[y]) { fr.st[y] = gen; fr.t[y] = nt; fr.m[y] = fr.m[x] + E.len[a >> 1]; pq.push(nt, y); }
      }
    }
    const self = this;
    return { settled, at(o) {                                                          // 到另一個吸附點（終點）的時間：經由它那條邊的兩端，或同一條邊上直接走
      if (!o) return null; let best = null; const tail = o.snapM / walkMps, ok = (x) => fr.st[x] === gen;
      const ou = E.u[o.e], ov = E.v[o.e], ko = o.L > 0 ? o.along / o.L : 0;
      if (ok(ou) && P.cost[2 * o.e] < Infinity) { const t = fr.t[ou] + P.time[2 * o.e] * ko + tail; if (!best || t < best.s) best = { s: t, m: fr.m[ou] + o.along + o.snapM }; }
      if (ok(ov) && P.cost[2 * o.e + 1] < Infinity) { const t = fr.t[ov] + P.time[2 * o.e + 1] * (1 - ko) + tail; if (!best || t < best.s) best = { s: t, m: fr.m[ov] + (o.L - o.along) + o.snapM }; }
      if (o.e === s.e) { const d = Math.abs(o.along - s.along), t = base + tail + d / walkMps; if (!best || t < best.s) best = { s: t, m: s.snapM + d + o.snapM }; }
      return best && best.s <= maxS ? { s: Math.round(best.s), m: Math.round(best.m) } : null;
    }, gen, router: self };
  }
  // 「最短距離」用的成本表：長度 ×（未知／有條件的係數）
  distCost(P) {
    if (P.costD) return P.costD;
    if (P.key && this.prof[P.key] && this.prof[P.key] !== P) return (P.costD = this.distCost(this.prof[P.key]));   // 依時間的 profile 共用原本的表
    const { E } = this.g, c = new Float32Array(this.M);
    for (let a = 0; a < this.M; a++) { const f = costFactor(this.status(a, P.pi), this.policy); c[a] = f === Infinity ? Infinity : Math.max(0.1, E.len[a >> 1]) * Math.max(1, f); }
    return (P.costD = c);
  }
  // 轉向用的幾何：每條有向邊離開起點、到達終點時的方位（0～255 代表 0～360°），每個頂點的岔路數與相接道路的最大等級
  turnGeo() {
    if (this.tg) return this.tg;
    const { V, E, G } = this.g, M = this.M, inB = new Uint8Array(M), outB = new Uint8Array(M), deg = new Uint8Array(V.n), maxRank = new Uint8Array(V.n), q = d => Math.round(((d % 360) + 360) % 360 / 360 * 256) & 255;
    for (let e = 0; e < E.n; e++) {
      const g0 = E.goff[e], g1 = E.goff[e + 1] - 1; if (g1 <= g0) continue;
      let k1 = g0 + 1; while (k1 < g1 && G.cum[k1] - G.cum[g0] < 2) k1++;           // 離端點至少 2 m 的點（避免很短的線段造成方位亂跳）
      let k0 = g1 - 1; while (k0 > g0 && G.cum[g1] - G.cum[k0] < 2) k0--;
      const bs = bearingE7(G.lat[g0], G.lon[g0], G.lat[k1], G.lon[k1]), be = bearingE7(G.lat[k0], G.lon[k0], G.lat[g1], G.lon[g1]);
      outB[2 * e] = q(bs); inB[2 * e] = q(be); outB[2 * e + 1] = q(be + 180); inB[2 * e + 1] = q(bs + 180);
      const r = RANK[this.wcls[E.way[e]]]; if (r > maxRank[E.u[e]]) maxRank[E.u[e]] = r; if (r > maxRank[E.v[e]]) maxRank[E.v[e]] = r;
    }
    const nb = new Int32Array(64);
    for (let v = 0; v < V.n; v++) {
      let n = 0;
      for (let k = this.outStart[v]; k < this.outStart[v + 1]; k++) { const y = this.head(this.outArc[k]); let dup = false; for (let j = 0; j < n; j++) if (nb[j] === y) { dup = true; break; } if (!dup && n < 64) nb[n++] = y; }
      deg[v] = Math.min(255, n);
    }
    return (this.tg = { inB, outB, deg, maxRank });
  }
  // 經過頂點 v（從 a 進、往 b 出）的時間（秒）：號誌、沒有號誌的路口、轉向延遲
  turnS(P, a, b, v) {
    const D = P.D, tg = this.turnGeo();
    let d = (this.g.V.flags[v] & NF.SIGNAL) ? D.j4 : 0;
    if (b === (a ^ 1)) return d + D.uturn;
    if (tg.deg[v] < 3) return d;                                                     // 不是路口（只是 way 換段、橋頭…）
    const delta = (((tg.outB[b] - tg.inB[a] + 384) % 256) - 128) * 360 / 256, ad = Math.abs(delta), R = delta > 0;   // 正＝右轉
    if (ad >= TURN.straight) {
      if (!d) d += D.j3;
      d += ad < TURN.slight ? (R ? D.slightR : D.slightL) : ad < TURN.turn ? (R ? D.right : D.left) : ad < TURN.sharp ? (R ? D.sharpR : D.sharpL) : D.uturn;
    } else if (!d && RANK[this.wcls[this.g.E.way[a >> 1]]] < tg.maxRank[v]) d += D.j3;   // 從小路直行穿越大路
    return d;
  }
  // 轉彎角度（度；正＝右轉）
  turnAngle(a, b) { const tg = this.turnGeo(); return b === (a ^ 1) ? 180 : (((tg.outB[b] - tg.inB[a] + 384) % 256) - 128) * 360 / 256; }
  // ---------- 地標（ALT）----------
  altFor(key) {
    if (key in this.alt) return this.alt[key];
    for (const st of [ST.UNKNOWN, ST.LIMITED]) if (costFactor(st, this.policy) < costFactor(st, DEFAULT_POLICY)) return (this.alt[key] = null);   // 政策比預設寬鬆：地標表的下界不成立
    let A = null; const src = this.altSource;
    try { A = typeof src === 'function' ? src(key) : src && src[key] ? src[key] : null; } catch { A = null; }
    if (A && (A.n !== this.g.V.n || A.model !== MODEL_KEY)) A = null;                // 不是這張圖或模型參數改過：不用
    return (this.alt[key] = A);
  }
  setAlt(key, A) { this.alt[key] = A && A.n === this.g.V.n && A.model === MODEL_KEY ? A : null; }
  // 地標下界：d(v, 終點) ≥ max(d(L,x) − d(L,v), d(v,L) − d(x,L))；終點在邊中間時取兩個入口的最小值；∞＝一定到不了
  altHeuristic(A, entries, startVerts) {
    const k = A.k, u = A.unit, INF = 65535, SAT = 65534, fw = A.fwd, bw = A.bwd;     // SAT：太遠（沒有可用的數值）
    const ex = entries.map(x => x * k);
    const bound = (v, i, xo) => {
      const fv = fw[v * k + i], fx = fw[xo + i], bv = bw[v * k + i], bx = bw[xo + i]; let h = 0;
      if (fv !== INF && fv !== SAT) { if (fx === INF) return Infinity; if (fx !== SAT) { const t = (fx - fv - 1) * u; if (t > h) h = t; } }
      if (bx !== INF && bx !== SAT) { if (bv === INF) return Infinity; if (bv !== SAT) { const t = (bv - bx - 1) * u; if (t > h) h = t; } }
      return h;
    };
    // 用起點附近最有用的 4 個地標（ALT 的「主動地標」）
    const score = new Float64Array(k); for (let i = 0; i < k; i++) for (const s of startVerts) for (const xo of ex) { const b = bound(s, i, xo); if (b > score[i]) score[i] = b === Infinity ? 1e12 : b; }
    const act = [...Array(k).keys()].sort((p, q) => score[q] - score[p]).slice(0, Math.min(4, k));
    return v => {
      let best = Infinity;
      for (const xo of ex) { let h = 0; for (const i of act) { const b = bound(v, i, xo); if (b > h) { h = b; if (h === Infinity) break; } } if (h < best) best = h; if (best === 0) break; }
      return best;
    };
  }
  // 各運具的連通結構（不考慮轉向限制；障礙物頂點進得去、出不來）：
  //   comp：強連通分量；wcc：不分方向的連通區（島嶼）；每個連通區最大的強連通分量當「主幹」
  //   toCore[v]：從 v 開得到主幹；fromCore[v]：從主幹開得到 v。吸附時用來避開只出不進、只進不出的小區塊
  components(key) {
    const P = this.profile(key); if (P.scc) return P.scc;
    const { V, E } = this.g, n = V.n, usable = new Uint8Array(n), out = this.outArc, st = this.outStart;
    for (let a = 0; a < 2 * E.n; a++) if (P.cost[a] < Infinity) { usable[this.tail(a)] = 1; usable[this.head(a)] = 1; }
    const r = scc(n, usable, v => { const o = []; if (P.bar[v]) return o; for (let k = st[v]; k < st[v + 1]; k++) { const a = out[k]; if (P.cost[a] < Infinity) o.push(this.head(a)); } return o; });
    // 不分方向的連通區（並查集）
    const par = Int32Array.from({ length: n }, (_, i) => i), find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    for (let a = 0; a < 2 * E.n; a += 2) if (P.cost[a] < Infinity || P.cost[a + 1] < Infinity) { const x = find(this.tail(a)), y = find(this.head(a)); if (x !== y) par[x] = y; }
    const wcc = new Int32Array(n).fill(-1); for (let v = 0; v < n; v++) if (usable[v]) wcc[v] = find(v);
    const coreOf = new Map(); for (let v = 0; v < n; v++) { if (!usable[v]) continue; const c = coreOf.get(wcc[v]); if (c === undefined || r.size[r.comp[v]] > r.size[c]) coreOf.set(wcc[v], r.comp[v]); }
    const isCore = new Uint8Array(r.count); for (const c of coreOf.values()) isCore[c] = 1;
    const bfs = fwd => {
      const mark = new Uint8Array(n), q = new Int32Array(n); let h = 0, t = 0;
      for (let v = 0; v < n; v++) if (usable[v] && isCore[r.comp[v]]) { mark[v] = 1; q[t++] = v; }
      while (h < t) {
        const x = q[h++];
        if (fwd && P.bar[x]) continue;
        for (let k = st[x]; k < st[x + 1]; k++) {
          const a = out[k], y = this.head(a);
          if (fwd ? P.cost[a] === Infinity : (P.cost[a ^ 1] === Infinity || P.bar[y])) continue;   // 反向：y → x 這條有向邊可走、而且 y 不是擋路的障礙物
          if (!mark[y]) { mark[y] = 1; q[t++] = y; }
        }
      }
      return mark;
    };
    return (P.scc = { ...r, usable, wcc, fromCore: bfs(true), toCore: bfs(false) });
  }
  // 路段的格網索引：每條邊登記在它的幾何線段經過的格子（第一次用時建立）
  edgeIndex() {
    if (this.eix) return this.eix;
    const { E, G } = this.g, NG = G.lat.length;
    let y0 = Infinity, x0 = Infinity, y1 = -Infinity, x1 = -Infinity;
    for (let k = 0; k < NG; k++) { const a = G.lat[k], b = G.lon[k]; if (a < y0) y0 = a; if (a > y1) y1 = a; if (b < x0) x0 = b; if (b > x1) x1 = b; }
    if (!NG) { y0 = x0 = y1 = x1 = 0; }
    let C = 25000, ny, nx;                                                           // 0.0025 度（約 250～280 m）；範圍太大時放大格子
    for (;;) { ny = Math.floor((y1 - y0) / C) + 1; nx = Math.floor((x1 - x0) / C) + 1; if (nx * ny <= 3e7) break; C *= 2; }
    const N = nx * ny, cnt = new Int32Array(N + 1), last = new Int32Array(N).fill(-1);
    const each = (e, fn) => {
      for (let k = E.goff[e]; k < E.goff[e + 1] - 1 || k === E.goff[e]; k++) {
        const k2 = Math.min(k + 1, E.goff[e + 1] - 1);
        const ya = Math.floor((Math.min(G.lat[k], G.lat[k2]) - y0) / C), yb = Math.floor((Math.max(G.lat[k], G.lat[k2]) - y0) / C);
        const xa = Math.floor((Math.min(G.lon[k], G.lon[k2]) - x0) / C), xb = Math.floor((Math.max(G.lon[k], G.lon[k2]) - x0) / C);
        for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const c = y * nx + x; if (last[c] !== e) { last[c] = e; fn(c); } }
        if (k2 === k) break;
      }
    };
    for (let e = 0; e < E.n; e++) each(e, c => cnt[c + 1]++);
    for (let c = 0; c < N; c++) cnt[c + 1] += cnt[c];
    const fill = cnt.slice(0, N), list = new Int32Array(cnt[N]); last.fill(-1);
    for (let e = 0; e < E.n; e++) each(e, c => { list[fill[c]++] = e; });
    return (this.eix = { C, y0, x0, ny, nx, start: cnt, list });
  }
  // 點到一條邊的最近點：距離（m）、沿邊距離（m，從 u 起算）、投影點、投影處順著 way 的方位
  nearestOnEdge(e, la7, lo7, kx, ky) {
    const { E, G } = this.g, g0 = E.goff[e], g1 = E.goff[e + 1];
    let bd = Infinity, along = 0, pla = G.lat[g0], plo = G.lon[g0], bk = g0;
    if (g1 - g0 === 1) return { d: Math.hypot((G.lat[g0] - la7) * ky, (G.lon[g0] - lo7) * kx), along: 0, la: pla, lo: plo, brg: 0 };
    for (let k = g0; k < g1 - 1; k++) {
      const ax = (G.lon[k] - lo7) * kx, ay = (G.lat[k] - la7) * ky, dx = (G.lon[k + 1] - G.lon[k]) * kx, dy = (G.lat[k + 1] - G.lat[k]) * ky, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < bd) { bd = d; bk = k; along = G.cum[k] + t * (G.cum[k + 1] - G.cum[k]); pla = Math.round(G.lat[k] + t * (G.lat[k + 1] - G.lat[k])); plo = Math.round(G.lon[k] + t * (G.lon[k + 1] - G.lon[k])); }
    }
    return { d: bd, along: Math.min(along, E.len[e]), la: pla, lo: plo, brg: bearingE7(G.lat[bk], G.lon[bk], G.lat[bk + 1], G.lon[bk + 1]) };
  }
  // 附近這個運具能用的路段：最近的一條，加上距離不超過「最近距離＋windowM」的其他路段（依距離排序）；渡輪航線、碼頭連接不當起訖點
  snapCandidates(lat, lon, key, { windowM = 500, maxM = 10000 } = {}) {
    const P = this.profile(key), { E, W } = this.g, X = this.edgeIndex(), la7 = Math.round(lat * 1e7), lo7 = Math.round(lon * 1e7);
    const ky = 110574e-7, kx = 111320e-7 * Math.cos(lat * Math.PI / 180), cellM = Math.min(X.C * ky, X.C * kx);
    const cy = Math.floor((la7 - X.y0) / X.C), cx = Math.floor((lo7 - X.x0) / X.C), seen = new Set(), out = [];
    let best = Infinity;
    for (let r = 0; r <= Math.ceil(maxM / cellM) + 1; r++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= X.ny) continue;
        for (let x = cx - r; x <= cx + r; x++) {
          if (x < 0 || x >= X.nx || Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== r) continue;
          const c = y * X.nx + x;
          for (let i = X.start[c]; i < X.start[c + 1]; i++) {
            const e = X.list[i]; if (seen.has(e)) continue; seen.add(e);
            if (!(P.cost[2 * e] < Infinity || P.cost[2 * e + 1] < Infinity) || W.hw[E.way[e]] === this.ferryHw || W.hw[E.way[e]] === this.pierHw) continue;
            const q = this.nearestOnEdge(e, la7, lo7, kx, ky); if (q.d > maxM) continue;
            out.push({ e, distM: q.d, along: q.along, lat7: q.la, lon7: q.lo, brg: q.brg }); if (q.d < best) best = q.d;
          }
        }
      }
      if (best < Infinity && r * cellM >= best + windowM) break;
    }
    return out.filter(c => c.distM <= best + windowM).sort((a, b) => a.distM - b.distM);
  }
  // 吸附點的形式：在頂點上（沿邊 < 0.5 m）→ { vertex }；在邊的中間 → { e, f }（f＝從 u 起算的比例）
  endpoint(c) {
    const { E } = this.g, L = E.len[c.e];
    if (c.along <= 0.5 || L <= 1) return { vertex: E.u[c.e], lat7: this.g.V.lat[E.u[c.e]], lon7: this.g.V.lon[E.u[c.e]], distM: c.distM, e0: c.e };
    if (L - c.along <= 0.5) return { vertex: E.v[c.e], lat7: this.g.V.lat[E.v[c.e]], lon7: this.g.V.lon[E.v[c.e]], distM: c.distM, e0: c.e };
    return { e: c.e, f: c.along / L, lat7: c.lat7, lon7: c.lon7, distM: c.distM, brg: c.brg };
  }
  // 起點：離開吸附點後第一個到達的頂點；終點：要開進吸附點必經的頂點（障礙物可以當終點，但不能穿過它進到邊的中間）
  endVerts(pt, P, asStart, cost = P.cost) {
    const { E } = this.g, r = [];
    if (pt.vertex != null) {
      if (asStart && P.bar[pt.vertex]) { for (let k = this.outStart[pt.vertex]; k < this.outStart[pt.vertex + 1]; k++) if (cost[this.outArc[k]] < Infinity) r.push(this.head(this.outArc[k])); }   // 從障礙物上出發：可以離開
      else r.push(pt.vertex);
      return r;
    }
    const fw = cost[2 * pt.e] < Infinity, bw = cost[2 * pt.e + 1] < Infinity, u = E.u[pt.e], v = E.v[pt.e];
    if (asStart) { if (fw) r.push(v); if (bw) r.push(u); }
    else { if (fw && !P.bar[u]) r.push(u); if (bw && !P.bar[v]) r.push(v); }
    return r;
  }
  // 從 verts 出發（fwd）或能到達 verts（!fwd）的所有頂點；超過上限回傳 null（當成「應該到得了」）
  reachSet(verts, P, fwd, cap = 20000) {
    const seen = new Set(verts), q = [...verts];
    while (q.length) {
      const x = q.pop();
      if (fwd && P.bar[x]) continue;
      for (let k = this.outStart[x]; k < this.outStart[x + 1]; k++) {
        const a = this.outArc[k], y = this.head(a);
        if (fwd ? P.cost[a] === Infinity : (P.cost[a ^ 1] === Infinity || P.bar[y])) continue;
        if (!seen.has(y)) { seen.add(y); q.push(y); if (seen.size > cap) return null; }
      }
    }
    return seen;
  }
  // 選起訖吸附點：依距離和由小到大，取第一組「起點開得到終點」的組合（不考慮轉向限制）；都不行就用最近的兩點
  //   判斷方式：同一個強連通分量、或起點開得到主幹且主幹開得到終點 → 可以；否則在小區塊裡實際找一次（小區塊很小，很快）
  //   檢查的組合：兩端最近的各 12 條路段兩兩配對，加上每個島嶼（不分方向的連通區）裡「開得到主幹」最近的起點與「主幹開得到」最近的終點
  pickEnds(cs, ct, key) {
    const P = this.profile(key), C = this.components(key);
    const S = cs.map(c => this.endpoint(c)), T = ct.map(c => this.endpoint(c));
    const sv = S.map(p => this.endVerts(p, P, true)), tv = T.map(p => this.endVerts(p, P, false)), anc = new Map(), desc = new Map();
    const sCore = i => sv[i].some(x => C.toCore[x]), tCore = j => tv[j].some(y => C.fromCore[y]);
    const routable = (i, j) => {
      const a = S[i], b = T[j];
      if (a.e != null && a.e === b.e && ((P.cost[2 * a.e] < Infinity && b.f >= a.f) || (P.cost[2 * a.e + 1] < Infinity && b.f <= a.f))) return true;   // 同一條邊、順著可走的方向
      if (!sv[i].length || !tv[j].length) return false;
      if (sv[i].some(x => tv[j].some(y => C.comp[x] === C.comp[y]))) return true;
      if (C.wcc[sv[i][0]] !== C.wcc[tv[j][0]]) return false;                         // 不同島嶼（不分方向都不相連）
      const sc = sCore(i), tc = tCore(j);
      if (sc && tc) return true;
      if (!tc) { if (!anc.has(j)) anc.set(j, this.reachSet(tv[j], P, false)); const A = anc.get(j); return !A || sv[i].some(x => A.has(x)); }
      if (!desc.has(i)) desc.set(i, this.reachSet(sv[i], P, true)); const D = desc.get(i); return !D || tv[j].some(y => D.has(y));
    };
    const K = 12, pairs = [];
    for (let i = 0; i < Math.min(K, S.length); i++) for (let j = 0; j < Math.min(K, T.length); j++) pairs.push([S[i].distM + T[j].distM, i, j]);
    const gs = new Map(), gt = new Map();
    for (let i = 0; i < S.length; i++) if (sv[i].length && sCore(i)) { const w = C.wcc[sv[i][0]]; if (!gs.has(w)) gs.set(w, i); }
    for (let j = 0; j < T.length; j++) if (tv[j].length && tCore(j)) { const w = C.wcc[tv[j][0]]; if (!gt.has(w)) gt.set(w, j); }
    for (const [w, i] of gs) if (gt.has(w)) pairs.push([S[i].distM + T[gt.get(w)].distM, i, gt.get(w)]);
    pairs.sort((x, y) => x[0] - y[0]);
    const pick = pairs.find(([, i, j]) => routable(i, j));
    return { s: S[pick ? pick[1] : 0], t: T[pick ? pick[2] : 0], nearestFromM: S[0].distM, nearestToM: T[0].distM, routable: !!pick };   // routable＝false：連不考慮轉向限制都到不了
  }

  // 頂點 s → 頂點 t（測試、除錯用；結果與 route 的頂點版相同）
  routeVertices(s, t, key, opt = {}) {
    const { V } = this.g, r = this.routeCore({ vertex: s }, { vertex: t, lat7: V.lat[t], lon7: V.lon[t] }, key, opt);
    return r.segs && { arcs: r.segs.map(x => x.a), cost: r.cost, settled: r.settled };
  }
  // 以「有向邊」為狀態的 A*；S、T 可以是頂點或邊上的一點（{ e, f }）
  // opt.metric：'time'（預設，最快）或 'distance'（最短）；opt.startPen：Map(有向邊 → 秒)，出發方向的額外成本（例如要迴轉）；opt.noAlt：不用地標
  // 回傳 segs：[{ a, p0, p1 }]（沿著有向邊方向走的比例區間），第一段、最後一段可能只走一部分；找不到時 segs＝null
  routeCore(S, T, key, opt = {}) {
    const P = opt.P || this.profile(key), { V } = this.g, out = this.outArc, start = this.outStart, dist = opt.metric === 'distance', ov = opt.overlay || null;
    const cost = dist ? this.distCost(P) : P.cost, sPen = opt.startPen || null;
    if (++this.gen > 2e9) { this.stamp.fill(0); this.hStamp.fill(0); this.gen = 1; }
    const gen = this.gen, stamp = this.stamp, gc = this.gc, pred = this.pred, pq = new MinHeap(4096), tla = T.lat7, tlo = T.lon7, hS = this.hStamp, hV = this.hVal;
    if (S.vertex != null && S.vertex === T.vertex) return { segs: [], cost: 0, settled: 0 };
    const fin = [], first = new Map();                                                   // 抵達終點的候選（堆積裡存負數）；起點在邊中間時第一段的起始比例
    const tArcs = T.vertex == null ? new Map([[2 * T.e, T.f], [2 * T.e + 1, 1 - T.f]]) : null;
    // 啟發式：直線距離 ÷ 最高速度（最短距離時就是直線距離），有地標表時取兩者較大的
    const vmax = dist ? 1 : P.vmax, A = dist || opt.noAlt ? null : this.altFor(key);
    let altH = null;
    if (A) {
      const entries = T.vertex != null ? [T.vertex] : this.endVerts(T, P, false, cost), sv = S.vertex != null ? [S.vertex] : this.endVerts(S, P, true, cost);
      if (entries.length && sv.length) altH = this.altHeuristic(A, entries, sv);
    }
    const h = x => {
      if (hS[x] === gen) return hV[x];
      let v = distE7(V.lat[x], V.lon[x], tla, tlo) / vmax;
      if (altH) { const a = altH(x); if (a > v) v = a; }
      hS[x] = gen; hV[x] = v; return v;
    };
    const relax = (a, ga, b, pen, cb) => {
      if (tArcs && tArcs.has(b)) { const p = tArcs.get(b), c = ga + pen + cb * p; fin.push({ a, b, p0: 0, p1: p, cost: c }); pq.push(c, -fin.length); }
      const hb = h(this.head(b)); if (hb === Infinity) return;                       // 地標判斷：從這裡一定到不了終點
      const ng = ga + cb + pen;
      if (stamp[b] !== gen || ng < gc[b]) { stamp[b] = gen; gc[b] = ng; pred[b] = a; pq.push(ng + hb, b); }
    };
    if (S.vertex != null) {
      for (let k = start[S.vertex]; k < start[S.vertex + 1]; k++) { const b = out[k], o = ov && ov.get(b); if (o && o.block) continue; const c = cost[b] * (o ? o.factor : 1); if (c < Infinity) relax(-1, 0, b, sPen ? sPen.get(b) || 0 : 0, c); }
    } else {
      for (const [a, p0] of [[2 * S.e, S.f], [2 * S.e + 1, 1 - S.f]]) {
        const c = cost[a]; if (c === Infinity) continue;
        const pen = sPen ? sPen.get(a) || 0 : 0;
        if (tArcs && tArcs.has(a) && tArcs.get(a) >= p0) { const cc = pen + c * (tArcs.get(a) - p0); fin.push({ a: -1, b: a, p0, p1: tArcs.get(a), cost: cc }); pq.push(cc, -fin.length); }   // 起訖在同一條邊、順著方向
        const g0 = pen + c * (1 - p0); first.set(a, p0);
        const hb = h(this.head(a)); if (hb === Infinity) continue;
        if (stamp[a] !== gen || g0 < gc[a]) { stamp[a] = gen; gc[a] = g0; pred[a] = -1; pq.push(g0 + hb, a); }
      }
    }
    let settled = 0, endA = -1, endF = null;
    while (pq.n) {
      const [f, a] = pq.pop();
      if (a < 0) { endF = fin[-a - 1]; break; }
      const v = this.head(a), ga = gc[a];
      if (f - h(v) > ga + 1e-6) continue;                                            // 過期的項目
      settled++;
      if (T.vertex != null && v === T.vertex) { endA = a; break; }
      if (P.bar[v]) continue;                                                        // 不能穿過的障礙物
      const onlySet = P.only.get(a), noSet = P.no.get(a), vw = P.viaWay.get(a), fa = this.isFerry(a);
      let others = 0; for (let k = start[v]; k < start[v + 1]; k++) { const b = out[k]; if (b !== (a ^ 1) && cost[b] < Infinity) { others++; break; } }
      for (let k = start[v]; k < start[v + 1]; k++) {
        const b = out[k], o = ov && ov.get(b); if (o && o.block) continue;                 // 交通事件：封閉的路段不能走、其他事件依係數加成本
        const cb = o ? cost[b] * o.factor : cost[b]; if (cb === Infinity) continue;
        if (b === (a ^ 1) && others) continue;                                       // 迴轉：只在死路
        if (onlySet && !onlySet.has(b)) continue;
        if (noSet && noSet.has(b)) continue;
        if (vw && this.viaWayBlocks(vw, a, b, pred)) continue;
        const pen = dist ? 0 : this.turnS(P, a, b, v) + (!fa && this.isFerry(b) ? FERRY_BOARD_COST : 0);
        relax(a, ga, b, pen, cb);
      }
    }
    if (endA < 0 && !endF) return { segs: null, settled };
    const segs = [], push = a => { for (; a >= 0; a = pred[a]) segs.push({ a, p0: pred[a] < 0 && first.has(a) ? first.get(a) : 0, p1: 1 }); };
    if (endF) { push(endF.a); segs.reverse(); segs.push({ a: endF.b, p0: endF.p0, p1: endF.p1 }); return { segs, cost: endF.cost, settled }; }
    push(endA); segs.reverse(); return { segs, cost: gc[endA], settled };
  }
  // via way 限制：往回看已走過的有向邊是否正好是 from → via…；是的話 no_* 擋下 to、only_* 只准 to
  viaWayBlocks(rules, a, b, pred) {
    for (const r of rules) {
      let x = a, ok = true;
      for (let i = r.viaArcs.length - 1; i >= 0 && ok; i--) { if (x !== r.viaArcs[i]) ok = false; else x = pred[x]; }
      if (!ok || x !== r.from) continue;
      if (r.kind === 'no' && b === r.to) return true;
      if (r.kind === 'only' && b !== r.to) return true;
    }
    return false;
  }
  // 出發方向：給了行進方向（heading，度）時，跟方向差超過 100° 的出發邊要先迴轉 → 加上迴轉時間
  startPenalty(s, P, heading) {
    if (heading == null || heading === '' || !Number.isFinite(+heading)) return null;
    const m = new Map(), pen = P.D.uturn + 15, tg = this.turnGeo();
    if (s.e != null) { if (s.brg != null) { if (angDiff(+heading, s.brg) > 100) m.set(2 * s.e, pen); if (angDiff(+heading, s.brg + 180) > 100) m.set(2 * s.e + 1, pen); } }
    else for (let k = this.outStart[s.vertex]; k < this.outStart[s.vertex + 1]; k++) { const b = this.outArc[k]; if (angDiff(+heading, tg.outB[b] * 360 / 256) > 100) m.set(b, pen); }
    return m.size ? m : null;
  }
  // 經緯度 → 經緯度；回傳距離、時間、座標、經過的 way、導航步驟、分段時間與警告
  // metric：'time'（最快，預設）／'distance'（最短）；heading：目前行進方向（偏航重新規劃時用，避免一出發就要迴轉）
  // at：出發時間（毫秒）→ 依時間判斷有條件的轉向限制；overlay：Map(有向邊 → { block, factor, timeFactor, events })，交通事件（server/traffic/events.mjs）
  route({ from, to, profile = 'car', metric = 'time', heading = null, noAlt = false, at = null, overlay = null }) {
    const cs = this.snapCandidates(from[0], from[1], profile), ct = this.snapCandidates(to[0], to[1], profile);
    if (!cs.length || !ct.length) return { error: 'NO_NEARBY_ROAD', message: '起點或終點附近沒有這種運具可用的道路' };
    const P = at != null ? this.profileAt(profile, at) : this.profile(profile), { s, t, nearestFromM, nearestToM, routable } = this.pickEnds(cs, ct, profile);
    const snap = { fromM: +s.distM.toFixed(1), toM: +t.distM.toFixed(1), from: [s.lat7 / 1e7, s.lon7 / 1e7], to: [t.lat7 / 1e7, t.lon7 / 1e7] };
    if (s.distM - nearestFromM > 1) snap.fromNearestM = +nearestFromM.toFixed(1);   // 最近的路段到不了／出不去，改吸附到較遠、能互通的路段
    if (t.distM - nearestToM > 1) snap.toNearestM = +nearestToM.toFixed(1);
    if (!routable) return { error: 'NO_ROUTE', message: '找不到路線：起點和終點不相連（不同島嶼且沒有這種運具可搭的渡輪，或被單行／禁行道路隔開）', snap, settled: 0 };
    const startPen = this.startPenalty(s, P, heading);
    const r = this.routeCore(s, t, profile, { metric, startPen, noAlt, P, overlay });
    if (!r.segs) return { error: 'NO_ROUTE', message: '找不到路線（可能在不同島嶼、或被單行／禁行／轉向限制隔開）', snap, settled: r.settled };
    const pen0 = startPen && r.segs.length ? startPen.get(r.segs[0].a) || 0 : 0;
    return { ...this.describe(r.segs, profile, { startPenS: pen0, P, overlay }), metric, snap, settled: r.settled, costS: +r.cost.toFixed(1) };
  }
  // 切出一條邊的一段幾何（順著 way 方向，從 fs 到 fe 公尺）
  cut(e, fs, fe) {
    const { E, G } = this.g, g0 = E.goff[e], g1 = E.goff[e + 1], pts = [];
    const at = s => { for (let k = g0; k < g1 - 1; k++) if (G.cum[k + 1] >= s) { const L = G.cum[k + 1] - G.cum[k], t = L > 0 ? (s - G.cum[k]) / L : 0; return [(G.lon[k] + t * (G.lon[k + 1] - G.lon[k])) / 1e7, (G.lat[k] + t * (G.lat[k + 1] - G.lat[k])) / 1e7]; } return [G.lon[g1 - 1] / 1e7, G.lat[g1 - 1] / 1e7]; };
    pts.push(at(fs)); for (let k = g0; k < g1; k++) if (G.cum[k] > fs && G.cum[k] < fe) pts.push([G.lon[k] / 1e7, G.lat[k] / 1e7]); pts.push(at(fe));
    return pts;
  }
  // 路線說明：arcs 可以是有向邊陣列（整段）或 routeCore 的 segs（含部分）
  // 回傳：距離、時間、座標（[經度, 緯度]）、經過的 way、導航步驟（steps，index 指向 coords）、
  //       分段時間 timing（segS：每段行駛秒數、segCls：道路類別、segKnown：速限已知、segWay：屬於 ways 的第幾條、delays：[座標序號, 秒]，給網頁導航的 ETA 模型）、渡輪、警告
  describe(arcs, key, { startPenS = 0, P: P0 = null, overlay = null } = {}) {
    const segs = arcs.map(x => typeof x === 'number' ? { a: x, p0: 0, p1: 1 } : x);
    const P = P0 || this.profile(key), { E, W } = this.g, coords = [], ways = [], steps = [], ferries = [], evHit = new Map();
    const warn = { unknownM: 0, limitedM: 0, conditionalM: 0, defaultAllowedM: 0, unknownSpeedM: 0, ferryM: 0, pierLinkM: 0 };
    const segS = [], segCls = [], segKnown = [], segWay = [], delays = [];
    let dist = 0, drive = 0, delay = startPenS, sinceStep = 0;
    if (startPenS > 0) delays.push([0, +startPenS.toFixed(1)]);
    for (let i = 0; i < segs.length; i++) {
      const { a, p0, p1 } = segs[i], e = a >> 1, w = E.way[e], s = this.status(a, P.pi), part = p1 - p0, L = E.len[e] * part, fer = this.isFerry(a), lim = this.limitOf(a);
      dist += L;
      const v = s & 7; if (v === ST.UNKNOWN) warn.unknownM += L; else if (v === ST.LIMITED) warn.limitedM += L; else if (v === ST.DEFAULT_ALLOWED) warn.defaultAllowedM += L; if (s & COND) warn.conditionalM += L;
      if (fer) warn.ferryM += L; else if (W.hw[w] === this.pierHw) warn.pierLinkM += L; else if (key !== 'foot' && key !== 'bike' && !lim.src) warn.unknownSpeedM += L;
      // 經過頂點：延遲＋導航步驟
      if (i) {
        const pa = segs[i - 1].a, at = coords.length - 1, d = this.turnS(P, pa, a, this.tail(a));
        if (d > 0.05) { delays.push([at, +d.toFixed(1)]); delay += d; }
        const ang = this.turnAngle(pa, a), ad = Math.abs(ang), inN = this.wayName(E.way[pa >> 1]), outN = this.wayName(w);
        if (fer && !this.isFerry(pa)) {
          const fs = W.ferryS ? W.ferryS[w] : NaN;
          ferries.push({ name: outN, fromStartM: Math.round(dist - L), source: Number.isFinite(fs) ? 'OSM duration' : '依平均航速推估', m: 0, t: 0 });
          steps.push({ index: at, type: 'ferry', dir: '', road: outN || '渡輪', angle: 0, fromStartM: Math.round(dist - L), distanceFromPrev: Math.round(sinceStep), at: coords[at] }); sinceStep = 0;
        } else if (!(ad <= TURN.straight && inN === outN)) {
          const type = pa === (a ^ 1) ? 'uturn' : ad < TURN.straight ? 'straight' : ad < TURN.slight ? 'slight' : ad < TURN.turn ? 'turn' : ad < TURN.sharp ? 'sharp' : 'uturn';
          steps.push({ index: at, type, dir: type === 'straight' ? '' : ang > 0 ? 'right' : 'left', road: outN, angle: Math.round(-ang), fromStartM: Math.round(dist - L), distanceFromPrev: Math.round(sinceStep), at: coords[at] }); sinceStep = 0;
        }
      } else steps.push({ index: 0, type: 'start', dir: '', road: this.wayName(w), angle: 0, fromStartM: 0, distanceFromPrev: 0 });
      sinceStep += L;
      // 幾何：依長度把這段的時間分給每一小段
      const EL = E.len[e], pts = a & 1 ? this.cut(e, EL * (1 - p1), EL * (1 - p0)).reverse() : this.cut(e, EL * p0, EL * p1), ovE = overlay && overlay.get(a), t = P.time[a] * part * (ovE && ovE.timeFactor ? ovE.timeFactor : 1);
      if (ovE) for (const id of ovE.events || []) { const h = evHit.get(id) || { m: 0, extraS: 0 }; h.m += L; h.extraS += P.time[a] * part * ((ovE.timeFactor || 1) - 1); evHit.set(id, h); }
      drive += t; if (fer && ferries.length) { const fy = ferries[ferries.length - 1]; fy.m += L; fy.t += t; }
      const add = [];
      for (const q of pts) { const z = add.length ? add[add.length - 1] : coords[coords.length - 1]; if (z && Math.abs(z[0] - q[0]) < 1e-9 && Math.abs(z[1] - q[1]) < 1e-9) continue; add.push(q); }
      const wid = W.id[w]; if (!ways.length || ways[ways.length - 1].id !== wid) ways.push({ id: wid, name: this.g.strings[W.name[w]] || '', ref: this.g.strings[W.ref[w]] || '', highway: HIGHWAYS[W.hw[w]], m: 0, limitKmh: fer ? null : Math.round(lim.kmh), limitSrc: fer ? 'ferry' : lim.src || 'class' });
      ways[ways.length - 1].m += L; const wi = ways.length - 1;
      let base = coords.length ? coords[coords.length - 1] : null, gl = 0; const pl = [];
      for (const q of add) { const l = base ? hav(base[0], base[1], q[0], q[1]) : 0; pl.push(l); gl += l; base = q; }
      for (let j = 0; j < add.length; j++) {
        const had = coords.length; coords.push(add[j]); if (!had) continue;
        segS.push(gl > 0 ? t * pl[j] / gl : 0); segCls.push(fer ? 7 : this.wcls[w]); segKnown.push(fer || lim.src ? 1 : 0); segWay.push(wi);
      }
      if (!(gl > 0) && t > 0.05) delays.push([Math.max(0, coords.length - 1), +t.toFixed(1)]);   // 長度 0 的段：時間記在這一點
    }
    if (coords.length) steps.push({ index: coords.length - 1, type: 'arrive', dir: '', road: segs.length ? this.wayName(E.way[segs[segs.length - 1].a >> 1]) : '', angle: 0, fromStartM: Math.round(dist), distanceFromPrev: Math.round(sinceStep), at: coords[coords.length - 1] });
    for (const k in warn) warn[k] = Math.round(warn[k]);
    const roads = []; for (const w of ways) { const n = w.name || w.ref; if (n && roads[roads.length - 1] !== n) roads.push(n); }
    return { profile: key, distanceM: Math.round(dist), durationS: Math.round(drive + delay), driveS: Math.round(drive), delayS: Math.round(delay), arcs: segs.map(x => x.a), coords,
      ways: ways.map(w => ({ ...w, m: Math.round(w.m) })), roads, steps,
      timing: { segS: segS.map(x => +x.toFixed(2)), segCls, segKnown, segWay, delays },
      ferries: ferries.map(f => ({ name: f.name, fromStartM: f.fromStartM, m: Math.round(f.m), durationS: Math.round(f.t), source: f.source, note: '不含候船與班次時間，請查詢航運公司班表' })),
      warnings: warn, conditionalRestrictionsIgnored: P.condSkipped, conditionalRestrictions: P.condAt || null,
      events: [...evHit].map(([id, h]) => ({ id, m: Math.round(h.m), extraS: Math.round(h.extraS) })) };
  }
}
