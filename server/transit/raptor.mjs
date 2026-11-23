// raptor.mjs — TransitRouter（v1.11）：多運具時刻表路由（公車、捷運、輕軌、台鐵、高鐵）
//
// 演算法：RAPTOR（Delling et al. 2012；以「轉乘輪數」為回合的動態規劃），每一輪＝多搭一段車：
//   ・有班次時刻（台鐵、高鐵、公車班表）：依營運日的班次群組（同一群組不超車）二分搜尋最早可搭的一班 —— 時間相依（Time-dependent）
//   ・捷運／輕軌：有「站別時刻表」就用該站的實際發車時刻；沒有就用班距（候車取平均班距的一半，標示「依班距推估」）；兩者都沒有＝資訊不足，不搭
//   ・每輪之後做一次步行轉乘（TransferEngine 的 OSM 步行路徑／TDX 站內轉乘）
//   ・起點、終點：步行可達的站（OSM 步行路網上實際走，不是直線）
// 輸出：各輪數的最早抵達 → Pareto（抵達時間 × 轉乘次數）；再用較短的步行上限跑一次得到「少步行」候選；
//       依最快、最少轉乘、最少步行、最低票價（所有乘車段都有票價資料時）、綜合建議 標記
// 為什麼不是 CSA：CSA 要把所有班次攤平成依時間排序的連線（connection），全台公車＋台鐵班次很多、記憶體與排序成本高；
//   RAPTOR 直接用 timetable-store 已經排好的班次群組，而且天然得到「轉乘次數」這個維度（McRAPTOR 的子集）。
import { DAY_S, dateStrOf, midnightMs, addDays, runsOn } from './time.mjs';
import { MIN_CHANGE_S, STATION_ACCESS_S, KIND } from './transfer-engine.mjs';

export const LEG_TYPE = { bus: 'BUS_RIDE', metro: 'METRO_RIDE', lrt: 'LIGHT_RAIL_RIDE', tra: 'TRAIN_RIDE', thsr: 'THSR_RIDE' };
export const MODE_LABEL = { bus: '公車', metro: '捷運', lrt: '輕軌', tra: '台鐵', thsr: '高鐵' };
const WALK_MPS = 1.2;
const hav = (a, b, c, d) => { const R = Math.PI / 180, h = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))); };

// 起點／終點到附近各站的步行（秒、公尺、來源）
function walkTo(ctx, pt, maxWalkS) {
  const { store, tr, router } = ctx, maxM = maxWalkS * WALK_MPS, res = new Map(), cand = tr.grid.near(pt[0], pt[1], maxM);
  const acc = i => STATION_ACCESS_S[store.stops[i].mode] ?? 0;
  if (router) {
    const sn = router.footSnap(pt[0], pt[1], 500);
    if (sn) { const R = router.footReach(sn, { maxS: maxWalkS }); for (const [i] of cand) { const r = tr.snaps[i] ? R.at(tr.snaps[i]) : null; if (r) res.set(i, { s: r.s + acc(i), m: r.m, kind: 0 }); } return { res, snapped: true, snapM: Math.round(sn.snapM) }; }
  }
  for (const [i, d] of cand) res.set(i, { s: Math.round(d * 1.35 / WALK_MPS) + acc(i), m: Math.round(d * 1.35), kind: 2 });
  return { res, snapped: false };
}

// 捷運／輕軌（沒有班次時刻的型態）：在 pos 站、時間 need 之後的發車
function boardNoTrips(ctx, p, pos, date, need) {
  const { store } = ctx, sd = p.stationDeps && p.stationDeps[pos];
  if (sd && sd.length) {
    const sure = sd.filter(x => runsOn(x.days, date) === true), use = sure.length ? sure : sd.filter(x => runsOn(x.days, date) !== false);
    let best = Infinity; for (const x of use) { const a = x.deps; let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] >= need) hi = m; else lo = m + 1; } if (lo < a.length && a[lo] < best) best = a[lo]; }
    return best < Infinity ? { dep: best, kind: 'stationTimetable', dayUncertain: !sure.length, source: use[0] && use[0].source } : null;
  }
  const f = store.freqAt(p.index, date, need); if (!f) return null;
  const sv = store.serviceState(p.index, pos, date, need); if (sv.state === 'closed') return null;
  const mean = (f.minS + f.maxS) / 2; return { dep: Math.round(need + mean / 2), kind: 'frequency', headwayS: [f.minS, f.maxS], dayUncertain: f.dayUncertain, source: f.source, serviceUnknown: sv.state === 'unknown' };
}

