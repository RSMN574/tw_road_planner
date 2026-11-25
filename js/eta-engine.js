// eta-engine.js — 導航 ETA：分段旅行時間模型 ＋ 平滑器
//
// 剩餘時間 = Σ(路段長度 ÷ 路段預估速度) ＋ 轉向延遲 ＋ 路口等待 ＋ 交通延遲（目前 0：沒有即時路況資料，不假造）
//   路段預估速度：速限（缺資料時依道路類別推估）× 該運具在該類道路的「平均／速限」比例（基礎模型，保守）
//                 有本機歷史紀錄（自己開過的路段實測速度）時與模型加權平均
//   近程修正：前方 150～600 m 依實際移動速度微調（權重 50%，且限制在模型的 0.6～1.6 倍內），不是只拿 GPS 速度去除剩餘距離
//   本趟修正：已走 ≥500 m 後，以「本趟實際耗時 ÷ 模型耗時」修正遠程（權重最多 50%，比例限制 0.7～1.8）
//   停等：停在路口前時，已等待的時間從該路口的預估等待中扣掉（ETA 在預期範圍內不跳動）
// 不確定範圍：路段變異（市區 30%、快速道路 15～18%）＋ 路口與轉向變異，加上 10% 系統偏差；可信度依相對不確定度與資料完整度
// 所有參數都是「基礎模型假設」，介面會標示；有真實行程紀錄後可用 tools/eta-eval.mjs 驗證與調整
import { State } from './state.js';
import { worldHaversine } from './geo.js';

// 參數表（FLOW、DELAY、CV）放在 eta-params.js：伺服器端的 OSM 路線搜尋也用同一套，路線時間與導航 ETA 一致
// （要用參數表請直接 import eta-params.js；build.mjs 的單檔打包不支援 export … from）
import { FLOW, DELAY, CV } from './eta-params.js';

function turnDelay(D, m) {
  if (!m) return 0; const L = m.dir === 'left';
  switch (m.turnType) { case 'turn': return L ? D.left : D.right; case 'slight': return L ? D.slightL : D.slightR; case 'sharp': return L ? D.sharpL : D.sharpR; case 'uturn': return D.uturn; default: return 0; }
}

