// ui-events.js
import { State } from './state.js';
import { getMode } from './vehicle.js';
import { placeholder, svg } from './dom.js';
import { esc } from './util.js';
import { clientToWorld, drawGrid, panBy, render, resetView, scheduleRender } from './render-core.js';
import { drawRoute } from './render-route.js';
import { inspectAt, renderAnalysis, renderRouteList, renderSteps, setActive, showStatus } from './ui-panels.js';
import { setPoint } from './ui-search.js';
import { camInteract, stopFollow } from './nav-ui.js';
import { PanTracker, browseState, pointerToMap, rotateBy, setPitch, startInertia, stopAnimations, syncMapUi, zoomToward } from './map-view.js';
import { osmFitTaiwan, osmNameFor, osmOn, osmPlan, osmPoint, osmPtLL } from './osm.js';
import { tpClear, tpPlan } from './transit-plan.js';
import { worldToLonLat } from './geo.js';



// 交通方式 → 提示文字、大眾運輸專用選項（v1.18：只有全台 OSM；舊路網的目標、偏好、收費、營運規劃選項已移除）
const HINT_OSM = '全台 OSM 道路圖（伺服器計算）：通行限制依 OSM 標籤，未標註的依道路類別推定並在結果中標示；時間＝速限（缺資料依道路類別推估）×車流係數＋路口與轉彎延遲，有 TDX 即時路況時依即時速度修正。';
const HINT_TRANSIT = '大眾運輸：台鐵、高鐵、捷運、輕軌、全台公車、公路客運、台灣好行（伺服器 RAPTOR，TDX 時刻表）。';
export function syncControls() {
  const tr = getMode() === 'transit', el = id => document.getElementById(id);
  if (el('transitOnly')) el('transitOnly').style.display = tr ? '' : 'none';
  if (el('modeHint')) el('modeHint').textContent = tr ? HINT_TRANSIT : HINT_OSM;
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  // ============================================================
  // 清除
  // ============================================================

  document.getElementById('clear').addEventListener('click', () => {
    State.fromPoint = null; State.toPoint = null;
    document.getElementById('fromInfo').textContent = '未設定';
    document.getElementById('toInfo').textContent = '未設定';
    document.getElementById('from').value = '';
    document.getElementById('to').value = '';
    document.getElementById('go').disabled = true;
    document.getElementById('status').style.display = 'none';
    State.routeSet = []; State.activeKey = null; State.selStep = -1;
    renderRouteList(); renderSteps();
    State.currentRoute = null; if (State.osm) State.osm.inspect = null; render();
    renderSteps(); renderAnalysis();      // 修正：清除後左面板步驟清單不再殘留
  });
  document.getElementById('routes').addEventListener('change', e => {
    const it = State.routeSet.find(x => x.key === e.target.dataset.k); if (!it) return;
    it.visible = e.target.checked;
    if (!it.visible && it.key === State.activeKey) {
      const nx = State.routeSet.find(x => x.route && x.visible);
      if (nx) { setActive(nx.key); return; }
      State.activeKey = null; State.currentRoute = null; renderSteps();
    } else if (it.visible && !State.currentRoute) { setActive(it.key); return; }
    renderRouteList(); scheduleRender();
  });
  document.getElementById('routes').addEventListener('click', e => {
    if (e.target.tagName === 'INPUT') return;
    const row = e.target.closest('.rt'); if (row && row.dataset.k) setActive(row.dataset.k);
  });
  document.getElementById('steps').addEventListener('click', e => {
    const row = e.target.closest('.step'); if (!row || !State.currentRoute) return;
    State.selStep = State.currentRoute._man[+row.dataset.i].index;
    for (const c of document.getElementById('steps').children) c.classList && c.classList.toggle('sel', c === row);
    scheduleRender();
  });
  // ============================================================
  // 規劃
  // ============================================================

  document.getElementById('mode').addEventListener('change', () => { syncControls(); });
  syncControls();
  document.getElementById('go').addEventListener('click', async () => {
    if (!State.fromPoint || !State.toPoint) return;
    if (!osmOn()) { showStatus('伺服器的全台道路圖尚未就緒，請稍候再試', 'loading'); return; }
    const btn = document.getElementById('go');
    btn.disabled = true; btn.textContent = '計算中...';
    showStatus('正在計算候選路線...', 'loading');
    await new Promise(r => setTimeout(r, 30));
    const t0 = performance.now();
    if (getMode() === 'transit') {                                 // 大眾運輸：不走道路候選，直接查公車＋捷運方案
      btn.disabled = false; btn.textContent = '規劃路線';
      State.routeSet = []; State.activeKey = null; State.currentRoute = null; State.selStep = -1; renderRouteList(); renderSteps(); renderAnalysis();
      try { const d = await tpPlan(State.fromPoint, State.toPoint, osmPtLL); placeholder.classList.add('hidden'); showStatus(d.itineraries.length ? `✅ 找到 ${d.itineraries.length} 個大眾運輸方案（伺服器 ${Math.round(performance.now() - t0)} ms）` : '⚠ 找不到大眾運輸方案', d.itineraries.length ? 'success' : 'loading'); }
      catch (err) { showStatus(`❌ ${esc(err.message)}`, 'error'); }
      return;
    }
    {                                                               // 全台 OSM 道路圖：伺服器計算
      let res = null;
      try { res = await osmPlan(State.fromPoint, State.toPoint); }
      catch (err) { btn.disabled = false; btn.textContent = '規劃路線'; State.routeSet = []; State.activeKey = null; State.currentRoute = null; renderRouteList(); renderSteps(); renderAnalysis(); render();
        showStatus(`❌ ${esc(err.code === 'NO_ROUTE' ? '找不到路線：' + err.message : err.code === 'NO_NEARBY_ROAD' ? err.message : '伺服器規劃失敗：' + err.message)}`, 'error'); return; }
      btn.disabled = false; btn.textContent = '規劃路線';
      State.routeSet = res.items; const top = res.items[0]; State.activeKey = top.key; State.currentRoute = top.route; State.selStep = -1;
      drawRoute(State.currentRoute, true); placeholder.classList.add('hidden');
      renderRouteList(); renderSteps(); renderAnalysis();
      showStatus(`✅ 找到 ${res.items.length} 條路線（伺服器 ${Math.round(performance.now() - t0)} ms）${res.notes.length ? '<br>' + res.notes.map(esc).join('<br>') : ''}`, 'success');
      return;
    }
  });
  window.addEventListener('resize', () => { if (!State.base) { if (osmOn() && osmFitTaiwan()) render(); else drawGrid(); return; } if (State.currentRoute) drawRoute(State.currentRoute, false); else render(); });   // 保留目前的位置與縮放
  // ============================================================
  // 平移 / 縮放 / 點擊選點（只綁 svg）
  // ============================================================

  {
    // v1.11：座標一律經 pointerToMap（3D 傾斜時反投影回地圖平面）；放開時有慣性；滾輪平滑縮放、上下限依每像素公尺數（map-view.js）
    // 右鍵拖曳（或 Ctrl＋左鍵拖曳）：左右＝旋轉、上下＝俯仰（只在非導航時）
    let down = null, moved = false, clickTimer = null; const track = new PanTracker();
    svg.addEventListener('contextmenu', e => { if (State.base) e.preventDefault(); });
    svg.addEventListener('mousedown', e => {
      if (e.button !== 0 && e.button !== 2) return;
      stopAnimations(); track.reset();
      const [fx, fy] = pointerToMap(e.clientX, e.clientY), orbit = (e.button === 2 || e.ctrlKey) && !(State.nav && State.nav.engine);
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, fx, fy, orbit };
      moved = false; if (!orbit) camInteract(); track.add(e.clientX, e.clientY);
    });
    svg.addEventListener('mousemove', e => {
      if (!down) return;
      if (!moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 3) return;   // <3px 視為 click
      if (!moved) { moved = true; svg.classList.add('dragging'); }
      if (down.orbit) { const b = browseState(); rotateBy((e.clientX - down.lx) * 0.4); if (Math.abs(e.clientY - down.ly) > 0) setPitch(b.pitch - (e.clientY - down.ly) * 0.3); down.lx = e.clientX; down.ly = e.clientY; return; }
      const [fx, fy] = pointerToMap(e.clientX, e.clientY);
      if (Number.isFinite(fx) && Number.isFinite(down.fx)) panBy(fx - down.fx, fy - down.fy);
      stopFollow(); down.fx = fx; down.fy = fy; down.lx = e.clientX; down.ly = e.clientY; track.add(fx, fy);
      scheduleRender({ viewOnly: true });
    });
    svg.addEventListener('mouseup', e => {
      const wasClick = down && !moved && !down.orbit;
      if (down && moved && !down.orbit) { const [vx, vy] = track.velocity(); if (!startInertia(vx, vy, syncMapUi)) scheduleRender(); }   // 拖曳結束：慣性滑動，停下來後完整重畫一次
      else if (down && moved) scheduleRender();
      down = null; svg.classList.remove('dragging');
      if (!wasClick || !osmOn() || !State.base) return;
      const [sx, sy] = pointerToMap(e.clientX, e.clientY); if (!Number.isFinite(sx)) return;
      if (document.getElementById('clickMode').value === 'inspect') { inspectAt(sx, sy); return; }
      const altEl = e.target && e.target.closest ? e.target.closest('.alt-route') : null;
      if (altEl) { setActive(altEl.getAttribute('data-key')); return; }          // 點其他候選路線 → 切換並顯示其分析
      const segEl = e.target && e.target.closest ? e.target.closest('.route-seg') : null;
      clearTimeout(clickTimer);
      clickTimer = setTimeout(() => pickOnMap(sx, sy), 250);   // 等一下，若是雙擊就取消
    });
    svg.addEventListener('mouseleave', () => { if (down && moved) scheduleRender(); down = null; svg.classList.remove('dragging'); });
    svg.addEventListener('wheel', e => {
      if (!State.base) return;
      e.preventDefault(); camInteract(); stopFollow();
      const [mx, my] = pointerToMap(e.clientX, e.clientY); if (!Number.isFinite(mx)) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;   // 行／頁 → 像素
      zoomToward(Math.max(-2, Math.min(2, -dy * 0.0022)), mx, my);              // 以游標為中心平滑縮放（導航旋轉、3D 傾斜中也正確）
    }, { passive: false });
    // 雙擊放大一級（Shift＋雙擊縮小）；回到全圖改用「⤢」按鈕
    svg.addEventListener('dblclick', e => { clearTimeout(clickTimer); if (!State.base) return; const [mx, my] = e && e.clientX != null ? pointerToMap(e.clientX, e.clientY) : [svg.clientWidth / 2, svg.clientHeight / 2]; if (Number.isFinite(mx)) zoomToward(e && e.shiftKey ? -1 : 1, mx, my); });
    const fit = document.getElementById('mapFit'); if (fit) fit.addEventListener('click', () => { stopAnimations(); resetView(); scheduleRender(); syncMapUi(); });

    function pickOnMap(sx, sy) {
      const [x, y] = clientToWorld(sx, sy);
      // 點哪裡就用哪裡（伺服器規劃時會吸附到最近的可用道路）；起點空→起點，否則→終點
      const [lon, lat] = worldToLonLat(x, y), which = !State.fromPoint ? 'from' : 'to', p = osmPoint(lon, lat, '地圖選點');
      setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo'); scheduleRender();
    }
  }
  {
    const tip = document.getElementById('tip');
    svg.addEventListener('mousemove', e => {
      const seg = e.target && e.target.closest ? e.target.closest('.route-seg') : null;
      if (!seg || svg.classList.contains('dragging')) { tip.style.display = 'none'; return; }
      const r = svg.getBoundingClientRect();
      tip.textContent = `${seg.getAttribute('data-road') || '（無路名）'} · 本段 ${(+seg.getAttribute('data-len')).toLocaleString()} 公尺${seg.getAttribute('data-spd') ? ' · ' + seg.getAttribute('data-spd') : ''}`;
      tip.style.left = (e.clientX - r.left + 12) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px';
      tip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  document.getElementById('clickMode').addEventListener('change', () => { if (document.getElementById('clickMode').value === 'pick') { if (State.osm) State.osm.inspect = null; document.getElementById('roadInfo').innerHTML = ''; scheduleRender(); } });

}
