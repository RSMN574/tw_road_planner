// mapmatch.js — Map Matching
// ① RouteTrack：把 GPS 吸附到「已規劃的路線」上，算出沿路線的進度（導航用，最穩）
// ② matchToRoad：把 GPS 吸附到整張道路圖的邊（偏航後重新規劃、顯示目前道路用），考慮方向與連通性
// 高程：資料中沒有高程／立體交叉資訊，無法排除高架與平面道路的錯誤連接（見 README 限制）
import { State } from './state.js';
import { isGeo, lonLatToWorld, worldDistM } from './geo.js';
import { angDiff, bearingOf } from './gps-filter.js';
import { edgeRoad, findNearestNode, snapEdge } from './graph-core.js';

export class RouteTrack {
  constructor(route) {
    const c = route.coords, n = c.length; this.x0 = c[0][0]; this.y0 = c[0][1];
    this.kx = isGeo() ? Math.cos(this.y0 * Math.PI / 180) * 111320 : State.projUnit; this.ky = isGeo() ? 110574 : State.projUnit;
    this.px = new Float64Array(n); this.py = new Float64Array(n); this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      [this.px[i], this.py[i]] = this.worldToM(c[i][0], c[i][1]);
      if (i) this.cum[i] = this.cum[i-1] + Math.hypot(this.px[i] - this.px[i-1], this.py[i] - this.py[i-1]);
    }
    this.n = n; this.total = this.cum[n - 1];
  }
  worldToM(x, y) { return [(x - this.x0) * this.kx, (y - this.y0) * this.ky]; }
  mToWorld(mx, my) { return [this.x0 + mx / this.kx, this.y0 + my / this.ky]; }
  toLocal(lon, lat) { const [x, y] = lonLatToWorld(lon, lat); return this.worldToM(x, y); }
  segBearing(i) { return bearingOf(this.px[i+1] - this.px[i], this.py[i+1] - this.py[i]); }
  // 在視窗 [hintS-back, hintS+ahead]（公尺）內找最佳線段；視窗內都很遠（>lostM）才退回全線搜尋
  match(mx, my, o = {}) {
    const { hintS = 0, back = 40, ahead = 300, heading = null, speed = 0, lostM = 80 } = o;
    const best = (lo, hi, useHeading) => {
      let b = null; const i0 = this._segAt(Math.max(0, lo)), i1 = Math.min(this.n - 2, this._segAt(Math.min(this.total, hi)));
      for (let i = i0; i <= i1; i++) {
        const ax = this.px[i], ay = this.py[i], dx = this.px[i+1] - ax, dy = this.py[i+1] - ay, L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / L2)) : 0, qx = ax + dx * t, qy = ay + dy * t, off = Math.hypot(mx - qx, my - qy);
        let score = off;
        if (useHeading && heading != null && speed >= 2 && L2 > 4) score += Math.max(0, angDiff(heading, this.segBearing(i)) - 60) * 0.3;   // 方向相反的線段扣分（最多約 36 公尺當量）
        if (!b || score < b.score) b = { score, seg: i, t, off, qx, qy, s: this.cum[i] + (this.cum[i+1] - this.cum[i]) * t };
      }
      return b;
    };
    let m = best(hintS - back, hintS + ahead, true);
    if (!m || m.off > lostM) { const g = best(0, this.total, true); if (g && (!m || g.off < m.off - 20)) m = g; }
    return { s: m.s, offset: m.off, seg: m.seg, qx: m.qx, qy: m.qy, bearing: this.segBearing(Math.min(m.seg, this.n - 2)) };
  }
  _segAt(s) { let lo = 0, hi = this.n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= s) lo = mid; else hi = mid; } return lo; }
  at(s) { const i = Math.min(this.n - 2, this._segAt(Math.max(0, Math.min(this.total, s)))), L = this.cum[i+1] - this.cum[i], t = L > 0 ? (s - this.cum[i]) / L : 0; return [this.px[i] + (this.px[i+1] - this.px[i]) * t, this.py[i] + (this.py[i+1] - this.py[i]) * t]; }
}

// 整張圖的邊匹配：候選 = 最近節點與其相鄰節點發出的邊；分數 = 距離 + 方向懲罰 − 連通性加成
export function matchToRoad(lon, lat, o = {}) {
  const { heading = null, speed = 0, accuracy = 20, prevEdge = -1 } = o;
  const [x, y] = lonLatToWorld(lon, lat), k = findNearestNode(x, y); if (k < 0) return null;
  const cand = new Set([k]); for (let e = State.adjOffset[k]; e < State.adjOffset[k+1]; e++) cand.add(State.adjTo[e]);
  let best = null;
  for (const u of cand) {
    const s = snapEdge(x, y, u); if (s.edge < 0) continue;
    const bx = State.nodeXY[s.v*5+2] - State.nodeXY[u*5+2], by = State.nodeXY[s.v*5+3] - State.nodeXY[u*5+3], kx = isGeo() ? Math.cos(y * Math.PI / 180) : 1;
    let score = s.dm;
    if (heading != null && speed >= 2) score += Math.max(0, angDiff(heading, bearingOf(bx * kx, by)) - 60) * 0.4;     // 逆向（單行道相反方向）的邊扣分
    if (prevEdge >= 0 && (s.edge === prevEdge || u === State.adjTo[prevEdge])) score -= 6;                            // 與上一條邊連通 → 加成，避免在平行道路間跳動
    if (!best || score < best.score) best = { score, edge: s.edge, u, v: s.v, dm: s.dm, px: s.px, py: s.py };
  }
  if (!best) return null;
  return { ...best, roadName: edgeRoad(best.edge), ok: best.dm <= Math.max(30, 2 * accuracy), node: k };
}
