// metro-city.mjs — 捷運整合測試用的城市（固定亂數種子）。
// ・道路：TWD97 公分座標的格網（與真實台中路網同一種座標），涵蓋台中捷運綠線
// ・公車：合成的密集路線，每個路口兩支對向站牌（同站群）；站距 150 m —— 捷運站附近會有很多比捷運站更近的公車站
// ・捷運：真實的 data/metro.json（TDX 車站，綠線 18 站）＋「測試用藍線 TB」（6 站，與綠線在市政府站附近交會；只存在於測試中）
// 所有公車路線、班次、藍線都是測試資料，不代表真實營運。
import { readFileSync } from 'node:fs';
import { rng } from './helpers.mjs';

export const LAT0 = 24.10, LON0 = 120.60, M_LAT = 1 / 110574, M_LON = 1 / (111320 * Math.cos(24.15 * Math.PI / 180));
export const ll = (x, y) => ({ lat: LAT0 + y * M_LAT, lon: LON0 + x * M_LON });
export const greenLine = () => JSON.parse(readFileSync(new URL('../data/metro.json', import.meta.url), 'utf8'));
export const st = (rows, id) => { const r = rows.find(x => x.StationID === id); return { lat: r.StationPosition.PositionLat, lon: r.StationPosition.PositionLon }; };

// 測試用藍線：從 G9（市政府）附近往東北、往西南各延伸；轉乘站 TB4 在 G9 東側約 120 m
export function testBlueLine() {
  const g9 = st(greenLine(), 'G9'), P = (dx, dy) => ({ PositionLat: g9.lat + dy * M_LAT, PositionLon: g9.lon + dx * M_LON });
  const pts = [[-3600, -2600], [-2400, -1700], [-1200, -850], [120, 0], [1300, 900], [2600, 1800]];
  return pts.map(([dx, dy], i) => ({ StationUID: `TEST-TB${i + 1}`, StationID: `TB${i + 1}`, StationName: { Zh_tw: `測試藍${i + 1}` }, StationPosition: P(dx, dy) }));
}

export function makeMetroCity({ seed = 11, cols = 80, rows = 62, sp = 150, routes = 260, toTWD97 } = {}) {
  const R = rng(seed), nodes = [], edges = [], id = (c, r) => `n${c}_${r}`;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    const p = ll(c * sp, r * sp), [e, n] = toTWD97(p.lon, p.lat); nodes.push({ id: id(c, r), x: Math.round(e * 100), y: Math.round(n * 100) });
    if (c + 1 < cols) edges.push({ from: id(c, r), to: id(c + 1, r), w: sp * 100, edgeId: `h${c}_${r}` });
    if (r + 1 < rows) edges.push({ from: id(c, r), to: id(c, r + 1), w: sp * 100, edgeId: `v${c}_${r}` });
  }
  const bn = {}, adj = {}, stop = (c, r, d) => {
    const p = ll(c * sp + (d ? 9 : -9), r * sp + (d ? -9 : 9)), u = `TXG${c}_${r}_${d}`;
    bn[u] ??= { stop_id: `${c}_${r}_${d}`, node_name: `路口${c}-${r}${d ? '(回)' : ''}`, latitude: p.lat, longitude: p.lon, station_group_id: `G${c}_${r}` }; return u;
  };
  for (let k = 0; k < routes; k++) {
    let c = Math.floor(R() * cols), r = Math.floor(R() * rows), dc = R() < .5 ? 1 : 0, dr = dc ? 0 : 1; if (R() < .5) { dc = -dc; dr = -dr; }
    const cells = [[c, r]], seen = new Set([c + ',' + r]), len = 14 + Math.floor(R() * 30);
    for (let g = 0; cells.length < len && g < 300; g++) {
      if (R() < .15) [dc, dr] = R() < .5 ? [dr, dc] : [-dr, -dc];
      const nc = c + dc, nr = r + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen.has(nc + ',' + nr)) { [dc, dr] = [dr, -dc]; continue; }
      c = nc; r = nr; cells.push([c, r]); seen.add(c + ',' + r);
    }
    if (cells.length < 5) continue;
    const run = Math.round(sp / (4.2 + R() * 1.8));
    for (const d of [0, 1]) {
      const seq = (d ? [...cells].reverse() : cells).map(([a, b]) => stop(a, b, d));
      for (let i = 0; i < seq.length - 1; i++) (adj[seq[i]] ??= []).push({ to: seq[i + 1], distance_meters: sp, route_name: `${k + 1}路`, route_uid: 'TXG' + k, subroute_uid: `TXG${k}0|${d}`, travel_times: [{ run_time: run }] });
    }
  }
  return { road: { nodes, edges, roads: [] }, bus: { nodes: bn, adjacency: adj }, metro: [...greenLine(), ...testBlueLine()] };
}
// 在某點附近（東 dx、北 dy 公尺）
export const near = (p, dx, dy) => ({ lat: p.lat + dy * M_LAT, lon: p.lon + dx * M_LON });
