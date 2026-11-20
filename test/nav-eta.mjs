// nav-eta.mjs — 導航 ETA、剩餘距離、相機：12 項情境＋與舊版（test/fixtures/legacy-navigation.mjs）比較誤差
// 地面真值與 GPS 都是模擬的（見 eta-sim.mjs），固定種子，可重現。數字只代表這套模擬，不代表真實道路。
import { ok, done } from './helpers.mjs';
await import('../js/main.js');
const M = { S: (await import('../js/state.js')).State, buildGraph: (await import('../js/loader.js')).buildGraph, loadRoadTable: (await import('../js/road-attrs.js')).loadRoadTable,
  tw: (await import('../js/geo.js')).lonLatToTWD97, ensureRA: (await import('../js/road-attrs.js')).ensureRA, GpsFilter: (await import('../js/gps-filter.js')).GpsFilter };
const { makeCity, truthDrive, runTrip, stats, fmt, ll } = await import('./eta-sim.mjs');
const { NavigationEngine } = await import('../js/navigation.js'), { NavigationEngine: Legacy } = await import('./fixtures/legacy-navigation.mjs');
const { EtaModel, EtaSmoother } = await import('../js/eta-engine.js'), { FLOW } = await import('../js/eta-params.js'), { generateManeuvers } = await import('../js/analysis.js'), { ensureVeh } = await import('../js/vehicle.js');
const { CameraController } = await import('../js/camera.js'), { EdgeHistory } = await import('../js/trip-log.js'), { rerouteFromFix } = await import('../js/nav-ui.js');
const quiet = f => { const a = console.info, b = console.warn; console.info = console.warn = () => {}; try { return f(); } finally { console.info = a; console.warn = b; } };
const city = quiet(() => makeCity(M, { n: 14 })), S = M.S;
const mk = (route, vk = 'car', o = {}) => { const V = ensureVeh(vk), e = new NavigationEngine(); e.start(route, generateManeuvers(route), k => V.spd[k] / 3.6, { model: (r, t, m) => new EtaModel(r, t, m, vk, o.history || null), smoother: new EtaSmoother(), onEdge: o.onEdge }); return e; };
const mkOld = (route, vk = 'car') => { const V = ensureVeh(vk), e = new Legacy(); e.start(route, generateManeuvers(route), k => V.spd[k] / 3.6); return e; };
const avgStats = list => { const a = k => list.reduce((p, s) => p + s[k], 0) / list.length; return { n: a('n'), maeS: a('maeS'), mape: a('mape'), bias: a('bias'), distMaeM: a('distMaeM'), distMaxM: Math.max(...list.map(s => s.distMaxM)), etaJumpP95S: a('etaJumpP95S'), etaJumpMaxS: Math.max(...list.map(s => s.etaJumpMaxS)), coverage: a('coverage') }; };
const compare = (ids, vk, tOpt = {}, rOpt = {}, seeds = [1, 2, 3, 4, 5]) => { const route = city.routeOf(ids), res = { old: [], new: [] };
  for (const sd of seeds) { const tr = truthDrive(M, city, ids, { seed: sd, vk, ...tOpt }); res.old.push(runTrip(M, tr, mkOld(route, vk), { seed: sd + 10, ...rOpt }).stats); res.new.push(runTrip(M, tr, mk(route, vk), { seed: sd + 10, ...rOpt }).stats); }
  return { old: avgStats(res.old), new: avgStats(res.new) }; };
const report = (name, r) => { console.log(`   ${name}｜舊：${fmt(r.old)}`); console.log(`   ${name}｜新：${fmt(r.new)}`); };
const REPORT = [];
const base = city.manhattan([[0, 1], [9, 1], [9, 11], [13, 11]]), baseRoute = city.routeOf(base);

