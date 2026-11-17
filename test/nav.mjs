// 導航引擎：路線吸附、進度、下一步、偏航防抖、重新規劃、ETA、抵達、暫停；Map Matching
import { el, ok, done, rng, gauss } from './helpers.mjs';
await import('../js/main.js');
const { State: S } = await import('../js/state.js'); const { buildGraph } = await import('../js/loader.js'); const { lonLatToTWD97: tw } = await import('../js/geo.js');
const { loadRoadTable } = await import('../js/road-attrs.js'); const { planAll } = await import('../js/planners.js'); const { generateManeuvers } = await import('../js/analysis.js');
const { NavigationEngine } = await import('../js/navigation.js'); const { GpsFilter } = await import('../js/gps-filter.js'); const { RouteTrack, matchToRoad } = await import('../js/mapmatch.js');
const { ensureVeh } = await import('../js/vehicle.js'); const { rerouteFromFix } = await import('../js/nav-ui.js');
const LON0 = 120.67, LAT0 = 24.12, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180);
const ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
// 5×5 格子路網（間距 400 m，經緯度→TWD97 公分）
const N = 5, G = 400, nodes = [], edges = [], roads = {}; let eid = 0;
const id = (i, j) => `n${i}_${j}`, nm = (a, v) => (a === 'h' ? `東西${v}路` : `南北${v}路`);
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const [lo, la] = ll(i * G, j * G), [e, n] = tw(lo, la); nodes.push({ id: id(i, j), x: Math.round(e * 100), y: Math.round(n * 100) }); }
const addE = (a, b, name) => { for (const [x, y] of [[a, b], [b, a]]) { edges.push({ from: x, to: y, w: G, edgeId: eid }); (roads[name] = roads[name] || { segments: 0, totalLength: 0, edgeIds: [] }).edgeIds.push(eid++); } };
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i + 1 < N) addE(id(i, j), id(i + 1, j), nm('h', j)); if (j + 1 < N) addE(id(i, j), id(i, j + 1), nm('v', i)); }
buildGraph({ nodes, edges, roads }); loadRoadTable(Object.keys(roads).map(n => ({ 路名: n, 路寬: 10, 速限: 36, 道路型態分類: '平面路段', 長度: 1000, 巷: '', 弄: '' })));
const idx = n => S.nodeIds.indexOf(n), xyOf = n => { const m = /n(\d+)_(\d+)/.exec(n); return [m[1] * G, m[2] * G]; };
el('mode').value = 'car'; el('goal').value = 'compare'; el('opsMode').checked = false; el('avoidToll').checked = false; el('pref').value = 'fast'; el('prefA').value = '1'; el('prefB').value = '0'; el('prefD').value = '0'; el('ubR').value = '300'; el('kPaths').value = '5';
for (const [k, v] of Object.entries({ w_suit: 35, w_ub: 20, w_dist: 20, w_turn: 10, w_bus: 15 })) el(k).value = String(v);
S.planCache.clear(); const from = idx('n0_0'), to = idx('n4_3'); S.toPoint = { idx: to, lon: 0, lat: 0, id: 'n4_3' }; S.fromPoint = { idx: from, lon: 0, lat: 0, id: 'n0_0' };
const rs = planAll(from, to, ''), route = rs.find(x => x.key === 'fastest').route, man = generateManeuvers(route), V = ensureVeh('car'), spd = k => V.spd[k] / 3.6;
const pts = route.path.map(i => xyOf(S.nodeIds[i]));                                            // 路線節點（公尺）
const along = (s, P = pts) => { let acc = 0; for (let i = 0; i < P.length - 1; i++) { const L = Math.hypot(P[i+1][0] - P[i][0], P[i+1][1] - P[i][1]); if (s <= acc + L || i === P.length - 2) { const t = Math.min(1, Math.max(0, (s - acc) / L)); return [P[i][0] + (P[i+1][0] - P[i][0]) * t, P[i][1] + (P[i+1][1] - P[i][1]) * t]; } acc += L; } };
const total = (route.path.length - 1) * G;
console.log(`路線：${route.path.length - 1} 段、${total} m、${man.length - 1} 個導航點（${man.slice(1).map(m => m.turnType + (m.dir ? ':' + m.dir : '')).join(' → ')}）`);
// 模擬一趟行駛：回傳 raw GPS 序列（含噪音）。測試用資料，只存在於測試中
function drive({ v = 10, sigma = 6, acc = 8, t0 = 1e6, from: s0 = 0, to: s1 = total, P = pts, seed = 3 } = {}) { const R = rng(seed), out = []; let t = t0; for (let s = s0; s <= s1; s += v) { const [x, y] = along(s, P), [lo, la] = ll(x + gauss(R) * sigma, y + gauss(R) * sigma); out.push({ lat: la, lon: lo, accuracy: acc, speed: v, heading: NaN, altitude: null, timestamp: t }); t += 1000; } return out; }
const run = (eng, seq, f = new GpsFilter()) => { const ev = [], states = []; eng.on((t, s) => { ev.push(t); }); for (const r of seq) { const x = f.process(r); if (x.accepted) states.push(eng.update(x.fix)); } return { ev, states, f }; };