// 一條路線的模型（規劃完成時建一次；之後每筆 GPS 只做 O(log n) 查表＋前方幾段的近程修正）
// track：RouteTrack（幾何累積距離）；maneuvers：generateManeuvers 的結果；history：{ get(eid) → {mps, n} }（可省略）
export class EtaModel {
  constructor(route, track, maneuvers, vk = 'car', history = null) {
    this._initOsm(route, track, maneuvers, vk, history);           // v1.18：只有伺服器的 OSM 路線（舊路網的本機模型已移除）
  }
  // 伺服器 OSM 路線：每段行駛時間（timing.segS）、路口與轉彎延遲（timing.delays：[座標序號, 秒]）由伺服器用同一套參數算好；
  // 這裡只補上：真實長度（大圓距離）、變異（CV 依道路類別）、本機歷史速度（以 OSM way id 為鍵）
  _initOsm(route, track, maneuvers, vk, history) {
    const sr = route._osm, T = sr.timing || {}, n = track.n, ll = route._ll, segS = T.segS || [], segCls = T.segCls || [], segKnown = T.segKnown || [], dAt = new Float64Array(n);
    this.vk = vk; this.track = track; this.n = n; this.lenSrc = 'OSM 道路幾何（大圓距離）';
    for (const [i, d] of T.delays || []) if (n > 1) dAt[Math.min(n - 1, Math.max(1, i))] += d;                // 起點的延遲（例如要先迴轉）記在第一個節點
    this.realCum = new Float64Array(n); this.cumT = new Float64Array(n); this.cumD = new Float64Array(n); this.cumVar = new Float64Array(n); this.cumSys = new Float64Array(n); this.edgeT = new Float64Array(Math.max(1, n - 1));
    let known = 0, hist = 0, junc = 0;
    for (let i = 0; i < n - 1; i++) {
      const L = worldHaversine(ll[i][0], ll[i][1], ll[i + 1][0], ll[i + 1][1]), cl = segCls[i] ?? 0; let t = segS[i] ?? L / 10;
      const key = route._segKey ? route._segKey(i) : null, h = history && key ? history.get(key) : null;
      if (h && h.n >= 2 && h.mps > 0.5 && L > 0 && t > 0) { const w = Math.min(h.n, 10), v = (w * h.mps + 3 * (L / t)) / (w + 3); t = L / v; hist += L; }
      if (segKnown[i]) known += L;
      this.edgeT[i] = t; this.realCum[i + 1] = this.realCum[i] + L; this.cumT[i + 1] = this.cumT[i] + t;
      this.cumVar[i + 1] = this.cumVar[i] + ((CV[cl] ?? 0.3) * t) ** 2; this.cumSys[i + 1] = this.cumSys[i] + 0.1 * t;
      const d = dAt[i + 1]; this.cumD[i + 1] = this.cumD[i] + d; if (d > 0) { this.cumVar[i + 1] += (0.6 * d) ** 2; junc++; }
    }
    this.nodeDelay = i => this.cumD[i] - this.cumD[i - 1];
    this.total = this.realCum[n - 1]; this.totalT = this.cumT[n - 1] + this.cumD[n - 1];
    const turns = (maneuvers || []).filter(m => ['slight', 'turn', 'sharp', 'uturn'].includes(m.turnType)).length;
    this.coverage = { limitKnown: this.total ? known / this.total : 0, history: this.total ? hist / this.total : 0, turns, junctions: junc, length: this.lenSrc };
  }
  // 幾何進度 s（RouteTrack 的公尺）→ 段號 i 與段內比例 f
  _seg(s) { const T = this.track, i = Math.min(this.n - 2, T._segAt(Math.max(0, Math.min(T.total, s)))), L = T.cum[i + 1] - T.cum[i]; return [i, L > 0 ? Math.min(1, Math.max(0, (s - T.cum[i]) / L)) : 0]; }
  // 沿路線的真實距離（剩餘距離用這個，不用直線）
  distAt(s) { const [i, f] = this._seg(s); return this.realCum[i] + (this.realCum[i + 1] - this.realCum[i]) * f; }
  remainingM(s) { return Math.max(0, this.total - this.distAt(s)); }
  // 模型累積行駛時間（不含延遲）
  driveAt(s) { const [i, f] = this._seg(s); return this.cumT[i] + this.edgeT[i] * f; }
  // ctx：{ vObs（m/s，近期沿路線的實際速度）, tripRatio, tripW, stoppedS, stopNodeIdx }
  remaining(s, ctx = {}) {
    const [i, f] = this._seg(s), n = this.n, drive = this.cumT[n - 1] - (this.cumT[i] + this.edgeT[i] * f);
    const passed = f >= 0.999 ? i + 1 : i, delays = this.cumD[n - 1] - this.cumD[passed];                // 還沒經過的節點延遲
    // 近程：前方 nearD 公尺依實際速度修正（只修正行駛時間，不改延遲）
    let near = 0, nearM = 0, nearT = 0;
    if (ctx.vObs >= 3) {
      const target = Math.min(600, Math.max(150, ctx.vObs * 30)), d0 = this.distAt(s);
      for (let j = i; j < n - 1 && nearM < target; j++) {
        const a = j === i ? d0 : this.realCum[j], b = this.realCum[j + 1], use = Math.min(b - a, target - nearM); if (use <= 0) continue;
        nearM += use; nearT += this.edgeT[j] * use / Math.max(1e-6, this.realCum[j + 1] - this.realCum[j]);
      }
      if (nearT > 0) { const tObs = Math.min(1.6 * nearT, Math.max(0.6 * nearT, nearM / ctx.vObs)); near = 0.5 * (tObs - nearT); }
    }
    // 遠程：本趟比例
    const far = Math.max(0, drive - nearT), trip = ctx.tripRatio && ctx.tripW ? far * ctx.tripW * (Math.min(1.8, Math.max(0.7, ctx.tripRatio)) - 1) : 0;
    // 停等：停在路口前，等待時間抵掉該路口的預估延遲
    let waitUsed = 0; if (ctx.stoppedS > 0 && ctx.stopNodeIdx > 0 && ctx.stopNodeIdx > passed - 1) waitUsed = Math.min(ctx.stoppedS, this.cumD[ctx.stopNodeIdx] - this.cumD[ctx.stopNodeIdx - 1]);
    const rem = Math.max(0, drive + near + trip + delays - waitUsed);
    // 不確定範圍（約 80% 區間）
    const sdRand = Math.sqrt(Math.max(0, this.cumVar[n - 1] - (this.cumVar[i] + (this.cumVar[i + 1] - this.cumVar[i]) * f))), sd = sdRand + (this.cumSys[n - 1] - this.cumSys[i] - 0.1 * this.edgeT[i] * f);
    const rel = rem > 0 ? sd / rem : 0, cov = this.coverage.limitKnown;
    const confidence = rel < 0.15 && cov >= 0.6 ? 'high' : rel < 0.3 ? 'medium' : 'low';
    return { remainingS: rem, lowS: Math.max(0, rem - 1.28 * sd), highS: rem + 1.28 * sd, confidence,
      parts: { drive: Math.round(drive), delays: Math.round(delays), nearAdj: Math.round(near), tripAdj: Math.round(trip), waitUsed: Math.round(waitUsed), traffic: 0 } };
  }
  // 進度前方最近、且在 maxM 內的「有延遲的節點」（停等扣除用）
  nextDelayNode(s, maxM = 50) { const [i] = this._seg(s), d0 = this.distAt(s); for (let j = i + 1; j < this.n - 1; j++) { if (this.realCum[j] - d0 > maxM) break; if (this.cumD[j] - this.cumD[j - 1] > 0) return j; } return -1; }
}

