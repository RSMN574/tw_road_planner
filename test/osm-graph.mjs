// osm-graph.mjs — OSM PBF → 道路拓樸圖 → 路徑搜尋（單行、各運具通行、轉向限制、橋與高度層、障礙物、缺資料）
// 測試資料 test/fixtures/osm/tw-mini.osm.pbf 由 make-fixtures.py 用 libosmium 產生（台中附近的小格子路網）
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf';
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x !== '' ? '｜' + x : '')); if (!c) fails++; };
const { readHeader, scan } = await import('../server/osm/pbf.mjs'), T = await import('../server/osm/tags.mjs'), A = await import('../server/osm/access.mjs');
const { buildTopology } = await import('../server/osm/topology.mjs'), { writeGraph, readGraph } = await import('../server/osm/graph-file.mjs'), { OsmRouter } = await import('../server/osm/router.mjs');
const { validateGraph } = await import('../server/osm/validate.mjs'), { FLOW, DELAY } = await import('../js/eta-params.js');
const tmpAlt = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'osm-alt-'));
const B = 10_000_000_000, nid = (i, j) => B + i * 100 + j, LAT0 = 24.150, LON0 = 120.650, D = 0.001, at = (i, j) => [LAT0 + j * D, LON0 + i * D];

console.log('① PBF 讀取（純 Node）');
const h = readHeader(FIX);
ok('表頭：產生程式、範圍、必要功能', /libosmium/.test(h.writingProgram) && h.required.includes('OsmSchema-V0.6') && h.required.includes('DenseNodes'), h.writingProgram);
const seen = { n: 0, w: 0, r: 0, big: 0 }; let bol = null;
scan(FIX, { nodeTags: true, node(id, la, lo, t) { seen.n++; if (id > 2 ** 32) seen.big++; if (t && t.barrier) bol = { id, la, lo }; }, way() { seen.w++; }, relation() { seen.r++; } });
ok('node／way／relation 數量', seen.n === 59 && seen.w === 44 && seen.r === 6, `${seen.n}／${seen.w}／${seen.r}`);
ok('超過 2^32 的 node id 完整保留', seen.big === seen.n && bol && bol.id === B + 6001);
ok('座標精確到 1e-7 度', bol.la === Math.round((LAT0 + 0.003) * 1e7) && bol.lo === Math.round((LON0 - 0.001) * 1e7), `${bol.la}, ${bol.lo}`);

console.log('② 標籤解析');
ok('maxspeed：60、50 km/h、30 mph、TW:urban（未知）', T.parseMaxspeed('60') === 60 && T.parseMaxspeed('50 km/h') === 50 && Math.abs(T.parseMaxspeed('30 mph') - 48.28) < 0.01 && Number.isNaN(T.parseMaxspeed('TW:urban')) && T.parseMaxspeed('50;40') === 40);
ok('width：6 m、3.5、12\'（英尺）；lanes；layer', T.parseWidth('6 m') === 6 && T.parseWidth('3.5') === 3.5 && Math.abs(T.parseWidth("12'") - 3.6576) < 1e-6 && T.parseLanes('2') === 2 && T.parseLanes('x') === 0 && T.parseLayer('-1') === -1 && T.parseLayer('') === 0);
ok('oneway：yes／-1／no／reversible／未標', T.parseOneway('yes') === 1 && T.parseOneway('-1') === -1 && T.parseOneway('no') === 0 && T.parseOneway('reversible') === 2 && T.parseOneway(undefined) === null);
ok('不進路網：施工中、廣場（area=yes）', T.skipReason({ highway: 'construction' }) && T.skipReason({ highway: 'pedestrian', area: 'yes' }) && !T.skipReason({ highway: 'residential' }));

console.log('③ 道路拓樸');
const g = buildTopology(FIX), { V, E, W, G } = g, S = g.stats;
const wIx = id => { for (let i = 0; i < W.n; i++) if (W.id[i] === id) return i; return -1; }, edgesOfWay = id => { const w = wIx(id), r = []; for (let e = W.edgeOff[w]; e < W.edgeOff[w + 1]; e++) r.push(e); return r; };
const vOf = osm => { const r = []; for (let v = 0; v < V.n; v++) if (V.osm[v] === osm) r.push(v); return r; };
ok('進路網 42 條（含 3 條渡輪）、排除施工中與廣場', S.routableWays === 42 && S.ferryWays === 3 && S.skipped['highway=construction'] === 1 && Object.keys(S.skipped).some(k => k.startsWith('area=yes')));
ok('長 way 在每個路口切開（東西0路 5 個路口 → 4 條邊）', edgesOfWay(200).length === 4);
const e200 = edgesOfWay(200)[0];
ok('邊保留原始 way id、OSM node id 與累積距離', W.id[E.way[e200]] === 200 && G.node[E.goff[e200]] === nid(0, 0) && G.node[E.goff[e200 + 1] - 1] === nid(1, 0) && Math.abs(G.cum[E.goff[e200 + 1] - 1] - E.len[e200]) < 1e-3);
ok('距離用大圓距離（0.001° 經度 ≈ 101.6 m）', Math.abs(E.len[e200] - 101.57) < 0.2, E.len[e200].toFixed(2) + ' m');
ok('頂點只來自 OSM node id（同座標不合併；無四捨五入）', V.osm.every(x => Number.isInteger(x) && x >= B));
const bridge = edgesOfWay(700);
ok('高架橋與平面道路幾何交叉但沒共用 node → 不相接（橋只有 1 條邊）', bridge.length === 1 && G.lat.subarray(E.goff[bridge[0]], E.goff[bridge[0] + 1]).length === 2);
ok('橋的端點接平面道路 → 相接', vOf(B + 4001).length === 1 && edgesOfWay(702).some(e => E.v[e] === E.u[bridge[0]]));
const vv = vOf(nid(1, 3));
ok('不同高度層在中間點共用 node（資料錯誤）→ 拆成 2 個頂點、不相連', S.layerConflictNodes === 1 && vv.length === 2 && !edgesOfWay(710).some(e => edgesOfWay(203).some(f => [E.u[e], E.v[e]].some(x => x === E.u[f] || x === E.v[f]))));
ok('封閉道路（圓環）在中點切開，沒有自環', edgesOfWay(500).length === 2 && S.selfLoops === 0 && S.closedWays === 1);
ok('缺座標的 node：計數、道路在缺點處斷開', S.missingNodes === 1 && edgesOfWay(807).length === 1);
ok('號誌標在頂點；障礙物點變成頂點', (V.flags[vOf(nid(1, 1))[0]] & 1) === 1 && vOf(B + 6001).length === 1 && V.barrier.has(vOf(B + 6001)[0]));

