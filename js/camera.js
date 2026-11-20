// camera.js — 導航相機：方向（North Up／Heading Up）、自動縮放、路口放大、傾斜、視角位置。純計算，不碰畫面
// 每一幀呼叫 step(dt, 輸入)，回傳平滑後的 { rot（地圖旋轉角，度）, widthM（畫面寬度代表幾公尺）, anchorY（定位點在畫面高度的比例）, tilt（度） }
//   方向：移動夠快且 GPS 精度夠 → 用 GPS 行進方向；低速／停止 → 有指南針就用指南針（Heading Up），沒有就鎖住最後的方向；精度太差 → 暫停更新
//   平滑：先低通濾波（去掉抖動），再以最大角速度內插旋轉（不會猛轉）
//   縮放：依車速決定看多遠；接近轉彎（依距離與路口複雜度）放大；精度差時拉遠；目標變化小於 15% 或 2 秒內不重設（避免反覆縮放）
//   路口：進入放大後，通過該路口並經過 2.5 秒才恢復；同一個路口不會再進入一次
import { angDiff } from './gps-filter.js';

export const CAM = {
  lockMps: { car: 2.5, heavy: 2.5, moto: 2.5, bike: 1.5, walk: 0.7 },              // 低於這個速度：GPS 方向不可靠，鎖住或改用指南針
  ahead: { car: [250, 1600], heavy: [250, 1600], moto: [200, 1200], bike: [120, 500], walk: [80, 260] },   // 前方要看到的距離（公尺）範圍
  aheadS: 25,                                                                       // 依車速：前方約 25 秒的路程
  junction: { car: 120, heavy: 120, moto: 100, bike: 70, walk: 45 },                // 路口放大時，前方至少看到的距離
  maxAccM: 30, headTau: 0.6, maxRotDps: 60, zoomTau: 1.0, minZoomGapS: 2, zoomHyst: 0.15, tiltDeg: 25, tiltTau: 1.0
};
const camLerpAng = (a, b, k) => { const d = ((b - a + 540) % 360) - 180; return (a + d * k + 360) % 360; };

export class CameraController {
  constructor({ vk = 'car', mode = 'heading', tilt = true } = {}) {
    this.vk = CAM.ahead[vk] ? vk : 'car'; this.mode = mode; this.tiltOn = tilt;
    this.rot = 0; this.hdg = null; this.widthM = null; this.targetW = null; this.lastZoomT = -1e9; this.t = 0; this.tilt = 0; this.anchorY = 0.62;
    this.jn = null; this.doneJn = new Set(); this.source = 'none'; this.tiltWant = false; this.slowSince = null;
  }
  setMode(m) { this.mode = m; }
  get busy() { return this._busy; }
  // inp：{ speed, heading, accuracy, compass, distToNext, next, complex, follow, aspect（畫面高÷寬） }
  step(dt, inp) {
    const c = CAM, v = Math.max(0, inp.speed || 0), acc = inp.accuracy ?? 99; this.t += dt;
    // ① 方向
    let target = null; this.source = 'locked';
    if (acc > c.maxAccM) this.source = 'paused';
    else if (v >= c.lockMps[this.vk] && inp.heading != null && isFinite(inp.heading)) { target = inp.heading; this.source = 'gps'; }
    else if (inp.compass != null) { target = inp.compass; this.source = 'compass'; }
    if (target != null) this.hdg = this.hdg == null ? target : camLerpAng(this.hdg, target, 1 - Math.exp(-dt / c.headTau));
    const want = this.mode === 'heading' && this.hdg != null ? this.hdg : 0, d = ((want - this.rot + 540) % 360) - 180, maxStep = c.maxRotDps * dt;
    const rot0 = this.rot; this.rot = (this.rot + Math.max(-maxStep, Math.min(maxStep, d * Math.min(1, dt * 4))) + 360) % 360;
    // ② 路口放大狀態
    const nx = inp.next, turn = nx && !['straight', 'arrive', 'start'].includes(nx.turnType), approach = Math.max(150, v * 12);
    if (this.jn && (!nx || nx.index !== this.jn.idx)) { if (this.jn.passedAt == null) this.jn.passedAt = this.t; if (this.t - this.jn.passedAt > 2.5) { this.doneJn.add(this.jn.idx); this.jn = null; } }
    if (!this.jn && turn && inp.distToNext <= approach && !this.doneJn.has(nx.index)) this.jn = { idx: nx.index, enterAt: this.t, passedAt: null };
    // ③ 目標寬度
    const [a0, a1] = c.ahead[this.vk], asp = Math.max(0.6, inp.aspect || 1.8), anchor = this.mode === 'heading' ? 0.62 + Math.min(0.1, v / 250) : 0.5;
    let ahead = Math.min(a1, Math.max(a0, v * c.aheadS));
    if (this.jn && this.jn.passedAt == null) ahead = Math.max(c.junction[this.vk], Math.min(ahead, (inp.distToNext || 0) * 1.6 + 60)) * (inp.complex ? 0.8 : 1);
    ahead = Math.max(ahead, acc * 4);
    const W = ahead / (anchor * asp), jnChanged = !!this.jn !== !!this._jnOn; this._jnOn = !!this.jn;
    if (this.targetW == null || jnChanged || (Math.abs(Math.log(W / this.targetW)) > Math.log(1 + c.zoomHyst) && this.t - this.lastZoomT >= c.minZoomGapS)) { this.targetW = W; this.lastZoomT = this.t; }
    const w0 = this.widthM; this.widthM = this.widthM == null ? this.targetW : Math.exp(Math.log(this.widthM) + (Math.log(this.targetW) - Math.log(this.widthM)) * (1 - Math.exp(-dt / c.zoomTau)));
    this.anchorY += (anchor - this.anchorY) * (1 - Math.exp(-dt / 0.8));
    // ④ 傾斜（只在 Heading Up、跟隨中、移動中）
    // 傾斜有遲滯：≥ 4 m/s 才傾斜，低於 1.5 m/s 持續 3 秒才放平（紅燈起停不會一直來回）；路口不改傾斜角，只靠放大，避免反覆動畫
    if (v >= 4) this.slowSince = null; else if (v < 1.5 && this.slowSince == null) this.slowSince = this.t;
    if (v >= 4) this.tiltWant = true; else if (this.slowSince != null && this.t - this.slowSince >= 3) this.tiltWant = false;
    const tt = this.tiltOn && this.mode === 'heading' && inp.follow && this.tiltWant ? c.tiltDeg : 0, t0 = this.tilt;
    this.tilt += (tt - this.tilt) * (1 - Math.exp(-dt / c.tiltTau)); if (Math.abs(this.tilt - tt) < 0.2) this.tilt = tt;
    this._busy = Math.abs(angDiff(this.rot, rot0)) > 0.05 || Math.abs(this.rot - want) > 0.5 || (w0 != null && Math.abs(this.widthM / w0 - 1) > 0.001) || Math.abs(this.widthM / this.targetW - 1) > 0.01 || Math.abs(this.tilt - t0) > 0.05;
    return { rot: this.rot, widthM: this.widthM, anchorY: this.anchorY, tilt: this.tilt, junction: !!(this.jn && this.jn.passedAt == null), source: this.source };
  }
  // 使用者動了地圖：傾斜立即歸零（觸控座標換算才正確）
  interact() { this.tilt = 0; }
}
