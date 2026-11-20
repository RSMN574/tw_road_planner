// map-view.js — 地圖視角控制（v1.11）：縮放上下限、平滑縮放、拖曳慣性、旋轉、俯仰（2D／3D）、縮放層級顯示、3D 下的指標座標換算
//
// 為什麼要這個模組：v1.10 以前的縮放限制寫死成「相對於畫面一開始的倍率」（滾輪 ×20、雙指 ×60、導航 ×60），
// 起始畫面是全台灣時，×20 只到約 25 m／像素（約等於網頁地圖 z12），根本看不到街道與路口。
// 現在改用「每像素幾公尺」換算成與一般網頁地圖相同的縮放層級（256 像素圖磚的 z），上下限依資料而定：
//   ・下限 z5：全台灣＋離島一個畫面放得下
//   ・上限 z21（約 0.07 m／像素，畫面 1000 像素寬約 70 m）：路網是向量（OSM 幾何），伺服器圖磚最高抓 z18（512 像素圖磚＝這裡的 z19），
//     z18 圖磚的座標量化約 3.4 cm、簡化容許誤差約 0.14 m，放到 z21 時誤差仍 ≤ 2 像素，不會因為放大而模糊；超過 z19 是「向量放大（overzoom）」不再抓更細的圖磚
//   ・本機路網（TWD97）也用同一套層級
// 3D：地圖平面用 CSS perspective＋rotateX（GPU 合成，畫面不重畫）；指標（滑鼠、手指）座標用反投影換回平面座標，所以傾斜時點選、拖曳、縮放都正確
import { State } from './state.js';
import { svg } from './dom.js';
import { isGeo, worldDistM, worldToLonLat } from './geo.js';
import { panBy, scheduleRender, screenToWorld, unrotate, zoomAt } from './render-core.js';

export const ZOOM = { min: 5, max: 21, tileMax512: 18 };
export const PITCH = { max: 55, step: 15, persp: 900 };
const EARTH_MPP0 = 156543.03392;                                   // z0、256 像素圖磚、赤道的每像素公尺數

// ---------- 縮放層級 ----------
const wrap = () => svg && svg.parentElement;
export const viewSize = () => ({ w: (svg && svg.clientWidth) || 800, h: (svg && svg.clientHeight) || 600 });
// 世界座標 1 單位是幾公尺（經緯度：經度方向；TWD97：projUnit）
export const mvMPerWorld = (x, y) => isGeo() ? worldDistM(x, y, x + 1e-4, y) / 1e-4 : State.projUnit;
// 畫面中心的每像素公尺數
export function metersPerPixel(scale = State.view.scale) {
  if (!State.base) return NaN;
  const { w, h } = viewSize(), [x, y] = screenToWorld(w / 2, h / 2);
  return mvMPerWorld(x, y) / (State.base.scale * State.base.kx * scale);
}
const latAtCenter = () => { const { w, h } = viewSize(), [x, y] = screenToWorld(w / 2, h / 2), ll = worldToLonLat(x, y); return Number.isFinite(ll[1]) ? ll[1] : 23.7; };
export function zoomOfMpp(mpp, lat = latAtCenter()) { return Math.log2(EARTH_MPP0 * Math.cos(lat * Math.PI / 180) / mpp); }
export function currentZoom() { const m = metersPerPixel(); return Number.isFinite(m) ? zoomOfMpp(m) : NaN; }
// 縮放層級 z → State.view.scale
export function scaleForZoom(z) { const m = metersPerPixel(1); if (!Number.isFinite(m)) return 1; const want = EARTH_MPP0 * Math.cos(latAtCenter() * Math.PI / 180) / 2 ** z; return m / want; }
// 把 view.scale 限制在上下限內（所有縮放：滾輪、雙指、按鈕、導航自動縮放都經過這裡）
export function clampScale(s) {
  const m1 = metersPerPixel(1); if (!Number.isFinite(m1) || !(s > 0)) return s;
  const lat = latAtCenter(), lo = scaleForZoomAt(ZOOM.min, m1, lat), hi = scaleForZoomAt(ZOOM.max, m1, lat);
  return Math.min(hi, Math.max(lo, s));
}
const scaleForZoomAt = (z, m1, lat) => m1 / (EARTH_MPP0 * Math.cos(lat * Math.PI / 180) / 2 ** z);
export const zoomLimitInfo = () => ({ ...ZOOM, note: '向量路網；z19 以上沿用 z18（512 像素）圖磚放大' });