console.log('⓪ 模型本身');
{ const T = new (await import('../js/mapmatch.js')).RouteTrack(baseRoute), m = new EtaModel(baseRoute, T, generateManeuvers(baseRoute), 'car');
  ok('剩餘距離用沿路線的累積距離（＝路網邊長總和）', Math.abs(m.total - baseRoute.distance) < 1 && m.coverage.length === '路網邊長', `${m.total.toFixed(0)} m`);
  ok('包含轉向延遲與路口等待', m.coverage.turns === 2 && m.coverage.junctions > 10 && m.cumD[m.n - 1] > 100, `轉向 ${m.coverage.turns}、路口 ${m.coverage.junctions}、延遲合計 ${m.cumD[m.n - 1].toFixed(0)} 秒`);
  const free = baseRoute.edgePath.reduce((a, k) => a + 250 / (ensureVeh('car').spd[k] / 3.6), 0);
  ok('比「全程以速限行駛」保守（舊算法）', m.totalT > free * 1.3, `${(m.totalT / 60).toFixed(1)} 分 vs 舊 ${(free / 60).toFixed(1)} 分`);
  const r0 = m.remaining(0); ok('有不確定範圍與可信度', r0.lowS < r0.remainingS && r0.highS > r0.remainingS && ['high', 'medium', 'low'].includes(r0.confidence), `${(r0.lowS / 60).toFixed(0)}～${(r0.highS / 60).toFixed(0)} 分、可信度 ${r0.confidence}`);
  ok('交通延遲沒有資料 → 0（不假造）', r0.parts.traffic === 0);
  const h = new EdgeHistory(null); for (const k of baseRoute.edgePath) for (let i = 0; i < 4; i++) h.add(S.adjEid[k], 250, 25);   // 自己開過：10 m/s
  const mh = new EtaModel(baseRoute, T, generateManeuvers(baseRoute), 'car', h);
  ok('有本機歷史速度時與模型加權（歷史 10 m/s 比模型快 → 時間變短）', mh.cumT[mh.n - 1] < m.cumT[m.n - 1] && mh.coverage.history > 0.99);
  const mw = new EtaModel(baseRoute, T, generateManeuvers(baseRoute), 'walk'), mb = new EtaModel(baseRoute, T, generateManeuvers(baseRoute), 'bike');
  ok('不同運具不同模型（步行 > 腳踏車 > 汽車）', mw.totalT > mb.totalT && mb.totalT > m.totalT, `步行 ${(mw.totalT / 60).toFixed(0)}、腳踏車 ${(mb.totalT / 60).toFixed(0)}、汽車 ${(m.totalT / 60).toFixed(0)} 分`);
  const sm = new EtaSmoother(); sm.update(1e6, 0, 600); const a1 = sm.update(1e6 + 10e3, 1000, 600);
  ok('平滑器：小變動（10 秒）只跟一點點', Math.abs(a1 - 1e6) < 2e3);
  let x; for (let i = 0; i < 4; i++) x = sm.update(1e6 + 300e3, 2000 + i * 1000, 600); ok('平滑器：持續同方向的大變動（5 分）會快速跟上', x - 1e6 > 200e3, `${((x - 1e6) / 1000).toFixed(0)} 秒`);
  const y = sm.update(1e6 + 10 * 60e3, 7000, 600, false); ok('平滑器：不可信的定位不更新', y === x);
}

console.log('① GPS 正常移動（5 個種子平均）');
{ const r = compare(base, 'car'); report('一般', r); REPORT.push(['一般市區', r]);
  ok('新 ETA 誤差比舊版小（MAE、MAPE）', r.new.maeS < r.old.maeS * 0.7 && r.new.mape < r.old.mape);
  ok('新 ETA MAPE < 15%', r.new.mape < 15, r.new.mape.toFixed(1) + '%');
  ok('剩餘距離平均誤差 < 10 m（只剩 GPS 雜訊）', r.new.distMaeM < 10, r.new.distMaeM.toFixed(1) + ' m');
  ok('舊版系統性低估（偏差為負、超過 1 分鐘）——ETA 不準的主因', r.old.bias < -60, r.old.bias.toFixed(0) + ' 秒');
  ok('估計區間涵蓋真值的比例 ≥ 60%', r.new.coverage >= 60, r.new.coverage.toFixed(0) + '%');
}

