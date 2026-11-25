// bus-live.js — 公車即時（v1.19）：地圖上的公車站牌、站牌即時到站卡、選取路線的公車位置
// 資料：/api/v1/transit/stops（畫面範圍的站牌）、/api/v1/transit/stop（到站）、/api/v1/transit/vehicles（車輛；伺服器向 TDX 取 A1／A2／N1／Shape）
// ・站牌放大到 z15.5 以上才顯示；卡片開著才每 30 秒更新到站，選了路線才每 20 秒更新車輛；分頁在背景時不更新（不浪費 API）
// ・車輛圖層 <g id="blVeh"> 單獨更新：畫面沒在移動時只換這一層，不重畫整張地圖
// ・過期的位置畫灰色並寫「N 秒前」；伺服器已把 10 分鐘以上的舊位置排除；沒有吸附到路線線形的位置會標示「原始 GPS」
// 打包會合併模組：頂層名稱一律加 bl 前綴；不用 import 別名。
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { esc } from './util.js';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { panBy, scheduleRender, screenToWorld, worldToScreen, zoomAt } from './render-core.js';
import { currentZoom } from './map-view.js';
import { osmOn } from './osm.js';
import { icon } from './ui-icons.js';

const BL_MINZ = 15.5;
const blS = { on: true, stops: [], bbox: null, busy: false, t: null, err: '', card: null, cardAt: 0, route: null, routeData: null, routeAt: 0, selPlate: null, timers: [] };
const blStore = { get(k, d) { try { const v = localStorage.getItem('ui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('ui.' + k, JSON.stringify(v)); } catch {} } };
const blId = id => document.getElementById(id);
const blNow = () => Date.now();
const blHM = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
const blHMS = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
const blMin = s => (s < 60 ? '即將進站' : `${Math.round(s / 60)} 分`);
async function blGet(path, params) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`api/v1/transit/${path}?${qs}`, { headers: { Accept: 'application/json' } }); let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  if (!r.ok || !j || !j.ok) throw new Error((j && j.error && j.error.message) || `HTTP ${r.status}`);
  return j.data;
}
const blNavOn = () => !!(State.nav && State.nav.engine);
function blViewBBox() {
  const w = svg.clientWidth || 800, h = svg.clientHeight || 600, c = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => worldToLonLat(...screenToWorld(x, y)));
  const lo = c.map(p => p[0]), la = c.map(p => p[1]); return [Math.min(...lo), Math.min(...la), Math.max(...lo), Math.max(...la)];
}

// ---------- 站牌圖層 ----------
async function blFetchStops() {
  if (blS.busy || !blS.on || !osmOn() || blNavOn() || !(currentZoom() >= BL_MINZ)) return;
  const v = blViewBBox(); if (v.some(x => !Number.isFinite(x))) return;
  const pw = (v[2] - v[0]) * 0.2, ph = (v[3] - v[1]) * 0.2, bb = [v[0] - pw, v[1] - ph, v[2] + pw, v[3] + ph];
  if ((bb[2] - bb[0]) * (bb[3] - bb[1]) > 0.0016) return;                                 // 伺服器的上限：太大就等放大
  blS.busy = true;
  try { const d = await blGet('stops', { bbox: bb.map(x => x.toFixed(5)).join(',') }); blS.stops = d.stops; blS.bbox = bb; blS.err = ''; }
  catch (e) { blS.err = e.message; blS.bbox = bb; } finally { blS.busy = false; scheduleRender(); }
}
function blDrawStops() {
  if (!blS.on || blNavOn() || !(currentZoom() >= BL_MINZ)) return '';
  const v = blViewBBox(), out = !blS.bbox || v[0] < blS.bbox[0] || v[2] > blS.bbox[2] || v[1] < blS.bbox[1] || v[3] > blS.bbox[3];
  if (out && !blS.busy) { clearTimeout(blS.t); blS.t = setTimeout(blFetchStops, 400); }
  const sel = blS.card && blS.card.uid, onRoute = blS.routeData ? new Set(blS.routeData.stops.map(s => s.uid)) : null; let h = '';
  for (const s of blS.stops) {
    const [x, y] = worldToScreen(...lonLatToWorld(s.lon, s.lat)), on = onRoute && onRoute.has(s.uid);
    h += `<g class="bl-stop${s.uid === sel ? ' sel' : ''}${on ? ' on' : ''}" data-uid="${esc(s.uid)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})"><circle r="${s.uid === sel ? 7 : 5}"/><title>${esc(s.name)}（${s.routes} 條路線）</title></g>`;
  }
  return h ? `<g id="blStops">${h}</g>` : '';
}

// ---------- 選取路線：線形＋車輛 ----------
function blVehHtml() {
  const d = blS.routeData; if (!d || blNavOn()) return '';
  let h = ''; const z = currentZoom();
  for (const v of d.vehicles) {
    const [x, y] = worldToScreen(...lonLatToWorld(v.pos[0], v.pos[1])), sel = v.plate === blS.selPlate, az = Number.isFinite(v.azimuth) ? v.azimuth : null;   // 方位角＝北為 0 順時針；整個場景的旋轉由 render-core 處理
    h += `<g class="bl-veh${v.stale ? ' stale' : ''}${v.snapped ? '' : ' raw'}${sel ? ' sel' : ''}" data-plate="${esc(v.plate)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">` +
      (az != null ? `<path class="bl-dir" d="M0 -19L6 -11L-6 -11Z" transform="rotate(${az.toFixed(0)})"/>` : '') +
      `<rect x="-10" y="-10" width="20" height="20" rx="5"/><path class="bl-bus" d="M-5 -5h10v7h-10zM-5 4h3M2 4h3" />` +
      (z >= 15 || sel ? `<text y="22" text-anchor="middle">${esc(v.plate)}${v.stale ? `（${v.ageS} 秒前）` : ''}</text>` : '') +
      `<title>${esc(d.route.name)} 往${esc(d.route.destination || '')}・${esc(v.plate)}${v.stale ? `・位置已過期（${v.ageS} 秒前）` : `・${v.ageS} 秒前`}${v.snapped ? '' : '・原始 GPS（未吸附到路線）'}</title></g>`;
  }
  return `<g id="blVeh">${h}</g>`;
}
function blDrawRoute() {
  const d = blS.routeData; if (!d || blNavOn()) return '';
  let h = '';
  if (d.shape && d.shape.coords.length > 1) h += `<path class="bl-line" d="M${d.shape.coords.map(([lo, la]) => worldToScreen(...lonLatToWorld(lo, la)).map(n => n.toFixed(1)).join(' ')).join('L')}"/>`;
  return `<g id="blRoute" pointer-events="none">${h}</g>`;
}
function blDraw() {
  if (!svg || !osmOn()) return;
  const h = blDrawRoute() + blDrawStops() + blVehHtml(); if (h) svg.insertAdjacentHTML('beforeend', h);
}
// 只更新車輛圖層：畫面跟上次完整重畫時一樣（沒有在平移／縮放）才可以直接換；否則交給下一次完整重畫
function blPatchVehicles() {
  const g = svg && svg.querySelector ? svg.querySelector('#blVeh') : null, d = State.drawnView, v = State.view;
  if (g && d && v && d.tx === v.tx && d.ty === v.ty && d.scale === v.scale) { const tmp = blVehHtml(); g.innerHTML = tmp.replace(/^<g id="blVeh">/, '').replace(/<\/g>$/, ''); }
  else scheduleRender();
}

// ---------- 站牌卡 ----------
const BL_STATE = { realtime: ['live', '即時'], scheduled: ['sch', '預定'], stale: ['old', '過期'], nodata: ['none', '無資料'], notDeparted: ['wait', '尚未發車'], noStop: ['warn', '交管不停靠'], ended: ['end', '末班已過'], suspended: ['end', '今日未營運'], terminal: ['none', '終點站'], error: ['warn', '即時無法取得'], status: ['warn', '狀態'] };
function blRouteRow(r, i) {
  const rt = r.rt || {}, st = BL_STATE[rt.state] || ['none', rt.state], sch = r.scheduled || {}, sel = blS.route && blS.route === r.pattern;
  let main = '';
  if (rt.state === 'realtime') main = rt.arrivals.slice(0, 2).map((a, k) => `<b class="${k ? '' : 'bl-eta'}">${blMin(a.etaS)}</b>${a.plate ? `<small>${esc(a.plate)}</small>` : ''}${a.last ? '<small class="bl-last">末班車</small>' : ''}`).join(' ');
  else if (rt.state === 'notDeparted' && rt.nextBusMs) main = `<b>${blHM(rt.nextBusMs)} 發車</b><small>（業者預告）</small>`;
  else main = `<span>${esc(rt.label || st[1])}</span>`;
  const next = (sch.next || []).filter(x => x.ms > blNow() - 60e3).slice(0, 2).map(x => blHM(x.ms) + (x.est ? '*' : '')).join('、');
  const schTxt = rt.state === 'terminal' ? '' : next ? `時刻表：${next}${sch.last ? `・末班 ${blHM(sch.last.ms)}` : ''}` : sch.source === 'frequency' && sch.freq ? `班距 ${Math.round(sch.freq.minS / 60)}～${Math.round(sch.freq.maxS / 60)} 分` : sch.last ? `今日末班 ${blHM(sch.last.ms)}（已過）` : sch.source === 'not-today' ? '時刻表：今天不行駛' : '沒有時刻表資料';
  return `<div class="bl-r${sel ? ' sel' : ''}" data-i="${i}"><span class="bl-name">${esc(r.name)}${r.subName ? `<small>${esc(r.subName)}</small>` : ''}</span>` +
    `<span class="bl-mid"><span class="bl-to">往 ${esc(r.destination || '—')}${r.source && r.source.kind !== 'City' ? `・${esc(r.source.label)}` : ''}</span><span class="bl-main">${main}</span><small class="ds-muted">${esc(schTxt)}</small></span>` +
    `<span class="bl-st ${st[0]}">${esc(st[1])}</span></div>`;
}
function blVehList() {
  const d = blS.routeData; if (!d) return '';
  const rows = d.vehicles.map(v => `<div class="bl-v${v.plate === blS.selPlate ? ' sel' : ''}${v.stale ? ' stale' : ''}" data-plate="${esc(v.plate)}"><b>${esc(v.plate)}</b>` +
    `<span>${v.next ? `下一站 ${esc(v.next.name)}${v.next.etaS != null ? `・${blMin(v.next.etaS)}` : ''}${v.next.how === 'position' ? '<small>（依位置推算）</small>' : ''}` : v.current ? `${esc(v.current.name)} ${esc(v.current.event || '')}` : '位置'}</span>` +
    `<small class="ds-muted">${v.current ? `目前：${esc(v.current.name)} ${esc(v.current.event || '')}・` : ''}${v.speedKmh != null ? `${v.speedKmh} km/h・` : ''}GPS ${blHMS(v.gpsMs)}（${v.ageS} 秒前）${v.stale ? '・<b class="bl-old">位置已過期</b>' : ''}${v.snapped ? '' : `・原始 GPS${v.offRouteM != null ? `（離路線 ${v.offRouteM} m）` : ''}`}${v.status && v.statusCode !== 0 ? `・${esc(v.status)}` : ''}${v.dutyCode === 2 ? '・勤務結束' : ''}</small></div>`).join('');
  return `<div class="bl-vs"><div class="bl-vh">${esc(d.route.name)} 往 ${esc(d.route.destination || '')}：${d.vehicles.length ? `${d.vehicles.length} 輛行駛中` : '這個方向目前沒有行駛中的公車'}${d.hiddenOld ? `（另有 ${d.hiddenOld} 輛超過 10 分鐘沒有更新，未顯示）` : ''}</div>${rows}` +
    `<small class="ds-muted">${d.note ? esc(d.note) + '。' : ''}${d.realtime === false ? esc(d.note || '') : `位置每 20 秒更新・${d.dataAt && d.dataAt.a1 ? `資料 ${blHMS(d.dataAt.a1)}` : ''}${d.errors && d.errors.length ? `・<b class="bl-old">${esc(d.errors[0])}</b>` : ''}`}</small></div>`;
}
function blCardHtml() {
  const c = blId('busCard'), k = blS.card; if (!c || !k) return;
  const d = k.data;
  c.innerHTML = `<div class="ds-ev-h"><span class="po-c-title"><b>${esc(d ? d.stop.name : k.name || '公車站牌')}</b><small>公車站牌${d ? `・${d.routes.length} 條路線（各方向、子路線分開）` : ''}</small></span><button type="button" class="ds-icon-btn" data-bl-close="1" aria-label="關閉">${icon('close', 20)}</button></div>` +
    (k.err ? `<p class="ds-muted">${esc(k.err)}</p>` : !d ? '<p class="ds-muted">載入中…</p>' : `<div class="bl-rs">${d.routes.map(blRouteRow).join('')}</div>${blVehList()}` +
      `<p class="ds-muted po-src">資料：交通部 TDX 公車動態（預估到站 N1、定時 A1、定點 A2）、時刻表（*＝由站間時間推算）・${d.realtime ? `更新 ${blHMS(d.fetchedAt)}（每 30 秒）` : '伺服器沒有 TDX 金鑰：只有時刻表'}・點路線看公車位置</p>`);
}
async function blOpenStop(uid, name) {
  const c = blId('busCard'); if (!c) return;
  if (!blS.card || blS.card.uid !== uid) { blS.card = { uid, name, data: null, err: '' }; blS.route = null; blS.routeData = null; blS.selPlate = null; }
  c.hidden = false; blCardHtml(); scheduleRender(); await blRefreshStop();
}
async function blRefreshStop() {
  const k = blS.card; if (!k || k.busy) return; k.busy = true; blS.cardAt = blNow();   // 進行中不重複送（定時器每 2 秒檢查一次）
  try { const d = await blGet('stop', { uid: k.uid }); if (blS.card !== k) return; k.data = d; k.err = ''; blS.cardAt = blNow(); }
  catch (e) { if (blS.card === k) k.err = '載入失敗：' + e.message; } finally { k.busy = false; }
  blCardHtml();
}
async function blSelectRoute(pattern) {
  if (blS.route === pattern) { blS.route = null; blS.routeData = null; blS.selPlate = null; blCardHtml(); scheduleRender(); return; }
  blS.route = pattern; blS.routeData = null; blS.selPlate = null; blCardHtml(); await blRefreshRoute(true); if (blS.route === pattern) blFit();
}
async function blRefreshRoute(full) {
  const p = blS.route; if (!p || blS.routeBusy === p) return; blS.routeBusy = p; blS.routeAt = blNow();
  try { const d = await blGet('vehicles', { pattern: p }); if (blS.route !== p) return; blS.routeData = d; blS.routeAt = blNow(); }
  catch (e) { if (blS.route === p) blS.routeData = { route: { name: '', destination: '' }, vehicles: [], stops: [], errors: [e.message], fetchedAt: blNow() }; }
  finally { if (blS.routeBusy === p) blS.routeBusy = null; }
  blCardHtml(); if (full) scheduleRender(); else blPatchVehicles();
}
// 選了路線：把路線（或車輛）放進沒有被面板遮住的區域
function blFit() {
  const d = blS.routeData; if (!d || !svg) return; const pts = (d.shape ? d.shape.coords : d.stops.map(s => [s.lon, s.lat])).concat(d.vehicles.map(v => v.pos)).filter(p => p && Number.isFinite(p[0])); if (pts.length < 2) return;
  const w = svg.clientWidth || 375, h = svg.clientHeight || 800, wide = typeof matchMedia !== 'undefined' && matchMedia('(min-width: 900px)').matches;
  // 可見區域：扣掉左側面板（寬螢幕）與站牌卡，取「卡片左邊」或「卡片上面」比較大的那塊
  const sr = svg.getBoundingClientRect ? svg.getBoundingClientRect() : { left: 0, top: 0 }, pn = blId('panel'), cd = blId('busCard');
  const pr = wide && pn && pn.getBoundingClientRect ? pn.getBoundingClientRect() : null, cr = cd && !cd.hidden && cd.getBoundingClientRect ? cd.getBoundingClientRect() : null;
  const L = (pr && pr.right > 0 ? pr.right - sr.left : 0) + 24, T = 84;
  const cands = cr ? [[L, T, cr.left - sr.left - 16, h - 40], [L, T, w - 72, cr.top - sr.top - 16]] : [[L, T, w - 72, wide ? h - 40 : h * 0.42]];
  const box = cands.filter(b => b[2] - b[0] > 80 && b[3] - b[1] > 80).sort((p, q) => (q[2] - q[0]) * (q[3] - q[1]) - (p[2] - p[0]) * (p[3] - p[1]))[0] || [24, 84, w - 24, h * 0.42];
  const sp = pts.map(p => worldToScreen(...lonLatToWorld(p[0], p[1]))), x0 = Math.min(...sp.map(p => p[0])), x1 = Math.max(...sp.map(p => p[0])), y0 = Math.min(...sp.map(p => p[1])), y1 = Math.max(...sp.map(p => p[1]));
  const k = Math.min(4, Math.max(0.02, Math.min((box[2] - box[0]) / Math.max(1, x1 - x0), (box[3] - box[1]) / Math.max(1, y1 - y0)) * 0.9)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  zoomAt(cx, cy, k); panBy((box[0] + box[2]) / 2 - cx, (box[1] + box[3]) / 2 - cy); scheduleRender();
}
function blClose() { const c = blId('busCard'); if (c) c.hidden = true; blS.card = null; blS.route = null; blS.routeData = null; blS.selPlate = null; scheduleRender(); }
// 定時更新：卡片開著才更新；分頁在背景、導航中不更新
function blTick() {
  if (typeof document !== 'undefined' && document.hidden) return; if (blNavOn()) return;
  // 地圖只做了快速平移（沒有完整重畫）時也要補抓站牌：畫面移出已抓的範圍就抓
  if (blS.on && !blS.busy && osmOn() && currentZoom() >= BL_MINZ) { const v = blViewBBox(); if (!blS.bbox || v[0] < blS.bbox[0] || v[2] > blS.bbox[2] || v[1] < blS.bbox[1] || v[3] > blS.bbox[3]) blFetchStops(); }
  if (!blS.card) return;
  const t = blNow();
  if (blS.card.data && t - blS.cardAt > 30e3) blRefreshStop();
  if (blS.route && t - blS.routeAt > 20e3) blRefreshRoute(false);
}
export function busLayerOn(v) {
  blS.on = !!v; blStore.set('busLayer', blS.on); const c = blId('blChk'); if (c) c.checked = blS.on;
  if (!blS.on) blClose(); else { blS.bbox = null; scheduleRender(); }
}
export const busLiveDebug = () => ({ on: blS.on, stops: blS.stops.length, card: blS.card && blS.card.uid, route: blS.route, vehicles: blS.routeData ? blS.routeData.vehicles.length : 0, err: blS.err });

export function init() {
  blS.on = blStore.get('busLayer', true);
  const prev = Hooks.drawExtra; Hooks.drawExtra = () => { if (prev) prev(); blDraw(); };
  const wrap = blId('canvasWrap'), lay = blId('dsLayers');
  if (!wrap || typeof document.createElement !== 'function' || typeof wrap.appendChild !== 'function' || typeof wrap.querySelector !== 'function') return;   // 測試替身：不建介面
  const card = document.createElement('div'); card.id = 'busCard'; card.className = 'ds-card bl-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', '公車站牌即時到站'); card.hidden = true; wrap.appendChild(card);
  card.addEventListener('click', e => {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest('[data-bl-close]')) { blClose(); return; }
    const r = t.closest('.bl-r'); if (r && blS.card && blS.card.data) { const x = blS.card.data.routes[+r.dataset.i]; if (x && x.rt && x.rt.state !== 'terminal') blSelectRoute(x.pattern); return; }
    const v = t.closest('.bl-v'); if (v) { blS.selPlate = v.dataset.plate; blCardHtml(); blPatchVehicles(); }
  });
  if (lay && typeof lay.querySelector === 'function' && lay.insertBefore) {
    const row = document.createElement('div'); row.className = 'tf-row';
    row.innerHTML = `<label class="ds-toggle"><input type="checkbox" id="blChk" ${blS.on ? 'checked' : ''}> 公車站牌與即時公車（放大後顯示）</label>`;
    const tfr = lay.querySelector('.tf-row');                                                  // 放在即時路況那一列後面（直接放進它的父層，不假設是 lay 的子節點）
    if (tfr && tfr.parentNode) tfr.parentNode.insertBefore(row, tfr.nextSibling); else lay.appendChild(row);
    row.querySelector('#blChk').addEventListener('change', e => busLayerOn(e.target.checked));
  }
  // 點站牌／公車（捕獲階段，避免地圖把它當成選點）
  const hit = e => {
    const t = e.target; if (!t || !t.closest) return; const s = t.closest('.bl-stop'), v = t.closest('.bl-veh'); if (!s && !v) return;
    e.stopPropagation(); if (e.cancelable && e.type !== 'touchstart') e.preventDefault();
    if (s) { const st = blS.stops.find(x => x.uid === s.getAttribute('data-uid')); blOpenStop(s.getAttribute('data-uid'), st && st.name); }
    else { blS.selPlate = v.getAttribute('data-plate'); blCardHtml(); blPatchVehicles(); }
  };
  if (svg) { svg.addEventListener('mousedown', hit, true); svg.addEventListener('touchstart', hit, { capture: true, passive: true }); }
  blS.timers.push(setInterval(blTick, 2000));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) blTick(); });
  document.addEventListener('navstate', () => { if (blNavOn()) blClose(); });
}
