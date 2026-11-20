// nav-hmm.mjs — v1.11 HMM Map Matching（js/hmm-match.js）vs 舊的視窗最近線段（RouteTrack.match）
// 情境（模擬資料，固定亂數種子可重現）：路線在雙向分隔道路上「去、迴轉、回」——兩個方向相距 15 m，都在同一條路線上；
// GPS 雜訊 σ＝6～9 m，高速（有可信方向）與低速（方向不可信）各跑一次。量的是「進度（沿路線距離）」對不對，以及有沒有誤判偏航。
import { ok, done, rng, gauss } from './helpers.mjs';
const { State } = await import('../js/state.js'); State.coordType = 'wgs84';
const { RouteTrack } = await import('../js/mapmatch.js'); const { HmmRouteMatcher } = await import('../js/hmm-match.js'); const { NavigationEngine } = await import('../js/navigation.js');
const LON0 = 120.67, LAT0 = 24.12, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180), ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
// 路線（公尺）：往東 600 m → 往南 15 m（迴轉道）→ 往西 600 m；每 20 m 一點
const P = []; for (let x = 0; x <= 600; x += 20) P.push([x, 0]); P.push([600, -15]); for (let x = 580; x >= 0; x -= 20) P.push([x, -15]);
const route = { coords: P.map(([x, y]) => ll(x, y)) }, T = new RouteTrack(route), TOTAL = T.total;
const at = s => { const [x, y] = T.at(s); return T.mToWorld(x, y); };
const brgAt = s => T.segBearing(Math.min(T._segAt(s), T.n - 2));
function sim({ v, sigma, seed, headingOk }) {
  const R = rng(seed), out = []; let t = 1e6;
  for (let s = 0; s <= TOTAL; s += v) { const [wx, wy] = at(s), [mx, my] = T.worldToM(wx, wy), nx = mx + gauss(R) * sigma, ny = my + gauss(R) * sigma; out.push({ s, mx: nx, my: ny, t, heading: headingOk ? (brgAt(s) + gauss(R) * 8 + 360) % 360 : null, speed: v, accuracy: sigma * 1.5 }); t += 1000; }
  return out;
}
function compare(name, opt) {
  const seq = sim(opt); let hint = 0, wBad = 0, hBad = 0, wErr = 0, hErr = 0; const H = new HmmRouteMatcher(T);
  for (const f of seq) {
    const w = T.match(f.mx, f.my, { hintS: hint, heading: f.heading, speed: f.speed }); hint = w.s;
    const h = H.step(f, 0);
    const ew = Math.abs(w.s - f.s), eh = Math.abs(h.s - f.s); wErr += ew; hErr += eh; if (ew > 60) wBad++; if (eh > 60) hBad++;
  }
  const n = seq.length;
  console.log(`  ${name}：${n} 筆；進度錯到另一側（誤差 > 60 m）視窗法 ${wBad}（${(100 * wBad / n).toFixed(1)}%）、HMM ${hBad}（${(100 * hBad / n).toFixed(1)}%）；平均誤差 ${(wErr / n).toFixed(1)} m → ${(hErr / n).toFixed(1)} m`);
  return { wBad, hBad, n, wErr: wErr / n, hErr: hErr / n };
}
console.log('① 路線層級的匹配（RouteTrack.match vs HMM）');
const fast = compare('高速 10 m/s、σ 6 m、有方向', { v: 10, sigma: 6, seed: 7, headingOk: true });
const slow = compare('低速 2 m/s、σ 9 m、沒有方向（停走、塞車）', { v: 2, sigma: 9, seed: 11, headingOk: false });
const slow2 = compare('低速 3 m/s、σ 8 m、沒有方向（另一組亂數）', { v: 3, sigma: 8, seed: 23, headingOk: false });
ok('高速：HMM 不比視窗法差', fast.hBad <= fast.wBad);
ok('低速沒有方向：HMM 錯到另一側的比例 < 2%', slow.hBad / slow.n < 0.02 && slow2.hBad / slow2.n < 0.02, `${slow.hBad}/${slow.n}、${slow2.hBad}/${slow2.n}`);
ok('低速沒有方向：HMM 比視窗法少錯', slow.hBad + slow2.hBad < slow.wBad + slow2.wBad || slow.wBad + slow2.wBad === 0, `視窗法 ${slow.wBad + slow2.wBad}、HMM ${slow.hBad + slow2.hBad}`);

console.log('② 導航引擎（含進度防跳、偏航防抖）：matcher=window vs hmm');
function engineRun(matcher, opt) {
  const eng = new NavigationEngine({ matcher }); eng.start(route, [], () => 10); const ev = []; eng.on(t => ev.push(t)); let maxErr = 0, sum = 0, n = 0;
  for (const f of sim(opt)) { const [wx, wy] = T.mToWorld(f.mx, f.my); const st = eng.update({ lon: wx, lat: wy, accuracy: f.accuracy, heading: f.heading, speed: f.speed, timestamp: f.t }); const e = Math.abs(st.s - f.s); maxErr = Math.max(maxErr, e); sum += e; n++; }
  return { maxErr, mean: sum / n, offroute: ev.filter(t => t === 'offroute').length };
}
for (const [name, opt] of [['低速 2 m/s、σ 9 m、沒有方向', { v: 2, sigma: 9, seed: 11, headingOk: false }], ['高速 10 m/s、σ 6 m', { v: 10, sigma: 6, seed: 7, headingOk: true }]]) {
  const a = engineRun('window', opt), b = engineRun('hmm', opt);
  console.log(`  ${name}：進度平均誤差 ${a.mean.toFixed(1)} → ${b.mean.toFixed(1)} m、最大 ${a.maxErr.toFixed(0)} → ${b.maxErr.toFixed(0)} m、誤判偏航 ${a.offroute} → ${b.offroute} 次`);
  ok(`${name}：HMM 的最大進度誤差不比視窗法大、不誤判偏航`, b.maxErr <= a.maxErr + 5 && b.offroute === 0);
}
console.log('③ 真的離開路線：HMM 回報偏離，引擎照常偏航');
{ const H = new HmmRouteMatcher(T); let r; for (let i = 0; i < 6; i++) r = H.step({ mx: 300, my: 80 + i * 10, accuracy: 8, speed: 5, heading: 0, t: 1e6 + i * 1000 }, 300);
  ok('離路線 80～130 m：沒有候選 → off', r.off === true); }
done();