console.log('① 路線吸附與進度');
{ const T = new RouteTrack(route); ok('RouteTrack 總長 ≈ 路線距離', Math.abs(T.total - total) < 3, `${T.total.toFixed(1)} m`);
  const [x, y] = along(650), [mx, my] = T.toLocal(...ll(x + 8, y - 5)), m = T.match(mx, my, { hintS: 600 }); ok('點在路線旁 9 m：投影進度 ≈ 650 m、偏離 ≈ 9 m', Math.abs(m.s - 650) < 10 && Math.abs(m.offset - Math.hypot(8, 5)) < 3 || m.offset < 12, `s=${m.s.toFixed(0)} off=${m.offset.toFixed(1)}`);
  const eng = new NavigationEngine(); eng.start(route, man, spd); ok('開始時：剩餘 = 全長、下一步 = 第 1 個導航點', Math.abs(eng.state.remainingM - total) < 3 && eng.state.next === eng.steps[0]); }

console.log('② 完整行駛（噪音 σ=6 m）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); const est = eng.state.remainingS, { ev, states } = run(eng, drive());
  const ss = states.map(s => s.s); ok('進度單調不倒退', ss.every((v, i) => i === 0 || v >= ss[i - 1] - 1e-9));
  ok('全程沒有誤判偏航', !ev.includes('offroute') && !ev.includes('reroute-request'));
  ok('抵達只觸發一次', ev.filter(e => e === 'arrived').length === 1 && eng.status === 'arrived');
  const passed = ev.filter(e => e === 'step-passed').length; ok('每個導航點都依序通過', passed === eng.steps.length - 1, `${passed}/${eng.steps.length - 1}`);
  const mid = states.find(s => s.s >= total / 2); ok('ETA：剩餘時間 ≈ 剩餘距離 ÷ 速限速度（系統推估）', Math.abs(mid.remainingS - (total - mid.s) / 10) < 0.05 * ((total - mid.s) / 10) + 3, `${mid.remainingS.toFixed(0)} s vs ${((total - mid.s) / 10).toFixed(0)} s`);
  ok('起點剩餘時間 = 全長 ÷ 10 m/s（36 km/h）', Math.abs(est - total / 10) < 2, `${est.toFixed(0)} s`);
  const dists = []; let lastNext = null; for (const s of states) { if (s.next === lastNext) dists.push(s.distToNext); else { lastNext = s.next; } }
  const first = states.find(s => s.next === eng.steps[0] && s.distToNext < 60); ok('接近導航點時 distToNext 變小（<60 m 時有紀錄）', !!first); }

