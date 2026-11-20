// grow.mjs — 可成長的型別陣列（大量資料不用一般陣列，省記憶體也省 GC）
export class Grow {
  constructor(T, cap = 1024) { this.T = T; this.a = new T(cap); this.n = 0; }
  push(v) { if (this.n === this.a.length) this._grow(this.n + 1); this.a[this.n++] = v; }
  pushArr(src) { if (this.n + src.length > this.a.length) this._grow(this.n + src.length); this.a.set(src, this.n); this.n += src.length; }
  _grow(min) { let c = this.a.length * 2; while (c < min) c *= 2; const b = new this.T(c); b.set(this.a.subarray(0, this.n)); this.a = b; }
  trim() { return this.a.slice(0, this.n); }
  get length() { return this.n; }
}
// 已排序的 Float64Array 裡二分搜尋；找不到回傳 −1
export function bsearch(a, x, n = a.length) { let lo = 0, hi = n - 1; while (lo <= hi) { const m = (lo + hi) >>> 1, v = a[m]; if (v < x) lo = m + 1; else if (v > x) hi = m - 1; else return m; } return -1; }
// 兩點距離（公尺，haversine）；座標是 1e-7 度的整數
const R = 6371008.8, K = Math.PI / 180 / 1e7;
export function distE7(la1, lo1, la2, lo2) {
  const p1 = la1 * K, p2 = la2 * K, dp = p2 - p1, dl = (lo2 - lo1) * K, s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
// 方位角（度，北 0 東 90）
export function bearingE7(la1, lo1, la2, lo2) {
  const p1 = la1 * K, p2 = la2 * K, dl = (lo2 - lo1) * K, y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
