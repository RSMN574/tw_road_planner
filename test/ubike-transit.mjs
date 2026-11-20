// YouBike 接駁：大眾運輸的第一／最後一哩可以騎 YouBike（借車站 → 騎 → 還車站 → 上車站；下車站 → 借 → 騎 → 還 → 終點）
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, done } from './helpers.mjs';
import * as C from './metro-city.mjs';
const quiet = f => { const a = console.info, b = console.warn; console.info = console.warn = () => {}; try { return f(); } finally { console.info = a; console.warn = b; } };
const geo = await import('../js/geo.js'); await import('../js/main.js');
const { State } = await import('../js/state.js'), { buildGraph } = await import('../js/loader.js'), T = await import('../js/transit.js'), BP = await import('../js/bus-plan.js'), BC = await import('../js/bus-core.js');
const { loadUbike } = await import('../js/ubike.js'), { withQuery } = await import('../js/ctx.js'), { WALK_MAX_M, YB_RENT_S, YB_RETURN_S } = await import('../js/constants.js');

// 城市：公車路線少（很多地方走路到不了站）、綠線＋藍線捷運、YouBike 每 450 m 一站
const city = C.makeMetroCity({ toTWD97: geo.lonLatToTWD97, routes: 40 }), yb = [];
for (let c = 1; c < 80; c += 3) for (let r = 1; r < 62; r += 3) { const p = C.ll(c * 150 + 20, r * 150 + 15); yb.push({ StationUID: `TXG${c}_${r}`, StationID: `${c}_${r}`, StationName: { Zh_tw: `YouBike ${c}-${r}` }, StationPosition: { PositionLat: p.lat, PositionLon: p.lon }, BikesCapacity: 20, ServiceType: 2 }); }
quiet(() => { buildGraph(city.road); T.loadBus(city.bus); T.loadMetro(city.metro); loadUbike(yb); });
const W = p => geo.lonLatToWorld(p.lon, p.lat), b = State.bus;

// 找一個「走路 500 m 內沒有任何站、但 400 m 內有 YouBike」的起點，終點放在捷運站旁
let O = null;
for (let c = 2; c < 78 && !O; c += 1) for (let r = 2; r < 60 && !O; r += 1) { const p = C.ll(c * 150, r * 150), [x, y] = W(p); if (!BC.nearbyStops(x, y, 6, WALK_MAX_M, 'out').length) O = p; }
const D = C.near(C.st(city.metro, 'G16'), -50, 60);
console.log('① 起點走路到不了任何站：只能靠 YouBike 接駁');
ok('找到測試起點（500 m 內沒有站）', !!O);
const [ox, oy] = W(O), [dx, dy] = W(D);
const off = withQuery({ mode: 'transit', ubikeLink: false }, () => BP.suggestBusMulti(ox, oy, dx, dy));
ok('關掉 YouBike 接駁：找不到方案（跟以前一樣）', off.length === 1 && !!off[0].error, off[0].error);
const on = withQuery({ mode: 'transit', ubikeLink: true }, () => BP.suggestBusMulti(ox, oy, dx, dy)), o = on[0];
ok('打開 YouBike 接駁：有方案，起點騎 YouBike', on.length >= 1 && !o.error && !!o.bikeIn, o.error || `${on.length} 種，最快 ${Math.round(o.sec / 60)} 分`);
const L = BP.legsOf(o), types = L.map(l => l.type);
ok('分段：步行 → YouBike → 步行 → 搭乘 …', types[0] === 'WALK' && types[1] === 'BIKE' && types[2] === 'WALK' && /_RIDE$/.test(types[3]), types.join(' → '));
const bk = L[1], U = State.UB;
ok('借車站在起點 400 m 內、還車站在上車站 250 m 內', geo.worldDistM(ox, oy, U.x[o.bikeIn.rent], U.y[o.bikeIn.rent]) <= 400 && geo.worldDistM(U.x[o.bikeIn.ret], U.y[o.bikeIn.ret], b.x[o.rides[0].stops[0]], b.y[o.rides[0].stops[0]]) <= 250, `${bk.from.name} → ${bk.to.name}`);
ok('騎乘時間合理：不快於 18 km/h、含借還車時間', bk.rideS >= bk.m / (18 / 3.6) - 1 && bk.sec >= bk.rideS + YB_RENT_S + YB_RETURN_S - 1, `${bk.m} m、騎 ${bk.rideS} 秒、合計 ${bk.sec} 秒`);
const P = bk.path, d0 = geo.worldDistM(P[0][0], P[0][1], U.x[o.bikeIn.rent], U.y[o.bikeIn.rent]), d1 = geo.worldDistM(P[P.length - 1][0], P[P.length - 1][1], U.x[o.bikeIn.ret], U.y[o.bikeIn.ret]);
ok('騎乘路線沿道路（由借車站附近到還車站附近）', P.length >= 3 && d0 < 160 && d1 < 160, `${P.length} 點`);
let len = 0; for (let i = 1; i < P.length; i++) len += geo.worldDistM(P[i - 1][0], P[i - 1][1], P[i][0], P[i][1]);
ok('路線長度＝騎乘距離（不是直線）', Math.abs(len - bk.m) < 2 && bk.m >= geo.worldDistM(P[0][0], P[0][1], P[P.length - 1][0], P[P.length - 1][1]) - 1);
ok('標示推估、未含即時車輛', bk.estimate && /推估/.test(bk.src) && /即時/.test(bk.src));
const tot = L.reduce((a, l) => a + (l.sec ?? 0) + (l.rideS && l.type !== 'BIKE' ? l.rideS + (l.waitS || 0) : 0), 0);
ok('各段時間加總 ≈ 方案總時間', Math.abs(tot - o.sec) < 0.03 * o.sec + 30, `${Math.round(tot)} vs ${Math.round(o.sec)} 秒`);