console.log('④ 各運具通行狀態（allowed／推定／未知／有條件／禁止）');
const st = (id, p, dir = 'f') => { const a = W.acc[wIx(id) * 5 + A.PROFILE_IX[p]]; return dir === 'f' ? a & 15 : a >> 4; }, S_ = A.ST;
ok('國道（motorway，國道1號）：汽車推定允許；大型重機、機車、自行車、行人推定禁止', st(600, 'car') === S_.DEFAULT_ALLOWED && ['heavy', 'moto', 'bike', 'foot'].every(p => st(600, p) === S_.DEFAULT_RESTRICTED));
ok('快速公路（motorroad=yes、台74）：大型重機可、機車不可', st(601, 'heavy') === S_.DEFAULT_ALLOWED && st(601, 'moto') === S_.DEFAULT_RESTRICTED && st(601, 'bike') === S_.DEFAULT_RESTRICTED);
ok('單行道：汽車反向禁止；oneway:bicycle=no 腳踏車可雙向；行人不受單行限制', st(304, 'car', 'b') === S_.ONEWAY && st(304, 'bike', 'b') === S_.DEFAULT_ALLOWED && st(304, 'foot', 'b') === S_.DEFAULT_ALLOWED);
ok('圓環（junction=roundabout）隱含單行', st(500, 'car', 'b') === S_.ONEWAY && st(500, 'car', 'f') === S_.DEFAULT_ALLOWED);
ok('access=private → 有條件（不是允許、也不是禁止）', ['car', 'moto', 'bike', 'foot'].every(p => st(800, p) === S_.LIMITED));
ok('人行步道：汽車推定禁止、自行車未知（台灣需有標誌）、行人推定允許', st(801, 'car') === S_.DEFAULT_RESTRICTED && st(801, 'bike') === S_.UNKNOWN && st(801, 'foot') === S_.DEFAULT_ALLOWED);
ok('產業道路（track）：汽車未知（不擅自判斷）', st(802, 'car') === S_.UNKNOWN && st(802, 'bike') === S_.DEFAULT_ALLOWED);
ok('自行車道：行人未知、汽車推定禁止', st(803, 'foot') === S_.UNKNOWN && st(803, 'car') === S_.DEFAULT_RESTRICTED && st(803, 'bike') === S_.DEFAULT_ALLOWED);
ok('motor_vehicle=no＋foot=yes：汽機車標籤禁止、行人標籤允許、自行車推定允許', st(804, 'car') === S_.RESTRICTED && st(804, 'moto') === S_.RESTRICTED && st(804, 'foot') === S_.ALLOWED && st(804, 'bike') === S_.DEFAULT_ALLOWED);
ok('沒標的道路：推定允許，與「標籤允許」分開記錄', st(200, 'car') === S_.DEFAULT_ALLOWED);
const bar = V.barrier.get(vOf(B + 6001)[0]);
ok('車阻（bollard）：汽車、重機擋下；機車未知；自行車、行人可過', A.isBlocked(bar[0]) && A.isBlocked(bar[1]) && bar[2] === S_.UNKNOWN && bar[3] === S_.ALLOWED && bar[4] === S_.ALLOWED);
const cond = A.wayAccess({ highway: 'residential', 'access:conditional': 'no @ (22:00-06:00)' });
ok('有時段條件的標籤：基本狀態照舊，加上「依時段」旗標', (cond[0] & 7) === S_.DEFAULT_ALLOWED && (cond[0] & A.COND) !== 0);
const wa = t => Array.from(A.wayAccess(t), x => x & 15), BLK = x => x === S_.RESTRICTED || x === S_.DEFAULT_RESTRICTED;
ok('階梯標 access=yes：汽機車、自行車仍不能走（通用標籤不放寬），行人可走', (a => BLK(a[0]) && BLK(a[1]) && BLK(a[2]) && BLK(a[3]) && a[4] === S_.ALLOWED)(wa({ highway: 'steps', access: 'yes' })));
ok('階梯標 motorcar=yes 仍不能開；bicycle=yes 只算有條件（牽車）', (a => BLK(a[0]) && a[3] === S_.LIMITED)(wa({ highway: 'steps', motorcar: 'yes', bicycle: 'yes' })));
ok('人行道 access=yes：汽車仍禁止、自行車仍未知；access=no 照樣禁止所有運具', (a => BLK(a[0]) && a[3] === S_.UNKNOWN)(wa({ highway: 'footway', access: 'yes' })) && wa({ highway: 'footway', access: 'no' }).every(BLK));
ok('國道標 access=yes：行人、機車仍依法禁止；汽車允許', (a => a[0] === S_.ALLOWED && BLK(a[2]) && BLK(a[4]))(wa({ highway: 'motorway', ref: '國道1號', access: 'yes' })));
ok('徒步區 motor_vehicle=delivery（運具自己的標籤）→ 汽機車有條件；access=destination（通用）→ 汽車仍禁止', wa({ highway: 'pedestrian', motor_vehicle: 'delivery' })[0] === S_.LIMITED && BLK(wa({ highway: 'pedestrian', access: 'destination' })[0]));
const wp = t => Object.fromEntries(A.PROFILES.map((p, i) => [p.key, A.wayAccess(t)[i] & 15]));
{ const a = wp({ highway: 'trunk', name: '市民大道高架道路', oneway: 'yes', 'motorcycle:conditional': 'no @ <=250 cc' });
  ok('排氣量條件 no @ <=250 cc（市民大道高架）：機車禁止、大型重機不受影響；不是時段條件，不標「依時段」', a.moto === S_.RESTRICTED && (a.heavy & 7) === S_.DEFAULT_ALLOWED && !(a.heavy & A.COND) && !(a.moto & A.COND)); }
{ const a = wp({ highway: 'trunk', motorroad: 'yes', name: '西濱快速公路', 'motorcycle:conditional': 'yes @ (displacement >= 250 cc)' });
  ok('排氣量條件 yes @ (displacement >= 250 cc)（快速公路）：大型重機允許、機車仍依法禁止', a.heavy === S_.ALLOWED && a.moto === S_.DEFAULT_RESTRICTED); }
