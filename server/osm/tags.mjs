// tags.mjs — OSM 道路標籤正規化（highway、maxspeed、lanes、width、layer、oneway…）
// 原則：沒有標的就是「未知」（NaN／空字串／0＝未標），不補預設值；預設推定一律在 access.mjs 另外標記來源。

// 參與路網的 highway 值（順序就是存檔用的代碼，只能往後加）
export const HIGHWAYS = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'service', 'road', 'track', 'pedestrian', 'footway', 'path', 'cycleway', 'steps', 'bridleway', 'corridor', 'busway', 'escape',
  'ferry',                                                                       // ferry：route=ferry 的渡輪航線（沒有 highway 標籤，進路網時當成這一類）
  'pier_link'];                                                                   // pier_link：航線端點沒接上道路時，建圖補的「碼頭連接（推估）」
export const HW = Object.fromEntries(HIGHWAYS.map((h, i) => [h, i]));
// 不進路網的 highway 值（記錄數量在報告裡）：施工中、計畫中、已廢棄、賽道、月台、休息區、公車導軌…
export const HW_SKIP = new Set(['proposed', 'construction', 'abandoned', 'disused', 'razed', 'planned', 'raceway', 'platform', 'rest_area', 'services', 'bus_guideway', 'elevator', 'via_ferrata', 'emergency_bay', 'turning_circle', 'turning_loop', 'traffic_island', 'no', 'dismantled']);

// 這條 way 要不要進路網；回傳 null＝要，否則回傳排除原因
export function skipReason(t) {
  const h = t.highway;
  if (!h) return 'no-highway';
  if (!(h in HW)) return HW_SKIP.has(h) ? 'highway=' + h : 'highway=' + h + '（未知值）';
  if ((t.area === 'yes') && (h === 'pedestrian' || h === 'footway' || h === 'service' || h === 'path' || h === 'living_street' || h === 'residential')) return 'area=yes（廣場／面狀道路）';
  if (t.construction && t.construction !== 'no' && h === 'construction') return 'construction';
  return null;
}

const num = s => { const v = parseFloat(String(s).replace(',', '.')); return Number.isFinite(v) ? v : NaN; };