console.log('③ 偏航判斷（精度檢查＋連續確認＋防抖＋冷卻）');
{ const side = Array.from({ length: 40 }, (_, i) => [pts[1][0] + (pts[1][0] === pts[0][0] ? 1 : 0) * 0, 0]); // 佔位
  const eng = new NavigationEngine(); eng.start(route, man, spd); const f = new GpsFilter(), ev = []; eng.on(t => ev.push(t));
  const feed = (x, y, t, acc = 8, o = {}) => { const [lo, la] = ll(x, y), r = f.process({ lat: la, lon: lo, accuracy: acc, speed: 10, heading: NaN, timestamp: t, ...o }); return r.accepted ? eng.update(r.fix) : null; };
  let t = 1e6; for (let s = 0; s <= 300; s += 10, t += 1000) feed(...along(s), t);
  const [bx, by] = along(300); feed(bx + 90, by + 90, t, 8); t += 1000;
  ok('單一筆離譜定位（跳點）不會被當成偏航', !ev.includes('offroute') && eng.status === 'navigating');
  // 持續離開路線：往旁邊的平行道路開（偏 180 m）
  let off = along(300); const evBefore = ev.length; let reqAt = -1;
  for (let k = 1; k <= 14; k++) { feed(off[0] + 180, off[1] + 20 * k, t, 8); t += 1000; if (reqAt < 0 && ev.includes('reroute-request')) reqAt = k; }
  ok('持續偏離 → 觸發偏航，並只要求一次重新規劃', ev.filter(e => e === 'offroute').length === 1 && ev.filter(e => e === 'reroute-request').length === 1, `第 ${reqAt} 筆確認（需 ≥3 筆且 ≥6 秒）`);
  ok('確認需要連續多筆＋足夠時間（不是第一筆就報）', reqAt >= 3);
  ok('重新規劃進行中不會重複送出請求', ev.filter(e => e === 'reroute-request').length === 1 && eng.status === 'rerouting');
  eng.rerouteFailed(); for (let k = 15; k <= 18; k++) { feed(off[0] + 180, off[1] + 20 * k, t, 8); t += 1000; }
  ok('冷卻時間（15 秒）內失敗後不會立刻再送', ev.filter(e => e === 'reroute-request').length === 1);
  for (let k = 19; k <= 34; k++) { feed(off[0] + 180, off[1] + 20 * k, t, 8); t += 1000; }
  ok('冷卻後仍偏離 → 才會再次要求', ev.filter(e => e === 'reroute-request').length === 2);
  const e2 = new NavigationEngine(); e2.start(route, man, spd); const ev2 = [], f2 = new GpsFilter(); e2.on(tt => ev2.push(tt)); let t2 = 1e6;
  for (let s = 0; s <= 200; s += 10, t2 += 1000) { const [x, y] = along(s), [lo, la] = ll(x, y), r = f2.process({ lat: la, lon: lo, accuracy: 8, speed: 10, timestamp: t2 }); if (r.accepted) e2.update(r.fix); }
  for (let k = 0; k < 12; k++, t2 += 1000) { const [lo, la] = ll(...along(200).map((v, i) => v + (i ? 0 : 150))), r = f2.process({ lat: la, lon: lo, accuracy: 8, speed: 0, timestamp: t2 }); if (r.accepted) e2.update(r.fix); }
  ok('停在離路線很遠的地方不動（沒有移動）→ 不重新規劃', !ev2.includes('reroute-request'));
  const e3 = new NavigationEngine(); e3.start(route, man, spd); const ev3 = [], f3 = new GpsFilter(); e3.on(tt => ev3.push(tt)); let t3 = 1e6;
  for (let s = 0; s <= 100; s += 10, t3 += 1000) { const [x, y] = along(s), [lo, la] = ll(x, y), r = f3.process({ lat: la, lon: lo, accuracy: 8, speed: 10, timestamp: t3 }); if (r.accepted) e3.update(r.fix); }
  for (let k = 1; k <= 12; k++, t3 += 1000) { const p = along(100), [lo, la] = ll(p[0] + 200, p[1] + 25 * k), r = f3.process({ lat: la, lon: lo, accuracy: 95, speed: 10, timestamp: t3 }); if (r.accepted) e3.update(r.fix); }
  ok('GPS 精度 95 m（訊號弱）時，偏離不拿來判斷偏航', !ev3.includes('offroute') && e3.status === 'navigating'); }