ok('名稱為「…高架道路」視為市區快速道路：自行車、行人推定禁止', (a => BLK(a[3]) && BLK(a[4]))(wa({ highway: 'trunk', name: '建國高架道路' })));
ok('沒標註的匝道（trunk_link「…入口匝道」）：機車、自行車、行人為未知（可能是快速道路出入口），汽車推定允許', (a => a[0] === S_.DEFAULT_ALLOWED && a[2] === S_.UNKNOWN && a[3] === S_.UNKNOWN && a[4] === S_.UNKNOWN)(wa({ highway: 'trunk_link', name: '建國南路入口匝道' })));

console.log('⑤ 轉向限制');
const RS = g.restrictions, rule = id => RS.rules.filter(r => r.rel === id);
ok('6 筆 relation：套用 5、找不到道路的 1 筆列出原因', RS.stats.applied === 5 && Object.keys(RS.skipped).some(k => k.startsWith('way-not-in-graph')) && RS.skipped.samples[Object.keys(RS.skipped).find(k => k.startsWith('way-not'))][0] === 903);
ok('no_left_turn（except=bicycle）：汽機車禁止、自行車不受限、行人不受限', rule(900).length === 1 && rule(900)[0].mask === 7 && rule(900)[0].angle === -90);
ok('only_straight_on 對應到直行的那條', rule(901)[0].kind === 'only' && rule(901)[0].angle === 0);
ok('to 道路穿過 via 點：用轉彎角度選右轉的方向（往南）', rule(902)[0].angle === 90 && !!rule(902)[0].cond);
ok('type=restriction:motorcar 只對汽車', rule(904).every(r => r.mask === 1));
ok('via way（中央分隔島迴轉道）：記錄 from → via 邊序列 → to', rule(905).length === 1 && rule(905)[0].viaArcs.length === 1);

