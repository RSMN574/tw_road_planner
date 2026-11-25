// 導航引擎：路線吸附、進度、下一步、偏航防抖、換新路線、ETA、抵達、暫停
// v1.18：路線改用伺服器 OSM 格式的合成路線（test/osm-route-fixture.mjs → osm.js 的 osmRouteObj），舊的本機路網已移除。
// 偏航後向伺服器重新規劃（osmReroute）的部分在 test/via.mjs 用真的伺服器測。
import { ok, done, rng, gauss } from './helpers.mjs';
await import('../js/main.js');
const { State: S } = await import('../js/state.js'); const { generateManeuvers } = await import('../js/analysis.js');
const { NavigationEngine } = await import('../js/navigation.js'); const { GpsFilter } = await import('../js/gps-filter.js'); const { RouteTrack } = await import('../js/mapmatch.js');
const { EtaModel } = await import('../js/eta-engine.js');
const { gridCity, alongM, lengthM } = await import('./osm-route-fixture.mjs');
S.coordType = 'wgs84';
// 5×5 格子（間距 400 m），路線 (0,0) → (4,0) → (4,3)（BasicModel 沒有每段速度時用 10 m/s）
const C = gridCity({ LON0: 120.67, LAT0: 24.12, sp: 400 }), { ll } = C, G = 400;
const nodes = C.manhattan([[0, 0], [4, 0], [4, 3]]), route = C.route(nodes), man = generateManeuvers(route), pts = C.metersOf(nodes), total = lengthM(pts);
const along = (s, P = pts) => alongM(P, s), spd = null;
console.log(`路線：${nodes.length - 1} 段、${total} m、${man.length - 1} 個導航點（${man.slice(1).map(m => m.turnType + (m.dir ? ':' + m.dir : '')).join(' → ')}）`);
// 模擬一趟行駛：回傳 raw GPS 序列（含噪音）。測試用資料，只存在於測試中
function drive({ v = 10, sigma = 6, acc = 8, t0 = 1e6, from: s0 = 0, to: s1 = total, P = pts, seed = 3 } = {}) { const R = rng(seed), out = []; let t = t0; for (let s = s0; s <= s1; s += v) { const [x, y] = along(s, P), [lo, la] = ll(x + gauss(R) * sigma, y + gauss(R) * sigma); out.push({ lat: la, lon: lo, accuracy: acc, speed: v, heading: NaN, timestamp: t }); t += 1000; } const [x, y] = along(s1, P), [lo, la] = ll(x, y); for (let k = 0; k < 3; k++) { out.push({ lat: la, lon: lo, accuracy: acc, speed: 0, heading: NaN, timestamp: t }); t += 1000; } return out; }
const run = (eng, seq, f = new GpsFilter()) => { const ev = [], states = []; eng.on(t => { ev.push(t); }); for (const r of seq) { const x = f.process(r); if (x.accepted) states.push(eng.update(x.fix)); } return { ev, states, f }; };

console.log('⓪ 路線格式（伺服器 OSM → osmRouteObj）');
ok('coords、_ll、timing 的長度一致；導航點有 start／arrive', route.coords.length === route._ll.length && route._osm.timing.segS.length === route.coords.length - 1 && man[0].turnType === 'start' && man[man.length - 1].turnType === 'arrive');
ok('轉彎方向：往東再往北＝左轉', man.some(m => m.turnType === 'turn' && m.dir === 'left'), man.map(m => m.turnType + (m.dir ? ':' + m.dir : '')).join(' '));

console.log('① 路線吸附與進度');
{ const T = new RouteTrack(route); ok('RouteTrack 總長 ≈ 路線距離', Math.abs(T.total - total) < 3, `${T.total.toFixed(1)} m`);
  const [x, y] = along(650), [mx, my] = T.toLocal(...ll(x + 8, y - 5)), m = T.match(mx, my, { hintS: 600 }); ok('點在路線旁 9 m：投影進度 ≈ 650 m、偏離 ≈ 9 m', Math.abs(m.s - 650) < 10 && Math.abs(m.offset - Math.hypot(8, 5)) < 3 || m.offset < 10, `s=${m.s.toFixed(1)} off=${m.offset.toFixed(1)}`);
  const eng = new NavigationEngine(); eng.start(route, man, spd); ok('開始時：剩餘 = 全長、下一步 = 第 1 個導航點', Math.abs(eng.state.remainingM - total) < 3 && eng.state.next === eng.steps[0]); }

