// transit.js — 公車＋捷運：載入、合併、轉乘連結
import { State, Hooks } from './state.js';
import { LINE_NAME, METRO_ACCESS_S, METRO_DWELL_S, METRO_CURVE, METRO_LINE_XFER_R, METRO_MPS, METRO_PLATFORM_S, METRO_XFER_R, SNAP_MAX_M, WALK_DETOUR, WALK_MPS, WALK_NET_MAX_M } from './constants.js';
import { worldDistM, worldHaversine } from './geo.js';
import { MinHeap } from './heap.js';
import { findNearestNode } from './graph-core.js';
import { busNearIdx, mergeParsed, parseBus, projectBusStops } from './bus-core.js';
import { uiEl } from './ctx.js';

// metro.json → 公車圖格式（捷運站＝節點、相鄰兩站＝邊）。接受兩種形狀：
//   ① TDX Metro/Station 的陣列（只有車站）：站序由 StationID（線代碼＋站號，例如 G8 < G8a < G9）推得；行駛時間以距離推估
//   ② 物件 { Stations, StationOfLine?, S2STravelTime?, LineTransfer?, Frequency?, FirstLastTimetable? }（TDX 原始欄位）：
//      有 StationOfLine 就用真正的站序；有 S2STravelTime 就用真正的站間時間；其餘資料交給時刻表搜尋（班距、首末班車）與轉乘
// 推估的部分都會標示來源（meta.runSrc 等），介面一律顯示「系統推估」。
export function metroToGraph(json) {
  const W = json && !Array.isArray(json) ? json : {}, rows = (Array.isArray(json) ? json : W.Stations || W.stations || W.Station || W.data || []).filter(s => s && s.StationID && s.StationPosition && Number.isFinite(+s.StationPosition.PositionLat) && Number.isFinite(+s.StationPosition.PositionLon));
  if (!rows.length) throw new Error('找不到站點（需要 TDX 格式：StationID 與 StationPosition 的經緯度）');
  const nodes = {}, byId = new Map(), lines = new Map(), op = s => (s.StationUID && s.StationUID.includes('-') ? s.StationUID.slice(0, s.StationUID.indexOf('-')) : '');
  for (const s of rows) { const uid = s.StationUID || s.StationID; byId.set(String(s.StationID), uid); nodes[uid] = { stop_id: s.StationID, node_name: s.StationName?.Zh_tw || uid, latitude: +s.StationPosition.PositionLat, longitude: +s.StationPosition.PositionLon, kind: 'metro', line: null, operator: op(s) || null }; }
  let order = 'StationID';
  if (Array.isArray(W.StationOfLine) && W.StationOfLine.length) {                                  // 真正的站序
    order = 'TDX StationOfLine';
    for (const l of W.StationOfLine) { const L = String(l.LineID ?? l.LineNo ?? ''); if (!L) continue;
      const st = (l.Stations || []).filter(x => byId.has(String(x.StationID)) && Number.isFinite(+x.Sequence)).sort((a, b) => a.Sequence - b.Sequence).map(x => ({ uid: byId.get(String(x.StationID)) }));
      if (st.length) lines.set(L, st); }
  } else for (const s of rows) {
    const uid = s.StationUID || s.StationID, m = /^([A-Za-z]+)(\d+)([A-Za-z]?)$/.exec(s.StationID);
    if (!m) continue;                                                       // ID 不是「線代碼＋站號」→ 只當獨立站，不連邊（狀態列會列出）
    const L = m[1].toUpperCase(); if (!lines.has(L)) lines.set(L, []); lines.get(L).push({ uid, n: +m[2], sfx: m[3].toLowerCase() });
  }
  const s2s = new Map(); for (const r of W.S2STravelTime || []) for (const t of r.TravelTimes || []) { const a = byId.get(String(t.FromStationID)), b = byId.get(String(t.ToStationID)), rt = +t.RunTime; if (a && b && rt > 0) s2s.set(a + '>' + b, rt + (+t.StopTime > 0 ? +t.StopTime : 0)); }
  const adjacency = {}; let est = 0, real = 0;
  for (const [L, st] of lines) {
    if (order === 'StationID') st.sort((a, b) => a.n - b.n || a.sfx.localeCompare(b.sfx));
    const label = LINE_NAME[L] || `捷運${L}線`;
    for (const x of st) if (!nodes[x.uid].line) nodes[x.uid].line = L;
    for (let i = 0; i < st.length - 1; i++) for (const [a, b] of [[st[i], st[i+1]], [st[i+1], st[i]]]) {
      const A = nodes[a.uid], B = nodes[b.uid], d = worldHaversine(A.longitude, A.latitude, B.longitude, B.latitude) * METRO_CURVE;   // 直線距離 × 係數 ≈ 軌道長度
      const rt = s2s.get(a.uid + '>' + b.uid) ?? s2s.get(b.uid + '>' + a.uid); if (rt) real++; else est++;
      (adjacency[a.uid] = adjacency[a.uid] || []).push({ to: b.uid, distance_meters: d, route_name: label, route_uid: 'MRT-' + L, mode: 'metro', travel_times: [{ run_time: rt ?? Math.round(d / METRO_MPS + METRO_DWELL_S) }] });
    }
  }
  const lone = Object.keys(nodes).filter(u => !adjacency[u]).map(u => nodes[u].node_name);
  return { nodes, adjacency, lines: [...lines].map(([L, st]) => ({ id: L, line: LINE_NAME[L] || `捷運${L}線`, stations: st.map(x => nodes[x.uid].node_name), uids: st.map(x => x.uid) })),
    meta: { order, runSrc: real && !est ? 'TDX S2STravelTime' : real ? '部分 TDX S2STravelTime、其餘推估' : '系統推估（距離÷平均速度）', lone,
      lineTransfer: (W.LineTransfer || []).map(t => ({ from: byId.get(String(t.FromStationID)), to: byId.get(String(t.ToStationID)), sec: +t.TransferTime > 0 ? +t.TransferTime * 60 : null })).filter(t => t.from && t.to && t.sec),
      frequency: W.Frequency || null, firstLast: W.FirstLastTimetable || null, ...metroFares(W.ODFare, byId) } };
}
// TDX Metro/ODFare → { 'A站uid>B站uid': [全票單程票, 全票電子票證] }（TicketType 1＝單程票、3＝電子票證；FareClass 1＝成人。其他票種不顯示）
// 只用 TDX 給的票價，沒有資料的起訖站就不顯示票價（不推估）
export function metroFares(rows, byId) {
  if (!Array.isArray(rows) || !rows.length) return { fares: null };
  const fares = {}; let n = 0;
  for (const r of rows) {
    const a = byId.get(String(r.OriginStationID)), b = byId.get(String(r.DestinationStationID)); if (!a || !b || (r.TrainType != null && +r.TrainType !== 0 && +r.TrainType !== 1)) continue;
    const pick = (t, c) => { const f = (r.Fares || []).find(x => +x.TicketType === t && +x.FareClass === c && +x.Price >= 0); return f ? +f.Price : null; };
    const v = [pick(1, 1), pick(3, 1)]; if (v[0] == null && v[1] == null) continue;
    fares[a + '>' + b] = v; n++;
  }
  return n ? { fares, fareSrc: 'TDX ODFare' } : { fares: null };
}

