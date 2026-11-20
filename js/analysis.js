// analysis.js
import { Hooks, State } from './state.js';
import { speedText } from './vehicle.js';
import { CLS, COS30, hlCache } from './constants.js';
import { isGeo, nodeDist, worldDistM, worldHaversine } from './geo.js';
import { edgeRoad, ensureFrom } from './graph-core.js';
import { ensureRA } from './road-attrs.js';
import { ubNear } from './ubike.js';
import { busNearIdx } from './bus-core.js';
import { qv } from './ctx.js';

export function buildAvoidSet(q) {
  const set = new Set();
  for (const [eid, ns] of State.edgeIdToRoadNames) for (const n of ns) if (n.includes(q)) { set.add(eid); break; }
  return set;
}

export function roadSeqOf(r) {
  if (r._osm) { const s = []; for (const n of r._osm.roads || []) if (s[s.length - 1] !== n) s.push(n); return s; }   // 伺服器 OSM 路線
  const seq = []; let last = null;
  for (const k of r.edgePath) { const n = edgeRoad(k); if (n && n !== last) { seq.push(n); last = n; } }
  return seq;
}

// 世界座標 y 向上：cross>0 為逆時針 = 左轉；cross<0 = 右轉

export function generateManeuvers(route) {
  if (route._osm) return route._man || [];                     // 伺服器 OSM 路線：導航步驟由伺服器算好（osm.js 轉換）
  const { path, edgePath, coords } = route;
  if (path.length < 2) return [];
  const kx = isGeo() ? Math.cos(coords[0][1] * Math.PI/180) : 1;
  const steps = [{ index: 0, nodeIdx: path[0], roadName: edgeRoad(edgePath[0]), turnAngle: 0, turnType: 'start', dir: '', distanceFromPrev: 0, spd: speedText(edgePath[0]) }];
  let acc = 0;
  for (let i = 1; i < path.length - 1; i++) {
    acc += State.adjW[edgePath[i-1]];
    const v1x = (coords[i][0] - coords[i-1][0]) * kx, v1y = coords[i][1] - coords[i-1][1];
    const v2x = (coords[i+1][0] - coords[i][0]) * kx, v2y = coords[i+1][1] - coords[i][1];
    if ((!v1x && !v1y) || (!v2x && !v2y)) continue;
    const ang = Math.atan2(v1x*v2y - v1y*v2x, v1x*v2x + v1y*v2y) * 180 / Math.PI;
    const a = Math.abs(ang), inN = edgeRoad(edgePath[i-1]), outN = edgeRoad(edgePath[i]);
    if (a <= 30 && inN === outN) continue;                       // 夾角 ≤30° 且路名沒變 → 不是 maneuver
    steps.push({ index: i, nodeIdx: path[i], roadName: outN, turnAngle: ang,
      turnType: a < 30 ? 'straight' : a < 60 ? 'slight' : a < 120 ? 'turn' : a < 150 ? 'sharp' : 'uturn',
      dir: a < 30 ? '' : ang > 0 ? 'left' : 'right', distanceFromPrev: acc, spd: speedText(edgePath[i]) });
    acc = 0;
  }
  acc += State.adjW[edgePath[path.length - 2]];
  steps.push({ index: path.length - 1, nodeIdx: path[path.length-1], roadName: edgeRoad(edgePath[edgePath.length-1]),
               turnAngle: 0, turnType: 'arrive', dir: '', distanceFromPrev: acc, spd: '' });
  return steps;
}

export function segmentsOf(route) {         // 涵蓋所有邊（含無路名段）；len 單位：projected 用 adjW，wgs84 用 haversine
  if (route._segs) return route._segs;
  if (route._osm) return route._segs = osmSegments(route);
  const segs = [], ep = route.edgePath, n = ep.length;
  let cur = '', st = 0;
  for (let i = 0; i < n; i++) {
    const name = edgeRoad(ep[i]);
    if (i === 0) cur = name;
    else if (name !== cur) { segs.push({ name: cur, start: st, end: i }); cur = name; st = i; }
  }
  if (n) segs.push({ name: cur, start: st, end: n });
  for (const sg of segs) {
    let len = 0;
    for (let i = sg.start; i < sg.end; i++) len += isGeo() ? nodeDist(route.path[i], route.path[i+1]) : State.adjW[ep[i]];
    sg.len = len;
  }
  return route._segs = segs;
}