// ETA 顯示平滑：小變動慢慢跟、持續同方向的大變動快速跟上、單筆異常不採用
export class EtaSmoother {
  constructor() { this.reset(); }
  reset() { this.shown = null; this.updatedAt = null; this.dir = 0; this.n = 0; }
  // rawArrivalMs：本次估算的抵達時刻；remS：本次估算的剩餘秒數；ok：這筆定位可信才更新
  update(rawArrivalMs, nowMs, remS, ok = true) {
    if (!ok || !isFinite(rawArrivalMs)) return this.shown;
    if (this.shown == null) { this.shown = rawArrivalMs; this.updatedAt = nowMs; return this.shown; }
    const d = rawArrivalMs - this.shown, band = Math.max(20e3, remS * 30), big = Math.max(120e3, remS * 200);   // 死區：20 秒或剩餘的 3%；大變動：2 分鐘或 20%
    const sg = Math.sign(d);
    if (Math.abs(d) > band) { this.n = sg === this.dir ? this.n + 1 : 1; this.dir = sg; } else { this.n = 0; this.dir = 0; }
    const a = Math.abs(d) <= band ? 0.08 : (this.n >= 3 || (Math.abs(d) > big && this.n >= 2)) ? 0.6 : 0.2;
    this.shown += d * a; if (this.shown < nowMs) this.shown = nowMs; this.updatedAt = nowMs;
    return this.shown;
  }
}

// 計算一趟的「本趟比例」：實際移動時間 ÷ 模型行駛時間（含延遲），只在走了 ≥500 m 後才用；權重隨距離增加，最多 50%
export function tripFactor(model, s0, s1, actualS) {
  const m = model.driveAt(s1) - model.driveAt(s0), [i0] = model._seg(s0), [i1] = model._seg(s1), dly = model.cumD[i1] - model.cumD[i0], plan = m + dly, dist = model.distAt(s1) - model.distAt(s0);
  if (dist < 500 || plan < 30) return { ratio: 1, w: 0 };
  return { ratio: actualS / plan, w: Math.min(0.5, dist / 4000) };
}
