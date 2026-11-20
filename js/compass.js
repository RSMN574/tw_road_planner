// compass.js — 裝置指南針（導航低速／停止時的方向輔助）。iOS 需要在使用者操作中取得權限
// Android Chrome：deviceorientationabsolute 的 alpha；iOS Safari：webkitCompassHeading（已是順時針、相對正北）。依螢幕方向修正
export class Compass {
  constructor() { this.h = null; this.acc = null; this.t = 0; this.on = false; this._fn = null; }
  async start() {
    if (this.on || typeof window === 'undefined' || typeof DeviceOrientationEvent === 'undefined') return false;
    try { if (typeof DeviceOrientationEvent.requestPermission === 'function' && (await DeviceOrientationEvent.requestPermission()) !== 'granted') return false; } catch { return false; }
    this._fn = e => {
      let h = null;
      if (typeof e.webkitCompassHeading === 'number' && e.webkitCompassHeading >= 0) { h = e.webkitCompassHeading; this.acc = typeof e.webkitCompassAccuracy === 'number' ? e.webkitCompassAccuracy : null; }
      else if (e.absolute && typeof e.alpha === 'number') h = (360 - e.alpha) % 360;
      if (h == null) return;
      const so = (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : 0; h = (h + so) % 360;
      this.h = this.h == null ? h : (this.h + ((((h - this.h) % 360) + 540) % 360 - 180) * 0.25 + 360) % 360; this.t = Date.now();
    };
    window.addEventListener('ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation', this._fn); this.on = true; return true;
  }
  stop() { if (this._fn && typeof window !== 'undefined') { window.removeEventListener('deviceorientationabsolute', this._fn); window.removeEventListener('deviceorientation', this._fn); } this.on = false; this._fn = null; }
  // 2 秒內的讀數才算數；精度差（iOS 回報 > 30°）不用
  get value() { return this.h != null && Date.now() - this.t < 2000 && !(this.acc != null && (this.acc < 0 || this.acc > 30)) ? this.h : null; }
}
