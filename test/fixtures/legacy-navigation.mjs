// 測試用：v1.7.1 以前的 NavigationEngine（原封不動，只改 import 路徑），用來和新版比較 ETA 與剩餘距離誤差。產品程式不使用。
// navigation.js — NavigationEngine：接收（已過濾的）GPS → 路線吸附 → 進度／下一步／剩餘／ETA／偏航／抵達
// 不直接搜尋路線：偏航確認後只發出 'reroute-request' 事件，由外層（nav-ui.js）重新規劃，再用 applyNewRoute() 換路線
import { RouteTrack } from '../../js/mapmatch.js';
import { angDiff } from '../../js/gps-filter.js';

export const NAV_DEFAULT = {
  minOffsetM: 30, accMult: 2,        // 偏航門檻 = max(30 m, 2×GPS 精度)
  confirmN: 3, confirmMs: 6000,      // 連續 3 筆精確定位、且持續 6 秒都偏離，才確認偏航（防抖）
  minMoveM: 15,                      // 偏離期間至少移動 15 m（停車不重新規劃）
  cooldownMs: 15000,                 // 兩次重新規劃至少間隔 15 秒
  maxAccuracyM: 50,                  // 精度超過 50 m 的定位不用來判斷偏航或抵達
  arriveM: 20, passM: 3,             // 剩餘 ≤20 m 視為抵達；已通過路口 3 m 後切到下一步
  // 轉錯路口（行進方向與路線方向差很多）：門檻降低、確認加快——平行道路不會觸發（方向差不多）
  divergeDeg: 60, divergeMinSpeed: 3, divergeOffsetM: 20, divergeConfirmN: 2, divergeConfirmMs: 2500,
  // ETA 依實際行駛速度修正：最近 3 分鐘、至少 60 秒且 200 m 的實際耗時 ÷ 預估耗時（暫停與停紅燈都算進去）
  etaWindowMs: 180000, etaMinMs: 60000, etaMinM: 200, etaMaxWeight: 0.7, etaMinFactor: 0.5, etaMaxFactor: 2.5
};

export class NavigationEngine {
  constructor(o = {}) { this.cfg = { ...NAV_DEFAULT, ...o }; this.active = false; this.paused = false; this.h = []; this.state = null; this.now = o.now ?? (() => Date.now()); }
  on(fn) { this.h.push(fn); return () => { this.h = this.h.filter(f => f !== fn); }; }
  _emit(type, extra) { for (const f of this.h) { try { f(type, { ...this.state, ...extra }); } catch (e) { console.error('導航 handler 錯誤', e); } } }

  // route：{coords, path, edgePath}；maneuvers：generateManeuvers(route)；edgeSpeedMps(k)：每條邊的行駛速度（m/s），用來估 ETA
  start(route, maneuvers, edgeSpeedMps) { this._load(route, maneuvers, edgeSpeedMps); this.active = true; this.paused = false; this.lastReroute = -Infinity; this._status('navigating'); this._emit('started'); }
  applyNewRoute(route, maneuvers, edgeSpeedMps) { this._load(route, maneuvers, edgeSpeedMps ?? this.edgeSpeed); this.rerouting = false; this._status('navigating'); this._emit('rerouted'); }
  _load(route, maneuvers, edgeSpeedMps) {
    this.route = route; this.track = new RouteTrack(route); this.edgeSpeed = edgeSpeedMps;
    this.firstRoad = (maneuvers.find(m => m.turnType === 'start') || {}).roadName || '';
    this.steps = maneuvers.filter(m => m.turnType !== 'start').map(m => ({ ...m, s: this.track.cum[Math.min(m.index, this.track.n - 1)] }));
    // 節點累積時間（系統推估：邊長 ÷ 該路段速度）；用多邊形距離線性對應，ETA 與進度同一把尺
    const n = this.track.n, tn = new Float64Array(n); let t = 0;
    for (let i = 1; i < n; i++) { const k = route.edgePath[i-1], v = edgeSpeedMps ? Math.max(1, edgeSpeedMps(k)) : 10; t += (this.track.cum[i] - this.track.cum[i-1]) / v; tn[i] = t; }
    this.nodeT = tn; this.totalT = t; this.hist = []; this.etaFactor = 1; this.s = 0; this.nextIdx = 0; this.off = null; this.rerouting = false; this.arrivedFlag = false; this.lastFix = null;
    this.state = this._snapshot(null, 0);
  }
  _timeAt(s) { const T = this.track, i = Math.min(T.n - 2, T._segAt(s)), L = T.cum[i+1] - T.cum[i], f = L > 0 ? (s - T.cum[i]) / L : 0; return this.nodeT[i] + (this.nodeT[i+1] - this.nodeT[i]) * f; }
  _status(st) { this.status = st; if (this.state) this.state.status = st; }
  pause() { this.paused = true; this._status('paused'); this._emit('paused'); }
  resume() { this.paused = false; this.off = null; this._status('navigating'); this._emit('resumed'); }
  stop() { this.active = false; this._status('stopped'); this._emit('stopped'); }
  rerouteFailed() { this.rerouting = false; if (this.status === 'rerouting') this._status('offroute'); this._emit('reroute-failed'); }   // 外層規劃失敗：回到 offroute，冷卻後再試

