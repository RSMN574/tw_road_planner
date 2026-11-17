// engine.mjs — 伺服器端的路網引擎：沿用網頁的同一套 ES Modules（js/），只是不碰 DOM
// ・Graph Cache：啟動時建圖一次（CSR 陣列常駐記憶體），之後每個請求直接查；資料檔變更可熱重載
// ・查詢參數經由 ctx.withQuery() 提供（取代網頁的表單欄位）；搜尋全程同步執行，請求之間不會互相干擾
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { brotliCompress, gzip, constants as Z } from 'node:zlib';
import path from 'node:path';
import { State } from '../js/state.js';
import { withQuery } from '../js/ctx.js';
import { buildGraphCore } from '../js/graph-build.js';
import { encodePack } from '../js/graph-pack.js';
import { lonLatToWorld, worldToLonLat, worldDistM, isGeo } from '../js/geo.js';
import { edgeRoad, findNearestNode, parseCoordInput } from '../js/graph-core.js';
import { loadRoadTable } from '../js/road-attrs.js';
import { loadBus, loadMetro } from '../js/transit.js';
import { loadUbike } from '../js/ubike.js';
import { planAll } from '../js/planners.js';
import { generateManeuvers } from '../js/analysis.js';
import { matchToRoad } from '../js/mapmatch.js';
import { pickRecommended, suggestBusMulti } from '../js/bus-plan.js';
import { legCoordsOf, routeKindOf } from '../js/bus-core.js';
import { VEHICLES } from '../js/vehicle.js';
import { ALGO } from '../js/constants.js';
import { ApiError } from './http-util.mjs';

const ROAD_MODES = ['car', 'heavy', 'moto', 'bike', 'walk'], ROAD_GOALS = ['compare', 'alt', 'pareto'], TRANSIT_GOALS = ['fastest', 'fewer', 'lesswalk', 'pareto'];
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
let info = { loaded: false }, cfgRef = null, mtimes = '';

// ---------- 載入（Graph Cache）----------
function sig(files) { return [path.join(files.graph, 'nodes.json'), path.join(files.graph, 'edges.json'), path.join(files.graph, 'roads.json'), files.roadTable, files.bus, files.metro, files.youbike].filter(f => f && existsSync(f)).map(f => `${f}:${statSync(f).mtimeMs}:${statSync(f).size}`).join('|'); }
export function loadData(cfg) {
  cfgRef = cfg; const t0 = Date.now(), F = cfg.files, g = n => path.join(F.graph, n + '.json');
  if (!existsSync(g('nodes')) || !existsSync(g('edges'))) throw new Error(`找不到路網：${g('nodes')}、${g('edges')}（請把 nodes.json、edges.json、roads.json 放到 ${F.graph}）`);
  loadGraph(cfg, g);
  const loaded = { roadTable: false, bus: false, metro: false, youbike: false }, warn = [];
  const opt = (k, fn) => { if (!F[k] || !existsSync(F[k])) return; try { fn(readJson(F[k])); loaded[k] = true; } catch (e) { warn.push(`${k}：${e.message}`); } };
  opt('roadTable', loadRoadTable); opt('youbike', loadUbike);
  // 公車與捷運：先放 JSON，最後重建一次（loadBus／loadMetro 各自會重建）
  opt('bus', loadBus); opt('metro', loadMetro);
  State.routerMode = ALGO[cfg.defaultAlgo] ? cfg.defaultAlgo : 'astar'; State.altMax = cfg.altCache || 12;
  mtimes = sig(F);
  const rel = f => f ? path.relative(cfg.dataDir, f).split(path.sep).join('/') : null;
  info = { loaded: true, loadedFrom: pack ? pack.from : 'json', nodes: State.N, edges: State.E, roads: State.roadNames.length, coordType: State.coordType, graphVersion: State.graphVersion, loadedAt: new Date().toISOString(), loadMs: Date.now() - t0,
    data: loaded, warnings: warn, transitStops: State.bus ? State.bus.n : 0,
    files: { roadTable: loaded.roadTable ? 'data/' + rel(F.roadTable) : null, bus: loaded.bus ? 'data/' + rel(F.bus) : null, metro: loaded.metro ? 'data/' + rel(F.metro) : null, youbike: loaded.youbike ? 'data/' + rel(F.youbike) : null } };
  return info;
}
export const dataInfo = () => info;

