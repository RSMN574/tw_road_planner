// road-attrs.js
import { State } from './state.js';
import { CLS, speedCache } from './constants.js';
import { qc, uiEl } from './ctx.js';

export function speedOfEdge(eid) {
  const at = eid != null ? State.edgeAttr.get(eid) : undefined;
  if (at && at.limit > 0 && at.limit < 200) return at.limit;          // 有真實速限就用真實速限
  const ns = eid != null ? State.edgeIdToRoadNames.get(eid) : null;
  if (!ns || ns.size === 0) return 30;
  const nm = ns.values().next().value;
  let v = speedCache.get(nm);
  if (v === undefined) {
    v = /[巷弄]/.test(nm) ? 20 : /快速|國道|省道|高架|大道/.test(nm) ? 50 : /路/.test(nm) ? 40 : 30;
    speedCache.set(nm, v);
  }
  return v;
}

export const busModeOn = () => qc('busMode');

export function readRoadAttr(r) {
  const w = parseFloat(r['路寬'] ?? r.width ?? r.road_width ?? r.roadWidth);
  const t = r['道路型態分類'] ?? r.road_type ?? r.roadType ?? r.class ?? null;
  const l = parseFloat(r['速限'] ?? r.speed_limit ?? r.speedLimit);
  return (isFinite(w) || t || isFinite(l)) ? { width: isFinite(w) && w > 0 ? w : NaN, type: t ? String(t) : '', limit: isFinite(l) ? l : NaN } : null;
}

const FREEWAY = /國道|高速公路/, EXPRESS = /快速道路|快速公路|[台臺](61|62|64|65|66|68|72|74|76|78|82|84|86|88)線/;   // 名稱判斷屬啟發式，清單未必完整
export function classify(typeStr, name) {
  const t = typeStr || '';
  if (/自行車|腳踏車|單車/.test(t)) return CLS.bike;
  if (/步行|人行|步道|徒步/.test(t)) return CLS.walk;
  if (FREEWAY.test(t) || FREEWAY.test(name)) return CLS.freeway;                    // 國道：汽車／重機／公車可行，一般機車與腳踏車不可
  if (EXPRESS.test(t) || EXPRESS.test(name) || /快速/.test(t)) return CLS.expressway;   // 快速道路：一般機車與腳踏車不可
  if (/巷|弄/.test(t)) return CLS.alley;
  if (/主要|主幹|幹道|高架|橋/.test(t)) return CLS.major;
  if (/次要|次幹/.test(t)) return CLS.minor;
  if (/平面|一般|隧道|地下/.test(t)) return CLS.general;        // 真實資料的「平面路段」= 一般地面道路；層級改由路寬判斷
  if (/匝道|交流道|特殊|其他/.test(t)) return CLS.other;
  if (t) return CLS.other;
  if (/自行車道|自行車專用|單車道/.test(name)) return CLS.bike;          // 無型態資料時，僅以路名「明確證據」排除
  if (/步道|人行|徒步/.test(name)) return CLS.walk;
  return CLS.unknown;                                                      // 缺資料 → 未知，不當作適合
}

export const widthScore = w => !(w > 0) ? null : w >= 12 ? 100 : w >= 8 ? 80 : w >= 6 ? 55 : 25;

export const typeScore = c => ({ 1: 85, 2: 100, 3: 70, 4: 35, 7: 30, 8: 60, 9: 60 })[c] ?? null;