// 伺服器 OSM 路線：依每段所屬的 way 路名分段（start／end 是 coords 的段號，與本機路線相同）；len 用大圓距離
function osmSegments(route) {
  const sr = route._osm, T = sr.timing || {}, sw = T.segWay || [], ll = route._ll, segs = [], nm = i => { const w = sr.ways[sw[i]]; return w ? (w.name || w.ref || '') : ''; };
  let cur = '', st = 0;
  for (let i = 0; i < sw.length; i++) { const n = nm(i); if (!i) cur = n; else if (n !== cur) { segs.push({ name: cur, start: st, end: i }); cur = n; st = i; } }
  if (sw.length) segs.push({ name: cur, start: st, end: sw.length });
  for (const sg of segs) { let len = 0; for (let i = sg.start; i < sg.end; i++) len += worldHaversine(ll[i][0], ll[i][1], ll[i + 1][0], ll[i + 1][1]); sg.len = len; }
  return segs;
}

export function roadEdges(name) {           // 該路所有邊（兩端都屬於該路節點、且邊的路名不與之矛盾）
  let arr = hlCache.get(name);
  if (arr) return arr;
  const nodes = State.roadNameToNodes.get(name) || [], set = new Set(nodes), out = [];
  for (const u of nodes) {
    for (let k = State.adjOffset[u]; k < State.adjOffset[u+1]; k++) {
      const v = State.adjTo[k];
      if (v <= u || !set.has(v)) continue;
      const ns = State.adjEid[k] != null ? State.edgeIdToRoadNames.get(State.adjEid[k]) : null;
      if (!ns || ns.has(name)) out.push(u, v);
    }
  }
  arr = Int32Array.from(out); hlCache.set(name, arr);
  return arr;
}

// ============================================================
// 路線分析指標：適宜性、未知比例、待確認道路、YouBike 覆蓋（站點去重）
// ============================================================

export function routeMetrics(r) {
  if (r._osm) return null;                                     // 伺服器 OSM 路線：沒有本機的道路屬性（適宜性等）
  const ra = ensureRA(), ep = r.edgePath, met = { len: 0, suit: 0, unkLen: 0, forbN: 0, confirm: new Map(), ub: null };
  let sl = 0;
  for (const k of ep) {
    const L = State.adjW[k]; met.len += L; sl += ra.suit[k] * L;
    if (ra.forb[k]) met.forbN++;
    if (ra.unk[k]) { met.unkLen += L; const n = edgeRoad(k) || '（無路名）'; met.confirm.set(n, (met.confirm.get(n) || 0) + L); }
  }
  met.suit = met.len ? sl / met.len : 0; met.unkRatio = met.len ? met.unkLen / met.len : 0;
  met.confirmList = [...met.confirm].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, l]) => `${n}（${Math.round(l)} m）`);
  if (State.UB && State.UB.x) {
    const R = (+qv('ubR', 300) || 300), ids = new Set(), c = r.coords;
    for (let i = 0; i < c.length - 1; i++) {                        // 沿路線每 ≤R/2 公尺取樣，同一站只算一次
      const d = worldDistM(c[i][0], c[i][1], c[i+1][0], c[i+1][1]), steps = Math.max(1, Math.ceil(d / (R / 2)));
      for (let s = 0; s <= steps; s++) { const t = s / steps; for (const j of ubNear(c[i][0] + (c[i+1][0]-c[i][0])*t, c[i][1] + (c[i+1][1]-c[i][1])*t, R)) ids.add(j); }
    }
    let cap = 0; for (const j of ids) cap += State.UB.cap[j];
    met.ub = { count: ids.size, cap, R };
  }
  if (State.bus && State.bus.x) { const ids = new Set(); for (const [x, y] of routePts(r, 75)) for (const j of busNearIdx(x, y, 150)) ids.add(j); met.bus = { count: ids.size }; }
  return met;
}

export function routePts(r, stepM) {                      // 沿路線每 ≤stepM 公尺取樣
  const c = r.coords, out = [];
  for (let i = 0; i < c.length - 1; i++) {
    const d = worldDistM(c[i][0], c[i][1], c[i+1][0], c[i+1][1]), n = Math.max(1, Math.ceil(d / stepM));
    for (let s = 0; s <= n; s++) out.push([c[i][0] + (c[i+1][0]-c[i][0])*s/n, c[i][1] + (c[i+1][1]-c[i][1])*s/n]);
  }
  return out;
}

export function edgeCov(k, kind) {                         // 邊兩端點＋中點附近的站點數（0..3 / 0..2），以邊索引記憶化
  const isU = kind === 'ub', M = isU ? (State.UBC = State.UBC && State.UBC.length === State.adjTo.length ? State.UBC : new Uint8Array(State.adjTo.length)) : (State.BSC = State.BSC && State.BSC.length === State.adjTo.length ? State.BSC : new Uint8Array(State.adjTo.length));
  let c = M[k]; if (c) return c - 1;
  const u = ensureFrom()[k], v = State.adjTo[k], ids = new Set(), R = isU ? (+qv('ubR', 300) || 300) : 150;
  for (const [x, y] of [[State.nodeXY[u*5+2], State.nodeXY[u*5+3]], [(State.nodeXY[u*5+2]+State.nodeXY[v*5+2])/2, (State.nodeXY[u*5+3]+State.nodeXY[v*5+3])/2], [State.nodeXY[v*5+2], State.nodeXY[v*5+3]]])
    for (const j of (isU ? ubNear(x, y, R) : busNearIdx(x, y, R))) ids.add(j);
  c = Math.min(isU ? 3 : 2, ids.size); M[k] = c + 1; return c;
}

