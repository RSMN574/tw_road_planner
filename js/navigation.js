// navigation.js — NavigationEngine：接收（已過濾的）GPS → 路線吸附 → 進度／下一步／剩餘／ETA／偏航／抵達
// 不直接搜尋路線：偏航確認後只發出 'reroute-request' 事件，由外層（nav-ui.js）重新規劃，再用 applyNewRoute() 換路線
// 每筆 GPS 只做「增量」工作：在進度附近的視窗內投影到路線、查累積距離／時間表（O(log n)），不重新搜尋路線、不重算整條 Polyline
// ETA：外層傳入模型工廠（eta-engine.js 的 EtaModel：分段速度＋轉向＋路口等待）；沒傳時用 BasicModel（各段速度相加，舊行為）
import { RouteTrack } from './mapmatch.js';
import { HmmRouteMatcher } from './hmm-match.js';
import { angDiff } from './gps-filter.js';

// 沒有外部模型時的後備：剩餘時間＝Σ 路段長 ÷ 路段速度（沒有延遲、沒有不確定範圍）
class BasicModel {
  constructor(route, track, speed) {
    const n = track.n, t = new Float64Array(n); for (let i = 1; i < n; i++) t[i] = t[i - 1] + (track.cum[i] - track.cum[i - 1]) / (speed && route.edgePath ? Math.max(1, speed(route.edgePath[i - 1])) : 10);
    this.track = track; this.n = n; this.t = t; this.total = track.total; this.totalT = t[n - 1]; this.coverage = { limitKnown: 0, history: 0, length: '路線幾何長度' };
  }
  _seg(s) { const T = this.track, i = Math.min(this.n - 2, T._segAt(Math.max(0, Math.min(T.total, s)))), L = T.cum[i + 1] - T.cum[i]; return [i, L > 0 ? Math.min(1, (s - T.cum[i]) / L) : 0]; }
  distAt(s) { return Math.max(0, Math.min(this.total, s)); }
  remainingM(s) { return Math.max(0, this.total - s); }
  remaining(s, ctx = null) {                                                                        // 沒有注入模型時的備援：只有路段速限＋本趟實際比例（與舊版行為相當），可信度標「低」
    const [i, f] = this._seg(s), base = Math.max(0, this.totalT - (this.t[i] + (this.t[i + 1] - this.t[i]) * f));
    const k = ctx && ctx.tripW > 0 ? 1 + ctx.tripW * (Math.min(1.8, Math.max(0.7, ctx.tripRatio)) - 1) : 1, r = base * k;
    return { remainingS: r, lowS: r, highS: r, confidence: 'low', parts: { drive: Math.round(base), delays: 0, nearAdj: 0, tripAdj: Math.round(r - base), waitUsed: 0, traffic: 0 } }; }
  nextDelayNode() { return -1; }
}

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
  etaWindowMs: 180000, etaMinMs: 60000, etaMinM: 200, etaMaxWeight: 0.7, etaMinFactor: 0.5, etaMaxFactor: 2.5,
  // 進度防護：往前跳超過「速度×時間×1.8＋精度＋30 m」要連續 2 筆一致才接受；往回超過 max(25 m, 精度) 要連續 3 筆一致才接受（較小的倒退視為雜訊）
  jumpConfirmN: 2, backConfirmN: 3, backTolM: 25, stopMps: 0.8, gpsLostMs: 12000,
  // v1.11：路線上的位置用 HMM（hmm-match.js）決定；'window'＝舊的視窗內最近線段。HMM 找不到候選（真的離開路線很遠）時退回視窗法
  matcher: 'hmm'
};

export class NavigationEngine {
  constructor(o = {}) { this.cfg = { ...NAV_DEFAULT, ...o }; this.active = false; this.paused = false; this.h = []; this.state = null; this.now = o.now ?? (() => Date.now()); }
  on(fn) { this.h.push(fn); return () => { this.h = this.h.filter(f => f !== fn); }; }
  _emit(type, extra) { for (const f of this.h) { try { f(type, { ...this.state, ...extra }); } catch (e) { console.error('導航 handler 錯誤', e); } } }

