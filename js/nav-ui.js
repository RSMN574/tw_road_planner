// nav-ui.js — 手機導航介面：開始／暫停／結束、頂部轉彎提示、底部剩餘資訊、GPS 箭頭、語音設定、偏航後重新規劃
import { State } from './state.js';
import { svg } from './dom.js';
import { isGeo, lonLatToWorld, worldDistM, worldToLonLat } from './geo.js';
import { esc, fmtClock, fmtDist } from './util.js';
import { findNearestNode } from './graph-core.js';
import { matchToRoad } from './mapmatch.js';
import { generateManeuvers } from './analysis.js';
import { ensureVeh, getMode, getVehicleKey } from './vehicle.js';
import { planOne } from './planners.js';
import { packRoute } from './router.js';
import { GPS_TEXT, GpsService } from './gps.js';
import { NavigationEngine } from './navigation.js';
import { EtaModel, EtaSmoother } from './eta-engine.js';
import { EdgeHistory, TripLog } from './trip-log.js';
import { CameraController } from './camera.js';
import { Compass } from './compass.js';
import { AnnouncementManager, PROMPT_PROFILE, VoiceEngine, VoiceTemplates } from './voice.js';
import { render, renderView, resetView, scheduleRender, worldToScreen } from './render-core.js';
import { applyBrowseCamera, clampScale } from './map-view.js';
import { icon, turnIcon } from './ui-icons.js';
import { drawRoute } from './render-route.js';
import { showStatus } from './ui-panels.js';
import { setPoint } from './ui-search.js';
import { osmNameFor, osmOn, osmPoint, osmReroute } from './osm.js';

