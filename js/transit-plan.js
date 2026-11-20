// transit-plan.js — 全台多運具大眾運輸（v1.11）：呼叫伺服器 /api/v1/transit/plan（RAPTOR：公車、捷運、輕軌、台鐵、高鐵），顯示方案、畫在地圖上
// 只在使用全台 OSM 道路圖（伺服器模式）時使用；本機路網模式維持原本的公車＋捷運規劃。
// 打包（build.mjs）會把模組合併：頂層名稱一律加 tp 前綴
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { esc, fmtDist } from './util.js';
import { lonLatToWorld } from './geo.js';
import { fitBase, resetView, scheduleRender, worldToScreen } from './render-core.js';

const TP_COLOR = { WALK: '#64748b', TRANSFER: '#94a3b8', BUS_RIDE: '#16a34a', METRO_RIDE: '#dc2626', LIGHT_RAIL_RIDE: '#0d9488', TRAIN_RIDE: '#1d4ed8', THSR_RIDE: '#ea580c' };
const TP_ICON = { WALK: '🚶', TRANSFER: '🔁', WAIT: '⏳', BUS_RIDE: '🚌', METRO_RIDE: '🚇', LIGHT_RAIL_RIDE: '🚊', TRAIN_RIDE: '🚆', THSR_RIDE: '🚄' };
const TP_TAG = { fastest: '最快', fewestTransfers: '最少轉乘', leastWalking: '最少步行', cheapest: '最便宜', recommended: '建議' };
const TP_MODES = [['bus', '公車'], ['metro', '捷運'], ['lrt', '輕軌'], ['tra', '台鐵'], ['thsr', '高鐵']];
const tpS = { res: null, sel: 0, err: null };
const tpClock = iso => { const d = new Date(Date.parse(iso) + 8 * 3600e3); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
const tpMin = s => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`; };
export const tpActive = () => !!tpS.res;
export function tpClear() { tpS.res = null; tpS.err = null; tpRender(); scheduleRender(); }

// 「出發時間」欄位（HH:MM）→ 今天該時刻；留空＝現在
function tpDepart() { const v = (document.getElementById('depTime') || {}).value; if (!v) return 'now'; const now = new Date(Date.now() + 8 * 3600e3); return `${now.toISOString().slice(0, 10)}T${v}`; }
function tpModes() { return TP_MODES.map(([k]) => k).filter(k => { const c = document.getElementById('tpm_' + k); return !c || c.checked; }); }
// 規劃（ui-events 的「規劃路線」在大眾運輸＋OSM 模式時呼叫）；ll(p) → [lon, lat]
export async function tpPlan(from, to, ll) {
  const [lo1, la1] = ll(from), [lo2, la2] = ll(to), modes = tpModes();
  const qs = `from=${la1.toFixed(6)},${lo1.toFixed(6)}&to=${la2.toFixed(6)},${lo2.toFixed(6)}&depart=${encodeURIComponent(tpDepart())}&modes=${modes.join(',')}`;
  const r = await fetch('api/v1/transit/plan?' + qs, { headers: { Accept: 'application/json' } }); let j = null; try { j = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok || !j || !j.ok) { const e = new Error((j && j.error && j.error.message) || `HTTP ${r.status}`); e.code = j && j.error ? j.error.code : 'HTTP_' + r.status; tpS.res = null; tpS.err = e; tpRender(); throw e; }
  tpS.res = j.data; tpS.sel = 0; tpS.err = null; tpRender(); tpFit(); scheduleRender();
  return j.data;
}
function tpFit() {
  const it = tpS.res && tpS.res.itineraries[tpS.sel]; if (!it) return; let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const l of it.legs) for (const [lo, la] of (l.geometry && l.geometry.coords) || []) { const [x, y] = lonLatToWorld(lo, la); if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y; }
  if (a < b) { fitBase(a, b, c, d, 50); resetView(); }
}
// 方案清單（#tpBox）
export function tpRender() {
  const box = document.getElementById('tpBox'); if (!box) return;
  if (tpS.err) { box.innerHTML = `<div class="rt na">❌ ${esc(tpS.err.code === 'TRANSIT_NOT_LOADED' ? tpS.err.message : '大眾運輸規劃失敗：' + tpS.err.message)}</div>`; return; }
  const R = tpS.res; if (!R) { box.innerHTML = ''; return; }
  if (!R.itineraries.length) { box.innerHTML = `<div class="rt na">找不到大眾運輸方案${R.notes && R.notes.length ? '：' + esc(R.notes.join('；')) : '（這個時間之後沒有可用的班次，或起終點附近沒有車站）'}</div>${R.walkOnly ? `<div class="hint">步行約 ${tpMin(R.walkOnly.durationS)}、${fmtDist(R.walkOnly.distanceM)}</div>` : ''}`; return; }
  let h = '<div class="tp-list">';
  R.itineraries.forEach((it, i) => {
    const icons = it.legs.filter(l => l.type !== 'WAIT' && !(l.type === 'WALK' && (l.durationS || 0) < 60)).map(l => `<span title="${esc(l.routeName || l.type)}">${TP_ICON[l.type] || '•'}${l.type.endsWith('_RIDE') ? `<small>${esc(l.trainNo || l.routeName || '')}</small>` : ''}</span>`).join('›');
    h += `<div class="tp-opt${i === tpS.sel ? ' sel' : ''}" data-i="${i}"><div class="tp-h"><b>${tpClock(it.departAt)} → ${tpClock(it.arriveAt)}</b> <span>${tpMin(it.durationS)}</span>${(it.tags || []).map(t => `<em class="tp-tag">${TP_TAG[t] || t}</em>`).join('')}</div>
      <div class="tp-i">${icons}</div><div class="tp-m">轉乘 ${it.transfers} 次・步行 ${fmtDist(it.walkM)}・候車 ${tpMin(it.waitS)}${it.fare ? `・${it.fare.complete ? `票價 ${it.fare.total} 元` : '票價不完整'}` : ''}${it.estimated ? '・<span style="color:#b45309">含推估</span>' : ''}</div></div>`;
  });
  h += '</div>';
  const it = R.itineraries[tpS.sel];
  if (it) {
    h += '<div class="tp-legs">';
    for (const l of it.legs) {
      const t = `${tpClock(l.departAt)}${l.arriveAt ? '–' + tpClock(l.arriveAt) : ''}`;
      if (l.type === 'WAIT') { h += `<div class="tp-leg"><span>${TP_ICON.WAIT}</span><div>在 ${esc(l.at.name)} 候車 ${tpMin(l.durationS)}</div></div>`; continue; }
      if (l.type === 'WALK' || l.type === 'TRANSFER') { h += `<div class="tp-leg"><span>${TP_ICON[l.type]}</span><div><b>${t}</b> ${l.type === 'TRANSFER' ? '轉乘' : '步行'} ${l.distanceM ? fmtDist(l.distanceM) + '・' : ''}${tpMin(l.durationS)}：${esc(l.from.name || '')} → ${esc(l.to.name || '')}<div class="hint">${esc(l.source || '')}${l.onSite === true ? '・站內' : l.onSite === false ? '・站外' : ''}</div></div></div>`; continue; }
      const tm = l.timing || {}, note = [tm.kind === 'frequency' ? `依班距推估候車（${Math.round(tm.headwayS[0] / 60)}～${Math.round(tm.headwayS[1] / 60)} 分一班）` : tm.kind === 'stationTimetable' ? '站別時刻表' : tm.kind === 'daily' ? '當日時刻表' : '定期時刻表', tm.delayMin ? `即時誤點 ${tm.delayMin} 分` : '', tm.dayUncertain ? '未註明適用星期' : '', l.fare ? (l.fare.price != null ? `票價 ${l.fare.price} 元（${l.fare.label}）` : `票價 ${l.fare.range ? l.fare.range.join('～') + ' 元，' : ''}${l.fare.label || ''}`) : '無票價資料', l.geometry ? l.geometry.source : ''].filter(Boolean).join('・');
      h += `<div class="tp-leg" style="border-left:4px solid ${TP_COLOR[l.type] || '#334155'}"><span>${TP_ICON[l.type] || '•'}</span><div><b>${t}</b> ${esc(l.routeName || '')}${l.trainNo ? ` ${esc(l.trainNo)} 次` : ''}${l.trainType ? `（${esc(l.trainType)}）` : ''}${l.headsign ? ` 往 ${esc(l.headsign)}` : ''}<br>${esc(l.from.name)} 上車 → ${esc(l.to.name)} 下車（${l.stops} 站、${tpMin(l.durationS)}）<div class="hint">${esc(note)}</div></div></div>`;
    }
    if (it.notes && it.notes.length) h += `<div class="hint">⚠ ${it.notes.map(esc).join('；')}</div>`;
    h += `<div class="hint">資料：TDX（版本 ${esc(String(R.data && R.data.version || '—'))}）；步行：OpenStreetMap 步行路網。車站進出與換車預留時間為系統推估。</div></div>`;
  }
  box.innerHTML = h;
}
// 地圖：目前選的方案（每段依運具上色；步行虛線）
export function drawTransitPlan() {
  const R = tpS.res, it = R && R.itineraries[tpS.sel]; if (!it || !svg) return;
  let h = '<g id="tpLayer">';
  for (const l of it.legs) {
    const c = (l.geometry && l.geometry.coords) || []; if (c.length < 2) continue;
    const d = c.map(([lo, la], i) => { const [x, y] = worldToScreen(...lonLatToWorld(lo, la)); return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1); }).join('');
    const walk = l.type === 'WALK' || l.type === 'TRANSFER';
    h += `<path d="${d}" fill="none" stroke="#fff" stroke-width="${walk ? 6 : 8}" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/><path d="${d}" fill="none" stroke="${TP_COLOR[l.type] || '#334155'}" stroke-width="${walk ? 3.5 : 5}" stroke-linecap="round" stroke-linejoin="round"${walk ? ' stroke-dasharray="2 6"' : ''}/>`;
  }
  for (const l of it.legs) if (l.type.endsWith('_RIDE')) for (const s of [l.from, l.to]) { const [x, y] = worldToScreen(...lonLatToWorld(s.lon, s.lat)); h += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#fff" stroke="${TP_COLOR[l.type]}" stroke-width="3"/><text x="${(x + 9).toFixed(1)}" y="${(y - 8).toFixed(1)}" font-size="12" fill="#1e293b" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(s.name || '')}</text>`; }
  svg.insertAdjacentHTML('beforeend', h + '</g>');
}
export function init() {
  Hooks.drawTransitPlan = drawTransitPlan;
  const row = document.getElementById('transitOnly');
  if (row && !document.getElementById('tpModes')) {
    row.insertAdjacentHTML('beforeend', `<div id="tpModes" class="tp-modes" title="全台大眾運輸（伺服器 RAPTOR）要考慮的運具">${TP_MODES.map(([k, n]) => `<label><input type="checkbox" id="tpm_${k}" checked> ${n}</label>`).join('')}</div><div id="tpBox"></div>`);
  }
  const box = document.getElementById('tpBox');
  if (box) box.addEventListener('click', e => { const o = e.target.closest && e.target.closest('.tp-opt'); if (!o) return; tpS.sel = +o.dataset.i; tpRender(); tpFit(); scheduleRender(); });
}