  // route：{coords, path, edgePath}；maneuvers：generateManeuvers(route)；edgeSpeedMps(k)：每條邊的行駛速度（m/s），用來估 ETA
  // route：{coords, path, edgePath}；maneuvers：generateManeuvers(route)；edgeSpeedMps(k)：每條邊的速度（m/s，後備模型用）
  // opts.model(route, track, maneuvers)：建立 ETA 模型（見 eta-engine.js）；opts.smoother：ETA 平滑器（含 update(raw, now, remS, ok)）；opts.onEdge(eid, m, s, t)：每走完一段回報實測（歷史速度用）
  start(route, maneuvers, edgeSpeedMps, opts = {}) { this.opts = opts; this.vObs = 0; this._load(route, maneuvers, edgeSpeedMps); this.active = true; this.paused = false; this.lastReroute = -Infinity; this._status('navigating'); this._emit('started'); }
  applyNewRoute(route, maneuvers, edgeSpeedMps) { this._load(route, maneuvers, edgeSpeedMps ?? this.edgeSpeed); this.rerouting = false; this._status('navigating'); this._emit('rerouted'); }
  _load(route, maneuvers, edgeSpeedMps) {
    const o = this.opts || {};
    this.route = route; this.track = new RouteTrack(route); this.edgeSpeed = edgeSpeedMps; this.hmm = this.cfg.matcher === 'hmm' ? new HmmRouteMatcher(this.track) : null;
    this.firstRoad = (maneuvers.find(m => m.turnType === 'start') || {}).roadName || '';
    this.steps = maneuvers.filter(m => m.turnType !== 'start').map(m => ({ ...m, s: this.track.cum[Math.min(m.index, this.track.n - 1)] }));
    this.model = o.model ? o.model(route, this.track, maneuvers) : new BasicModel(route, this.track, edgeSpeedMps);
    for (const st of this.steps) st.dist = this.model.distAt(st.s);                                // 導航點的「沿路線真實距離」
    this.totalT = this.model.totalT; this.hist = []; this.etaFactor = 1; this.s = 0; this.nextIdx = 0; this.off = null; this.rerouting = false; this.arrivedFlag = false; this.lastFix = null;
    // 重新規劃後：進度、跳點判斷、停等、各節點經過時間、本趟比例都重設（實際速度 vObs 保留）
    this.lastT = null; this.pendF = null; this.pendB = null; this.stopSince = null; this.vt = new Float64Array(this.track.n).fill(NaN); this.trip = null; this.lastGood = null;
    if (o.smoother) o.smoother.reset(); this.raw = null; this.quality = 'none';
    this.state = this._snapshot(null, 0);
  }
  _status(st) { this.status = st; if (this.state) this.state.status = st; }
  pause() { this.paused = true; this._status('paused'); this._emit('paused'); }
  resume() { this.paused = false; this.off = null; this._status('navigating'); this._emit('resumed'); }
  stop() { this.active = false; this._status('stopped'); this._emit('stopped'); }
  rerouteFailed() { this.rerouting = false; if (this.status === 'rerouting') this._status('offroute'); this._emit('reroute-failed'); }   // 外層規劃失敗：回到 offroute，冷卻後再試