console.log('⑥ 路徑搜尋（以有向邊為狀態的 A*）');
const R = new OsmRouter(g), R0 = new OsmRouter(g, { ignoreRestrictions: true }), pairs = r => { const s = new Set(); for (let i = 1; i < r.arcs.length; i++) s.add(r.arcs[i - 1] + '>' + r.arcs[i]); return s; };
const has = (r, x) => !!r && !r.error && pairs(r).has(x.from + '>' + x.to);
// 找一組起訖點：不考慮轉向限制時，最短路線正好會做這個被禁止的動作 —— 這樣才能證明是「限制」讓路線改變
const bad = (r, x) => x.kind === 'no' ? has(r, x) : !!r && !r.error && [...pairs(r)].some(p => p.startsWith(x.from + '>') && p !== x.from + '>' + x.to);
function caseFor(x, profile, base = R0) { for (let s = 0; s < V.n; s++) for (let t = 0; t < V.n; t++) { if (s === t) continue; const r = base.routeVertices(s, t, profile); if (r && bad(r, x)) return [s, t]; } return null; }
const check = (name, x, profile, Rr = R, exempt = null) => {
  const c = caseFor(x, profile); if (!c) { ok(name + '（找不到會用到這個動作的起訖點）', false); return; }
  const r = Rr.routeVertices(c[0], c[1], profile), r0 = R0.routeVertices(c[0], c[1], profile);
  ok(name, r && !bad(r, x) && r.cost > r0.cost, `不限制 ${r0.cost.toFixed(0)} 秒 → 遵守限制 ${r ? r.cost.toFixed(0) + ' 秒' : '無路線'}`);
  if (exempt) { const re = R.routeVertices(c[0], c[1], exempt), re0 = R0.routeVertices(c[0], c[1], exempt); ok(`  ${exempt} 不受這條限制（同一組起訖點的路線與不限制時相同）`, !!re && !!re0 && Math.abs(re.cost - re0.cost) < 1e-6); }
};
check('禁止左轉（no_left_turn）：汽車改道', rule(900)[0], 'car', R, 'bike');
ok('except=bicycle：自行車的限制表裡沒有這條；行人也沒有', !R.profile('bike').no.get(rule(900)[0].from)?.has(rule(900)[0].to) && !R.profile('foot').no.size && !R.profile('foot').only.size);
check('只准直行（only_straight_on）：從南邊進 (2,2) 的汽車不能轉彎', rule(901)[0], 'car');
const U1 = [LAT0 - 0.002, LON0 + 0.0008], U2 = [LAT0 - 0.0025, LON0 + 0.0008];                // 分隔北側、南側車道上的點
const u = rule(905)[0], uv = { kind: 'no', from: u.viaArcs[0], to: u.to }, r3 = R.route({ from: U1, to: U2, profile: 'car' }), r30 = R0.route({ from: U1, to: U2, profile: 'car' });
ok('via way 禁止迴轉：不走 分隔北側→迴轉道→分隔南側，改繞遠路', has(r30, uv) && pairs(r30).has(u.from + '>' + u.viaArcs[0]) && !(has(r3, uv) && pairs(r3).has(u.from + '>' + u.viaArcs[0])) && r3.distanceM > r30.distanceM, `${r30.distanceM} → ${r3.distanceM} m`);
const r3f = R.route({ from: U1, to: U2, profile: 'foot' });
ok('行人不受轉向限制與單行限制（走迴轉道）', !r3f.error && r3f.ways.some(w => w.id === 402) && r3f.distanceM < 500, `${r3f.distanceM} m`);
const cr = rule(902)[0], Rc = new OsmRouter(g, { applyConditional: true });
ok('有時段條件的限制：預設不套用並回報', !R.profile('car').no.get(cr.from)?.has(cr.to) && R.profile('car').condSkipped === 1 && Rc.profile('car').no.get(cr.from)?.has(cr.to));
check('  選擇套用時路線會遵守', cr, 'car', Rc);
check('restriction:motorcar 只擋汽車', rule(904)[0], 'car', R, 'moto');
const ow = R.route({ from: at(4, 4), to: at(4, 0), profile: 'car' }), owb = R.route({ from: at(4, 4), to: at(4, 0), profile: 'bike' });
ok('單行道：汽車不逆向（繞路）；腳踏車可逆向（oneway:bicycle=no）', !ow.error && ow.distanceM > 500 && !owb.error && owb.distanceM < 500, `${ow.distanceM} vs ${owb.distanceM} m`);
const mw = R.route({ from: at(2, 2), to: [LAT0 - 0.001, LON0 - 0.004], profile: 'car' }), mwm = R.route({ from: at(2, 2), to: [LAT0 - 0.001, LON0 - 0.004], profile: 'moto' });
ok('國道：汽車走得到；機車不能走（終點只能吸附到最近的一般道路）', mw.ways.some(w => w.id === 600) && !mwm.ways.some(w => w.id === 600) && mwm.snap.toM > 300);
const bc = R.route({ from: at(0, 3), to: [LAT0 + 0.003, LON0 - 0.002], profile: 'car' }), bb = R.route({ from: at(0, 3), to: [LAT0 + 0.003, LON0 - 0.002], profile: 'bike' });
const bolV = vOf(B + 6001)[0], passes = r => r.arcs.some(a => R.tail(a) === bolV);
ok('車阻：汽車過不去（終點在車阻後面 → 停在車阻前，註明改吸附）；腳踏車可以到', (bc.error === 'NO_ROUTE' || (!passes(bc) && bc.snap.toM > 90 && bc.snap.toNearestM < 1)) && !bb.error && bb.snap.toM < 1 && passes(bb), bc.error || `汽車停在 ${bc.snap.toM} m 外`);
const lc = R.route({ from: [LAT0 + 0.0045, LON0 + 0.001], to: at(0, 3), profile: 'foot' });
ok('高度層錯接的橋：不能在橋上轉進平面道路（起點改吸附到平面道路，路線不經過這座橋）', lc.error === 'NO_ROUTE' || (!lc.ways.some(w => w.id === 710) && 'fromNearestM' in lc.snap), lc.error || `改吸附 ${lc.snap.fromNearestM} → ${lc.snap.fromM} m`);
const tk = R.route({ from: at(0, 4), to: [LAT0 + 0.0052, LON0], profile: 'car' }), pv = R.route({ from: at(1, 0), to: [LAT0 - 0.0008, LON0 + 0.001], profile: 'car' });
ok('通行未知、有條件的路段：可以走，但結果列出警告', tk.warnings.unknownM > 100 && pv.warnings.limitedM > 50, `未知 ${tk.warnings.unknownM} m、有條件 ${pv.warnings.limitedM} m`);
const Rf = new OsmRouter(g, { policy: { ...A.DEFAULT_POLICY, unknown: 'forbid' } }), tkf = Rf.route({ from: at(0, 4), to: [LAT0 + 0.0052, LON0], profile: 'car' });
ok('政策改成「未知＝禁止」時不走未知路段', tkf.error || tkf.warnings.unknownM === 0);
const rb = R.route({ from: at(4, 2), to: [LAT0 + 0.002, LON0 + 0.0065 + 0.0005], profile: 'car' }), south = [LON0 + 0.0065, LAT0 + 0.002 - 0.0005];
ok('圓環照方向繞行（逆時針：西 → 南 → 東，不從北邊逆向）', !rb.error && rb.ways.some(w => w.id === 500) && rb.coords.some(c => Math.abs(c[0] - south[0]) < 1e-7 && Math.abs(c[1] - south[1]) < 1e-7), `${rb.distanceM} m`);
const e201 = edgesOfWay(201), sg = R.describe([2 * e201[0], 2 * e201[1]], 'car');                  // (0,1) → (1,1)【號誌】→ (2,1)，速限 50
const exp201 = sg.distanceM / (50 * FLOW.car[R.wcls[g.E.way[e201[0]]]] / 3.6) + DELAY.car.j4;
ok('時間＝長度 ÷（速限 × 平均／速限比例）＋號誌等待（與網頁 ETA 同一套參數）；路線有座標與 way 清單', sg.coords.length === 3 && sg.ways[0].id === 201 && Math.abs(sg.durationS - exp201) <= 1, `${sg.distanceM} m、${sg.durationS} 秒（應為 ${exp201.toFixed(1)}）`);
ok('  分段時間（給導航 ETA）：各段行駛時間＋路口延遲＝總時間', Math.abs(sg.timing.segS.reduce((a, b) => a + b, 0) + sg.timing.delays.reduce((a, d) => a + d[1], 0) - sg.durationS) <= 1 && sg.timing.segS.length === sg.coords.length - 1 && sg.timing.delays.some(d => d[0] === 1 && d[1] === DELAY.car.j4));
// 轉彎成本、道路等級成本、區域速限
const arcUV = (a, b) => { const u = vOf(a)[0], v = vOf(b)[0]; for (let k = R.outStart[u]; k < R.outStart[u + 1]; k++) if (R.head(R.outArc[k]) === v) return R.outArc[k]; return -1; };
{ const inA = arcUV(nid(0, 2), nid(1, 2)), L = arcUV(nid(1, 2), nid(1, 3)), Rt = arcUV(nid(1, 2), nid(1, 1)), Pc = R.profile('car'), Pm = R.profile('moto'), v = vOf(nid(1, 2))[0];
  const dl = R.turnS(Pc, inA, L, v), dr = R.turnS(Pc, inA, Rt, v), ml = R.turnS(Pm, inA, L, v);
  ok('轉彎延遲：左轉比右轉久（台灣靠右）；機車左轉多為兩段式', dl - dr === DELAY.car.left - DELAY.car.right && ml === DELAY.moto.j3 + DELAY.moto.left && R.turnAngle(inA, L) < -60 && R.turnAngle(inA, Rt) > 60, `汽車左 ${dl}／右 ${dr} 秒、機車左 ${ml} 秒`); }
{ const a = arcUV(nid(0, 0), nid(1, 0)), Pc = R.profile('car'); ok('道路等級係數只影響選路：巷弄的成本＝時間 × 1.25，時間不變', Math.abs(Pc.cost[a] - Pc.time[a] * 1.25) < 1e-3); }
{ const a = arcUV(nid(0, 0), nid(0, 1)), l = R.limitOf(a); ok('maxspeed=TW:urban → 法定速限 50（巷弄推估 30 取較低），不算「速限未知」', l.src === 'zone' && l.kmh === 30 && T.zoneMaxspeed({ 'maxspeed:type': 'TW:urban' }) === 50 && T.zoneMaxspeed({ 'maxspeed:type': 'TW:urban', lane_markings: 'no' }) === 30 && Number.isNaN(T.zoneMaxspeed({ 'maxspeed:type': 'TW:trunk' })), `${l.kmh} km/h（${l.src}）`); }
ok('maxspeed 的各車道寫法「50|40」取最高、duration「01:30」「90」「PT1H」換算秒', T.parseMaxspeed('50|40') === 50 && T.parseDuration('01:30') === 5400 && T.parseDuration('90') === 5400 && T.parseDuration('PT1H') === 3600 && T.parseDuration('0:20:30') === 1230);
// 最短距離、出發方向
{ const f = R.route({ from: at(0, 0), to: at(4, 4), profile: 'car' }), d = R.route({ from: at(0, 0), to: at(4, 4), profile: 'car', metric: 'distance' });
  ok('「最短距離」路線不比「最快」長；兩者都有時間', !f.error && !d.error && d.distanceM <= f.distanceM && d.durationS > 0, `最快 ${f.distanceM} m／${f.durationS} 秒、最短 ${d.distanceM} m／${d.durationS} 秒`); }
{ const p = [LAT0, LON0 + 0.0015], east = R.route({ from: p, to: at(4, 0), profile: 'car', heading: 90 }), west = R.route({ from: p, to: at(4, 0), profile: 'car', heading: 270 });
  ok('出發方向（偏航重新規劃用）：車頭朝反方向時要先迴轉，時間較長、標在第一點', !east.error && !west.error && west.durationS > east.durationS && west.timing.delays.some(d => d[0] === 0) && !east.timing.delays.some(d => d[0] === 0), `朝東 ${east.durationS} 秒、朝西 ${west.durationS} 秒`); }