  update(fix) {
    if (!this.active || this.paused || !fix) return this.state;
    const c = this.cfg, T = this.track, now = fix.timestamp ?? this.now(), [mx, my] = T.toLocal(fix.lon, fix.lat);
    const precise = !fix.weak && fix.accuracy <= c.maxAccuracyM;
    const m = T.match(mx, my, { hintS: this.s, heading: fix.heading, speed: fix.speed ?? 0 });
    const diverging = fix.heading != null && (fix.speed ?? 0) >= c.divergeMinSpeed && angDiff(fix.heading, m.bearing) > c.divergeDeg;
    const thr = diverging ? Math.max(c.divergeOffsetM, 1.5 * fix.accuracy) : Math.max(c.minOffsetM, c.accMult * fix.accuracy);
    const needN = diverging ? c.divergeConfirmN : c.confirmN, needMs = diverging ? c.divergeConfirmMs : c.confirmMs;
    if (m.offset <= thr * 1.5 && m.s > this.s) this.s = m.s;                                      // 進度只往前（雜訊造成的小幅倒退忽略）
    while (this.nextIdx < this.steps.length - 1 && this.steps[this.nextIdx].s <= this.s + c.passM) { this.nextIdx++; this._emit('step-passed', { passed: this.steps[this.nextIdx - 1] }); }
    // 偏航判斷：精確定位才算；連續多筆＋持續時間＋有移動
    if (precise && m.offset > thr) {
      if (!this.off) this.off = { t0: now, n: 0, x: mx, y: my };
      this.off.n++;
      if (this.off.n >= needN && now - this.off.t0 >= needMs && Math.hypot(mx - this.off.x, my - this.off.y) >= c.minMoveM) {
        if (this.status === 'navigating') { this._status('offroute'); this.state = this._snapshot(fix, m.offset, m); this._emit('offroute'); }
        if (!this.rerouting && now - this.lastReroute >= c.cooldownMs) { this.lastReroute = now; this.rerouting = true; this._status('rerouting'); this.state = this._snapshot(fix, m.offset, m); this._emit('reroute-request', { fix }); }
      }
    } else if (m.offset <= thr * 0.6) {
      this.off = null;
      if (this.status === 'offroute' || this.status === 'rerouting') { this._status('navigating'); this.rerouting = false; this.state = this._snapshot(fix, m.offset, m); this._emit('back-on-route'); }
    }
    if (precise && m.offset <= thr) this._trackEta(now);
    this.state = this._snapshot(fix, m.offset, m);
    if (!this.arrivedFlag && precise && this.state.remainingM <= Math.max(c.arriveM, 0) && this.nextIdx >= this.steps.length - 1) { this.arrivedFlag = true; this._status('arrived'); this.state.status = 'arrived'; this._emit('arrived'); }
    this._emit('update'); return this.state;
  }
  // 實際行駛速度修正 ETA：比較最近一段的「實際耗時」與「預估耗時」，比值平滑後乘到剩餘時間（權重隨走過的距離增加，最多 70%）
  _trackEta(now) {
    const c = this.cfg, h = this.hist; h.push({ t: now, s: this.s });
    while (h.length > 2 && now - h[1].t >= c.etaWindowMs) h.shift();
    const a = h[0], dt = now - a.t, ds = this.s - a.s; if (dt < c.etaMinMs || ds < c.etaMinM) return;
    const plan = this._timeAt(this.s) - this._timeAt(a.s); if (!(plan > 1)) return;
    const f = Math.min(c.etaMaxFactor, Math.max(c.etaMinFactor, dt / 1000 / plan)), w = Math.min(c.etaMaxWeight, this.s / 3000 + 0.2);
    const target = 1 + (f - 1) * w; this.etaFactor = this.etaFactor === 1 && !this.etaSeen ? target : this.etaFactor * 0.7 + target * 0.3; this.etaSeen = true;
  }
  _snapshot(fix, offset, m) {
    const T = this.track, rem = Math.max(0, T.total - this.s), remPlan = Math.max(0, this.totalT - this._timeAt(this.s)), remT = remPlan * (this.etaFactor || 1), next = this.steps[Math.min(this.nextIdx, this.steps.length - 1)] || null, after = this.steps[this.nextIdx + 1] || null;
    const q = m ? T.mToWorld(m.qx, m.qy) : null;
    return { status: this.status || 'navigating', firstRoad: this.firstRoad, s: this.s, totalM: T.total, remainingM: rem, remainingS: remT, remainingPlanS: remPlan, etaFactor: this.etaFactor || 1, etaMs: (fix?.timestamp ?? this.now()) + remT * 1000,
      next, distToNext: next ? Math.max(0, next.s - this.s) : 0, after, offsetM: offset, snapped: q, bearing: m ? m.bearing : null,
      accuracy: fix ? fix.accuracy : null, weak: !!(fix && fix.weak), speed: fix ? fix.speed : null, heading: fix ? fix.heading : null, fix };
  }
}
