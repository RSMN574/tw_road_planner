// GPS 過濾與定位服務（權限、失訊、跳點、精度、節流、平滑、方向）
import { ok, done, rng, gauss } from './helpers.mjs';
const { GpsFilter, angDiff } = await import('../js/gps-filter.js'); const { GpsService } = await import('../js/gps.js');
const LAT0 = 24.12, LON0 = 120.67, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180);
const ll = (x, y) => ({ lat: LAT0 + y / mLat, lon: LON0 + x / mLon });
const raw = (x, y, t, o = {}) => ({ ...ll(x, y), accuracy: 8, speed: NaN, heading: NaN, altitude: null, timestamp: t, ...o });
const toXY = f => [(f.lon - LON0) * mLon, (f.lat - LAT0) * mLat];
console.log('① GpsFilter');
{ const R = rng(5), f = new GpsFilter(); let eR = 0, eF = 0, n = 0;
  for (let i = 0; i < 80; i++) { const nx = gauss(R) * 8, ny = gauss(R) * 8, r = f.process(raw(nx, ny, 1000 * (i + 1), { accuracy: 8 })); if (r.accepted && i >= 10) { const [x, y] = toXY(r.fix); eF += x * x + y * y; eR += nx * nx + ny * ny; n++; } }
  ok('靜止時：平滑後的誤差 RMS 明顯小於原始量測', Math.sqrt(eF / n) < Math.sqrt(eR / n) * 0.6, `原始 ${Math.sqrt(eR / n).toFixed(1)} m → 平滑 ${Math.sqrt(eF / n).toFixed(1)} m`); }
{ const R = rng(9), f = new GpsFilter(); let eR = 0, eF = 0, n = 0;
  for (let i = 0; i < 90; i++) { const tx = i * 15, nx = gauss(R) * 6, ny = gauss(R) * 6, r = f.process(raw(tx + nx, ny, 1000 * (i + 1), { speed: 15 })); if (r.accepted && i >= 5) { const [x, y] = toXY(r.fix); eF += (x - tx) ** 2 + y * y; eR += nx * nx + ny * ny; n++; } }
  ok('行駛中（15 m/s）：不落後於真實位置，誤差不比原始量測大', Math.sqrt(eF / n) <= Math.sqrt(eR / n) * 1.05, `原始 ${Math.sqrt(eR / n).toFixed(1)} m → 濾波 ${Math.sqrt(eF / n).toFixed(1)} m`); }
{ const f = new GpsFilter(); f.process(raw(0, 0, 1000)); f.process(raw(10, 0, 2000)); f.process(raw(20, 0, 3000));
  let r = f.process(raw(5000, 3000, 4000)); ok('單一跳點（5 km 外）被排除', !r.accepted && r.reason === 'jump');
  r = f.process(raw(30, 0, 5000)); ok('跳點後下一筆正常定位仍被接受', r.accepted && Math.abs(toXY(r.fix)[0] - 30) < 15); }
{ const f = new GpsFilter(); f.process(raw(0, 0, 1000)); f.process(raw(10, 0, 2000)); const res = []; for (let i = 0; i < 4; i++) res.push(f.process(raw(8000 + i * 10, 0, 3000 + i * 1000)));
  ok('連續多筆彼此一致的遠處定位 → 判定真的移動（重設濾波），不永遠卡住', res.slice(0, 2).every(r => !r.accepted) && res[2].accepted && res[2].reason === 'relocated', res.map(r => r.reason || 'ok').join(',')); }
{ const f = new GpsFilter(); let r = f.process(raw(0, 0, 1000, { accuracy: 200 })); ok('精度 200 m → 丟棄（poor-accuracy）', !r.accepted && r.reason === 'poor-accuracy');
  r = f.process(raw(0, 0, 2000, { accuracy: NaN })); ok('沒有精度資訊 → 丟棄', !r.accepted);
  r = f.process(raw(0, 0, 3000, { accuracy: 80 })); ok('精度 80 m → 接受但標記 weak（導航不拿它判斷偏航）', r.accepted && r.fix.weak === true);
  r = f.process(raw(0, 0, 3200, { accuracy: 8 })); ok('間隔 < 0.8 秒 → 節流', !r.accepted && r.reason === 'throttled');
  r = f.process(raw(0, 0, 3000, { accuracy: 8 })); ok('時間沒前進 → stale', !r.accepted && r.reason === 'stale');
  ok('座標 (0,0)／NaN → invalid', f.process({ lat: 0, lon: 0, accuracy: 5, timestamp: 9e3 }).reason === 'invalid' && f.process({ lat: NaN, lon: 1, accuracy: 5 }).reason === 'invalid'); }
{ const f = new GpsFilter(); let last; for (let i = 0; i < 10; i++) last = f.process(raw(i * 12, 0, 1000 * (i + 1)));
  ok('沒有裝置 heading：用位移估算方向（向東 ≈ 90°）', last.fix.heading != null && angDiff(last.fix.heading, 90) < 10, 'heading=' + (last.fix.heading ?? 'null').toString().slice(0, 5));
  const g = new GpsFilter(); g.process(raw(0, 0, 1000)); const s = g.process(raw(0.5, 0.5, 2000)); ok('原地不動：不亂報方向', s.fix.heading == null);
  const h = new GpsFilter(); h.process(raw(0, 0, 1000, { speed: 10, heading: 180 })); const r2 = h.process(raw(0, -10, 2000, { speed: 10, heading: 180 })); ok('有裝置 heading 且有速度：採用（向南 180°）', angDiff(r2.fix.heading, 180) < 5); }

