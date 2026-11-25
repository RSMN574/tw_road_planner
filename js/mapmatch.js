// mapmatch.js — Map Matching
// ① RouteTrack：把 GPS 吸附到「已規劃的路線」上，算出沿路線的進度（導航用，最穩）
// （v1.18：舊路網的整張圖邊匹配 matchToRoad 已移除；偏航後由伺服器從目前位置重新規劃）
// 高程：資料中沒有高程／立體交叉資訊，無法排除高架與平面道路的錯誤連接（見 README 限制）
import { State } from './state.js';
import { isGeo, lonLatToWorld, worldDistM } from './geo.js';
import { angDiff, bearingOf } from './gps-filter.js';

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