export function countTurns(r) {                            // 內部節點前後方向夾角 > 30°
  const c = r.coords, kx = isGeo() ? Math.cos(c[0][1] * Math.PI/180) : 1; let t = 0;
  for (let i = 1; i < c.length - 1; i++) {
    const ax = (c[i][0]-c[i-1][0])*kx, ay = c[i][1]-c[i-1][1], bx = (c[i+1][0]-c[i][0])*kx, by = c[i+1][1]-c[i][1], al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
    if (al > 0 && bl > 0 && ax*bx + ay*by < COS30*al*bl) t++;
  }
  return t;
}

export function getW() {
  const g = id => Math.max(0, +qv(id, { w_suit: 35, w_ub: 20, w_dist: 20, w_turn: 10, w_bus: 15 }[id]) || 0), w = { suit: g('w_suit'), ub: g('w_ub'), dist: g('w_dist'), turn: g('w_turn'), bus: g('w_bus') };
  return (w.suit + w.ub + w.dist + w.turn + w.bus) > 0 ? w : { suit: 35, ub: 20, dist: 20, turn: 10, bus: 15 };
}

// 各項正規化到 0～100；缺資料的項目不計入（權重重新正規化），不當作滿分

export function scoreRoutes(items) {
  const W = getW(), L = items.filter(x => x.route); if (!L.length) return;
  const minD = Math.min(...L.map(x => x.route.distance)), minT = Math.min(...L.map(x => x.turns));
  const hasUb = L.every(x => x.met.ub), hasBus = L.every(x => x.met.bus);
  const maxU = Math.max(...L.map(x => x.met.ub ? x.met.ub.count : 0)), maxB = Math.max(...L.map(x => x.met.bus ? x.met.bus.count : 0));
  const names = { suit: '道路適宜性', ub: 'YouBike 覆蓋', dist: '路線較短', turn: '轉彎少', bus: '涵蓋既有公車站牌' }, noAttr = ensureRA().nWithAttr === 0;
  for (const x of L) {
    const c = { suit: x.met.suit, dist: 100 * minD / Math.max(x.route.distance, 1e-9), turn: 100 * (minT + 1) / (x.turns + 1),
                ub: hasUb ? (maxU > 0 ? 100 * x.met.ub.count / maxU : 0) : null, bus: hasBus ? (maxB > 0 ? 100 * x.met.bus.count / maxB : 0) : null };
    let a = 0, d = 0; for (const k in c) if (c[k] != null) { a += W[k] * c[k]; d += W[k]; }
    x.score = { total: d > 0 ? a / d : 0, comp: c, skipped: [hasUb ? '' : 'YouBike', hasBus ? '' : '既有公車站牌'].filter(Boolean) };
  }
  const best = L.reduce((a, b) => (b.score.total > a.score.total ? b : a));
  for (const x of L) {
    x.score.best = x === best;
    const top = Object.entries(x.score.comp).filter(([k, v]) => v != null && W[k] > 0).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${names[k]} ${Math.round(v)}`);
    const warn = [x.met.unkRatio > 0.2 ? `⚠ 未知屬性 ${Math.round(x.met.unkRatio * 100)}%，需人工確認` : '', noAttr ? '⚠ 尚未載入路寬／型態，適宜性僅為預設值' : ''].filter(Boolean);
    x.score.reasons = (x === best ? '推薦原因：' : '強項：') + top.join('、') + (warn.length ? '　' + warn.join('　') : '');
  }
}

export function rescore() { const L = State.routeSet.filter(x => x.route && x.score); if (L.length) { scoreRoutes(L); Hooks.renderRouteList(); Hooks.renderAnalysis(); } }

// ============================================================
// 階段 4：公車站點候選選擇與站距（站距一律用沿路網累積距離，不用直線距離）
// ============================================================

export function suggestStops(route, S) {
  const ra = ensureRA(), P = route.path, ep = route.edgePath, c = route.coords, n = P.length;
  if (n < 2) return null;
  const cum = new Float64Array(n); for (let i = 1; i < n; i++) cum[i] = cum[i-1] + State.adjW[ep[i-1]];
  const hasUb = !!(State.UB && State.UB.x), hasBus = !!(State.bus && State.bus.x), kx = isGeo() ? Math.cos(c[0][1] * Math.PI/180) : 1, cand = new Array(n);
  for (let i = 0; i < n; i++) {
    const v = P[i], [x, y] = c[i], deg = State.adjOffset[v+1] - State.adjOffset[v]; let major = false;
    for (let k = State.adjOffset[v]; k < State.adjOffset[v+1]; k++) if (ra.cls[k] === CLS.major || ra.width[k] >= 12) major = true;
    const ub = hasUb ? ubNear(x, y, 100).length : 0, ex = hasBus ? busNearIdx(x, y, 50).length : 0;
    const suit = Math.min(i > 0 ? ra.suit[ep[i-1]] : 100, i < n - 1 ? ra.suit[ep[i]] : 100);
    let turn = 0;
    if (i > 0 && i < n - 1) {
      const ax = (c[i][0]-c[i-1][0])*kx, ay = c[i][1]-c[i-1][1], bx = (c[i+1][0]-c[i][0])*kx, by = c[i+1][1]-c[i][1], al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
      if (al > 0 && bl > 0) turn = Math.acos(Math.max(-1, Math.min(1, (ax*bx + ay*by) / (al*bl)))) * 180 / Math.PI;
    }
    let sc = 30; const why = [], warn = [];                         // 初始啟發式評分（非通行/需求判定）
    if (ex) { sc += 40; why.push('現有站牌'); }
    if (ub) { sc += Math.min(30, 10 * ub); why.push(`YouBike×${ub}`); }
    if (deg >= 3) { if (major) { sc += 20; why.push('主要道路路口'); } else { sc += 10; why.push('路口'); } }
    if (suit < 50) { sc -= 20; warn.push('道路適宜性低／屬性待確認'); }
    if (turn > 60) { sc -= 15; warn.push('急轉彎處'); }
    cand[i] = { score: Math.max(0, Math.min(100, sc)), why, warn };
  }
  const minG = 0.5 * S, maxG = 1.5 * S, sel = [0]; let last = 0;
  for (;;) {
    const rem = cum[n-1] - cum[last]; let best = -1, bs = -Infinity;
    for (let i = last + 1; i < n - 1; i++) {
      const g = cum[i] - cum[last]; if (g < minG) continue; if (g > maxG) break;
      if (cum[n-1] - cum[i] < minG) continue;                                   // 不讓最後一段短於最小站距
      if (rem <= maxG && !(cand[i].score >= 70 || cand[i].why.includes('現有站牌'))) continue;   // 剩餘夠短時，只有高分或現有站牌才值得再插一站
      const sc = cand[i].score - Math.abs(g - S) / S * 10;                      // 偏離目標站距略扣分
      if (sc > bs) { bs = sc; best = i; }
    }
    if (best < 0) {
      if (rem <= maxG) break;                                                   // 直接接終點
      for (let i = last + 1; i < n - 1; i++) if (cum[i] - cum[last] >= minG) { best = i; break; }   // 長邊視窗內無節點 → 取第一個超過最小站距者
      if (best < 0) break;
    }
    sel.push(best); last = best;
  }
  sel.push(n - 1);
  if (sel.length > 2 && cum[n-1] - cum[sel[sel.length-2]] < minG && cand[sel[sel.length-2]].score < 70) sel.splice(sel.length - 2, 1);
  const stops = sel.map((i, q) => ({ q: q + 1, i, node: P[i], x: c[i][0], y: c[i][1], dist: cum[i], gap: q ? cum[i] - cum[sel[q-1]] : 0,
    name: edgeRoad(ep[Math.min(i, n - 2)]) || '（無路名）', ...cand[i] }));
  const gaps = stops.slice(1).map(s => s.gap);
  return { stops, S, minGap: Math.min(...gaps), maxGap: Math.max(...gaps), avgGap: gaps.reduce((a, b) => a + b, 0) / gaps.length,
           existing: stops.filter(s => s.why.includes('現有站牌')).length, warned: stops.filter(s => s.warn.length).length };
}

export function stopsOf(route) {
  if (route._osm) return null;                                 // 公車站點建議需要本機路網
  const S = Math.max(150, +qv('stopGap', 400) || 400), key = `${S}|${State.UB ? State.UB.n : 0}|${State.bus ? State.bus.n : 0}|${State.RA ? State.RA.m : 0}`;
  if (route._stopsKey !== key) { route._stops = suggestStops(route, S); route._stopsKey = key; }
  return route._stops;
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  for (const id of ['w_suit', 'w_ub', 'w_dist', 'w_turn', 'w_bus']) document.getElementById(id).addEventListener('input', rescore);
}