console.log('② 終點也可以騎（最後一哩）');
const back = withQuery({ mode: 'transit', ubikeLink: true }, () => BP.suggestBusMulti(dx, dy, ox, oy)), ob = back.find(x => x.bikeOut);
ok('反方向：下車後騎 YouBike 到終點', !!ob && BP.legsOf(ob).slice(-3).map(l => l.type).join() === 'WALK,BIKE,WALK', ob && BP.legsOf(ob).map(l => l.type).join(' → '));

console.log('③ 走路就到得了的地方：騎車方案只在有好處時出現');
{ const A = C.near(C.st(city.metro, 'G3'), 60, 40), B = C.near(C.st(city.metro, 'G9'), 50, -40), [ax, ay] = W(A), [bx, by] = W(B);
  const r = withQuery({ mode: 'transit', ubikeLink: true }, () => BP.suggestBusMulti(ax, ay, bx, by));
  ok('捷運站旁到捷運站旁：推薦的還是直接走進捷運站', !r[0].bikeIn && BP.legsOf(r[0])[0].type === 'WALK', BP.legsOf(r[0]).map(l => l.type).join(' → '));
  ok('列出的騎車方案都是 Pareto 最優（不會被其他方案全面勝過）', r.filter(x => x.bikeIn || x.bikeOut).every(x => x.pareto)); }

console.log('④ API');
{ const Dd = mkdtempSync(path.join(os.tmpdir(), 'bp-yb-')); mkdirSync(Dd + '/graph'); mkdirSync(Dd + '/bus');
  for (const k of ['nodes', 'edges', 'roads']) writeFileSync(`${Dd}/graph/${k}.json`, JSON.stringify(city.road[k]));
  writeFileSync(Dd + '/bus/graph.json', JSON.stringify(city.bus)); writeFileSync(Dd + '/metro.json', JSON.stringify(city.metro)); writeFileSync(Dd + '/ubike.json', JSON.stringify(yb));
  const { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
  quiet(() => engine.loadData(readConfig({ DATA_DIR: Dd, CACHE_DIR: Dd + '/.c', LOG: '0' })));
  const q = p => `${p.lat},${p.lon}`, r = engine.transit({ from: q(O), to: q(D) }), op = r.options[r.recommended], bl = op.legs.find(l => l.type === 'BIKE');
  ok('/api/v1/transit：access＝ubike、BIKE 段含借還車站、距離、時間、路線幾何', op.access === 'ubike' && bl && bl.from.kind === 'ubike' && bl.to.name && bl.bikeM > 0 && bl.durationS > 0 && bl.geometry.length >= 2 && bl.estimate === true, bl && `${bl.from.name} → ${bl.to.name}，${bl.bikeM} m`);
  let e = null; try { engine.transit({ from: q(O), to: q(D), ubike: '0' }); } catch (x) { e = x; }
  ok('ubike=0：不考慮 YouBike（這個起點就沒有方案）', e && e.code === 'NO_TRANSIT_ROUTE');
  rmSync(Dd, { recursive: true, force: true }); }
done();