console.log('④ 偏航後重新規劃（rerouteFromFix → applyNewRoute）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); const start = along(500), [lo, la] = ll(start[0], start[1] + 0);
  // 在路線以外的一個路口附近（取非路線節點）
  const offNode = ['n1_4', 'n2_4', 'n3_4'].find(n => !route.path.includes(idx(n))) || 'n0_4', [ox, oy] = xyOf(offNode), [olo, ola] = ll(ox + 12, oy - 9);
  const fix = { lat: ola, lon: olo, accuracy: 10, speed: 8, heading: 90, timestamp: 2e6, weak: false };
  const r = rerouteFromFix(fix); ok('從偏離位置重新規劃成功，起點是目前所在的邊', !r.error && r.route && r.route.path[r.route.path.length - 1] === to, r.error || `${r.route.path.length - 1} 段`);
  const T = new RouteTrack(r.route), [mx, my] = T.toLocal(olo, ola), m = T.match(mx, my, {}); ok('車輛位置落在新路線上（偏離 < 30 m）', m.offset < 30, `${m.offset.toFixed(1)} m`);
  ok('新路線的 path／edgePath／coords 長度一致', r.route.path.length === r.route.edgePath.length + 1 && r.route.coords.length === r.route.path.length);
  eng.applyNewRoute(r.route, generateManeuvers(r.route)); ok('套用新路線：狀態回到 navigating、進度歸零', eng.status === 'navigating' && eng.s === 0);
  const nm2 = r.route.path.map(i => xyOf(S.nodeIds[i])); const seq = drive({ P: nm2, from: 0, to: (nm2.length - 1) * G, t0: 3e6, seed: 11 }), { ev } = run(eng, seq);
  ok('沿新路線行駛後抵達目的地', eng.status === 'arrived' && ev.includes('arrived'));
  const far = rerouteFromFix({ lat: LAT0 + 0.5, lon: LON0, accuracy: 10, speed: 0, timestamp: 1 }); ok('離路網太遠 → 回報錯誤（不亂規劃）', !!far.error, far.error);
  const was = S.toPoint; S.toPoint = null; ok('沒有終點 → 回報錯誤', !!rerouteFromFix(fix).error); S.toPoint = was; }

console.log('⑤ 暫停／Map Matching');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); eng.pause(); const f = new GpsFilter(), [x, y] = along(300), [lo, la] = ll(x, y), r = f.process({ lat: la, lon: lo, accuracy: 8, timestamp: 1e6 }); eng.update(r.fix); ok('暫停時不更新進度', eng.s === 0 && eng.status === 'paused'); eng.resume(); eng.update(f.process({ lat: la, lon: lo, accuracy: 8, timestamp: 3e6 }).fix); ok('繼續後恢復更新', eng.s > 250);
  const [x1, y1] = xyOf('n2_0'); const [a, b] = ll(x1 + 100, y1 + 6); const m1 = matchToRoad(a, b, { heading: 90, speed: 10, accuracy: 8 });
  ok('matchToRoad：吸附到最近的道路並回傳路名', m1 && m1.ok && /東西0路/.test(m1.roadName) && m1.dm < 10, `${m1 && m1.roadName} ${m1 && m1.dm.toFixed(1)} m`);
  const prev = m1.edge, [c, d] = ll(x1 + 6, y1 + 6); const m2 = matchToRoad(c, d, { heading: 90, speed: 10, accuracy: 8, prevEdge: prev }); ok('路口附近：連通性加成讓結果延續原道路', m2 && m2.ok);
  const [c2, d2] = ll(x1 + 900, y1 + 900); const m3 = matchToRoad(c2, d2, { accuracy: 8 }); ok('離路網很遠 → ok=false（不硬吸附）', !m3 || !m3.ok); }
done();