// maxspeed → km/h；"50"、"50 km/h"、"30 mph"、"walk"；"50|40"（各車道）取最高；"TW:urban" 這類區域代碼 → NaN（見 zoneMaxspeed）
export function parseMaxspeed(s) {
  if (s == null || s === '') return NaN;
  const v = String(s).trim().toLowerCase();
  if (v === 'walk') return 5;
  if (v.includes('|')) { const parts = v.split('|').map(parseMaxspeed).filter(Number.isFinite); return parts.length ? Math.max(...parts) : NaN; }
  let m = /^(\d+(?:[.,]\d+)?)\s*(km\/h|kmh|kph|mph|knots)?$/.exec(v);
  if (!m) { if (!v.includes(';')) return NaN; const parts = v.split(';').map(parseMaxspeed).filter(Number.isFinite); return parts.length ? Math.min(...parts) : NaN; }   // "50;40" 取較低的；"TW:urban" 這類區域代碼 → 未知
  const n = num(m[1]); return m[2] === 'mph' ? n * 1.609344 : m[2] === 'knots' ? n * 1.852 : n;
}
// width → 公尺；"6"、"6 m"、"6.5m"、"12'6\""（英尺）
export function parseWidth(s) {
  if (s == null || s === '') return NaN;
  const v = String(s).trim().toLowerCase();
  let m = /^(\d+(?:[.,]\d+)?)\s*(m|meters?|公尺)?$/.exec(v); if (m) return num(m[1]);
  m = /^(\d+)'(?:\s*(\d+)")?$/.exec(v); if (m) return (+m[1] * 12 + (+m[2] || 0)) * 0.0254;
  m = /^(\d+(?:[.,]\d+)?)\s*(ft|feet)$/.exec(v); if (m) return num(m[1]) * 0.3048;
  return NaN;
}
export const parseLanes = s => { const v = parseInt(String(s ?? ''), 10); return Number.isFinite(v) && v > 0 && v < 30 ? v : 0; };
export function parseLayer(s) { if (s == null || s === '') return 0; const v = parseInt(String(s), 10); return Number.isFinite(v) && v >= -9 && v <= 9 ? v : 0; }
// 垂直高度層：有 layer 用 layer；沒有時橋＝+1、隧道＝−1、location=underground／underwater＝−1、location=overground／overhead／roof＝+1
// （只用來判斷「同一個節點上，兩條不同高度的道路是否真的相連」）。covered=yes（有頂蓋的平面道路，例如騎樓、穿越建築）不改變高度
export function levelOf(t) {
  if (t.layer != null && t.layer !== '') return parseLayer(t.layer);
  if (isBridge(t)) return 1; if (isTunnel(t)) return -1;
  const loc = String(t.location || '');
  if (loc === 'underground' || loc === 'underwater') return -1; if (loc === 'overground' || loc === 'overhead' || loc === 'roof' || loc === 'rooftop') return 1;
  return 0;
}
export const isBridge = t => !!t.bridge && t.bridge !== 'no';
export const isTunnel = t => !!t.tunnel && t.tunnel !== 'no';
// oneway：1 順向、−1 逆向、0 雙向、2 可變（reversible／alternating，依時段）、null 未標
export function parseOneway(s) {
  if (s == null || s === '') return null;
  const v = String(s).trim().toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return 1;
  if (v === '-1' || v === 'reverse') return -1;
  if (v === 'no' || v === 'false' || v === '0') return 0;
  if (v === 'reversible' || v === 'alternating') return 2;
  return null;
}
export function parseIncline(s) {                       // 百分比；"up"/"down" 沒有數值 → NaN
  if (s == null) return NaN; const m = /^(-?\d+(?:\.\d+)?)\s*%$/.exec(String(s).trim()); return m ? +m[1] : NaN;
}
export const SMOOTHNESS = ['', 'excellent', 'good', 'intermediate', 'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'];
export const smoothCode = s => Math.max(0, SMOOTHNESS.indexOf(String(s ?? '')));
export const TRISTATE = { '': 0, yes: 1, no: 2 };       // lit 等：0 未標、1 有、2 沒有
export const tri = s => (s == null || s === '' ? 0 : s === 'no' || s === 'none' ? 2 : 1);
export const SIDEWALK = ['', 'both', 'left', 'right', 'no', 'separate', 'yes'];
export function sidewalkCode(t) {
  let v = t.sidewalk; if (v === 'none') v = 'no';
  if (v == null && t['sidewalk:both']) v = t['sidewalk:both'] === 'no' ? 'no' : t['sidewalk:both'] === 'separate' ? 'separate' : 'both';
  if (v == null && (t['sidewalk:left'] || t['sidewalk:right'])) { const l = t['sidewalk:left'], r = t['sidewalk:right']; v = l && l !== 'no' && r && r !== 'no' ? 'both' : l && l !== 'no' ? 'left' : r && r !== 'no' ? 'right' : 'no'; }
  return Math.max(0, SIDEWALK.indexOf(v ?? ''));
}
// cycleway：合併 cycleway、cycleway:both/left/right，保留最有意義的一個值
export function cyclewayOf(t) {
  for (const k of ['cycleway', 'cycleway:both', 'cycleway:right', 'cycleway:left']) if (t[k] && t[k] !== 'no') return t[k];
  return t.cycleway === 'no' || t['cycleway:both'] === 'no' ? 'no' : '';
}
export const nameOf = t => t.name || t['name:zh'] || t['name:zh-Hant'] || t['name:zh_TW'] || t['name:en'] || '';
// 快速公路（不是國道的 motorway／trunk 也可能是）：用 motorroad、ref、name 判斷；國道用 ref／name 含「國道」
export const isFreewayTW = t => /國道/.test((t.ref || '') + (t.name || '') + (t['official_name'] || ''));
export const isExpresswayTW = t => t.motorroad === 'yes' || /快速(公路|道路)|高架道路/.test((t.name || '') + (t['official_name'] || '')) || /^[台臺]\s?(61|62|64|65|66|68|72|74|76|78|82|84|86|88)(甲|乙)?\b/.test(t.ref || '');

// 匝道（*_link、名稱有「匝道」）：多半是快速道路的出入口，但沒標註時無法確定（也有一般道路的匝道）
export const isRampTW = t => /_link$/.test(t.highway || '') && /匝道/.test((t.name || '') + (t['official_name'] || ''));

// 區域速限代碼（maxspeed=TW:urban，或 maxspeed:type／source:maxspeed／zone:maxspeed 標了 TW:urban、TW:rural）→ 法定上限 km/h
// 道路交通安全規則第 93 條：沒有速限標誌或標線時，時速不得超過 50 公里；未劃設車道線、行車分向線或分向限制線的道路不得超過 30 公里
// 市區、郊區法規沒有不同（都是 50）；標了 lane_markings=no 的道路用 30。不認得的代碼（例如 TW:trunk）→ NaN
export const TW_ZONE_KMH = { 'tw:urban': 50, 'tw:rural': 50, 'tw:rban': 50 };
export function zoneMaxspeed(t) {
  for (const k of ['maxspeed', 'maxspeed:type', 'source:maxspeed', 'zone:maxspeed']) {
    const v = t[k]; if (v == null) continue;
    const c = String(v).trim().toLowerCase(); if (c in TW_ZONE_KMH) return t.lane_markings === 'no' ? 30 : TW_ZONE_KMH[c];
  }
  return NaN;
}
// duration（渡輪航行時間）→ 秒："01:30"、"1:30:00"、"90"（分）、"PT1H30M"
export function parseDuration(s) {
  if (s == null || s === '') return NaN;
  const v = String(s).trim().toUpperCase();
  let m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(v); if (m) return +m[1] * 3600 + +m[2] * 60 + (+m[3] || 0);
  m = /^(\d+(?:\.\d+)?)$/.exec(v); if (m) return +m[1] * 60;
  m = /^P(?:T)?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(v); if (m && (m[1] || m[2] || m[3])) return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return NaN;
}
