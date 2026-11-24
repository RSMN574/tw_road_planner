// poi.js — 店家地點搜尋（v1.13）：搜尋下拉的「地點」區、類別快捷鈕、結果清單（底部面板）、地圖編號標記（縮小時合併）、詳細卡（設為目的地／起點）
// 資料：伺服器 /api/v1/poi/*（OpenStreetMap，ODbL）。沒有評分、評論；營業時間只有部分地點有，判斷不了就顯示原文。
// 打包會合併模組：頂層名稱一律加 po 前綴。不用 import 別名。
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { esc, fmtDist } from './util.js';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { panBy, scheduleRender, screenToWorld, worldToScreen, zoomAt } from './render-core.js';
import { setPoint } from './ui-search.js';
import { osmNameFor, osmOn, osmPoint } from './osm.js';
import { icon } from './ui-icons.js';
import { sheetTo } from './ui-shell.js';

const poId = id => document.getElementById(id);
const poS = { list: [], sel: -1, title: '', q: '', category: null, openNow: false, data: null, seq: 0, detail: null };
// 類別快捷（code 對應 server/osm/poi-categories.mjs）
const PO_CHIPS = [['fuel', 'fuel', '加油站'], ['convenience', 'store', '便利商店'], ['restaurant', 'food', '餐廳'], ['cafe', 'cafe', '咖啡'], ['parking', 'parking', '停車場'], ['atm', 'bank', 'ATM'], ['hospital', 'health', '醫院'], ['clinic', 'health', '診所'], ['pharmacy', 'pill', '藥局'], ['toilets', 'toilet', '廁所'], ['charging', 'fuel', '充電站'], ['hotel', 'bed', '住宿']];
const PO_OPEN = { open: ['open', '營業中'], closing: ['closing', '即將打烊'], closed: ['closed', '已打烊'], unknown: ['unknown', ''] };

// 地圖中心（經緯度）；有 GPS 定位且在畫面內時用 GPS
function poCenter() {
  try { const w = svg.clientWidth || 800, h = svg.clientHeight || 600, [lo, la] = worldToLonLat(...screenToWorld(w / 2, h / 2)); if (Number.isFinite(lo) && Number.isFinite(la)) return [la, lo]; } catch { /* 地圖還沒準備好 */ }
  return null;
}
async function poGet(path, params) {
  const u = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, v);
  const r = await fetch('api/v1/poi/' + path + '?' + u.toString()), j = await r.json().catch(() => null);
  if (!j || !j.ok) { const e = new Error((j && j.error && j.error.message) || `HTTP ${r.status}`); e.code = j && j.error && j.error.code; throw e; }
  return j.data;
}
export function poiSearch(q, { category, openNow, limit = 15 } = {}) {
  const c = poCenter(); return poGet('search', { q, category, openNow: openNow ? 1 : '', limit, near: c ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : '' });
}
const poDist = r => (r.distanceM != null ? fmtDist(r.distanceM) : '');
const poPlace = r => r.address || (r.nearRoad ? `${r.nearRoad}（附近道路）` : '');
const poBadge = r => { const o = PO_OPEN[r.open] || PO_OPEN.unknown; return o[1] ? `<span class="po-open ${o[0]}">${o[1]}</span>` : ''; };
const poName = r => r.name || r.categoryLabel;

// ---------- 搜尋下拉的「地點」區（ui-search.js 透過 Hooks.poiSuggest 呼叫）----------
// 回傳 true＝有放東西進去
function poSuggest(result, data, which, q) {
  if (!data || !data.results || !data.results.length) return false;
  const head = document.createElement('div'); head.className = 'po-sec'; head.textContent = data.mode === 'category' ? `${data.results[0].categoryLabel}・${data.near && data.near.name ? data.near.name + '附近' : '附近'}` : '地點'; result.appendChild(head);
  for (const r of data.results.slice(0, which === 'from' ? 5 : 6)) {
    const div = document.createElement('div'); div.className = 'po-sug';
    div.innerHTML = `<span class="po-ic">${icon(r.icon || 'pin', 20)}</span><span class="po-t"><b>${esc(poName(r))}</b><small>${esc(r.categoryLabel)}${poDist(r) ? '・' + poDist(r) : ''}${poPlace(r) ? '・' + esc(poPlace(r)) : ''} ${poBadge(r)}</small></span>`;
    div.onclick = () => { result.innerHTML = ''; if (which === 'from') { poSetAs(r, 'from'); return; } poShowList(data, q, data.results.indexOf(r)); };
    result.appendChild(div);
  }
  const more = data.total > 6 || (data.results.length > 6);
  if (which !== 'from' && more) { const div = document.createElement('div'); div.className = 'po-sug po-all'; div.innerHTML = `<span class="po-ic">${icon('list', 20)}</span><span class="po-t"><b>查看全部${data.total ? ` ${data.total} 筆` : ''}</b></span>`; div.onclick = () => { result.innerHTML = ''; poFull(q); }; result.appendChild(div); }
  return true;
}