const gid = id => document.getElementById(id), rm = id => { const e = gid(id); if (e && e.remove) e.remove(); };
const navTxt = {}, setText = (id, v) => { if (navTxt[id] !== v) { navTxt[id] = v; const e = gid(id); if (e) e.textContent = v; } };    // 只在內容改變時才動 DOM
const navStore = { get(k, d) { try { const v = localStorage.getItem('nav.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem('nav.' + k, JSON.stringify(v)); } catch {} } };
export const settings = { voiceOn: true, rate: 1, volume: 1, promptScale: 1, smooth: true, orient: 'heading', tilt: true };
let voice = null, ann = null, wakeLock = null, bound = false, edgeHist = null;
const hist = () => edgeHist || (edgeHist = new EdgeHistory());                                    // 本機路段歷史速度（第一次導航時才讀取）

// ---------- 重新規劃（純函式，可測試）----------
// 從目前（過濾後）定位吸附到道路，沿行進方向的下一個節點出發，規劃到原本的終點。回傳 { route, item } 或 { error }
export function rerouteFromFix(fix) {
  if (!State.toPoint) return { error: '沒有終點' };
  const m = matchToRoad(fix.lon, fix.lat, { heading: fix.heading, speed: fix.speed ?? 0, accuracy: fix.accuracy });
  if (!m || !m.ok) return { error: '附近找不到道路，無法重新規劃' };
  const dest = State.toPoint.idx, u = m.u, v = m.v, nodeXY = State.nodeXY, c = i => [nodeXY[i*5+2], nodeXY[i*5+3]];
  if (v === dest) { const r = packRoute([u, v], [m.edge], State.adjW[m.edge]); return { route: r, item: { key: 'fastest', label: '重新規劃', color: '#16a34a', visible: true, route: r, plain: true, min: 0, seq: [], met: null, turns: 0, algo: '重新規劃', veh: getVehicleKey(), toll: 0 } }; }
  const item = planOne(v, dest, State.nav && State.nav.planKey || 'fastest');
  if (!item) return { error: '找不到從目前位置出發的路線' };
  const r0 = item.route;                                                                              // 在前面接上「目前所在的那條邊」，讓車輛位置落在路線上
  const route = { ...r0, path: [u, ...r0.path], edgePath: [m.edge, ...r0.edgePath], coords: [c(u), ...r0.coords], distance: r0.distance + State.adjW[m.edge], _segs: null, _man: null, _plain: true };
  return { route, item: { ...item, route } };
}

// ---------- 地圖上的 GPS 箭頭／精度圈／下一個導航點 ----------
const mPerWorld = (x, y) => isGeo() ? worldDistM(x, y, x + 1e-4, y) / 1e-4 : State.projUnit;
export function drawNav() {
  const b = gid('startNav'); if (b) b.disabled = !!State.nav || !(State.currentRoute && (State.currentRoute.edgePath || State.currentRoute._osm) && getMode() !== 'transit');
  const n = State.nav; if (!n || !n.fix || !State.base) { rm('navMarker'); return; }
  const st = n.state, fix = n.fix, P = n.disp || markerTarget(n), wx = P.x, wy = P.y;          // n.disp：動畫中的位置（兩筆定位之間平滑移動）
  const [sx, sy] = worldToScreen(wx, wy), mpw = mPerWorld(wx, wy), [ax] = worldToScreen(wx + fix.accuracy / mpw, wy), r = Math.min(120, Math.max(12, Math.abs(ax - sx)));
  const hdg = P.h, nx = st && st.next ? (st.next.nodeIdx != null ? worldToScreen(State.nodeXY[st.next.nodeIdx*5+2], State.nodeXY[st.next.nodeIdx*5+3]) : st.next.xy ? worldToScreen(st.next.xy[0], st.next.xy[1]) : null) : null;   // OSM 路線的導航點用座標（xy）
  // 箭頭元素只建立一次，之後每幀只改屬性（不重建 DOM：手機上每幀的成本小很多）
  const layer = gid('navOverlay') || svg;                                                      // 獨立的一層（見 css）；找不到就畫在地圖上
  let g = gid('navMarker');
  if (!g || g.parentNode !== layer) {
    if (g) g.remove();
    layer.insertAdjacentHTML('beforeend', '<g id="navMarker"><circle class="nm-acc" fill="#3b82f6" fill-opacity=".14" stroke="#3b82f6" stroke-opacity=".5"/><circle class="nm-next" r="9" fill="#fff" stroke="#f59e0b" stroke-width="4"/>'
      + '<circle class="nm-dot" r="8" fill="#2563eb" stroke="#fff" stroke-width="3"/><g class="nm-arrow"><polygon points="0,-15 11,11 0,5 -11,11" fill="#2563eb" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></g></g>');
    g = gid('navMarker'); if (!g || !g.querySelector) return;
  } else if (g !== layer.lastChild) layer.appendChild(g);                                     // 保持在最上層
  const q = c => g.querySelector('.' + c), set = (el, o) => { if (el) for (const k in o) el.setAttribute(k, o[k]); };
  const cam = State.cam; if (cam && cam.rot) g.setAttribute('transform', `rotate(${(-cam.rot).toFixed(2)} ${cam.cx.toFixed(1)} ${cam.cy.toFixed(1)})`); else g.removeAttribute && g.removeAttribute('transform');   // 與地圖同一個旋轉
  set(q('nm-acc'), { cx: sx.toFixed(1), cy: sy.toFixed(1), r: r.toFixed(1) });
  const ne = q('nm-next'); if (ne) { if (nx) { set(ne, { cx: nx[0].toFixed(1), cy: nx[1].toFixed(1) }); ne.removeAttribute('display'); } else ne.setAttribute('display', 'none'); }
  const dot = q('nm-dot'), arr = q('nm-arrow');
  if (hdg == null) { set(dot, { cx: sx.toFixed(1), cy: sy.toFixed(1) }); dot && dot.removeAttribute('display'); arr && arr.setAttribute('display', 'none'); }
  else { set(arr, { transform: `translate(${sx.toFixed(1)} ${sy.toFixed(1)}) rotate(${hdg.toFixed(1)})` }); arr && arr.removeAttribute('display'); dot && dot.setAttribute('display', 'none'); }
}

// 箭頭該在的位置：在路線上就吸附到路線，否則用定位點；方向用 GPS 行進方向，沒有就用路線方向
function markerTarget(n) {
  const st = n.state, fix = n.fix, onRoute = st && st.snapped && st.offsetM <= Math.max(30, 2 * fix.accuracy), [x, y] = onRoute ? st.snapped : lonLatToWorld(fix.lon, fix.lat);
  return { x, y, h: fix.heading ?? (st && st.bearing) ?? null };
}
// ---------- 平滑移動：GPS 約每秒一筆，箭頭與地圖在兩筆之間補間移動，不再一跳一跳 ----------
const FRAME_MS = 66, SHIFT_MS = 1000, now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const lerpAng = (a, b, t) => { if (a == null) return b; if (b == null) return a; const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };
function animateMarker() {
  const n = State.nav; if (!n || !n.fix) return;
  const to = markerTarget(n), from = n.disp || to, t = now(), gap = n.lastFixT ? t - n.lastFixT : 1000;
  n.lastFixT = t;
  // 跳太遠（例如重新定位、剛開始）就直接到位，不要畫出橫越地圖的動畫
  const far = Math.hypot((to.x - from.x) * mPerWorld(to.x, to.y), (to.y - from.y) * mPerWorld(to.x, to.y)) > 150;
  const still = Math.hypot((to.x - from.x) * mPerWorld(to.x, to.y), (to.y - from.y) * mPerWorld(to.x, to.y)) < 0.5 && Math.abs(((to.h ?? 0) - (from.h ?? 0) + 540) % 360 - 180) < 2;   // 停著不動：不必跑動畫
  n.anim = { from, to, t0: t, dur: far || still || !settings.smooth ? 0 : Math.min(1200, Math.max(250, gap * 0.95)) };
  kick();
}
function kick() {
  const n = State.nav; if (!n || n.raf) return;
  let sync = true;                                   // requestAnimationFrame 同步執行（測試環境）時直接跳到終點，避免遞迴
  n.raf = requestAnimationFrame(() => { n.raf = 0; frame(sync); }) || 0; sync = false;
}
function frame(sync) {
  const n = State.nav; if (!n || !n.disp && !n.anim) return;
  const A = n.anim || { from: n.disp, to: n.disp, t0: 0, dur: 0 }, T = now(), t = sync || !A.dur ? 1 : Math.min(1, (T - A.t0) / A.dur), e = t < 1 ? t * (2 - t) : 1;   // ease-out
  if (!sync && n.lastFrame && T - n.lastFrame < FRAME_MS) { kick(); return; }                  // 約 15 fps：夠平順，又不讓手機一直全速重繪（省電）
  n.lastFrame = T;
  n.disp = { x: A.from.x + (A.to.x - A.from.x) * e, y: A.from.y + (A.to.y - A.from.y) * e, h: lerpAng(A.from.h, A.to.h, e) };
  // 地圖每筆定位平移一次（只平移已畫好的畫面，不重畫）；箭頭在獨立的一層上連續移動——平移要重繪整張地圖，箭頭只重繪一小塊，手機上省很多電
  const camMoved = stepCamera(T, sync);
  if (n.follow && (t === 1 || camMoved || !n.lastShift || T - n.lastShift >= SHIFT_MS)) { n.lastShift = T; followToWorld(n.disp.x, n.disp.y); renderView(); } else drawNav();
  if (t < 1 || (n.cam && n.cam.busy && !sync)) kick(); else n.anim = null;
}

// ---------- 相機：方向、縮放、傾斜（每幀，約 15 fps）----------
// 回傳 true＝這一幀相機有明顯變化（需要更新地圖轉換）
function stepCamera(T, sync) {
  const n = State.nav; if (!n || !n.cam || !State.base) return false;
  const dt = sync || !n.camT ? 1 : Math.min(0.5, (T - n.camT) / 1000); n.camT = T;
  const st = n.state || {}, fix = n.fix || {}, w = svg.clientWidth || 1, h = svg.clientHeight || 1, next = st.next, after = st.after;
  const complex = !!(next && ((next.nodeIdx != null && uniqNbr(next.nodeIdx) >= 5) || (after && after.s - next.s < 120)));
  const spd = Number.isFinite(fix.speed) ? Math.max(0, fix.speed) : (st.eta && Number.isFinite(st.eta.vObs) ? st.eta.vObs : 0);   // 手機沒給速度時用引擎平滑後的實際速度
  const o = n.cam.step(dt, { speed: spd, heading: fix.heading ?? st.bearing ?? null, accuracy: fix.accuracy ?? 99,
    compass: n.compass ? n.compass.value : null, distToNext: st.distToNext ?? 1e9, next, complex, follow: n.follow, aspect: h / w });
  n.camOut = o;
  // 只在變化看得出來時才更新地圖（旋轉 ≥ 2°、錨點 ≥ 2 px、縮放 ≥ 1.5%；小變化累積 0.6 秒後再一次補上）：
  // 直線行駛時 GPS 方向的小抖動不會讓整個地圖每幀重新排版，轉彎時仍是每幀平順旋轉
  const prev = State.cam || { rot: 0, cx: 0, cy: 0 }, cx = w / 2, cyT = h * o.anchorY, late = sync || T - (n.camApplyT || 0) >= 600;
  const dRot = Math.abs(((o.rot - prev.rot + 540) % 360) - 180), dCy = Math.abs(cyT - prev.cy);
  const takeRot = dRot >= 2 || (late && dRot > 0.05), cy = dCy >= 2 || (late && dCy > 0.3) ? cyT : prev.cy;
  State.cam = { rot: takeRot ? o.rot : prev.rot, cx, cy, tilt: o.tilt };
  let moved = takeRot || cy !== prev.cy;
  if (n.follow) {                                                                                           // 自動縮放：只在跟隨時
    const tiltK = tiltScale(o.tilt, h * o.anchorY), [x, y] = n.disp ? [n.disp.x, n.disp.y] : lonLatToWorld(fix.lon, fix.lat), k = State.base.scale * State.base.kx / mPerWorld(x, y);
    const want = clampScale((w / (o.widthM * tiltK)) / k), dz = Math.abs(want / State.view.scale - 1);
    if (dz > 0.015 || (late && dz > 0.002)) { const sx = w / 2, sy = cy; State.view.tx = sx - (sx - State.view.tx) * (want / State.view.scale); State.view.ty = sy - (sy - State.view.ty) * (want / State.view.scale); State.view.scale = want; moved = true; }
    if (!n.cam.busy && n.zoomDirty) { n.zoomDirty = false; const d = State.drawnView; if (!d || Math.abs(Math.log(State.view.scale / d.scale)) > 0.3) State.renderFull = true; }   // 縮放停下來、且與上次完整重畫差超過 35%：重畫一次（線寬恢復正常）；小幅縮放只縮放場景
    if (moved) n.zoomDirty = true;
  }
  if (moved) n.camApplyT = T;
  applyTilt(o.tilt, cy / h);
  return moved;
}
// 傾斜：CSS 3D（perspective＋rotateX）套在地圖與箭頭兩層；放大 s 倍讓傾斜後的梯形蓋滿畫面，縮放時再除回去
const PERSP = 900;
// CSS 由右往左套用：先 scale(s)，再 rotateX，最後透視。畫面頂端（離轉軸 dTop）要蓋滿寬度與高度：
//   寬：s·P/(P + s·dTop·sin a) ≥ 1  →  s ≥ P/(P − dTop·sin a)；高：s·cos a·P/(P + s·dTop·sin a) ≥ 1  →  s ≥ P/(P·cos a − dTop·sin a)
function tiltScale(deg, dTop) { if (!deg) return 1; const a = deg * Math.PI / 180, sn = dTop * Math.sin(a), den = Math.max(PERSP * 0.25, Math.min(PERSP - sn, PERSP * Math.cos(a) - sn)); return Math.min(3, PERSP / den) * 1.01; }
function applyTilt(deg, anchorY) {
  // 只在角度變化 ≥ 2°（或到達 0／目標角）、錨點移動 ≥ 1% 時才改 CSS：每改一次都要重新排版整個地圖層
  const n = State.nav, v = deg > 0.3 ? Math.round(deg / 2) * 2 || 0 : 0, key = v * 1000 + Math.round(anchorY * 100); if (n && n.tiltApplied === key) return; if (n) n.tiltApplied = key;
  const s = v ? tiltScale(v, (svg.clientHeight || 0) * anchorY) : 1, css = v ? `perspective(${PERSP}px) rotateX(${v.toFixed(1)}deg) scale(${s.toFixed(3)})` : '';
  for (const el of [svg, gid('navOverlay')]) if (el && el.style) { el.style.transformOrigin = `50% ${(anchorY * 100).toFixed(1)}%`; el.style.transform = css; }
  State.pitchCss = v ? { deg: v, s, oy: (svg.clientHeight || 0) * anchorY } : null;            // 指標座標反投影、圖磚範圍用（map-view.js）
}
const uniqNbr = v => { const s = new Set(); for (let k = State.adjOffset[v]; k < State.adjOffset[v + 1]; k++) s.add(State.adjTo[k]); return s.size; };
// 使用者動了地圖：傾斜立刻放平（觸控／滑鼠座標換算才正確）
export function camInteract() { const n = State.nav; if (n && n.cam && n.cam.tilt) { n.cam.interact(); if (State.cam) State.cam.tilt = 0; n.tiltApplied = null; applyTilt(0, n.camOut ? n.camOut.anchorY : 0.62); } }

// ---------- 畫面更新 ----------
const arrowOf = st => !st ? '⬆' : st.turnType === 'arrive' ? '🏁' : st.turnType === 'waypoint' ? '📍' : st.turnType === 'ferry' ? '⛴' : st.turnType === 'uturn' ? '↩' : st.turnType === 'sharp' ? (st.dir === 'left' ? '↙' : '↘') : st.turnType === 'turn' ? (st.dir === 'left' ? '⬅' : '➡') : st.turnType === 'slight' ? (st.dir === 'left' ? '↖' : '↗') : '⬆';
const fmtLeft = s => { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`; };
function refreshUI() {
  const n = State.nav; if (!n) return; const s = n.state, e = n.engine;
  if (!s) return;
  const msg = e.status === 'offroute' ? '已偏離路線' : e.status === 'rerouting' ? '正在重新規劃路線…' : e.status === 'arrived' ? '已抵達目的地' : e.status === 'paused' ? '導航已暫停' : '';
  const gpsWait = !n.fix ? '等待 GPS 定位…' : '';
  // v1.12：自繪轉向圖示；距離轉彎很近時轉向卡放大（車 200 m、機車 150、自行車 80、步行 50）
  const ic = e.status === 'arrived' ? 't_arrive' : msg && e.status !== 'paused' ? 'warn' : turnIcon(s.next), ae = gid('navArrow');
  if (ae && ae.dataset && ae.dataset.ic !== ic) { ae.dataset.ic = ic; ae.innerHTML = icon(ic, 48); ae.setAttribute && ae.setAttribute('aria-label', s.next ? VoiceTemplates.action(s.next) : ''); }
  const near = { car: 200, heavy: 200, moto: 150, bike: 80, walk: 50 }[n.vk] || 200, nt = gid('navTop');
  if (nt && nt.classList) { nt.classList.toggle('imminent', !msg && !!s.next && s.distToNext <= near); nt.classList.toggle('alert', !!msg && e.status !== 'paused'); }
  setText('navDist', msg || gpsWait || (s.next ? (s.distToNext >= 1000 ? `${(s.distToNext / 1000).toFixed(1)} 公里` : `${Math.round(s.distToNext / 10) * 10 || 10} 公尺`) : '—'));
  setText('navRoad', msg || !s.next ? '' : s.next.turnType === 'arrive' ? '目的地' : s.next.turnType === 'waypoint' ? `途經點 ${s.next.wp || ''}${s.next.roadName ? '・' + s.next.roadName : ''}` : (s.next.roadName ? `進入 ${s.next.roadName}` : VoiceTemplates.action(s.next)));
  setText('navThen', !msg && s.after ? `接著：${VoiceTemplates.action(s.after)}${s.after.roadName ? '・' + s.after.roadName : ''}` : '');
  setText('navRem', fmtDist(s.remainingM)); refreshTime();
  setText('navPause', e.paused ? '▶ 繼續' : '⏸ 暫停');
}
// 每秒更新：剩餘時間（＝抵達時刻 − 現在）、不確定範圍、可信度、最後更新時間、定位異常
const CONF = { high: '高', medium: '中', low: '低' };
function refreshTime() {
  const n = State.nav; if (!n || !n.state) return; const s = n.state, e = s.eta || {}, now = Date.now(), left = Math.max(0, (s.etaMs - now) / 1000);
  setText('navEta', fmtClock(s.etaMs)); setText('navLeft', fmtLeft(left));
  const ago = e.updatedAt ? Math.max(0, Math.round((now - e.updatedAt) / 1000)) : null, gpsBad = e.stale || (n.gps && ['lost', 'unavailable'].includes(n.gps.status));
  const range = e.lowS != null && e.highS - e.lowS >= 60 ? `約 ${fmtLeft(e.lowS)}～${fmtLeft(e.highS)}` : '';
  setText('navNote', gpsBad ? `⚠ 定位異常：顯示 ${ago != null ? ago + ' 秒前' : '先前'}的估算` :
    `${range ? range + '・' : ''}可信度${CONF[e.confidence] || '—'}${ago != null ? `・${ago < 3 ? '剛剛' : ago + ' 秒前'}更新` : ''}・依速限與路口推估，未含即時路況`);
  const nt = gid('navNote'); if (nt && nt.dataset) nt.dataset.bad = gpsBad ? '1' : '';
}
function onGpsStatus({ status, text, detail }) {
  if (status === 'lost' && State.nav) State.nav.engine.markGpsLost();
  const chip = gid('gpsChip'); if (chip) { setText('gpsChip', text); chip.dataset.s = status; chip.title = detail || ''; }
  if (ann) ann.onGps(status);
  if (['denied', 'insecure', 'unsupported'].includes(status)) { const d = detail ? `（${detail}）` : ''; endNavigation(); showStatus(`❌ ${esc(text)}${esc(d)}。導航需要裝置定位（HTTPS 或 localhost）。`, 'error'); }
  refreshUI();
}
function toast(msg, ms = 4000) { const t = gid('navMsg'); if (!t) return; t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms); }

// ---------- 跟隨與縮放 ----------
const ZOOM_M = { car: 700, heavy: 700, moto: 600, bike: 350, walk: 220 };
function setNavZoom() {
  const n = State.nav, fix = n.fix, route = State.currentRoute; if (!State.base || !route) return;
  const [x, y] = fix ? lonLatToWorld(fix.lon, fix.lat) : route.coords[0], w = svg.clientWidth, want = ZOOM_M[n.vk] || 600, k = State.base.scale * State.base.kx / mPerWorld(x, y);
  State.view.scale = clampScale((w / want) / k);
}
function followTo(fix) { const [x, y] = lonLatToWorld(fix.lon, fix.lat); followToWorld(x, y); }
function followToWorld(x, y) {
  const [sx, sy] = worldToScreen(x, y);
  const h = svg.clientHeight, cy = State.cam && State.nav ? State.cam.cy : h * 0.62;                // 與目前套用中的旋轉中心一致
  State.view.tx += svg.clientWidth / 2 - sx; State.view.ty += cy - sy;
}
function orientLabel() { const b = gid('navOrient'); if (b) { b.textContent = settings.orient === 'heading' ? '🧭 車頭朝上' : '🧭 北朝上'; b.title = '切換地圖方向'; } }
export function stopFollow() { if (State.nav && State.nav.follow) { State.nav.follow = false; const b = gid('navRecenter'); if (b) b.hidden = false; } }

// ---------- 開始／結束 ----------
export function startNavigation() {
  if (State.nav) return;
  const route = State.currentRoute;
  if (!route || !(route.edgePath || route._osm) || getMode() === 'transit') { showStatus('請先規劃一條道路路線（大眾運輸不提供逐步 GPS 導航）', 'error'); return; }
  const vk0 = getVehicleKey(), vk = PROMPT_PROFILE[vk0] ? vk0 : 'car';
  // 語音必須在這個使用者操作內初始化（iOS Safari／Android Chrome 限制）
  voice = new VoiceEngine({ enabled: settings.voiceOn, rate: settings.rate, volume: settings.volume, onState: s => { if (s.ready === false) toast('語音無法使用：' + (s.reason || '')); else if (s.voiceFound === false) toast('這個裝置沒有中文語音，語音提示可能無聲或使用預設語音'); } });
  voice.init(); ann = new AnnouncementManager(voice, { profileKey: vk, scale: settings.promptScale });
  const gps = new GpsService(), engine = new NavigationEngine(), V = route._osm ? null : ensureVeh(vk0 === 'bus' ? 'car' : vk0);   // OSM 路線：每段時間由伺服器給（route._osm.timing），不需要本機路網的車種表
  State.nav = { engine, gps, voice, follow: true, fix: null, state: null, vk, first: true, rerouteBusy: false, planKey: ['shortest', 'pref'].includes(State.activeKey) ? State.activeKey : 'fastest' };   // 重新規劃沿用出發時選的路線種類
  for (const it of State.routeSet) it.visible = it.key === State.activeKey;                                // 導航中只顯示目前路線
  document.body.classList.add('navigating'); if (typeof CustomEvent !== 'undefined' && document.dispatchEvent) document.dispatchEvent(new CustomEvent('navstate', { detail: 'start' })); gid('navUI').hidden = false; gid('navRecenter').hidden = true; gid('navVoicePanel').hidden = true;
  engine.on((type, s) => { State.nav.state = engine.state; if (ann) ann.onNav(type, s); if (type === 'reroute-request') requestReroute(s.fix); if (type === 'arrived') toast('已抵達目的地'); if (type === 'step-passed' && s.passed && s.passed.turnType === 'waypoint') { State.viaDone = Math.max(State.viaDone || 0, s.passed.wp || (State.viaDone || 0) + 1); toast(`已抵達途經點 ${s.passed.wp || ''}${s.passed.roadName ? '：' + s.passed.roadName : ''}`); } if (State.nav && State.nav.trip && (type === 'arrived' || type === 'offroute' || type === 'back-on-route')) State.nav.trip.event(Date.now(), type); if (type !== 'update') scheduleRender(); refreshUI(); });
  const H = hist(), smoother = new EtaSmoother(), vkm = vk0 === 'bus' ? 'car' : vk0;
  State.nav.trip = new TripLog({ vehicle: vkm, routeM: Math.round(route.distance || 0) });
  State.nav.cam = new CameraController({ vk: vkm, mode: settings.orient, tilt: settings.tilt });
  if (settings.orient === 'heading') { State.nav.compass = new Compass(); State.nav.compass.start(); }                // 必須在按下「開始導航」的操作中要求權限（iOS）
  engine.start(route, generateManeuvers(route), V ? k => V.spd[k] / 3.6 : null, {
    model: (r, t, m) => new EtaModel(r, t, m, vkm, H), smoother,
    onEdge: (k, meters, sec, t) => { H.add(typeof k === 'string' ? k : State.adjEid[k], meters, sec, t); } });   // OSM 路線的 k 是 'osm:<way id>'
  State.nav.tick = setInterval(() => { refreshTime(); if (State.nav && State.nav.trip && State.nav.state) State.nav.trip.pred(Date.now(), State.nav.state); }, 1000);
  gps.on('status', onGpsStatus); gps.on('fix', onFix); gps.on('reject', r => { if (r === 'jump') toast('已忽略異常定位跳點', 2000); });
  drawRoute(route, true); setNavZoom(); scheduleRender(); refreshUI();
  if (!gps.start()) return;                                                                             // 失敗原因由 status 事件處理
  acquireWakeLock();
}
function onFix(fix) {
  const n = State.nav; if (!n) return; n.fix = fix; if (n.trip) n.trip.fix(fix); const s = n.engine.update(fix);
  if (n.first) { n.first = false; if (s && s.offsetM > 100 && n.engine.status === 'navigating') { toast('您不在路線上，從目前位置重新規劃'); requestReroute(fix); } setNavZoom(); }
  if (n.first === false && !n.zoomed) { n.zoomed = true; scheduleRender(); }                  // 第一次定位改了縮放：完整重畫一次
  animateMarker();                                                                           // 地圖跟隨與箭頭移動都在動畫裡做（只平移已畫好的畫面）
  refreshUI();
}
async function requestReroute(fix) {
  const n = State.nav; if (!n || n.rerouteBusy) return; n.rerouteBusy = true; n.engine.rerouting = true; if (n.engine.status === 'navigating') n.engine._status('rerouting'); refreshUI();
  try {
    await new Promise(r => setTimeout(r, 0));
    const r = State.currentRoute && State.currentRoute._osm ? await osmReroute(fix, n.planKey) : rerouteFromFix(fix);   // OSM 路線：伺服器從目前位置（含行進方向）重新規劃
    if (State.nav !== n) return;
    if (r.error) { toast(r.error); n.engine.rerouteFailed(); }
    else { n.reroutes = (n.reroutes || 0) + 1; if (n.trip) n.trip.event(Date.now(), 'rerouted'); State.currentRoute = r.route; State.routeSet = [r.item]; State.activeKey = r.item.key; n.engine.applyNewRoute(r.route, generateManeuvers(r.route)); drawRoute(r.route, false); }
  } catch (e) { console.error('重新規劃失敗', e); toast('重新規劃失敗'); if (State.nav === n) n.engine.rerouteFailed(); }
  finally { n.rerouteBusy = false; refreshUI(); }
}
export function endNavigation() {
  const n = State.nav; if (!n) return;
  n.engine.stop(); n.gps.stop(); if (voice) { voice.setEnabled(false); voice = null; } ann = null; releaseWakeLock();
  clearInterval(n.tick); if (n.compass) n.compass.stop(); if (edgeHist) edgeHist.save(); State.lastTrip = n.trip; State.cam = null; n.tiltApplied = null; applyTilt(0, 0.62);
  if (n.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(n.raf);
  State.nav = null; document.body.classList.remove('navigating'); if (typeof CustomEvent !== 'undefined' && document.dispatchEvent) document.dispatchEvent(new CustomEvent('navstate', { detail: 'end' })); gid('navUI').hidden = true; rm('navMarker'); applyBrowseCamera(); scheduleRender();   // 回到瀏覽模式的旋轉／3D 設定
}
async function acquireWakeLock() { try { if (navigator.wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); } } catch { /* 不支援或被拒：導航仍可進行，但螢幕可能自動關閉 */ } }
function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }

// ---------- 使用目前位置當起點（一次性定位；必須由使用者按鈕觸發）----------
export function useMyLocation() {
  if (!State.loaded && !osmOn()) { showStatus('請先載入路網', 'error'); return; }
  if (!navigator.geolocation) { showStatus('此瀏覽器不支援定位', 'error'); return; }
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) { showStatus('定位需要 HTTPS（或 localhost）', 'error'); return; }
  showStatus('正在取得目前位置…', 'loading');
  navigator.geolocation.getCurrentPosition(pos => {
    const c = pos.coords;
    if (osmOn()) {                                                                                  // 全台 OSM：直接用定位點，規劃時伺服器吸附到最近的可用道路
      const p = osmPoint(c.longitude, c.latitude, '目前位置'); setPoint(p, 'from'); osmNameFor(p, 'fromInfo');
      showStatus(`📍 已用目前位置當起點（定位精度約 ${Math.round(c.accuracy)} m）` + (c.accuracy > 100 ? '<br>⚠ 精度不佳，建議移到空曠處或到設定開啟「精確位置」' : ''), c.accuracy > 100 ? 'loading' : 'success'); scheduleRender(); return;
    }
    const [wx, wy] = lonLatToWorld(c.longitude, c.latitude), idx = findNearestNode(wx, wy);
    if (idx < 0) { showStatus('⚠ 目前位置附近找不到路網（可能不在路網範圍內）', 'error'); return; }
    const nx = State.nodeXY[idx*5+2], ny = State.nodeXY[idx*5+3], dm = worldDistM(wx, wy, nx, ny);
    if (dm > 500) { showStatus(`⚠ 目前位置離最近的路網節點 ${Math.round(dm)} m，已超出路網範圍`, 'error'); return; }
    setPoint({ idx, lon: nx, lat: ny, id: State.nodeIds[idx] + '（目前位置）' }, 'from');
    showStatus(`📍 已用目前位置當起點（定位精度約 ${Math.round(c.accuracy)} m，最近節點距離 ${Math.round(dm)} m）` + (c.accuracy > 100 ? '<br>⚠ 精度不佳，建議移到空曠處或到設定開啟「精確位置」' : ''), c.accuracy > 100 ? 'loading' : 'success');
  }, e => showStatus(e.code === 1 ? '❌ 定位權限被拒絕，請到瀏覽器／系統設定允許此網站使用定位' : '❌ 無法取得目前位置：' + esc(e.message || ''), 'error'), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

// ---------- 綁定 ----------
export function init() {
  if (bound) return; bound = true;
  // 診斷用（DevTools／自動化量測）：目前路線的經緯度、導航狀態。不影響功能。
  if (typeof window !== 'undefined') window.__nav = { routeLL: () => (State.currentRoute ? State.currentRoute.coords.map(([x, y]) => { const [lo, la] = worldToLonLat(x, y); return [la, lo]; }) : null), status: () => (State.nav ? State.nav.engine.status : 'idle'), reroutes: () => (State.nav ? State.nav.reroutes || 0 : 0), loadInfo: () => State.loadInfo || null, dbg: () => { const s = State.nav && State.nav.state; return s ? [Math.round(s.offsetM), s.heading == null ? 'h-' : Math.round(s.heading), s.bearing == null ? 'b-' : Math.round(s.bearing), s.speed == null ? 'v-' : s.speed.toFixed(1)].join('/') : ''; } };
  Object.assign(settings, { voiceOn: navStore.get('voiceOn', true), rate: navStore.get('rate', 1), volume: navStore.get('volume', 1), promptScale: navStore.get('promptScale', 1), smooth: navStore.get('smooth', true), orient: navStore.get('orient', 'heading'), tilt: navStore.get('tilt', true) });
  gid('vOn').checked = settings.voiceOn; gid('vRate').value = settings.rate; gid('vVol').value = settings.volume; gid('vDist').value = String(settings.promptScale); if (gid('navSmooth')) gid('navSmooth').checked = settings.smooth; if (gid('navTilt')) gid('navTilt').checked = settings.tilt; orientLabel();
  gid('startNav').addEventListener('click', startNavigation);
  const nm = gid('navMore'); if (nm && nm.addEventListener) nm.addEventListener('click', () => { const b = gid('navBottom'); if (b && b.classList) { const v = b.classList.toggle('show-more'); nm.setAttribute('aria-expanded', String(v)); } });
  gid('myLoc').addEventListener('click', useMyLocation);
  gid('navEnd').addEventListener('click', endNavigation);
  gid('navPause').addEventListener('click', () => { const n = State.nav; if (!n) return; if (n.engine.paused) { n.engine.resume(); } else { n.engine.pause(); if (voice) voice._cancel(); } refreshUI(); });
  gid('navRepeat').addEventListener('click', () => { if (voice && !voice.repeat()) toast('目前沒有可重複的提示'); });
  gid('navVoiceBtn').addEventListener('click', () => { const p = gid('navVoicePanel'); p.hidden = !p.hidden; });
  if (gid('navOrient')) gid('navOrient').addEventListener('click', async () => {                     // 北朝上 ↔ 車頭朝上
    settings.orient = settings.orient === 'heading' ? 'north' : 'heading'; navStore.set('orient', settings.orient); orientLabel();
    const n = State.nav; if (n && n.cam) { n.cam.setMode(settings.orient); if (settings.orient === 'heading' && !n.compass) { n.compass = new Compass(); n.compass.start(); } kick(); }
  });
  if (gid('navLog')) gid('navLog').addEventListener('click', () => {                                     // 下載行程紀錄（給 tools/eta-eval.mjs 計算真實誤差）
    const t = State.nav ? State.nav.trip : State.lastTrip; if (!t) { toast('目前沒有行程紀錄'); return; }
    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(t.toJSON())], { type: 'application/json' })); a.download = `trip-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); } catch (e) { toast('無法下載：' + e.message); }
  });
  gid('navRecenter').addEventListener('click', () => { const n = State.nav; if (!n) return; n.follow = true; gid('navRecenter').hidden = true; if (n.disp) followToWorld(n.disp.x, n.disp.y); else if (n.fix) followTo(n.fix); setNavZoom(); scheduleRender(); });
  const upd = () => { settings.voiceOn = gid('vOn').checked; settings.rate = +gid('vRate').value; settings.volume = +gid('vVol').value; settings.promptScale = +gid('vDist').value; if (gid('navSmooth')) settings.smooth = gid('navSmooth').checked; if (gid('navTilt')) { settings.tilt = gid('navTilt').checked; if (State.nav && State.nav.cam) State.nav.cam.tiltOn = settings.tilt; } for (const k of Object.keys(settings)) navStore.set(k, settings[k]);
    if (voice) { voice.setEnabled(settings.voiceOn); voice.setRate(settings.rate); voice.setVolume(settings.volume); } if (ann) ann.setProfile(State.nav ? State.nav.vk : 'car', settings.promptScale); };
  for (const id of ['vOn', 'vRate', 'vVol', 'vDist', 'navSmooth', 'navTilt']) if (gid(id)) gid(id).addEventListener('change', upd);
  gid('vTest').addEventListener('click', () => { if (voice) voice.speak({ text: '語音測試，前方兩百公尺，右轉，進入中港路', priority: 2, key: 'test:' + Date.now(), force: true }); else toast('開始導航後才能測試語音（瀏覽器要求在操作中啟用語音）'); });
  document.addEventListener('visibilitychange', () => {
    const n = State.nav; if (!n) return;
    if (document.visibilityState === 'visible') { acquireWakeLock(); toast('網頁回到前景。網頁在背景時，瀏覽器可能暫停定位與語音', 5000); }
  });
}