console.log('② GPS 跳點（不經過 GpsFilter，直接送給引擎，測引擎本身的防護）');
{ const tr = truthDrive(M, city, base, { seed: 3 }), jumps = [{ k: 100, along: 450 }, { k: 160, dx: 200 }, { k: 220, along: 300 }];
  const n = runTrip(M, tr, mk(baseRoute), { seed: 13, jumps, raw: true }).stats, o = runTrip(M, tr, mkOld(baseRoute), { seed: 13, jumps, raw: true }).stats;
  console.log(`   舊：${fmt(o)}\n   新：${fmt(n)}`); REPORT.push(['GPS 跳點（未過濾）', { old: o, new: n }]);
  ok('單筆往前跳 450 m：新版進度不跟著跳（最大剩餘距離誤差 < 60 m）', n.distMaxM < 60, n.distMaxM.toFixed(0) + ' m');
  ok('舊版會被跳點永久帶走進度（最大誤差 > 300 m）——剩餘距離不準的原因之一', o.distMaxM > 300, o.distMaxM.toFixed(0) + ' m');
  const e = mk(baseRoute), [x0, y0] = city.xy(base[2]), [lo, la] = ll(x0, y0); e.update({ lat: la, lon: lo, accuracy: 8, speed: 10, heading: null, timestamp: 1e12 });
  const [x1, y1] = city.xy(base[12]), [lo1, la1] = ll(x1, y1), s0 = e.s; e.update({ lat: la1, lon: lo1, accuracy: 120, weak: true, speed: 10, heading: null, timestamp: 1e12 + 1000 });
  ok('精度很差（120 m）的定位不推進度', e.s === s0);
  // 真的往前移動（例如隧道後）：連續 2 筆一致才接受
  e.update({ lat: la1, lon: lo1, accuracy: 8, speed: 10, heading: null, timestamp: 1e12 + 2000 }); const sA = e.s; e.update({ lat: la1 + 0.0001, lon: lo1, accuracy: 8, speed: 10, heading: null, timestamp: 1e12 + 3000 });
  ok('連續兩筆一致的大幅前進才接受', sA === s0 && e.s > s0 + 2000, `${s0.toFixed(0)} → ${sA.toFixed(0)} → ${e.s.toFixed(0)} m`);
}

console.log('③ GPS 短暫停止（在路口前停 40 秒，例如紅燈）');
{ const j = 10, ids = base, frac = j / (ids.length - 1) - 0.0005, tr = truthDrive(M, city, ids, { seed: 2, jamAt: frac, jamS: 40 });
  const run = eng => { const r = runTrip(M, tr, eng, { seed: 12 }); const stopK0 = Math.round(r.rows.find(x => x.sRem <= tr.L * (1 - frac) + 1)?.k ?? 0); const span = r.rows.filter(x => x.k >= stopK0 && x.k <= stopK0 + 40); return { r, drift: span.length ? (Math.max(...span.map(x => x.eta)) - Math.min(...span.map(x => x.eta))) / 1000 : NaN }; };
  const n = run(mk(baseRoute)), o = run(mkOld(baseRoute));
  console.log(`   停車 40 秒期間「預計抵達時刻」的變化：舊 ${o.drift.toFixed(0)} 秒、新 ${n.drift.toFixed(0)} 秒`);
  ok('停等期間 ETA 不大幅跳動（≤ 30 秒；預期的路口等待吸收掉）', n.drift <= 30, n.drift.toFixed(0) + ' 秒');
  ok('舊版停多久 ETA 就延後多久', o.drift >= 35, o.drift.toFixed(0) + ' 秒');
}

console.log('④ GPS 失去定位（中斷 30 秒）');
{ const tr = truthDrive(M, city, base, { seed: 4 }), e = mk(baseRoute), { rows } = runTrip(M, tr, e, { seed: 14, lostFrom: 150, lostS: 30 });
  const before = rows.filter(x => x.k < 150).pop(), after = rows.find(x => x.k >= 180);
  ok('中斷前後都有估算，恢復後繼續更新', !!before && !!after && after.dRem < before.dRem);
  const e2 = mk(baseRoute); runTrip(M, { ...tr, T: 140 }, e2, { seed: 14 }); const held = e2.state.etaMs; e2.markGpsLost();
  ok('定位失效：保留最後的估算並標示定位異常', e2.state.eta.stale === true && e2.state.etaMs === held);
}