// ---------- 結果清單（底部面板）＋地圖標記 ----------
// 完整清單（Enter、查看全部）：最多 30 筆
function poFull(q) {
  const to = poId('to'); if (to) to.blur(); poS.category = null; poS.openNow = false; const my = ++poS.seq;
  poiSearch(q, { limit: 30 }).then(d => { if (my === poS.seq) poShowList(d, q); }).catch(err => { if (my === poS.seq) { poS.list = []; poS.title = `「${q}」`; poS.data = null; document.body.classList.add('poi-mode'); poRenderList(); const b = poId('poiList'); if (b) b.insertAdjacentHTML('beforeend', `<p class="ds-muted">${esc(err.message)}</p>`); sheetTo('half'); } });
}
function poShowList(data, q, sel = -1) {
  poS.data = data; poS.list = data.results || []; poS.q = q; poS.category = data.mode === 'category' ? data.category : poS.category; poS.sel = -1;
  poS.title = data.mode === 'category' ? `${(poS.list[0] && poS.list[0].categoryLabel) || q}・${data.near && data.near.name ? data.near.name + '附近' : '附近'}` : `「${q}」`;
  document.body.classList.add('poi-mode'); poRenderList(); poFit();
  if (sel >= 0) poSelect(sel, true); else { poCloseCard(); sheetTo('half'); }
  scheduleRender();
}
function poRenderList() {
  const box = poId('poiList'); if (!box) return; const L = poS.list;
  const head = `<div class="po-head"><b>${esc(poS.title)}</b><span class="po-cnt">${L.length ? `${L.length} 筆` : ''}</span>
    <label class="po-filter"><input type="checkbox" id="poOpenNow" ${poS.openNow ? 'checked' : ''}> 營業中</label><button type="button" class="ds-icon-btn" data-po-close="1" aria-label="關閉搜尋結果">${icon('close', 20)}</button></div>`;
  if (!L.length) { box.innerHTML = head + `<div class="ds-state ds-empty">${icon('search', 28)}<p>${poS.openNow ? '附近沒有確定營業中的地點（多數店家沒有提供營業時間）' : '找不到符合的地點'}。可以改用類別（例如「加油站」）或路名搜尋。</p></div>`; return; }
  const note = poS.data && poS.data.note ? `<p class="ds-muted po-note">${esc(poS.data.note)}</p>` : '';
  box.innerHTML = head + note + `<ol class="po-list" role="listbox" aria-label="搜尋結果">` + L.map((r, i) => `<li role="option" aria-selected="${i === poS.sel}" class="po-row${i === poS.sel ? ' sel' : ''}" data-i="${i}">
    <span class="po-num">${i + 1}</span><span class="po-t"><b>${esc(poName(r))}</b><small>${esc(r.categoryLabel)}${poDist(r) ? '・' + poDist(r) : ''} ${poBadge(r)}</small>${poPlace(r) ? `<small class="po-addr">${esc(poPlace(r))}</small>` : ''}${r.moreSameName ? `<small class="po-more">附近還有 ${r.moreSameName} 家同名</small>` : ''}</span>
    <button type="button" class="po-go" data-go="${i}" aria-label="設為目的地：${esc(poName(r))}">${icon('route', 20)}<span>路線</span></button></li>`).join('') + '</ol>' +
    `<p class="ds-muted po-src">資料：© OpenStreetMap contributors（ODbL）・沒有評分與評論</p>`;
}
async function poRerun() {
  const my = ++poS.seq; let d;
  try { d = await poiSearch(poS.category && poS.data && poS.data.mode === 'category' ? '' : poS.q, { category: poS.data && poS.data.mode === 'category' ? poS.category : null, openNow: poS.openNow, limit: 30 }); }
  catch (e) { const box = poId('poiList'); if (box && my === poS.seq) box.insertAdjacentHTML('beforeend', `<div class="ds-state ds-error" role="alert">${icon('warn', 28)}<p>${esc(e.message)}</p></div>`); return; }
  if (my !== poS.seq) return; const keep = poS.title; poShowList(d, poS.q); poS.title = keep; poRenderList();
}
export function poiCategory(code, label) {
  const to = poId('to'); if (to) { to.value = label; to.blur(); } const r = poId('toResult'); if (r) r.innerHTML = '';
  poS.category = code; poS.openNow = false; const my = ++poS.seq; poS.q = label;
  const box = poId('poiList'); document.body.classList.add('poi-mode'); if (box) box.innerHTML = `<div class="po-head"><b>${esc(label)}・附近</b></div><div class="ds-cards"><div class="ds-route ds-skel"><i></i><i></i><i></i></div></div>`; sheetTo('half');
  poGet('search', { category: code, limit: 30, near: (c => (c ? `${c[0].toFixed(5)},${c[1].toFixed(5)}` : ''))(poCenter()) })
    .then(d => { if (my === poS.seq) poShowList(d, label); })
    .catch(e => { if (my === poS.seq && box) box.innerHTML = `<div class="po-head"><b>${esc(label)}</b><button type="button" class="ds-icon-btn" data-po-close="1" aria-label="關閉">${icon('close', 20)}</button></div><div class="ds-state ds-error" role="alert">${icon('warn', 28)}<p>${esc(e.code === 'NO_POI' ? '伺服器沒有店家地點資料' : e.message)}</p></div>`; });
}
export function poiClear() {
  poS.list = []; poS.sel = -1; poS.data = null; poS.seq++; document.body.classList.remove('poi-mode'); poCloseCard(); const box = poId('poiList'); if (box) box.innerHTML = ''; scheduleRender();
}

