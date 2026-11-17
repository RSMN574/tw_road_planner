// gps-filter.js — GPS 原始定位的品質控管（純邏輯，不碰 DOM／navigator，方便測試）
// 注意：裝置不知道速度／方向／高度時會回報 null；isFinite(null) 是 true，所以這裡一律用 Number.isFinite 判斷
// 流程：格式檢查 → 精度判斷 → 節流 → 跳點排除 → 卡爾曼平滑（局部公尺座標）→ 行進方向估算
import { worldHaversine } from './geo.js';

const M_LAT = 110574, M_LON = 111320;
const norm360 = a => ((a % 360) + 360) % 360;
export const angDiff = (a, b) => { const d = Math.abs(norm360(a) - norm360(b)); return d > 180 ? 360 - d : d; };
export const bearingOf = (dx, dy) => norm360(Math.atan2(dx, dy) * 180 / Math.PI);       // dx 東、dy 北（公尺）→ 方位角（0=北，順時針）

export class GpsFilter {
  constructor(o = {}) {
    // maxAccuracyM：超過就標記「訊號弱」（仍參與平滑，但導航不拿它判斷偏航）；hardAccuracyM：超過就直接丟棄
    this.o = { minIntervalMs: 800, maxAccuracyM: 50, hardAccuracyM: 150, maxSpeedMps: 60, relocateAfter: 3, headingMinMoveM: 8, headingMinSpeed: 1.0, ...o };
    this.reset();
  }
  reset() { this.vEst = 0; this.org = null; this.x = 0; this.y = 0; this.P = 0; this.last = null; this.jumps = []; this.hAnchor = null; this.heading = null; this.stats = { accepted: 0, jump: 0, poor: 0, throttled: 0, invalid: 0, stale: 0 }; }
  toXY(lat, lon) { return [(lon - this.org.lon) * M_LON * Math.cos(this.org.lat * Math.PI / 180), (lat - this.org.lat) * M_LAT]; }
  toLL(x, y) { return [this.org.lat + y / M_LAT, this.org.lon + x / (M_LON * Math.cos(this.org.lat * Math.PI / 180))]; }
  _rej(reason) { this.stats[reason === 'poor-accuracy' ? 'poor' : reason === 'jump' ? 'jump' : reason]++; return { accepted: false, reason, fix: null }; }

