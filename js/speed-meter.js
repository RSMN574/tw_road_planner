// speed-meter.js — 導航畫面的「目前速度」（v1.20）：純邏輯，不碰 DOM，方便測試
// 輸入：GpsFilter 處理過的定位（fix：speed、speedSrc＝device（裝置都卜勒速度）／position（濾波後位移）、rawAccuracy、timestamp、weak）
// 處理：
//   ・異常值：超過 200 km/h、或加減速度超過 7 m/s²（一般車輛做不到）的單筆不採用；連續 3 筆都這樣才視為真的（例如剛開始使用就在高速公路上）
//   ・漂移：用位移估的速度，若這段時間的位移小於定位精度的一半 → 當成 0（GPS 在原地飄）
//   ・平滑：EMA，時間常數依來源（都卜勒 2 秒、位移 4 秒）；靜止：連續 2 筆低於 3 km/h → 顯示 0
//   ・品質：good（都卜勒且精度 ≤ 10 m）／fair／poor（精度 > 30 m、訊號弱、位移估速且精度 > 15 m）／lost（超過 6 秒沒有定位）
// 與速限比較：只有品質 good／fair、速限已確認時才比較；超過「速限＋max(3 km/h, 5%)」持續 3 秒以上才算超速——只是提醒，不是鼓勵開到速限
export class SpeedMeter {
  constructor(o = {}) { this.o = { maxMps: 55.6, maxAccel: 7, stillMps: 0.83, lostMs: 6000, overHoldMs: 3000, ...o }; this.reset(); }
  reset() { this.v = null; this.lastTs = null; this.rejectRun = 0; this.stillRun = 0; this.src = null; this.acc = null; this.weak = false; this.overSince = null; this.stats = { samples: 0, rejected: 0, drift: 0 }; }
  update(fix) {
    if (!fix || !Number.isFinite(fix.timestamp)) return this.state(fix && fix.timestamp);
    const ts = fix.timestamp, dt = this.lastTs != null ? (ts - this.lastTs) / 1000 : 0, acc = Number.isFinite(fix.rawAccuracy) ? fix.rawAccuracy : fix.accuracy;
    let x = Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null; this.stats.samples++;
    if (x != null && fix.speedSrc === 'position' && dt > 0 && x * dt < (acc || 0) * 0.5) { x = 0; this.stats.drift++; }   // 位移小於精度的一半：當成原地飄移
    if (x != null) {
      const bad = x > this.o.maxMps || (this.v != null && dt > 0 && Math.abs(x - this.v) / dt > this.o.maxAccel);
      if (bad && this.rejectRun < 2) { this.rejectRun++; this.stats.rejected++; this.lastTs = ts; return this.state(ts); }
      this.rejectRun = 0;
      if (x > this.o.maxMps) x = null;                                                       // 連續都超過 200 km/h：資料本身有問題，不顯示
    }
    if (x != null) {
      const tau = fix.speedSrc === 'device' ? 2 : 4, a = this.v == null || dt <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      this.v = this.v == null ? x : this.v + a * (x - this.v);
      this.stillRun = x < this.o.stillMps ? this.stillRun + 1 : 0;
    }
    this.lastTs = ts; this.src = fix.speedSrc || null; this.acc = acc; this.weak = !!fix.weak;
    return this.state(ts);
  }
  quality(now) {
    if (this.lastTs == null || (now != null && now - this.lastTs > this.o.lostMs)) return 'lost';
    if (this.v == null) return 'poor';
    if (this.weak || !(this.acc <= 30) || (this.src === 'position' && this.acc > 15)) return 'poor';
    if (this.src === 'device' && this.acc <= 10) return 'good';
    return 'fair';
  }
  // now：毫秒（沒有新定位時也要能判斷「訊號中斷」）
  state(now = Date.now()) {
    const q = this.quality(now), still = this.stillRun >= 2, kmh = q === 'lost' || this.v == null ? null : still ? 0 : Math.round(this.v * 3.6);
    return { kmh, quality: q, qualityText: { good: 'GPS 良好', fair: 'GPS 普通', poor: 'GPS 精度不足，速度僅供參考', lost: 'GPS 訊號中斷' }[q], accuracyM: this.acc != null ? Math.round(this.acc) : null,
      updatedAt: this.lastTs, source: this.src, stationary: still && q !== 'lost', lowSpeed: kmh != null && kmh > 0 && kmh < 5 };
  }
  // 與速限比較：'over'（持續超過）／'ok'／'unknown'（速限未知或速度不可靠）
  compare(limitKmh, now = Date.now()) {
    const s = this.state(now);
    if (!(limitKmh > 0) || s.kmh == null || !(s.quality === 'good' || s.quality === 'fair')) { this.overSince = null; return 'unknown'; }
    if (s.kmh > limitKmh + Math.max(3, limitKmh * 0.05)) { if (this.overSince == null) this.overSince = this.lastTs; return this.lastTs - this.overSince >= this.o.overHoldMs ? 'over' : 'ok'; }
    this.overSince = null; return 'ok';
  }
}
