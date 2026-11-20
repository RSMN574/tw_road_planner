// ui-search.js
import { State } from './state.js';
import { findNearestNode, parseCoordInput } from './graph-core.js';
import { lonLatToWorld } from './geo.js';
import { showStatus } from './ui-panels.js';
import { osmHwLabel, osmNameFor, osmOn, osmPoint, osmSearch } from './osm.js';
import { esc } from './util.js';

export function setupSearch(inputId, resultId, onPick) {
  const input = document.getElementById(inputId);
  const result = document.getElementById(resultId);

   input.addEventListener('input', () => {
    clearTimeout(State.searchTimer);
    const q = input.value.trim();
    result.innerHTML = '';
    // 0) 直接命中节点 ID（如 "xy:21103490,267921562"）
    const directIdx = State.nodeIdToIdx ? State.nodeIdToIdx.get(q) : undefined;
    if (directIdx !== undefined) {
      const div = document.createElement('div');
      div.style.color = '#2563eb';
      div.textContent = `🎯 节点 ${q}　点击定位`;
      div.style.cursor = 'pointer';
      div.onclick = () => {
        result.innerHTML = '';
        const lon = State.nodeXY[directIdx*5+2], lat = State.nodeXY[directIdx*5+3];
        setPoint({ idx: directIdx, lon, lat, id: q }, whichOf(inputId));
        showStatus(`🎯 已定位 ${whichOf(inputId)==='from'?'起点':'终点'}：${q}`, 'success');
      };
      result.appendChild(div);
      return;
    }
    // 先判斷座標
    const c = parseCoordInput(q);
    if (c) {
      const div = document.createElement('div');
      div.style.color = '#2563eb';
      div.textContent = `📍 座標 (${c.lat}, ${c.lon})　按 Enter 定位`;
      div.style.cursor = 'pointer';
      div.onclick = () => {
        input.value = `${c.lat}, ${c.lon}`;
        result.innerHTML = '';
        locateCoordinate(c, onPick === undefined ? null : whichOf(inputId));
      };
      result.appendChild(div);
      return;
    }
    if (q.length < 1) return;                       // ← 中文 1 字也能搜

    if (osmOn()) {                                   // 全台 OSM：問伺服器（同名道路依離地圖中心的距離排序）
      State.searchTimer = setTimeout(async () => {
        const my = (State.searchSeq = (State.searchSeq || 0) + 1);
        let hits; try { hits = await osmSearch(q); } catch (e) { if (my === State.searchSeq) result.innerHTML = `<div style="color:#dc2626">⚠ 搜尋失敗：${esc(e.message)}</div>`; return; }
        if (my !== State.searchSeq || input.value.trim() !== q) return;
        result.innerHTML = hits.length ? '' : `<div style="color:#94a3b8">全台 OSM 道路沒有符合「${esc(q)}」的路名</div>`;
        for (const h of hits) {
          const div = document.createElement('div');
          div.innerHTML = `${esc(h.name)} <small style="color:#64748b">${esc(osmHwLabel(h.highway))}${h.km || h.km === 0 ? `・${h.km} km` : ''}</small>`;
          div.onclick = () => { input.value = h.name; result.innerHTML = ''; const which = whichOf(inputId), p = osmPoint(h.lon, h.lat, h.name); setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo'); };
          result.appendChild(div);
        }
      }, 250);
      return;
    }

    if (State.roadNames.length === 0) {
      const div = document.createElement('div');
      div.style.color = '#dc2626';
      div.textContent = '⚠ 未載入道路名稱（請確認 roads.json，或 nodes.json 是否含 road/street/name）';
      result.appendChild(div);
      return;
    }

    State.searchTimer = setTimeout(() => {
      const ql = q.toLowerCase();
      const hits = State.roadNames
        .filter(n => n.toLowerCase().includes(ql))
        .slice(0, 30);

      if (hits.length === 0) {
        const div = document.createElement('div');
        div.style.color = '#94a3b8';
        div.textContent = `無符合「${q}」的道路`;
        result.appendChild(div);
        return;
      }

      for (const name of hits) {
        const div = document.createElement('div');
        div.textContent = name;
        div.onclick = () => {
          input.value = name;
          result.innerHTML = '';
          onPick(name);
        };
        result.appendChild(div);
      }
    }, 150);
  });
    // Enter / blur 也觸發座標定位
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const c = parseCoordInput(input.value.trim());
    if (c) { e.preventDefault(); result.innerHTML = ''; locateCoordinate(c, whichOf(inputId)); }
  });
}