// 把地圖移到所有標記（避開面板／卡片）
function poFit() {
  const L = poS.list; if (!L.length || !svg) return; const w = svg.clientWidth || 375, h = svg.clientHeight || 800, wide = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches;
  const pts = L.map(r => worldToScreen(...lonLatToWorld(r.lon, r.lat)));
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  const box = wide ? [404 + 24, 80, w - 72, h - 40] : [24, 84, w - 72, h * 0.52 - 8];      // 可見區域 [左, 上, 右, 下]
  // 最小範圍約 600 m（只有一兩個點時不要放太大）
  const r0 = L[0], [ax] = worldToScreen(...lonLatToWorld(r0.lon, r0.lat)), [bx] = worldToScreen(...lonLatToWorld(r0.lon + 600 / (111320 * Math.cos(r0.lat * Math.PI / 180)), r0.lat)), minPx = Math.max(1e-3, Math.abs(bx - ax));
  const bw = box[2] - box[0], bh = box[3] - box[1], k = Math.max(0.02, Math.min(bw / Math.max(minPx, x1 - x0), bh / Math.max(minPx, y1 - y0)) * 0.85);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; zoomAt(cx, cy, k); panBy((box[0] + box[2]) / 2 - cx, (box[1] + box[3]) / 2 - cy);
}
function poPanTo(r) {
  if (!svg) return; const w = svg.clientWidth || 375, h = svg.clientHeight || 800, wide = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches;
  const [x, y] = worldToScreen(...lonLatToWorld(r.lon, r.lat)), tx = wide ? (404 + w) / 2 : w / 2, ty = wide ? h / 2 : 84 + (h * 0.5 - 84) / 2;
  if (x < (wide ? 420 : 16) || x > w - 16 || y < 84 || y > (wide ? h - 16 : h * 0.55)) panBy(tx - x, ty - y);
}

// ---------- 地圖標記（Hooks.drawExtra 的後半段）----------
const PO_CELL = 34;
function poDraw() {
  if (!svg || !poS.list.length || (State.nav && State.nav.engine)) return;
  const pts = poS.list.map((r, i) => { const [x, y] = worldToScreen(...lonLatToWorld(r.lon, r.lat)); return { i, x, y }; });
  const cells = new Map(), solo = [];
  for (const p of pts) { if (p.i === poS.sel) { solo.push(p); continue; } const k = Math.floor(p.x / PO_CELL) + ',' + Math.floor(p.y / PO_CELL), c = cells.get(k); if (c) c.push(p); else cells.set(k, [p]); }
  let h = '<g id="poMarks">';
  for (const c of cells.values()) {
    if (c.length === 1) { solo.unshift(c[0]); continue; }
    const x = c.reduce((s, p) => s + p.x, 0) / c.length, y = c.reduce((s, p) => s + p.y, 0) / c.length;
    h += `<g class="po-cl" data-x="${x.toFixed(1)}" data-y="${y.toFixed(1)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="15" class="po-cl-c"/><text y="5" text-anchor="middle">${c.length}</text><title>${c.length} 個地點（點一下放大）</title></g>`;
  }
  for (const p of solo) {
    const r = poS.list[p.i], s = p.i === poS.sel;
    h += `<g class="po-mk${s ? ' sel' : ''}" data-i="${p.i}" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><path d="M0 0c-${s ? 6 : 4.5} -${s ? 9 : 7} -${s ? 13 : 10} -${s ? 14 : 11} -${s ? 13 : 10} -${s ? 22 : 17}a${s ? 13 : 10} ${s ? 13 : 10} 0 1 1 ${s ? 26 : 20} 0c0 ${s ? 8 : 6} -${s ? 7 : 5.5} ${s ? 13 : 10} -${s ? 13 : 10} ${s ? 22 : 17}z" class="po-pin"/>` +
      `<text y="${s ? -18 : -14}" text-anchor="middle">${p.i + 1}</text>${s ? `<text class="po-lbl" y="14" text-anchor="middle">${esc(poName(r).slice(0, 16))}</text>` : ''}<title>${esc(poName(r))}</title></g>`;
  }
  svg.insertAdjacentHTML('beforeend', h + '</g>');
}

