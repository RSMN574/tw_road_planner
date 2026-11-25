// render-layers.js — 路線的附屬圖層：其他候選路線、轉向箭頭（v1.18：舊路網的公車、YouBike、路寬、周邊道路、站點建議圖層已移除）
import { Hooks, State } from './state.js';
import { svg } from './dom.js';
import { generateManeuvers } from './analysis.js';
import { pathDOf, worldToScreen } from './render-core.js';

export function drawOtherRoutes(main) {
  const NS = 'http://www.w3.org/2000/svg';
  for (const it of State.routeSet) {
    if (!it.visible || !it.route || it.route === main) continue;
    const pth = document.createElementNS(NS, 'path');
    pth.setAttribute('d', pathDOf(it.route.coords)); pth.setAttribute('fill', 'none');
    pth.setAttribute('class', 'alt-route'); pth.setAttribute('data-key', it.key); pth.setAttribute('stroke', it.color); pth.setAttribute('stroke-width', '5'); if (it.route._dash) pth.setAttribute('stroke-dasharray', it.route._dash); pth.setAttribute('opacity', '0.85');
    pth.setAttribute('stroke-linecap', 'round'); pth.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pth);
  }
}

export function drawArrows(route) {
  if (!route._man) route._man = generateManeuvers(route);
  const NS = 'http://www.w3.org/2000/svg', c = route.coords;
  for (const s of route._man) {
    if (!c[s.index]) continue;
    const [x, y] = worldToScreen(c[s.index][0], c[s.index][1]);
    if (s.index === State.selStep) {                                    // 清單選中 → 節點加圈高亮
      const ring = document.createElementNS(NS, 'circle');
      ring.setAttribute('cx', x); ring.setAttribute('cy', y); ring.setAttribute('r', '15');
      ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#f59e0b'); ring.setAttribute('stroke-width', '3');
      svg.appendChild(ring);
    }
    if (s.turnType === 'start' || s.turnType === 'arrive' || s.turnType === 'waypoint' || !c[s.index + 1]) continue;
    const [x2, y2] = worldToScreen(c[s.index+1][0], c[s.index+1][1]);   // 方向 = v2（以螢幕向量計算，自動處理 y 翻轉與 cos）
    const L = Math.hypot(x2 - x, y2 - y) || 1, ux = (x2 - x) / L, uy = (y2 - y) / L, px = -uy, py = ux;
    const t = document.createElementNS(NS, 'path');
    t.setAttribute('d', `M${x+ux*11},${y+uy*11}L${x-ux*5+px*7},${y-uy*5+py*7}L${x-ux*5-px*7},${y-uy*5-py*7}Z`);
    t.setAttribute('fill', Hooks.stepColor(s)); t.setAttribute('stroke', 'white'); t.setAttribute('stroke-width', '1.5');
    svg.appendChild(t);
  }
}