// 道路網上的步行距離（公尺）：從 (x, y) 最近的道路節點出發，做有上限的 Dijkstra；回傳「到某站點的步行距離」查詢函式
// 不能只用直線距離當轉乘時間（過馬路、繞路口都要走）；沒有道路圖時才退回「直線 × 繞行係數」並標示為推估
function walkFrom(x, y) {
  const k0 = State.N ? findNearestNode(x, y) : -1;
  if (k0 < 0) return (tx, ty) => ({ m: worldDistM(x, y, tx, ty) * WALK_DETOUR, src: `直線×${WALK_DETOUR} 推估（沒有道路圖）` });
  const XY = State.nodeXY, d0 = worldDistM(x, y, XY[k0*5+2], XY[k0*5+3]), dist = new Map([[k0, d0]]), pq = new MinHeap(); pq.push(d0, k0);
  while (pq.size) {
    const [d, u] = pq.pop(); if (d > dist.get(u) || d > WALK_NET_MAX_M) continue;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u + 1]; k++) { const v = State.adjTo[k], nd = d + worldDistM(XY[u*5+2], XY[u*5+3], XY[v*5+2], XY[v*5+3]); if (nd < (dist.get(v) ?? Infinity) && nd <= WALK_NET_MAX_M) { dist.set(v, nd); pq.push(nd, v); } }
  }
  return (tx, ty, node) => { const k = node >= 0 ? node : findNearestNode(tx, ty); if (k < 0) return null; const dn = dist.get(k); if (dn === undefined) return null;
    return { m: dn + worldDistM(tx, ty, XY[k*5+2], XY[k*5+3]), src: '道路步行距離' }; };
}