// ---------- 路網封包（graph.bin）----------
// 網頁優先下載封包（小很多、不必在手機上解析 JSON 與建圖）；伺服器重啟時也直接讀封包，不必再解析 JSON。
// 快取檔名含「路網三檔的大小＋修改時間」：JSON 一有變動就自動重建，舊的封包會被刪掉。
let pack = null;
export const graphPack = () => pack;
function loadGraph(cfg, g) {
  const files = ['nodes', 'edges', 'roads'].map(g).filter(existsSync), src = files.map(f => `${path.basename(f)}:${statSync(f).size}:${Math.floor(statSync(f).mtimeMs)}`).join('|');
  const h = createHash('sha1').update(src).digest('hex').slice(0, 16), dir = cfg.cacheDir, file = path.join(dir, `graph-${h}.bin`);
  let buf = null, from = 'json';
  if (existsSync(file)) { try { buf = readFileSync(file); buildGraphCore({ pack: buf }); from = 'pack'; } catch (e) { console.warn('[路網封包] 讀取失敗，改用 JSON：' + e.message); buf = null; } }
  if (!buf) {
    buildGraphCore({ nodes: readJson(g('nodes')), edges: readJson(g('edges')), roads: existsSync(g('roads')) ? readJson(g('roads')) : [] }, () => { buf = Buffer.from(encodePack({ source: src })); });
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file + '.tmp', buf); renameSync(file + '.tmp', file);
      for (const f of readdirSync(dir)) if (/^graph-[0-9a-f]{16}\.bin$/.test(f) && f !== path.basename(file)) unlinkSync(path.join(dir, f)); } catch (e) { console.warn('[路網封包] 無法寫入快取：' + e.message); }
  }
  const p = { etag: `"g${h}"`, file, bytes: buf.length, from, gz: null, br: null, ready: null };
  // 壓縮在背景執行緒進行，不卡住伺服器；壓好前先送 gzip 以外的原始檔
  p.ready = Promise.all([
    new Promise(r => gzip(buf, { level: 6 }, (e, out) => { if (!e) p.gz = out; r(); })),
    new Promise(r => brotliCompress(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 6, [Z.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e, out) => { if (!e) p.br = out; r(); }))
  ]);
  pack = p; return from;
}
// 預熱：用一條路線把常用交通方式的 ALT 地標先建好（大路網上第一次查詢不用等預處理）
export function warmup(modes = ['car', 'moto', 'bike', 'walk']) {
  if (!info.loaded || State.N < 20000) return 0; const t0 = Date.now(), a = 0, b = Math.max(1, State.N - 1);
  const [lo1, la1] = nodeLL(a), [lo2, la2] = nodeLL(b);
  for (const m of modes) { try { route({ from: `${la1},${lo1}`, to: `${la2},${lo2}`, mode: m, steps: '0' }); } catch {} }
  return Date.now() - t0;
}
export function reloadIfChanged() { if (!cfgRef) return false; const s = sig(cfgRef.files); if (s === mtimes) return false; loadData(cfgRef); return true; }