console.log('② GpsService');
function fakeGeo() { const g = { cb: null, err: null, cleared: false, started: 0, watchPosition(ok_, er) { g.started++; g.cb = ok_; g.err = er; return 7; }, clearWatch() { g.cleared = true; } }; return g; }
const pos = (x, y, t, acc = 8) => ({ coords: { ...{ latitude: ll(x, y).lat, longitude: ll(x, y).lon, accuracy: acc, altitude: null, speed: null, heading: null } }, timestamp: t });
{ const g = fakeGeo(), s = new GpsService({ geolocation: g, secure: false }), st = []; s.on('status', x => st.push(x.status)); ok('非 HTTPS：不啟動、狀態 insecure', s.start() === false && g.started === 0 && s.status === 'insecure'); }
{ const s = new GpsService({ geolocation: null, secure: true }); ok('瀏覽器不支援：unsupported', s.start() === false && s.status === 'unsupported'); }
{ const g = fakeGeo(), s = new GpsService({ geolocation: g }), st = []; s.on('status', x => st.push(x.status)); s.start(); g.err({ code: 1, message: 'denied' });
  ok('權限被拒：狀態 denied、停止監聽、不重試', s.status === 'denied' && g.cleared && st.includes('pending')); }
{ let timers = []; const g = fakeGeo(), s = new GpsService({ geolocation: g, setTimeout: (f, ms) => { const t = { f, ms }; timers.push(t); return t; }, clearTimeout: t => { timers = timers.filter(x => x !== t); } }), fixes = [], st = [];
  s.on('fix', f => fixes.push(f)); s.on('status', x => st.push(x.status)); s.start();
  g.cb(pos(0, 0, 1000)); g.cb(pos(10, 0, 2000)); g.cb(pos(10.2, 0, 2100)); ok('收到定位 → active，節流的不重複發出', s.status === 'active' && fixes.length === 2);
  g.err({ code: 2, message: 'no signal' }); ok('錯誤碼 2（暫時無法定位）：unavailable，但持續監聽', s.status === 'unavailable' && !g.cleared);
  timers[timers.length - 1].f(); ok('超過失訊時間沒有新定位 → lost', s.status === 'lost');
  g.cb(pos(20, 0, 20000)); ok('訊號回來 → 回到 active', s.status === 'active');
  g.cb(pos(30, 0, 21000, 90)); ok('精度 90 m → weak（仍會發出 fix 但帶 weak 旗標）', s.status === 'weak' && fixes[fixes.length - 1].weak);
  const rej = []; s.on('reject', r => rej.push(r)); g.cb(pos(9000, 0, 22000)); ok('跳點 → reject 事件，不會發出 fix', rej.includes('jump') && fixes.length === 4);
  s.stop(); ok('stop：clearWatch 並回到 idle', g.cleared && s.status === 'idle'); }
done();