// 渡輪
{ const isle = [LAT0 + 0.004, LON0 + 0.022], far = [LAT0 + 0.004, LON0 + 0.031], fw = R.route({ from: at(4, 4), to: isle, profile: 'foot' }), fc = R.route({ from: at(4, 4), to: isle, profile: 'car' });
  const fb = R.route({ from: at(4, 4), to: isle, profile: 'bike' }), ff = R.route({ from: at(4, 4), to: far, profile: 'foot' }), sea = R.route({ from: [LAT0 + 0.004, LON0 + 0.012], to: at(4, 4), profile: 'foot' });
  ok('渡輪：行人搭船到小島（OSM duration 20 分鐘），步驟有「渡輪」、結果註明不含候船時間', !fw.error && fw.ferries.length === 1 && Math.abs(fw.ferries[0].durationS - 1200) <= 1 && fw.ferries[0].source === 'OSM duration' && fw.steps.some(st => st.type === 'ferry') && fw.warnings.ferryM > 1000 && /不含候船/.test(fw.ferries[0].note), fw.error || `${fw.durationS} 秒`);
  ok('  只載人的渡輪（motor_vehicle=no）：汽車到不了小島', fc.error === 'NO_ROUTE');
  ok('  標了 bicycle=yes：自行車可以搭', !fb.error && fb.ferries.length === 1);
  ok('  沒標航行時間的渡輪：依平均航速推估並標示', !ff.error && ff.ferries.length === 2 && ff.ferries[1].source === '依平均航速推估');
  ok('  起點點在海上：不吸附到航線，改吸附到最近的道路', !sea.error && sea.ways[0].highway !== 'ferry' && sea.snap.fromM > 100, `吸附 ${sea.snap.fromM} m`); }
  const nIsle = R.route({ from: at(0, 4), to: [LAT0 + 0.0150, LON0 + 0.0010], profile: 'foot' });
  ok('  航線端點沒接上道路：建圖補「碼頭連接（推估）」接到最近的道路頂點，搭得到；結果標示推估的連接長度', S.ferryPierLinks === 1 && S.ferryUnlinkedEnds === 0 && !nIsle.error && nIsle.warnings.pierLinkM > 10 && nIsle.ferries.length === 1 && nIsle.ways.some(w => w.highway === 'pier_link'), nIsle.error || `連接 ${nIsle.warnings.pierLinkM} m`);
