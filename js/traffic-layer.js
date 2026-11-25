// traffic-layer.js — 即時路況圖層（v1.15）：TDX 路況資訊 v2 的路段狀態畫在地圖上（順暢綠、車多黃、壅塞紅、封閉深灰），
// 路線上的車多／壅塞路段疊色，圖層選單的開關與圖例。資料：/api/v1/traffic/flow?bbox=…（伺服器每 5 分鐘向 TDX 更新）
// 打包會合併模組：頂層名稱一律加 tf 前綴；不用 import 別名。
import { State, Hooks } from './state.js';
import { svg } from './dom.js';
import { lonLatToWorld, worldToLonLat } from './geo.js';
import { scheduleRender, screenToWorld, worldToScreen } from './render-core.js';
import { osmOn } from './osm.js';

const TF_COLOR = { 1: '#1E8E3E', 2: '#F9AB00', 3: '#D93025', '-1': '#3C4043' };
const tfS = { on: true, list: [], bbox: null, at: 0, busy: false, info: null, t: null, err: '' };
const tfStore = { get(k, d) { try { const v = localStorage.getItem('ui.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('ui.' + k, JSON.stringify(v)); } catch {} } };

function tfViewBBox() {
  const w = svg.clientWidth || 800, h = svg.clientHeight || 600, c = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => worldToLonLat(...screenToWorld(x, y)));
  const lo = c.map(p => p[0]), la = c.map(p => p[1]); return [Math.min(...lo), Math.min(...la), Math.max(...lo), Math.max(...la)];
}
async function tfFetch() {
  if (tfS.busy || !osmOn()) return; const v = tfViewBBox(); if (v.some(x => !Number.isFinite(x))) return;
  const pw = (v[2] - v[0]) * 0.25, ph = (v[3] - v[1]) * 0.25, bb = [v[0] - pw, v[1] - ph, v[2] + pw, v[3] + ph];   // 多抓一圈，平移時不必馬上重抓
  tfS.busy = true;
  try {
    const r = await fetch('api/v1/traffic/flow?bbox=' + bb.map(x => x.toFixed(4)).join(',')), j = await r.json();
    if (j && j.ok) { tfS.list = j.data.sections || []; tfS.info = { available: j.data.available, fetchedAt: j.data.fetchedAt, note: j.data.note || '' }; tfS.bbox = bb; tfS.err = ''; tfLegend(); }
    else { tfS.err = (j && j.error && j.error.message) || ('HTTP ' + r.status); }
  } catch (e) { tfS.err = e.message; } finally { tfS.at = Date.now(); tfS.busy = false; scheduleRender(); }
}
// 往行進方向右側平移（台灣靠右行駛：雙向道路兩個方向的狀態分開看得到）
function tfOffset(pts, d) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    out.push([pts[i][0] - dy / L * d, pts[i][1] + dx / L * d]);
  }
  return out;
}
const tfPath = pts => 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
function tfDraw() {
  if (!svg || !osmOn()) return;
  if (tfS.on) {
    // 重抓：超過 2.5 分鐘、畫面移出已抓的範圍、或放大很多（縮小時伺服器只回國道與快速道路，放大後要補市區道路）
    const v = tfViewBBox(), stale = Date.now() - tfS.at > 150e3, out = !tfS.bbox || v[0] < tfS.bbox[0] || v[2] > tfS.bbox[2] || v[1] < tfS.bbox[1] || v[3] > tfS.bbox[3], zoomedIn = tfS.bbox && (v[2] - v[0]) < (tfS.bbox[2] - tfS.bbox[0]) / 4;
    if ((stale || out || zoomedIn) && !tfS.busy) { clearTimeout(tfS.t); tfS.t = setTimeout(tfFetch, 450); }
  }
  const z = State.view && State.view.scale ? 1 : 1, wide = tfS.bbox && tfS.bbox[2] - tfS.bbox[0] > 0.5, w = wide ? 2.4 : 3.6;
  let h = '';
  if (tfS.on && tfS.list.length) {
    const by = { 1: [], 2: [], 3: [], '-1': [] };
    for (const s of tfS.list) for (const line of s.g) { const pts = line.map(([lo, la]) => worldToScreen(...lonLatToWorld(lo, la))); if (pts.length < 2) continue; (by[s.lv] || by[1]).push(tfPath(tfOffset(pts, w * 0.9))); }
    for (const lv of [1, 2, 3, -1]) if (by[lv].length) h += `<path d="${by[lv].join('')}" fill="none" stroke="${TF_COLOR[lv]}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${lv === 1 ? ' opacity=".8"' : ''}${lv === -1 ? ' stroke-dasharray="6 4"' : ''}/>`;
  }
  if (h) { const g = `<g id="tfFlow" pointer-events="none">${h}</g>`, base = svg.querySelector && svg.querySelector('#osmBase'); if (base && base.insertAdjacentHTML) base.insertAdjacentHTML('afterend', g); else svg.insertAdjacentHTML('beforeend', g); }
  // 目前路線經過的車多／壅塞路段：疊在路線上
  const r = State.currentRoute, f = r && r._osm && r._osm.flow, ll = r && r._ll;
  if (f && f.runs && f.runs.length && ll) {
    let p = '';
    for (const [i0, i1, lv] of f.runs) { if (lv === 1) continue; const pts = []; for (let i = i0; i <= i1 && i < ll.length; i++) pts.push(worldToScreen(...lonLatToWorld(ll[i][0], ll[i][1]))); if (pts.length >= 2) p += `<path d="${tfPath(pts)}" fill="none" stroke="${TF_COLOR[lv]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"${lv === -1 ? ' stroke-dasharray="6 4"' : ''}/>`; }
    if (p) svg.insertAdjacentHTML('beforeend', `<g id="tfRoute" pointer-events="none">${p}</g>`);
  }
  void z;
}
function tfLegend() {
  const box = document.getElementById('tfLegend'); if (!box) return; const i = tfS.info;
  const t = i && i.fetchedAt ? new Date(i.fetchedAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  box.innerHTML = `<span class="tf-key"><i style="background:${TF_COLOR[1]}"></i>順暢</span><span class="tf-key"><i style="background:${TF_COLOR[2]}"></i>車多</span><span class="tf-key"><i style="background:${TF_COLOR[3]}"></i>壅塞</span><span class="tf-key"><i style="background:${TF_COLOR[-1]}"></i>封閉</span>` +
    `<small class="ds-muted">${i && i.available ? `TDX 即時路況・${t} 更新・國道、省道與 11 個縣市（其他縣市未提供）` : (i && i.note) || tfS.err || '載入中…'}</small>`;
}
export function trafficOn(v) {
  tfS.on = !!v; tfStore.set('flow', tfS.on); const c = document.getElementById('tfChk'); if (c) c.checked = tfS.on; const b = document.getElementById('tfBtn'); if (b && b.setAttribute) b.setAttribute('aria-pressed', String(tfS.on));
  if (tfS.on) { tfS.at = 0; tfFetch(); } scheduleRender();
}
export function init() {
  tfS.on = tfStore.get('flow', true);
  const prev = Hooks.drawExtra; Hooks.drawExtra = () => { if (prev) prev(); tfDraw(); };
  const lay = document.getElementById('dsLayers'); if (!lay || typeof document.createElement !== 'function' || typeof lay.querySelectorAll !== 'function' || !lay.insertBefore) return;   // 沒有 UI v2 外殼（測試替身）
  // 圖層選單：開關＋圖例（取代舊的「即時壅塞目前沒有資料來源」）
  for (const p of lay.querySelectorAll('p.ds-muted')) if (/即時壅塞/.test(p.textContent)) p.remove();
  const row = document.createElement('div'); row.className = 'tf-row';
  row.innerHTML = `<label class="ds-toggle"><input type="checkbox" id="tfChk" ${tfS.on ? 'checked' : ''}> 即時路況（TDX）</label><div id="tfLegend" class="tf-legend"></div>`;
  const first = lay.querySelector('.ds-toggle'); lay.insertBefore(row, first || null);
  row.querySelector('#tfChk').addEventListener('change', e => trafficOn(e.target.checked));
  tfLegend();
}
export const trafficDebug = () => ({ on: tfS.on, sections: tfS.list.length, info: tfS.info, err: tfS.err });
