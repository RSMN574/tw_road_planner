// access.mjs — 同一套路網、五種運具的通行規則（汽車、大型重機、機車、自行車、步行）
//
// 每條邊、每種運具、每個方向存一個 4-bit 狀態（低 3 bits 是狀態，第 4 bit 是「有時段條件」）：
//   0 UNKNOWN            未標註、也沒有可靠的預設規則（例如汽車走 highway=track）——不擅自當成允許或禁止，交給路徑規劃的政策決定並在結果中警告
//   1 ALLOWED            標籤明確允許（yes／designated／permissive…）
//   2 DEFAULT_ALLOWED    未標註，依道路類別的預設規則推定允許（例如一般道路允許汽車）——與標籤允許分開記錄，報告與介面都標「推定」
//   3 LIMITED            有條件通行：destination、private、delivery、customers、permit…（只為了到達目的地才進入）
//   4 RESTRICTED         標籤明確禁止（no、use_sidepath…）
//   5 DEFAULT_RESTRICTED 未標註，依法規／道路類別推定禁止（例如國道禁止機車、人行道禁止汽車）
//   6 ONEWAY             單行道的反方向
//   +8 COND              另有 :conditional 標籤（依時段、天候等），基本狀態照上面，路徑規劃另外警告
// 方向：低 4 bits＝順著 way 的方向（forward），高 4 bits＝反方向（backward）。
import { parseOneway, isFreewayTW, isExpresswayTW, isRampTW } from './tags.mjs';

export const ST = { UNKNOWN: 0, ALLOWED: 1, DEFAULT_ALLOWED: 2, LIMITED: 3, RESTRICTED: 4, DEFAULT_RESTRICTED: 5, ONEWAY: 6 };
export const COND = 8;
export const ST_KEY = ['unknown', 'allowed', 'default_allowed', 'limited', 'restricted', 'default_restricted', 'oneway'];
export const ST_LABEL = ['未知（未標註、無預設規則）', '允許（標籤）', '推定允許（未標註，依道路類別預設）', '有條件（限到達目的地、私人道路等）', '禁止（標籤）', '推定禁止（未標註，依法規／道路類別預設）', '禁止（單行道反方向）'];
// 三大類：allowed／limited／restricted／unknown（推定的一律另外記「推定」）
export const category = s => ['unknown', 'allowed', 'allowed', 'limited', 'restricted', 'restricted', 'restricted'][s & 7];
export const isBlocked = s => { const v = s & 7; return v === ST.RESTRICTED || v === ST.DEFAULT_RESTRICTED || v === ST.ONEWAY; };
// AccessProfileEngine 的對外四態（v1.11）：allowed／restricted（有條件，例如限住戶、限送貨）／prohibited／unknown，
// 另附 source：tag（OSM 該運具或通用的通行標籤）、default（未標註，依道路類別與台灣法規推定）、oneway（單行反向）、none（未知）
// 推定的與標籤的永遠分開回報；unknown 不會被當成 allowed（路徑規劃依政策：預設可走但成本 ×3 並警告）
export function access4(s) {
  const v = s & 7, cond = !!(s & COND);
  const [state, source] = [['unknown', 'none'], ['allowed', 'tag'], ['allowed', 'default'], ['restricted', 'tag'], ['prohibited', 'tag'], ['prohibited', 'default'], ['prohibited', 'oneway']][v];
  return { state, source, conditional: cond };
}

// 標籤的優先順序：越具體的運具越優先（例如 motorcar > motor_vehicle > vehicle > access）；同一個鍵先看 :forward／:backward
export const PROFILES = [
  { key: 'car', label: '汽車', chain: ['motorcar', 'motor_vehicle', 'vehicle', 'access'], oneway: ['oneway:motorcar', 'oneway:motor_vehicle', 'oneway:vehicle'], capKmh: Infinity },
  { key: 'heavy', label: '大型重型機車', chain: ['motorcycle', 'motor_vehicle', 'vehicle', 'access'], oneway: ['oneway:motorcycle', 'oneway:motor_vehicle', 'oneway:vehicle'], capKmh: Infinity },
  { key: 'moto', label: '機車', chain: ['motorcycle', 'motor_vehicle', 'vehicle', 'access'], oneway: ['oneway:motorcycle', 'oneway:motor_vehicle', 'oneway:vehicle'], capKmh: Infinity },
  { key: 'bike', label: '自行車', chain: ['bicycle', 'vehicle', 'access'], oneway: ['oneway:bicycle', 'oneway:vehicle'], capKmh: 18 },
  { key: 'foot', label: '步行', chain: ['foot', 'access'], oneway: ['oneway:foot'], capKmh: 4.5 }
];
export const PROFILE_IX = Object.fromEntries(PROFILES.map((p, i) => [p.key, i]));

