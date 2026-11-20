// ui-events.js
import { State } from './state.js';
import { PREFS, VEHICLES, getMode, opsModeOn } from './vehicle.js';
import { placeholder, svg } from './dom.js';
import { esc } from './util.js';
import { findNearestNode } from './graph-core.js';
import { planAll } from './planners.js';
import { clientToWorld, drawGrid, fitGraph, panBy, render, resetView, scheduleRender, zoomAt } from './render-core.js';
import { drawRoute } from './render-route.js';
import { enrichBusSuggestion, inspectAt, renderAnalysis, renderBusBox, renderRouteList, renderSteps, renderStops, runTT, setActive, setHighlight, showStatus, toggleHighlight, updateBusSuggestion, fitToTransit } from './ui-panels.js';
import { setPoint } from './ui-search.js';
import { camInteract, stopFollow } from './nav-ui.js';
import { PanTracker, browseState, pointerToMap, rotateBy, setPitch, startInertia, stopAnimations, syncMapUi, zoomToward } from './map-view.js';
import { osmNameFor, osmOn, osmPlan, osmPoint, osmPtLL } from './osm.js';
import { tpClear, tpPlan } from './transit-plan.js';
import { worldToLonLat } from './geo.js';



// 交通方式 → 可選目標、可見控制項（道路模式：比較／替代／Pareto；大眾運輸：最快／少轉乘／少步行／Pareto）
const GOALS = {
  osm: [['compare', '最快（短程另附最短距離）']],
  road: [['compare', '比較：最短／最快／依偏好'], ['alt', '替代路線（K 條不重複）'], ['pareto', '多目標 Pareto（時間×距離×風險）']],
  transit: [['fastest', '最快抵達'], ['fewer', '少轉乘'], ['lesswalk', '少步行'], ['pareto', 'Pareto 最優方案']]
};
const HINT_OSM = '全台 OSM 道路圖（伺服器計算）：通行限制依 OSM 標籤，未標註的依道路類別推定並在結果中標示；時間＝速限（缺資料依道路類別推估）×車流係數＋路口與轉彎延遲，未含即時路況。';
const HINT = { car: '禁行自行車／步行專用道；速限取自道路表，缺資料時依道路類別推估。', heavy: '不走國道；其餘同汽車。', moto: '不走國道、快速道路；速度上限為假設值 50 km/h。', bike: '不走國道、快速道路、步行專用道；優先自行車道；速度為假設值 18 km/h。', walk: '可走步行／自行車專用道，不走國道、快速道路；速度為固定假設值 4.3 km/h。', transit: '公車＋捷運；時間為系統推估（班距與捷運速度為假設值），有 TDX 即時資料時另行標示。' };
export function syncControls() {
  const m = getMode(), tr = m === 'transit', el = id => document.getElementById(id), osm = !tr && osmOn(), kind = tr ? 'transit' : osm ? 'osm' : 'road', goal = el('goal');
  if (goal.dataset.kind !== kind) {
    goal.innerHTML = (GOALS[kind] || GOALS.road).map(([v, t]) => `<option value="${v}">${t}</option>`).join(''); goal.dataset.kind = kind; goal.value = GOALS[kind][0][0];
  }
  goal.disabled = (!tr && opsModeOn()) || osm;                        // 營運規劃有自己的多目標候選，不使用「目標」；OSM 模式固定「最快＋最短」
  el('tollRow').style.display = m === 'car' && !osm ? '' : 'none';    // 只有國道收費，且機車本來就不能走國道（OSM 模式尚未提供避開國道）
  el('roadOnly').style.display = tr || osm ? 'none' : '';
  el('transitOnly').style.display = tr ? '' : 'none';
  el('modeHint').textContent = osm ? HINT_OSM : (HINT[m] || '');
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
    if (!osmOn()) placeholder.classList.remove('hidden');            // 全台 OSM：地圖本身就是底圖，不顯示「請先載入路網」
    State.routeSet = []; State.activeKey = null; State.selStep = -1; setHighlight(null); State.busSug = null; renderBusBox();
    renderRouteList(); renderSteps();
    State.currentRoute = null; if (State.osm) State.osm.inspect = null; if (State.loaded) { resetView(); fitGraph(); } render();
    renderSteps(); renderStops(); renderAnalysis();      // 修正：清除後左面板步驟清單不再殘留
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

  for (const id of ['mode', 'opsMode']) document.getElementById(id).addEventListener('change', () => { syncControls(); });
  syncControls();
  document.getElementById('routerMode').addEventListener('change', e => { State.routerMode = e.target.value; });
  document.getElementById('go').addEventListener('click', async () => {
    if (!State.fromPoint || !State.toPoint || !(State.loaded || osmOn())) return;
    const btn = document.getElementById('go');
    btn.disabled = true; btn.textContent = '計算中...';
    showStatus('正在計算候選路線...', 'loading');
    await new Promise(r => setTimeout(r, 30));
    const t0 = performance.now();
    if (getMode() === 'transit') {                                 // 大眾運輸：不走道路候選，直接查公車＋捷運方案
      btn.disabled = false; btn.textContent = '規劃路線';
      if (osmOn()) {                                                // v1.11：全台 OSM 模式 → 伺服器的多運具 RAPTOR（台鐵、高鐵、捷運、輕軌、公車）
        State.routeSet = []; State.activeKey = null; State.currentRoute = null; State.selStep = -1; renderRouteList(); renderSteps(); renderAnalysis();
        try { const d = await tpPlan(State.fromPoint, State.toPoint, osmPtLL); placeholder.classList.add('hidden'); showStatus(d.itineraries.length ? `✅ 找到 ${d.itineraries.length} 個大眾運輸方案（伺服器 ${Math.round(performance.now() - t0)} ms）` : '⚠ 找不到大眾運輸方案', d.itineraries.length ? 'success' : 'loading'); }
        catch (err) { showStatus(`❌ ${esc(err.message)}`, 'error'); }
        return;
      }
      if (!(State.bus && State.bus.x)) { showStatus('⚠ 大眾運輸需要先載入公車（graph.json）或捷運（metro.json）資料', 'error'); return; }
      State.routeSet = []; State.activeKey = null; State.currentRoute = null; State.selStep = -1;
      renderRouteList(); renderSteps(); renderStops(); renderAnalysis();
      updateBusSuggestion(); fitToTransit(); placeholder.classList.add('hidden');
      const n = State.busOpts.filter(o => !o.error).length;
      showStatus(n ? `✅ 找到 ${n} 種大眾運輸方案（${Math.round(performance.now() - t0)} ms）` : `⚠ ${esc((State.busOpts[0] && State.busOpts[0].error) || '找不到大眾運輸方案')}`, n ? 'success' : 'loading');
      return;
    }
    if (osmOn()) {                                                  // 全台 OSM 道路圖：伺服器計算
      let res = null;
      try { res = await osmPlan(State.fromPoint, State.toPoint); }
      catch (err) { btn.disabled = false; btn.textContent = '規劃路線'; State.routeSet = []; State.activeKey = null; State.currentRoute = null; renderRouteList(); renderSteps(); renderAnalysis(); render();
        showStatus(`❌ ${esc(err.code === 'NO_ROUTE' ? '找不到路線：' + err.message : err.code === 'NO_NEARBY_ROAD' ? err.message : '伺服器規劃失敗：' + err.message)}`, 'error'); return; }
      btn.disabled = false; btn.textContent = '規劃路線';
      State.routeSet = res.items; const top = res.items[0]; State.activeKey = top.key; State.currentRoute = top.route; State.selStep = -1;
      drawRoute(State.currentRoute, true); placeholder.classList.add('hidden');
      renderRouteList(); renderSteps(); renderStops(); renderAnalysis(); State.busOpts = []; State.busSug = null; State.busRec = -1; renderBusBox();
      showStatus(`✅ 找到 ${res.items.length} 條路線（伺服器 ${Math.round(performance.now() - t0)} ms）${res.notes.length ? '<br>' + res.notes.map(esc).join('<br>') : ''}`, 'success');
      return;
    }
    State.routeSet = planAll(State.fromPoint.idx, State.toPoint.idx, document.getElementById('avoid').value.trim());
    const ms = Math.round(performance.now() - t0);
    btn.disabled = false; btn.textContent = '規劃路線';
    const ok = State.routeSet.filter(x => x.route);
    if (!ok.length) {
      State.activeKey = null; State.currentRoute = null; renderRouteList(); renderSteps(); render();
      showStatus('❌ 無法找到路線（可能不連通）', 'error'); return;
    }
    const top = ok.every(x => x.plain) ? (ok.find(x => x.key === 'fastest' || x.key === 'k0') || ok[0]) : ok.reduce((a, b) => ((b.score ? b.score.total : -1) > (a.score ? a.score.total : -1) ? b : a));   // 一般導航預設最快；營運規劃選總分最高
    State.activeKey = top.key; State.currentRoute = top.route; State.selStep = -1;
    drawRoute(State.currentRoute, true);                       // 依所有可見路線的範圍 fit
    placeholder.classList.add('hidden');
    renderRouteList(); renderSteps(); renderStops(); renderAnalysis();
    const miss = State.routeSet.filter(x => !x.route).map(x => `${x.label}：${esc(x.msg)}`);
    showStatus(`✅ 找到 ${ok.length} 條候選路線（${ms} ms）` + (miss.length ? `<br>⚠ ${miss.join('；')}` : ''), miss.length ? 'loading' : 'success');
    if (opsModeOn()) updateBusSuggestion(); else { State.busOpts = []; State.busSug = null; State.busRec = -1; renderBusBox(); scheduleRender(); }   // 一般導航不顯示公車建議
  });
  window.addEventListener('resize', () => {
    if (!State.loaded && osmOn()) { if (State.currentRoute) drawRoute(State.currentRoute, false); else render(); return; }   // 只有 OSM：保留目前的位置與縮放
    if (!State.loaded) { drawGrid(); return; }
    resetView();
    if (State.currentRoute) drawRoute(State.currentRoute, true); else { fitGraph(); render(); }
  });
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
      if (!wasClick || !(State.loaded || osmOn()) || !State.base) return;
      const [sx, sy] = pointerToMap(e.clientX, e.clientY); if (!Number.isFinite(sx)) return;
      if (document.getElementById('clickMode').value === 'inspect') { inspectAt(sx, sy); return; }
      const altEl = e.target && e.target.closest ? e.target.closest('.alt-route') : null;
      if (altEl) { setActive(altEl.getAttribute('data-key')); return; }          // 點其他候選路線 → 切換並顯示其分析
      const segEl = e.target && e.target.closest ? e.target.closest('.route-seg') : null;
      if (segEl) { toggleHighlight(segEl.getAttribute('data-road')); return; }
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
      if (osmOn()) {                                              // 全台 OSM：點哪裡就用哪裡（伺服器規劃時會吸附到最近的可用道路）
        const [lon, lat] = worldToLonLat(x, y), which = !State.fromPoint ? 'from' : 'to', p = osmPoint(lon, lat, '地圖選點');
        setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo'); scheduleRender(); return;
      }
      const idx = findNearestNode(x, y);
      if (idx < 0) { showStatus('⚠ 點擊處附近找不到路網節點', 'error'); return; }
      const p = { idx, lon: State.nodeXY[idx*5+2], lat: State.nodeXY[idx*5+3], id: State.nodeIds[idx] };
      setPoint(p, !State.fromPoint ? 'from' : !State.toPoint ? 'to' : 'to');   // from 空→from；to 空→to；都滿→覆蓋 to
      scheduleRender();
    }
  }
  {
    const tip = document.getElementById('tip');
    svg.addEventListener('mousemove', e => {
      const seg = e.target && e.target.closest ? e.target.closest('.route-seg, .ub, .sg') : null;
      if (!seg || svg.classList.contains('dragging')) { tip.style.display = 'none'; return; }
      const r = svg.getBoundingClientRect();
      tip.textContent = seg.getAttribute('data-tip') ? seg.getAttribute('data-tip') : seg.getAttribute('class') === 'ub' ? `${seg.getAttribute('data-name')} · 容量 ${seg.getAttribute('data-cap')}`
        : `${seg.getAttribute('data-road') || '（無路名）'} · 本段 ${(+seg.getAttribute('data-len')).toLocaleString()} 公尺${seg.getAttribute('data-spd') ? ' · ' + seg.getAttribute('data-spd') : ''}`;
      tip.style.left = (e.clientX - r.left + 12) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px';
      tip.style.display = 'block';
    });
    svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
  document.getElementById('nearbyBtn').addEventListener('click', e => {
    State.showNearby = !State.showNearby;
    e.currentTarget.textContent = State.showNearby ? '隱藏周邊道路' : '顯示周邊道路';
    if (State.showNearby && !State.currentRoute) showStatus('請先規劃路線，周邊道路會畫在路線四周', 'loading');
    scheduleRender();
  });
  document.getElementById('busBox').addEventListener('click', e => {
    const row = e.target.closest && e.target.closest('.busopt'); if (!row) return;
    const i = +row.dataset.i; if (i === State.busSel || !State.busOpts[i]) return;
    State.busSel = i; State.busSug = State.busOpts[i]; renderBusBox(); scheduleRender();
    if (!State.busSug.live || State.busSug.live.state !== 'done') enrichBusSuggestion(false);              // 只替「被選中的方案」查 TDX，節省 API 請求
  });
  document.getElementById('busBox').addEventListener('change', e => {
    if (e.target.id === 'busChk') { State.busVisible = e.target.checked; renderBusBox(); scheduleRender(); }
    if (e.target.id === 'parOnly') { State.paretoOnly = e.target.checked; renderBusBox(); }
    if (e.target.id === 'ubikeLink') { State.ubikeLink = e.target.checked; updateBusSuggestion(); }
  });
  for (const id of ['stopGap', 'showStops']) document.getElementById(id).addEventListener('change', () => { renderStops(); scheduleRender(); });
  document.getElementById('showWidth').addEventListener('change', scheduleRender);
  document.getElementById('clickMode').addEventListener('change', () => { if (document.getElementById('clickMode').value === 'pick') { State.inspectEdge = null; document.getElementById('roadInfo').innerHTML = ''; scheduleRender(); } });
  document.getElementById('tdxRefresh').addEventListener('click', () => enrichBusSuggestion(true));
  document.getElementById('depTime').addEventListener('change', () => enrichBusSuggestion(false));
  document.getElementById('ttGo').addEventListener('click', () => runTT(false));
  document.getElementById('pref').addEventListener('change', e => {            // 選預設偏好 → 填入 α β δ；也可以手動改（自訂）
    const p = PREFS[e.target.value]; if (!p) return;
    document.getElementById('prefA').value = p.a; document.getElementById('prefB').value = p.b; document.getElementById('prefD').value = p.d;
  });
}
