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

// 路段速限文字：OSM 有標／只有區域代碼（例如 TW:urban，依道路類別推估）／沒有資料（推估）
export function segSpeedText(route, sg) {
  const sr = route._osm; if (!sr) return '';
  const sw = (sr.timing && sr.timing.segWay) || [], ws = new Set(); for (let i = sg.start; i < sg.end && i < sw.length; i++) ws.add(sw[i]);
  const L = [...ws].map(i => sr.ways[i]).filter(w => w && w.limitKmh != null); if (!L.length) return '';
  const tag = L.filter(w => w.limitSrc === 'tag').map(w => w.limitKmh), est = L.filter(w => w.limitSrc !== 'tag');
  if (!tag.length) return est.some(w => w.limitSrc === 'zone') ? `區域速限約 ${est[0].limitKmh} km/h（只有區域代碼，依類別推估）` : `速限未知（推估 ${est[0].limitKmh} km/h）`;
  const a = Math.min(...tag), b = Math.max(...tag);
  return `速限 ${a === b ? a : a + '–' + b} km/h` + (est.length ? '（部分路段缺資料）' : '');
}
// 路線的速限統計：資料覆蓋率（依長度）、加權平均、最高
export function limitStats(route) {
  const ws = (route._osm && route._osm.ways) || [], L = ws.reduce((a, w) => a + w.m, 0), k = ws.filter(w => w.limitSrc === 'tag'), Lk = k.reduce((a, w) => a + w.m, 0);
  return { cov: L ? Lk / L : 0, avg: Lk ? k.reduce((a, w) => a + w.limitKmh * w.m, 0) / Lk : NaN, max: k.reduce((a, w) => Math.max(a, w.limitKmh), 0) };
}
