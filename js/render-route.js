// render-route.js
import { Hooks, State } from './state.js';
import { segSpeedText } from './vehicle.js';
import { svg } from './dom.js';
import { segmentsOf } from './analysis.js';
import { allCoords, drawGrid, drawMarkers, fitBase, labelBBox, pathDOf, placeLabels, resetView, worldToScreen } from './render-core.js';
import { drawArrows, drawBus, drawInspect, drawNearby, drawOtherRoutes, drawRoadHighlight, drawStops, drawUbike, drawWidthLayer } from './render-layers.js';

export function drawRoute(route, refit = true) {
  const w = svg.clientWidth, h = svg.clientHeight;
  const padding = 60;
  const coords = route.coords;

  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lon, lat] of allCoords(route)) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  State.currentRoute = route;
  if (refit) { fitBase(minLon, maxLon, minLat, maxLat, padding); resetView(); }
  const project = worldToScreen;

  drawGrid();
  drawWidthLayer();
  drawNearby(route);
  drawOtherRoutes(route);
  drawBus();
  drawUbike();

  let pathD = '';
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = project(coords[i][0], coords[i][1]);
    pathD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
  }

  const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  halo.setAttribute('d', pathD);
  halo.setAttribute('fill', 'none');
  halo.setAttribute('stroke', route._color || '#fbbf24');
  halo.setAttribute('stroke-width', '12');
  halo.setAttribute('stroke-linecap', 'round');
  halo.setAttribute('stroke-linejoin', 'round');
  halo.setAttribute('opacity', '0.25');
  svg.appendChild(halo);

  for (const sg of segmentsOf(route)) {                 // 依道路分段；無路名的段 data-road 為空
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', pathDOf(route.coords.slice(sg.start, sg.end + 1)));
    el.setAttribute('class', 'route-seg');
    el.setAttribute('data-road', sg.name);
    el.setAttribute('data-len', Math.round(sg.len));
    el.setAttribute('data-spd', segSpeedText(route, sg));
    el.setAttribute('stroke', route._color || '#f59e0b');
    if (route._dash) el.setAttribute('stroke-dasharray', route._dash);
    svg.appendChild(el);
  }

  const [sx, sy] = project(coords[0][0], coords[0][1]);
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  s.setAttribute('cx', sx); s.setAttribute('cy', sy); s.setAttribute('r', '9');
  s.setAttribute('fill', 'white'); s.setAttribute('stroke', '#3b82f6'); s.setAttribute('stroke-width', '3');
  svg.appendChild(s);

  const [ex, ey] = project(coords[coords.length-1][0], coords[coords.length-1][1]);
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  e.setAttribute('cx', ex); e.setAttribute('cy', ey); e.setAttribute('r', '9');
  e.setAttribute('fill', 'white'); e.setAttribute('stroke', '#ef4444'); e.setAttribute('stroke-width', '3');
  svg.appendChild(e);

  const sl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  sl.setAttribute('x', sx + 14); sl.setAttribute('y', sy + 5);
  sl.setAttribute('font-size', '12'); sl.setAttribute('fill', '#3b82f6');
  sl.setAttribute('font-weight', 'bold'); sl.textContent = '起點';
  svg.appendChild(sl);

  const el = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  el.setAttribute('x', ex + 14); el.setAttribute('y', ey + 5);
  el.setAttribute('font-size', '12'); el.setAttribute('fill', '#ef4444');
  el.setAttribute('font-weight', 'bold'); el.textContent = '終點';
  svg.appendChild(el);
  drawMarkers();
  drawArrows(route);
    // === 路名标注 ===
  const NS = 'http://www.w3.org/2000/svg';
  const segs = [];
  let curName = null, startI = 0;
  for (let i = 0; i < route.edgePath.length; i++) {
    const eid = State.adjEid[route.edgePath[i]];
    const names = eid != null ? State.edgeIdToRoadNames.get(eid) : null;
    const name = (names && names.size > 0) ? [...names][0] : null;
    if (name !== curName) {
      if (curName) segs.push({ name: curName, start: startI, end: i });
      curName = name;
      startI = i;
    }
  }
  if (curName) segs.push({ name: curName, start: startI, end: route.edgePath.length });
  route._roadSegs = segs;

  const cands = [];
  for (const s of segs) {
    let segLen = 0;
    for (let i = s.start; i < s.end; i++) {
      const a = project(coords[i][0], coords[i][1]), b = project(coords[i+1][0], coords[i+1][1]);
      segLen += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    if (segLen < 40) continue;                                  // 短段直接放棄
    const midI = Math.floor((s.start + s.end) / 2);
    const a = project(coords[midI][0], coords[midI][1]), b = project(coords[midI + 1][0], coords[midI + 1][1]);
    const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2 - 10;
    cands.push({ x, y, text: s.name, segLen, bbox: labelBBox(x, y, s.name) });
  }
  for (const c of placeLabels(cands, 12)) {
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', c.x); t.setAttribute('y', c.y);
    t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '11'); t.setAttribute('font-weight', '600');
    t.setAttribute('fill', '#92400e'); t.setAttribute('stroke', '#ffffff'); t.setAttribute('stroke-width', '3');
    t.setAttribute('stroke-linejoin', 'round'); t.setAttribute('paint-order', 'stroke');   // 白描邊在字下
    t.textContent = c.text;
    svg.appendChild(t);
  }
  drawStops(route);
  drawRoadHighlight();
  drawInspect();
  if (Hooks.drawNav) Hooks.drawNav();                          // 導航：GPS 箭頭、精度圈、下一個導航點（nav-ui.js）
}
