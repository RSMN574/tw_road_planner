// gps.js — 定位服務：navigator.geolocation.watchPosition 的包裝
// 只使用裝置 GPS／系統定位（不用 IP 定位取代導航定位）。狀態：idle / pending / active / weak / lost / denied / unavailable / insecure / unsupported
import { GpsFilter } from './gps-filter.js';

export const GPS_TEXT = { idle: 'GPS 未啟動', pending: '正在取得 GPS…', active: 'GPS 正常', weak: 'GPS 訊號弱', lost: 'GPS 訊號中斷', denied: '定位權限被拒絕', unavailable: '無法取得位置', insecure: '定位需要 HTTPS', unsupported: '此瀏覽器不支援定位' };

export class GpsService {
  // 參數都可以注入（測試用）；實際使用時全部走預設值
  constructor(o = {}) {
    this.geo = o.geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : null);
    this.filter = o.filter ?? new GpsFilter(o.filterOpts);
    this.secure = o.secure ?? (typeof isSecureContext !== 'undefined' ? isSecureContext : true);
    this.lostMs = o.lostMs ?? 10000; this.setT = o.setTimeout ?? ((f, ms) => setTimeout(f, ms)); this.clearT = o.clearTimeout ?? (t => clearTimeout(t));   // 包一層：直接存 setTimeout 再用 this.setT() 呼叫，瀏覽器會報 Illegal invocation
    this.status = 'idle'; this.last = null; this.watchId = null; this.lostTimer = null; this.h = { fix: [], status: [], reject: [] };
  }
  on(type, fn) { this.h[type].push(fn); return () => { this.h[type] = this.h[type].filter(f => f !== fn); }; }
  _emit(type, a) { for (const f of this.h[type]) { try { f(a); } catch (e) { console.error('GPS handler 錯誤', e); } } }
  _set(st, detail) { if (st === this.status && !detail) return; this.status = st; this._emit('status', { status: st, text: GPS_TEXT[st] || st, detail: detail || '' }); }
  _armLost() { this.clearT(this.lostTimer); this.lostTimer = this.setT(() => { if (this.watchId != null) this._set('lost'); }, this.lostMs); }

  // 必須由使用者操作（例如按「開始導航」）呼叫，瀏覽器才會跳出權限詢問
  start() {
    if (this.watchId != null) return true;
    if (!this.secure) { this._set('insecure', '請用 https:// 開啟（localhost 也可）'); return false; }
    if (!this.geo) { this._set('unsupported'); return false; }
    this.filter.reset(); this._set('pending'); this._armLost();
    this.watchId = this.geo.watchPosition(p => this._onPos(p), e => this._onErr(e), { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    return true;
  }
  stop() { if (this.watchId != null && this.geo) this.geo.clearWatch(this.watchId); this.watchId = null; this.clearT(this.lostTimer); this._set('idle'); }
  _onPos(p) {
    const c = p.coords, res = this.filter.process({ lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, altitude: c.altitude, speed: c.speed, heading: c.heading, timestamp: p.timestamp });
    if (!res.accepted) { if (res.reason !== 'throttled') this._emit('reject', res.reason); if (res.reason === 'poor-accuracy') this._set('weak'); return; }
    this.last = res.fix; this._armLost(); this._set(res.fix.weak ? 'weak' : 'active'); this._emit('fix', res.fix);
  }
  _onErr(e) {
    if (e && e.code === 1) { this.stop(); this._set('denied', '請到瀏覽器／系統設定允許此網站使用定位'); return; }   // 權限被拒：不再重試
    this._set(e && e.code === 3 && this.last ? 'lost' : 'unavailable', e && e.message ? String(e.message) : '');  // 2＝無法定位、3＝逾時：持續監聽，等訊號回來
  }
}