// ---------- 3D 俯仰：CSS perspective(P) rotateX(a) scale(s)，轉軸在 (50%, anchorY) ----------
// State.pitchCss = { deg, s, oy }：目前套用在地圖層的傾斜（瀏覽模式由這裡設定，導航模式由 nav-ui 設定）
// 平面座標 (u,v)（相對轉軸）→ 螢幕：X = s·u·P/(P − s·v·sin a)、Y = s·v·cos a·P/(P − s·v·sin a)
export function pitchScale(deg, dTop) { if (!deg) return 1; const a = deg * Math.PI / 180, sn = dTop * Math.sin(a), P = PITCH.persp, den = Math.max(P * 0.25, Math.min(P - sn, P * Math.cos(a) - sn)); return Math.min(3, P / den) * 1.01; }
export function toFlat(sx, sy) {                                    // 螢幕（地圖容器內）→ 地圖平面（svg 內、未傾斜時的座標）
  const pc = State.pitchCss; if (!pc || !pc.deg) return [sx, sy];
  const { w } = viewSize(), a = pc.deg * Math.PI / 180, P = PITCH.persp, X = sx - w / 2, Y = sy - pc.oy, s = pc.s;
  const den = s * (P * Math.cos(a) + Y * Math.sin(a)); if (den <= 1e-6) return [NaN, NaN];             // 地平線以上：不在地面上
  const v = Y * P / den, u = X * (P - s * v * Math.sin(a)) / (s * P);
  return [w / 2 + u, pc.oy + v];
}
export function fromFlat(fx, fy) {                                  // 地圖平面 → 螢幕
  const pc = State.pitchCss; if (!pc || !pc.deg) return [fx, fy];
  const { w } = viewSize(), a = pc.deg * Math.PI / 180, P = PITCH.persp, u = fx - w / 2, v = fy - pc.oy, s = pc.s, k = P / (P - s * v * Math.sin(a));
  return [w / 2 + s * u * k, pc.oy + s * v * Math.cos(a) * k];
}
// 滑鼠／觸控的 client 座標 → 地圖平面座標（用容器的位置；svg 本身傾斜後的 getBoundingClientRect 不是原本的框）
export function pointerToMap(clientX, clientY) { const el = wrap() || svg, r = el.getBoundingClientRect(); return toFlat(clientX - r.left, clientY - r.top); }
// 目前看得到的地面範圍（平面座標的四邊形；傾斜時上緣會延伸到畫面外）——圖磚用
export function visibleFlatQuad(padK = 0) {
  const { w, h } = viewSize(), px = w * padK, py = h * padK, pc = State.pitchCss;
  let top = -py; if (pc && pc.deg) { const t = toFlat(w / 2, 0)[1]; top = Number.isFinite(t) ? Math.max(t - py, -h * 4) : -h * 4; }
  const tl = pc && pc.deg ? toFlat(0, 0) : [-px, top], tr = pc && pc.deg ? toFlat(w, 0) : [w + px, top];
  const sp = (q, dx) => Number.isFinite(q[0]) ? [q[0] + dx, Math.max(q[1] - py, -h * 4)] : [dx < 0 ? -w * 2 : w * 3, -h * 4];
  return [sp(tl, -px), sp(tr, px), [w + px, h + py], [-px, h + py]];
}
// 瀏覽模式（非導航）的旋轉與俯仰
const browse = { rot: 0, pitch: 0 };
export const browseState = () => ({ ...browse });
export function applyBrowseCamera() {
  if (State.nav && State.nav.active !== false && State.nav.engine) return;                      // 導航中由 nav-ui 的相機控制
  const { w, h } = viewSize();
  State.cam = browse.rot || browse.pitch ? { rot: browse.rot, cx: w / 2, cy: h / 2, tilt: browse.pitch } : null;
  setPitchCss(browse.pitch, 0.5);
  syncMapUi();
}
export function setPitchCss(deg, anchorY) {
  const { h } = viewSize(), v = deg > 0.3 ? deg : 0, s = v ? pitchScale(v, h * anchorY) : 1;
  State.pitchCss = v ? { deg: v, s, oy: h * anchorY } : null;
  const css = v ? `perspective(${PITCH.persp}px) rotateX(${v.toFixed(1)}deg) scale(${s.toFixed(3)})` : '';
  for (const el of [svg, document.getElementById('navOverlay')]) if (el && el.style) { el.style.transformOrigin = `50% ${(anchorY * 100).toFixed(1)}%`; el.style.transform = css; }
}
export function rotateBy(deg) { browse.rot = ((browse.rot + deg) % 360 + 360) % 360; applyBrowseCamera(); scheduleRender(); }
export function resetNorth() { browse.rot = 0; applyBrowseCamera(); scheduleRender(); }
export function setPitch(deg) { browse.pitch = Math.max(0, Math.min(PITCH.max, deg)); applyBrowseCamera(); scheduleRender(); }
export const togglePitch = () => setPitch(browse.pitch > 0 ? 0 : 45);

