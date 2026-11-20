// osm-buildings.js — OSM 建築物圖層（v1.11）：z16 以上畫建築外框；3D 視角（傾斜）時畫 2.5D 立體；z18 以上標建築名稱
//
// 資料：伺服器 api/v1/osm/buildings/{z}/{x}/{y}.json（tools/osm/osm-buildings.mjs 從 OSM PBF 擷取）
// 高度來源分三種，畫法不同、不混為一談：
//   OSM height（真實資料）／OSM building:levels × 3 m（由樓層推算）→ 實心
//   推估（OSM 沒有任何高度資料；依建築類型的保守值）→ 半透明＋虛線外框；台灣 OSM 約 87% 的建築屬於這一類
// 3D 的作法：地圖平面是 CSS 傾斜的，建築的「高」換成平面上朝畫面上方的位移（高度 × tan(俯仰角) ÷ 每像素公尺數），
//   由遠到近畫（畫家演算法）。這是 2.5D 示意，不是真正的 3D 引擎
// 打包（build.mjs）會把所有模組合併成一個檔案：這裡的頂層名稱一律加 bld 前綴，避免與其他模組同名
import { State } from './state.js';
import { svg } from './dom.js';
import { lonLatToWorld, isGeo } from './geo.js';
import { esc } from './util.js';
import { scheduleRender, worldToScreen, labelBBox, placeLabels } from './render-core.js';