  update(fix) {
    if (!this.active || this.paused || !fix) return this.state;
    const c = this.cfg, T = this.track, now = fix.timestamp ?? this.now(), [mx, my] = T.toLocal(fix.lon, fix.lat);
    const precise = !fix.weak && fix.accuracy <= c.maxAccuracyM;
    let m = T.match(mx, my, { hintS: this.s, heading: fix.heading, speed: fix.speed ?? 0 });
    if (this.hmm && !fix.weak && fix.accuracy <= c.maxAccuracyM * 2) { const h = this.hmm.step({ mx, my, accuracy: fix.accuracy, heading: fix.heading, speed: fix.speed ?? 0, t: now }, this.s); if (h && Number.isFinite(h.offset) && !h.off) m = { s: h.s, offset: h.offset, seg: h.seg, qx: h.qx, qy: h.qy, bearing: h.bearing, pOff: h.pOff, hmm: true }; }
    const diverging = fix.heading != null && (fix.speed ?? 0) >= c.divergeMinSpeed && angDiff(fix.heading, m.bearing) > c.divergeDeg;
    const thr = diverging ? Math.max(c.divergeOffsetM, 1.5 * fix.accuracy) : Math.max(c.minOffsetM, c.accMult * fix.accuracy);
    const needN = diverging ? c.divergeConfirmN : c.confirmN, needMs = diverging ? c.divergeConfirmMs : c.confirmMs;
    const prevS = this.s, prevT = this.lastT;
    this.quality = fix.weak ? 'weak' : precise ? 'good' : 'poor';
    if (precise && m.offset <= thr * 1.5) this._progress(m.s, now, fix);                             // 精度不足或離路線太遠的定位不推進度
    else { this.pendF = null; this.pendB = null; }
    if (this.s !== prevS) this._passVertices(prevS, prevT, now);
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
    if (precise && m.offset <= thr) { this._trackEta(now); this.lastGood = now; }
    this.state = this._snapshot(fix, m.offset, m);
    if (!this.arrivedFlag && precise && this.state.remainingM <= Math.max(c.arriveM, 0) && this.nextIdx >= this.steps.length - 1) { this.arrivedFlag = true; this._status('arrived'); this.state.status = 'arrived'; this._emit('arrived'); }
    this._emit('update'); return this.state;
  }
  // 進度：防跳點、防倒退
  _progress(cand, now, fix) {
    const c = this.cfg, dt = this.lastT ? Math.max(0.2, (now - this.lastT) / 1000) : 1, v = Math.max(this.vObs || 0, fix.speed || 0, 5);
    const maxAdv = 30 + v * dt * 1.8 + (fix.accuracy || 0), adv = cand - this.s;
    let accept = false;
    if (adv >= 0) {
      if (adv <= maxAdv || this.lastT == null) { accept = true; this.pendF = null; }
      else { const p = this.pendF; if (p && cand >= p.s - 10 && cand - p.s <= 30 + v * Math.max(0.2, (now - p.t) / 1000) * 1.8 + (fix.accuracy || 0)) { p.n++; p.s = cand; p.t = now; } else this.pendF = { n: 1, s: cand, t: now }; if (this.pendF.n >= c.jumpConfirmN) { accept = true; this.pendF = null; } }
      this.pendB = null;
    } else {
      this.pendF = null;
      if (-adv > Math.max(c.backTolM, fix.accuracy || 0)) { const p = this.pendB; if (p && Math.abs(cand - p.s) < 40) { p.n++; p.s = cand; } else this.pendB = { n: 1, s: cand }; if (this.pendB.n >= c.backConfirmN) { this.s = cand; this.pendB = null; this.vt.fill(NaN); this.lastT = now; } }
      else this.pendB = null;
      // 雜訊造成的小倒退：進度不動，但時間往前（速度估算用）
      this._speed(0, dt, fix); this.lastT = now; return;
    }
    if (!accept) return;
    const ds = cand - this.s; this.s = cand; this._speed(ds, dt, fix); this.lastT = now;
    if (!this.trip && (fix.speed || 0) >= 1) this.trip = { t: now, s: this.s };
  }
  // 沿路線的實際速度（EWMA）與停等偵測
  _speed(ds, dt, fix) {
    const inst = dt > 0 && dt <= 15 ? ds / dt : null, gps = fix.speed != null && fix.speed >= 0 ? fix.speed : null, v = inst != null ? (gps != null ? 0.5 * inst + 0.5 * gps : inst) : gps;
    if (v != null) this.vObs = this.vObs ? this.vObs * 0.7 + v * 0.3 : v;
    const stopped = (gps != null ? gps : this.vObs) < this.cfg.stopMps;
    if (stopped) { if (this.stopSince == null) this.stopSince = this.lastT ?? 0; } else this.stopSince = null;
  }
  // 記下經過每個路線節點的時刻；完整走完一段就回報實測（扣掉模型的路口延遲，避免和延遲重複計算）
  _passVertices(s0, t0, t1) {
    const T = this.track, s1 = this.s, cb = this.opts && this.opts.onEdge; if (t0 == null || s1 <= s0 || t1 - t0 > 15000) return;
    for (let j = T._segAt(s0) + 1; j < T.n && T.cum[j] <= s1; j++) {
      this.vt[j] = t0 + (T.cum[j] - s0) / (s1 - s0) * (t1 - t0);
      if (cb && j >= 1 && isFinite(this.vt[j - 1])) {
        const m = this.model, L = m.realCum ? m.realCum[j] - m.realCum[j - 1] : T.cum[j] - T.cum[j - 1], d = m.cumD ? m.cumD[j] - m.cumD[j - 1] : 0, sec = (this.vt[j] - this.vt[j - 1]) / 1000;
        const key = this.route.edgePath ? this.route.edgePath[j - 1] : this.route._segKey ? this.route._segKey(j - 1) : null;   // OSM 路線：'osm:<way id>'
        if (key != null) cb(key, L, Math.max(sec * 0.4, sec - d), this.vt[j]);
      }
    }
  }
  // 舊介面保留：本趟「實際耗時 ÷ 預估耗時」（新模型在 _snapshot 內使用）
  _trackEta(now) { const h = this.hist; h.push({ t: now, s: this.s }); while (h.length > 2 && now - h[1].t >= this.cfg.etaWindowMs) h.shift(); }
  // 定位失效：保留最後可信估算，標示定位異常（不更新 ETA）
  markGpsLost(now = this.now()) { if (!this.state) return; this.state = { ...this.state, eta: { ...(this.state.eta || {}), stale: true, staleSince: this.state.eta && this.state.eta.staleSince || now } }; this._emit('update'); }
  _snapshot(fix, offset, m) {
    const T = this.track, M = this.model, now = fix?.timestamp ?? this.now(), next = this.steps[Math.min(this.nextIdx, this.steps.length - 1)] || null, after = this.steps[this.nextIdx + 1] || null;
    const rem = M.remainingM(this.s), d0 = M.distAt(this.s);
    // 本趟比例：已走 ≥500 m 後，實際耗時 ÷ 模型在同一段的預估
    let tripRatio = 1, tripW = 0;
    if (this.trip && this.s - this.trip.s >= 500) { const a = M.remaining(this.trip.s).remainingS, b = M.remaining(this.s).remainingS, plan = a - b; if (plan > 30) { tripRatio = (now - this.trip.t) / 1000 / plan; tripW = Math.min(0.5, (this.s - this.trip.s) / 4000); } }
    const stoppedS = this.stopSince != null && fix ? Math.max(0, (now - this.stopSince) / 1000) : 0;
    const e = M.remaining(this.s, { vObs: this.vObs, tripRatio, tripW, stoppedS, stopNodeIdx: stoppedS ? M.nextDelayNode(this.s, 50) : -1 }), plan = M.remaining(this.s).remainingS;
    const ok = !!fix && this.quality === 'good' && (offset ?? 0) <= Math.max(this.cfg.minOffsetM, this.cfg.accMult * (fix.accuracy || 0)), sm = this.opts && this.opts.smoother;
    const doSm = sm && fix && this._smT !== now; if (doSm) this._smT = now;                          // 每筆定位只更新平滑器一次（同一筆可能產生多次快照）
    const shown = doSm ? sm.update(now + e.remainingS * 1000, now, e.remainingS, ok || sm.shown == null) : sm && sm.shown != null ? sm.shown : now + e.remainingS * 1000;
    const etaMs = shown ?? now + e.remainingS * 1000, remS = Math.max(0, (etaMs - now) / 1000);
    this.etaFactor = plan > 0 ? e.remainingS / plan : 1;
    const q = m ? T.mToWorld(m.qx, m.qy) : null;
    return { status: this.status || 'navigating', firstRoad: this.firstRoad, s: this.s, totalM: M.total, remainingM: rem, remainingS: remS, rawRemainingS: e.remainingS, remainingPlanS: plan, etaFactor: this.etaFactor, etaMs,
      eta: { lowS: e.lowS, highS: e.highS, confidence: e.confidence, updatedAt: sm ? sm.updatedAt : now, stale: false, parts: e.parts, coverage: M.coverage, quality: this.quality, vObs: this.vObs },
      next, distToNext: next ? Math.max(0, (next.dist ?? next.s) - d0) : 0, after, offsetM: offset, snapped: q, bearing: m ? m.bearing : null,
      accuracy: fix ? fix.accuracy : null, weak: !!(fix && fix.weak), speed: fix ? fix.speed : null, heading: fix ? fix.heading : null, fix };
  }
}
