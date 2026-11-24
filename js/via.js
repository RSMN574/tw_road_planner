// via.js — 途經點（v1.14）：起點與終點之間最多 5 個途經點；新增（搜尋、點地圖、店家詳細卡）、刪除、上下移動；改變後自動重新規劃；地圖上畫編號標記
// 規劃：伺服器 /api/v1/osm/route?via=緯度,經度;…（分段規劃後接起來）。大眾運輸模式不支援途經點（明確提示，不假裝）。
// 打包會合併模組：頂層名稱一律加 vi 前綴。
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { esc } from './util.js';
import { lonLatToWorld } from './geo.js';
import { scheduleRender, worldToScreen } from './render-core.js';
import { osmPtLL } from './osm.js';
import { icon } from './ui-icons.js';

export const VIA_MAX = 5;
const viId = id => document.getElementById(id);
const viName = p => String((p && (p.name || p.id)) || '途經點').replace(/（.*$/, '').slice(0, 30);

// 給規劃用：「緯度,經度;緯度,經度」；from = 從第幾個開始（導航中偏航重新規劃時，已經過的不再去）
export function viaParam(from = 0) {
  const L = (State.via || []).slice(from).map(p => { const [lo, la] = osmPtLL(p); return `${la.toFixed(6)},${lo.toFixed(6)}`; });
  return L.length ? L.join(';') : undefined;
}
export const viaCount = () => (State.via || []).length;
export const viaRemaining = () => Math.max(0, viaCount() - (State.viaDone || 0));

function viChanged(replan = true) {
  viRender(); scheduleRender();
  if (replan && State.fromPoint && State.toPoint && !(State.nav && State.nav.engine)) { const g = viId('go'); if (g && !g.disabled) g.click(); }
}
export function addVia(p) {
  if (!p) return false; State.via = State.via || [];
  if (State.via.length >= VIA_MAX) { viHint(`途經點最多 ${VIA_MAX} 個`); return false; }
  State.via.push({ ...p, name: viName(p) }); State.viaPending = false; viChanged(); return true;
}
export function removeVia(i) { if (!State.via || !State.via[i]) return; State.via.splice(i, 1); viChanged(); }
export function moveVia(i, d) { const L = State.via || [], j = i + d; if (!L[i] || j < 0 || j >= L.length) return; [L[i], L[j]] = [L[j], L[i]]; viChanged(); }
export function clearVia() { if (!viaCount()) return; State.via = []; State.viaDone = 0; viChanged(); }
// 「新增途經點」：下一個選到的點（搜尋結果、點地圖）當成途經點
export function viaPick(on = true) {
  State.viaPending = on; viRender();
  const to = viId('to'); if (on && to) { to.value = ''; to.focus(); }
}
function viHint(t) { const h = viId('viaHint'); if (h) { h.textContent = t; h.hidden = false; clearTimeout(viHint.t); viHint.t = setTimeout(() => { h.hidden = true; }, 3000); } }

function viRender() {
  const box = viId('viaRows'); if (!box) return; const L = State.via || [], transit = (viId('mode') || {}).value === 'transit';
  box.innerHTML = L.map((p, i) => `<div class="via-row" data-i="${i}"><span class="via-num">${i + 1}</span><span class="via-name" title="${esc(viName(p))}">${esc(viName(p))}</span>
      <button type="button" class="ds-icon-btn via-b" data-up="${i}" aria-label="途經點 ${i + 1} 往前" ${i ? '' : 'disabled'}>${icon('up', 18)}</button>
      <button type="button" class="ds-icon-btn via-b" data-down="${i}" aria-label="途經點 ${i + 1} 往後" ${i < L.length - 1 ? '' : 'disabled'}>${icon('down', 18)}</button>
      <button type="button" class="ds-icon-btn via-b" data-del="${i}" aria-label="刪除途經點 ${i + 1}">${icon('close', 18)}</button></div>`).join('') +
    (State.viaPending ? `<div class="via-pending">${icon('pin', 16)} 搜尋或點地圖選擇途經點 <button type="button" class="ds-link" data-cancel="1">取消</button></div>` :
      L.length < VIA_MAX ? `<button type="button" class="ds-link via-add" data-add="1">${icon('plus', 16)} 新增途經點</button>` : `<small class="ds-muted">途經點最多 ${VIA_MAX} 個</small>`) +
    (L.length && transit ? `<small class="ds-muted via-note">大眾運輸不支援途經點，規劃時會直接從起點到終點</small>` : '') +
    `<small class="ds-muted" id="viaHint" hidden></small>`;
  const cl = document.body && document.body.classList; if (cl && cl.toggle) cl.toggle('via-pending', !!State.viaPending);
}

// 地圖上的途經點標記（紫色編號）
function viDraw() {
  const L = State.via || []; if (!svg || !L.length) return; let h = '<g id="viaMarks">';
  L.forEach((p, i) => { let ll; try { ll = osmPtLL(p); } catch { return; } const [x, y] = worldToScreen(...lonLatToWorld(ll[0], ll[1])), done = State.nav && State.nav.engine && i < (State.viaDone || 0);
    h += `<g class="via-mk${done ? ' done' : ''}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="11" class="via-c"/><text y="4" text-anchor="middle">${i + 1}</text><title>途經點 ${i + 1}：${esc(viName(p))}</title></g>`; });
  svg.insertAdjacentHTML('beforeend', h + '</g>');
}

export function init() {
  State.via = State.via || []; State.viaDone = 0; State.viaPending = false;
  Hooks.addVia = addVia; Hooks.viaParam = viaParam;
  const prev = Hooks.drawExtra; Hooks.drawExtra = () => { if (prev) prev(); viDraw(); };
  const od = viId('dsOdRows'), toRow = viId('toInfo') && viId('toInfo').closest && viId('toInfo').closest('.row');
  if (!od || typeof document.createElement !== 'function' || !od.insertBefore) return;     // 沒有 UI v2 外殼（測試替身）
  const box = document.createElement('div'); box.id = 'viaRows'; box.setAttribute('aria-label', '途經點');
  od.insertBefore(box, toRow && toRow.parentNode === od ? toRow : null);
  box.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button'); if (!b) return;
    if (b.dataset.add) viaPick(true); else if (b.dataset.cancel) viaPick(false);
    else if (b.dataset.del != null) removeVia(+b.dataset.del); else if (b.dataset.up != null) moveVia(+b.dataset.up, -1); else if (b.dataset.down != null) moveVia(+b.dataset.down, 1);
  });
  viId('mode')?.addEventListener('change', () => viRender());
  // 清除起訖（既有的「清除」按鈕）時一併清掉途經點
  viId('clear')?.addEventListener('click', () => { State.via = []; State.viaDone = 0; State.viaPending = false; viRender(); });
  // 每次開始導航：從第一個途經點算起（同一條路線導航第二次也正確）
  document.addEventListener('navstate', e => { if (e && e.detail === 'start') { State.viaDone = 0; scheduleRender(); } });
  viRender();
}
export const viaDebug = () => ({ via: viaCount(), done: State.viaDone || 0, pending: !!State.viaPending });