// 標籤分兩種（McRAPTOR 常見做法）：搭車抵達（R）與步行抵達（W）。步行轉乘只從「搭車抵達」出發，
// 所以兩者要分開比較——否則一個較早的「步行抵達」會擋掉較晚的「搭車抵達」，而後者才能再步行轉到別的路線（轉乘集合不是遞移封閉的）
function raptor(ctx, { t0, date, views, access, egress, maxRounds, modes, fpMaxS }) {
  const { store, tr } = ctx, N = store.stops.length, K = maxRounds + 1, bestR = new Float64Array(N).fill(Infinity), bestW = new Float64Array(N).fill(Infinity);
  const tauR = [], tauW = [], parR = [], parW = []; for (let k = 0; k <= K; k++) { tauR.push(new Float64Array(N).fill(Infinity)); tauW.push(new Float64Array(N).fill(Infinity)); parR.push(new Map()); parW.push(new Map()); }
  let marked = new Set(), target = Infinity;
  for (const [i, a] of access) { const t = t0 + a.s; tauW[0][i] = t; bestW[i] = t; parW[0].set(i, { t: 'access', s: a.s, m: a.m, kind: a.kind }); marked.add(i); }
  const tgt = () => { let b = Infinity; for (const [i, e] of egress) for (let k = 0; k <= K; k++) { const v = tauR[k][i] + e.s; if (v < b) b = v; } return b; };
  const delayOf = (p, id) => { if (p.mode !== 'tra' || !ctx.delays) return 0; const d = ctx.delays.get(String(id).replace(/^TRA-/, '')); return d ? d.delayMin * 60 : 0; };
  for (let k = 1; k <= K && marked.size; k++) {
    const Q = new Map();                                                         // 型態 → 最早要掃的位置
    for (const s of marked) for (const [pi, pos] of store.stopPatterns[s]) { const p = store.patterns[pi]; if (!modes.has(p.mode)) continue; const q = Q.get(pi); if (q === undefined || pos < q) Q.set(pi, pos); }
    const pR = tauR[k - 1], pW = tauW[k - 1], newR = new Set(), newW = new Set();
    // 上一輪在 s 的最早時間與來源；搭車抵達的要預留換車時間
    const from = s => { const r = pR[s] + (pR[s] < Infinity ? (MIN_CHANGE_S[store.stops[s].mode] ?? 60) : 0), w = pW[s]; return r <= w ? { t: r, src: 'R' } : { t: w, src: 'W' }; };
    const relax = (s, at, info) => { if (at < bestR[s] && at < target) { tauR[k][s] = at; bestR[s] = at; parR[k].set(s, info); newR.add(s); } };
    for (const [pi, pos0] of Q) {
      const p = store.patterns[pi], S = p.stopIdx.length;
      let scanned = false;
      for (const v of views) {
        const D = v.day, gs = D.groupsOf[pi]; if (!gs || !gs.length) continue; scanned = true;
        for (const gi of gs) {
          const g = D.groups[gi]; let trip = -1, bpos = -1, dly = 0, bsrc = 'W';
          for (let i = pos0; i < S; i++) {
            const s = p.stopIdx[i];
            if (trip >= 0) { const a = g.arr[trip * S + i]; if (a !== store.UNKNOWN) relax(s, a + v.shift + dly, { t: 'ride', pi, view: v.date, shift: v.shift, gi, trip, bpos, apos: i, dly, src: bsrc }); }
            if (i === S - 1) continue; const f = from(s); if (f.t === Infinity) continue;
            const tt = store.earliest(g, i, f.t - v.shift);
            if (tt >= 0 && g.dep[tt * S + i] !== store.UNKNOWN && (trip < 0 || g.dep[tt * S + i] < g.dep[trip * S + i])) { trip = tt; bpos = i; dly = delayOf(p, g.ids[tt]); bsrc = f.src; }
          }
        }
      }
      if (scanned || !p.offArr) continue;
      // 沒有班次時刻的捷運／輕軌：站別時刻表或班距
      let curDep = Infinity, bpos = -1, meta = null, bsrc = 'W';
      for (let i = pos0; i < S; i++) {
        const s = p.stopIdx[i];
        if (bpos >= 0) { const off = p.offArr[i] - p.offDep[bpos]; if (Number.isFinite(off)) relax(s, curDep + off, { t: 'ride', pi, view: date, shift: 0, gi: -1, bpos, apos: i, dep: curDep, board: meta, src: bsrc }); }
        if (i === S - 1 || !Number.isFinite(p.offDep[i])) continue; const f = from(s); if (f.t === Infinity) continue;
        const c = boardNoTrips(ctx, p, i, date, f.t); if (!c) continue;
        if (bpos < 0 || c.dep < curDep + (p.offDep[i] - p.offDep[bpos])) { curDep = c.dep; bpos = i; meta = c; bsrc = f.src; }
      }
    }
    // 步行轉乘：只從這一輪「搭車抵達」的站出發（不連續走兩段）
    for (const s of newR) for (let q = tr.start[s]; q < tr.start[s + 1]; q++) {
      const sec = tr.sec[q]; if (sec > fpMaxS && tr.kind[q] !== 1) continue;
      const j = tr.to[q], at = tauR[k][s] + sec;
      if (at < bestW[j] && at < bestR[j] && at < target) { tauW[k][j] = at; bestW[j] = at; parW[k].set(j, { t: 'walk', from: s, s: sec, m: tr.m[q] >= 0 ? tr.m[q] : null, kind: tr.kind[q], meta: tr.meta.get(q) || null }); newW.add(j); }
    }
    target = Math.min(target, tgt()); marked = new Set([...newR, ...newW]);
  }
  const run = { tauR, tauW, parR, parW, K }; if (ctx.debug) (ctx._runs ||= []).push(run);
  return run;
}