// 轉乘連結（取代以前「把捷運站併進公車站群、固定 90 秒」）：每條連結有自己的步行距離與時間，雙向
//   捷運 ↔ 公車：直線 METRO_XFER_R 內的公車站；時間＝道路步行距離 ÷ 步速 ＋ 進出站時間
//   捷運 ↔ 捷運（不同路線）：有 TDX LineTransfer 就用它的轉乘時間；否則＝道路步行距離 ÷ 步速 ＋ 換月台時間
// 不靠站名相同判斷轉乘。回傳有連結的捷運站數。
export function linkMetroTransfers(b) {
  b.xfer = new Map(); b.xferStats = { metroBus: 0, metroMetro: 0, metroWithLink: 0, metroNoLink: [] };
  const put = (a, c, o) => { let l = b.xfer.get(a); if (!l) b.xfer.set(a, l = []); if (!l.some(x => x.to === c)) l.push({ to: c, ...o }); };
  const LT = new Map(((State.metroJson && State.metroJson.meta && State.metroJson.meta.lineTransfer) || []).map(t => [t.from + '>' + t.to, t.sec]));
  for (let i = 0; i < b.n; i++) {
    if (b.stopKind[i] !== 'metro' || !(b.x[i] === b.x[i])) continue;
    const walk = walkFrom(b.x[i], b.y[i]); let any = false;
    for (const j of busNearIdx(b.x[i], b.y[i], METRO_XFER_R)) {
      if (j === i) continue;
      if (b.stopKind[j] === 'bus') {
        const w = walk(b.x[j], b.y[j], b.node ? b.node[j] : -1); if (!w) continue;
        const o = { sec: w.m / WALK_MPS + METRO_ACCESS_S, m: w.m, src: w.src, kind: 'metro-bus' };
        put(i, j, o); put(j, i, { ...o, kind: 'bus-metro' }); b.xferStats.metroBus++; any = true;
      } else if (b.stopKind[j] === 'metro' && b.stopLine[j] !== b.stopLine[i] && worldDistM(b.x[i], b.y[i], b.x[j], b.y[j]) <= METRO_LINE_XFER_R) {
        const tdx = LT.get(b.uids[i] + '>' + b.uids[j]), w = tdx ? null : walk(b.x[j], b.y[j], -1);
        if (!tdx && !w) continue;
        put(i, j, tdx ? { sec: tdx, m: 0, src: 'TDX LineTransfer', kind: 'metro-metro' } : { sec: w.m / WALK_MPS + METRO_PLATFORM_S, m: w.m, src: w.src + '＋換月台推估', kind: 'metro-metro' });
        b.xferStats.metroMetro++; any = true;
      }
    }
    if (any) b.xferStats.metroWithLink++; else b.xferStats.metroNoLink.push(b.names[i]);
  }
  return b.xferStats.metroWithLink;
}

