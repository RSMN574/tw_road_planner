// osm.js — 全台 OSM 道路圖（由伺服器提供）：地圖底圖（圖磚）、路線規劃、導航的重新規劃、路名搜尋、道路資訊
// 伺服器有載入 OSM 道路圖（api/v1/health 的 osm.loaded）時自動啟用，可在介面上關閉改回本機路網。
// ・不把整張圖送到瀏覽器：底圖用 api/v1/osm/tiles/{z}/{x}/{y}.json，只抓看得到的範圍；路線由伺服器計算
// ・路線的時間、每段時間（timing）與導航 ETA 用同一套模型（eta-params.js）；渡輪、未標註的通行限制、推估的速限都會標示
// ・座標：伺服器一律用 WGS84 經緯度；網頁的「世界座標」可能是經緯度或 TWD97（有載入本機路網時），一律經 lonLatToWorld 轉換
import { Hooks, State } from './state.js';
import { svg } from './dom.js';
import { isGeo, lonLatToWorld, worldToLonLat } from './geo.js';
import { esc, fmtDist } from './util.js';
import { MODES } from './constants.js';
import { getMode, getVehicleKey } from './vehicle.js';
import { clientToWorld, fitBase, labelBBox, placeLabels, render, resetView, scheduleRender, screenToWorld, unrotate, worldToScreen } from './render-core.js';
import { ZOOM, currentZoom, metersPerPixel, syncMapUi, visibleFlatQuad } from './map-view.js';
import { drawBuildings } from './osm-buildings.js';

// ---------- 狀態 ----------
export const osmOn = () => !!(State.osm && State.osm.avail && State.osm.on);
const OSM_PREF_KEY = 'osm.on', OSM_TW = [119.25, 122.1, 21.85, 25.35];         // 台灣（含澎湖）的範圍：沒有本機路網時的初始畫面
const osmStore = { get() { try { return localStorage.getItem(OSM_PREF_KEY) !== '0'; } catch { return true; } }, set(v) { try { localStorage.setItem(OSM_PREF_KEY, v ? '1' : '0'); } catch {} } };
export const osmModeOf = () => { const v = getVehicleKey(); return v === 'bus' ? 'car' : v; };
const OSM_HW_LABEL = { motorway: '高速公路', trunk: '快速公路／省道幹道', primary: '主要道路', secondary: '次要道路', tertiary: '一般道路', unclassified: '一般道路（未分級）', residential: '巷弄／住宅區道路', living_street: '生活巷道', service: '服務道路', track: '產業道路', pedestrian: '行人徒步區', footway: '人行道', path: '小徑', cycleway: '自行車道', steps: '階梯', ferry: '渡輪航線', pier_link: '碼頭連接（推估）', motorway_link: '匝道', trunk_link: '匝道', primary_link: '連接道', secondary_link: '連接道', tertiary_link: '連接道', busway: '公車專用道', road: '道路（未分類）' };
const OSM_ACCESS = { allowed: '可通行（OSM 有標）', default_allowed: '可通行（依道路類別推定）', unknown: '未標註（依道路類別推定，結果中標示）', limited: '有限制（例如限送貨、限住戶）', restricted: '禁止（OSM 有標）', default_restricted: '禁止（依道路類別推定）', oneway: '單行道反向' };
const OSM_MODE_LABEL = { car: '汽車', heavy: '重型機車', moto: '一般機車', bike: '腳踏車', walk: '步行', foot: '步行' };