// ---------- 平滑縮放（滾輪、按鈕、鍵盤）----------
let zAnim = null, inertia = null;
export function stopAnimations() { if (zAnim) { cancelAnimationFrame(zAnim.raf); zAnim = null; } if (inertia) { cancelAnimationFrame(inertia.raf); inertia = null; } }
// 以 (fx, fy)（平面座標）為中心，往目標縮放層級平滑移動；連續滾動會累加目標
export function zoomToward(dz, fx, fy, { tau = 110 } = {}) {
  if (!State.base) return;
  if (inertia) { cancelAnimationFrame(inertia.raf); inertia = null; }
  const cur = State.view.scale, base = zAnim ? zAnim.target : cur, target = clampScale(base * 2 ** dz);
  if (zAnim) { zAnim.target = target; zAnim.fx = fx; zAnim.fy = fy; return; }
  zAnim = { target, fx, fy, t: performance.now(), raf: 0 };
  // requestAnimationFrame 若是同步呼叫（測試替身、或背景分頁的某些實作）：第二層直接跳到目標，不會無窮遞迴
  let inStep = false;
  const step = T => {
    const A = zAnim; if (!A) return; const now = typeof T === 'number' ? T : performance.now(), dt = Math.max(0, Math.min(64, now - A.t)); A.t = now; A.n = (A.n || 0) + 1;
    if (inStep || A.n > 240) { zoomAt(A.fx, A.fy, A.target / State.view.scale); zAnim = null; scheduleRender(); syncMapUi(); return; }
    inStep = true; try {
    const s = State.view.scale, k0 = A.target / s, k = Math.abs(Math.log(k0)) < 0.002 ? k0 : Math.exp(Math.log(k0) * (1 - Math.exp(-dt / tau)));
    zoomAt(...rotBack(A.fx, A.fy), k);
    if (Math.abs(Math.log(A.target / State.view.scale)) < 0.002) { zAnim = null; scheduleRender(); syncMapUi(); return; }
    scheduleRender({ viewOnly: true }); syncMapUi(); A.raf = requestAnimationFrame(step);
    } finally { inStep = false; }
  };
  zAnim.raf = requestAnimationFrame(step);
}
// zoomAt 自己會處理旋轉（unrotate），這裡傳入的是平面座標，原樣交給它
const rotBack = (fx, fy) => [fx, fy];
export function zoomInstant(k, fx, fy) { const s2 = clampScale(State.view.scale * k); zoomAt(fx, fy, s2 / State.view.scale); syncMapUi(); }

