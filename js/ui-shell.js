// ui-shell.js — UI v2 外殼（v1.12）：頂部搜尋列＋語音、浮動地圖按鈕（右上／右下）、底部可拖拽面板（手機）／左側浮動卡片（平板、桌機、車機）、
// 路線方案卡片、空／載入／錯誤狀態、常用地址（家、公司、最近）、選單（主題、省電樣式、車機模式、進階設定）、道路事件圖層、導航中依日出日落切換深色
//
// 原則：不改規劃與導航的邏輯——既有元素（同一個 id、同一組事件）只是「搬位置」到新的外殼裡；新元件只呼叫既有的公開函式或觸發既有按鈕。
// 設計規格：docs/design/UI_V2_DESIGN.md。打包會合併模組：頂層名稱一律加 sh 前綴。
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { esc, fmtDist } from './util.js';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { panBy, scheduleRender, screenToWorld, worldToScreen, zoomAt } from './render-core.js';
import { setActive } from './ui-panels.js';
import { setPoint } from './ui-search.js';
import { osmNameFor, osmOn, osmPoint, osmPtLL } from './osm.js';
import { icon } from './ui-icons.js';
import { setNightHint, setThemePref, themePref } from './pwa.js';

const shId = id => document.getElementById(id);
const shStore = { get(k, d) { try { const v = localStorage.getItem('ui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('ui.' + k, JSON.stringify(v)); } catch {} } };
const shEl = (tag, attrs = {}, html = '') => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (html) e.innerHTML = html; return e; };
const shMove = (node, parent, before = null) => { if (node && parent) parent.insertBefore(node, before); return node; };
const shWide = () => typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches;
const SH_MODES = [['car', 'car', '汽車'], ['moto', 'moto', '機車'], ['bike', 'bike', '自行車'], ['walk', 'walk', '步行'], ['transit', 'transit', '大眾運輸']];
const shClock = ms => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const shMin = m => (m >= 60 ? `${Math.floor(m / 60)} 小時 ${Math.round(m % 60)} 分` : `${Math.max(1, Math.round(m))} 分`);

// ---------- 底部面板（三段吸附）----------
const SH_STATES = ['peek', 'half', 'full'];
let shSheet = 'peek';
export function sheetTo(st) {
  const p = shId('panel'); if (!p || !p.classList) return; shSheet = SH_STATES.includes(st) ? st : 'half';
  for (const s of SH_STATES) p.classList.toggle('sheet-' + s, s === shSheet);
  p.style.transform = '';
  const h = shId('dsHandle'); if (h && h.setAttribute) h.setAttribute('aria-expanded', shSheet === 'peek' ? 'false' : 'true');
}
function shSheetDrag(p, handle) {
  let y0 = null, t0 = 0, base = 0, moved = false;
  const H = () => p.getBoundingClientRect().height, offOf = st => { const h = H(); return st === 'full' ? 0 : st === 'half' ? h - innerHeight * 0.48 : h - 96; };
  const down = e => { if (shWide() || (e.target.closest && e.target.closest('button'))) return; y0 = e.clientY; t0 = performance.now(); base = offOf(shSheet); moved = false; p.classList.add('dragging'); handle.setPointerCapture?.(e.pointerId); };
  const move = e => { if (y0 == null) return; const dy = e.clientY - y0; if (Math.abs(dy) > 4) moved = true; const off = Math.max(0, Math.min(H() - 72, base + dy)); p.style.transform = `translateY(${off}px)`; };
  const up = e => {
    if (y0 == null) return; p.classList.remove('dragging'); const dy = e.clientY - y0, v = dy / Math.max(1, performance.now() - t0); y0 = null;
    if (!moved) { sheetTo(shSheet === 'peek' ? 'half' : shSheet === 'half' ? 'full' : 'peek'); return; }
    const off = Math.max(0, base + dy), cands = SH_STATES.map(s => [s, Math.abs(offOf(s) - off)]).sort((a, b) => a[1] - b[1]);
    sheetTo(Math.abs(v) > 0.6 ? (v > 0 ? (shSheet === 'full' ? 'half' : 'peek') : (shSheet === 'peek' ? 'half' : 'full')) : cands[0][0]);   // 快速甩動依方向，慢慢拖依最近的位置
  };
  handle.addEventListener('pointerdown', down); handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  handle.addEventListener('keydown', e => { if (e.key === 'ArrowUp') { sheetTo(shSheet === 'peek' ? 'half' : 'full'); e.preventDefault(); } else if (e.key === 'ArrowDown') { sheetTo(shSheet === 'full' ? 'half' : 'peek'); e.preventDefault(); } else if (e.key === 'Enter' || e.key === ' ') { sheetTo(shSheet === 'peek' ? 'half' : 'peek'); e.preventDefault(); } });
  handle.addEventListener('click', e => { if (e.target.closest && e.target.closest('button')) return; if (shWide()) sheetTo(shSheet === 'peek' ? 'half' : 'peek'); });
}

// ---------- 常用地址 ----------
const shFav = () => shStore.get('fav', {}), shRecent = () => shStore.get('recent', []);
function shPointLL(p) { try { return p && (p.ll || (p.osm ? osmPtLL(p) : worldToLonLat(p.lon, p.lat))); } catch { return null; } }
function shGoTo(f) { if (!f || !f.ll) return; const p = osmPoint(f.ll[0], f.ll[1], f.name); setPoint(p, 'to'); if (osmOn()) osmNameFor(p, 'toInfo'); scheduleRender(); }
function shRenderQuick() {
  const box = shId('dsQuick'); if (!box) return; const f = shFav(), rec = shRecent().slice(0, 4);
  const chip = (k, ic, label, sub) => `<button type="button" class="ds-chipbtn" data-fav="${k}" ${f[k] ? '' : 'data-empty="1"'}>${icon(ic, 20)}<span><b>${label}</b><small>${esc(sub)}</small></span></button>`;
  box.innerHTML = `<div class="ds-quick-row">${chip('home', 'home', '家', f.home ? f.home.name : '尚未設定')}${chip('work', 'work', '公司', f.work ? f.work.name : '尚未設定')}</div>` +
    (rec.length ? `<div class="ds-sec">最近</div>${rec.map((r, i) => `<button type="button" class="ds-recent" data-rec="${i}">${icon('clock', 18)}<span>${esc(r.name)}</span></button>`).join('')}` :
      `<div class="ds-state ds-empty">${icon('search', 28)}<p>搜尋目的地、點地圖選點，或用目前位置出發</p></div>`);
}
function shRemember(which) {
  const p = which === 'to' ? State.toPoint : null, ll = shPointLL(p); if (!ll) return;
  const name = (p.road ? p.id + '・' + p.road : p.id) || `${ll[1].toFixed(4)}, ${ll[0].toFixed(4)}`;
  const r = shRecent().filter(x => Math.hypot(x.ll[0] - ll[0], x.ll[1] - ll[1]) > 2e-4); r.unshift({ name: String(name).slice(0, 40), ll }); shStore.set('recent', r.slice(0, 8)); shRenderQuick();
}

// ---------- 路線方案卡片 ----------
function shCards() {
  const box = shId('dsRoutes'); if (!box) return; const st = shId('status'), stCls = st && st.className, set = State.routeSet || [];
  if (stCls === 'loading' && !set.some(x => x.route)) { box.innerHTML = '<div class="ds-cards">' + '<div class="ds-route ds-skel"><i></i><i></i><i></i></div>'.repeat(2) + '</div>'; return; }
  if (stCls === 'error' && !set.some(x => x.route)) { box.innerHTML = `<div class="ds-state ds-error" role="alert">${icon('warn', 28)}<p>${esc((st.innerText || '規劃失敗').replace(/^[❌⚠]\s*/, ''))}</p><button type="button" class="ds-btn-2" data-retry="1">重試</button></div>`; return; }
  const ok = set.filter(x => x.route); if (!ok.length) { box.innerHTML = ''; return; }
  const now = Date.now();
  box.innerHTML = `<div class="ds-cards" role="listbox" aria-label="路線方案">` + ok.map((it, i) => {
    const o = it.route._osm || {}, sel = it.key === State.activeKey, ev = (o.events || []).length, km = (it.route.distance || o.distanceM || 0) / 1000, toll = it.toll > 0 ? it.toll / 1000 : 0;
    return `<button type="button" class="ds-route${sel ? ' sel' : ''}" role="option" aria-selected="${sel}" data-k="${esc(it.key)}">
      <span class="ds-route-tag ${i === 0 ? 'rec' : ''}">${i === 0 ? '推薦' : '備選'}・${esc(it.label)}</span>
      <span class="ds-route-time">${shMin(it.min)}</span>
      <span class="ds-route-sub">${km.toFixed(km < 10 ? 1 : 0)} 公里・${shClock(now + it.min * 60e3)} 到達</span>
      <span class="ds-traffic none" title="沒有即時路況資料"><i style="width:100%"></i></span><span class="ds-traffic-lbl">無即時路況資料</span>
      <span class="ds-route-meta">${o.signals != null ? `<span title="紅綠燈">${icon('light', 16)}${o.signals}</span>` : ''}${toll ? `<span title="行經國道（收費，費率未計）">${icon('toll', 16)}國道 ${toll.toFixed(0)} km</span>` : ''}${ev ? `<span class="ds-chip warn" title="路線經過的道路事件（TDX）">${icon('event', 14)}事件 ${ev}</span>` : ''}</span>
    </button>`;
  }).join('') + '</div>';
  const a = box.querySelector('.ds-route.sel'); if (a && a.scrollIntoView && !shWide()) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// 路線規劃完成後，把路線移到看得到的區域：手機在面板上方（面板半展開約蓋住下半部）、平板桌機在左側卡片右邊
let shFitted = null;
function shFitAbove() {
  const set = State.routeSet; if (!set || set === shFitted || !set.some(x => x.route) || shSheet === 'peek') return; shFitted = set;
  const w = svg.clientWidth || 375, h = svg.clientHeight || 800, top = 76, visH = h * 0.52 - top;
  if (shWide()) { const card = 404; zoomAt(w / 2, h / 2, Math.max(0.5, (w - card - 24) / w)); panBy(card / 2, 0); scheduleRender(); return; }   // 平板／桌機：避開左側卡片
  zoomAt(w / 2, h / 2, Math.max(0.45, Math.min(1, visH / (h - 120)))); panBy(0, -(h / 2 - (top + visH / 2))); scheduleRender();
}

// ---------- 道路事件圖層（TDX）----------
const shEv = { on: false, list: [], at: 0, bbox: null, busy: false };
function shViewBBox() { const w = svg.clientWidth || 800, h = svg.clientHeight || 600, c = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => worldToLonLat(...screenToWorld(x, y))); const lo = c.map(p => p[0]), la = c.map(p => p[1]); return [Math.min(...lo), Math.min(...la), Math.max(...lo), Math.max(...la)]; }
async function shEvFetch() {
  if (shEv.busy || !osmOn()) return; const bb = shViewBBox(); if (bb.some(x => !Number.isFinite(x)) || (bb[2] - bb[0]) > 1.2) { shEv.list = []; return; }   // 太大的範圍不抓（全台約 3,000 筆）
  shEv.busy = true; shEv.bbox = bb; shEv.at = Date.now();
  try { const r = await fetch('api/v1/traffic/events?bbox=' + bb.map(x => x.toFixed(4)).join(',')), j = await r.json(); shEv.list = j && j.ok ? j.data.events : []; shEv.note = j && j.ok ? (j.data.available ? '' : j.data.note) : ''; }
  catch { shEv.list = []; } finally { shEv.busy = false; scheduleRender(); }
}
const SH_EV_COLOR = { 交通事故: '#c5221f', 施工: '#b06000', 壅塞: '#c5221f', 特殊管制: '#7b1fa2', 天氣: '#1967d2', 災害: '#c5221f', 活動: '#00796b' };
function shDrawEvents() {
  if (!shEv.on || !svg) return; const bb = shViewBBox();
  if (!shEv.bbox || Date.now() - shEv.at > 180e3 || bb[0] < shEv.bbox[0] || bb[2] > shEv.bbox[2] || bb[1] < shEv.bbox[1] || bb[3] > shEv.bbox[3]) { clearTimeout(shEv.t); shEv.t = setTimeout(shEvFetch, 400); }
  let h = '<g id="dsEvents">';
  for (const e of shEv.list) { const [x, y] = worldToScreen(...lonLatToWorld(e.at[1], e.at[0])), c = SH_EV_COLOR[e.type] || '#5f6368';
    h += `<g class="ds-ev" data-id="${esc(e.eventId)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="11" fill="${c}" stroke="#fff" stroke-width="2"/><path d="M0-5v5M0 3.5v.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><title>${esc(e.type)}：${esc(e.title || e.description || '')}</title></g>`; }
  svg.insertAdjacentHTML('beforeend', h + '</g>');
}
function shShowEvent(id) {
  const e = shEv.list.find(x => x.eventId === id), card = shId('dsEventCard'); if (!e || !card) return;
  const t = ms => (ms ? new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
  card.innerHTML = `<div class="ds-ev-h"><b>${esc(e.type)}</b><button type="button" class="ds-icon-btn" data-close="1" aria-label="關閉">${icon('close', 20)}</button></div><p>${esc(e.title || '')}</p><p class="ds-muted">${esc(e.description || '')}</p>
    <p class="ds-muted">影響：${esc(e.severityLabel)}　期間：${t(e.startTime)} ～ ${t(e.endTime)}</p><p class="ds-muted">來源：${esc(e.source || 'TDX')}（交通部 TDX 道路事件）${e.mapped ? '' : '・未對應到路網，不影響路線'}</p>`;
  card.hidden = false;
}

// ---------- 語音輸入（Web Speech API，瀏覽器支援才顯示）----------
function shVoice(btn, input) {
  const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition); if (!SR) { btn.hidden = true; return; }
  let rec = null;
  btn.addEventListener('click', () => {
    if (rec) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'zh-TW'; rec.interimResults = false; rec.maxAlternatives = 1; btn.classList.add('listening'); btn.setAttribute('aria-label', '收音中，再按一下停止');
    rec.onresult = e => { const t = e.results[0][0].transcript.trim(); input.value = t; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); };
    rec.onend = () => { rec = null; btn.classList.remove('listening'); btn.setAttribute('aria-label', '語音輸入'); };
    rec.onerror = () => { btn.classList.add('err'); setTimeout(() => btn.classList.remove('err'), 1500); };
    try { rec.start(); } catch { rec = null; btn.classList.remove('listening'); }
  });
}

// ---------- 日出日落（導航中、主題設為「自動」時：天黑自動深色）----------
// NOAA 簡化公式：太陽高度角 < −0.833° 視為天黑；誤差數分鐘，只用來切換配色
export function sunAltitude(lat, lon, ms) {
  const d = ms / 864e5 - 10957.5, R = Math.PI / 180, g = (357.529 + 0.98560028 * d) * R, q = 280.459 + 0.98564736 * d, L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * R;
  const e = (23.439 - 0.00000036 * d) * R, ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)), dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24, ha = ((gmst * 15 + lon) * R - ra);
  return Math.asin(Math.sin(lat * R) * Math.sin(dec) + Math.cos(lat * R) * Math.cos(dec) * Math.cos(ha)) / R;
}
function shNightTick() {
  const nav = State.nav, fix = nav && nav.fix; if (!nav) { setNightHint(null); return; }
  const lat = fix ? fix.lat : 23.7, lon = fix ? fix.lon : 121; setNightHint(sunAltitude(lat, lon, Date.now()) < -0.833);
}

