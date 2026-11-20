// ui-touch.js — 觸控：單指平移（放開有慣性）、雙指縮放＋旋轉（點一下仍走原本的選點流程）
// v1.11：座標經 pointerToMap（3D 傾斜時反投影回地圖平面）；縮放上下限依每像素公尺數（map-view.clampScale）；
//        雙指旋轉超過 8° 才開始旋轉（避免縮放時不小心轉動），導航中不旋轉（方向由導航相機決定）
import { State } from './state.js';
import { svg } from './dom.js';
import { panBy, scheduleRender, zoomAt } from './render-core.js';
import { camInteract, stopFollow } from './nav-ui.js';
import { PanTracker, browseState, clampScale, pointerToMap, rotateBy, startInertia, stopAnimations, syncMapUi } from './map-view.js';

export function init() {
  let mode = null, a = null, d0 = 0, s0 = 1, ang0 = 0, rotOn = false, lastAng = 0; const track = new PanTracker();
  const pt = t => { const [x, y] = pointerToMap(t.clientX, t.clientY); return { x, y, cx: t.clientX, cy: t.clientY }; }, dist = (p, q) => Math.hypot(p.cx - q.cx, p.cy - q.cy);
  const angle = (p, q) => Math.atan2(q.cy - p.cy, q.cx - p.cx) * 180 / Math.PI;
  const navigating = () => !!(State.nav && State.nav.engine);
  svg.addEventListener('touchstart', e => {
    if (!State.base) return;
    stopAnimations(); camInteract();                                                      // 導航傾斜中：先把視角放平（瀏覽模式的 3D 不必，座標會反投影）
    if (e.touches.length === 1) { mode = 'pan'; a = pt(e.touches[0]); a.moved = false; track.reset(); track.add(a.x, a.y); }
    else if (e.touches.length === 2) { const p = pt(e.touches[0]), q = pt(e.touches[1]); mode = 'pinch'; d0 = dist(p, q); s0 = State.view.scale; ang0 = lastAng = angle(p, q); rotOn = false; }
  }, { passive: true });
  svg.addEventListener('touchmove', e => {
    if (!State.base || !mode) return;
    if (mode === 'pan' && e.touches.length === 1) {
      const p = pt(e.touches[0]); if (!a.moved && Math.hypot(p.cx - a.cx, p.cy - a.cy) < 6) return; a.moved = true; e.preventDefault();      // 移動超過 6px 才算拖曳，輕點仍是選點
      if (Number.isFinite(p.x) && Number.isFinite(a.x)) panBy(p.x - a.x, p.y - a.y);
      a.x = p.x; a.y = p.y; a.cx = p.cx; a.cy = p.cy; track.add(p.x, p.y); stopFollow(); scheduleRender({ viewOnly: true });
    } else if (mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault(); const p = pt(e.touches[0]), q = pt(e.touches[1]), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      if (!Number.isFinite(mx)) return;
      const s2 = clampScale(s0 * dist(p, q) / d0), k = s2 / State.view.scale;
      zoomAt(mx, my, k); stopFollow();
      const an = angle(p, q);
      if (!navigating()) {
        if (!rotOn && Math.abs(((an - ang0 + 540) % 360) - 180) > 8) { rotOn = true; lastAng = an; }
        if (rotOn) { const d = ((an - lastAng + 540) % 360) - 180; if (Math.abs(d) > 0.3) { rotateBy(d); lastAng = an; } }
      }
      scheduleRender({ viewOnly: true }); syncMapUi();
    }
  }, { passive: false });
  // 手勢結束：單指拖曳有速度就慣性滑動；否則完整重畫一次（補上畫面外的路網、線寬恢復）
  svg.addEventListener('touchend', e => {
    if (e.touches.length === 0) {
      if (mode === 'pan' && a && a.moved) { const [vx, vy] = track.velocity(); if (!startInertia(vx, vy, syncMapUi)) scheduleRender(); }
      else if (mode === 'pinch') { scheduleRender(); syncMapUi(); }
      mode = null;
    } else if (e.touches.length === 1) { mode = 'pan'; a = pt(e.touches[0]); a.moved = true; track.reset(); track.add(a.x, a.y); }
  }, { passive: true });
  svg.addEventListener('touchcancel', () => { if (mode) scheduleRender(); mode = null; }, { passive: true });
  void browseState;
}
