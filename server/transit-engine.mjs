// transit-engine.mjs — 全台多運具大眾運輸規劃（v1.11）：把 TDX 快取資料、轉乘、RAPTOR、票價、線型接在一起，給 /api/v1/transit/plan
//
// 在 OSM 道路圖所在的執行緒執行（osm-engine 呼叫），因為起終點與轉乘的步行要用 OSM 步行路網實際走。
// 資料來源：CACHE_DIR/transit（tools/transit-sync.mjs --rail TRA,THSR --operators TRTC,NTMC,… --extras 下載；需要 TDX 金鑰）
// 沒有資料時回 503 TRANSIT_NOT_LOADED，不會假裝有結果。
import path from 'node:path';
import { createTransitData } from './transit/snapshot.mjs';
import { buildTransfers } from './transit/transfer-engine.mjs';
import { planTransit, LEG_TYPE, MODE_LABEL } from './transit/raptor.mjs';
import { ApiError } from './http-util.mjs';
import { MinHeap } from '../js/heap.js';

let td = null, ctx = null, builtKey = '', cfgT = null, injected = false;
export function transitConfigure(cfg) { cfgT = cfg; }
// 測試用：直接給一份資料（store＋extra），不讀快取
export function setTransitData(store, extra = {}, router = null, log = () => {}) { injected = true; ctx = makeContext(store, extra, router, log); builtKey = 'injected'; return ctx.tr.stats; }
export function resetTransit() { injected = false; ctx = null; td = null; builtKey = ''; }

// ---------- 軌道線型：把乘車段切成沿著軌道的線 ----------
function project(line, lon, lat) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110574; let best = null, acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = (line[i][0] - lon) * kx, ay = (line[i][1] - lat) * ky, bx = (line[i + 1][0] - lon) * kx, by = (line[i + 1][1] - lat) * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + dx * t, ay + dy * t);
    if (!best || d < best.d) best = { i, t, d, along: acc + L * t }; acc += L;
  }
  return best;
}
export function sliceShape(shapes, stops) {
  if (!shapes || !shapes.length || stops.length < 2) return null;
  const a = stops[0], b = stops[stops.length - 1]; let best = null;
  for (const sh of shapes) for (const line of sh.lines) { const pa = project(line, a.lon, a.lat), pb = project(line, b.lon, b.lat); if (!pa || !pb) continue; const sc = pa.d + pb.d; if (!best || sc < best.sc) best = { sc, line, pa, pb, src: sh.source }; }
  if (!best || best.pa.d > 250 || best.pb.d > 250) return null;
  const { line, pa, pb } = best, fwd = pa.along <= pb.along, [p, q] = fwd ? [pa, pb] : [pb, pa], pt = (x, i, t) => [x[i][0] + (x[i + 1][0] - x[i][0]) * t, x[i][1] + (x[i + 1][1] - x[i][1]) * t];
  const out = [pt(line, p.i, p.t)]; for (let i = p.i + 1; i <= q.i; i++) out.push(line[i]); out.push(pt(line, q.i, q.t));
  if (!fwd) out.reverse();
  return { coords: out, source: best.src };
}

// GIS 圖資的線型是很多小段（實測：台北捷運一條線 7 段、台鐵更多）；端點相距 < 60 m 的接成一條，乘車段才切得出來
const ptM = (a, b) => Math.hypot((a[0] - b[0]) * 101000, (a[1] - b[1]) * 110600);
export function joinLines(lines, tolM = 60) {
  const rest = lines.map(l => l.slice()), out = [];
  while (rest.length) {
    let cur = rest.shift(), grew = true;
    while (grew) { grew = false;
      for (let i = 0; i < rest.length; i++) { const l = rest[i], h = cur[0], t = cur[cur.length - 1];
        if (ptM(t, l[0]) < tolM) cur = cur.concat(l.slice(1)); else if (ptM(t, l[l.length - 1]) < tolM) cur = cur.concat(l.slice(0, -1).reverse()); else if (ptM(h, l[l.length - 1]) < tolM) cur = l.slice(0, -1).concat(cur); else if (ptM(h, l[0]) < tolM) cur = l.slice(1).reverse().concat(cur); else continue;
        rest.splice(i, 1); grew = true; break; } }
    out.push(cur);
  }
  return out;
}