export function whichOf(inputId) { return inputId === 'from' ? 'from' : 'to'; }

export function locateCoordinate(c, which) {
  if (osmOn() && c.ll) {                                                       // 全台 OSM：直接用這個經緯度（規劃時伺服器會吸附到最近的可用道路）
    const p = osmPoint(c.lon, c.lat, `座標 ${c.lat}, ${c.lon}`); setPoint(p, which); osmNameFor(p, which === 'from' ? 'fromInfo' : 'toInfo');
    showStatus(`📍 已設定${which === 'from' ? '起點' : '終點'}：${c.lat}, ${c.lon}`, 'success'); return;
  }
  const [wx, wy] = c.ll ? lonLatToWorld(c.lon, c.lat) : [c.lon, c.lat];      // 經緯度 → 路網座標（TWD97 路網要先轉換）
  const idx = findNearestNode(wx, wy);
  if (idx < 0) { showStatus('⚠ 坐标附近找不到路网节点', 'error'); return; }
  const lon = State.nodeXY[idx*5+2], lat = State.nodeXY[idx*5+3];
  setPoint({ idx, lon, lat, id: State.nodeIds[idx] + '（最近节点）' }, which);
  showStatus(
    `📍 已定位 ${which === 'from' ? '起点' : '终点'}<br>` +
    `最近节点：${State.nodeIds[idx]}<br>` +
    `实际坐标：${lon}, ${lat}`, 'success'
  );
}

export function pickRoad(name, which) {
  if (!State.loaded) return;
  let candidates = State.roadNameToNodes.get(name) || [];

  // 若沒對應節點 → 退回掃 nodeIds（限量，避免 140 萬節點卡死）
  if (candidates.length === 0) {
    for (let i = 0; i < State.N && candidates.length < 500; i++) {
      if (State.nodeIds[i] && State.nodeIds[i].includes(name)) candidates.push(i);
    }
  }

  if (candidates.length === 0) {
    showStatus(`⚠ 道路「${name}」沒有對應節點<br>請檢查 roads.json 是否包含 nodes 對應，或 nodes.json 是否有 road 欄位`, 'error');
    return;
  }

  const idx = candidates[0];
  setPoint({
    idx,
    lon: State.nodeXY[idx * 5 + 2],
    lat: State.nodeXY[idx * 5 + 3],
    id: State.nodeIds[idx]
  }, which);
}

export function setPoint(p, which) {
  if (which === 'from') {
    State.fromPoint = p;
    document.getElementById('fromInfo').textContent =
      `${p.id} (${p.lon.toFixed(5)}, ${p.lat.toFixed(5)})`;
  } else {
    State.toPoint = p;
    document.getElementById('toInfo').textContent =
      `${p.id} (${p.lon.toFixed(5)}, ${p.lat.toFixed(5)})`;
  }
  document.getElementById('go').disabled = !(State.fromPoint && State.toPoint);
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  setupSearch('from', 'fromResult', name => pickRoad(name, 'from'));
  setupSearch('to',   'toResult',   name => pickRoad(name, 'to'));
  document.getElementById('from').addEventListener('focus', () => State.mode = 'from');
  document.getElementById('to'  ).addEventListener('focus', () => State.mode = 'to'  );
}
