// hmm-match.js — MapMatcher（v1.11）：隱藏式馬可夫模型（HMM）把 GPS 對到「已規劃路線」上的位置
//
// 為什麼：只取「視窗內最近的線段」（RouteTrack.match）在路線靠近自己時會跳——例如去回走同一條分隔道路（兩側車道相距 10～20 m）、
//   繞一圈回到附近、高架與平面都在路線上。GPS 誤差 5～15 m 時，最近的那一段常常是「另一個方向」。低速或停止時 GPS 方向不可靠，也不能靠方向分辨。
// 作法（Newson & Krumm 2009 的路線版）：
//   狀態＝路線上的候選位置（沿線距離 s；每個線段在誤差範圍內的投影點，相距 < 12 m 的合併）＋「偏離路線」狀態
//   發射機率：離路線的距離 ~ 常態分布（σ＝max(4 m, GPS 精度)）；速度夠快且方向可信時，方向差越大機率越低；低速時不用方向
//   轉移機率：沿路線前進的距離 與 兩筆 GPS 之間移動的距離（或 速度×時間）越接近越可能（指數分布）；倒退大幅扣分
//   線上維特比（Viterbi）：每筆定位更新所有狀態的最佳累積分數，取目前最可能的狀態（不需要未來的定位）
// 純計算，不碰 DOM；route 的座標由 RouteTrack 提供（公尺座標 px/py、累積距離 cum）
import { angDiff } from './gps-filter.js';

export const HMM = { winBack: 80, winAhead: 400, maxDistM: 60, mergeM: 12, betaMin: 8, backPenaltyPerM: 0.05, offLogStay: Math.log(0.92), offLogEnter: Math.log(0.03), offLogLeave: Math.log(0.25), headMinMps: 3, headSigmaDeg: 35 };

export class HmmRouteMatcher {
  constructor(track, o = {}) { this.T = track; this.o = { ...HMM, ...o }; this.reset(); }
  reset() { this.states = null; this.last = null; this.steps = 0; }
  // 在 [s0, s1] 範圍內找候選：每個線段的投影點，距離 ≤ maxD
  _candidates(mx, my, s0, s1, maxD) {
    const T = this.T, i0 = T._segAt(Math.max(0, s0)), i1 = Math.min(T.n - 2, T._segAt(Math.min(T.total, s1))), out = [];
    for (let i = i0; i <= i1; i++) {
      const ax = T.px[i], ay = T.py[i], dx = T.px[i + 1] - ax, dy = T.py[i + 1] - ay, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / L2)) : 0, qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(mx - qx, my - qy);
      if (d > maxD) continue;
      const s = T.cum[i] + (T.cum[i + 1] - T.cum[i]) * t, prev = out[out.length - 1];
      if (prev && Math.abs(prev.s - s) < this.o.mergeM) { if (d < prev.d) Object.assign(prev, { s, d, seg: i, qx, qy }); continue; }
      out.push({ s, d, seg: i, qx, qy });
    }
    return out;
  }
  // fix：{ mx, my（路線的公尺座標）, accuracy, heading, speed, t（毫秒）}；hintS：引擎目前的進度（第一次用來限制搜尋範圍）
  step(fix, hintS = 0) {
    const o = this.o, T = this.T, sig = Math.max(4, fix.accuracy || 10), maxD = Math.max(o.maxDistM, 3 * sig);
    const base = this.states ? Math.max(...this.states.filter(x => !x.off).map(x => x.s), hintS) : hintS;
    let cands = this._candidates(fix.mx, fix.my, (this.states ? Math.min(...this.states.filter(x => !x.off).map(x => x.s).concat(base)) : hintS) - o.winBack, base + o.winAhead + (fix.speed || 0) * 3, maxD);
    if (!cands.length && !this.states) cands = this._candidates(fix.mx, fix.my, 0, T.total, maxD);       // 第一筆、視窗內沒有：全線找
    const useHead = fix.heading != null && (fix.speed || 0) >= o.headMinMps;
    const emit = c => { let lp = -0.5 * (c.d / sig) ** 2; if (useHead) { const a = angDiff(fix.heading, T.segBearing(Math.min(c.seg, T.n - 2))); lp += -0.5 * (a / o.headSigmaDeg) ** 2; } return lp; };
    const offEmit = -0.5 * 2.5 ** 2 - 0.5;                                                           // 「偏離」：相當於離路線 2.5σ 的機率
    const moved = this.last ? Math.hypot(fix.mx - this.last.mx, fix.my - this.last.my) : 0, dt = this.last && fix.t != null && this.last.t != null ? Math.max(0.2, (fix.t - this.last.t) / 1000) : 1;
    // 預期沿路線前進的距離：有 GPS 速度就用速度×時間（兩筆定位之間的直線位移含雜訊，低速時會被雜訊放大）；沒有才用位移
    const expect = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed * dt : moved, beta = Math.max(o.betaMin, 0.5 * expect + 0.5 * sig);
    const next = cands.map(c => ({ ...c, off: false, lp: -Infinity, from: -1 })); next.push({ off: true, lp: -Infinity, from: -1 });
    if (!this.states) { for (const x of next) x.lp = x.off ? offEmit + o.offLogEnter : emit(x); }
    else {
      for (const x of next) {
        let best = -Infinity, bi = -1;
        this.states.forEach((p, pi) => {
          let tr;
          if (p.off && x.off) tr = o.offLogStay; else if (p.off) tr = o.offLogLeave; else if (x.off) tr = o.offLogEnter;
          else { const ds = x.s - p.s; tr = -Math.abs(ds - expect) / beta - (ds < -sig ? (-ds - sig) * o.backPenaltyPerM : 0); }
          const v = p.lp + tr; if (v > best) { best = v; bi = pi; }
        });
        x.lp = best + (x.off ? offEmit : emit(x)); x.from = bi;
      }
    }
    const mx = Math.max(...next.map(x => x.lp)); for (const x of next) x.lp -= mx;                    // 正規化，避免數值往下溢
    this.states = next.filter(x => x.lp > -40); this.last = { mx: fix.mx, my: fix.my, t: fix.t }; this.steps++;
    const top = this.states.reduce((a, b) => (b.lp > a.lp ? b : a)), on = this.states.filter(x => !x.off), bestOn = on.length ? on.reduce((a, b) => (b.lp > a.lp ? b : a)) : null;
    const pOff = Math.exp(this.states.find(x => x.off)?.lp ?? -Infinity) / this.states.reduce((a, x) => a + Math.exp(x.lp), 0);
    if (!bestOn) return { off: true, pOff: 1, s: hintS, offset: Infinity };
    return { off: top.off, pOff, s: bestOn.s, offset: bestOn.d, seg: bestOn.seg, qx: bestOn.qx, qy: bestOn.qy, bearing: T.segBearing(Math.min(bestOn.seg, T.n - 2)), candidates: on.length };
  }
}