// 軌道線型網：GIS 圖資的線是很多小段（實測台北捷運淡水信義線 75 段，中間有缺口、雙軌、支線），只把端點接起來不夠。
// 建一個小圖：每個點是頂點、相鄰點相連；每段的端點連到 150 m 內其他段最近的點（補缺口）。乘車段＝相鄰兩站之間的最短路徑逐段接起來（不會走錯支線）
export function railNet(lines) {
  const P = [], adj = [], C = 0.002, grid = new Map(), key = (x, y) => Math.floor(y / C) * 1e6 + Math.floor(x / C);
  const addV = (p, piece) => { const i = P.length; P.push([p[0], p[1], piece]); adj.push([]); const k = key(p[0], p[1]); (grid.get(k) || grid.set(k, []).get(k)).push(i); return i; };
  const link = (a, b) => { const d = ptM(P[a], P[b]); adj[a].push([b, d]); adj[b].push([a, d]); };
  const ends = [];
  lines.forEach((l, pi) => { let prev = -1; l.forEach((p, j) => { const v = addV(p, pi); if (prev >= 0) link(prev, v); prev = v; if (j === 0 || j === l.length - 1) ends.push(v); }); });
  const nearest = (x, y, maxM, skipPiece = -1) => { let b = -1, bd = maxM; const cy = Math.floor(y / C), cx = Math.floor(x / C), r = Math.ceil(maxM / 200); for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) for (const i of grid.get(yy * 1e6 + xx) || []) { if (P[i][2] === skipPiece) continue; const d = ptM(P[i], [x, y]); if (d < bd) { bd = d; b = i; } } return b; };
  // 懸空的端點（150 m 內沒有別段）：補到 3 km 內最近的別段（實測台鐵西部幹線台中附近有 2.8 km 的缺口），補的那一小段是直線
  for (const e of ends) { let n = nearest(P[e][0], P[e][1], 150, P[e][2]); if (n < 0) n = nearest(P[e][0], P[e][1], 3000, P[e][2]); if (n >= 0) link(e, n); }
  // 端點對端點（不同段、1.5 km 內最近的端點）：缺口常在兩段的端點之間，而 150 m 內最近的點可能是旁邊的平行軌或側線
  const endGrid = new Map(); for (const e of ends) { const k = key(P[e][0], P[e][1]); (endGrid.get(k) || endGrid.set(k, []).get(k)).push(e); }
  for (const e of ends) { let b = -1, bd = 1500; const cy = Math.floor(P[e][1] / C), cx = Math.floor(P[e][0] / C); for (let yy = cy - 8; yy <= cy + 8; yy++) for (let xx = cx - 8; xx <= cx + 8; xx++) for (const f of endGrid.get(yy * 1e6 + xx) || []) { if (P[f][2] === P[e][2]) continue; const d = ptM(P[e], P[f]); if (d < bd) { bd = d; b = f; } } if (b >= 0) link(e, b); }
  const path = (a, b, maxM) => {                                            // a、b：[lon, lat]
    const s = nearest(a[0], a[1], 300), t = nearest(b[0], b[1], 300); if (s < 0 || t < 0) return null;
    const dist = new Map([[s, 0]]), prev = new Map(), pq = new MinHeap(64); pq.push(0, s);
    while (pq.n) { const [d, v] = pq.pop(); if (v === t) break; if (d > (dist.get(v) ?? Infinity) || d > maxM) continue; for (const [w, l] of adj[v]) { const nd = d + l; if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, v); pq.push(nd, w); } } }
    if (!dist.has(t)) return null; const out = []; for (let v = t; v !== undefined; v = prev.get(v)) { out.push([P[v][0], P[v][1]]); if (v === s) break; } return out.reverse();
  };
  return { path, size: P.length };
}

