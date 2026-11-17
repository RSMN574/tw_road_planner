// transit.js — 公車＋捷運：載入、合併、轉乘連結
import { State, Hooks } from './state.js';
import { LINE_NAME, METRO_DWELL_S, METRO_CURVE, METRO_MPS, MRT_TRANSFER_M, SNAP_MAX_M } from './constants.js';
import { worldHaversine } from './geo.js';
import { busNearIdx, mergeParsed, parseBus, projectBusStops } from './bus-core.js';
import { uiEl } from './ctx.js';

// metro.json（TDX Metro Station：只有站點，沒有站序／班距／時刻表）→ 公車圖格式
// 站序：由 StationID（線代碼＋站號，例如 G8 < G8a < G9）推得；行駛時間與距離是估計值，介面一律標示為「系統推估」
export function metroToGraph(json) {
  const rows = (Array.isArray(json) ? json : json.Stations || json.stations || json.data || []).filter(s => s && s.StationID && s.StationPosition);
  if (!rows.length) throw new Error('找不到站點（需要 StationID 與 StationPosition）');
  const nodes = {}, lines = new Map();
  for (const s of rows) {
    const uid = s.StationUID || s.StationID, m = /^([A-Za-z]+)(\d+)([a-z]?)$/.exec(s.StationID);
    nodes[uid] = { stop_id: s.StationID, node_name: s.StationName?.Zh_tw || uid, latitude: s.StationPosition.PositionLat, longitude: s.StationPosition.PositionLon, kind: 'metro' };
    if (!m) continue;                                                       // ID 不是「線代碼＋站號」→ 只當獨立站，不連邊
    const L = m[1].toUpperCase(); if (!lines.has(L)) lines.set(L, []); lines.get(L).push({ uid, n: +m[2], sfx: m[3] });
  }
  const adjacency = {};
  for (const [L, st] of lines) {
    st.sort((a, b) => a.n - b.n || a.sfx.localeCompare(b.sfx));
    const label = LINE_NAME[L] || `捷運${L}線`;
    for (let i = 0; i < st.length - 1; i++) for (const [a, b] of [[st[i], st[i+1]], [st[i+1], st[i]]]) {
      const A = nodes[a.uid], B = nodes[b.uid], d = worldHaversine(A.longitude, A.latitude, B.longitude, B.latitude) * METRO_CURVE;   // 直線距離 × 係數 ≈ 軌道長度
      (adjacency[a.uid] = adjacency[a.uid] || []).push({ to: b.uid, distance_meters: d, route_name: label, route_uid: 'MRT-' + L, mode: 'metro', travel_times: [{ run_time: Math.round(d / METRO_MPS + METRO_DWELL_S) }] });
    }
  }
  return { nodes, adjacency, lines: [...lines].map(([L, st]) => ({ line: LINE_NAME[L] || L, stations: st.map(x => nodes[x.uid].node_name) })) };
}

// 捷運站 ↔ 附近公車站牌：建立步行轉乘（同站群，固定罰時）。只把「尚未屬於其他站群」的站牌併進來，不破壞原有站群
export function linkMetroTransfers(b) {
  let linked = 0;
  for (let i = 0; i < b.n; i++) {
    if (b.stopKind[i] !== 'metro' || !(b.x[i] === b.x[i])) continue;
    const near = busNearIdx(b.x[i], b.y[i], MRT_TRANSFER_M).filter(j => b.stopKind[j] === 'bus');
    if (!near.length) continue;
    let g = b.group[i]; if (g < 0) g = near.map(j => b.group[j]).find(x => x >= 0) ?? -1;
    if (g < 0) { g = b.members.length; b.members.push([]); }
    for (const j of [i, ...near]) if (b.group[j] < 0) { b.group[j] = g; b.members[g].push(j); }
    linked++;
  }
  return linked;
}

export function rebuildTransit() {
  const st = uiEl('busStat'), ms = uiEl('metroStat');
  try {
    State.graphVersion++;
    const parts = []; if (State.busJson) parts.push(parseBus(State.busJson)); if (State.metroJson) parts.push(parseBus(State.metroJson));
    if (!parts.length) { State.bus = null; st.textContent = ''; Hooks.updateBusSuggestion?.(); return; }
    State.bus = parts.length === 2 ? mergeParsed(parts[0], parts[1]) : parts[0];
    const ok = projectBusStops(), linked = ok ? linkMetroTransfers(State.bus) : 0, b = State.bus, dg = ok && b.diag ? b.diag : null;
    const nBus = b.stopKind.filter(k => k !== 'metro').length, nMetro = b.n - nBus;
    st.innerHTML = State.busJson ? `公車：${nBus.toLocaleString()} 站 · ${b.routeLabels.filter((_, i) => b.routeKind[i] !== 'metro').length} 路線` + (ok ? '' : '（載入道路圖後生效）') +
      (dg ? `<br>${Math.round((b.snapPct || 0) * 100)}% 站牌已吸附到道路（≤${SNAP_MAX_M} m）；站點離最近道路：中位 ${isFinite(dg.med) ? Math.round(dg.med) + ' m' : '無（皆在路網範圍外）'}，${Math.round(dg.within50 * 100)}% 在 50 m 內` +
        (dg.adopted ? `<br>✅ 已自動改用「${dg.adopted}」` : '') + ((!isFinite(dg.med) || dg.med > 100 || dg.within50 < 0.5) ? '<br>⚠ 偏差仍大：Console 執行 busDiag() 看各假設比較' : '') : '') : '';
    if (ms && State.metroJson) ms.innerHTML = `🚇 捷運：${nMetro} 站 · ${State.metroJson.lines.map(l => `${l.line}（${l.stations.length} 站）`).join('、')}` + (ok ? `<br>${linked} 站與 ${MRT_TRANSFER_M} m 內的公車站牌建立步行轉乘` : '（載入道路圖後生效）') + '<br><small>班距、行駛時間為系統推估（資料沒有時刻表）</small>';
    Hooks.updateBusSuggestion?.();
  } catch (err) { State.bus = null; st.textContent = '公車／捷運資料載入失敗：' + err.message; }
}
export function reprojectTransit() { if (State.bus) { projectBusStops(); linkMetroTransfers(State.bus); } }   // 重新載入道路圖後，站牌要重新投影與連結
export function loadBus(json) { State.busJson = json; rebuildTransit(); }
export function loadMetro(json) {
  try { State.metroJson = metroToGraph(json); } catch (e) { uiEl('metroStat').textContent = '捷運資料載入失敗：' + e.message; return; }
  rebuildTransit();
}

export function init() {
  document.getElementById('busFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadBus(JSON.parse(await f.text())); } catch (err) { document.getElementById('busStat').textContent = '不是有效的 JSON'; } } });
  document.getElementById('metroFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadMetro(JSON.parse(await f.text())); } catch (err) { document.getElementById('metroStat').textContent = '不是有效的 JSON'; } } });
  fetch('./data/bus/graph.json').then(r => r.ok ? r.json() : null).then(j => j && loadBus(j)).catch(() => {});
  fetch('./data/metro.json').then(r => r.ok ? r.json() : null).then(j => j && loadMetro(j)).catch(() => {});
}
