// trip-log.js — 本機的行駛紀錄（只存在這支手機的瀏覽器裡，不上傳）
// ① EdgeHistory：自己開過的路段實測速度（ETA 的「歷史旅行時間」），每個 edgeId 一筆指數平均；尖峰（平日 7–9、17–19 時）與其他時段分開
// ② TripLog：一趟導航的 GPS 與每次 ETA 估算，結束時可下載成 JSON，再用 tools/eta-eval.mjs 算真實的 ETA 誤差（MAE／MAPE）
const KEY = 'twNavEdgeHist', MAX = 20000;
const peakOf = ms => { const d = new Date(ms + 8 * 3600e3), h = d.getUTCHours(), wd = d.getUTCDay(); return wd >= 1 && wd <= 5 && ((h >= 7 && h < 9) || (h >= 17 && h < 19)) ? 'p' : 'o'; };
export class EdgeHistory {
  constructor(storage = (typeof localStorage !== 'undefined' ? localStorage : null), now = () => Date.now()) {
    this.st = storage; this.now = now; this.m = new Map(); this.dirty = false;
    try { const j = this.st && JSON.parse(this.st.getItem(KEY) || 'null'); if (j && Array.isArray(j.e)) for (const [k, v, n, t] of j.e) this.m.set(k, { mps: v, n, t }); } catch { this.m = new Map(); }
  }
  get(eid, ms = this.now()) { return this.m.get(peakOf(ms) + ':' + eid) || null; }
  // 一段實測：長度（公尺）÷ 經過時間（秒）；明顯不合理的（< 0.3 或 > 45 m/s）不記
  add(eid, meters, seconds, ms = this.now()) {
    if (eid == null || !(meters > 5) || !(seconds > 0.5)) return false; const v = meters / seconds; if (v < 0.3 || v > 45) return false;
    const k = peakOf(ms) + ':' + eid, o = this.m.get(k);
    if (o) { o.mps = o.mps * 0.7 + v * 0.3; o.n = Math.min(50, o.n + 1); o.t = ms; this.m.delete(k); this.m.set(k, o); } else this.m.set(k, { mps: v, n: 1, t: ms });
    if (this.m.size > MAX) for (const kk of [...this.m.keys()].slice(0, this.m.size - MAX)) this.m.delete(kk);   // 最舊的先刪
    this.dirty = true; return true;
  }
  save() { if (!this.dirty || !this.st) return; try { this.st.setItem(KEY, JSON.stringify({ v: 1, e: [...this.m].map(([k, o]) => [k, +o.mps.toFixed(2), o.n, o.t]) })); this.dirty = false; } catch { /* 空間不足或無痕模式：略過 */ } }
  get size() { return this.m.size; }
}
export class TripLog {
  constructor(meta = {}) { this.meta = { ...meta, startedAt: Date.now() }; this.fixes = []; this.preds = []; this.events = []; }
  fix(f) { if (this.fixes.length < 20000) this.fixes.push([f.timestamp, +f.lat.toFixed(6), +f.lon.toFixed(6), Math.round(f.accuracy), f.speed == null ? null : +f.speed.toFixed(1), f.heading == null ? null : Math.round(f.heading)]); }
  pred(t, st) { if (this.preds.length < 20000) this.preds.push([t, Math.round(st.remainingM), Math.round(st.rawRemainingS ?? st.remainingS), Math.round(st.remainingS), st.eta ? st.eta.confidence : null]); }
  event(t, type) { this.events.push([t, type]); }
  toJSON() { return { v: 1, meta: this.meta, endedAt: Date.now(), fixes: this.fixes, preds: this.preds, events: this.events, columns: { fixes: ['t', 'lat', 'lon', 'acc', 'speed', 'heading'], preds: ['t', 'remainingM', 'rawRemainingS', 'shownRemainingS', 'confidence'] } }; }
}