  // raw：{ lat, lon, accuracy, altitude, speed, heading, timestamp(ms) } → { accepted, reason, fix }
  process(raw) {
    const o = this.o;
    if (!raw || !Number.isFinite(raw.lat) || !Number.isFinite(raw.lon) || Math.abs(raw.lat) > 90 || Math.abs(raw.lon) > 180 || (raw.lat === 0 && raw.lon === 0)) return this._rej('invalid');
    const ts = Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now(), acc = Number.isFinite(raw.accuracy) && raw.accuracy > 0 ? raw.accuracy : NaN;
    if (!isFinite(acc) || acc > o.hardAccuracyM) return this._rej('poor-accuracy');             // 沒有精度、或精度太差 → 不使用
    if (!this.last) {                                                                              // 第一點：直接建立濾波器
      this.org = { lat: raw.lat, lon: raw.lon }; this.x = 0; this.y = 0; this.P = acc * acc; this.last = { ts, x: 0, y: 0, acc };
      return this._emit(raw, ts, acc, 0);
    }
    const dt = (ts - this.last.ts) / 1000;
    if (dt <= 0) return this._rej('stale');                                                       // 時間沒前進（重複或亂序）
    if (dt * 1000 < o.minIntervalMs) return this._rej('throttled');                               // 更新節流
    const [rx, ry] = this.toXY(raw.lat, raw.lon), d = Math.hypot(rx - this.last.x, ry - this.last.y);
    const allowed = o.maxSpeedMps * dt + 2 * (acc + this.last.acc);
    if (d > allowed) {                                                                            // 跳點：不可能的位移
      this.jumps.push({ x: rx, y: ry, ts });
      const J = this.jumps; if (J.length > o.relocateAfter) J.shift();
      const consistent = J.length >= o.relocateAfter && J.every((p, i) => i === 0 || Math.hypot(p.x - J[i-1].x, p.y - J[i-1].y) <= o.maxSpeedMps * Math.max(1, (p.ts - J[i-1].ts) / 1000) + 2 * acc);
      if (!consistent) return this._rej('jump');
      this.x = rx; this.y = ry; this.P = acc * acc; this.jumps = []; this.hAnchor = null;         // 連續多點彼此一致 → 判定為真的移動（例如隧道出口、長時間失訊後），重設濾波
      this.last = { ts, x: rx, y: ry, acc };
      return this._emit(raw, ts, acc, dt, true);
    }
    this.jumps = [];
    // 卡爾曼（位置，兩軸共用方差）：預測方差隨「速度×時間」增長，所以行駛中幾乎信任量測、靜止時強力平滑
    // 裝置沒給速度時用「濾波後位移」的移動平均估速（不用原始量測的跳動，否則靜止時雜訊會被當成在移動）
    const v = Number.isFinite(raw.speed) && raw.speed >= 0 ? raw.speed : this.vEst;
    this.P += (v * dt) ** 2 + 0.5 * dt;
    const R = Math.max(acc, 3) ** 2, S = this.P + R, d2 = (rx - this.x) ** 2 + (ry - this.y) ** 2;
    if (d2 > 4 * S) this.P += (d2 - S) * 0.5;                     // 量測遠超預期（可能真的開始移動）→ 提高不確定度，濾波才跟得上
    const K = this.P / (this.P + R);
    this.x += K * (rx - this.x); this.y += K * (ry - this.y); this.P *= (1 - K);
    const px = this.last.x, py = this.last.y; this.last = { ts, x: this.x, y: this.y, acc };
    this.vEst = 0.7 * this.vEst + 0.3 * Math.hypot(this.x - px, this.y - py) / dt;
    return this._emit(raw, ts, acc, dt, false, [this.x - px, this.y - py]);
  }
  _emit(raw, ts, acc, dt, relocated = false, move = null) {
    this.stats.accepted++;
    const [lat, lon] = this.toLL(this.x, this.y);
    let speed = Number.isFinite(raw.speed) && raw.speed >= 0 ? raw.speed : (move && dt > 0 ? Math.hypot(move[0], move[1]) / dt : null);
    // 方向：裝置回報的 heading（要有速度才可信）→ 否則用位移方向（至少移動 headingMinMoveM 才更新，避免靜止時亂跳）
    let h = null;
    if (Number.isFinite(raw.heading) && speed != null && speed >= this.o.headingMinSpeed) h = norm360(raw.heading);
    else {
      if (!this.hAnchor) this.hAnchor = { x: this.x, y: this.y };
      const dx = this.x - this.hAnchor.x, dy = this.y - this.hAnchor.y;
      if (Math.hypot(dx, dy) >= this.o.headingMinMoveM) { h = bearingOf(dx, dy); this.hAnchor = { x: this.x, y: this.y }; }
    }
    if (h != null) this.heading = this.heading == null || relocated ? h : norm360(this.heading + Math.atan2(Math.sin((h - this.heading) * Math.PI / 180), Math.cos((h - this.heading) * Math.PI / 180)) * 180 / Math.PI * 0.6);
    const sd = Math.sqrt(this.P), accuracy = Math.max(Math.min(acc, sd), 1);
    return { accepted: true, reason: relocated ? 'relocated' : null, fix: { lat, lon, rawLat: raw.lat, rawLon: raw.lon, accuracy, rawAccuracy: acc, altitude: Number.isFinite(raw.altitude) ? raw.altitude : null, speed, heading: this.heading, timestamp: ts, weak: acc > this.o.maxAccuracyM, relocated } };
  }
}
export const rawDistM = (a, b) => worldHaversine(a.lon, a.lat, b.lon, b.lat);
