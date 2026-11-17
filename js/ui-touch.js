// ui-touch.js — 觸控：單指平移、雙指縮放（點一下仍走原本的選點流程）
import { State } from './state.js';
import { svg } from './dom.js';
import { scheduleRender } from './render-core.js';
import { stopFollow } from './nav-ui.js';

export function init() {
  let mode = null, a = null, d0 = 0, s0 = 1;
  const pt = t => ({ x: t.clientX, y: t.clientY }), dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  svg.addEventListener('touchstart', e => {
    if (!State.base) return;
    if (e.touches.length === 1) { mode = 'pan'; a = pt(e.touches[0]); a.moved = false; }
    else if (e.touches.length === 2) { mode = 'pinch'; d0 = dist(pt(e.touches[0]), pt(e.touches[1])); s0 = State.view.scale; }
  }, { passive: true });
  svg.addEventListener('touchmove', e => {
    if (!State.base || !mode) return;
    if (mode === 'pan' && e.touches.length === 1) {
      const p = pt(e.touches[0]); if (!a.moved && dist(p, a) < 6) return; a.moved = true; e.preventDefault();      // 移動超過 6px 才算拖曳，輕點仍是選點
      State.view.tx += p.x - a.x; State.view.ty += p.y - a.y; a.x = p.x; a.y = p.y; stopFollow(); scheduleRender({ viewOnly: true });
    } else if (mode === 'pinch' && e.touches.length === 2) {
      e.preventDefault(); const p = pt(e.touches[0]), q = pt(e.touches[1]), r = svg.getBoundingClientRect(), mx = (p.x + q.x) / 2 - r.left, my = (p.y + q.y) / 2 - r.top;
      const s2 = Math.min(60, Math.max(0.2, s0 * dist(p, q) / d0)), k = s2 / State.view.scale;
      State.view.tx = mx - (mx - State.view.tx) * k; State.view.ty = my - (my - State.view.ty) * k; State.view.scale = s2; stopFollow(); scheduleRender({ viewOnly: true });
    }
  }, { passive: false });
  // 手勢結束：完整重畫一次（補上畫面外的路網、線寬恢復）
  svg.addEventListener('touchend', e => {
    if (e.touches.length === 0) { if (mode === 'pinch' || (mode === 'pan' && a && a.moved)) scheduleRender(); mode = null; }
    else if (e.touches.length === 1) { mode = 'pan'; a = pt(e.touches[0]); a.moved = true; }
  }, { passive: true });
  svg.addEventListener('touchcancel', () => { if (mode) scheduleRender(); mode = null; }, { passive: true });
}