// ---------- 小工具 ----------
const need = () => { if (!info.loaded) throw new ApiError(503, 'GRAPH_NOT_LOADED', '路網尚未載入'); };
const ll = (x, y) => { const [lon, lat] = worldToLonLat(x, y); return [+lon.toFixed(7), +lat.toFixed(7)]; };
const nodeLL = i => ll(State.nodeXY[i*5+2], State.nodeXY[i*5+3]);
export function parseLatLon(v, name) {
  if (v && typeof v === 'object') { const lat = +v.lat, lon = +(v.lon ?? v.lng); if (isFinite(lat) && isFinite(lon)) return { lat, lon }; }
  const c = typeof v === 'string' ? parseCoordInput(v) : null;
  if (!c || !c.ll) throw new ApiError(400, 'BAD_COORD', `${name} 需要「緯度,經度」（WGS84，例如 24.137,120.686）`, { got: v ?? null });
  return { lat: c.lat, lon: c.lon };
}
function snap(p, name) {
  const [wx, wy] = lonLatToWorld(p.lon, p.lat), idx = findNearestNode(wx, wy);
  if (idx < 0) throw new ApiError(422, 'OUT_OF_COVERAGE', `${name} 附近沒有路網`);
  const d = worldDistM(wx, wy, State.nodeXY[idx*5+2], State.nodeXY[idx*5+3]);
  if (d > cfgRef.maxSnapM) throw new ApiError(422, 'OUT_OF_COVERAGE', `${name} 離最近的道路節點 ${Math.round(d)} m，超出路網範圍（上限 ${cfgRef.maxSnapM} m）`, { distanceM: Math.round(d) });
  return { idx, wx, wy, snapM: Math.round(d), node: State.nodeIds[idx], at: nodeLL(idx) };
}
const bool = v => v === true || v === 1 || /^(1|true|yes|on)$/i.test(String(v ?? ''));
// Douglas–Peucker（以公尺為單位）：路線幾何簡化，減少回傳大小
export function simplify(pts, tolM) {
  if (!(tolM > 0) || pts.length < 3) return pts;
  const lat0 = pts[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110574, P = pts.map(([x, y]) => [x * kx, y * ky]), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = -1, mi = -1; const [ax, ay] = P[a], [bx, by] = P[b], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) { const t = L2 ? Math.max(0, Math.min(1, ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / L2)) : 0, d = Math.hypot(P[i][0] - ax - t * dx, P[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; } }
    if (md > tolM) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}

// ---------- 地理編碼（目前：經緯度／投影座標／路名）----------
export function geocode(q) {
  need(); const s = String(q.q ?? '').trim(); if (!s) throw new ApiError(400, 'MISSING_PARAM', '缺少參數 q');
  const c = parseCoordInput(s);
  if (c) {
    const [wx, wy] = c.ll ? lonLatToWorld(c.lon, c.lat) : [c.lon, c.lat], idx = findNearestNode(wx, wy); if (idx < 0) throw new ApiError(422, 'OUT_OF_COVERAGE', '附近沒有路網');
    const [lon, lat] = c.ll ? [c.lon, c.lat] : ll(wx, wy), m = matchToRoad(lon, lat, { accuracy: 30 });
    return { results: [{ type: 'coordinate', lat, lon, road: m ? m.roadName || null : null, nearestNode: State.nodeIds[idx], nodeAt: nodeLL(idx), distanceToRoadM: m ? Math.round(m.dm) : null }] };
  }
  const lim = Math.min(20, Math.max(1, +q.limit || 10)), hits = State.roadNames.filter(n => n.includes(s)).sort((a, b) => (a === s ? -1 : b === s ? 1 : a.length - b.length)).slice(0, lim);
  return { results: hits.map(name => { const ns = State.roadNameToNodes.get(name) || [], mid = ns[Math.floor(ns.length / 2)]; const [lon, lat] = mid != null ? nodeLL(mid) : [null, null]; return { type: 'road', name, lat, lon, nodes: ns.length }; }),
    note: '路名比對（含子字串）；地址與地標的地理編碼尚未支援' };
}
// ---------- 逆地理編碼：最近的道路 ----------
export function reverse(q) {
  need(); const p = parseLatLon(q.lat != null ? { lat: q.lat, lon: q.lon ?? q.lng } : q.at, 'lat/lon');
  const m = matchToRoad(p.lon, p.lat, { accuracy: Math.min(200, +q.accuracy || 30) });
  if (!m || !m.ok) throw new ApiError(404, 'NO_ROAD_NEARBY', '附近找不到道路', m ? { distanceM: Math.round(m.dm) } : undefined);
  return { road: m.roadName || null, distanceM: Math.round(m.dm), snapped: ll(m.px, m.py), edgeFrom: State.nodeIds[m.u], edgeTo: State.nodeIds[m.v] };
}
// ---------- 附近道路 ----------
export function nearbyRoads(q) {
  need(); const p = parseLatLon(q.lat != null ? { lat: q.lat, lon: q.lon ?? q.lng } : q.at, 'lat/lon'), R = Math.min(2000, Math.max(20, +q.radius || 300));
  const [wx, wy] = lonLatToWorld(p.lon, p.lat), mpw = isGeo() ? 111320 * Math.cos(p.lat * Math.PI / 180) : State.projUnit, cells = Math.ceil(R / mpw / State.GRID) + 1;
  const gx = Math.floor(wx / State.GRID), gy = Math.floor(wy / State.GRID), best = new Map();
  for (let dx = -cells; dx <= cells; dx++) for (let dy = -cells; dy <= cells; dy++) {
    const arr = State.gridIndex.get((gx + dx) + ',' + (gy + dy)); if (!arr) continue;
    for (const i of arr) { const d = worldDistM(wx, wy, State.nodeXY[i*5+2], State.nodeXY[i*5+3]); if (d > R) continue;
      for (let k = State.adjOffset[i]; k < State.adjOffset[i+1]; k++) { const n = edgeRoad(k); if (n && (!best.has(n) || best.get(n) > d)) best.set(n, d); } }
  }
  return { radiusM: R, roads: [...best].sort((a, b) => a[1] - b[1]).slice(0, Math.min(100, +q.limit || 30)).map(([name, d]) => ({ name, distanceM: Math.round(d) })), note: '距離以道路節點估計' };
}

// ---------- 道路路線 ----------
function routeCtx(q, mode) {
  const goal = ROAD_GOALS.includes(q.goal) ? q.goal : 'compare';
  return { mode, goal, opsMode: false, busMode: false, avoidToll: bool(q.avoidToll), pref: q.pref || 'balanced', prefA: q.alpha ?? '', prefB: q.beta ?? '', prefD: q.delta ?? '',
    kPaths: Math.max(2, Math.min(8, +q.k || 5)), ubR: 300, stopGap: 400, w_suit: 35, w_ub: 20, w_dist: 20, w_turn: 10, w_bus: 15 };
}
function serializeRoute(it, q) {
  const r = it.route, tol = q.simplify === undefined ? 2 : Math.max(0, +q.simplify || 0);
  if (!r) return { key: it.key, label: it.label, ok: false, message: it.msg || '找不到路線' };
  const out = { key: it.key, label: it.label, ok: true, distanceM: Math.round(r.distance), durationS: Math.round((it.min || 0) * 60), tollM: Math.round(it.toll || 0), turns: it.turns ?? null,
    roads: it.seq || [], algorithm: it.algo || null, note: it.note || null, estimate: '依速限推估（未含壅塞）' };
  const geom = r.coords.map(([x, y]) => ll(x, y)); out.geometry = simplify(geom, tol); out.geometryPoints = { original: geom.length, simplified: out.geometry.length };
  if (q.steps === undefined || bool(q.steps)) {
    const cum = [0]; for (let i = 0; i < r.edgePath.length; i++) cum.push(cum[i] + State.adjW[r.edgePath[i]]);
    out.steps = generateManeuvers(r).map(m => ({ type: m.turnType, dir: m.dir || null, road: m.roadName || null, angle: m.turnAngle != null ? Math.round(m.turnAngle) : null, at: nodeLL(m.nodeIdx), fromStartM: Math.round(cum[m.index] || 0) }));
  }
  return out;
}
export function route(q) {
  need(); const mode = q.mode || 'car';
  if (mode === 'transit') return transit(q);
  if (!ROAD_MODES.includes(mode)) throw new ApiError(400, 'BAD_MODE', `mode 只能是 ${[...ROAD_MODES, 'transit'].join('、')}`);
  const algo = q.algo && ALGO[q.algo] ? q.algo : (ALGO[cfgRef.defaultAlgo] ? cfgRef.defaultAlgo : 'astar');
  const from = snap(parseLatLon(q.from, 'from'), '起點'), to = snap(parseLatLon(q.to, 'to'), '終點');
  if (from.idx === to.idx) throw new ApiError(422, 'SAME_POINT', '起點與終點吸附到同一個路口');
  const ctx = routeCtx(q, mode), prev = State.routerMode; State.routerMode = algo;
  let items; try { items = withQuery(ctx, () => planAll(from.idx, to.idx, String(q.avoid || '').trim())); } finally { State.routerMode = prev; }
  const routes = items.map(it => serializeRoute(it, q));
  if (!routes.some(r => r.ok)) throw new ApiError(404, 'NO_ROUTE', routes[0]?.message || '找不到路線', { routes });
  return { mode, vehicle: VEHICLES[mode].label, goal: ctx.goal, avoidToll: ctx.avoidToll && mode === 'car', from: { node: from.node, snapM: from.snapM, at: from.at }, to: { node: to.node, snapM: to.snapM, at: to.at }, routes };
}

// ---------- 大眾運輸（公車＋捷運）----------
export function transit(q) {
  need(); if (!State.bus || !State.bus.x) throw new ApiError(503, 'NO_TRANSIT_DATA', '伺服器沒有載入公車或捷運資料（data/bus/graph.json、data/metro.json）');
  const goal = TRANSIT_GOALS.includes(q.goal) ? q.goal : 'fastest', fp = parseLatLon(q.from, 'from'), tp = parseLatLon(q.to, 'to');
  const [fx, fy] = lonLatToWorld(fp.lon, fp.lat), [tx, ty] = lonLatToWorld(tp.lon, tp.lat), b = State.bus;
  const opts = withQuery({ mode: 'transit', goal }, () => suggestBusMulti(fx, fy, tx, ty));
  if (!opts.length || opts[0].error) throw new ApiError(404, 'NO_TRANSIT_ROUTE', (opts[0] && opts[0].error) || '找不到大眾運輸方案');
  const rec = pickRecommended(opts, goal), stop = i => ({ name: b.names[i], lat: +b.lat[i].toFixed(7), lon: +b.lng[i].toFixed(7), kind: b.stopKind[i] });
  return { mode: 'transit', goal, recommended: rec, estimate: '系統推估（公車候車、捷運班距與速度為假設值）；即時到站請用 /tdx 代理查 TDX ETA',
    options: opts.map((o, i) => ({ recommended: i === rec, pareto: !!o.pareto, totalS: Math.round(o.sec), transfers: o.transfers, walkM: Math.round(o.crit?.walk ?? (o.walkIn + o.walkOut)), waitS: Math.round(o.crit?.wait ?? 0),
      walkInM: Math.round(o.walkIn), walkOutM: Math.round(o.walkOut),
      rides: o.rides.map(r => ({ route: r.label, kind: routeKindOf(r), rideS: Math.round(r.sec), from: stop(r.stops[0]), to: stop(r.stops[r.stops.length - 1]), stops: r.stops.length - 1,
        geometry: simplify((legCoordsOf(r) || []).map(([x, y]) => ll(x, y)), 3) })) })) };
}

// ---------- 多運具比較：每種交通方式取最快的一條 ----------
export function multimodal(q) {
  need(); const modes = String(q.modes || 'car,moto,bike,walk,transit').split(',').map(s => s.trim()).filter(m => ROAD_MODES.includes(m) || m === 'transit');
  const out = [];
  for (const m of modes) {
    try {
      if (m === 'transit') { const t = transit({ ...q, goal: 'fastest' }), o = t.options[t.recommended]; out.push({ mode: m, ok: true, durationS: o.totalS, transfers: o.transfers, walkM: o.walkM, summary: o.rides.map(r => r.route).join(' → '), estimate: t.estimate }); }
      else { const r = route({ ...q, mode: m, goal: 'compare', steps: false, simplify: 5 }), f = r.routes.find(x => x.key === 'fastest' && x.ok) || r.routes.find(x => x.ok); out.push({ mode: m, ok: true, durationS: f.durationS, distanceM: f.distanceM, tollM: f.tollM, summary: f.roads.slice(0, 4).join(' → '), geometry: f.geometry, estimate: f.estimate }); }
    } catch (e) { out.push({ mode: m, ok: false, error: { code: e.code || 'ERROR', message: e.message } }); }
  }
  return { options: out.sort((a, b) => (a.ok ? a.durationS : 1e12) - (b.ok ? b.durationS : 1e12)) };
}