// 伺服器回報 OSM 狀態（server-link.js 呼叫）
export function osmAttach(info) {
  const avail = !!(info && info.loaded);
  State.osm = { ...(State.osm || {}), avail, info: info || null, on: State.osm && State.osm.userSet ? State.osm.on : osmStore.get(), tiles: (State.osm && State.osm.tiles) || new Map(), inflight: new Set(), queue: [] };
  const row = document.getElementById('osmRow'); if (row) row.hidden = !avail;
  const cb = document.getElementById('osmOn'); if (cb) cb.checked = State.osm.on;
  osmApply();
  return avail;
}
// 開／關 OSM 模式之後：調整畫面、控制項、提示
export function osmApply() {
  const on = osmOn(), attr = document.getElementById('osmAttr'), info = State.osm && State.osm.info;
  if (attr) attr.hidden = !on;
  const hint = document.getElementById('osmHint');
  if (hint) hint.textContent = !State.osm || !State.osm.avail ? '' : on ? `全台 OSM 道路圖（資料時間 ${osmDate(info)}）：路線在伺服器計算${info && info.alt ? '，長距離用地標加速' : ''}。` : '已關閉：使用本機載入的路網。';
  const sh = document.getElementById('sheetHandle'), tn = sh && sh.firstChild;                     // 標題：全台模式不再叫「台中道路圖」
  if (tn && tn.nodeType === 3) { if (State.osm && !State.osm.title0) State.osm.title0 = tn.nodeValue; tn.nodeValue = on ? '台灣道路圖 ' : (State.osm && State.osm.title0) || tn.nodeValue; }
  if (on && !State.loaded) {                                                       // 沒有本機路網：直接用經緯度當世界座標，畫面先放全台灣
    State.coordType = 'wgs84'; State.projUnit = 1;
    if (!State.base || !State.osm.fitted) { fitBase(OSM_TW[0], OSM_TW[1], OSM_TW[2], OSM_TW[3], 20); resetView(); State.osm.fitted = true; }
    const st = document.getElementById('stats'); if (st) st.textContent = `全台 OSM 道路圖（${osmDate(info)}）`;
    const ph = document.getElementById('placeholder'); if (ph && !State.currentRoute) { ph.classList.add('hidden'); }
    const fz = document.getElementById('fileName'); if (fz) fz.textContent = '沒有本機路網（使用全台 OSM 道路圖）';
    osmFileNote();
    const stt = document.getElementById('status'); if (stt && !State.osm.greeted) { State.osm.greeted = true; stt.className = ''; stt.style.display = 'block'; stt.innerHTML = `✅ 全台 OSM 道路圖（資料時間 ${esc(osmDate(info))}）<br>在地圖上點選起點與終點，或搜尋路名、輸入「緯度,經度」`; }
  }
  if (Hooks.syncControls) Hooks.syncControls();
  render();
}
// 「路網資料」區塊的說明：本機路網是選用的（不覆蓋載入進度）
export function osmFileNote() {
  const fl = document.getElementById('fileList'); if (!fl || document.getElementById('osmFileNote')) return;
  fl.insertAdjacentHTML('beforeend', '<div id="osmFileNote" style="color:#64748b">本機路網是選用的（台中公車營運規劃等功能需要）；路線規劃與導航使用伺服器的全台 OSM 道路圖。</div>');
}
const osmDate = info => (info && (info.dataTimestamp || info.builtAt) ? String(info.dataTimestamp || info.builtAt).slice(0, 10) : '—');
export function osmToggle(on) {
  if (!State.osm) return; State.osm.on = !!on; State.osm.userSet = true; osmStore.set(!!on);
  State.routeSet = []; State.activeKey = null; State.currentRoute = null; State.selStep = -1;
  if (State.fromPoint && State.fromPoint.idx < 0 && !on) State.fromPoint = null;             // OSM 選的點沒有本機路網節點
  if (State.toPoint && State.toPoint.idx < 0 && !on) State.toPoint = null;
  osmApply();
}

// ---------- API ----------
async function osmGet(path, params = {}) {
  const qs = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`api/v1/osm/${path}${qs ? '?' + qs : ''}`, { headers: { Accept: 'application/json' } });
  let j = null; try { j = await r.json(); } catch { /* 不是 JSON */ }
  if (!r.ok || !j || !j.ok) { const e = new Error((j && j.error && j.error.message) || `HTTP ${r.status}`); e.code = j && j.error ? j.error.code : 'HTTP_' + r.status; e.status = r.status; throw e; }
  return j.data;
}
// 點（起終點）的經緯度：OSM 選的點有 ll；本機路網的節點用世界座標換回經緯度
export const osmPtLL = p => p.ll || worldToLonLat(p.lon, p.lat);
// 在經緯度建立一個點（給 setPoint）：lon／lat 欄位是「世界座標」（與本機路網節點一致），ll 是經緯度
export function osmPoint(lon, lat, label) { const [x, y] = lonLatToWorld(lon, lat); return { idx: -1, lon: x, lat: y, ll: [lon, lat], id: label || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, osm: true }; }
// 補上最近道路的名稱（非同步，不擋操作）
export async function osmNameFor(p, infoId) {
  try {
    const [lon, lat] = osmPtLL(p), d = await osmGet('nearest', { lat: lat.toFixed(6), lon: lon.toFixed(6), mode: osmModeOf(), radius: 300 });
    const name = d.name || d.ref || OSM_HW_LABEL[d.highway] || d.highway; p.road = name; p.roadM = d.distanceM;
    const el = document.getElementById(infoId); if (el && (infoId === 'fromInfo' ? State.fromPoint : State.toPoint) === p) el.textContent = `${p.id}（最近道路：${name}，${d.distanceM} m）`;
  } catch (e) {
    const el = document.getElementById(infoId); if (el && e.code === 'NO_ROAD_NEARBY') el.textContent = `${p.id}（⚠ 300 m 內沒有這種運具可走的道路）`;
  }
}