// ---------- 建立外殼 ----------
export function init() {
  const panel = shId('panel'), body = panel && panel.querySelector && panel.querySelector('.body'), wrap = shId('canvasWrap'), mc = shId('mapCtl');
  if (!panel || !body || !wrap || typeof document.createElement !== 'function' || !panel.insertBefore) return;   // 測試用的 DOM 替身：不建外殼
  document.body.classList.add('ds');
  // ① 頂部搜尋列：把既有的「終點」輸入框與結果清單搬進來（同一個元素、同一組事件）
  const top = shEl('div', { id: 'dsTop', role: 'search' }), to = shId('to'), toRes = shId('toResult');
  top.innerHTML = `<button type="button" class="ds-icon-btn" id="dsMenuBtn" aria-label="選單" aria-haspopup="true" aria-expanded="false">${icon('menu')}</button><div class="ds-search">${icon('search', 20)}</div><button type="button" class="ds-icon-btn" id="dsMic" aria-label="語音輸入">${icon('mic')}</button>`;
  document.body.insertBefore(top, document.body.firstChild);
  const sw = top.querySelector('.ds-search'); if (to) { to.placeholder = '搜尋店家、地點、路名或緯度,經度'; to.setAttribute('aria-label', '搜尋目的地'); shMove(to, sw); } if (toRes) { toRes.classList.add('ds-results'); shMove(toRes, top); }
  shVoice(shId('dsMic'), to);
  // 選單
  const menu = shEl('div', { id: 'dsMenu', role: 'menu', hidden: '' }); document.body.appendChild(menu);
  const renderMenu = () => { const tp = themePref(), cl = document.body.classList;
    menu.innerHTML = `<div class="ds-sec">外觀</div><div class="ds-seg" role="radiogroup" aria-label="深色模式">${[['auto', '自動'], ['light', '淺色'], ['dark', '深色']].map(([k, n]) => `<button type="button" role="radio" aria-checked="${tp === k}" data-theme="${k}">${n}</button>`).join('')}</div>
      <label class="ds-toggle"><input type="checkbox" id="dsLite" ${cl.contains('lite') ? 'checked' : ''}> 省電樣式（關閉半透明與陰影）</label>
      <label class="ds-toggle"><input type="checkbox" id="dsCar" ${cl.contains('car') ? 'checked' : ''}> 車機模式（大字、大按鈕）</label>
      <div class="ds-sec">更多</div><button type="button" class="ds-menu-item" data-act="adv">${icon('layers', 20)} 資料與進階設定</button>
      ${shId('installBtn') && !shId('installBtn').hidden ? `<button type="button" class="ds-menu-item" data-act="install">${icon('plus', 20)} 加入主畫面</button>` : ''}
      <p class="ds-muted ds-credit">地圖 © OpenStreetMap contributors（ODbL）・大眾運輸與道路事件：交通部 TDX</p>`; };
  const menuBtn = shId('dsMenuBtn'), openMenu = v => { menu.hidden = !v; menuBtn.setAttribute('aria-expanded', String(v)); if (v) renderMenu(); };
  menuBtn.addEventListener('click', e => { e.stopPropagation(); openMenu(menu.hidden); });
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target) && e.target !== menuBtn) openMenu(false); });
  menu.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button'); if (!b) return;
    if (b.dataset.theme) { setThemePref(b.dataset.theme); renderMenu(); }
    if (b.dataset.act === 'adv') { openMenu(false); sheetTo('full'); const m = shId('dsMore'); if (m) { m.open = true; m.scrollIntoView?.({ block: 'start' }); } }
    if (b.dataset.act === 'install') { shId('installBtn')?.click(); openMenu(false); }
  });
  menu.addEventListener('change', e => { if (e.target.id === 'dsLite') { document.body.classList.toggle('lite', e.target.checked); shStore.set('lite', e.target.checked); } if (e.target.id === 'dsCar') { document.body.classList.toggle('car', e.target.checked); shStore.set('car', e.target.checked); } });
  if (shStore.get('lite', false)) document.body.classList.add('lite'); if (shStore.get('car', false)) document.body.classList.add('car');

  // ② 浮動地圖按鈕：右上（圖層、道路事件、2D／3D、指北）、右下（定位、縮放）。仍放在 #mapCtl 裡（map-view.js 的點擊委派照常）
  if (mc) {
    const gTop = shEl('div', { class: 'ds-fab-group top' }), gBot = shEl('div', { class: 'ds-fab-group bottom' }), lay = shEl('div', { id: 'dsLayers', class: 'ds-pop', hidden: '' });
    gTop.innerHTML = `<button type="button" id="dsLayerBtn" aria-label="圖層" aria-haspopup="true" aria-expanded="false">${icon('layers')}</button><button type="button" id="dsEvBtn" aria-label="道路事件（施工、事故）" aria-pressed="false">${icon('event')}</button>`;
    gBot.innerHTML = `<button type="button" id="dsLocate" aria-label="目前位置">${icon('locate')}</button>`;
    for (const id of ['mapPitch', 'mapNorth']) shMove(shId(id), gTop);
    for (const id of ['mapZoomIn', 'mapZoom', 'mapZoomOut']) shMove(shId(id), gBot);
    lay.innerHTML = `<div class="ds-sec">地圖</div><label class="ds-toggle"><input type="checkbox" id="dsEvChk"> 道路事件（TDX 施工、事故、管制）</label><label class="ds-toggle"><input type="checkbox" id="dsInspect"> 點地圖查詢道路資訊</label><div class="ds-pop-row"></div>
      <p class="ds-muted">即時壅塞（紅／黃／綠）目前沒有資料來源，不顯示。</p>`;
    for (const id of ['mapRotL', 'mapRotR', 'mapFit']) shMove(shId(id), lay.querySelector('.ds-pop-row'));
    gTop.appendChild(lay); mc.appendChild(gTop); mc.appendChild(gBot);
    const zi = shId('mapZoomIn'), zo = shId('mapZoomOut'), nb = shId('mapNorth'); if (zi) zi.innerHTML = icon('plus'); if (zo) zo.innerHTML = icon('minus'); if (nb) nb.innerHTML = `<span>${icon('north')}</span>`;
    const rl = shId('mapRotL'), rr = shId('mapRotR'), mf = shId('mapFit'); if (rl) rl.textContent = '⟲ 左轉 15°'; if (rr) rr.textContent = '⟳ 右轉 15°'; if (mf) mf.textContent = '顯示全圖';
    const lb = shId('dsLayerBtn'); lb.addEventListener('click', e => { e.stopPropagation(); lay.hidden = !lay.hidden; lb.setAttribute('aria-expanded', String(!lay.hidden)); });
    document.addEventListener('click', e => { if (!lay.hidden && !lay.contains(e.target) && !lb.contains(e.target)) { lay.hidden = true; lb.setAttribute('aria-expanded', 'false'); } });
    const setEv = v => { shEv.on = v; shId('dsEvBtn').setAttribute('aria-pressed', String(v)); shId('dsEvChk').checked = v; shStore.set('events', v); if (v) shEvFetch(); scheduleRender(); };
    shId('dsEvBtn').addEventListener('click', () => setEv(!shEv.on)); shId('dsEvChk').addEventListener('change', e => setEv(e.target.checked));
    const cm = shId('clickMode'); shId('dsInspect').addEventListener('change', e => { if (cm) { cm.value = e.target.checked ? 'inspect' : 'pick'; cm.dispatchEvent(new Event('change')); } if (e.target.checked) sheetTo('half'); });
    shId('dsLocate').addEventListener('click', () => { if (State.nav && State.nav.engine) { const r = shId('navRecenter'); if (r && !r.hidden) r.click(); } else shId('myLoc')?.click(); });
    if (shStore.get('events', false)) setTimeout(() => setEv(true), 1500);
  }
  const evCard = shEl('div', { id: 'dsEventCard', class: 'ds-card', role: 'dialog', 'aria-label': '道路事件', hidden: '' }); wrap.appendChild(evCard);
  evCard.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-close]')) evCard.hidden = true; });
  const evHit = e => { const g = e.target && e.target.closest && e.target.closest('.ds-ev'); if (!g) return; e.stopPropagation(); if (e.cancelable && e.type !== 'touchstart') e.preventDefault(); shShowEvent(g.getAttribute('data-id')); };
  if (svg) { svg.addEventListener('mousedown', evHit, true); svg.addEventListener('touchstart', evHit, { capture: true, passive: true }); }

  // ③ 底部面板：把手、快速區（常用地址）、規劃區（起訖、交通方式、路線卡、開始導航）；其他既有設定收進「資料與進階設定」
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '路線規劃面板');
  const h1 = panel.querySelector('h1'); if (h1) { h1.id = 'dsHandle'; h1.setAttribute('tabindex', '0'); h1.setAttribute('role', 'button'); h1.setAttribute('aria-label', '展開或收合面板（可拖曳）'); h1.insertAdjacentHTML('afterbegin', '<span class="ds-grabber" aria-hidden="true"></span>'); shSheetDrag(panel, h1); }
  const quick = shEl('div', { id: 'dsQuick' }), plan = shEl('div', { id: 'dsPlan' });
  plan.innerHTML = `<div class="ds-od"><div class="ds-od-rows" id="dsOdRows"></div><button type="button" class="ds-icon-btn" id="dsSwap" aria-label="起點終點互換">${icon('swap')}</button></div>
    <div class="ds-modes" role="tablist" aria-label="交通方式">${SH_MODES.map(([k, ic, n]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="false">${icon(ic, 20)}<span>${n}</span></button>`).join('')}</div>
    <div id="dsRoutes" aria-live="polite"></div><div class="ds-actions" id="dsActions"></div><div class="ds-favset"><button type="button" class="ds-link" data-setfav="home">設為家</button><button type="button" class="ds-link" data-setfav="work">設為公司</button></div>`;
  body.insertBefore(plan, body.firstChild); body.insertBefore(quick, plan);
  // 起點、終點資訊列搬進規劃區
  const fromRow = shId('from') && shId('from').closest('.row'), toRow = shId('toInfo') && shId('toInfo').closest('.row'), od = shId('dsOdRows');
  if (fromRow) { fromRow.classList.add('ds-od-from'); shMove(fromRow, od);
    // 起點已設定時只顯示一行（點一下才展開搜尋框與「使用目前位置」）
    const fi = shId('fromInfo'), fin = shId('from'); if (fi) { fi.setAttribute('role', 'button'); fi.setAttribute('tabindex', '0'); fi.addEventListener('click', () => { fromRow.classList.add('editing'); fin && fin.focus(); }); }
    if (fin) fin.addEventListener('blur', () => setTimeout(() => { if (State.fromPoint && !fromRow.contains(document.activeElement)) fromRow.classList.remove('editing'); }, 300)); } if (toRow) { toRow.classList.add('ds-od-to'); shMove(toRow, od); }
  shMove(shId('osmRow'), plan); shMove(shId('transitOnly'), plan);
  const act = shId('dsActions'); shMove(shId('go'), act); shMove(shId('startNav'), act); shMove(shId('navHint'), act);
  const sn = shId('startNav'); if (sn) { sn.innerHTML = `${icon('route', 20)} 開始導航`; sn.removeAttribute('style'); }
  const goB = shId('go'); if (goB) goB.classList.add('ds-btn-2');
  // 其餘：收進「資料與進階設定」
  const more = shEl('details', { id: 'dsMore' }); more.innerHTML = '<summary>資料與進階設定</summary>'; body.appendChild(more);
  for (const n of [...body.children]) if (n !== quick && n !== plan && n !== more && !['status', 'routes', 'busBox', 'ttBox', 'analysisBox', 'roadInfo', 'hlInfo', 'steps', 'stopBox'].includes(n.id)) more.appendChild(n);
  shMove(shId('status'), plan, shId('dsRoutes'));
  const detail = shEl('details', { id: 'dsDetail' }); detail.innerHTML = '<summary>路線詳細（逐步指示、分析）</summary>'; body.insertBefore(detail, more);
  for (const id of ['routes', 'busBox', 'ttBox', 'analysisBox', 'roadInfo', 'hlInfo', 'steps', 'stopBox']) shMove(shId(id), detail);

  // 事件
  quick.addEventListener('click', e => { const b = e.target.closest && e.target.closest('button'); if (!b) return; if (b.dataset.fav) { const f = shFav()[b.dataset.fav]; if (f) shGoTo(f); else { sheetTo('half'); to && to.focus(); } } if (b.dataset.rec != null) shGoTo(shRecent()[+b.dataset.rec]); });
  plan.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button'); if (!b) return;
    if (b.dataset.mode) { const m = shId('mode'); if (m) { m.value = b.dataset.mode; m.dispatchEvent(new Event('change', { bubbles: true })); } shSyncModes(); if (State.fromPoint && State.toPoint) shId('go')?.click(); }
    if (b.id === 'dsSwap') { const f = State.fromPoint, t = State.toPoint; if (t) setPoint(t, 'from'); if (f) setPoint(f, 'to'); if (State.fromPoint && State.toPoint) shId('go')?.click(); }
    if (b.dataset.setfav) { const ll = shPointLL(State.toPoint); if (!ll) return; const f = shFav(); f[b.dataset.setfav] = { name: String(State.toPoint.road ? State.toPoint.road : State.toPoint.id).slice(0, 30), ll }; shStore.set('fav', f); shRenderQuick(); b.textContent = '已儲存 ✓'; setTimeout(() => { b.textContent = b.dataset.setfav === 'home' ? '設為家' : '設為公司'; }, 1500); }
  });
  shId('dsRoutes').addEventListener('click', e => { const c = e.target.closest && e.target.closest('.ds-route'); if (c && c.dataset.k) { setActive(c.dataset.k); shCards(); } if (e.target.closest && e.target.closest('[data-retry]')) shId('go')?.click(); });
  const shSyncModes = () => { const v = (shId('mode') || {}).value; for (const b of plan.querySelectorAll('[data-mode]')) b.setAttribute('aria-selected', String(b.dataset.mode === v || (b.dataset.mode === 'moto' && v === 'heavy'))); };
  shId('mode')?.addEventListener('change', shSyncModes); shSyncModes();
  // 既有面板內容變了 → 更新新元件（不改既有程式）
  const obs = (id, fn, o = { childList: true, subtree: true, characterData: true }) => { const n = shId(id); if (n && typeof MutationObserver !== 'undefined') new MutationObserver(fn).observe(n, o); };
  obs('routes', () => { shCards(); shFitAbove(); }); obs('status', () => shCards(), { attributes: true, childList: true, subtree: true });
  let auto = 0;
  obs('toInfo', () => { const has = !!State.toPoint; document.body.classList.toggle('has-dest', has); if (has) { shRemember('to'); if (shSheet === 'peek') sheetTo('half'); clearTimeout(auto); auto = setTimeout(() => { if (State.fromPoint && State.toPoint && !(State.nav && State.nav.engine) && !shId('go').disabled) shId('go').click(); }, 350); } });
  obs('fromInfo', () => { if (fromRow) fromRow.classList.toggle('set', !!State.fromPoint); if (State.fromPoint && fromRow && !fromRow.contains(document.activeElement)) fromRow.classList.remove('editing'); clearTimeout(auto); auto = setTimeout(() => { if (State.fromPoint && State.toPoint && !(State.nav && State.nav.engine) && !shId('go').disabled) shId('go').click(); }, 350); });
  Hooks.drawExtra = shDrawEvents;
  document.addEventListener('themechange', () => scheduleRender());
  setInterval(shNightTick, 60e3); document.addEventListener('navstate', shNightTick);
  shRenderQuick(); shCards(); sheetTo(shWide() ? 'half' : 'peek');
  if (typeof matchMedia !== 'undefined') matchMedia('(min-width: 900px)').addEventListener?.('change', () => sheetTo(shWide() ? 'half' : 'peek'));
}
export const shellDebug = () => ({ sheet: shSheet, events: shEv.list.length, eventsOn: shEv.on });
void fmtDist;
