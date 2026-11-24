// render-layers.js
import { Hooks, State } from './state.js';
import { NEARBY_FRAC, NEARBY_MAX_EDGES, WCOL, nearbyCache } from './constants.js';
import { svg } from './dom.js';
import { ensureRA } from './road-attrs.js';
import { legCoordsOf } from './bus-core.js';
import { generateManeuvers, roadEdges, stopsOf } from './analysis.js';
import { allCoords, pathDOf, screenToWorld, worldToScreen } from './render-core.js';

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

export function drawRoadHighlight() {
  if (!State.highlightRoad || !State.base) return;
  const NS = 'http://www.w3.org/2000/svg', w = svg.clientWidth, h = svg.clientHeight, e = roadEdges(State.highlightRoad);
  let d = '';
  for (let i = 0; i < e.length; i += 2) {
    const [x1, y1] = worldToScreen(State.nodeXY[e[i]*5+2], State.nodeXY[e[i]*5+3]);
    const [x2, y2] = worldToScreen(State.nodeXY[e[i+1]*5+2], State.nodeXY[e[i+1]*5+3]);
    if ((x1 < -50 && x2 < -50) || (x1 > w+50 && x2 > w+50) || (y1 < -50 && y2 < -50) || (y1 > h+50 && y2 > h+50)) continue;
    d += `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  const g = document.createElementNS(NS, 'g'); g.setAttribute('id', 'road-highlight');   // 最上層
  const pth = document.createElementNS(NS, 'path');
  pth.setAttribute('d', d); pth.setAttribute('fill', 'none'); pth.setAttribute('stroke', '#3b82f6');
  pth.setAttribute('stroke-opacity', '0.45'); pth.setAttribute('stroke-width', '12'); pth.setAttribute('stroke-linecap', 'round');
  g.appendChild(pth); svg.appendChild(g);
}

// 上限，避免市中心畫出數十萬條線


export function nearbyEdges(route) {
  const rts = [route, ...State.routeSet.filter(it => it.visible && it.route && it.route !== route).map(it => it.route)];
  const key = rts.map(r => r._id || (r._id = ++State.routeIdSeq)).join(',');
  if (nearbyCache.key === key) return nearbyCache.arr;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of allCoords(route)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const cell = Math.max(x1 - x0, y1 - y0, 1e-9) * NEARBY_FRAC, K = (cx, cy) => (cx + 8) * 100000 + (cy + 8);
  const marked = new Set();
  for (const [x, y] of allCoords(route)) {            // 路線每個節點所在的粗格 + 周圍一圈
    const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) marked.add(K(cx + dx, cy + dy));
  }
  const inc = new Uint8Array(State.N);
  for (let i = 0; i < State.N; i++) {
    const x = State.nodeXY[i*5+2], y = State.nodeXY[i*5+3];
    if (x === 0 && y === 0) continue;
    const cx = Math.floor((x - x0) / cell), cy = Math.floor((y - y0) / cell);
    if (cx < -1 || cy < -1 || cx > 1e4 || cy > 1e4) continue;
    if (marked.has(K(cx, cy))) inc[i] = 1;
  }
  const out = [];
  for (let u = 0; u < State.N && out.length < NEARBY_MAX_EDGES * 2; u++) {
    if (!inc[u]) continue;
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) { const v = State.adjTo[k]; if (v > u && inc[v]) out.push(u, v); }
  }
  nearbyCache.key = key; nearbyCache.arr = Int32Array.from(out);
  return nearbyCache.arr;
}

export function drawNearby(route) {
  if (!State.showNearby || !State.base) return;
  const w = svg.clientWidth, h = svg.clientHeight, e = nearbyEdges(route), big = State.nav ? Math.max(w, h) * 0.65 : 0, mx = Math.max(20, w * 0.4, big), my = Math.max(20, h * 0.4, big);   // 多畫畫面外 40%：快速平移時邊緣不會露白；導航中（可能旋轉、傾斜）多畫更多
  let d = '';
  for (let i = 0; i < e.length; i += 2) {
    const [x1, y1] = worldToScreen(State.nodeXY[e[i]*5+2], State.nodeXY[e[i]*5+3]);
    const [x2, y2] = worldToScreen(State.nodeXY[e[i+1]*5+2], State.nodeXY[e[i+1]*5+3]);
    if ((x1 < -mx && x2 < -mx) || (x1 > w+mx && x2 > w+mx) || (y1 < -my && y2 < -my) || (y1 > h+my && y2 > h+my)) continue;
    d += `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`;
  }
  const pth = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  pth.setAttribute('d', d); pth.setAttribute('fill', 'none'); pth.setAttribute('stroke', '#cbd5e1');
  pth.setAttribute('stroke-width', '1.2'); pth.setAttribute('stroke-linecap', 'round'); pth.setAttribute('id', 'nearby-roads');
  svg.appendChild(pth);
}

export function drawBusDots() {                          // 公車站（放大後）＋ 捷運站與線（一直顯示，不貼合道路）
  const b = State.bus, w = svg.clientWidth, h = svg.clientHeight, dBus = [], dMetro = [], dLine = [], labels = [], NS = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < b.n && dBus.length < 3000; i++) {
    if (!(b.sx[i] === b.sx[i])) continue;
    const metro = b.stopKind[i] === 'metro'; if (!metro && State.view.scale < 2) continue;
    const [x, y] = worldToScreen(b.sx[i], b.sy[i]);
    if (metro) {
      for (let e = b.off[i]; e < b.off[i+1]; e++) if (b.routeKind[b.eRoute[e]] === 'metro' && b.eTo[e] > i) { const [x2, y2] = worldToScreen(b.sx[b.eTo[e]], b.sy[b.eTo[e]]); dLine.push(`M${x.toFixed(1)},${y.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`); }
      if (x < -5 || x > w + 5 || y < -5 || y > h + 5) continue;
      dMetro.push(`M${x.toFixed(1)},${y.toFixed(1)}h0`); if (State.view.scale >= 2.5) labels.push([x, y, b.names[i]]);
    } else if (!(x < -5 || x > w + 5 || y < -5 || y > h + 5)) dBus.push(`M${x.toFixed(1)},${y.toFixed(1)}h0`);
  }
  const mk = (d, color, width, extra) => { if (!d.length) return; const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d.join('')); p.setAttribute('stroke', color); p.setAttribute('stroke-width', width); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('fill', 'none'); if (extra) p.setAttribute('opacity', extra); svg.appendChild(p); };
  mk(dLine, '#16a34a', 3, '0.55'); mk(dBus, '#a78bfa', 5); mk(dMetro, '#15803d', 10);
  for (const [x, y, name] of labels) { const t = document.createElementNS(NS, 'text'); t.setAttribute('x', x + 8); t.setAttribute('y', y + 4); t.setAttribute('font-size', '11'); t.setAttribute('fill', '#166534'); t.setAttribute('stroke', '#fff'); t.setAttribute('stroke-width', '3'); t.setAttribute('paint-order', 'stroke'); t.textContent = name; svg.appendChild(t); }
}

export function drawBus() {
  if (!State.bus || !State.bus.x || !State.busVisible || !State.base) return;
  drawBusDots();
  if (!State.busSug || State.busSug.error) return;
  const NS = 'http://www.w3.org/2000/svg', b = State.bus;
  const line = (d, dash, w, color = '#7c3aed') => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', color); p.setAttribute('stroke-width', w);
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('opacity', '0.9');
    if (dash) p.setAttribute('stroke-dasharray', dash);
    svg.appendChild(p);
  };
  const P = (x, y) => worldToScreen(x, y).map(v => v.toFixed(1)).join(',');
  const first = State.busSug.rides[0].stops[0], lastR = State.busSug.rides[State.busSug.rides.length - 1], last = lastR.stops[lastR.stops.length - 1];
  // 起終點：步行（虛線）；有 YouBike 接駁時：步行到借車站 → 騎車（沿道路，橘色）→ 步行到站
  const U = State.UB, bikeSeg = (bk, ax, ay, zx, zy) => { const r = bk.rent, t = bk.ret;
    line(`M${P(ax, ay)}L${P(U.x[r], U.y[r])}`, '4 5', 2); line('M' + bk.path.map(([x, y]) => P(x, y)).join('L'), null, 4, '#ea580c'); line(`M${P(U.x[t], U.y[t])}L${P(zx, zy)}`, '4 5', 2);
    for (const i of [r, t]) { const [x, y] = worldToScreen(U.x[i], U.y[i]), c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '5'); c.setAttribute('fill', '#ea580c'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '2'); svg.appendChild(c); } };
  if (State.busSug.bikeIn && U && U.x) bikeSeg(State.busSug.bikeIn, State.busSug.ox, State.busSug.oy, b.sx[first], b.sy[first]);
  else line(`M${P(State.busSug.ox, State.busSug.oy)}L${P(b.sx[first], b.sy[first])}`, '4 5', 2);      // 步行
  if (State.busSug.bikeOut && U && U.x) bikeSeg(State.busSug.bikeOut, b.sx[last], b.sy[last], State.busSug.dx, State.busSug.dy);
  else line(`M${P(b.sx[last], b.sy[last])}L${P(State.busSug.dx, State.busSug.dy)}`, '4 5', 2);
  for (const r of State.busSug.rides) {
    line('M' + legCoordsOf(r).map(([x, y]) => P(x, y)).join('L'), null, 4);   // 沿道路，不是站與站的直線
    for (const i of [r.stops[0], r.stops[r.stops.length - 1]]) {
      const [x, y] = worldToScreen(b.sx[i], b.sy[i]), c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '4.5'); c.setAttribute('fill', '#fff');
      c.setAttribute('stroke', '#7c3aed'); c.setAttribute('stroke-width', '2'); svg.appendChild(c);
    }
  }
}

export function drawUbike() {                             // 放大後顯示站點；hover 顯示名稱與容量
  if (!State.UB || !State.UB.x || !State.base || State.view.scale < 2) return;
  const NS = 'http://www.w3.org/2000/svg', w = svg.clientWidth, h = svg.clientHeight; let c = 0;
  for (let i = 0; i < State.UB.n && c < 1500; i++) {
    const [x, y] = worldToScreen(State.UB.x[i], State.UB.y[i]);
    if (x < -8 || x > w + 8 || y < -8 || y > h + 8) continue;
    const el = document.createElementNS(NS, 'circle');
    el.setAttribute('class', 'ub'); el.setAttribute('cx', x); el.setAttribute('cy', y); el.setAttribute('r', '4.5');
    el.setAttribute('fill', '#f97316'); el.setAttribute('stroke', '#fff'); el.setAttribute('stroke-width', '1.5');
    el.setAttribute('data-name', State.UB.name[i]); el.setAttribute('data-cap', State.UB.cap[i]);
    svg.appendChild(el); c++;
  }
}

export function drawStops(route) {
  if (!document.getElementById('showStops').checked || !State.base || route._osm) return;
  const sg = stopsOf(route); if (!sg) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (const s of sg.stops) {
    const [x, y] = worldToScreen(s.x, s.y), c = document.createElementNS(NS, 'circle'), t = document.createElementNS(NS, 'text');
    c.setAttribute('class', 'sg'); c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '8');
    c.setAttribute('fill', s.score >= 70 ? '#16a34a' : s.score >= 50 ? '#f59e0b' : '#94a3b8'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '2');
    c.setAttribute('data-tip', `站 ${s.q}：${s.name} · 距起點 ${Math.round(s.dist)} m · 分數 ${Math.round(s.score)}${s.why.length ? '（' + s.why.join('、') + '）' : ''}${s.warn.length ? ' ⚠ ' + s.warn.join('、') : ''}`);
    t.setAttribute('x', x); t.setAttribute('y', y + 3.5); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '10'); t.setAttribute('font-weight', '700'); t.setAttribute('fill', '#fff');
    t.textContent = s.q; svg.appendChild(c); svg.appendChild(t);
  }
}

export function drawWidthLayer() {
  const hint = document.getElementById('widthHint'); hint.textContent = '';
  if (!document.getElementById('showWidth').checked || !State.base || !State.gridIndex) return;
  const w = svg.clientWidth, h = svg.clientHeight, [xa, yb] = screenToWorld(0, 0), [xb, ya] = screenToWorld(w, h);
  const gx0 = Math.floor(Math.min(xa, xb) / State.GRID), gx1 = Math.floor(Math.max(xa, xb) / State.GRID), gy0 = Math.floor(Math.min(ya, yb) / State.GRID), gy1 = Math.floor(Math.max(ya, yb) / State.GRID);
  if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > 25000) { hint.textContent = '請再放大，才會顯示道路寬度圖層'; return; }
  const ra = ensureRA(), B = { a: '', b: '', c: '', d: '', u: '', f: '' }; let cnt = 0;
  const vis = v => { const cx = Math.floor(State.nodeXY[v*5+2] / State.GRID), cy = Math.floor(State.nodeXY[v*5+3] / State.GRID); return cx >= gx0 && cx <= gx1 && cy >= gy0 && cy <= gy1; };
  for (let gx = gx0; gx <= gx1 && cnt < 60000; gx++) for (let gy = gy0; gy <= gy1; gy++) for (const u of State.gridIndex.get(gx + ',' + gy) || []) {
    const [x1, y1] = worldToScreen(State.nodeXY[u*5+2], State.nodeXY[u*5+3]);
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k]; if (v < u && vis(v)) continue;                      // 兩端都在視窗內的邊只畫一次
      const wv = ra.width[k], key = ra.forb[k] ? 'f' : !(wv > 0) ? 'u' : wv >= 12 ? 'a' : wv >= 8 ? 'b' : wv >= 6 ? 'c' : 'd';
      const [x2, y2] = worldToScreen(State.nodeXY[v*5+2], State.nodeXY[v*5+3]);
      B[key] += `M${x1.toFixed(1)},${y1.toFixed(1)}L${x2.toFixed(1)},${y2.toFixed(1)}`; cnt++;
    }
  }
  const NS = 'http://www.w3.org/2000/svg';
  for (const key in B) {
    if (!B[key]) continue;
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', B[key]); p.setAttribute('fill', 'none'); p.setAttribute('stroke', WCOL[key]); p.setAttribute('stroke-width', key === 'a' ? '3' : '2'); p.setAttribute('stroke-linecap', 'round');
    if (key === 'f') p.setAttribute('stroke-dasharray', '3 4');
    svg.appendChild(p);
  }
}

export function drawInspect() {
  if (!State.inspectEdge || !State.base) return;
  const NS = 'http://www.w3.org/2000/svg', n = State.inspectEdge, [x1, y1] = worldToScreen(State.nodeXY[n.u*5+2], State.nodeXY[n.u*5+3]), [x2, y2] = worldToScreen(State.nodeXY[n.v*5+2], State.nodeXY[n.v*5+3]), [px, py] = worldToScreen(n.px, n.py);
  const l = document.createElementNS(NS, 'path'); l.setAttribute('d', `M${x1},${y1}L${x2},${y2}`); l.setAttribute('fill', 'none'); l.setAttribute('stroke', '#f59e0b');
  l.setAttribute('stroke-width', '9'); l.setAttribute('stroke-opacity', '0.5'); l.setAttribute('stroke-linecap', 'round'); svg.appendChild(l);
  const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', px); c.setAttribute('cy', py); c.setAttribute('r', '4'); c.setAttribute('fill', '#f59e0b'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.5'); svg.appendChild(c);
}