export function makeContext(store, extra = {}, router = null, log = () => {}, opts = {}) {
  const tr = buildTransfers(store, router, { log, ...opts });
  const shapesBy = new Map(); for (const s0 of extra.shapes || []) { const s = { ...s0, lines: joinLines(s0.lines) }; const k = s.op === 'TRTC' || s.op === 'NTMC' ? 'TRTC' : s.op; if (!shapesBy.has(k)) shapesBy.set(k, []); shapesBy.get(k).push(s); }
  // 捷運票價（Metro ODFare：TicketType 1 單程、FareClass 1 成人）
  const mf = new Map(); for (const [op, list] of Object.entries(extra.metroFares || {})) for (const r of list || []) { const f = (r.Fares || []).find(x => Number(x.TicketType) === 1 && Number(x.FareClass) === 1); if (f && Number.isFinite(+f.Price)) mf.set(`${op}|${r.OriginStationID}>${r.DestinationStationID}`, +f.Price); }
  const fareOf = (p, A, B, timing) => {
    if (p.mode === 'thsr') { const e = extra.fares && extra.fares.THSR && extra.fares.THSR.get(`${A.stationId}>${B.stationId}`); return e && e.standard != null ? { price: e.standard, label: '標準車廂成人單程', source: e.source } : null; }
    if (p.mode === 'tra') {
      const e = extra.fares && extra.fares.TRA && extra.fares.TRA.get(`${A.stationId}>${B.stationId}`); if (!e) return null;
      // 台鐵 ODFare 的票種（2026-11 實際資料）：[成|孩|愛孩][自|莒|復|普][折]；依台鐵票價規則對應車種：自強／普悠瑪／太魯閣／EMU3000＝自、莒光＝莒、區間／區間快／復興＝復、普快＝普
      const tt = (timing && timing.trainType) || '', cls = /自強|普悠瑪|太魯閣/.test(tt) ? '自' : /莒光/.test(tt) ? '莒' : /區間|復興/.test(tt) ? '復' : /普快/.test(tt) ? '普' : null, hit = cls && e.types.find(t => t.type === '成' + cls);
      if (hit) return { price: hit.price, label: `成人全票（${tt}，票種「成${cls}」）`, source: e.source.replace('（票種依原始資料）', '（車種依台鐵票價規則對應）') };
      return { price: null, range: [e.min, e.max], label: `無法判斷車種「${tt || '未知'}」對應的票種（${e.types.filter(t => t.type.startsWith('成') && !t.type.endsWith('折')).map(t => t.type + ' ' + t.price).join('、')}）`, source: e.source };
    }
    if (p.mode === 'metro' || p.mode === 'lrt') { const v = mf.get(`${p.operator}|${A.stationId}>${B.stationId}`); return v != null ? { price: v, label: '成人單程票', source: `TDX Rail/Metro/ODFare/${p.operator}` } : null; }
    return null;                                                                   // 公車：沒有接 OD 票價資料
  };
  const netBy = new Map();
  const rideGeometry = (p, stops) => {
    // 先在單一路線的線型上切；跨線（例如台鐵山線接縱貫線）切不出來時，用同業者所有線段接起來再切；切出來的長度要合理（≤ 站間直線總長 × 1.8），否則退回直線
    const key = p.operator === 'NTMC' ? 'TRTC' : p.operator; if (p.mode === 'bus') return { coords: stops.map(s => [s.lon, s.lat]), source: '站與站之間直線（公車沒有接線型資料）' };
    let crow = 0; for (let i = 1; i < stops.length; i++) crow += ptM([stops[i - 1].lon, stops[i - 1].lat], [stops[i].lon, stops[i].lat]);
    const okLen = (g, base = crow) => { if (!g) return null; let L = 0; for (let i = 1; i < g.coords.length; i++) L += ptM(g.coords[i - 1], g.coords[i]); return L <= Math.max(500, base * 1.8) ? g : null; };
    if (!netBy.has(key)) netBy.set(key, shapesBy.has(key) ? railNet(shapesBy.get(key).flatMap(x => x.lines)) : null);
    const net = netBy.get(key); let g = null;
    if (net) {                                                                   // 相鄰兩站一段一段找；找不到的那一段用直線並記下（GIS 線型本身有缺口與平行軌）
      const out = [], n = stops.length - 1; let straight = 0;
      for (let i = 1; i <= n; i++) { const a = [stops[i - 1].lon, stops[i - 1].lat], b = [stops[i].lon, stops[i].lat], seg0 = net.path(a, b, ptM(a, b) * 2.5 + 500), seg = seg0 && okLen({ coords: seg0 }, ptM(a, b)) ? seg0 : null; if (!seg) straight++; const add = seg || [a, b]; out.push(...(out.length ? add.slice(1) : add)); }
      if (straight < n) g = { coords: out, source: shapesBy.get(key)[0].source + (straight ? `（${straight}／${n} 段站間找不到線型，用直線）` : ''), straightSegments: straight };
    }
    return g || { coords: stops.map(s => [s.lon, s.lat]), source: '站與站之間直線（沒有線型資料）' };
  };
  return { store, tr, router, delays: extra.delays ? extra.delays.delays : null, fareOf, rideGeometry, extra };
}