// ---------- 結果：分段 ----------
const iso = (date, sec) => new Date(midnightMs(date) + sec * 1000).toISOString();
function legsOf(ctx, run, k, s) {
  const { store } = ctx, legs = []; let cur = s, kk = k, kind = 'R', guard = 0;
  while (guard++ < 50) {
    const pr = (kind === 'R' ? run.parR : run.parW)[kk].get(cur); if (!pr) return null;
    if (pr.t === 'access') { legs.unshift({ type: 'WALK', role: 'access', toStop: cur, s: pr.s, m: pr.m, source: KIND[pr.kind] }); break; }
    if (pr.t === 'walk') { const tdx = pr.kind === 1 || pr.kind === 3; legs.unshift({ type: tdx ? 'TRANSFER' : 'WALK', role: 'transfer', fromStop: pr.from, toStop: cur, s: pr.s, m: pr.m, source: pr.meta ? pr.meta.source : KIND[pr.kind], onSite: pr.meta ? pr.meta.onSite : null }); cur = pr.from; kind = 'R'; continue; }
    const p = store.patterns[pr.pi], S = p.stopIdx.length, boardStop = p.stopIdx[pr.bpos];
    let dep, arr, tripId = null, trainNo = null, timing;
    if (pr.gi >= 0) { const D = store.day(pr.view), g = D.groups[pr.gi]; dep = g.dep[pr.trip * S + pr.bpos] + pr.shift + pr.dly; arr = g.arr[pr.trip * S + pr.apos] + pr.shift + pr.dly; tripId = g.ids[pr.trip]; const t = p.trips.find(x => x.id === tripId); trainNo = t ? t.trainNo || null : null; timing = { kind: g.src === 'daily' ? 'daily' : 'schedule', estimated: !!(g.flags[pr.trip] & 1), dayUncertain: !!(g.flags[pr.trip] & 2), trainType: t ? t.trainType : null, headsign: t ? t.headsign : null, delayMin: pr.dly ? pr.dly / 60 : 0 }; }
    else { dep = pr.dep; arr = pr.dep + (p.offArr[pr.apos] - p.offDep[pr.bpos]); timing = { kind: pr.board.kind, estimated: pr.board.kind === 'frequency' || p.runEstimated > 0, headwayS: pr.board.headwayS || null, dayUncertain: !!pr.board.dayUncertain, runSource: p.runSource }; }
    legs.unshift({ type: LEG_TYPE[p.mode] || 'RIDE', mode: p.mode, pi: pr.pi, fromStop: boardStop, toStop: p.stopIdx[pr.apos], bpos: pr.bpos, apos: pr.apos, depS: dep, arrS: arr, tripId, trainNo, timing });
    cur = boardStop; kk--; kind = pr.src;
  }
  return legs;
}
function finishItinerary(ctx, legs, { date, t0, egress, lastStop, departMs }) {
  const { store } = ctx, out = [], st = i => { const s = store.stops[i]; return { uid: s.uid, name: s.name, mode: s.mode, lat: s.lat, lon: s.lon, stationId: s.stationId ?? s.stopId ?? null, operator: s.operator ?? null }; };
  const rides = legs.filter(l => l.depS != null), first = rides[0]; if (!first) return null;
  const access = legs[0], startS = first.timing.kind === 'frequency' ? Math.min(t0, first.depS - access.s) : first.depS - access.s;                       // 建議出發時間：剛好走到車站搭第一班（一定不早於查詢時間）
  let t = startS, walkM = 0, walkS = 0, waitS = 0, fareTotal = 0, fareOk = true; const fares = [], notes = new Set(), modes = [];
  for (const l of legs) {
    if (l.depS == null) {                                                         // 步行／轉乘
      const from = l.fromStop != null ? st(l.fromStop) : { name: '起點' }, to = st(l.toStop);
      out.push({ type: l.type, from, to, departAt: iso(date, t), arriveAt: iso(date, t + l.s), durationS: l.s, distanceM: l.m, source: l.source, onSite: l.onSite ?? null, estimated: l.source !== KIND[0] && l.source !== KIND[1] });
      walkM += l.m || 0; walkS += l.s; t += l.s; continue;
    }
    const p = store.patterns[l.pi], w = l.depS - t;
    if (w >= 30) { out.push({ type: 'WAIT', at: st(l.fromStop), departAt: iso(date, t), arriveAt: iso(date, l.depS), durationS: Math.round(w) }); waitS += w; }
    const stops = []; for (let i = l.bpos; i <= l.apos; i++) stops.push(st(p.stopIdx[i]));
    const fare = ctx.fareOf ? ctx.fareOf(p, store.stops[l.fromStop], store.stops[l.toStop], l.timing) : null; if (fare && Number.isFinite(fare.price)) { fareTotal += fare.price; fares.push(fare); } else fareOk = false;
    if (l.timing.estimated) notes.add(l.timing.kind === 'frequency' ? `${MODE_LABEL[p.mode]}${p.name ? ' ' + p.name : ''}：沒有時刻表，候車時間依班距推估` : `${MODE_LABEL[p.mode]}${p.name ? ' ' + p.name : ''}：部分站間時間是推估`);
    if (l.timing.dayUncertain) notes.add(`${MODE_LABEL[p.mode]}${p.name ? ' ' + p.name : ''}：資料沒有註明適用星期`);
    if (l.timing.delayMin) notes.add(`台鐵 ${l.trainNo} 次即時誤點 ${l.timing.delayMin} 分（已計入）`);
    modes.push(p.mode);
    out.push({ type: l.type, mode: p.mode, operator: p.operator, routeName: p.name, routeUID: p.routeUID, direction: p.direction, headsign: l.timing.headsign || p.headsign || null, tripId: l.tripId, trainNo: l.trainNo, trainType: l.timing.trainType || null,
      from: st(l.fromStop), to: st(l.toStop), departAt: iso(date, l.depS), arriveAt: iso(date, l.arrS), durationS: Math.round(l.arrS - l.depS), stops: stops.length - 1, stopList: stops, timing: l.timing, fare,
      geometry: ctx.rideGeometry ? ctx.rideGeometry(p, stops) : { coords: stops.map(s => [s.lon, s.lat]), source: '站與站之間直線（沒有線型資料）' } });
    t = l.arrS;
  }
  const eg = egress.get(lastStop); out.push({ type: 'WALK', from: st(lastStop), to: { name: '終點' }, departAt: iso(date, t), arriveAt: iso(date, t + eg.s), durationS: eg.s, distanceM: eg.m, source: KIND[eg.kind], estimated: eg.kind !== 0 });
  walkM += eg.m || 0; walkS += eg.s; t += eg.s;
  const transfers = Math.max(0, rides.length - 1);
  return { departAt: iso(date, startS), arriveAt: iso(date, t), durationS: Math.round(t - startS), totalFromRequestS: Math.round(t - t0), waitS: Math.round(waitS), walkM: Math.round(walkM), walkS: Math.round(walkS), transfers, modes: [...new Set(modes)],
    fare: fares.length ? { total: fareOk ? fareTotal : null, known: fares.length, rides: rides.length, complete: fareOk, currency: 'TWD', note: fareOk ? '各段單程票價加總（未含轉乘優惠）' : '有乘車段沒有票價資料（例如公車），不計算總價' } : null,
    legs: out, notes: [...notes], estimated: out.some(l => l.estimated || (l.timing && l.timing.estimated)), _key: rides.map(l => `${l.pi}:${l.bpos}:${l.apos}:${l.tripId ?? l.depS}`).join('|') };
}

