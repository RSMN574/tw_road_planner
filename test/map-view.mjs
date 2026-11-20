// map-view.mjs — v1.11 地圖視角：縮放層級換算與上下限、3D 傾斜的指標座標反投影、慣性速度、按鈕縮放（單元測試，DOM 替身）
import { ok, done } from './helpers.mjs';
const { State } = await import('../js/state.js');
const { fitBase, resetView, worldToScreen, clientToWorld } = await import('../js/render-core.js');
const MV = await import('../js/map-view.js');
State.coordType = 'wgs84'; fitBase(119.25, 122.1, 21.85, 25.35, 20); resetView();               // 全台灣放進 800×600
const z0 = MV.currentZoom();
ok('全台畫面約 z6～z8（舊版上限 ×20 只到約 z12）', z0 > 5.5 && z0 < 8.5, `z${z0.toFixed(2)}；×20 → z${(z0 + Math.log2(20)).toFixed(1)}`);
ok('上限 z21、下限 z5：clampScale', Math.abs(MV.zoomOfMpp(MV.metersPerPixel(MV.clampScale(1e9))) - MV.ZOOM.max) < 0.05 && Math.abs(MV.zoomOfMpp(MV.metersPerPixel(MV.clampScale(1e-9))) - MV.ZOOM.min) < 0.05);
State.view.scale = MV.scaleForZoom(19); ok('scaleForZoom(19) → currentZoom ≈ 19、約 0.27 m／像素', Math.abs(MV.currentZoom() - 19) < 0.05 && Math.abs(MV.metersPerPixel() - 0.27) < 0.03, `${MV.metersPerPixel().toFixed(3)} m/px`);
MV.zoomInstant(1000, 400, 300); ok('按鈕／鍵盤縮放不會超過上限', MV.currentZoom() <= MV.ZOOM.max + 0.01);
// 3D：反投影
State.pitchCss = { deg: 45, s: MV.pitchScale(45, 300), oy: 300 };
let maxErr = 0; for (const [x, y] of [[400, 300], [100, 50], [700, 580], [20, 200]]) { const [sx, sy] = MV.fromFlat(x, y), [fx, fy] = MV.toFlat(sx, sy); maxErr = Math.max(maxErr, Math.hypot(fx - x, fy - y)); }
ok('3D 45°：平面 → 螢幕 → 平面 來回誤差 < 0.001 像素', maxErr < 1e-3, maxErr.toExponential(1));
{ const q = MV.visibleFlatQuad(0), [sx, sy] = MV.fromFlat(q[0][0], q[0][1]); ok('3D：可見地面範圍的左上角投影回螢幕左上角（圖磚範圍依此計算）', Math.hypot(sx, sy) < 1e-6, `${sx.toFixed(3)}, ${sy.toFixed(3)}`); }
State.pitchCss = null; ok('2D：反投影就是原座標', JSON.stringify(MV.toFlat(123, 45)) === '[123,45]');
const tr = new MV.PanTracker(); tr.add(0, 0, 0); tr.add(50, 0, 50); tr.add(100, 0, 100); const [vx] = tr.velocity();
ok('慣性：最後 100 ms 的速度（每毫秒 1 像素）', Math.abs(vx - 1) < 1e-9);
const [wx, wy] = clientToWorld(400, 300); ok('clientToWorld／worldToScreen 一致', Math.hypot(...worldToScreen(wx, wy).map((v, i) => v - [400, 300][i])) < 1e-6);
done();
