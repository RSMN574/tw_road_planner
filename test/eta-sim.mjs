// eta-sim.mjs — 可重現的導航模擬（固定亂數種子），用來量 ETA 與剩餘距離的誤差
//
// 「地面真值」是模擬的行駛過程（所有數字都是測試假設，不是真實路況）：
//   ・每條路段的實際巡航速度＝速限 ×（情境指定的隨機比例）——與 ETA 模型的參數無關，各自獨立抽樣
//   ・號誌：四岔以上路口有 90 秒週期、綠燈 45%，到達時剛好紅燈就等到綠燈（＋起步損失 4 秒）；三岔路口 40% 機率小等
//   ・轉彎：左轉多等 6～16 秒、右轉 2～6 秒、迴轉 15～30 秒
//   ・情境：壅塞（某段速度只剩 35～55%，模型不知道）、塞車停等、GPS 跳點、GPS 中斷、偏離路線
// v1.18：路線是伺服器 OSM 格式的合成路線（test/osm-route-fixture.mjs），舊的本機路網已移除
// GPS：每秒一筆，雜訊 σ=4 m，沒有速度與方向（很多手機在市區就是這樣），由 GpsFilter 推算
import { rng, gauss } from './helpers.mjs';
import { gridCity } from './osm-route-fixture.mjs';

export const LON0 = 120.62, LAT0 = 24.13, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180);
export const ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];

// 格子城市（test/osm-route-fixture.mjs）：每 4 條是主要道路（50 km/h），第 2、6… 條是次要道路（30），其餘一般道路（40）
// 路口用名稱 'n<i>_<j>'；routeOf(名稱序列, 運具) → 網頁的 route 物件（伺服器 OSM 格式，時間依該運具）
export function makeCity(M, { n = 14, sp = 250 } = {}) {
  const C = gridCity({ LON0, LAT0, sp, n }), { id, parse } = C;
  const xy = s => { const [i, j] = parse(s); return [i * sp, j * sp]; };
  const routeOf = (ids, vk = 'car') => { const r = C.route(ids.map(parse), { vk }); r.ids = ids; return r; };
  // 曼哈頓路線（先東西再南北），或依指定轉折點 → 路口名稱
  const manhattan = pts => C.manhattan(pts).map(([i, j]) => id(i, j));
  return { n, sp, id, xy, parse, routeOf, manhattan, C, freeMps: C.freeMps };
}

// 地面真值：沿路線（路口名稱）的行駛時間表
export function truthDrive(M, city, ids, { seed = 1, flow = [0.55, 0.9], vk = 'car', congest = null, jamAt = null, jamS = 0 } = {}) {
  const R = rng(seed), nodes = ids.map(city.parse), P = ids.map(city.xy), n = ids.length;
  const seg = [];                                                       // { s0, s1, t0, t1 }（行駛）或停等（s0 === s1）
  let s = 0, t = 0;
  for (let i = 0; i < n - 1; i++) {
    const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]), lim = city.C.roadOf(nodes[i], nodes[i + 1]).kmh;
    let v = vk === 'walk' ? 1.1 + R() * 0.3 : vk === 'bike' ? 3.5 + R() * 1.5 : (Math.min(lim, vk === 'moto' ? 50 : 999) / 3.6) * (flow[0] + R() * (flow[1] - flow[0]));
    if (congest && s / ((n - 1) * city.sp) >= congest[0] && s / ((n - 1) * city.sp) <= congest[1] && vk !== 'walk') v *= 0.35 + R() * 0.2;
    if (jamAt != null && s <= jamAt * (n - 1) * city.sp && s + L > jamAt * (n - 1) * city.sp) { const sj = jamAt * (n - 1) * city.sp, d1 = sj - s; seg.push({ s0: s, s1: sj, t0: t, t1: t + d1 / v }); t += d1 / v; seg.push({ s0: sj, s1: sj, t0: t, t1: t + jamS }); t += jamS; seg.push({ s0: sj, s1: s + L, t0: t, t1: t + (L - d1) / v }); t += (L - d1) / v; }
    else { seg.push({ s0: s, s1: s + L, t0: t, t1: t + L / v }); t += L / v; }
    s += L;
    if (i + 1 < n - 1) {                                                 // 路口：號誌與轉向
      const a = P[i], b = P[i + 1], c = P[i + 2], cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), turn = Math.abs(cr) < 1e-6 ? ((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0 ? 'u' : 's') : cr > 0 ? 'l' : 'r';
      let w = 0; const deg = city.C.deg(nodes[i + 1]);
      if (deg >= 4) { const ph = R() * 90; if (ph < 49.5) w += 49.5 - ph + (vk === 'walk' ? 0 : 4); }
      else if (deg === 3 && R() < 0.4) w += R() * 8;
      if (vk !== 'walk') w += turn === 'l' ? 6 + R() * 10 : turn === 'r' ? 2 + R() * 4 : turn === 'u' ? 15 + R() * 15 : 0;
      if (w > 0) { seg.push({ s0: s, s1: s, t0: t, t1: t + w }); t += w; }
    }
  }
  const at = tt => { for (const g of seg) if (tt <= g.t1) { const f = g.t1 > g.t0 ? (tt - g.t0) / (g.t1 - g.t0) : 1; return { s: g.s0 + (g.s1 - g.s0) * f, moving: g.s1 > g.s0 }; } return { s, moving: false }; };
  const pos = sv => { let acc = 0; for (let i = 0; i < n - 1; i++) { const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); if (sv <= acc + L || i === n - 2) { const f = Math.min(1, Math.max(0, (sv - acc) / L)); return [P[i][0] + (P[i + 1][0] - P[i][0]) * f, P[i][1] + (P[i + 1][1] - P[i][1]) * f]; } acc += L; } return P[n - 1]; };
  return { T: t, L: s, at, pos };
}