function ensure(router) {
  if (injected && ctx) { if (router && !ctx.router) ctx = makeContext(ctx.store, ctx.extra, router); return ctx; }
  if (!cfgT) throw new ApiError(503, 'TRANSIT_NOT_LOADED', '大眾運輸規劃尚未設定');
  if (!td) td = createTransitData({ dir: path.join(cfgT.cacheDir, 'transit'), city: cfgT.transit.city, operators: cfgT.transit.metro, rail: cfgT.transit.rail, extras: true });
  const store = td.store || td.load();
  if (!store) throw new ApiError(503, 'TRANSIT_NOT_LOADED', '伺服器沒有大眾運輸資料：先執行 node tools/transit-sync.mjs --rail TRA,THSR --operators TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT --extras（需要 TDX 金鑰）');
  const key = store.version + '|' + (router ? 'osm' : 'none');
  if (!ctx || builtKey !== key) { ctx = makeContext(store, td.extra, router); builtKey = key; }
  return ctx;
}
// 伺服器啟動時預先建好（全台實測：轉乘約 15 秒，避免第一位使用者等）；沒有資料回傳 false
export function transitPrepare(router) { try { ensure(router); return true; } catch { return false; } }
export function transitStatus() {
  const c = ctx; return { loaded: !!c, injected, version: c ? c.store.version : null, stats: c ? c.store.stats : null, transfers: c ? c.tr.stats : null, detail: c ? c.store.detail || null : null,
    datasets: td ? td.status().datasets : null, warnings: c ? c.store.warnings.slice(0, 50) : [] };
}
// q：from、to（緯度,經度）已解析成 [lat, lon]；departMs；modes（陣列）；maxWalkM；maxTransfers；walkGeometry（預設 true）
export function transitPlan(q, router) {
  const c = ensure(router), modes = (q.modes || []).filter(m => LEG_TYPE[m]);
  const r = planTransit(c, { from: q.from, to: q.to, departMs: q.departMs, modes, maxWalkM: q.maxWalkM ?? (cfgT && cfgT.transit ? cfgT.transit.maxWalkM : 1000), maxTransfers: q.maxTransfers });
  // 步行段的實際路徑（畫地圖用）：起終點在 OSM 步行路網上實際走一次
  if (router && q.walkGeometry !== false) for (const it of r.itineraries.slice(0, 6)) {
    let prev = q.from;
    for (const l of it.legs) {
      const end = l.to && l.to.lat != null ? [l.to.lat, l.to.lon] : l.to && l.to.name === '終點' ? q.to : null;
      if ((l.type === 'WALK' || l.type === 'TRANSFER') && end && prev) { const w = router.route({ from: prev, to: end, profile: 'foot', steps: false }); l.geometry = w.error ? { coords: [[prev[1], prev[0]], [end[1], end[0]]], source: '直線（步行路網找不到路）' } : { coords: w.coords.map(([lo, la]) => [+lo.toFixed(6), +la.toFixed(6)]), source: 'OSM 步行路徑' }; }
      if (l.to && l.to.lat != null) prev = [l.to.lat, l.to.lon]; else if (l.at) prev = [l.at.lat, l.at.lon];
    }
  }
  return { ...r, modeLabels: MODE_LABEL, data: { version: c.store.version, builtAt: c.store.builtAt, transfers: c.tr.stats, injected } };
}