const BLD_ZMIN = 15, BLD_ZMAX = 18, BLD_CACHE = 400, BLD_PAR = 4, BLD_SHOW_DZ = 16, BLD_LABEL_DZ = 18;
const bldS = { tiles: new Map(), inflight: new Set(), queue: [], fail: 0 };
const bldOn = () => !!(State.osm && State.osm.avail && State.osm.on && State.osm.info && State.osm.info.buildings && State.osm.info.buildings.available);
const bldLon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z), bldLat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
function bldFetch(z, x, y) {
  const k = z + '/' + x + '/' + y; if (bldS.tiles.has(k) || bldS.inflight.has(k)) return;
  if (bldS.inflight.size >= BLD_PAR) { if (!bldS.queue.includes(k)) bldS.queue.push(k); return; }
  bldS.inflight.add(k); const v = encodeURIComponent(((State.osm.info && State.osm.info.version) || '') + '|' + (State.osm.info.buildings.version || ''));
  fetch(`api/v1/osm/buildings/${z}/${x}/${y}.json?v=${v}`).then(r => (r.ok ? r.json() : null)).then(t => bldS.tiles.set(k, t ? bldDecode(t) : { b: [], geo: isGeo() })).catch(() => { bldS.fail++; })
    .finally(() => {
      bldS.inflight.delete(k); while (bldS.tiles.size > BLD_CACHE) bldS.tiles.delete(bldS.tiles.keys().next().value);
      if (bldS.queue.length) { const [a, b, c] = bldS.queue.shift().split('/').map(Number); bldFetch(a, b, c); }
      clearTimeout(bldS.redraw); bldS.redraw = setTimeout(() => { if (!(State.nav && State.nav.follow)) scheduleRender(); else State.renderFull = true; }, 150);
    });
}
function bldDecode(t) {
  const [w, s, e, n] = t.bbox, X = t.extent || 4096, kx = (e - w) / X, ky = (n - s) / X, out = [];
  for (const f of t.b || []) {
    const [h, mh, src, ti, ni] = f, m = (f.length - 5) / 2, xs = new Float64Array(m), ys = new Float64Array(m); let px = 0, py = 0, cx = 0, cy = 0;
    for (let i = 0; i < m; i++) { if (i === 0) { px = f[5]; py = f[6]; } else { px += f[5 + 2 * i]; py += f[6 + 2 * i]; } const [wx, wy] = lonLatToWorld(w + px * kx, n - py * ky); xs[i] = wx; ys[i] = wy; cx += wx; cy += wy; }
    out.push({ h: h / 10, mh: mh / 10, src, type: t.types[ti], name: ni ? t.names[ni - 1] : '', xs, ys, cx: cx / m, cy: cy / m });
  }
  return { b: out, geo: isGeo() };
}
// 目前畫面要哪些建築圖磚（跟道路圖磚同一個層級，但限制在 15～18）
function bldVisible(z, view) {
  const bz = Math.max(BLD_ZMIN, Math.min(BLD_ZMAX, z)), x0 = bldLon2x(view.w0, bz), x1 = bldLon2x(view.e0, bz), y0 = bldLat2y(view.n0, bz), y1 = bldLat2y(view.s0, bz), use = [];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 90) return use;                                  // 太多（3D 看很遠）：不抓
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const t = bldS.tiles.get(bz + '/' + x + '/' + y); if (t) use.push(t); else bldFetch(bz, x, y); }
  return use;
}
let bldFrame = null;
// 由 osm.js 的 drawOsmBase 呼叫三次：phase 'base'（道路下面的平面外框）、'3d'（道路上面的立體）、'labels'（名稱）
export function drawBuildings({ z, dz, mpp, bx0, bx1, by0, by1, phase, view }) {
  if (!bldOn() || !Number.isFinite(dz) || dz < BLD_SHOW_DZ || !(mpp > 0)) { if (phase === 'base') bldFrame = null; return ''; }
  const pc = State.pitchCss, pitched = !!(pc && pc.deg >= 10 && dz >= 16.5);
  if (phase === 'base') {
    for (const t of bldS.tiles.values()) if (t.geo !== isGeo()) { bldS.tiles.clear(); break; }
    bldFrame = { list: view ? bldVisible(z, view) : [], pitched, dz, mpp };
    if (pitched) return '';
    let solid = '', est = '';
    for (const t of bldFrame.list) for (const b of t.b) { const d = bldRing(b, bx0, bx1, by0, by1); if (!d) continue; if (b.src === 2) est += d; else solid += d; }
    return (solid ? `<path d="${solid}" fill="#e4ddd2" stroke="#cfc6b8" stroke-width="0.8"/>` : '') + (est ? `<path d="${est}" fill="#ece7df" stroke="#d6cfc4" stroke-width="0.8" stroke-dasharray="3 2"/>` : '');
  }
  if (!bldFrame) return '';
  if (phase === '3d') {
    if (!bldFrame.pitched) return '';
    const rot = (State.cam && State.cam.rot ? State.cam.rot : 0) * Math.PI / 180, k = Math.tan(pc.deg * Math.PI / 180) / mpp, ux = Math.sin(rot), uy = -Math.cos(rot);   // 畫面「上方」在繪圖座標中的方向
    const items = [];
    for (const t of bldFrame.list) for (const b of t.b) { const [sx, sy] = worldToScreen(b.cx, b.cy); if (sx < bx0 || sx > bx1 || sy < by0 || sy > by1) continue; items.push({ b, depth: sx * ux + sy * uy }); }
    items.sort((p, q) => q.depth - p.depth);                                           // 遠（畫面上方）先畫
    let h = '';
    for (const { b } of items) {
      const top = b.h * k, base = b.mh * k, ox = ux * top, oy = uy * top, bxo = ux * base, byo = uy * base, pts = [];
      for (let i = 0; i < b.xs.length; i++) { const [x, y] = worldToScreen(b.xs[i], b.ys[i]); pts.push([x + bxo, y + byo]); }
      let walls = ''; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; walls += `M${p[0].toFixed(1)},${p[1].toFixed(1)}L${q[0].toFixed(1)},${q[1].toFixed(1)}L${(q[0] + ox - bxo).toFixed(1)},${(q[1] + oy - byo).toFixed(1)}L${(p[0] + ox - bxo).toFixed(1)},${(p[1] + oy - byo).toFixed(1)}Z`; }
      const roof = 'M' + pts.map(p => `${(p[0] + ox - bxo).toFixed(1)},${(p[1] + oy - byo).toFixed(1)}`).join('L') + 'Z', est = b.src === 2, dash = est ? ' stroke-dasharray="3 2"' : '';
      h += `<g class="bld3d" data-src="${b.src}"${est ? ' opacity=".55"' : ''}><path d="${walls}" fill="${est ? '#cbd5e1' : '#a8a29e'}" stroke="${est ? '#94a3b8' : '#78716c'}" stroke-width=".5"${dash}/><path d="${roof}" fill="${est ? '#f1f5f9' : '#e7e5e4'}" stroke="${est ? '#94a3b8' : '#78716c'}" stroke-width=".7"${dash}/></g>`;
    }
    return h;
  }
  if (phase === 'labels') {
    if (bldFrame.dz < BLD_LABEL_DZ) return '';
    const c = []; for (const t of bldFrame.list) for (const b of t.b) { if (!b.name) continue; const [x, y] = worldToScreen(b.cx, b.cy); if (x < 0 || y < 0 || x > svg.clientWidth || y > svg.clientHeight) continue; c.push({ x, y, text: b.name, segLen: b.h, bbox: labelBBox(x, y, b.name) }); }
    return placeLabels(c, 25).map(l => `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" text-anchor="middle" font-size="11" fill="#57534e" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(l.text)}</text>`).join('');
  }
  return '';
}
function bldRing(b, bx0, bx1, by0, by1) {
  let d = '', inside = false;
  for (let i = 0; i < b.xs.length; i++) { const [x, y] = worldToScreen(b.xs[i], b.ys[i]); if (x > bx0 && x < bx1 && y > by0 && y < by1) inside = true; d += (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1); }
  return inside ? d + 'Z' : '';
}
// 測試、除錯用
export function buildingDebug() { let n = 0, est = 0; for (const t of bldS.tiles.values()) for (const b of t.b) { n++; if (b.src === 2) est++; } return { tiles: bldS.tiles.size, buildings: n, estimated: est, inflight: bldS.inflight.size, fail: bldS.fail, pitched: !!(bldFrame && bldFrame.pitched) }; }