// ---------- 路線 ----------
const OSM_COLOR = { fastest: (MODES.find(m => m.key === 'fastest') || {}).color || '#16a34a', shortest: (MODES.find(m => m.key === 'shortest') || {}).color || '#f59e0b' };
const osmIsToll = w => w.highway === 'motorway' && /國道|高速公路/.test(`${w.ref} ${w.name}`);
// 某一段（coords 的第 i 段）所屬 way 的速限文字：OSM 有標／區域速限代碼（TW:urban 等）／依道路類別推估
export function osmSpdText(sr, i) {
  const T = sr.timing, w = T && T.segWay ? sr.ways[T.segWay[Math.max(0, Math.min(T.segWay.length - 1, i))]] : null;
  if (!w || w.limitKmh == null) return w && w.highway === 'ferry' ? '渡輪' : '';
  return w.limitSrc === 'tag' ? `速限 ${w.limitKmh} km/h` : w.limitSrc === 'zone' ? `區域速限約 ${w.limitKmh} km/h（OSM 只標區域代碼，依類別推估）` : `速限未知（推估 ${w.limitKmh} km/h）`;
}
// 伺服器的一條路線 → 網頁的 route 物件（coords 是世界座標；_osm 保留伺服器的原始資料）
export function osmRouteObj(sr, color, label) {
  const coords = sr.geometry.map(([lo, la]) => lonLatToWorld(lo, la)), T = sr.timing || {};
  const route = { coords, _ll: sr.geometry, distance: sr.distanceM, _osm: sr, _plain: true, _color: color, _label: label, _segs: null };
  route._man = (sr.steps || []).map(s => ({ index: Math.min(s.index, coords.length - 1), roadName: s.road || '', turnAngle: s.angle || 0, turnType: s.type, dir: s.dir || '', distanceFromPrev: s.distanceFromPrev || 0,
    spd: s.type === 'arrive' ? '' : s.type === 'ferry' ? '渡輪（不含候船與班次時間）' : osmSpdText(sr, s.index), xy: coords[Math.min(s.index, coords.length - 1)] }));
  route._segKey = i => { const w = T.segWay ? sr.ways[T.segWay[i]] : null; return w ? 'osm:' + w.id : null; };   // 本機歷史速度的鍵（OSM way id）
  return route;
}
// 路線清單的一筆
export function osmItem(sr, vk, notes = []) {
  const label = sr.key === 'shortest' ? '最短距離' : sr.alsoShortest ? '最快（也是最短）' : '最快', color = OSM_COLOR[sr.key] || '#2563eb', route = osmRouteObj(sr, color, label);
  const seq = []; for (const n of sr.roads || []) if (seq[seq.length - 1] !== n) seq.push(n);
  const toll = (sr.ways || []).filter(osmIsToll).reduce((a, w) => a + w.m, 0), turns = route._man.filter(m => ['slight', 'turn', 'sharp', 'uturn'].includes(m.turnType)).length;
  return { key: sr.key, label, color, visible: true, route, msg: '', plain: true, osm: true, min: sr.durationS / 60, seq, met: null, turns, algo: `伺服器 OSM 全台路網（A*${State.osm && State.osm.info && State.osm.info.alt ? '＋ALT 地標' : ''}）`, veh: vk, toll, note: [osmWarnText(sr), ...notes].filter(Boolean).join('；') };
}
// 結果中要標示的事項：渡輪、未標註／有限制的通行、條件限制、推估的速限
export function osmWarnText(sr) {
  const w = sr.warnings || {}, out = [];
  if (sr.ferries && sr.ferries.length) out.push(`含渡輪 ${sr.ferries.length} 段（${sr.ferries.map(f => `${f.name || '航線'} 約 ${Math.round(f.durationS / 60)} 分${f.source === 'OSM duration' ? '' : '・推估'}`).join('、')}；不含候船，請查班表）`);
  if (w.unknownM > 50) out.push(`${fmtDist(w.unknownM)} 的通行權 OSM 未標註（依道路類別推定）`);
  if (w.limitedM > 20) out.push(`${fmtDist(w.limitedM)} 有通行限制（例如限住戶）`);
  if (w.conditionalM > 20) out.push(`${fmtDist(w.conditionalM)} 有時段／條件限制（未判斷時段）`);
  if (w.pierLinkM > 20) out.push(`碼頭連接 ${fmtDist(w.pierLinkM)} 為推估`);
  const zone = (sr.ways || []).filter(x => x.limitSrc === 'zone').reduce((a, x) => a + x.m, 0);
  if (w.unknownSpeedM > 200) out.push(`${Math.round(w.unknownSpeedM / Math.max(1, sr.distanceM) * 100)}% 路段沒有速限資料${zone > 100 ? `（其中 ${fmtDist(zone)} 只有區域代碼如 TW:urban）` : ''}，時間依道路類別推估`);
  return out.join('；');
}
// 規劃：回傳 { items, notes }（失敗丟出 Error）
export async function osmPlan(from, to) {
  const vk = getVehicleKey(), mode = osmModeOf(), [lo1, la1] = osmPtLL(from), [lo2, la2] = osmPtLL(to);
  const d = await osmGet('route', { from: `${la1.toFixed(6)},${lo1.toFixed(6)}`, to: `${la2.toFixed(6)},${lo2.toFixed(6)}`, mode, alternatives: 1 });
  const notes = d.notes || [];
  return { items: d.routes.map(sr => osmItem(sr, vk === 'bus' ? 'car' : vk)), notes, data: d.data };
}
// 導航中偏航：從目前定位（含行進方向）重新規劃到原本的終點
export async function osmReroute(fix, planKey = 'fastest') {
  if (!State.toPoint) return { error: '沒有終點' };
  const [lo2, la2] = osmPtLL(State.toPoint), moving = fix.heading != null && (fix.speed ?? 0) >= 2;
  try {
    const d = await osmGet('route', { from: `${fix.lat.toFixed(6)},${fix.lon.toFixed(6)}`, to: `${la2.toFixed(6)},${lo2.toFixed(6)}`, mode: osmModeOf(), alternatives: planKey === 'shortest' ? 'all' : 0, heading: moving ? Math.round(fix.heading) : undefined, steps: 1 });
    const sr = d.routes.find(r => r.key === planKey) || d.routes[0]; if (!sr) return { error: '找不到從目前位置出發的路線' };
    const it = osmItem(sr, getVehicleKey()); return { route: it.route, item: it };
  } catch (e) { return { error: e.status === 404 || e.status === 422 ? (e.message || '找不到從目前位置出發的路線') : '無法連線伺服器重新規劃（' + e.message + '）' }; }
}
// 路線分析表的列（ui-panels.renderAnalysis 用）
export function osmAnalysisRows(it) {
  const sr = it.route._osm, w = sr.warnings || {}, ways = sr.ways || [], L = Math.max(1, sr.distanceM);
  const tag = ways.filter(x => x.limitSrc === 'tag').reduce((a, x) => a + x.m, 0), zone = ways.filter(x => x.limitSrc === 'zone').reduce((a, x) => a + x.m, 0);
  const lim = ways.filter(x => x.limitSrc === 'tag'), avg = tag ? lim.reduce((a, x) => a + x.limitKmh * x.m, 0) / tag : NaN;
  const rows = [['路線', it.label], ['資料', `OpenStreetMap（資料時間 ${osmDate(State.osm && State.osm.info)}；© OpenStreetMap contributors）`], ['演算法', it.algo], ['總距離', fmtDist(sr.distanceM)],
    [`預估時間（${OSM_MODE_LABEL[osmModeOf()] || ''}）`, `${(sr.durationS / 60).toFixed(1)} 分：行駛 ${(sr.driveS / 60).toFixed(1)} 分＋路口與轉彎 ${(sr.delayS / 60).toFixed(1)} 分（未含即時路況、收費站）`],
    ['速限資料', `OSM 有標 ${Math.round(tag / L * 100)}%${isFinite(avg) ? `（平均 ${Math.round(avg)} km/h）` : ''}${zone ? `；只有區域代碼 ${Math.round(zone / L * 100)}%` : ''}；其餘依道路類別推估`],
    ['轉彎', `${it.turns} 次`], ['收費路段（國道）', it.toll > 0 ? `${(it.toll / 1000).toFixed(1)} km（費率未納入）` : '無']];
  if (sr.ferries && sr.ferries.length) rows.push(['渡輪', sr.ferries.map(f => `${f.name || '航線'} ${fmtDist(f.m)}、約 ${Math.round(f.durationS / 60)} 分（${f.source}）`).join('；') + '；不含候船與班次時間']);
  const acc = [w.unknownM > 0 ? `未標註 ${fmtDist(w.unknownM)}` : '', w.limitedM > 0 ? `有限制 ${fmtDist(w.limitedM)}` : '', w.conditionalM > 0 ? `時段／條件限制 ${fmtDist(w.conditionalM)}（未判斷）` : '', w.defaultAllowedM > 0 ? `依道路類別推定可通行 ${fmtDist(w.defaultAllowedM)}` : ''].filter(Boolean);
  rows.push(['通行資料', acc.length ? acc.join('；') : '全部有 OSM 標註']);
  if (sr.snap) rows.push(['起終點吸附', `起點離道路 ${Math.round(sr.snap.fromM ?? 0)} m、終點 ${Math.round(sr.snap.toM ?? 0)} m`]);
  return rows;
}