console.log('② 完整行駛（噪音 σ=6 m）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); const est = eng.state.remainingS, { ev, states } = run(eng, drive());
  const ss = states.map(s => s.s); ok('進度單調不倒退', ss.every((v, i) => i === 0 || v >= ss[i - 1] - 1e-9));
  ok('全程沒有誤判偏航', !ev.includes('offroute') && !ev.includes('reroute-request'));
  ok('抵達只觸發一次', ev.filter(e => e === 'arrived').length === 1 && eng.status === 'arrived');
  const passed = ev.filter(e => e === 'step-passed').length; ok('每個導航點都依序通過', passed === eng.steps.length - 1, `${passed}/${eng.steps.length - 1}`);
  const mid = states.find(s => s.s >= total / 2); ok('ETA（後備模型）：剩餘時間 ≈ 剩餘距離 ÷ 10 m/s', Math.abs(mid.remainingS - (total - mid.s) / 10) < 0.05 * ((total - mid.s) / 10) + 3, `${mid.remainingS.toFixed(0)} s vs ${((total - mid.s) / 10).toFixed(0)} s`);
  ok('起點剩餘時間 = 全長 ÷ 10 m/s', Math.abs(est - total / 10) < 2, `${est.toFixed(0)} s`);
  const first = states.find(s => s.next === eng.steps[0] && s.distToNext < 60); ok('接近導航點時 distToNext 變小（<60 m 時有紀錄）', !!first); }

console.log('②b 伺服器的分段時間（EtaModel）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd, { model: (r, t, m) => new EtaModel(r, t, m, 'car') });
  const sr = route._osm; ok('模型總時間 ＝ 伺服器的行駛時間＋路口延遲', Math.abs(eng.model.totalT - sr.durationS) < 2, `${eng.model.totalT.toFixed(0)} s vs ${sr.durationS} s`);
  ok('速限全部已知 → 資料完整度 100%', Math.abs(eng.model.coverage.limitKnown - 1) < 1e-6);
  const { ev } = run(eng, drive({ v: 12 })); ok('用 EtaModel 一樣能走完並抵達', ev.includes('arrived') && eng.status === 'arrived'); }

