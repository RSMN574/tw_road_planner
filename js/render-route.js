// render-route.js — 畫目前路線（v1.18：只有伺服器的全台 OSM 路線）
import { Hooks, State } from './state.js';
import { segSpeedText } from './vehicle.js';
import { svg } from './dom.js';
import { segmentsOf } from './analysis.js';
import { allCoords, drawGrid, drawMarkers, fitBase, labelBBox, pathDOf, placeLabels, resetView, worldToScreen } from './render-core.js';
import { drawArrows, drawOtherRoutes } from './render-layers.js';

export function drawRoute(route, refit = true) {
  const coords = route.coords;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of allCoords(route)) {
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  State.currentRoute = route;
  if (refit) { fitBase(minLon, maxLon, minLat, maxLat, 60); resetView(); }
  const project = worldToScreen, NS = 'http://www.w3.org/2000/svg';

  drawGrid();
  drawOtherRoutes(route);

  let pathD = '';
  for (let i = 0; i < coords.length; i++) { const [x, y] = project(coords[i][0], coords[i][1]); pathD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1); }
  const halo = document.createElementNS(NS, 'path');
  halo.setAttribute('d', pathD); halo.setAttribute('fill', 'none'); halo.setAttribute('stroke', route._color || '#fbbf24'); halo.setAttribute('stroke-width', '12');
  halo.setAttribute('stroke-linecap', 'round'); halo.setAttribute('stroke-linejoin', 'round'); halo.setAttribute('opacity', '0.25');
  svg.appendChild(halo);

  const segs = segmentsOf(route);
  for (const sg of segs) {                                       // 依道路分段；無路名的段 data-road 為空
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', pathDOf(route.coords.slice(sg.start, sg.end + 1)));
    el.setAttribute('class', 'route-seg'); el.setAttribute('data-road', sg.name); el.setAttribute('data-len', Math.round(sg.len)); el.setAttribute('data-spd', segSpeedText(route, sg));
    el.setAttribute('stroke', route._color || '#f59e0b'); if (route._dash) el.setAttribute('stroke-dasharray', route._dash);
    svg.appendChild(el);
  }

  const end = (i, color, label) => {
    const [x, y] = project(coords[i][0], coords[i][1]), c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '9'); c.setAttribute('fill', 'white'); c.setAttribute('stroke', color); c.setAttribute('stroke-width', '3'); svg.appendChild(c);
    const t = document.createElementNS(NS, 'text'); t.setAttribute('x', x + 14); t.setAttribute('y', y + 5); t.setAttribute('font-size', '12'); t.setAttribute('fill', color); t.setAttribute('font-weight', 'bold'); t.textContent = label; svg.appendChild(t);
  };
  end(0, '#3b82f6', '起點'); end(coords.length - 1, '#ef4444', '終點');
  drawMarkers();
  drawArrows(route);

  // 路名標注：每段道路取中點，長段優先、互不重疊
  const cands = [];
  for (const s of segs) {
    if (!s.name) continue; let segLen = 0;
    for (let i = s.start; i < s.end; i++) { const a = project(coords[i][0], coords[i][1]), b = project(coords[i + 1][0], coords[i + 1][1]); segLen += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    if (segLen < 40) continue;
    const midI = Math.floor((s.start + s.end) / 2), a = project(coords[midI][0], coords[midI][1]), b = project(coords[midI + 1][0], coords[midI + 1][1]);
    const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2 - 10; cands.push({ x, y, text: s.name, segLen, bbox: labelBBox(x, y, s.name) });
  }
  for (const c of placeLabels(cands, 12)) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', c.x); t.setAttribute('y', c.y); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '11'); t.setAttribute('font-weight', '600');
    t.setAttribute('fill', '#92400e'); t.setAttribute('stroke', '#ffffff'); t.setAttribute('stroke-width', '3'); t.setAttribute('stroke-linejoin', 'round'); t.setAttribute('paint-order', 'stroke');
    t.textContent = c.text; svg.appendChild(t);
  }
  if (Hooks.drawNav) Hooks.drawNav();                            // 導航：GPS 箭頭、精度圈、下一個導航點（nav-ui.js）
}