export function rebuildTransit() {
  const st = uiEl('busStat');
  try {
    State.graphVersion++;
    const parts = []; if (State.busJson) parts.push(parseBus(State.busJson)); if (State.metroJson) parts.push(parseBus(State.metroJson));
    if (!parts.length) { State.bus = null; st.textContent = ''; Hooks.updateBusSuggestion?.(); return; }
    State.bus = parts.length === 2 ? mergeParsed(parts[0], parts[1]) : parts[0];
    const ok = projectBusStops(); if (ok) linkMetroTransfers(State.bus);
    renderTransitStat(ok);
    Hooks.updateBusSuggestion?.();
  } catch (err) { State.bus = null; st.textContent = '公車／捷運資料載入失敗：' + err.message; }
}
// 狀態列（公車、捷運）：道路圖載入前後都要更新（以前道路圖後載入時，捷運狀態一直停在「載入道路圖後生效」）
function renderTransitStat(ok) {
  const st = uiEl('busStat'), ms = uiEl('metroStat'), b = State.bus; if (!b) return;
  const dg = ok && b.diag ? b.diag : null, nBus = b.stopKind.filter(k => k !== 'metro').length, nMetro = b.n - nBus;
  st.innerHTML = State.busJson ? `公車：${nBus.toLocaleString()} 站 · ${b.routeLabels.filter((_, i) => b.routeKind[i] !== 'metro').length} 路線` + (ok ? '' : '（載入道路圖後生效）') +
    (dg ? `<br>${Math.round((b.snapPct || 0) * 100)}% 站牌已吸附到道路（≤${SNAP_MAX_M} m）；站點離最近道路：中位 ${isFinite(dg.med) ? Math.round(dg.med) + ' m' : '無（皆在路網範圍外）'}，${Math.round(dg.within50 * 100)}% 在 50 m 內` +
      (dg.adopted ? `<br>✅ 已自動改用「${dg.adopted}」（只套用在公車站，捷運站不受影響）` : '') + ((!isFinite(dg.med) || dg.med > 100 || dg.within50 < 0.5) ? '<br>⚠ 偏差仍大：Console 執行 busDiag() 看各假設比較' : '') : '') : '';
  const xs = b.xferStats || { metroBus: 0, metroMetro: 0, metroNoLink: [] }, mm = State.metroJson && State.metroJson.meta, linked = xs.metroWithLink || 0;
  if (ms && State.metroJson) ms.innerHTML = `🚇 捷運：${nMetro} 站 · ${State.metroJson.lines.map(l => `${l.line}（${l.stations.length} 站）`).join('、')}` +
    (ok ? `<br>${linked} 站有步行轉乘（捷運↔公車 ${xs.metroBus} 條、跨線 ${xs.metroMetro} 條，依道路步行距離）` + (xs.metroNoLink.length ? `<br>⚠ ${xs.metroNoLink.length} 站附近 ${METRO_XFER_R} m 內沒有可步行到的公車站：${xs.metroNoLink.slice(0, 5).join('、')}` : '') : '（載入道路圖後生效）') +
    (mm && mm.lone.length ? `<br>⚠ ${mm.lone.length} 站無法判斷站序、沒有連線：${mm.lone.slice(0, 5).join('、')}` : '') +
    `<br><small>站序：${mm ? mm.order : 'StationID'}；行駛時間：${mm ? mm.runSrc : '系統推估'}；班距：${mm && mm.frequency ? 'TDX Frequency' : '系統推估'}</small>`;
}
export function reprojectTransit() { if (State.bus) { const ok = projectBusStops(); if (ok) linkMetroTransfers(State.bus); renderTransitStat(ok); } }   // 重新載入道路圖後，站牌要重新投影與連結
export function loadBus(json) { State.busJson = json; rebuildTransit(); }
// 載入失敗一定要讓呼叫端知道（以前在伺服器上被吞掉，健康檢查還顯示「捷運已載入」）：畫面顯示原因，並把錯誤往上丟
export function loadMetro(json) {
  try { State.metroJson = metroToGraph(json); State.metroError = null; }
  catch (e) { State.metroError = e.message; const el = uiEl('metroStat'); if (el) el.textContent = '捷運資料載入失敗：' + e.message; throw e; }
  rebuildTransit();
}

export function init() {
  document.getElementById('busFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadBus(JSON.parse(await f.text())); } catch (err) { document.getElementById('busStat').textContent = '不是有效的 JSON'; } } });
  document.getElementById('metroFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadMetro(JSON.parse(await f.text())); } catch (err) { document.getElementById('metroStat').textContent = '捷運資料載入失敗：' + (err instanceof SyntaxError ? '不是有效的 JSON' : err.message); } } });
  fetch('./data/bus/graph.json').then(r => r.ok ? r.json() : null).then(j => j && loadBus(j)).catch(() => {});
  fetch('./data/metro.json').then(r => r.ok ? r.json() : null).then(j => j && loadMetro(j)).catch(e => { const el = document.getElementById('metroStat'); if (el && !el.textContent) el.textContent = '捷運資料載入失敗：' + e.message; });   // 沒有檔案（404）是正常的；格式錯誤要顯示
}
