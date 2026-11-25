// ui-search.js — 搜尋框：路名（伺服器 OSM）、店家地點（poi.js）、經緯度輸入（v1.18：舊路網的路名、節點代碼搜尋已移除）
import { Hooks, State } from './state.js';
import { showStatus } from './ui-panels.js';
import { osmHwLabel, osmNameFor, osmOn, osmPoint, osmSearch } from './osm.js';
import { esc } from './util.js';

// 經緯度輸入：「緯度,經度」或「經度,緯度」（台灣本島、澎湖、金門、馬祖、蘭嶼的範圍），逗號、分號、空白都可以
export function parseCoordInput(v) {
  const m = String(v || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;，\s]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (a >= 20.5 && a <= 26.5 && b >= 116 && b <= 122.5) return { lat: a, lon: b, ll: true };
  if (b >= 20.5 && b <= 26.5 && a >= 116 && a <= 122.5) return { lat: b, lon: a, ll: true };
  return null;
}

export function setupSearch(inputId, resultId) {
  const input = document.getElementById(inputId);
  const result = document.getElementById(resultId);
  input.addEventListener('input', () => {
    clearTimeout(State.searchTimer);
    const q = input.value.trim();
    result.innerHTML = '';
    const c = parseCoordInput(q);                                  // 先判斷座標
    if (c) {
      const div = document.createElement('div');
      div.style.color = '#2563eb'; div.style.cursor = 'pointer';
      div.textContent = `📍 座標 (${c.lat}, ${c.lon})　按 Enter 定位`;
      div.onclick = () => { input.value = `${c.lat}, ${c.lon}`; result.innerHTML = ''; locateCoordinate(c, whichOf(inputId)); };
      result.appendChild(div);
      return;
    }
    if (q.length < 1 || !osmOn()) return;                          // 中文 1 字也能搜；伺服器還沒好就先不搜
    State.searchTimer = setTimeout(async () => {
      const my = (State.searchSeq = (State.searchSeq || 0) + 1);
      // 店家地點（poi.js）與道路同時查；地點放上面、道路放下面
      const pp = Hooks.poiSearch ? Hooks.poiSearch(q).catch(() => null) : Promise.resolve(null);
      let hits; try { hits = await osmSearch(q); } catch (e) { hits = null; if (!Hooks.poiSearch && my === State.searchSeq) { result.innerHTML = `<div style="color:#dc2626">⚠ 搜尋失敗：${esc(e.message)}</div>`; return; } }
      const pd = await pp;
      if (my !== State.searchSeq || input.value.trim() !== q) return;
      result.innerHTML = '';
      const gotPoi = Hooks.poiSuggest ? Hooks.poiSuggest(result, pd, whichOf(inputId), q) : false;
      if (!hits) { if (!gotPoi) result.innerHTML = `<div style="color:#dc2626">⚠ 搜尋失敗</div>`; return; }
      if (gotPoi && hits.length) { const h = document.createElement('div'); h.className = 'po-sec'; h.textContent = '道路'; result.appendChild(h); }
      if (!hits.length && !gotPoi) result.innerHTML = `<div style="color:#94a3b8">沒有符合「${esc(q)}」的地點或路名</div>`;
      for (const h of gotPoi ? hits.slice(0, 5) : hits) {
        const div = document.createElement('div');
        div.innerHTML = `${esc(h.name)} <small style="color:#64748b">${esc(osmHwLabel(h.highway))}${h.km || h.km === 0 ? `・${h.km} km` : ''}</small>`;
        div.onclick = () => { input.value = h.name; result.innerHTML = ''; const which = whichOf(inputId), p = osmPoint(h.lon, h.lat, h.name); setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo'); };
        result.appendChild(div);
      }
    }, 250);
  });
  // Enter 也觸發座標定位
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const c = parseCoordInput(input.value.trim());
    if (c) { e.preventDefault(); result.innerHTML = ''; locateCoordinate(c, whichOf(inputId)); }
  });
}

export function whichOf(inputId) { return inputId === 'from' ? 'from' : 'to'; }

// 經緯度 → 起點或終點（規劃時伺服器會吸附到最近的可用道路）
export function locateCoordinate(c, which) {
  const p = osmPoint(c.lon, c.lat, `座標 ${c.lat}, ${c.lon}`); setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo');
  showStatus(`📍 已設定${which === 'from' ? '起點' : '終點'}：${c.lat}, ${c.lon}`, 'success');
}

export function setPoint(p, which) {
  if (which === 'to' && State.viaPending && Hooks.addVia) { Hooks.addVia(p); return; }     // v1.14：「新增途經點」之後選到的點
  const lon = p.ll ? p.ll[0] : p.lon, lat = p.ll ? p.ll[1] : p.lat;
  if (which === 'from') { State.fromPoint = p; document.getElementById('fromInfo').textContent = `${p.id} (${lon.toFixed(5)}, ${lat.toFixed(5)})`; }
  else { State.toPoint = p; document.getElementById('toInfo').textContent = `${p.id} (${lon.toFixed(5)}, ${lat.toFixed(5)})`; }
  document.getElementById('go').disabled = !(State.fromPoint && State.toPoint);
}

// 載入時要執行的綁定，由 main.js 依序呼叫
export function init() {
  setupSearch('from', 'fromResult');
  setupSearch('to', 'toResult');
  document.getElementById('from').addEventListener('focus', () => State.mode = 'from');
  document.getElementById('to'  ).addEventListener('focus', () => State.mode = 'to'  );
}