const VAL = {
  yes: ST.ALLOWED, designated: ST.ALLOWED, permissive: ST.ALLOWED, official: ST.ALLOWED, public: ST.ALLOWED,
  destination: ST.LIMITED, delivery: ST.LIMITED, customers: ST.LIMITED, private: ST.LIMITED, permit: ST.LIMITED, agricultural: ST.LIMITED, forestry: ST.LIMITED,
  residents: ST.LIMITED, discouraged: ST.LIMITED, dismount: ST.LIMITED,
  no: ST.RESTRICTED, use_sidepath: ST.RESTRICTED, emergency: ST.RESTRICTED, military: ST.RESTRICTED, psv: ST.RESTRICTED, bus: ST.RESTRICTED, taxi: ST.RESTRICTED, hov: ST.RESTRICTED,
  unknown: ST.UNKNOWN
};
export const unknownValues = new Map();                 // 不認得的值（報告用）：值 → 評估次數（每種運具、每個方向各算一次）
function mapVal(v, key) {
  const s = String(v).trim().toLowerCase(), first = s.split(';')[0].trim();
  if (first in VAL) return VAL[first];
  unknownValues.set(key + '=' + first, (unknownValues.get(key + '=' + first) || 0) + 1);
  return ST.UNKNOWN;
}
function explicit(t, chain, dir) {
  for (const k of chain) {
    const vd = t[k + dir]; if (vd != null && vd !== '') return { st: mapVal(vd, k + dir), key: k + dir };
    const v = t[k]; if (v != null && v !== '') return { st: mapVal(v, k), key: k };
  }
  return null;
}

// 預設規則（未標註時）：依台灣交通法規與 OSM 台灣慣例；回傳 [狀態, 原因代碼]
//   國道（motorway）：機車、自行車、行人禁止；大型重機禁止（快速公路例外）
//   快速公路（motorroad=yes、名稱或 ref 為快速公路）：機車、自行車、行人禁止
//   人行道、步道、自行車道、階梯：汽機車禁止；自行車走人行道／行人徒步區 → 未知（台灣需有標誌才可）
//   產業道路（track）：汽機車 → 未知（路況與是否開放差異大）
const WALKISH = new Set(['pedestrian', 'footway', 'path', 'steps', 'bridleway', 'corridor']);
export function defaultRule(pk, hw, t) {
  const motorway = hw === 'motorway' || hw === 'motorway_link', trunk = hw === 'trunk' || hw === 'trunk_link';
  const freeway = motorway && (isFreewayTW(t) || !isExpresswayTW(t)), express = (motorway && !freeway) || ((trunk || hw === 'primary') && isExpresswayTW(t)) || t.motorroad === 'yes';
  if (hw === 'ferry') return pk === 'foot' ? [ST.DEFAULT_ALLOWED, 'ferry'] : [ST.UNKNOWN, 'ferry'];   // 渡輪：一定載人；能不能載車、載自行車要看標籤（沒標＝未知）
  if (hw === 'busway') return [ST.DEFAULT_RESTRICTED, 'busway'];
  if (hw === 'escape') return [ST.DEFAULT_RESTRICTED, 'escape-lane'];
  if (pk === 'car') {
    if (WALKISH.has(hw) || hw === 'cycleway') return [ST.DEFAULT_RESTRICTED, 'non-motor-way'];
    if (hw === 'track') return [ST.UNKNOWN, 'track'];
    return [ST.DEFAULT_ALLOWED, 'road-class'];
  }
  const ramp = !freeway && !express && isRampTW(t);                                  // 沒標註的匝道：可能是快速道路出入口
  if (pk === 'heavy' || pk === 'moto') {
    if (WALKISH.has(hw) || hw === 'cycleway') return [ST.DEFAULT_RESTRICTED, 'non-motor-way'];
    if (freeway) return [ST.DEFAULT_RESTRICTED, 'freeway-law'];                      // 國道禁行機車（含大型重機）
    if (express && pk === 'moto') return [ST.DEFAULT_RESTRICTED, 'expressway-law'];  // 快速公路、市區快速道路（高架道路）禁行普通機車；大型重機可行
    if (ramp && pk === 'moto') return [ST.UNKNOWN, 'ramp'];
    if (hw === 'track') return [ST.UNKNOWN, 'track'];
    return [ST.DEFAULT_ALLOWED, 'road-class'];
  }
  if (pk === 'bike') {
    if (freeway || express) return [ST.DEFAULT_RESTRICTED, freeway ? 'freeway-law' : 'expressway-law'];
    if (ramp) return [ST.UNKNOWN, 'ramp'];
    if (hw === 'steps' || hw === 'corridor') return [ST.DEFAULT_RESTRICTED, 'steps'];
    if (hw === 'footway' || hw === 'pedestrian' || hw === 'bridleway') return [ST.UNKNOWN, 'footway-bicycle'];
    return [ST.DEFAULT_ALLOWED, 'road-class'];
  }
  // foot
  if (freeway || express) return [ST.DEFAULT_RESTRICTED, freeway ? 'freeway-law' : 'expressway-law'];
  if (ramp) return [ST.UNKNOWN, 'ramp'];
  if (hw === 'cycleway') return [ST.UNKNOWN, 'cycleway-foot'];
  return [ST.DEFAULT_ALLOWED, 'road-class'];
}