// ---------- 對外 ----------
// q：{ from: [lat, lon], to: [lat, lon], departMs, maxWalkM（預設 1000）, maxTransfers（預設 4）, modes（陣列，預設全部） }
export function planTransit(ctx, q) {
  const { store } = ctx, departMs = q.departMs ?? Date.now(), date = dateStrOf(departMs), t0 = Math.round((departMs - midnightMs(date)) / 1000);
  const modes = new Set(q.modes && q.modes.length ? q.modes : Object.keys(LEG_TYPE)), maxRounds = Math.max(1, Math.min(6, q.maxTransfers ?? 4) + 1);
  const views = [{ date, shift: 0, day: store.day(date) }]; if (t0 < 6 * 3600) { const pd = addDays(date, -1); views.push({ date: pd, shift: -DAY_S, day: store.day(pd) }); }   // 凌晨：前一個營運日的 24:xx 班次
  const runOnce = (maxWalkM, fpMaxS) => {
    const A = walkTo(ctx, q.from, maxWalkM / WALK_MPS), E = walkTo(ctx, q.to, maxWalkM / WALK_MPS);
    if (!A.res.size || !E.res.size) return { its: [], A, E };
    const run = raptor(ctx, { t0, date, views: views.map(v => ({ date: v.date, shift: v.shift, day: v.day })), access: A.res, egress: E.res, maxRounds, modes, fpMaxS });
    const its = [];
    for (let k = 1; k <= run.K; k++) {
      let bs = -1, bt = Infinity; for (const [i, e] of E.res) { const v = run.tauR[k][i] + e.s; if (v < bt) { bt = v; bs = i; } }
      if (bs < 0) continue; const legs = legsOf(ctx, run, k, bs); if (!legs) continue;
      const it = finishItinerary(ctx, legs, { date, t0, egress: E.res, lastStop: bs, departMs }); if (it) its.push(it);
    }
    return { its, A, E };
  };
  const main = runOnce(q.maxWalkM ?? 1000, 600), lessWalk = runOnce(Math.min(500, q.maxWalkM ?? 1000), 300);
  // 合併、去重；Pareto（抵達 × 轉乘 × 步行）
  const all = new Map(); for (const it of [...main.its, ...lessWalk.its]) if (!all.has(it._key)) all.set(it._key, it);
  let list = [...all.values()];
  // 去掉繞回同一站的方案（例如搭出去再搭回來只為了少走幾步，實測資料會出現），再取 Pareto：步行少不到 300 m 不算「比較好」
  const loops = it => { const seen = new Set(); for (const l of it.legs) if (l.type.endsWith('_RIDE')) { for (const s of [l.from.uid, l.to.uid]) { if (seen.has(s) && s !== l.from.uid) return true; } seen.add(l.from.uid); seen.add(l.to.uid); } return false; };
  list = list.filter(it => !loops(it));
  const WALK_TOL = 300, dom = (b, a) => b.arriveAt <= a.arriveAt && b.transfers <= a.transfers && b.walkM <= a.walkM + WALK_TOL && (b.arriveAt < a.arriveAt || b.transfers < a.transfers || b.walkM < a.walkM - WALK_TOL);
  list = list.filter(a => !list.some(b => b !== a && dom(b, a)));
  const tag = (name, fn) => { if (!list.length) return; const b = list.reduce((x, y) => (fn(y) < fn(x) ? y : x)); (b.tags ||= []).push(name); };
  const arr = it => Date.parse(it.arriveAt);
  tag('fastest', it => arr(it)); tag('fewestTransfers', it => it.transfers * 1e10 + arr(it)); const fast = list.length ? Math.min(...list.map(arr)) : 0;
  tag('leastWalking', it => (arr(it) - fast > 30 * 60e3 ? 1e12 : 0) + it.walkM * 1e4 + arr(it) / 1e3);
  if (list.some(it => it.fare && it.fare.complete)) tag('cheapest', it => (it.fare && it.fare.complete ? it.fare.total : 1e9) * 1e10 + arr(it));
  tag('recommended', it => it.totalFromRequestS + 300 * it.transfers + 1.5 * it.walkS + 0.5 * it.waitS);
  list.sort((a, b) => arr(a) - arr(b) || a.transfers - b.transfers);
  for (const it of list) { it.tags ||= []; delete it._key; }
  // 只走路（起終點很近時）
  let walkOnly = null; const crow = hav(q.from[0], q.from[1], q.to[0], q.to[1]);
  if (crow <= (q.maxWalkM ?? 1000) * 1.5 && ctx.router) { const r = ctx.router.route({ from: q.from, to: q.to, profile: 'foot' }); if (!r.error) walkOnly = { distanceM: r.distanceM, durationS: r.durationS, geometry: r.coords }; }
  const info = {}; for (const v of views) { const by = {}; v.day.info.forEach((x, pi) => { if (modes.has(store.patterns[pi].mode)) by[x] = (by[x] || 0) + 1; }); info[v.date] = by; }
  return { itineraries: list, walkOnly, request: { date, departAt: new Date(departMs).toISOString(), modes: [...modes], maxWalkM: q.maxWalkM ?? 1000, maxTransfers: maxRounds - 1 },
    access: { stops: main.A.res.size, snapped: main.A.snapped }, egress: { stops: main.E.res.size, snapped: main.E.snapped }, serviceInfo: info,
    notes: [!main.A.res.size ? `起點 ${q.maxWalkM ?? 1000} m 步行範圍內沒有車站／站牌` : '', !main.E.res.size ? `終點 ${q.maxWalkM ?? 1000} m 步行範圍內沒有車站／站牌` : ''].filter(Boolean) };
}