// ---------- 選取、詳細卡 ----------
function poSelect(i, pan) {
  const r = poS.list[i]; if (!r) return; poS.sel = i; poRenderList();
  const row = document.querySelector(`#poiList .po-row[data-i="${i}"]`); if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  if (pan) poPanTo(r); scheduleRender(); poOpenCard(r);
}
function poCloseCard() { const c = poId('poiCard'); if (c) c.hidden = true; poS.detail = null; }
async function poOpenCard(r) {
  const card = poId('poiCard'); if (!card) return; poS.detail = r.id; card.hidden = false;
  if (!(typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches)) sheetTo('peek');
  poCardHtml(card, r, null);
  try { const d = await poGet('detail', { id: r.id }); if (poS.detail === r.id) poCardHtml(card, { ...d, distanceM: r.distanceM }, d); }
  catch (e) { if (poS.detail === r.id) card.querySelector('.po-c-more').innerHTML = `<p class="ds-muted">${esc(e.message)}</p>`; }
}
const poSafeUrl = u => { try { const x = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
function poCardHtml(card, r, d) {
  const o = PO_OPEN[r.open] || PO_OPEN.unknown, rows = [];
  rows.push(`<p class="po-c-open">${o[1] ? `<span class="po-open ${o[0]}">${o[1]}</span> ` : ''}${esc(r.open === 'unknown' && r.openText ? r.openText : (r.openText && r.openText !== o[1] ? r.openText : ''))}</p>`);
  if (d && d.hours && !d.hoursEvaluable) rows.push(`<p class="ds-muted">營業時間（原文，無法自動判斷）：${esc(d.hours)}</p>`); else if (d && d.hours) rows.push(`<p class="ds-muted">營業時間：${esc(d.hours)}</p>`);
  if (poPlace(r)) rows.push(`<p>${icon('pin', 16)} ${esc(poPlace(r))}${d && d.level ? `（${esc(d.level)} 樓）` : ''}</p>`);
  if (d && d.phone) { const tel = String(d.phone).split(/[;,]/)[0].trim(); rows.push(`<p>${icon('phone', 16)} <a href="tel:${esc(tel.replace(/[^\d+]/g, ''))}">${esc(tel)}</a></p>`); }
  const web = d && d.website && poSafeUrl(d.website); if (web) rows.push(`<p>${icon('globe', 16)} <a href="${esc(web)}" target="_blank" rel="noopener noreferrer">${esc(web.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 40))}</a></p>`);
  card.innerHTML = `<div class="ds-ev-h"><span class="po-c-title"><b>${esc(poName(r))}</b><small>${esc(r.categoryLabel)}${poDist(r) ? '・' + poDist(r) : ''}${r.nameEn && r.nameEn !== r.name ? '・' + esc(r.nameEn) : ''}</small></span><button type="button" class="ds-icon-btn" data-po-cclose="1" aria-label="關閉">${icon('close', 20)}</button></div>
    ${rows.join('')}<div class="po-c-more">${d ? '' : '<p class="ds-muted">載入詳細資料…</p>'}</div>
    <div class="po-c-act"><button type="button" class="ds-btn-1" data-po-as="to">${icon('flag', 18)} 設為目的地</button><button type="button" class="ds-btn-2" data-po-as="from">${icon('locate', 18)} 設為起點</button></div>
    <p class="ds-muted po-src">資料：© OpenStreetMap contributors（ODbL）${d && d.osm ? `・<a href="${esc(d.osm.url)}" target="_blank" rel="noopener noreferrer">在 OSM 查看／修正</a>` : ''}</p>`;
  card.dataset.id = r.id; card._po = r;
}
function poSetAs(r, which) {
  if (!r) return; const p = osmPoint(r.lon, r.lat, poName(r)); p.poi = r.id; if (r.address) p.road = r.address;
  setPoint(p, which); if (osmOn()) osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo');
  const inp = poId(which === 'from' ? 'from' : 'to'); if (inp) inp.value = poName(r);
  poiClear(); if (which === 'to') sheetTo('half'); scheduleRender();
}

export function init() {
  const top = poId('dsTop'), body = poId('panel') && poId('panel').querySelector && poId('panel').querySelector('.body'), wrap = poId('canvasWrap');
  if (!top || !body || !wrap || typeof document.createElement !== 'function' || !body.insertBefore) return;   // 沒有 UI v2 外殼（測試替身）：不建
  // 類別快捷鈕：搜尋列下方
  const chips = document.createElement('div'); chips.id = 'poiChips'; chips.setAttribute('role', 'toolbar'); chips.setAttribute('aria-label', '附近類別');
  chips.innerHTML = PO_CHIPS.map(([c, ic, n]) => `<button type="button" data-cat="${c}">${icon(ic, 16)}<span>${n}</span></button>`).join('');
  document.body.insertBefore(chips, top.nextSibling);
  chips.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button[data-cat]'); if (b) poiCategory(b.dataset.cat, b.textContent.trim()); });
  // 清單（面板最上方）、詳細卡（地圖上）
  const list = document.createElement('div'); list.id = 'poiList'; list.setAttribute('aria-live', 'polite'); body.insertBefore(list, body.firstChild);
  list.addEventListener('click', e => {
    const t = e.target; if (!t.closest) return;
    if (t.closest('[data-po-close]')) { poiClear(); const to = poId('to'); if (to && !State.toPoint) to.value = ''; sheetTo('peek'); return; }
    const g = t.closest('[data-go]'); if (g) { poSetAs(poS.list[+g.dataset.go], 'to'); return; }
    const row = t.closest('.po-row'); if (row) poSelect(+row.dataset.i, true);
  });
  list.addEventListener('change', e => { if (e.target.id === 'poOpenNow') { poS.openNow = e.target.checked; poRerun(); } });
  const card = document.createElement('div'); card.id = 'poiCard'; card.className = 'ds-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '地點資訊'); card.hidden = true; wrap.appendChild(card);
  card.addEventListener('click', e => { const t = e.target; if (!t.closest) return; if (t.closest('[data-po-cclose]')) { poCloseCard(); if (poS.list.length) sheetTo('half'); return; } const b = t.closest('[data-po-as]'); if (b) poSetAs(card._po, b.dataset.poAs); });
  // 點地圖標記（捕獲階段，避免地圖把它當成選點）
  const hit = e => {
    const t = e.target; if (!t || !t.closest) return; const m = t.closest('.po-mk'), c = t.closest('.po-cl'); if (!m && !c) return;
    e.stopPropagation(); if (e.cancelable && e.type !== 'touchstart') e.preventDefault();
    if (m) poSelect(+m.getAttribute('data-i'), false); else { zoomAt(+c.getAttribute('data-x'), +c.getAttribute('data-y'), 2.2); scheduleRender(); }
  };
  if (svg) { svg.addEventListener('mousedown', hit, true); svg.addEventListener('touchstart', hit, { capture: true, passive: true }); }
  // 頂部搜尋列按 Enter：顯示完整清單
  const to = poId('to');
  if (to) to.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || e.isComposing) return; const q = to.value.trim(); if (!q || /^-?\d+(\.\d+)?\s*[, ]\s*-?\d+(\.\d+)?$/.test(q) || !osmOn()) return;
    e.preventDefault(); const res = poId('toResult'); if (res) res.innerHTML = ''; poFull(q);
  });
  // 掛到既有流程：下拉加「地點」區、地圖多畫一層
  Hooks.poiSearch = q => (osmOn() ? poiSearch(q, { limit: 8 }) : Promise.resolve(null));
  Hooks.poiSuggest = poSuggest;
  const prev = Hooks.drawExtra; Hooks.drawExtra = () => { if (prev) prev(); poDraw(); };
  document.addEventListener('navstate', () => { if (State.nav && State.nav.engine) poiClear(); });
}
export const poiDebug = () => ({ list: poS.list.length, sel: poS.sel, title: poS.title, mode: document.body.classList.contains('poi-mode') });
