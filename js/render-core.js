// render-core.js
import { Hooks, State } from './state.js';
import { svg } from './dom.js';
import { isGeo } from './geo.js';

export function fitBase(minX, maxX, minY, maxY, padding = 60) {
  const w = svg.clientWidth, h = svg.clientHeight;
  const kx = isGeo() ? Math.cos((minY + maxY) / 2 * Math.PI/180) : 1;
  const spanX = Math.max((maxX - minX) * kx, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((w - padding*2) / spanX, (h - padding*2) / spanY);
  State.base = { minX, minY, kx, scale, offX: (w - spanX*scale)/2, offY: (h - spanY*scale)/2, h };
}

export function fitGraph() {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (let i = 0; i < State.N; i++) {
    const x = State.nodeXY[i*5+2], y = State.nodeXY[i*5+3];
    if (!isFinite(x) || !isFinite(y) || (x === 0 && y === 0)) continue;
    if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y;
  }
  if (a <= b) fitBase(a, b, c, d);
}

export function worldToScreen(x, y) {
  const bx = State.base.offX + (x - State.base.minX) * State.base.kx * State.base.scale;
  const by = State.base.h - State.base.offY - (y - State.base.minY) * State.base.scale;
  return [bx * State.view.scale + State.view.tx, by * State.view.scale + State.view.ty];
}

// ---- 相機旋轉（Heading Up）：只是呈現層——所有繪圖仍用「北朝上」的螢幕座標，最後整組以 (cx, cy) 為中心旋轉 -rot 度 ----
// 使用者在螢幕上的點、拖曳量，要先「轉回」繪圖座標才能換算世界座標
export function unrotate(sx, sy) {
  const c = State.cam; if (!c || !c.rot) return [sx, sy];
  const a = c.rot * Math.PI / 180, dx = sx - c.cx, dy = sy - c.cy;
  return [c.cx + dx * Math.cos(a) - dy * Math.sin(a), c.cy + dx * Math.sin(a) + dy * Math.cos(a)];
}
export function panBy(dx, dy) { const c = State.cam, a = c && c.rot ? c.rot * Math.PI / 180 : 0; State.view.tx += dx * Math.cos(a) - dy * Math.sin(a); State.view.ty += dx * Math.sin(a) + dy * Math.cos(a); }
export function zoomAt(mx, my, k) { const [x, y] = unrotate(mx, my); State.view.tx = x - (x - State.view.tx) * k; State.view.ty = y - (y - State.view.ty) * k; State.view.scale *= k; }
export const clientToWorld = (sx, sy) => screenToWorld(...unrotate(sx, sy));
const rotPrefix = () => { const c = State.cam; return c && c.rot ? `rotate(${(-c.rot).toFixed(2)} ${c.cx.toFixed(1)} ${c.cy.toFixed(1)}) ` : ''; };

export function screenToWorld(sx, sy) {
  const bx = (sx - State.view.tx) / State.view.scale, by = (sy - State.view.ty) / State.view.scale;
  return [(bx - State.base.offX) / (State.base.kx * State.base.scale) + State.base.minX,
          (State.base.h - State.base.offY - by) / State.base.scale + State.base.minY];
}

export function resetView() { State.view = { tx: 0, ty: 0, scale: 1 }; }

// scheduleRender()：下一個畫面完整重畫。
// scheduleRender({ viewOnly: true })：只有視角變了（導航跟隨、拖曳、雙指縮放）——把上一次畫好的整個場景套一個轉換矩陣，
// 不重新產生路網與路線的幾萬個點；位移或縮放差太多、或期間有人要求完整重畫，才完整重畫。
export function scheduleRender(o) {
  if (!(o && o.viewOnly === true)) State.renderFull = true;
  if (State.rafId) return;
  State.rafId = requestAnimationFrame(() => { State.rafId = 0; const full = State.renderFull; State.renderFull = false; if (full || !shiftScene()) render(); });
}
// 立刻更新畫面（動畫每一幀用）：能平移就平移，不能才完整重畫
export function renderView() { if (State.renderFull || !shiftScene()) { State.renderFull = false; render(); } }

export function render() {                       // 只重繪，不重跑 dijkstra
  if (!State.base) { drawGrid(); return; }
  if (State.currentRoute) Hooks.drawRoute(State.currentRoute, false);
  else { drawGrid(); Hooks.drawWidthLayer(); Hooks.drawBus(); Hooks.drawUbike(); drawMarkers(); Hooks.drawInspect(); if (Hooks.drawTransitPlan) Hooks.drawTransitPlan(); if (Hooks.drawNav) Hooks.drawNav(); }
  if (Hooks.drawExtra) Hooks.drawExtra();                       // v1.12：道路事件圖層等（ui-shell.js）
  commitScene();
  if (Hooks.syncMapUi) Hooks.syncMapUi();                       // 縮放層級、比例尺（map-view.js）
}
// 把剛畫好的內容收進 <g id="scene">，記下當時的視角（之後的快速平移以它為基準）；導航箭頭留在最上層、每次各自重畫
function commitScene() {
  if (!svg || !svg.ownerDocument || typeof svg.insertBefore !== 'function' || !svg.childNodes) { State.drawnView = null; return; }
  const g = svg.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('id', 'scene');
  for (const c of [...svg.childNodes]) if (c.id !== 'navMarker') g.appendChild(c);
  svg.insertBefore(g, svg.firstChild);
  State.scene = g; State.drawnView = { tx: State.view.tx, ty: State.view.ty, scale: State.view.scale, w: svg.clientWidth, h: svg.clientHeight };
  const r = rotPrefix(); if (r) g.setAttribute('transform', r.trim());
}
// 成功回傳 true；條件不符（沒有場景、視窗大小變了、縮放超過 2 倍、平移超過畫面 35%）回傳 false，由呼叫端完整重畫
export function shiftScene() {
  const d = State.drawnView, g = State.scene, v = State.view;
  if (!d || !g || !g.isConnected || svg.clientWidth !== d.w || svg.clientHeight !== d.h) return false;
  const k = v.scale / d.scale, ex = v.tx - d.tx * k, ey = v.ty - d.ty * k;
  if (k > 2 || k < 0.5 || Math.abs(ex + (k - 1) * d.w / 2) > d.w * 0.35 || Math.abs(ey + (k - 1) * d.h / 2) > d.h * 0.35) return false;
  g.setAttribute('transform', rotPrefix() + (k === 1 ? `translate(${ex.toFixed(1)} ${ey.toFixed(1)})` : `matrix(${k} 0 0 ${k} ${ex.toFixed(1)} ${ey.toFixed(1)})`));
  if (Hooks.drawNav) Hooks.drawNav();
  return true;
}

export function drawMarkers() {
  if (!State.base) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (const [p, color] of [[State.fromPoint, '#3b82f6'], [State.toPoint, '#ef4444']]) {
    if (!p) continue;
    const [x, y] = worldToScreen(p.lon, p.lat);
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', '6');
    c.setAttribute('fill', color); c.setAttribute('stroke', 'white'); c.setAttribute('stroke-width', '2');
    svg.appendChild(c);
  }
}

// ============================================================
// 背景網格
// ============================================================

export function drawGrid() {
  svg.innerHTML = '';
  const w = svg.clientWidth, h = svg.clientHeight;
  let g = '<g class="bg-grid" stroke="#f1f5f9" style="stroke:var(--c-grid,#f1f5f9)" stroke-width="1">';   // v1.12：顏色跟主題（深色時不會是亮白格線）
  if (!State.base) {
    for (let x = 0; x <= w; x += 40) g += `<line x1="${x}" y1="0" x2="${x}" y2="${h}"/>`;
    for (let y = 0; y <= h; y += 40) g += `<line x1="0" y1="${y}" x2="${w}" y2="${y}"/>`;
  } else {
    // 世界間距取 10 的整數次方，使螢幕間距最接近 40px
    const pxPerUnit = State.base.scale * State.view.scale;
    const step = Math.pow(10, Math.round(Math.log10(40 / pxPerUnit)));
    const [x0, y1] = screenToWorld(0, 0), [x1, y0] = screenToWorld(w, h);
    let n = 0;
    for (let x = Math.floor(x0/step)*step; x <= x1 && n < 400; x += step, n++) {
      const sx = worldToScreen(x, 0)[0].toFixed(1);
      g += `<line x1="${sx}" y1="0" x2="${sx}" y2="${h}"/>`;
    }
    for (let y = Math.floor(y0/step)*step, m = 0; y <= y1 && m < 400; y += step, m++) {
      const sy = worldToScreen(0, y)[1].toFixed(1);
      g += `<line x1="0" y1="${sy}" x2="${w}" y2="${sy}"/>`;
    }
  }
  g += '</g>';
  svg.insertAdjacentHTML('afterbegin', g);
  if (Hooks.drawOsmBase) Hooks.drawOsmBase();                 // 全台 OSM 底圖（osm.js；伺服器有 OSM 道路圖時）
}

export function* allCoords(route) {
  yield* route.coords;
  for (const it of State.routeSet) if (it.visible && it.route && it.route !== route) yield* it.route.coords;
}

export function pathDOf(coords) {
  let d = '';
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = worldToScreen(coords[i][0], coords[i][1]);
    d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
  }
  return d;
}