// ---------- 路名搜尋 ----------
export async function osmSearch(q) {
  let near; if (State.base) { const w = svg.clientWidth, h = svg.clientHeight, [x, y] = screenToWorld(w / 2, h / 2), [lo, la] = worldToLonLat(x, y); if (isFinite(lo) && isFinite(la)) near = `${la.toFixed(5)},${lo.toFixed(5)}`; }
  const d = await osmGet('search', { q, near, limit: 20 }); return d.results;
}
export const osmHwLabel = hw => OSM_HW_LABEL[hw] || hw;

// ---------- 道路資訊（點地圖查看）----------
export async function osmInspect(x, y, box) {                     // x, y：世界座標
  const [lon, lat] = worldToLonLat(x, y), mode = osmModeOf();
  box.innerHTML = '<div class="rt na">查詢道路資訊…</div>';
  try {
    const d = await osmGet('nearest', { lat: lat.toFixed(6), lon: lon.toFixed(6), mode, radius: 200 });
    State.osm.inspect = lonLatToWorld(d.at[1], d.at[0]);
    const rows = [['道路', d.name || '（無路名）'], ['編號', d.ref || '—'], ['類別（OSM）', `${osmHwLabel(d.highway)}（highway=${d.highway}）`], ['速限', d.limitSrc === 'tag' ? `${d.limitKmh} km/h（OSM 有標）` : d.limitSrc === 'zone' ? `約 ${d.limitKmh} km/h（OSM 只標區域代碼，依類別推估）` : `未知（依道路類別推估 ${d.limitKmh} km/h）`],
      ...Object.entries(d.access).map(([k, v]) => [`通行：${OSM_MODE_LABEL[k] || k}`, OSM_ACCESS[v] || v]), ['距離', `${d.distanceM} m`], ['OSM way', String(d.osmWay)]];
    box.innerHTML = `<div style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">🛣 道路資訊（OSM）</div><table style="font-size:12px;width:100%;border-collapse:collapse">` +
      rows.map(([a, b]) => `<tr><td style="color:#64748b;padding:2px 6px 2px 0;white-space:nowrap">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('') + '</table><div style="font-size:11px;color:#94a3b8;margin-top:4px">資料：© OpenStreetMap contributors。未標註的通行權依道路類別推定。</div>';
  } catch (e) { State.osm.inspect = null; box.innerHTML = `<div class="rt na">${esc(e.code === 'NO_ROAD_NEARBY' ? '附近 200 m 內沒有這種運具可用的道路' : '查詢失敗：' + e.message)}</div>`; }
  scheduleRender();
}

// ---------- 地圖底圖（圖磚）----------
// 圖磚當 512 像素用：縮放層級＝讓圖磚約 512 像素寬；看得到的範圍外加 40%（拖曳時只平移已畫好的畫面，邊緣也要有圖）
// v1.11：圖磚最高 z18（512 像素；＝一般網頁地圖的 z19）。再放大是向量 overzoom（座標量化約 3.4 cm，不會模糊），上限見 map-view.ZOOM
const OSM_ZMIN = 6, OSM_ZMAX = ZOOM.tileMax512, OSM_CACHE_MAX = 700, OSM_PARALLEL = 6, OSM_MAX_TILES = 120;
// 樣式：顏色、寬度（像素，依縮放加粗）、外框
const OSM_STYLE = {
  motorway: ['#f59e0b', 3.2, 1], trunk: ['#fb923c', 2.8, 1], primary: ['#fcd34d', 2.4, 1], secondary: ['#fde68a', 2.0, 1], tertiary: ['#ffffff', 1.8, 1],
  motorway_link: ['#f59e0b', 1.6, 1], trunk_link: ['#fb923c', 1.5, 1], primary_link: ['#fcd34d', 1.4, 1], secondary_link: ['#fde68a', 1.3, 1], tertiary_link: ['#ffffff', 1.2, 1],
  unclassified: ['#ffffff', 1.4, 1], residential: ['#ffffff', 1.3, 1], road: ['#ffffff', 1.2, 1], living_street: ['#f1f5f9', 1.2, 1], busway: ['#bfdbfe', 1.2, 1], service: ['#ffffff', 0.9, 1], track: ['#d6b38a', 0.9, 0], escape: ['#ffffff', 0.9, 1],
  pedestrian: ['#e2e8f0', 1.1, 1], footway: ['#fca5a5', 0.7, 0], path: ['#a8a29e', 0.7, 0], steps: ['#f87171', 0.9, 0], cycleway: ['#60a5fa', 0.8, 0], bridleway: ['#a8a29e', 0.7, 0], corridor: ['#cbd5e1', 0.6, 0],
  ferry: ['#38bdf8', 1.4, 0], pier_link: ['#94a3b8', 0.8, 0]
};
// 道路典型寬度（公尺；一條 OSM way＝一個行車方向的車道組或雙向道路）：OSM 沒標 width／lanes 時，高縮放的線寬用這個
const OSM_WIDTH_M = { motorway: 11, motorway_link: 5, trunk: 10, trunk_link: 5, primary: 10, primary_link: 5, secondary: 8, secondary_link: 5, tertiary: 7, tertiary_link: 4.5, unclassified: 6, residential: 5, road: 5, living_street: 4,
  busway: 4, service: 3.5, track: 3, escape: 4, pedestrian: 5, footway: 2, path: 1.5, steps: 2, cycleway: 2, bridleway: 2, corridor: 2, ferry: 1, pier_link: 2 };
const OSM_ORDER = ['track', 'path', 'bridleway', 'footway', 'steps', 'corridor', 'cycleway', 'pier_link', 'service', 'escape', 'pedestrian', 'living_street', 'road', 'residential', 'unclassified', 'busway', 'tertiary_link', 'secondary_link', 'primary_link', 'trunk_link', 'motorway_link', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'ferry'];
const OSM_DASH = { ferry: '6 5', path: '3 3', footway: '2 3', track: '5 3', bridleway: '3 3', steps: '1.5 2', pier_link: '3 3' };
const osmTileKey = (z, x, y) => z + '/' + x + '/' + y;
const osmLon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), osmLat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
// 目前畫面的經緯度範圍與每像素的經度；3D 傾斜時加上地面上看得到的梯形（上緣延伸到畫面外），旋轉時用外接圓
function osmView(padK = 0.4) {
  const w = svg.clientWidth || 800, h = svg.clientHeight || 600, cam = State.cam, r = cam && cam.rot ? Math.hypot(w, h) / 2 : 0;
  const cx = w / 2, cy = h / 2, hw = (r || w / 2) * (1 + padK), hh = (r || h / 2) * (1 + padK);
  let corners = [[cx - hw, cy - hh], [cx + hw, cy - hh], [cx - hw, cy + hh], [cx + hw, cy + hh]].map(([sx, sy]) => screenToWorld(sx, sy));
  if (State.pitchCss && State.pitchCss.deg) corners = corners.concat(visibleFlatQuad(padK).map(([fx, fy]) => clientToWorld(fx, fy)));
  const pts = corners.map(([x, y]) => worldToLonLat(x, y));
  const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]), [l0] = worldToLonLat(...screenToWorld(0, cy)), [l1] = worldToLonLat(...screenToWorld(w, cy));
  return { w0: Math.min(...lons), e0: Math.max(...lons), s0: Math.min(...lats), n0: Math.max(...lats), dpp: Math.abs(l1 - l0) / w };
}
export function osmZoom(dpp) { return Math.max(OSM_ZMIN, Math.min(OSM_ZMAX, Math.round(Math.log2(360 / (512 * dpp))))); }
function osmFetchTile(z, x, y) {
  const S = State.osm, key = osmTileKey(z, x, y); if (S.tiles.has(key) || S.inflight.has(key)) return;
  if (S.inflight.size >= OSM_PARALLEL) { if (!S.queue.includes(key)) S.queue.push(key); return; }
  S.inflight.add(key); const ver = encodeURIComponent((S.info && S.info.version) || '');
  fetch(`api/v1/osm/tiles/${z}/${x}/${y}.json?v=${ver}`).then(r => (r.ok ? r.json() : null)).then(t => { S.tiles.set(key, t ? osmDecode(t) : { empty: true }); }).catch(() => { /* 網路錯誤：下次重畫再試 */ })
    .finally(() => {
      S.inflight.delete(key);
      while (S.tiles.size > OSM_CACHE_MAX) S.tiles.delete(S.tiles.keys().next().value);
      if (S.queue.length) { const [qz, qx, qy] = S.queue.shift().split('/').map(Number); osmFetchTile(qz, qx, qy); }
      clearTimeout(S.redraw); S.redraw = setTimeout(() => { if (!(State.nav && State.nav.follow)) scheduleRender(); else State.renderFull = true; }, 120);   // 導航跟隨中：等下次畫面更新時再完整重畫
    });
}
// 解碼：圖磚格點 → 經緯度 → 世界座標（只做一次）
function osmDecode(t) {
  const [w, s, e, n] = t.bbox, X = t.extent || 4096, kx = (e - w) / X, ky = (n - s) / X, roads = [];
  for (const [hi, ni, ow, c, wm] of t.roads) {
    const m = c.length / 2, xs = new Float64Array(m), ys = new Float64Array(m); let px = 0, py = 0;
    for (let i = 0; i < m; i++) { px += c[2 * i]; py += c[2 * i + 1]; if (!i) { px = c[0]; py = c[1]; } const [wx, wy] = lonLatToWorld(w + px * kx, n - py * ky); xs[i] = wx; ys[i] = wy; }
    roads.push({ hw: t.hw[hi], name: ni ? t.names[ni - 1] : '', ow, xs, ys, wm: wm || 0 });
  }
  return { z: t.z, roads, geo: isGeo() };
}
// 畫底圖（render-core.drawGrid 呼叫）：先用已快取的圖磚畫（較粗的層級當暫時的替代），缺的再去抓
export function drawOsmBase() {
  if (!osmOn() || !State.base || !svg || !svg.clientWidth) return;
  const S = State.osm, v = osmView(); let z = osmZoom(v.dpp), x0, x1, y0, y1;
  for (;; z--) { x0 = osmLon2x(v.w0, z); x1 = osmLon2x(v.e0, z); y0 = osmLat2y(v.n0, z); y1 = osmLat2y(v.s0, z); if ((x1 - x0 + 1) * (y1 - y0 + 1) <= OSM_MAX_TILES || z <= OSM_ZMIN) break; }   // 3D 看很遠時圖磚太多：整個畫面改用較粗的層級
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > OSM_MAX_TILES * 2) return;
  const use = [], seen = new Set();
  for (const t of S.tiles.values()) if (t.geo !== isGeo()) { S.tiles.clear(); break; }   // 世界座標系統變了（載入了本機路網）：重新解碼
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const k = osmTileKey(z, x, y), t = S.tiles.get(k);
    if (t) { if (!seen.has(k)) { seen.add(k); use.push(t); } continue; }
    osmFetchTile(z, x, y);
    for (let d = 1; d <= 3 && z - d >= OSM_ZMIN; d++) { const pk = osmTileKey(z - d, x >> d, y >> d), pt = S.tiles.get(pk); if (pt) { if (!seen.has(pk)) { seen.add(pk); use.push(pt); } break; } }
  }
  const W = svg.clientWidth, H = svg.clientHeight, cull = 0.6; let bx0 = -W * cull, bx1 = W * (1 + cull), by0 = -H * cull, by1 = H * (1 + cull);
  if (State.pitchCss && State.pitchCss.deg) for (const [fx, fy] of visibleFlatQuad(0.2)) { const [ux, uy] = unrotate(fx, fy); bx0 = Math.min(bx0, ux); bx1 = Math.max(bx1, ux); by0 = Math.min(by0, uy); by1 = Math.max(by1, uy); }
  // 線寬：低縮放用固定像素；z17 以上依道路實際寬度（OSM width／lanes，沒有就依道路類別的典型寬度）換算成像素，放大後道路有真實比例
  const dz = currentZoom(), mpp = metersPerPixel(), metric = Number.isFinite(dz) && dz >= 17 && mpp > 0;
  const paths = {}, labels = [], arrows = [], zk = Math.max(0.6, Math.min(2.2, 0.55 + (z - 10) * 0.18)), lab = z >= 15 && !State.currentRoute, arrowOn = Number.isFinite(dz) && dz >= 17.5;
  for (const t of use) for (const r of t.roads) {
    let d = '', inside = false, best = null, bl = 0;
    let [px, py] = worldToScreen(r.xs[0], r.ys[0]);
    for (let i = 0; i < r.xs.length; i++) {
      const [sx, sy] = i ? worldToScreen(r.xs[i], r.ys[i]) : [px, py];
      if (sx > bx0 && sx < bx1 && sy > by0 && sy < by1) inside = true;
      d += (i ? 'L' : 'M') + sx.toFixed(1) + ',' + sy.toFixed(1);
      if (lab && i && r.name) { const L = Math.hypot(sx - px, sy - py); if (L > bl) { bl = L; best = [(sx + px) / 2, (sy + py) / 2]; } }
      px = sx; py = sy;
    }
    if (!inside) continue;
    let wk = r.hw; if (metric) { const st = OSM_STYLE[r.hw] || ['#fff', 1, 1], px = Math.max(st[1] * zk, (r.wm || OSM_WIDTH_M[r.hw] || 4) / mpp); wk = r.hw + '|' + Math.min(400, Math.round(px * 2) / 2); }
    (paths[wk] = paths[wk] || []).push(d);
    if (arrowOn && r.ow) osmArrows(r, arrows);
    if (best && bl > 60) labels.push({ x: best[0], y: best[1] + 4, text: r.name, segLen: bl + (OSM_ORDER.indexOf(r.hw) * 20), bbox: labelBBox(best[0], best[1] + 4, r.name) });
  }
  let h = '<g id="osmBase">' + drawBuildings({ z, dz, mpp, bx0, bx1, by0, by1, phase: 'base', view: v });
  const keys = Object.keys(paths), keyOrder = k => { const [hw, px] = k.split('|'); return OSM_ORDER.indexOf(hw) * 1000 + (px ? +px : 0); };
  keys.sort((a, b) => keyOrder(a) - keyOrder(b));
  for (const pass of [0, 1]) for (const k of keys) {                                   // 第 0 輪：外框（灰），第 1 輪：道路顏色
    const [hw, mpx] = k.split('|'), ps = paths[k], st = OSM_STYLE[hw] || ['#ffffff', 1, 1], wpx = mpx ? +mpx : st[1] * zk;
    if (pass === 0) { if (st[2]) h += `<path d="${ps.join('')}" fill="none" stroke="#cbd5e1" stroke-width="${(wpx + (mpx ? Math.max(1.6, wpx * 0.12) : 1.6)).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`; continue; }
    h += `<path d="${ps.join('')}" fill="none" stroke="${st[0]}" stroke-width="${wpx.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"${OSM_DASH[hw] ? ` stroke-dasharray="${OSM_DASH[hw]}"` : ''}/>`;
  }
  if (arrows.length) h += `<path d="${arrows.join('')}" fill="none" stroke="#64748b" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`;
  h += drawBuildings({ z, dz, mpp, bx0, bx1, by0, by1, phase: '3d' });
  const byName = new Map(); for (const c of labels) { const o = byName.get(c.text); if (!o || c.segLen > o.segLen) byName.set(c.text, c); }   // 雙向分隔的道路是兩條 way：同名只標一次
  const fs = Number.isFinite(dz) && dz >= 18 ? 13 : 11;
  for (const c of placeLabels([...byName.values()], Number.isFinite(dz) && dz >= 17 ? 30 : 18)) h += `<text x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" text-anchor="middle" font-size="${fs}" fill="#475569" stroke="#ffffff" stroke-width="3" paint-order="stroke">${esc(c.text)}</text>`;
  h += drawBuildings({ z, dz, mpp, bx0, bx1, by0, by1, phase: 'labels' });
  if (S.inspect) { const [ix, iy] = worldToScreen(S.inspect[0], S.inspect[1]); h += `<circle cx="${ix.toFixed(1)}" cy="${iy.toFixed(1)}" r="6" fill="#f59e0b" stroke="#fff" stroke-width="2"/>`; }
  h += '</g>';
  svg.insertAdjacentHTML('beforeend', h);
  syncMapUi();
}
// 單行道箭頭（z17.5 以上）：沿線每 110 像素一個「›」，方向依 OSM 單行方向（1＝順著線、-1＝逆著）
function osmArrows(r, out) {
  let acc = 55, [px, py] = worldToScreen(r.xs[0], r.ys[0]);
  for (let i = 1; i < r.xs.length; i++) {
    const [sx, sy] = worldToScreen(r.xs[i], r.ys[i]), L = Math.hypot(sx - px, sy - py);
    if (L > 0) { let t = acc; while (t < L) { const k = t / L, x = px + (sx - px) * k, y = py + (sy - py) * k, ux = (sx - px) / L * r.ow, uy = (sy - py) / L * r.ow;
        out.push(`M${(x - 4 * ux + 3 * uy).toFixed(1)},${(y - 4 * uy - 3 * ux).toFixed(1)}L${(x + 2 * ux).toFixed(1)},${(y + 2 * uy).toFixed(1)}L${(x - 4 * ux - 3 * uy).toFixed(1)},${(y - 4 * uy + 3 * ux).toFixed(1)}`); t += 110; }
      acc = t - L; }
    px = sx; py = sy;
  }
}
// 目前畫面的縮放層級（測試、除錯用）
export function osmDebug() { const v = osmView(0); return { z: osmZoom(v.dpp), tiles: State.osm ? State.osm.tiles.size : 0, inflight: State.osm ? State.osm.inflight.size : 0, bbox: [v.w0, v.s0, v.e0, v.n0] }; }

// 載入時要執行的綁定，由 main.js 呼叫
export function init() {
  Hooks.drawOsmBase = drawOsmBase;
  const cb = document.getElementById('osmOn'); if (cb) cb.addEventListener('change', () => osmToggle(cb.checked));
}
