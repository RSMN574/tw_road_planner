// 導航與載入優化：轉錯路口快速偵測、ETA 依實際速度修正、語音提示距離隨車速放大、路網封包（graph.bin）與 JSON 完全一致
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
const { ManeuverDetector, PROMPT_PROFILE, LEAD_S } = await import('../js/voice.js');
const { buildGraphCore } = await import('../js/graph-build.js'); const { encodePack, readPackHeader } = await import('../js/graph-pack.js');
const quiet = f => { const a = console.info, b = console.warn; console.info = console.warn = () => {}; try { return f(); } finally { console.info = a; console.warn = b; } };

console.log('① 轉錯路口：方向與路線差很多 → 更快確認偏航；平行偏移（方向相同）維持原本的防抖');
{ // 沿路線開 300 m 後，往路線的左側垂直開出去（15 m/s）
  const off = (turn, seed) => { const eng = new NavigationEngine(), f = new GpsFilter(), R = rng(seed); eng.start(route, man, spd); let t = 1e6, n = 0, at = null;
    for (let s = 0; s <= 300; s += 15) { const [x, y] = along(s), [lo, la] = ll(x, y); const r = f.process({ lat: la, lon: lo, accuracy: 6, speed: 15, heading: NaN, altitude: null, timestamp: t }); if (r.accepted) eng.update(r.fix); t += 1000; }
    const [x0, y0] = along(300), [x1, y1] = along(310), h = Math.atan2(y1 - y0, x1 - x0), ang = h + turn;
    eng.on(type => { if (type === 'reroute-request' && at == null) at = n; });
    for (n = 1; n <= 30 && at == null; n++) { const [lo, la] = ll(x0 + Math.cos(ang) * 15 * n + gauss(R) * 2, y0 + Math.sin(ang) * 15 * n + gauss(R) * 2); const r = f.process({ lat: la, lon: lo, accuracy: 6, speed: 15, heading: NaN, altitude: null, timestamp: t }); if (r.accepted) eng.update(r.fix); t += 1000; }
    return at; };
  const fast = [1, 2, 3].map(sd => off(Math.PI / 2, sd));
  // 對照組：關掉「方向判斷」（divergeDeg 設成不可能達到）＝原本的規則
  const ref = [1, 2, 3].map(sd => { const eng = new NavigationEngine({ divergeDeg: 999 }), f = new GpsFilter(), R = rng(sd); eng.start(route, man, spd); let t = 1e6, n = 0, at = null;
    for (let s = 0; s <= 300; s += 15) { const [x, y] = along(s), [lo, la] = ll(x, y); const r = f.process({ lat: la, lon: lo, accuracy: 6, speed: 15, heading: NaN, altitude: null, timestamp: t }); if (r.accepted) eng.update(r.fix); t += 1000; }
    const [x0, y0] = along(300), [x1, y1] = along(310), ang = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2; eng.on(type => { if (type === 'reroute-request' && at == null) at = n; });
    for (n = 1; n <= 30 && at == null; n++) { const [lo, la] = ll(x0 + Math.cos(ang) * 15 * n + gauss(R) * 2, y0 + Math.sin(ang) * 15 * n + gauss(R) * 2); const r = f.process({ lat: la, lon: lo, accuracy: 6, speed: 15, heading: NaN, altitude: null, timestamp: t }); if (r.accepted) eng.update(r.fix); t += 1000; }
    return at; });
  ok('轉錯路口：比原本規則更早發出重新規劃', fast.every((x, i) => x != null && ref[i] != null && x < ref[i]), `新 ${fast.join('、')} 筆 vs 原本 ${ref.join('、')} 筆`);
  ok('轉錯路口：仍需要確實離開路線（至少 3 筆定位）', fast.every(x => x >= 3), fast.join('、'));
  // 與路線平行、偏 25 m 行駛（例如旁邊的平行道路或 GPS 偏移）：不應觸發
  const eng = new NavigationEngine(), f = new GpsFilter(), R = rng(9), ev = []; eng.start(route, man, spd); eng.on(t => ev.push(t)); let t = 1e6;
  for (let s = 0; s <= 380; s += 12) { const [x, y] = along(s), [lo, la] = ll(x + gauss(R) * 3, y + 25 + gauss(R) * 3); const r = f.process({ lat: la, lon: lo, accuracy: 6, speed: 12, heading: NaN, altitude: null, timestamp: t }); if (r.accepted) eng.update(r.fix); t += 1000; }
  ok('平行偏移 25 m（方向一致）：不會誤判偏航', !ev.includes('reroute-request'), ev.filter(x => x !== 'update').join(',') || '沒有事件');
}