export function ensureRA() {                              // 每條鄰接邊的屬性陣列（惰性建立一次）
  if (State.RA && State.RA.m === State.adjEid.length) return State.RA;
  const m = State.adjEid.length, cls = new Uint8Array(m), suit = new Uint8Array(m), unk = new Uint8Array(m), forb = new Uint8Array(m), width = new Float32Array(m).fill(NaN), limit = new Float32Array(m).fill(NaN);
  let nForb = 0, nWithAttr = 0;
  for (let k = 0; k < m; k++) {
    const eid = State.adjEid[k], a = eid != null ? State.edgeAttr.get(eid) : undefined, ns = eid != null ? State.edgeIdToRoadNames.get(eid) : null;
    const name = ns && ns.size ? ns.values().next().value : '';
    let c = classify(a ? a.type : '', name); if (a && a.alley && c !== CLS.bike && c !== CLS.walk) c = CLS.alley; cls[k] = c;
    if (a) { width[k] = a.width; nWithAttr++; if (a.limit > 0 && a.limit < 200) limit[k] = a.limit; }
    if (c === CLS.bike || c === CLS.walk) { forb[k] = 1; nForb++; suit[k] = 0; continue; }
    const ws = widthScore(a ? a.width : NaN), ts = typeScore(c);
    suit[k] = ws != null && ts != null ? Math.round(0.6*ws + 0.4*ts) : ws != null ? Math.min(ws, 60) : ts != null ? Math.min(ts, 60) : 40;
    unk[k] = (ws == null || c === CLS.unknown || c === CLS.alley || c === CLS.other) ? 1 : 0;      // 待人工確認
  }
  State.RA = { m, cls, suit, unk, forb, width, limit, nForb, nWithAttr };
  console.info(`ℹ 道路屬性：${(nWithAttr/2).toLocaleString()} 條邊有路寬/型態資料，${(nForb/2).toLocaleString()} 條邊判定公車不可通行`);
  return State.RA;
}

// 道路屬性表：以「路名」對應到 roads.json 的 edgeIds（同名多筆 → 路寬取長度加權平均、型態取最長者）

export function applyRoadTable() {
  if (!State.roadTable || !State.edgeIdToRoadNames.size) return;
  let hit = new Set();
  for (const [eid, ns] of State.edgeIdToRoadNames) for (const n of ns) {
    const a = State.roadTable.get(n); if (!a) continue;
    const t = [...a.types].sort((x, y) => y[1] - x[1])[0];
    State.edgeAttr.set(eid, { width: a.wL ? a.wl / a.wL : NaN, type: t ? t[0] : '', limit: a.lim, alley: a.alley }); hit.add(n); break;
  }
  State.RA = null; State.graphVersion++; State.vehCache = null;
  uiEl('rtStat').textContent = `屬性表 ${State.roadTable.size} 組路名（含巷弄 ${[...State.roadTable.values()].filter(a => a.alley).length} 組），對應到路網 ${hit.size} / ${State.roadNames.length} 條道路（未對應者維持「未知」）`;
}

export function loadRoadTable(json) {
  const rows = Array.isArray(json) ? json : (json.roads || json.data || json.items || json.rows || []), agg = new Map();
  for (const r of rows) {
    const base = r['路名'] ?? r.name; if (!base) continue;
    const lane = String(r['巷'] ?? '').trim(), alley = String(r['弄'] ?? '').trim();
    const name = base + lane + alley;                                   // 「英才路」與「英才路170巷」是不同道路，不可合併平均
    const L = parseFloat(r['長度'] ?? r.length) || 1, w = parseFloat(r['路寬'] ?? r.width), t = r['道路型態分類'] ?? r.type ?? '', lim = parseFloat(r['速限'] ?? r.speed_limit);
    let a = agg.get(name); if (!a) agg.set(name, a = { wl: 0, wL: 0, types: new Map(), lim: NaN, alley: !!(lane || alley) });
    if (isFinite(w) && w > 0) { a.wl += w * L; a.wL += L; }
    if (t) a.types.set(t, (a.types.get(t) || 0) + L);
    if (isFinite(lim)) a.lim = lim;
  }
  if (!agg.size) throw new Error('找不到含「路名」的資料列');
  State.roadTable = agg;
  if (State.N) applyRoadTable(); else uiEl('rtStat').textContent = `屬性表 ${agg.size} 組路名（載入道路圖後對應）`;
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  document.getElementById('rtFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadRoadTable(JSON.parse(await f.text())); } catch (err) { document.getElementById('rtStat').textContent = '載入失敗：' + err.message; } } });
  fetch('./data/road-attrs.json').then(r => r.ok ? r.json() : null).then(j => j && loadRoadTable(j)).catch(() => {});
}
