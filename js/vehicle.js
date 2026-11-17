// vehicle.js — 車種通行規則、速限、動態權重成本  Cost(e) = α·T + β·D + γ·W + δ·R
import { State } from './state.js';
import { CLS, WALK_MPS } from './constants.js';
import { ensureRA } from './road-attrs.js';
import { qc, qv } from './ctx.js';

// 通行規則（依需求）：汽車＝不走自行車／步行專用道；重機＝再加上不走國道；一般機車＝再加上不走快速道路；腳踏車＝不走國道、快速道路（優先自行車道）
export const VEHICLES = {
  bus:   { label: '公車',     ban: [CLS.bike, CLS.walk],                               cap: Infinity },
  car:   { label: '汽車',     ban: [CLS.bike, CLS.walk],                               cap: Infinity },
  heavy: { label: '重型機車', ban: [CLS.bike, CLS.walk, CLS.freeway],                  cap: Infinity },
  moto:  { label: '一般機車', ban: [CLS.bike, CLS.walk, CLS.freeway, CLS.expressway],  cap: 50 },      // cap：假設值，非法規查證
  bike:  { label: '腳踏車',   ban: [CLS.walk, CLS.freeway, CLS.expressway],            cap: 18 },      // cap：假設的平均騎乘速度
  walk:  { label: '步行',     ban: [CLS.freeway, CLS.expressway],                      cap: WALK_MPS * 3.6 }   // 步行：可走自行車道／步行專用道，不可走國道、快速道路；速度為固定假設值
};
const DEFAULT_LIMIT = [30, 40, 50, 40, 20, 18, 5, 30, 100, 80];      // 速限資料缺漏時，依道路類別推估（km/h，對應 CLS 0..9）；介面一律標示為「推估」
export const D_SCALE = 0.1;                                          // 距離項換成「秒當量」：1 公尺 = 0.1 秒
export const PREFS = { fast: { a: 1, b: 0, d: 0 }, short: { a: 0, b: 1, d: 0 }, balanced: { a: 1, b: 0.5, d: 0.5 }, safe: { a: 1, b: 0.3, d: 2 } };   // α 時間、β 距離、δ 風險

// 使用者看到的「交通方式」：car/heavy/moto/bike/walk 或 transit（大眾運輸）。'bus' 只在「營運規劃」勾選時當內部車種使用
export function getMode() { const v = qv('mode', 'car'); return (v === 'transit' || (v !== 'bus' && VEHICLES[v])) ? v : 'car'; }
export const opsModeOn = () => qc('opsMode');
export const getVehicleKey = () => opsModeOn() ? 'bus' : (m => VEHICLES[m] ? m : 'car')(getMode());
export const avoidTollOn = () => qc('avoidToll') && getVehicleKey() === 'car';   // 只有國道收費；機車本來就禁行國道
export const tollLength = route => { const ra = ensureRA(); let L = 0; for (const k of route.edgePath) if (ra.cls[k] === CLS.freeway) L += State.adjW[k]; return L; };
export function getPref() {
  const g = (id, d) => { const x = parseFloat(qv(id)); return isFinite(x) && x >= 0 ? x : d; };
  const p = PREFS[qv('pref', 'balanced')] || PREFS.balanced, r = { a: g('prefA', p.a), b: g('prefB', p.b), d: g('prefD', p.d) };
  return r.a + r.b + r.d > 0 ? r : PREFS.balanced;
}
export const vehicleAllows = (key, cls) => !VEHICLES[key].ban.includes(cls);

