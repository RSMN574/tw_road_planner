// speed-limit.mjs — v1.20：SpeedLimitService（來源優先順序、方向、時段、可信度、未知不補值）與 SpeedMeter（GPS 速度的異常值、漂移、靜止、品質、超速判斷）
// 測試資料都是假的（小型道路圖替身、模擬的 GPS），數字只代表測試
import { ok, done } from './helpers.mjs';
const { parseConditional, conditionalAt, createSpeedLimits } = await import('../server/osm/speed-limit.mjs');
const { SpeedMeter } = await import('../js/speed-meter.js');
const { speedLimitText } = await import('../js/vehicle.js');

const tpe = hm => Date.parse(`2026-11-25T${hm}:00+08:00`);   // 週三
console.log('① maxspeed:conditional 解析與時段判斷');
{ const a = parseConditional('50 @ (20:00 - 24:00, 00:00 - 06:00)'), b = parseConditional('30 @ (20:00-06:00)'), c = parseConditional('30 @ (08:00-12:00, 13:00-18:00)');
  ok('三種實際出現在台灣 OSM 的寫法都能解析', a.ok && b.ok && c.ok && a.rules[0].kmh === 50 && a.rules[0].spans.length === 2);
  ok('跨午夜（20:00-06:00）：23:30、05:59 成立，06:00、12:00 不成立', conditionalAt(b, tpe('23:30')) === 30 && conditionalAt(b, tpe('05:59')) === 30 && conditionalAt(b, tpe('06:00')) == null && conditionalAt(b, tpe('12:00')) == null);
  ok('兩段時間（08-12、13-18）：12:30 午休不成立', conditionalAt(c, tpe('09:00')) === 30 && conditionalAt(c, tpe('12:30')) == null && conditionalAt(c, tpe('17:59')) === 30);
  const d = parseConditional('40 @ (Mo-Fr 07:00-09:00)'); ok('有星期：週三 08:00 成立、週六不成立', conditionalAt(d, tpe('08:00')) === 40 && conditionalAt(d, Date.parse('2026-11-28T08:00:00+08:00')) == null);
  ok('解析不了的條件（wet、hgv 等）→ ok:false（照實標示，不套用）', !parseConditional('60 @ wet').ok && !parseConditional('80 @ (weight>3.5)').ok); }

// 道路圖替身：way 0 有標 maxspeed=60、way 1 只有 forward=30／backward=50、way 2 TW:urban（zone 50）、way 3 沒有任何標籤、way 4 有標＋時段＋可變＋依標誌登錄
const W = { id: [101, 102, 103, 104, 105], maxspeed: Float32Array.from([60, NaN, NaN, NaN, 70]), maxF: Float32Array.from([NaN, 30, NaN, NaN, NaN]), maxB: Float32Array.from([NaN, 50, NaN, NaN, NaN]), zoneMax: Uint8Array.from([0, 0, 50, 0, 0]) };
const E = { way: Int32Array.from([0, 1, 2, 3, 4]) }, router = { g: { W, E } };
const extra = { version: 't', ways: { 105: { cond: '50 @ (20:00-06:00)', variable: 'weather', sign: 1 } } };
console.log('② 來源與優先順序');
{ const S = createSpeedLimits({ router, extra, graphVersion: 'g1' }), A = (e, dir = 0, m = 'car', t = tpe('12:00')) => S.forArc(2 * e + dir, m, t);
  ok('OSM maxspeed → 可信度 medium', A(0).kmh === 60 && A(0).source === 'osm' && A(0).confidence === 'medium');
  ok('依行駛方向：順向 30、逆向 50（不套到對向）', A(1, 0).kmh === 30 && A(1, 1).kmh === 50);
  ok('TW:urban → 法定 50、可信度 low（不是現場標誌）', A(2).kmh === 50 && A(2).source === 'osm-zone' && A(2).confidence === 'low');
  ok('沒有任何標籤 → 速限未知（kmh null），不填道路類別的推估值', A(3).kmh === null && A(3).confidence === 'unknown' && speedLimitText(A(3)) === '速限未知');
  ok('依標誌登錄 → high；可變速限加註', A(4).kmh === 70 && A(4).confidence === 'high' && A(4).notes.some(n => /可變速限/.test(n)));
  ok('時段速限：晚上 22:00 → 50（時段）；中午 → 70 並註明另有時段速限', A(4, 0, 'car', tpe('22:00')).kmh === 50 && A(4, 0, 'car', tpe('22:00')).source === 'osm-cond' && A(4).notes.some(n => /另有時段速限/.test(n)));
  ok('步行：不適用', A(0, 0, 'walk').confidence === 'na' && A(0, 0, 'walk').kmh === null);
  const S2 = createSpeedLimits({ router, official: a => (a >> 1 === 0 ? { kmh: 100, auth: '高速公路局' } : null), officialVersion: 'x', graphVersion: 'g1' });
  ok('TDX 官方優先，與 OSM 不同時加註', S2.forArc(0, 'car').kmh === 100 && S2.forArc(0, 'car').source === 'tdx' && S2.forArc(0, 'car').confidence === 'high' && S2.forArc(0, 'car').notes.some(n => /OSM 標 60/.test(n)));
  ok('版本含道路圖、附加表、官方資料', /^g1\|x-\|tdxx$/.test(S2.version), S2.version);
  const R = S.forRoute({ arcs: [0, 2, 4], segArc: [0, 0, 1, -1, 2] }, 'car', tpe('12:00'));
  ok('路線：每段一個、相同的去重、補的小段（-1）沒有速限', R.seg.length === 5 && R.seg[0] === R.seg[1] && R.seg[3] === -1 && R.table.length === 3 && R.table[R.seg[4]].kmh === 50 && R.table[R.seg[4]].source === 'osm-zone'); }