console.log('② ETA 依實際行駛速度修正（分段模型＋本趟實際比例；詳細的誤差統計見 nav-eta.mjs）');
{ const { EtaModel, EtaSmoother } = await import('../js/eta-engine.js');
  const runAt = (v, withModel = true) => { const eng = new NavigationEngine(), f = new GpsFilter(); eng.start(route, man, spd, withModel ? { model: (r, t, m) => new EtaModel(r, t, m, 'car'), smoother: new EtaSmoother() } : {}); const st = []; for (const r of drive({ v, sigma: 2, seed: 4 })) { const x = f.process(r); if (x.accepted) st.push(eng.update(x.fix)); } return st; };
  const slow = runAt(4), norm = runAt(9), at = (st, frac) => st.find(s => s.s >= total * frac);
  const a = at(slow, 0.6), b = at(norm, 0.6);
  ok('照模型預期的速度行駛：修正係數接近 1', Math.abs(b.etaFactor - 1) < 0.15, b.etaFactor.toFixed(2));
  ok('開得比預期慢很多：剩餘時間往上修正（與模型加權，不是直接用 GPS 速度換算）', a.etaFactor > 1.1 && a.etaFactor <= 2.5 && a.rawRemainingS > b.rawRemainingS * 1.2, `係數 ${a.etaFactor.toFixed(2)}，剩 ${Math.round(a.rawRemainingS)} 秒（模型原估 ${Math.round(a.remainingPlanS)} 秒；正常速度者 ${Math.round(b.rawRemainingS)} 秒）`);
  const early = slow.find(s => s.s > 50); ok('剛出發（資料不足）：不用本趟比例修正', early.eta.parts.tripAdj === 0);
  ok('ETA 時間點＝定位時間＋平滑後的剩餘時間', Math.abs(a.etaMs - (a.fix.timestamp + a.remainingS * 1000)) < 1);
  ok('有估計區間與可信度', a.eta.lowS < a.rawRemainingS && a.eta.highS > a.rawRemainingS && !!a.eta.confidence);
  const c = at(runAt(4, false), 0.6); ok('沒有注入模型（備援）：仍會依本趟實際比例往上修正，可信度標「低」', c.etaFactor > 1.2 && c.eta.confidence === 'low', c.etaFactor.toFixed(2));
}

console.log('③ 語音提示距離隨車速放大');
{ const det = new ManeuverDetector(), P = PROMPT_PROFILE.car, mk = (d, v) => ({ status: 'navigating', next: { index: 7, turnType: 'turn', dir: 'right', roadName: '中港路' }, distToNext: d, speed: v });
  ok('低速：沿用原本距離（500 m 前不提示）', det.detect(mk(520, 5), P) === null && det.detect(mk(490, 5), P) !== null);
  det.reset();
  ok('時速 90 公里：約 750 m 就先提示', det.detect(mk(800, 25), P) === null && det.detect(mk(740, 25), P)?.priority === 1, `門檻 ${25 * LEAD_S.far[0]} m`);
  det.reset(); det.detect(mk(740, 25), P); det.detect(mk(290, 25), P);
  const now = det.detect(mk(120, 25), P);
  ok('時速 90 公里：「現在轉彎」提前到約 125 m（念完還來得及）', now && now.priority === 2 && /現在/.test(now.text));
  det.reset(); ok('停車時（速度 0）：「現在」仍是 40 m', det.detect(mk(45, 0), P)?.priority !== 2 && det.detect(mk(38, 0), P)?.priority === 2);
}

