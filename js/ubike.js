// ubike.js
import { Hooks, State } from './state.js';
import { autoUnit, isGeo, lonLatToTWD97, worldDistM } from './geo.js';
import { findNearestNode } from './graph-core.js';
import { uiEl } from './ctx.js';

export function parseUbike(json) {
  const arr = Array.isArray(json) ? json : (json.Stations || json.stations || json.data || json.items || []);
  const u = { uid: [], name: [], cap: [], svc: [], lon: [], lat: [] }, seen = new Set();
  for (const s of arr) {
    const uid = s.StationUID ?? s.StationID, pos = s.StationPosition || {};
    const lon = parseFloat(pos.PositionLon ?? s.lon), lat = parseFloat(pos.PositionLat ?? s.lat);
    if (uid == null || seen.has(uid) || !isFinite(lon) || !isFinite(lat)) continue;       // 以 StationUID 去重
    seen.add(uid); u.uid.push(String(uid)); u.name.push(s.StationName?.Zh_tw ?? String(uid));
    u.cap.push(Number(s.BikesCapacity) || 0); u.svc.push(s.ServiceType ?? null); u.lon.push(lon); u.lat.push(lat);
  }
  if (!u.uid.length) throw new Error('找不到有效站點（需 StationUID 與 StationPosition）');
  u.n = u.uid.length; return u;
}

export function ubProject() {                             // 與公車站同一套座標假設（單位、TWD67 偏移）
  if (!State.UB || !State.N || State.coordType === 'unknown') return false;
  const unit = isGeo() ? 1 : (State.busFix.unit ?? autoUnit()), f = { swap: false, unit, dE: State.busFix.dE, dN: State.busFix.dN };
  State.UB.x = new Float64Array(State.UB.n); State.UB.y = new Float64Array(State.UB.n); State.UB.node = new Int32Array(State.UB.n); State.UB.nd = new Float32Array(State.UB.n);
  const cell = isGeo() ? 0.005 : 500 / unit; State.UB.cell = cell; State.UB.grid = new Map(); let matched = 0;
  const saved = State.projUnit; State.projUnit = unit;
  for (let i = 0; i < State.UB.n; i++) {
    if (isGeo()) { State.UB.x[i] = State.UB.lon[i]; State.UB.y[i] = State.UB.lat[i]; }
    else { const [e, n] = lonLatToTWD97(State.UB.lon[i], State.UB.lat[i]); State.UB.x[i] = (e + f.dE) / unit; State.UB.y[i] = (n + f.dN) / unit; }
    const k = findNearestNode(State.UB.x[i], State.UB.y[i]); State.UB.node[i] = k;
    State.UB.nd[i] = k < 0 ? Infinity : worldDistM(State.UB.x[i], State.UB.y[i], State.nodeXY[k*5+2], State.nodeXY[k*5+3]);
    if (State.UB.nd[i] <= 150) matched++;
    const key = Math.floor(State.UB.x[i]/cell) * 100000 + Math.floor(State.UB.y[i]/cell);
    let a = State.UB.grid.get(key); if (!a) State.UB.grid.set(key, a = []); a.push(i);
  }
  State.projUnit = saved; State.UB.unit = unit; State.UB.matched = matched;
  return true;
}

export function ubNear(x, y, R) {                         // R 公尺內的站點 index
  const c = State.UB.cell, cx = Math.floor(x/c), cy = Math.floor(y/c), out = [];
  const saved = State.projUnit; State.projUnit = State.UB.unit;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
    for (const i of State.UB.grid.get((cx+dx)*100000 + cy+dy) || []) if (worldDistM(x, y, State.UB.x[i], State.UB.y[i]) <= R) out.push(i);
  State.projUnit = saved; return out;
}

export function loadUbike(json) {
  const st = uiEl('ubStat');
  try {
    State.UB = parseUbike(json); const ok = ubProject(); State.graphVersion++;
    st.textContent = `YouBike：${State.UB.n.toLocaleString()} 站` + (ok ? `，${State.UB.matched} 站在 150 m 內匹配到道路節點（容量為站點容量，非即時可借車數）` : '（載入道路圖後生效）');
    Hooks.scheduleRender?.();
  } catch (err) { State.UB = null; st.textContent = 'YouBike 載入失敗：' + err.message; }
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  document.getElementById('ubFile').addEventListener('change', async e => { const f = e.target.files[0]; if (f) { try { loadUbike(JSON.parse(await f.text())); } catch (err) { document.getElementById('ubStat').textContent = '不是有效的 JSON'; } } });
  document.getElementById('ubR').addEventListener('change', () => { State.UBC = null; for (const it of State.routeSet) if (it.route) it.met = Hooks.routeMetrics(it.route); Hooks.rescore(); Hooks.renderRouteList(); });
  fetch('./data/ubike.json').then(r => r.ok ? r.json() : null).then(j => j && loadUbike(j)).catch(() => {});
}