console.log('⑤ 路線連續轉彎（樓梯狀，12 個轉彎）');
{ const stair = city.manhattan([[1, 1], [3, 1], [3, 3], [5, 3], [5, 5], [7, 5], [7, 7], [9, 7], [9, 9], [11, 9], [11, 11], [13, 11], [13, 13]]), r = compare(stair, 'car');
  report('連續轉彎', r); REPORT.push(['連續轉彎', r]);
  ok('連續轉彎：新 MAE 比舊版小、剩餘距離平均誤差 < 10 m', r.new.maeS < r.old.maeS && r.new.distMaeM < 10);
  const st = mk(city.routeOf(stair)); ok('轉向延遲逐一計入（11 個轉彎）', st.model.coverage.turns === 11, String(st.model.coverage.turns));
}

console.log('⑥ 偏航後重新規劃');
{ const S0 = M.S; S0.planCache && S0.planCache.clear(); S0.toPoint = { idx: city.idx('n13_11'), lon: 0, lat: 0, id: 'n13_11' }; S0.fromPoint = { idx: city.idx('n0_1'), lon: 0, lat: 0, id: 'n0_1' };
  const { el } = await import('./helpers.mjs'); el('mode').value = 'car'; el('goal').value = 'compare'; el('pref').value = 'fast'; el('prefA').value = '1'; el('prefB').value = '0'; el('prefD').value = '0';
  // 本來在 (5,1) 要往北轉，結果直走。第 1 趟：找出系統重新規劃的路線；第 2 趟：真值改成「偏離後照新路線開」，量新路線上的剩餘距離
  const route = city.routeOf(city.manhattan([[0, 1], [5, 1], [5, 11], [13, 11]])), rev = new Map();
  for (let i = 0; i < city.n; i++) for (let j = 0; j < city.n; j++) rev.set(city.idx(city.id(i, j)), [i, j]);
  const pass = truthIds => { const tr = truthDrive(M, city, truthIds, { seed: 6 }), e = mk(route), f = new M.GpsFilter(), rows = []; let req = null, applied = null, nr = null;
    e.on((t, s) => { if (t === 'reroute-request' && !req) req = s.fix; });
    for (let k = 0; k <= tr.T + 5; k++) {
      const { s } = tr.at(Math.min(k, tr.T)), [x, y] = tr.pos(s), [lo, la] = ll(x, y), r = f.process({ lat: la, lon: lo, accuracy: 6, speed: null, heading: NaN, timestamp: 1.7e12 + k * 1000 }); if (!r.accepted) continue;
      e.update(r.fix);
      if (req && !applied) { const rr = rerouteFromFix(req); if (!rr.error) { nr = rr.route; e.applyNewRoute(nr, generateManeuvers(nr)); applied = { k, s }; } }
      if (applied) rows.push({ k, err: Math.abs(e.state.remainingM - (tr.L - s)), st: e.state.status });
      if (e.state.status === 'arrived') break;
    }
    return { applied, rows, nr }; };
  const p1 = pass(city.manhattan([[0, 1], [8, 1], [8, 11], [13, 11]]));
  ok('偏離後發出重新規劃並換上新路線', !!p1.applied && !!p1.nr, p1.applied ? `第 ${p1.applied.k} 秒、新路線 ${p1.nr.distance.toFixed(0)} m` : '');
  const [ui, uj] = rev.get(p1.nr.path[0]), ids2 = [...city.manhattan([[0, 1], [ui, uj]]), ...p1.nr.path.slice(1).map(k => city.id(...rev.get(k)))], p2 = pass(ids2);
  ok('第 2 趟在同一時間重新規劃（真值前段相同）', p2.applied && p2.applied.k === p1.applied.k);
  const later = p2.rows.filter(r => r.k >= p2.applied.k + 10);
  ok('換路線後進度重新起算、沿新路線的剩餘距離正確（10 秒後誤差 < 60 m）', later.length > 0 && later.every(r => r.err < 60), later.length ? `最大 ${Math.max(...later.map(r => r.err)).toFixed(0)} m` : '');
  ok('照新路線開到終點', p2.rows.length && p2.rows[p2.rows.length - 1].st === 'arrived');
}