console.log('④ 路網封包 graph.bin：與 JSON 建圖結果完全相同');
{ const snap = () => JSON.stringify({ N: S.N, E: S.E, ct: S.coordType, ids: S.nodeIds, xy: Array.from(S.nodeXY), off: Array.from(S.adjOffset), to: Array.from(S.adjTo), w: Array.from(S.adjW), eid: S.adjEid, rn: S.roadNames,
    r2n: [...S.roadNameToNodes].map(([k, v]) => [k, [...v]]).sort(), e2r: [...S.edgeIdToRoadNames].map(([k, v]) => [k, [...v]]).sort(), attr: [...S.edgeAttr].map(([k, v]) => [k, JSON.stringify(v, (a, b) => Number.isNaN(b) ? 'NaN' : b)]).sort() });
  const cases = {
    '格子路網（TWD97 整數座標、數字 edgeId）': () => ({ nodes, edges, roads }),
    '混合格式（經緯度、折線、陣列、前綴 ID、多路名、NaN 屬性）': () => ({ nodes: [{ id: 'a', lon: 120.6, lat: 24.1, road: '中港路' }, { id: 'b', lon: 120.61, lat: 24.1 }, { id: 'c', lon: 120.61, lat: 24.11 }, { id: 'd', lon: 120.62, lat: 24.11 }, { id: '7', lon: 120.63, lat: 24.12 }],
      edges: [['a', 'b', 50], { nodes: ['b', 'c', 'd'], length: 200, edgeId: 'P1' }, { source: 'node_d', target: 7, weight: 30.5, id: 'X' }, { from: ' a ', to: 'c', w: 0 }, { from: 'a', to: 'zz', w: 3 }, { from: 'c', to: 'a', w: 9, edgeId: 'X' }],
      roads: [{ name: '中港路', edgeIds: ['X', 'P1'], width: 20 }, { name: '文心路', edgeIds: ['X', 3, 'ghost'], 速限: 50 }, { name: '文心路', nodes: ['b', 'nope'] }, '孤路'] }),
    '鄰接表格式': () => ({ nodes: { a: [120.6, 24.1], b: [120.61, 24.1], c: [120.62, 24.1] }, edges: { a: { b: 10, c: 20 }, b: [['c', 5]] }, roads: { 甲路: ['a', 'b'], 乙路: { edgeIds: [0, 1] } } })
  };
  for (const [name, mk] of Object.entries(cases)) {
    let buf; quiet(() => buildGraphCore(mk(), () => { buf = encodePack({ t: 1 }); })); const a = snap(); quiet(() => buildGraphCore({ pack: buf })); const b = snap();
    ok(name, a === b, `${buf.length} bytes`);
  }
  let err = null; try { buildGraphCore({ pack: new Uint8Array(20) }); } catch (e) { err = e.message; } ok('不是封包的檔案：明確報錯（網頁會改用 JSON）', /不是路網封包/.test(err || ''));
  quiet(() => buildGraph({ nodes, edges, roads }));
  let buf2; quiet(() => buildGraphCore({ nodes, edges, roads }, () => { buf2 = encodePack(); }));
  ok('表頭含版本、節點數、區段清單', readPackHeader(buf2).head.N === N * N && readPackHeader(buf2).head.sections.length > 10);
  const S2 = S.nodeIdToIdx; ok('節點 ID → 索引（第一次查詢時才建立）', S2.get('n3_2') === S.nodeIds.indexOf('n3_2') && S2.has('nope') === false);
}
done();