// 地標（ALT）：結果與不用地標完全相同，只是展開較少
{ const { buildAlt, writeAlt, altLoader } = await import('../server/osm/alt.mjs'), tables = { car: buildAlt(R, 'car'), foot: buildAlt(R, 'foot') };
  const Ra = new OsmRouter(g, { alt: tables }); let same = 0, diff = 0, sa = 0, sn = 0, pruned = 0;
  for (const pf of ['car', 'foot']) for (let s0 = 0; s0 < V.n; s0 += 2) for (let t0 = 1; t0 < V.n; t0 += 3) {
    if (s0 === t0) continue; const a = Ra.routeVertices(s0, t0, pf), b = R.routeVertices(s0, t0, pf, { noAlt: true });
    if (!a !== !b) { diff++; continue; } if (!a) { pruned++; continue; } if (Math.abs(a.cost - b.cost) < 1e-6) same++; else diff++; sa += a.settled; sn += b.settled;
  }
  ok('地標（ALT）：每一組起訖點的成本都與不用地標相同；展開的有向邊較少', diff === 0 && same > 500 && sa < sn, `${same} 組相同、${diff} 組不同、到不了 ${pruned} 組；展開 ${sa} vs ${sn}`);
  writeAlt(tmpAlt + '/a.bin', tables); const ld = altLoader(tmpAlt + '/a.bin'), lc = ld('car');
  ok('  地標表寫檔後讀回相同；只讀用到的運具；模型參數不同的表不採用', lc && lc.k === tables.car.k && lc.fwd.every((x, i) => x === tables.car.fwd[i]) && ld('bike') === null && new OsmRouter(g, { alt: { car: { ...tables.car, model: 'old' } } }).altFor('car') === null); }
// 吸附到路段：路段中間的點（偏離 30 m）→ 只算走到的那一段
const mid = (i, j) => [LAT0 + j * D, LON0 + i * D], off = 30 / 110574;
const sm = R.route({ from: [LAT0 + off, LON0 + 0.0005], to: [LAT0 + off, LON0 + 0.0025], profile: 'car' }), m200 = 0.002 * 111320 * Math.cos(LAT0 * Math.PI / 180);
ok('吸附到最近的路段（投影點），不是最近的路口；頭尾只算走到的部分', !sm.error && Math.abs(sm.snap.fromM - 30) < 0.5 && Math.abs(sm.snap.toM - 30) < 0.5 && Math.abs(sm.distanceM - m200) < 2 && sm.ways.every(w => w.id === 200), `${sm.distanceM} m（應為 ${m200.toFixed(0)}）`);
ok('  路線座標從投影點開始、到投影點結束', !sm.error && Math.abs(sm.coords[0][0] - (LON0 + 0.0005)) < 1e-6 && Math.abs(sm.coords[0][1] - LAT0) < 1e-6 && Math.abs(sm.coords.at(-1)[0] - (LON0 + 0.0025)) < 1e-6);
const sx = R.route({ from: [LAT0 + 0.0028, LON0 + 0.004], to: [LAT0 + 0.0022, LON0 + 0.004], profile: 'car' }), sxb = R.route({ from: [LAT0 + 0.0028, LON0 + 0.004], to: [LAT0 + 0.0022, LON0 + 0.004], profile: 'bike' });
ok('同一條單行道上往回走：汽車要繞一圈；腳踏車（可逆向）直接走', !sx.error && sx.distanceM > 300 && !sxb.error && Math.abs(sxb.distanceM - 0.0006 * 110574) < 2, `汽車 ${sx.distanceM} m、腳踏車 ${sxb.distanceM} m`);
const sd = R.route({ from: [LAT0 + 0.0022, LON0 + 0.004], to: [LAT0 + 0.0028, LON0 + 0.004], profile: 'car' });
ok('  順著單行方向：同一條邊直接到', !sd.error && Math.abs(sd.distanceM - 0.0006 * 110574) < 2 && sd.arcs.length === 1, `${sd.distanceM} m`);
ok('起訖點正好在路口上：與頂點版路線相同', (() => { const a = R.route({ from: at(0, 2), to: at(3, 4), profile: 'car' }), b = R.routeVertices(vOf(nid(0, 2))[0], vOf(nid(3, 4))[0], 'car'); return !a.error && b && JSON.stringify(a.arcs) === JSON.stringify(b.arcs); })());

