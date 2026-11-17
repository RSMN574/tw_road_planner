// transit-city.mjs — 效能基準用的合成城市（固定亂數種子，每次產生的資料完全相同）。
// 同一座城市同時輸出三種形狀：① TDX 形狀（新資料層用）② 舊的公車 graph.json 形狀（現有搜尋用）③ 道路圖。
// 所有班次都是人工產生的測試資料，只用來比較「優化前後」的效能與結果，不代表任何真實路線。
import { rng } from './helpers.mjs';

const LAT0 = 24.12, LON0 = 120.62, M_LAT = 1 / 110574, M_LON = 1 / (111320 * Math.cos(LAT0 * Math.PI / 180));
const hm = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ALL = { Sunday: 1, Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1 };

export function makeCity({ seed = 7, cols = 30, rows = 20, spacing = 400, routes = 120, metro = true } = {}) {
  const R = rng(seed), ll = (x, y) => ({ lat: LAT0 + y * M_LAT, lon: LON0 + x * M_LON });
  // 每個路口兩支站牌（去程／回程，相距約 25 m），同一個站群
  const stopAt = (c, r, dir) => { const p = ll(c * spacing + (dir ? 12 : -12), r * spacing + (dir ? -12 : 12)); return { uid: `TXG${c}_${r}_${dir}`, id: `${c}_${r}_${dir}`, name: `路口${c}-${r}`, ...p, group: `G${c}_${r}` }; };
  const stopOfRoute = [], schedule = [], oldNodes = {}, oldAdj = {};
  const useOld = s => { oldNodes[s.uid] ??= { stop_id: s.id, node_name: s.name, latitude: s.lat, longitude: s.lon, station_group_id: s.group }; };
  for (let k = 0; k < routes; k++) {
    // 路線：隨機走 12～28 個相鄰路口（不回頭）
    let c = Math.floor(R() * cols), r = Math.floor(R() * rows), dc = R() < 0.5 ? 1 : 0, dr = dc ? 0 : 1; if (R() < 0.5) { dc = -dc; dr = -dr; }
    const cells = [[c, r]], len = 12 + Math.floor(R() * 17), seen = new Set([c + ',' + r]);
    while (cells.length < len) {
      if (R() < 0.18) [dc, dr] = R() < 0.5 ? [dr, dc] : [-dr, -dc];
      const nc = c + dc, nr = r + dr; if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || seen.has(nc + ',' + nr)) { [dc, dr] = [dr, -dc]; if (cells.length > 60 || R() < 0.05) break; const c2 = c + dc, r2 = r + dr; if (c2 < 0 || r2 < 0 || c2 >= cols || r2 >= rows || seen.has(c2 + ',' + r2)) break; continue; }
      c = nc; r = nr; cells.push([c, r]); seen.add(c + ',' + r);
    }
    if (cells.length < 4) { k--; continue; }
    const headway = [600, 900, 1200, 1800, 3600][Math.floor(R() * 5)], speed = 4.5 + R() * 3, first = 5.5 * 3600 + Math.floor(R() * 1800), last = 22.5 * 3600;
    for (const dir of [0, 1]) {
      const seq = (dir ? [...cells].reverse() : cells).map(([cc, rr]) => stopAt(cc, rr, dir)), run = Math.round(spacing / speed), sub = `TXG${k}0`;
      stopOfRoute.push({ RouteUID: 'TXG' + k, RouteID: String(k), RouteName: { Zh_tw: String(k + 1) }, SubRouteUID: sub, SubRouteID: k + '0', SubRouteName: { Zh_tw: String(k + 1) }, Direction: dir, City: 'Taichung',
        Stops: seq.map((s, i) => ({ StopUID: s.uid, StopID: s.id, StopName: { Zh_tw: s.name }, StopSequence: i + 1, StopPosition: { PositionLat: s.lat, PositionLon: s.lon }, StationGroupID: s.group })) });
      const Timetables = []; for (let t = first + (dir ? headway / 2 : 0), n = 0; t <= last; t += headway, n++) Timetables.push({ TripID: `${k}-${dir}-${n}`, ServiceDay: ALL, StopTimes: seq.map((s, i) => ({ StopSequence: i + 1, StopUID: s.uid, ArrivalTime: hm(t + i * run), DepartureTime: hm(t + i * run) })) });
      schedule.push({ RouteUID: 'TXG' + k, SubRouteUID: sub, Direction: dir, Timetables });
      seq.forEach(useOld);
      for (let i = 0; i < seq.length - 1; i++) (oldAdj[seq[i].uid] ??= []).push({ to: seq[i + 1].uid, distance_meters: spacing, route_name: String(k + 1), route_uid: 'TXG' + k, subroute_uid: `${sub}|${dir}`, travel_times: [{ run_time: run }] });
    }
  }
  // 捷運：一條斜向的線，每 3 個路口一站
  const m = { station: [], stationOfLine: [], s2s: [], frequency: [], firstLast: [], line: [{ LineID: 'G', LineName: { Zh_tw: '綠線' } }] };
  if (metro) {
    const st = []; for (let i = 0; i * 3 < Math.min(cols, rows * 1.5); i++) { const p = ll(i * 3 * spacing + 60, Math.min(rows - 1, i * 2) * spacing + 60); st.push({ id: 'G' + i, ...p }); }
    m.station = st.map(s => ({ StationUID: 'TMRT-' + s.id, StationID: s.id, StationName: { Zh_tw: '捷運' + s.id }, StationPosition: { PositionLat: s.lat, PositionLon: s.lon } }));
    m.stationOfLine = [{ LineID: 'G', Stations: st.map((s, i) => ({ Sequence: i + 1, StationID: s.id })) }];
    m.s2s = [{ LineID: 'G', TravelTimes: st.slice(1).map((s, i) => ({ FromStationID: st[i].id, ToStationID: s.id, RunTime: 130, StopTime: 25 })) }];
    m.frequency = [{ LineID: 'G', ServiceDay: ALL, Headways: [{ StartTime: '06:00', EndTime: '07:00', MinHeadwayMins: 8, MaxHeadwayMins: 10 }, { StartTime: '07:00', EndTime: '09:00', MinHeadwayMins: 4, MaxHeadwayMins: 6 }, { StartTime: '09:00', EndTime: '24:00', MinHeadwayMins: 8, MaxHeadwayMins: 10 }] }];
    m.firstLast = st.flatMap((s, i) => [i < st.length - 1 ? { LineID: 'G', StationID: s.id, DestinationStaionID: st[st.length - 1].id, FirstTrainTime: '06:00', LastTrainTime: '24:00', ServiceDay: ALL } : null, i > 0 ? { LineID: 'G', StationID: s.id, DestinationStaionID: st[0].id, FirstTrainTime: '06:00', LastTrainTime: '24:00', ServiceDay: ALL } : null]).filter(Boolean);
  }
  // 固定的起訖點（公尺座標；每一組都落在路網範圍內）
  const od = []; for (let i = 0; i < 40; i++) od.push({ from: ll(R() * (cols - 1) * spacing, R() * (rows - 1) * spacing), to: ll(R() * (cols - 1) * spacing, R() * (rows - 1) * spacing) });
  return { bus: { stopOfRoute, schedule }, metro: m, old: { nodes: oldNodes, adjacency: oldAdj }, od, size: { cols, rows, spacing }, ll };
}
// 道路圖（舊搜尋需要它來投影站牌）：與路口同一個格網，節點座標為 TWD97 公分
export function roadGraphOf(city, lonLatToTWD97) {
  const { cols, rows, spacing } = city.size, nodes = [], edges = [], id = (c, r) => `n${c}_${r}`;
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) { const p = city.ll(c * spacing, r * spacing), [e, n] = lonLatToTWD97(p.lon, p.lat); nodes.push({ id: id(c, r), x: Math.round(e * 100), y: Math.round(n * 100) });
    if (c + 1 < cols) edges.push({ from: id(c, r), to: id(c + 1, r), w: spacing * 100, edgeId: `h${c}_${r}` }); if (r + 1 < rows) edges.push({ from: id(c, r), to: id(c, r + 1), w: spacing * 100, edgeId: `v${c}_${r}` }); }
  return { nodes, edges, roads: {} };
}
