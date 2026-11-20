// graph-core.js
import { State } from './state.js';
import { isGeo, worldDistM } from './geo.js';

// 'projected' | 'wgs84' | 'unknown'（unknown 按 projected 處理）

// 掃描節點偵測座標型別

export function detectCoordType() {
  let maxAbs = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, cnt = 0;
  for (let i = 0; i < State.N; i++) {
    const x = State.nodeXY[i*5+2], y = State.nodeXY[i*5+3];
    if (!isFinite(x) || !isFinite(y) || (x === 0 && y === 0)) continue;   // 略過缺座標的佔位節點
    cnt++;
    const m = Math.max(Math.abs(x), Math.abs(y));
    if (m > maxAbs) maxAbs = m;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (cnt === 0) return 'unknown';
  if (maxAbs > 1e5) return 'projected';
  if (minX >= 119.5 && maxX <= 122.5 && minY >= 22 && maxY <= 25.5) return 'wgs84';
  return 'unknown';
}

export function buildSpatialIndex() {
  if (State.N === 0) return;
  // 自适应网格：按节点坐标跨度 / 1000 自适应
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (let i = 0; i < State.N; i++) {
    const lon = State.nodeXY[i*5+2], lat = State.nodeXY[i*5+3];
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
  }
  const span = Math.max(maxLon - minLon, maxLat - minLat);
  // 格子大小：不小於「節點平均間距 × 3」。只用 span/1000 時，稀疏資料的格子會比節點間距還小，最多 20 圈的搜尋範圍連最近節點都找不到
  const area = (maxLon - minLon) * (maxLat - minLat), spacing = area > 0 ? Math.sqrt(area / State.N) : 0;
  State.GRID = span > 0 ? Math.min(span / 50, Math.max(span / 1000, 3 * spacing)) : 1;
  State.gridIndex = new Map();
  for (let i = 0; i < State.N; i++) {
    const lon = State.nodeXY[i*5+2], lat = State.nodeXY[i*5+3];
    const key = Math.floor(lon/State.GRID) + ',' + Math.floor(lat/State.GRID);
    let arr = State.gridIndex.get(key);
    if (!arr) { arr = []; State.gridIndex.set(key, arr); }
    arr.push(i);
  }
}

export function findNearestNode(lon, lat) {
  if (!State.gridIndex) return -1;
  const geo = isGeo();
  const kx = geo ? Math.cos(lat * Math.PI/180) : 1;   // wgs84 才做 cos 修正；projected/unknown 純歐氏
  const gx = Math.floor(lon/State.GRID), gy = Math.floor(lat/State.GRID);
  let best = -1, bestD = Infinity;
  for (let r = 0; r <= 20; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const arr = State.gridIndex.get((gx+dx) + ',' + (gy+dy));
        if (!arr) continue;
        for (const i of arr) {
          const ddx = (State.nodeXY[i*5+2] - lon) * kx;
          const ddy = State.nodeXY[i*5+3] - lat;
          const d = ddx*ddx + ddy*ddy;
          if (d < bestD) { bestD = d; best = i; }
        }
      }
    }
    // 第 r+1 圈任何點至少距離 r*GRID*min(1,kx)；已找到更近的就能確定是最近點
    if (best >= 0) { const lb = r * State.GRID * Math.min(1, kx); if (bestD <= lb*lb) break; }
  }
  return best;
}

export function parseCoordInput(v) {
  // 支持 xy:X,Y / X,Y / 逗号/分号/空白分隔
  const m = v.match(/^\s*(?:xy[:\s]*)?(-?\d+(?:\.\d+)?)\s*[,;，\s]\s*(-?\d+(?:\.\d+)?)\s*$/i);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  // 经纬度（台湾）
  if (a >= 20.5 && a <= 26.5 && b >= 116 && b <= 122.5) return { lat: a, lon: b, ll: true };      // ll：WGS84 經緯度（台灣本島、澎湖、金門、馬祖、蘭嶼；要依路網座標型別轉換）
  if (b >= 20.5 && b <= 26.5 && a >= 116 && a <= 122.5) return { lat: b, lon: a, ll: true };
  // 投影坐标（数值远大于经纬度）
  if (Math.abs(a) > 1e5 || Math.abs(b) > 1e5) return { lon: a, lat: b };
  return null;
}

// ============================================================
// 逐步導航
// ============================================================

export function edgeRoad(k) {
  const ns = State.adjEid[k] != null ? State.edgeIdToRoadNames.get(State.adjEid[k]) : null;
  return ns && ns.size ? ns.values().next().value : '';
}

export function ensureFrom() {
  if (State.adjFrom && State.adjFrom.length === State.adjTo.length) return State.adjFrom;
  State.adjFrom = new Int32Array(State.adjTo.length);
  for (let u = 0; u < State.N; u++) for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) State.adjFrom[k] = u;
  return State.adjFrom;
}

export function snapEdge(x, y, k) {                        // 節點 k 周圍的邊中，離 (x,y) 最近的投影點（x,y 為道路圖座標）
  const kx = isGeo() ? Math.cos(y * Math.PI/180) : 1, ax = State.nodeXY[k*5+2], ay = State.nodeXY[k*5+3];
  let best = { edge: -1, u: k, v: k, px: ax, py: ay, dm: worldDistM(x, y, ax, ay) };
  for (let e = State.adjOffset[k]; e < State.adjOffset[k+1]; e++) {
    const v = State.adjTo[e], bx = State.nodeXY[v*5+2], by = State.nodeXY[v*5+3], dx = (bx - ax) * kx, dy = by - ay, L2 = dx*dx + dy*dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, (((x - ax) * kx) * dx + (y - ay) * dy) / L2)) : 0;
    const px = ax + (bx - ax) * t, py = ay + (by - ay) * t, dm = worldDistM(x, y, px, py);
    if (dm < best.dm || best.edge < 0) best = { edge: e, u: k, v, px, py, dm };
  }
  return best;
}