console.log('⑦ 長距離（30×30 格、約 14 km）');
{ const big = quiet(() => makeCity(M, { n: 30 })), ids = big.manhattan([[0, 2], [26, 2], [26, 25], [29, 25]]), route = big.routeOf(ids), r = { old: [], new: [] };
  for (const sd of [1, 2, 3]) { const tr = truthDrive(M, big, ids, { seed: sd }); r.old.push(runTrip(M, tr, mkOld(route), { seed: sd + 10 }).stats); r.new.push(runTrip(M, tr, mk(route), { seed: sd + 10 }).stats); }
  const R = { old: avgStats(r.old), new: avgStats(r.new) }; report('長距離', R); REPORT.push(['長距離 14 km', R]);
  ok('長距離：新 MAPE < 舊版、且 < 15%', R.new.mape < R.old.mape && R.new.mape < 15, R.new.mape.toFixed(1) + '%');
  quiet(() => makeCity(M, { n: 14 }));
}
const baseRoute2 = city.routeOf(base);

console.log('⑧ 低速與高速切換（中段壅塞，速度只剩 35～55%，模型不知道）');
{ const r = compare(base, 'car', { congest: [0.3, 0.6] }); report('壅塞', r); REPORT.push(['中段壅塞', r]);
  ok('壅塞：新版誤差比舊版小（靠實際速度與本趟比例修正）', r.new.maeS < r.old.maeS);
  const tr = truthDrive(M, city, base, { seed: 1, congest: [0.3, 0.6] }), { rows } = runTrip(M, tr, mk(baseRoute2), { seed: 11 });
  const inJam = rows.filter(x => x.sRem < tr.L * 0.55 && x.sRem > tr.L * 0.45), raw = inJam.map(x => x.rawRem - x.tRem);
  ok('壅塞中估算往上修正（相對於出發時的模型）', inJam.length > 0 && inJam[inJam.length - 1].rawRem > inJam[0].rawRem - (inJam[inJam.length - 1].k - inJam[0].k) * 0.8);
}

console.log('⑨ 接近複雜路口：自動放大、通過後恢復、不反覆縮放');
{ // 每秒 10 m 前進；第一個轉彎在 600 m（複雜路口），下一個在 1300 m；跑到 950 m
  const cam = new CameraController({ vk: 'car', mode: 'heading' }), A = { index: 20, turnType: 'turn', dir: 'left' }, B = { index: 25, turnType: 'turn', dir: 'right' }, w = [], jn = [];
  for (let p = 0; p <= 950; p += 10) { const o = cam.step(1, { speed: 10, heading: 90, accuracy: 6, distToNext: p < 600 ? 600 - p : 1300 - p, next: p < 600 ? A : B, complex: true, follow: true, aspect: 2.1 }); w.push(o.widthM); jn.push(o.junction); }
  const enter = jn.indexOf(true), exit = jn.lastIndexOf(true);
  ok('接近轉彎時進入路口放大（畫面寬度變小）', enter > 0 && Math.min(...w.slice(enter, exit + 1)) < w[enter - 1] * 0.7, `${w[enter - 1].toFixed(0)} → ${Math.min(...w.slice(enter, exit + 1)).toFixed(0)} m`);
  ok('通過路口後恢復一般視角', exit < jn.length - 1 && w[w.length - 1] > Math.min(...w) * 1.5);
  let flips = 0; for (let i = 1; i < jn.length; i++) if (jn[i] !== jn[i - 1]) flips++; ok('同一個路口只放大一次（不反覆切換）', flips <= 2, `切換 ${flips} 次`);
  const c2 = new CameraController({ vk: 'car', mode: 'heading' }); c2.step(1, { speed: 10, heading: 90, accuracy: 6, follow: true, aspect: 2 }); for (let i = 0; i < 30; i++) c2.step(0.1, { speed: 10, heading: 90, accuracy: 6, follow: true, aspect: 2 });
  const r0 = c2.rot; for (let i = 0; i < 10; i++) c2.step(0.1, { speed: 0.3, heading: 200 + i * 15, accuracy: 6, follow: true, aspect: 2 });
  ok('低速／停止：方向鎖定（GPS 方向亂跳也不轉）', Math.abs(c2.rot - r0) < 1, `${r0.toFixed(0)}° → ${c2.rot.toFixed(0)}°`);
  for (let i = 0; i < 10; i++) c2.step(0.1, { speed: 12, heading: 300, accuracy: 60, follow: true, aspect: 2 });
  ok('精度不足（60 m）：暫停方向更新', Math.abs(c2.rot - r0) < 1 && c2.source === 'paused');
  const c3 = new CameraController({ vk: 'car', mode: 'heading' }); c3.step(1, { speed: 10, heading: 0, accuracy: 6, follow: true, aspect: 2 }); const turns = [];
  for (let i = 0; i < 20; i++) turns.push(c3.step(0.1, { speed: 10, heading: 90, accuracy: 6, follow: true, aspect: 2 }).rot);
  ok('轉向時旋轉內插（每 0.1 秒最多 6°，不會瞬間轉 90°）', turns.every((r, i) => i === 0 || Math.abs(r - turns[i - 1]) <= 6.01) && turns[0] < 20, turns.slice(0, 4).map(x => x.toFixed(0)).join('→'));
  const c4 = new CameraController({ vk: 'walk', mode: 'heading' }); c4.step(1, { speed: 0.2, heading: null, accuracy: 6, compass: 135, follow: true, aspect: 2 }); for (let i = 0; i < 40; i++) c4.step(0.1, { speed: 0.2, heading: null, accuracy: 6, compass: 135, follow: true, aspect: 2 });
  ok('停止時用指南針輔助方向', Math.abs(c4.rot - 135) < 3 && c4.source === 'compass', c4.rot.toFixed(0) + '°');
  const c5 = new CameraController({ vk: 'car', mode: 'north' }); for (let i = 0; i < 20; i++) c5.step(0.1, { speed: 10, heading: 90, accuracy: 6, follow: true, aspect: 2 });
  ok('北朝上模式不旋轉', c5.rot === 0);
  const speeds = [5, 20].map(v => { const c = new CameraController({ vk: 'car' }); let o; for (let i = 0; i < 50; i++) o = c.step(0.2, { speed: v, heading: 0, accuracy: 6, follow: true, aspect: 2, distToNext: 1e9 }); return o.widthM; });
  ok('自動縮放：高速看得比較遠', speeds[1] > speeds[0] * 1.8, speeds.map(x => x.toFixed(0) + ' m').join(' vs '));
}