// 跑一趟：engine＝已 start 的引擎；回傳每筆的（真值、預估）與統計
export function runTrip(M, truth, engine, { seed = 7, sigma = 4, t0 = 1.7e12, jumps = [], lostFrom = null, lostS = 0, filter = true, minRemS = 60, raw = false } = {}) {
  const R = rng(seed), f = new M.GpsFilter(), rows = [];
  for (let k = 0; k <= Math.ceil(truth.T) + 5; k++) {
    const tt = Math.min(k, truth.T), { s } = truth.at(tt), [x, y] = truth.pos(s);
    if (lostFrom != null && k >= lostFrom && k < lostFrom + lostS) { if (k === lostFrom + 12) engine.markGpsLost && engine.markGpsLost(t0 + k * 1000); continue; }
    let px = x + gauss(R) * sigma, py = y + gauss(R) * sigma;
    const j = jumps.find(q => q.k === k); if (j) { if (j.along != null) [px, py] = truth.pos(Math.min(truth.L, s + j.along)); else { px += j.dx || 0; py += j.dy || 0; } }
    const [lo, la] = ll(px, py), fix = { lat: la, lon: lo, accuracy: 6 + R() * 4, speed: null, heading: NaN, altitude: null, timestamp: t0 + k * 1000 };
    let st;
    if (filter && !raw) { const r = f.process(fix); if (!r.accepted) continue; st = engine.update(r.fix); }
    else st = engine.update({ ...fix, heading: null, weak: false });
    if (!st) continue;
    rows.push({ k, tRem: Math.max(0, truth.T - tt), sRem: Math.max(0, truth.L - s), pRem: (st.etaMs - (t0 + k * 1000)) / 1000, rawRem: st.rawRemainingS ?? st.remainingS, dRem: st.remainingM, eta: st.etaMs, status: st.status, conf: st.eta ? st.eta.confidence : null, low: st.eta ? st.eta.lowS : null, high: st.eta ? st.eta.highS : null });
    if (st.status === 'arrived') break;
  }
  return { rows, stats: stats(rows, minRemS) };
}
export function stats(rows, minRemS = 60) {
  const r = rows.filter(x => x.tRem >= minRemS), ae = r.map(x => Math.abs(x.pRem - x.tRem)), pe = r.map(x => Math.abs(x.pRem - x.tRem) / x.tRem), de = rows.map(x => Math.abs(x.dRem - x.sRem));
  const jumps = []; for (let i = 1; i < rows.length; i++) jumps.push(Math.abs(rows[i].eta - rows[i - 1].eta) / 1000);
  const inside = r.filter(x => x.low != null && x.tRem >= x.low && x.tRem <= x.high).length;
  const avg = a => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN), mx = a => (a.length ? Math.max(...a) : NaN), sorted = jumps.slice().sort((a, b) => a - b);
  return { n: r.length, maeS: avg(ae), mape: avg(pe) * 100, bias: avg(r.map(x => x.pRem - x.tRem)), distMaeM: avg(de), distMaxM: mx(de), etaJumpP95S: sorted[Math.floor(sorted.length * 0.95)] || 0, etaJumpMaxS: mx(jumps), coverage: r.length ? inside / r.length * 100 : NaN };
}
export const fmt = s => `MAE ${s.maeS.toFixed(0)} 秒、MAPE ${s.mape.toFixed(1)}%、偏差 ${s.bias >= 0 ? '+' : ''}${s.bias.toFixed(0)} 秒｜剩餘距離誤差 平均 ${s.distMaeM.toFixed(1)} m、最大 ${s.distMaxM.toFixed(0)} m｜ETA 每筆跳動 P95 ${s.etaJumpP95S.toFixed(0)} 秒、最大 ${s.etaJumpMaxS.toFixed(0)} 秒${isFinite(s.coverage) ? `｜真值落在估計區間內 ${s.coverage.toFixed(0)}%` : ''}`;