console.log('⑦ 圖檔（TWOSM1）與建置工具');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'osm-')); writeGraph(tmp + '/g.twosm', g, { test: 1 });
const g2 = readGraph(tmp + '/g.twosm'), R2 = new OsmRouter(g2), q = R2.route({ from: at(0, 2), to: at(2, 4), profile: 'car' });
const q0 = R.route({ from: at(0, 2), to: at(2, 4), profile: 'car' });
ok('寫出後讀回：數量、字串、轉向限制、路線完全相同', g2.V.n === V.n && g2.E.n === E.n && g2.strings.join() === g.strings.join() && g2.restrictions.rules.length === RS.rules.length && JSON.stringify(q.arcs) === JSON.stringify(q0.arcs));
const run = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', tmp + '/out', '--no-osmium'], { encoding: 'utf8' });
const cur = existsSync(tmp + '/out/current.json') ? JSON.parse(readFileSync(tmp + '/out/current.json', 'utf8')) : null, man = cur ? JSON.parse(readFileSync(`${tmp}/out/${cur.dir}/manifest.json`, 'utf8')) : null;
ok('osm-build：輸出圖檔、manifest（來源、版本、MD5）、報告，最後才更新 current.json', run.status === 0 && man && man.graph.md5.length === 32 && man.counts.vertices === V.n && existsSync(`${tmp}/out/${cur.dir}/report.md`), run.status ? run.stderr.slice(0, 200) : `${man.graph.bytes} bytes`);
// 命令列：Windows PowerShell 用 npm run 時 `--` 會被 npm.ps1 吃掉，旗標變成 npm_config_*、值變成一般參數（逗號被拆成空白）
{ const env0 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('npm_config_')));
  const rt = (args, env = {}) => spawnSync(process.execPath, [ROOT + '/tools/osm/osm-route.mjs', ...args], { encoding: 'utf8', env: { ...env0, ...env } });
  const A = at(0, 2), Bq = at(2, 4), lines = r => r.stdout.split('\n').filter(l => /^(car|moto)：/.test(l)).map(l => l.replace(/搜尋 [\d,]+ 條有向邊、\d+ ms；/, '')).join('|');
  const n0 = rt(['--graph', tmp + '/g.twosm', '--from', A.join(','), '--to', Bq.join(','), '--profile', 'car,moto']);
  const n1 = rt([tmp + '/g.twosm', A.join(' '), Bq.join(' '), 'car moto'], { npm_config_from: 'true', npm_config_to: 'true', npm_config_profile: 'true', npm_config_graph: 'true' });
  const n2 = rt(['--graph', tmp + '/g.twosm', '--from', String(A[0]), String(A[1]), '--to', String(Bq[0]), String(Bq[1]), '--profile', 'car', 'moto']);
  const n3 = rt(['--graph', tmp + '/g.twosm', '--from', `${A[1]},${A[0]}`, '--to', `${Bq[1]},${Bq[0]}`, '--profile', 'car,moto']);
  const n4 = rt(['--graph', tmp + '/g.twosm', '--profile', 'car']);
  ok('osm-route：一般寫法算得出汽車、機車兩條路線', n0.status === 0 && lines(n0).split('|').length === 2, n0.status ? n0.stderr.slice(0, 160) : lines(n0));
  ok('  PowerShell＋npm（旗標被吃掉、逗號變空白）：結果相同', n1.status === 0 && lines(n1) === lines(n0), n1.status ? n1.stderr.slice(0, 160) : '');
  ok('  PowerShell 直接打、沒加引號（座標被拆成兩個參數）：結果相同', n2.status === 0 && lines(n2) === lines(n0));
  ok('  寫成「經度,緯度」：自動對調並提醒', n3.status === 0 && lines(n3) === lines(n0) && /已對調/.test(n3.stdout));
  ok('  少了起終點：說明用法（不丟出程式錯誤）', n4.status === 2 && /需要起點和終點/.test(n4.stderr) && !/TypeError/.test(n4.stderr));
  const { createHash } = await import('node:crypto'), fmd5 = createHash('md5').update(readFileSync(FIX)).digest('hex');
  const b9 = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', FIX, fmd5], { encoding: 'utf8', env: { ...env0, npm_config_pbf: 'true', npm_config_md5: 'true', npm_config_osmium: 'false', npm_config_out: tmp + '/sw' } });
  ok('osm-build：PowerShell＋npm（--pbf、--md5、--no-osmium、--out=… 被 npm 吃掉）仍照指定的檔案、MD5、輸出資料夾建圖', b9.status === 0 && /MD5 相符.*--md5/.test(b9.stdout) && !/tags-filter/.test(b9.stdout) && existsSync(tmp + '/sw/current.json'), b9.status ? b9.stderr.slice(0, 200) : ''); }