function modeOneway(t, p, ow0, implied, hw) {
  for (const k of p.oneway) { const v = parseOneway(t[k]); if (v != null) return v; }
  if (p.key === 'foot') return WALKISH.has(hw) && (ow0 === 1 || ow0 === -1) ? ow0 : 0;   // 行人只受 oneway:foot，或步道本身的單向（例如單向的人行陸橋）
  if (p.key === 'bike' && (ow0 === 1 || ow0 === -1 || (ow0 == null && implied))) {
    for (const k of ['cycleway', 'cycleway:both', 'cycleway:left', 'cycleway:right']) if (/^opposite/.test(t[k] || '')) return 0;   // 腳踏車可逆向（opposite_lane 等）
  }
  return ow0 != null ? ow0 : implied ? 1 : 0;
}
// 依車輛條件的 :conditional（台灣常見：motorcycle:conditional=yes @ (displacement >= 250 cc)、no @ <=250 cc）
// 這類條件跟時間無關，直接依運具的代表排氣量判斷：機車（普通重型，250 cc 以下）以 125 cc、大型重型機車（逾 250 cc）以 550 cc 計
export const DISPLACEMENT_CC = { moto: 125, heavy: 550 };
function splitCond(v) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of String(v)) { if (ch === '(') depth++; else if (ch === ')') depth--; if (ch === ';' && depth <= 0) { parts.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => { const i = p.indexOf('@'); return i < 0 ? null : { value: p.slice(0, i).trim(), cond: p.slice(i + 1).trim().replace(/^\((.*)\)$/s, '$1').trim() }; }).filter(Boolean);
}
const CC_RE = /^(?:displacement\s*)?(<=|>=|<|>|=)\s*(\d+(?:\.\d+)?)\s*cc$/i;
// 回傳 { allCc：每一段都是排氣量條件, hit：符合條件的值（沒有就 null） }
export function displacementRule(v, cc) {
  const parts = splitCond(v); if (!parts.length) return { allCc: false, hit: null };
  let allCc = true, hit = null;
  for (const p of parts) {
    const m = CC_RE.exec(p.cond); if (!m) { allCc = false; continue; }
    if (cc == null) continue;
    const x = +m[2], ok = m[1] === '<=' ? cc <= x : m[1] === '>=' ? cc >= x : m[1] === '<' ? cc < x : m[1] === '>' ? cc > x : cc === x;
    if (ok && hit == null) hit = p.value;
  }
  return { allCc, hit };
}
// 有沒有「依時段等」無法預先判斷的條件（排氣量條件已直接套用，不算）
const hasCond = (t, keys) => keys.some(k => { const v = t[k + ':conditional']; return v != null && !displacementRule(v).allCc; });

