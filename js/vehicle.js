// vehicle.js — 交通方式與路線的速限／收費資訊（v1.18：通行規則與速度改由伺服器的 OSM 路網決定；舊路網的成本函式已移除）
import { WALK_MPS } from './constants.js';
import { qv } from './ctx.js';

export const VEHICLES = {
  car:   { label: '汽車' },
  heavy: { label: '重型機車' },
  moto:  { label: '一般機車', cap: 50 },
  bike:  { label: '腳踏車', cap: 18 },
  walk:  { label: '步行', cap: WALK_MPS * 3.6 }
};
// 使用者看到的「交通方式」：car/heavy/moto/bike/walk 或 transit（大眾運輸）
export function getMode() { const v = qv('mode', 'car'); return (v === 'transit' || VEHICLES[v]) ? v : 'car'; }
export const getVehicleKey = () => (m => (VEHICLES[m] ? m : 'car'))(getMode());
// 國道（收費）長度
export const tollLength = route => ((route._osm && route._osm.ways) || []).filter(w => w.highway === 'motorway' && /國道|高速公路/.test(`${w.ref} ${w.name}`)).reduce((a, w) => a + w.m, 0);

// v1.20 速限文字（SpeedLimitService 的結果）：沒有可靠來源就是「速限未知」，不顯示路線時間用的推估值
export function speedLimitText(L, short = false) {
  if (!L) return '';
  if (L.confidence === 'na') return short ? '' : L.label;
  if (L.kmh == null) return '速限未知';
  const tail = { tdx: '官方', 'osm-zone': '法定', 'osm-cond': '時段' }[L.source];
  return `速限 ${L.kmh} km/h${tail ? `（${tail}）` : ''}`;
}
// 路線第 i 小段的速限（伺服器的 speedLimits.table／seg）；舊伺服器沒有 speedLimits → 只用 OSM 標籤
export function osmLimitAt(sr, i) {
  const S = sr && sr.speedLimits; if (S && S.seg && S.seg.length) { const j = S.seg[Math.max(0, Math.min(S.seg.length - 1, i))]; return j >= 0 ? S.table[j] : null; }
  const T = sr && sr.timing, w = T && T.segWay ? sr.ways[T.segWay[Math.max(0, Math.min(T.segWay.length - 1, i))]] : null;
  return w ? (w.limitSrc === 'tag' ? { kmh: w.limitKmh, source: 'osm', confidence: 'medium', label: 'OSM 速限標籤' } : { kmh: null, source: null, confidence: 'unknown', label: '速限未知' }) : null;
}
// 路段速限文字（v1.20：SpeedLimitService 的結果；沒有可靠來源就是「速限未知」，不顯示推估值）
export function segSpeedText(route, sg) {
  const sr = route._osm; if (!sr) return '';
  const L = []; for (let i = sg.start; i < sg.end; i++) { const x = osmLimitAt(sr, i); if (x) L.push(x); } if (!L.length) return '';
  const known = L.filter(x => x.kmh != null).map(x => x.kmh); if (!known.length) return '速限未知';
  const a = Math.min(...known), b = Math.max(...known), off = L.some(x => x.source === 'tdx');
  return `速限 ${a === b ? a : a + '–' + b} km/h${off ? '（官方）' : ''}` + (known.length < L.length ? '（部分路段速限未知）' : '');
}
// 路線的速限統計：資料覆蓋率（依長度）、加權平均、最高
export function limitStats(route) {
  const ws = (route._osm && route._osm.ways) || [], L = ws.reduce((a, w) => a + w.m, 0), k = ws.filter(w => w.limitSrc === 'tag'), Lk = k.reduce((a, w) => a + w.m, 0);
  return { cov: L ? Lk / L : 0, avg: Lk ? k.reduce((a, w) => a + w.limitKmh * w.m, 0) / Lk : NaN, max: k.reduce((a, w) => Math.max(a, w.limitKmh), 0) };
}