console.log('③ 偏航判斷（精度檢查＋連續確認＋防抖＋冷卻）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); const f = new GpsFilter(), ev = []; eng.on(t => ev.push(t));
  const feed = (x, y, t, acc = 8, o = {}) => { const [lo, la] = ll(x, y), r = f.process({ lat: la, lon: lo, accuracy: acc, speed: 10, heading: NaN, timestamp: t, ...o }); return r.accepted ? eng.update(r.fix) : null; };
  let t = 1e6; for (let s = 0; s <= 300; s += 10, t += 1000) feed(...along(s), t);
  const [bx, by] = along(300); feed(bx + 90, by + 90, t, 8); t += 1000;
  ok('單一筆離譜定位（跳點）不會被當成偏航', !ev.includes('offroute') && eng.status === 'navigating');
  const off = along(300); let reqAt = -1;
  for (let k = 1; k <= 14; k++) { feed(off[0] + 20 * k, off[1] + 180, t, 8); t += 1000; if (reqAt < 0 && ev.includes('reroute-request')) reqAt = k; }
  ok('持續偏離 → 觸發偏航，並只要求一次重新規劃', ev.filter(e => e === 'offroute').length === 1 && ev.filter(e => e === 'reroute-request').length === 1, `第 ${reqAt} 筆確認（需 ≥3 筆且 ≥6 秒）`);
  ok('確認需要連續多筆＋足夠時間（不是第一筆就報）', reqAt >= 3);
  ok('重新規劃進行中不會重複送出請求', ev.filter(e => e === 'reroute-request').length === 1 && eng.status === 'rerouting');
  eng.rerouteFailed(); for (let k = 15; k <= 18; k++) { feed(off[0] + 20 * k, off[1] + 180, t, 8); t += 1000; }
  ok('冷卻時間（15 秒）內失敗後不會立刻再送', ev.filter(e => e === 'reroute-request').length === 1);
  for (let k = 19; k <= 34; k++) { feed(off[0] + 20 * k, off[1] + 180, t, 8); t += 1000; }
  ok('冷卻後仍偏離 → 才會再次要求', ev.filter(e => e === 'reroute-request').length === 2);
  const e2 = new NavigationEngine(); e2.start(route, man, spd); const ev2 = [], f2 = new GpsFilter(); e2.on(tt => ev2.push(tt)); let t2 = 1e6;
  for (let s = 0; s <= 200; s += 10, t2 += 1000) { const [x, y] = along(s), [lo, la] = ll(x, y), r = f2.process({ lat: la, lon: lo, accuracy: 8, speed: 10, timestamp: t2 }); if (r.accepted) e2.update(r.fix); }
  for (let k = 0; k < 12; k++, t2 += 1000) { const p = along(200), [lo, la] = ll(p[0], p[1] + 150), r = f2.process({ lat: la, lon: lo, accuracy: 8, speed: 0, timestamp: t2 }); if (r.accepted) e2.update(r.fix); }
  ok('停在離路線很遠的地方不動（沒有移動）→ 不重新規劃', !ev2.includes('reroute-request'));
  const e3 = new NavigationEngine(); e3.start(route, man, spd); const ev3 = [], f3 = new GpsFilter(); e3.on(tt => ev3.push(tt)); let t3 = 1e6;
  for (let s = 0; s <= 100; s += 10, t3 += 1000) { const [x, y] = along(s), [lo, la] = ll(x, y), r = f3.process({ lat: la, lon: lo, accuracy: 8, speed: 10, timestamp: t3 }); if (r.accepted) e3.update(r.fix); }
  for (let k = 1; k <= 12; k++, t3 += 1000) { const p = along(100), [lo, la] = ll(p[0] + 25 * k, p[1] + 200), r = f3.process({ lat: la, lon: lo, accuracy: 95, speed: 10, timestamp: t3 }); if (r.accepted) e3.update(r.fix); }
  ok('GPS 精度 95 m（訊號弱）時，偏離不拿來判斷偏航', !ev3.includes('offroute') && e3.status === 'navigating'); }

console.log('④ 偏航後換成新路線（applyNewRoute）');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); const ev = []; eng.on(t => ev.push(t));
  // 車子開到 (1,1)（不在原路線上）；伺服器回來的新路線從 (1,1) 到終點 (4,3)
  const n2 = C.manhattan([[1, 1], [4, 1], [4, 3]]), r2 = C.route(n2), p2 = C.metersOf(n2), L2 = lengthM(p2);
  const T = new RouteTrack(r2), [mx, my] = T.toLocal(...ll(400 + 12, 400 - 9)), m = T.match(mx, my, {}); ok('車輛位置落在新路線上（偏離 < 30 m）', m.offset < 30, `${m.offset.toFixed(1)} m`);
  ok('新路線的終點 ＝ 原本的終點', Math.abs(r2._ll[r2._ll.length - 1][0] - route._ll[route._ll.length - 1][0]) < 1e-9 && Math.abs(r2._ll[r2._ll.length - 1][1] - route._ll[route._ll.length - 1][1]) < 1e-9);
  eng.applyNewRoute(r2, generateManeuvers(r2)); ok('套用新路線：狀態回到 navigating、進度歸零、發出 rerouted', eng.status === 'navigating' && eng.s === 0 && ev.includes('rerouted'));
  const { ev: ev2 } = run(eng, drive({ P: p2, from: 0, to: L2, t0: 3e6, seed: 11 }));
  ok('沿新路線行駛後抵達目的地', eng.status === 'arrived' && ev2.includes('arrived')); }

console.log('⑤ 暫停');
{ const eng = new NavigationEngine(); eng.start(route, man, spd); eng.pause(); const f = new GpsFilter(), [x, y] = along(300), [lo, la] = ll(x, y), r = f.process({ lat: la, lon: lo, accuracy: 8, timestamp: 1e6 }); eng.update(r.fix);
  ok('暫停時不更新進度', eng.s === 0 && eng.status === 'paused');
  eng.resume(); eng.update(f.process({ lat: la, lon: lo, accuracy: 8, timestamp: 1e6 + 1000 }).fix); ok('繼續後恢復更新', eng.status === 'navigating' && eng.s > 200, `s=${eng.s.toFixed(0)}`); }
done();