// 通用標籤（access、vehicle）不能放寬「這種運具依法規或道路型態本來就不能走」的道路：
//   highway=steps＋access=yes 不代表汽車能開上階梯；國道標 access=yes 也不代表行人、機車能走。
//   只有該運具自己的標籤（motorcar、motorcycle、motor_vehicle、bicycle、foot）能放寬；通用標籤仍然可以更嚴格（access=no、private…）。
//   階梯：汽機車一律不能走；自行車標 bicycle=yes 也只算「有條件」（牽車）。
const GENERIC = new Set(['access', 'vehicle']);
const FIRM = new Set(['non-motor-way', 'freeway-law', 'expressway-law', 'steps', 'footway-bicycle', 'cycleway-foot', 'busway', 'escape-lane', 'ferry']);
const RANK = [1, 3, 3, 2, 0, 0, 0];                     // 寬鬆程度：禁止 0 < 未知 1 < 有條件 2 < 允許 3
const looser = (a, b) => RANK[a & 7] > RANK[b & 7];

// 一條 way 對五種運具的通行狀態；info（選填）收集統計：每種運具每個方向的狀態次數、原因
export function wayAccess(t, info = null) {
  const hw = t.highway, out = new Uint8Array(PROFILES.length);
  const ow0 = parseOneway(t.oneway), implied = t.junction === 'roundabout' || t.junction === 'circular' || hw === 'motorway' || hw === 'motorway_link';
  for (let i = 0; i < PROFILES.length; i++) {
    const p = PROFILES[i], motor = p.key === 'car' || p.key === 'heavy' || p.key === 'moto';
    let d = null; const dflt = () => d || (d = defaultRule(p.key, hw, t));
    let ignored = 0;
    const adj = x => {
      if (!x) return x;
      if (hw === 'steps' && motor && looser(x.st, ST.RESTRICTED)) { ignored++; return null; }
      if (GENERIC.has(x.key.split(':')[0]) && FIRM.has(dflt()[1]) && looser(x.st, dflt()[0])) { ignored++; return null; }
      if (hw === 'steps' && p.key === 'bike' && (x.st & 7) === ST.ALLOWED) return { ...x, st: ST.LIMITED };
      return x;
    };
    let fw = adj(explicit(t, p.chain, ':forward')), bw = adj(explicit(t, p.chain, ':backward'));
    // 排氣量條件：比已採用的標籤更具體（或同一個鍵）的 *:conditional 若符合，直接採用
    if (DISPLACEMENT_CC[p.key] != null) {
      const upto = Math.max(fw ? p.chain.indexOf(fw.key.split(':')[0]) : p.chain.length - 1, bw ? p.chain.indexOf(bw.key.split(':')[0]) : p.chain.length - 1);
      for (let k = 0; k <= upto; k++) {
        const v = t[p.chain[k] + ':conditional']; if (v == null) continue;
        const r = displacementRule(v, DISPLACEMENT_CC[p.key]); if (r.hit == null) continue;
        const x = adj({ st: mapVal(r.hit, p.chain[k] + ':conditional'), key: p.chain[k] + ':conditional' }); if (x) { fw = bw = x; } break;
      }
    }
    let sf = fw ? fw.st : dflt()[0], sb = bw ? bw.st : dflt()[0];
    const ow = modeOneway(t, p, ow0, implied, hw);
    let cond = hasCond(t, [...p.chain, 'oneway', ...p.oneway]) ? COND : 0;
    if (ow === 1 && !isBlocked(sb)) sb = ST.ONEWAY;
    else if (ow === -1 && !isBlocked(sf)) sf = ST.ONEWAY;
    else if (ow === 2) cond = COND;                                                    // 可變向車道：依時段，標成有條件
    out[i] = (sf | cond) | ((sb | cond) << 4);
    if (info) { const a = info[p.key] || (info[p.key] = { fwd: new Array(7).fill(0), reasons: {} }); a.fwd[sf]++; if (!fw && d) a.reasons[d[1]] = (a.reasons[d[1]] || 0) + 1; if (ignored) a.reasons['generic-tag-not-relaxing'] = (a.reasons['generic-tag-not-relaxing'] || 0) + 1; }
  }
  return out;
}
export const fwdOf = (code, i) => code[i] & 15, bwdOf = (code, i) => code[i] >> 4;

