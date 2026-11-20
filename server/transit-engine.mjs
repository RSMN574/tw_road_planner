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
function sliceShape(shapes, stops) {
  if (!shapes || !shapes.length || stops.length < 2) return null;
  const a = stops[0], b = stops[stops.length - 1]; let best = null;
  for (const sh of shapes) for (const line of sh.lines) { const pa = project(line, a.lon, a.lat), pb = project(line, b.lon, b.lat); if (!pa || !pb) continue; const sc = pa.d + pb.d; if (!best || sc < best.sc) best = { sc, line, pa, pb, src: sh.source }; }
  if (!best || best.pa.d > 250 || best.pb.d > 250) return null;
  const { line, pa, pb } = best, fwd = pa.along <= pb.along, [p, q] = fwd ? [pa, pb] : [pb, pa], pt = (x, i, t) => [x[i][0] + (x[i + 1][0] - x[i][0]) * t, x[i][1] + (x[i + 1][1] - x[i][1]) * t];
  const out = [pt(line, p.i, p.t)]; for (let i = p.i + 1; i <= q.i; i++) out.push(line[i]); out.push(pt(line, q.i, q.t));
  if (!fwd) out.reverse();
  return { coords: out, source: best.src };
}

export function makeContext(store, extra = {}, router = null, log = () => {}, opts = {}) {
  const tr = buildTransfers(store, router, { log, ...opts });
  const shapesBy = new Map(); for (const s of extra.shapes || []) { const k = s.op === 'TRTC' || s.op === 'NTMC' ? 'TRTC' : s.op; if (!shapesBy.has(k)) shapesBy.set(k, []); shapesBy.get(k).push(s); }
  // 捷運票價（Metro ODFare：TicketType 1 單程、FareClass 1 成人）
  const mf = new Map(); for (const [op, list] of Object.entries(extra.metroFares || {})) for (const r of list || []) { const f = (r.Fares || []).find(x => Number(x.TicketType) === 1 && Number(x.FareClass) === 1); if (f && Number.isFinite(+f.Price)) mf.set(`${op}|${r.OriginStationID}>${r.DestinationStationID}`, +f.Price); }
  const fareOf = (p, A, B) => {
    if (p.mode === 'thsr') { const e = extra.fares && extra.fares.THSR && extra.fares.THSR.get(`${A.stationId}>${B.stationId}`); return e && e.standard != null ? { price: e.standard, label: '標準車廂成人單程', source: e.source } : null; }
    if (p.mode === 'tra') {
      const e = extra.fares && extra.fares.TRA && extra.fares.TRA.get(`${A.stationId}>${B.stationId}`); if (!e) return null;
      return { price: null, range: [e.min, e.max], label: `票種依車種（${e.types.map(t => t.type + ' ' + t.price).join('、')}）`, source: e.source };    // 不猜哪一種票種對應這班車
    }
    if (p.mode === 'metro' || p.mode === 'lrt') { const v = mf.get(`${p.operator}|${A.stationId}>${B.stationId}`); return v != null ? { price: v, label: '成人單程票', source: `TDX Rail/Metro/ODFare/${p.operator}` } : null; }
    return null;                                                                   // 公車：沒有接 OD 票價資料
  };
  const rideGeometry = (p, stops) => {
    const key = p.operator === 'NTMC' ? 'TRTC' : p.operator, g = (p.mode !== 'bus') && sliceShape(shapesBy.get(key), stops);
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