console.log('⑩ 手動拖曳地圖（相機）');
{ const c = new CameraController({ vk: 'car', mode: 'heading', tilt: true }); for (let i = 0; i < 40; i++) c.step(0.1, { speed: 12, heading: 0, accuracy: 6, follow: true, aspect: 2 });
  const t0 = c.tilt; c.interact(); ok('拖曳時傾斜立即歸零（觸控座標才正確）', t0 > 10 && c.tilt === 0, `${t0.toFixed(0)}° → 0°`);
  for (let i = 0; i < 20; i++) c.step(0.1, { speed: 12, heading: 0, accuracy: 6, follow: false, aspect: 2 }); ok('不跟隨時不傾斜', c.tilt < 1);
  console.log('   （瀏覽器端：拖曳後停止跟隨、按「回到定位」恢復——見 test/browser.cjs）');
}

console.log('⑪ 大量建築物渲染：專案沒有建築物資料，這項無法測試（見報告「尚未支援」）');

console.log('⑫ 不同運具 ETA 模型');
for (const vk of ['moto', 'bike', 'walk']) { const r = compare(base, vk, {}, {}, [1, 2, 3]); report(vk, r); REPORT.push([{ moto: '機車', bike: '腳踏車', walk: '步行' }[vk], r]);
  ok(`${vk}：新 MAE 不比舊版差`, r.new.maeS <= r.old.maeS * 1.05, `${r.new.maeS.toFixed(0)} vs ${r.old.maeS.toFixed(0)} 秒`); }

console.log('⑬ 效能：每筆 GPS 只做增量計算');
{ const tr = truthDrive(M, city, base, { seed: 1 }), e = mk(baseRoute2), t0 = performance.now(), { rows } = runTrip(M, tr, e, { seed: 11 }), ms = (performance.now() - t0) / rows.length;
  ok('每筆定位處理 < 1 ms（含 Map Matching、進度、ETA）', ms < 1, ms.toFixed(3) + ' ms'); }

if (process.env.ETA_REPORT) (await import('node:fs')).writeFileSync(process.env.ETA_REPORT, JSON.stringify(REPORT.map(([k, r]) => ({ case: k, old: r.old, new: r.new })), null, 1));
done();