// ---------- 節點上的障礙物（barrier）----------
// 預設：柱（bollard）擋汽車與重機、機車未知、自行車與行人可過；閘門（gate、lift_gate…）汽機車未知（可能關閉）；
// 自行車柵（cycle_barrier）自行車要下車牽行；行人閘門、踏階（stile、turnstile、kissing_gate）只有行人可過；收費站可過。
const U = ST.UNKNOWN, A = ST.ALLOWED, L = ST.LIMITED, R = ST.DEFAULT_RESTRICTED;
const BARRIER = {          //            car heavy moto bike foot
  bollard:            [R, R, U, A, A], block: [R, R, R, U, A], jersey_barrier: [R, R, R, U, A], log: [R, R, R, U, A], rock: [R, R, R, U, A],
  cycle_barrier:      [R, R, R, L, A], motorcycle_barrier: [R, R, R, L, A], kissing_gate: [R, R, R, R, A], stile: [R, R, R, R, A], turnstile: [R, R, R, R, A], 'full-height_turnstile': [R, R, R, R, A],
  gate:               [U, U, U, U, A], lift_gate: [U, U, U, U, A], swing_gate: [U, U, U, U, A], sliding_gate: [U, U, U, U, A], chain: [U, U, U, U, A], bar: [U, U, U, U, A], barrier_board: [U, U, U, U, A],
  toll_booth: [A, A, A, A, A], border_control: [A, A, A, A, A], cattle_grid: [A, A, A, A, A], entrance: [A, A, A, A, A], height_restrictor: [A, A, A, A, A], sump_buster: [R, U, U, A, A],
  kerb: [A, A, A, A, A], hampshire_gate: [R, R, R, U, A], debris: [U, U, U, U, U], fence: [R, R, R, R, R], wall: [R, R, R, R, R], yes: [U, U, U, U, U]
};
// 回傳 Uint8Array(5) 狀態（不分方向）；這個點不影響通行時回傳 null
export function nodeAccess(t) {
  if (!t) return null;
  const b = t.barrier; if (!b && !t.access && !t.motor_vehicle && !t.motorcar && !t.motorcycle && !t.bicycle && !t.foot) return null;
  if (!b) return null;                                   // 沒有障礙物的點上的 access 標籤（常是設施點）不影響道路通行
  const row = BARRIER[b] || [U, U, U, U, A], out = new Uint8Array(PROFILES.length);
  for (let i = 0; i < PROFILES.length; i++) { const e = explicit(t, PROFILES[i].chain, ''); out[i] = e ? e.st : row[i]; }
  return out;
}

// 路徑規劃的通行政策：未知與有條件要怎麼處理（預設：可以走，但成本加倍並在結果中警告；不擅自當成一般道路）
export const DEFAULT_POLICY = { unknown: 'avoid', unknownFactor: 3, limited: 'avoid', limitedFactor: 8, conditional: 'allow' };
// 這個狀態能不能走、成本要乘多少（Infinity＝不能走）
export function costFactor(s, pol = DEFAULT_POLICY) {
  const v = s & 7;
  if (v === ST.ALLOWED || v === ST.DEFAULT_ALLOWED) return 1;
  if (v === ST.UNKNOWN) return pol.unknown === 'forbid' ? Infinity : pol.unknown === 'allow' ? 1 : pol.unknownFactor;
  if (v === ST.LIMITED) return pol.limited === 'forbid' ? Infinity : pol.limited === 'allow' ? 1 : pol.limitedFactor;
  return Infinity;
}