// 每條鄰接邊的車種屬性（惰性建立，只快取目前車種，避免 140 萬節點時記憶體倍增）
export function ensureVeh(key) {
  const ra = ensureRA(), c = State.vehCache;
  if (c && c.key === key && c.m === ra.m) return c;
  const V = VEHICLES[key], m = ra.m, ban = new Set(V.ban), forb = new Uint8Array(m), spd = new Float32Array(m), risk = new Float32Array(m);
  let vmax = 10, nForb = 0;
  for (let k = 0; k < m; k++) {
    const cl = ra.cls[k];
    if (ban.has(cl)) { forb[k] = 1; nForb++; spd[k] = 1; continue; }
    const lim = ra.limit[k], base = isFinite(lim) ? lim : (DEFAULT_LIMIT[cl] ?? 30);
    const v = Math.max(key === 'walk' ? 3 : 5, (key === 'bike' && cl === CLS.bike) ? V.cap : Math.min(base, V.cap)); spd[k] = v; if (v > vmax) vmax = v;
    let r = ra.unk[k] ? 0.1 : 0;                                                       // 風險 R：屬性不明、高速道路對腳踏車／機車的風險
    if (key === 'bike') r += cl === CLS.bike ? 0 : lim >= 60 ? 2 : lim >= 50 ? 1.2 : lim >= 40 ? 0.5 : 0.2;
    else if (key === 'moto') r += lim >= 60 ? 0.8 : lim >= 50 ? 0.4 : 0;
    else if (key === 'walk') r += (cl === CLS.bike || cl === CLS.walk || cl === CLS.alley) ? 0 : lim >= 50 ? 0.6 : 0.2;   // 與車流共用道路的風險
    risk[k] = r;
  }
  return State.vehCache = { key, m, forb, spd, risk, vmax, nForb };
}
export function speedInfo(k) { const ra = ensureRA(), lim = ra.limit[k]; return isFinite(lim) ? { limit: lim, known: true } : { limit: DEFAULT_LIMIT[ra.cls[k]] ?? 30, known: false }; }
export const speedText = k => { const s = speedInfo(k); return s.known ? `速限 ${s.limit} km/h` : `速限未知（推估 ${s.limit} km/h）`; };

// 成本函式：cost = α·(L/v) + (β + δ·R)·L·D_SCALE（單位：秒當量）。回傳 mper = 每公尺成本下界，供 A* 啟發函式使用：
// 時間項 ≥ L/vmax、距離項 = β·L·D_SCALE，風險項 ≥ 0 不計入 → 啟發值不會高估剩餘成本，A* 仍保證最佳
export function makeCost(key, pref, ignoreForb, avoidToll) {
  const V = ensureVeh(key), { a, b, d } = pref, fb = ignoreForb ? null : V.forb, cls = avoidToll ? ensureRA().cls : null;
  const fn = (eid, w, k) => ((fb && fb[k]) || (cls && cls[k] === CLS.freeway)) ? Infinity : a * (w / (V.spd[k] / 3.6)) + (b + d * V.risk[k]) * w * D_SCALE;
  return { fn, mper: a / (V.vmax / 3.6) + b * D_SCALE, V };
}
export function routeTimeS(r, V) { let t = 0; for (const k of r.edgePath) t += State.adjW[k] / (V.spd[k] / 3.6); return t; }

// 路段速限文字：同一路名的路段內若速限不同，顯示範圍；全部缺資料時標示「速限未知」
export function segSpeedText(route, sg) {
  const ra = ensureRA(), known = new Set(); let unknown = 0;
  for (let i = sg.start; i < sg.end; i++) { const l = ra.limit[route.edgePath[i]]; if (isFinite(l)) known.add(l); else unknown++; }
  if (!known.size) return `速限未知（推估 ${speedInfo(route.edgePath[sg.start]).limit} km/h）`;
  const a = Math.min(...known), b = Math.max(...known);
  return `速限 ${a === b ? a : a + '–' + b} km/h` + (unknown ? '（部分路段缺資料）' : '');
}
// 路線的速限統計：資料覆蓋率（依長度）、加權平均、最高
export function limitStats(route) {
  const ra = ensureRA(); let L = 0, Lk = 0, sum = 0, mx = 0;
  for (const k of route.edgePath) { const w = State.adjW[k], l = ra.limit[k]; L += w; if (isFinite(l)) { Lk += w; sum += l * w; if (l > mx) mx = l; } }
  return { cov: L ? Lk / L : 0, avg: Lk ? sum / Lk : NaN, max: mx };
}