// ---------- 拖曳慣性 ----------
// 記錄最後 100 ms 的位置，放開時速度夠快就繼續滑動，摩擦力讓它在約 0.3 秒的時間常數內停下
export class PanTracker {
  constructor() { this.pts = []; }
  reset() { this.pts = []; }
  add(x, y, t = performance.now()) { this.pts.push([x, y, t]); while (this.pts.length > 2 && t - this.pts[0][2] > 100) this.pts.shift(); }
  velocity() { const p = this.pts; if (p.length < 2) return [0, 0]; const a = p[0], b = p[p.length - 1], dt = b[2] - a[2]; return dt > 8 ? [(b[0] - a[0]) / dt, (b[1] - a[1]) / dt] : [0, 0]; }
}
export function startInertia(vx, vy, onStop) {
  const sp = Math.hypot(vx, vy); if (sp < 0.25) { if (onStop) onStop(); return false; }      // 每毫秒 0.25 像素以下不滑
  const k = Math.min(1, 3 / sp); vx *= k; vy *= k;                                        // 最快每毫秒 3 像素
  inertia = { vx, vy, t: performance.now(), raf: 0 };
  let inStep = false;
  const step = T => {
    const I = inertia; if (!I) return; if (inStep) { inertia = null; scheduleRender(); if (onStop) onStop(); return; }   // 同步的 rAF：不做慣性
    const now = typeof T === 'number' ? T : performance.now(), dt = Math.max(0, Math.min(48, now - I.t)); I.t = now; inStep = true; try {
    panBy(I.vx * dt, I.vy * dt); const f = Math.exp(-dt / 325); I.vx *= f; I.vy *= f;
    if (Math.hypot(I.vx, I.vy) < 0.02) { inertia = null; scheduleRender(); if (onStop) onStop(); return; }
    scheduleRender({ viewOnly: true }); I.raf = requestAnimationFrame(step);
    } finally { inStep = false; }
  };
  inertia.raf = requestAnimationFrame(step); return true;
}

// ---------- 地圖控制列（縮放層級、比例尺、指北針、2D／3D）----------
const nice = m => { const p = 10 ** Math.floor(Math.log10(m)), d = m / p; return (d >= 5 ? 5 : d >= 2 ? 2 : 1) * p; };
export function syncMapUi() {
  const el = document.getElementById('mapCtl'); if (!el || !State.base) return;
  const z = currentZoom(), m = metersPerPixel(), zl = document.getElementById('mapZoom');
  if (zl) zl.textContent = Number.isFinite(z) ? `z${z.toFixed(1)}` : '—';
  const zi = document.getElementById('mapZoomIn'), zo = document.getElementById('mapZoomOut');
  if (zi) zi.disabled = z >= ZOOM.max - 0.01; if (zo) zo.disabled = z <= ZOOM.min + 0.01;
  const sb = document.getElementById('mapScale');
  if (sb && Number.isFinite(m)) { const L = nice(m * 90), px = L / m; sb.style.width = `${Math.round(px)}px`; sb.textContent = L >= 1000 ? `${L / 1000} km` : `${L} m`; }
  const nb = document.getElementById('mapNorth'), rot = State.cam && State.cam.rot ? State.cam.rot : 0;
  if (nb && nb.style && nb.style.setProperty) { nb.style.setProperty('--rot', `${-rot}deg`); nb.title = rot ? `目前旋轉 ${Math.round(rot)}°，點一下回到北朝上` : '北朝上'; }
  const pb = document.getElementById('mapPitch'); if (pb) { pb.textContent = browse.pitch > 0 ? '2D' : '3D'; if (pb.setAttribute) pb.setAttribute('aria-pressed', browse.pitch > 0 ? 'true' : 'false'); }
  const hint = document.getElementById('mapZoomHint');
  if (hint) hint.hidden = !(Number.isFinite(z) && z > ZOOM.tileMax512 + 1.05);
}
export function init() {
  const c = document.getElementById('mapCtl'); if (!c) return;
  const center = () => { const { w, h } = viewSize(); return [w / 2, h / 2]; };
  c.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('button'); if (!b) return;
    if (b.id === 'mapZoomIn') zoomToward(1, ...center());
    else if (b.id === 'mapZoomOut') zoomToward(-1, ...center());
    else if (b.id === 'mapNorth') resetNorth();
    else if (b.id === 'mapPitch') togglePitch();
    else if (b.id === 'mapRotL') rotateBy(-15);
    else if (b.id === 'mapRotR') rotateBy(15);
  });
  window.addEventListener('keydown', e => {
    if (!State.base || /^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) return;
    if (e.key === '+' || e.key === '=') zoomToward(1, ...center()); else if (e.key === '-' || e.key === '_') zoomToward(-1, ...center()); else return;
    e.preventDefault();
  });
  syncMapUi();
}
// 測試／除錯
export function viewDebug() { return { zoom: currentZoom(), mpp: metersPerPixel(), rot: State.cam ? State.cam.rot : 0, pitch: State.pitchCss ? State.pitchCss.deg : 0, limits: { ...ZOOM } }; }