console.log('③ SpeedMeter：GPS 速度');
{ const fx = (t, mps, o = {}) => ({ timestamp: t, speed: mps, speedSrc: 'device', rawAccuracy: 6, accuracy: 6, weak: false, ...o });
  let m = new SpeedMeter(), t = 1e6, s;
  for (let i = 0; i < 10; i++, t += 1000) s = m.update(fx(t, 50 / 3.6));
  ok('穩定 50 km/h（都卜勒、精度 6 m）→ 50、品質 good', s.kmh === 50 && s.quality === 'good', JSON.stringify(s));
  s = m.update(fx(t, 150 / 3.6)); t += 1000; ok('單筆突然 150 km/h（加速度不可能）→ 不採用，仍顯示約 50', s.kmh === 50 && m.stats.rejected === 1);
  for (let i = 0; i < 3; i++, t += 1000) s = m.update(fx(t, 100 / 3.6)); ok('連續 3 筆一致的大變化 → 接受（例如一開始就在高速公路上）', s.kmh > 60, String(s.kmh));
  m = new SpeedMeter(); t = 1e6; for (let i = 0; i < 6; i++, t += 1000) s = m.update({ timestamp: t, speed: 2.5, speedSrc: 'position', rawAccuracy: 25, accuracy: 25 });
  ok('停著、GPS 飄移（位移估速 9 km/h 但位移小於精度一半）→ 0 km/h、靜止', s.kmh === 0 && s.stationary && m.stats.drift > 0);
  ok('位移估速且精度 25 m → 品質 poor（不假裝準確）', s.quality === 'poor' && /精度不足/.test(s.qualityText));
  m = new SpeedMeter(); t = 1e6; for (let i = 0; i < 5; i++, t += 1000) s = m.update(fx(t, 30 / 3.6, { rawAccuracy: 40 }));
  ok('精度 40 m → poor', s.quality === 'poor');
  ok('超過 6 秒沒有定位 → GPS 訊號中斷、不顯示速度', m.state(t + 7000).quality === 'lost' && m.state(t + 7000).kmh === null);
  m = new SpeedMeter(); t = 1e6; for (let i = 0; i < 3; i++, t += 1000) m.update(fx(t, 2 / 3.6)); s = m.state(t);
  ok('低速 2 km/h（例如塞車）→ 視為靜止 0', s.kmh === 0); }

console.log('④ 與速限比較（只是提醒）');
{ const m = new SpeedMeter(); let t = 1e6; const fx = (mps, acc = 6) => ({ timestamp: t, speed: mps, speedSrc: 'device', rawAccuracy: acc, accuracy: acc });
  for (let i = 0; i < 6; i++, t += 1000) m.update(fx(52 / 3.6));
  ok('52 km/h、速限 50 → 不算超速（容許 max(3 km/h, 5%)）', m.compare(50, t) === 'ok');
  const res = []; for (let i = 0; i < 12; i++, t += 1000) { m.update(fx(65 / 3.6)); res.push(m.compare(50, t)); }
  ok('持續 65 km/h、速限 50 → 3 秒以上才標示超速', res.includes('over') && res.indexOf('over') >= 3, res.join(','));
  ok('速限未知 → unknown（不比較）', m.compare(null, t) === 'unknown');
  for (let i = 0; i < 5; i++, t += 1000) m.update(fx(65 / 3.6, 45)); ok('GPS 精度不足 → unknown（不拿不可靠的速度判斷超速）', m.compare(50, t) === 'unknown'); }
done();