export function textWidth(t) {
  try {
    if (!State._mctx) { State._mctx = document.createElement('canvas').getContext('2d'); State._mctx.font = '600 11px "Microsoft JhengHei", sans-serif'; }
    const w = State._mctx.measureText(t).width; if (w > 0) return w;
  } catch (e) {}
  return t.length * 11;                                          // 無 canvas 時的估算（CJK 約 1em）
}

export function labelBBox(x, y, text) { const w = textWidth(text) + 6; return { x1: x - w/2, y1: y - 12, x2: x + w/2, y2: y + 4 }; }

export const bboxOverlap = (a, b) => !(a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1);

export function placeLabels(cands, maxN = 12, W = svg.clientWidth, H = svg.clientHeight) {
  cands.sort((a, b) => b.segLen - a.segLen);                     // 長段優先
  const placed = [];
  for (const c of cands) {
    if (placed.length >= maxN) break;
    for (const off of [0, -14, 14, -28, 28]) {                   // 重疊就上下偏移，全失敗則放棄
      const bb = labelBBox(c.x, c.y + off, c.text);
      if (bb.x1 < 0 || bb.x2 > W || bb.y1 < 0 || bb.y2 > H) continue;
      if (placed.some(p => bboxOverlap(p.bbox, bb))) continue;
      placed.push({ ...c, y: c.y + off, bbox: bb }); break;
    }
  }
  return placed;
}