// 有 osmium-tool 時：先 tags-filter 再建圖，結果要與直接讀原檔完全相同
if (spawnSync('osmium', ['--version']).status === 0) {
  const b1 = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', tmp + '/os'], { encoding: 'utf8' }), cur1 = JSON.parse(readFileSync(tmp + '/os/current.json', 'utf8')), g3 = readGraph(`${tmp}/os/${cur1.graph}`), g4 = readGraph(`${tmp}/out/${cur.graph}`);
  const same = ['V', 'E', 'G', 'W'].every(k => Object.keys(g3[k]).every(f => !ArrayBuffer.isView(g3[k][f]) || (g3[k][f].length === g4[k][f].length && g3[k][f].every((x, i) => x === g4[k][f][i] || (Number.isNaN(x) && Number.isNaN(g4[k][f][i])))))) && JSON.stringify(g3.restrictions.rules) === JSON.stringify(g4.restrictions.rules);
  ok('osmium tags-filter 預先篩選後建圖：資料與直接讀原檔完全相同', b1.status === 0 && /osmium tags-filter/.test(b1.stdout) && same && JSON.parse(readFileSync(`${tmp}/os/${cur1.dir}/manifest.json`, 'utf8')).filteredWith.startsWith('osmium'));
} else console.log('  （沒有 osmium-tool，略過 osmium 預先篩選的比對）');
const rep = validateGraph(g, R);
ok('檢查報告：各運具的強連通分量與通行狀態分布', rep.profiles.car.components >= 1 && rep.profiles.foot.largestPct > rep.profiles.car.largestPct && rep.profiles.car.directedKm.oneway > 0, `汽車 ${rep.profiles.car.components} 個、步行 ${rep.profiles.foot.components} 個`);
// 手動下載的檔案（沒有下載紀錄）：放進 data/osm/raw 就自動找到並記錄；有 .md5 就驗證；--pbf 可配 --md5
{ const { mkdirSync, copyFileSync, writeFileSync } = await import('node:fs'), { createHash } = await import('node:crypto'), md5 = createHash('md5').update(readFileSync(FIX)).digest('hex');
  const bld = (...a) => spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--no-osmium', ...a], { encoding: 'utf8' });
  mkdirSync(tmp + '/m/raw', { recursive: true });
  const e0 = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out');
  ok('沒有任何 OSM 檔：列出三種做法（放進資料夾、--pbf、下載）', e0.status === 2 && /--pbf/.test(e0.stderr) && /osm:download/.test(e0.stderr));
  copyFileSync(FIX, tmp + '/m/raw/taiwan-20261117.osm.pbf');
  const e1 = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out'), mm = JSON.parse(readFileSync(tmp + '/m/raw/manifest.json', 'utf8')).downloads[0];
  ok('手動放進 data/osm/raw：自動使用、補記錄（來源＝手動、MD5、PBF 表頭）', e1.status === 0 && /使用 /.test(e1.stdout) && mm.url === 'manual' && mm.md5 === md5 && mm.md5Verified === false, e1.status ? e1.stderr.slice(0, 160) : mm.file);
  const e1b = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out1b'), e1c = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out1c', '--md5', 'f'.repeat(32));
  const e1d = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out1d', '--md5', md5), mm2 = JSON.parse(readFileSync(tmp + '/m/raw/manifest.json', 'utf8')).downloads[0];
  ok('已登記的手動檔：說明「與登記時相同、尚未與官方比對」；加 --md5 不符就停、相符就記成已驗證', e1b.status === 0 && /尚未與 Geofabrik 官方 MD5 比對/.test(e1b.stdout) && e1c.status === 1 && e1d.status === 0 && mm2.md5Verified === true && /已與 Geofabrik 官方 MD5 比對/.test(e1d.stdout));
  writeFileSync(tmp + '/m/raw/taiwan-20261117.osm.pbf.md5', '0'.repeat(32) + '  taiwan-latest.osm.pbf\n'); copyFileSync(FIX, tmp + '/m/raw/taiwan-20261118.osm.pbf');
  writeFileSync(tmp + '/m/raw/taiwan-20261118.osm.pbf.md5', '1'.repeat(32) + '  taiwan-latest.osm.pbf\n');
  const e2 = bld('--raw', tmp + '/m/raw', '--out', tmp + '/m/out');
  ok('旁邊的 .md5 不符：停下來，不建圖', e2.status === 1 && /MD5 不符/.test(e2.stderr));
  const e3 = bld('--pbf', FIX, '--md5', md5, '--out', tmp + '/m/out3'), e4 = bld('--pbf', FIX, '--md5', 'f'.repeat(32), '--out', tmp + '/m/out4');
  ok('--pbf ＋ --md5：相符才建圖', e3.status === 0 && /MD5 相符/.test(e3.stdout) && e4.status === 1); }

// 下載工具：用本機假伺服器模擬 Geofabrik（taiwan-latest.osm.pbf ＋ .md5）
{ const http = await import('node:http'), { createHash } = await import('node:crypto'), body = readFileSync(FIX); let md5 = createHash('md5').update(body).digest('hex');
  const srv = http.createServer((q, r) => { if (q.url.endsWith('.md5')) { r.end(`${md5}  taiwan-latest.osm.pbf\n`); return; } r.writeHead(200, { 'content-length': body.length, 'last-modified': 'Tue, 17 Nov 2026 20:21:00 GMT', etag: '"abc"' }); r.end(body); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${srv.address().port}/asia/taiwan-latest.osm.pbf`, dl = (...a) => new Promise(res => { const p = spawn(process.execPath, [ROOT + '/tools/osm/osm-download.mjs', '--url', url, '--dir', tmp + '/raw', ...a]); let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d); p.on('close', code => res({ code, out })); });
  const { spawn } = await import('node:child_process');
  const d1 = await dl(), m1 = JSON.parse(readFileSync(tmp + '/raw/manifest.json', 'utf8')).downloads;
  ok('下載：MD5 與 Geofabrik 相符、保留原始檔、記錄來源版本（Last-Modified、ETag、PBF 表頭）', d1.code === 0 && m1.length === 1 && m1[0].md5Verified && m1[0].etag === '"abc"' && /^taiwan-\d{8}\.osm\.pbf$/.test(m1[0].file) && existsSync(tmp + '/raw/' + m1[0].file) && m1[0].pbf.writingProgram.includes('libosmium'), m1[0] && m1[0].file);
  const d2 = await dl(); ok('MD5 跟上次一樣：不重新下載', d2.code === 0 && /沒有新版本/.test(d2.out));
  const b2 = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--raw', tmp + '/raw', '--out', tmp + '/out2', '--no-osmium'], { encoding: 'utf8' }), m2 = existsSync(tmp + '/out2/current.json') && JSON.parse(readFileSync(`${tmp}/out2/${JSON.parse(readFileSync(tmp + '/out2/current.json', 'utf8')).dir}/manifest.json`, 'utf8'));
  ok('osm-build 不指定檔案：用最新下載、先驗證原始檔 MD5，manifest 記錄來源網址與 MD5', b2.status === 0 && /MD5 相符/.test(b2.stdout) && m2 && m2.source === url && m2.sourceMd5 === m1[0].md5, b2.status ? b2.stderr.slice(0, 150) : '');
  md5 = '0'.repeat(32); const d3 = await dl('--force'), m3 = JSON.parse(readFileSync(tmp + '/raw/manifest.json', 'utf8')).downloads;
  ok('MD5 不符：拒絕並刪除下載的檔案，不寫進紀錄', d3.code !== 0 && /MD5 不符/.test(d3.out) && m3.length === 1);
  srv.close(); }
rmSync(tmp, { recursive: true, force: true });

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
