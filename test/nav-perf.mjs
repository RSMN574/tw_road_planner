// 導航優化：轉錯路口快速偵測、ETA 依實際速度修正、語音提示距離隨車速放大（v1.18：路網封包 graph.bin 隨舊的本機路網移除）
import { ok, done, rng, gauss } from './helpers.mjs';
await import('../js/main.js');
const { State: S } = await import('../js/state.js'); const { generateManeuvers } = await import('../js/analysis.js');
const { NavigationEngine } = await import('../js/navigation.js'); const { GpsFilter } = await import('../js/gps-filter.js');
const { gridCity, alongM, lengthM } = await import('./osm-route-fixture.mjs');
S.coordType = 'wgs84';
// 5×5 格子（間距 400 m，每條路速限 36 km/h、一般道路），路線 (0,0) → (4,0) → (4,3)：伺服器 OSM 格式的合成路線（v1.18：舊的本機路網已移除）
const C = gridCity({ LON0: 120.67, LAT0: 24.12, sp: 400, uniform: { kmh: 36, cls: 1 } }), { ll } = C, G = 400;
const nodes = C.manhattan([[0, 0], [4, 0], [4, 3]]), route = C.route(nodes), man = generateManeuvers(route), pts = C.metersOf(nodes), total = lengthM(pts), spd = null;
const along = (s, P = pts) => alongM(P, s);
console.log(`路線：${nodes.length - 1} 段、${total} m、${man.length - 1} 個導航點（${man.slice(1).map(m => m.turnType + (m.dir ? ':' + m.dir : '')).join(' → ')}）`);
// 模擬一趟行駛：回傳 raw GPS 序列（含噪音）。測試用資料，只存在於測試中
function drive({ v = 10, sigma = 6, acc = 8, t0 = 1e6, from: s0 = 0, to: s1 = total, P = pts, seed = 3 } = {}) { const R = rng(seed), out = []; let t = t0; for (let s = s0; s <= s1; s += v) { const [x, y] = along(s, P), [lo, la] = ll(x + gauss(R) * sigma, y + gauss(R) * sigma); out.push({ lat: la, lon: lo, accuracy: acc, speed: v, heading: NaN, altitude: null, timestamp: t }); t += 1000; } return out; }
const run = (eng, seq, f = new GpsFilter()) => { const ev = [], states = []; eng.on((t, s) => { ev.push(t); }); for (const r of seq) { const x = f.process(r); if (x.accepted) states.push(eng.update(x.fix)); } return { ev, states, f }; };
const { ManeuverDetector, PROMPT_PROFILE, LEAD_S } = await import('../js/voice.js');

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

done();
