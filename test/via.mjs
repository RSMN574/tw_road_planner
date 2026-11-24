// via.mjs — 途經點（v1.14）：分段路線合併（mergeLegs）、路線 API 的 via 參數（測試路網 tw-mini）、網頁的規劃／導航（途經點步驟、通過途經點、偏航重新規劃只帶剩下的途經點）、語音
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf';
const realFetch = globalThis.fetch.bind(globalThis), { el, ok, done } = await import('./helpers.mjs');   // helpers 會把 fetch 換成離線替身：先留住真的
const quiet = console.info; console.info = () => {}; console.warn = () => {};

console.log('① mergeLegs：把分段路線接成一條');
const { mergeLegs } = await import('../server/osm-engine.mjs');
const leg = (x0, n, name, extra = {}) => {      // n 段直線，每段 100 m、10 秒
  const coords = Array.from({ length: n + 1 }, (_, i) => [x0 + i * 0.001, 24]);
  return { distanceM: n * 100, durationS: n * 10, driveS: n * 10, delayS: 0, arcs: [x0], coords, roads: [name], ways: [{ id: x0, name, m: n * 100 }],
    steps: [{ index: 0, type: 'start', road: name, fromStartM: 0, distanceFromPrev: 0 }, { index: n, type: 'arrive', road: name, fromStartM: n * 100, distanceFromPrev: n * 100 }],
    timing: { segS: Array(n).fill(10), segCls: Array(n).fill(1), segKnown: Array(n).fill(1), segWay: Array(n).fill(0), delays: [[1, 2]] },
    ferries: [], signals: 2, warnings: { unknownM: 5 }, events: [{ id: 'e1', m: 10, extraS: 3 }], snap: { from: [24, x0], to: [24, x0 + n * 0.001], fromM: 1, toM: 2 }, ...extra };
};
{
  const m = mergeLegs([leg(121, 3, 'A路'), leg(121.003, 2, 'B路'), leg(121.010, 1, 'C路')]);   // 第 2→3 段的起點和前一段終點不同（吸附到不同位置）
  ok('距離、時間、號誌、警告、事件加總', m.distanceM === 600 && m.durationS === 60 && m.signals === 6 && m.warnings.unknownM === 15 && m.events.length === 1 && m.events[0].m === 30 && m.events[0].extraS === 9);
  ok('座標：相同的接點只留一個，不同的保留', m.coords.length === 4 + 2 + 2, `${m.coords.length}`);
  ok('分段時間的數量＝座標數−1（接點不同時補一段 0 秒）', m.timing.segS.length === m.coords.length - 1 && m.timing.segS.filter(x => x === 0).length === 1);
  ok('分段的 way 序號依序位移', m.timing.segWay.slice(0, 3).every(x => x === 0) && m.timing.segWay[3] === 1 && m.timing.segWay[m.timing.segWay.length - 1] === 2 && m.ways.length === 3);
  const T = m.steps.map(s => s.type); ok('步驟：只有一個出發、一個抵達，中間的抵達變成途經點（編號 1、2）', T.join(',') === 'start,waypoint,waypoint,arrive' && m.steps[1].waypoint === 1 && m.steps[2].waypoint === 2, T.join(','));
  ok('途經點步驟的位置＝那一段的終點，距離累加', m.steps[1].index === 3 && m.steps[1].fromStartM === 300 && m.steps[2].index === 5 && m.steps[2].fromStartM === 500 && m.steps[3].index === m.coords.length - 1 && m.steps[3].fromStartM === 600);
  ok('legs：每段距離、時間、終點位置', JSON.stringify(m.legs.map(l => [l.distanceM, l.durationS, l.endIndex])) === JSON.stringify([[300, 30, 3], [200, 20, 5], [100, 10, 7]]));
  ok('延遲的座標序號位移', JSON.stringify(m.timing.delays) === JSON.stringify([[1, 2], [4, 2], [7, 2]]), JSON.stringify(m.timing.delays));
  ok('吸附資訊：起點、終點、途經點', m.snap.from[1] === 121 && Math.abs(m.snap.to[1] - 121.011) < 1e-9 && m.snap.via.length === 2);
  ok('道路名稱依序（相鄰相同的合併）', m.roads.join('→') === 'A路→B路→C路');
}

console.log('② 路線 API：via 參數（測試路網）');
const DATA = mkdtempSync(path.join(tmpdir(), 'via-srv-')), OUT = DATA + '/osm/graph'; mkdirSync(OUT, { recursive: true });
const b = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', OUT, '--no-osmium'], { encoding: 'utf8' });
if (b.status) { console.log(b.stderr); process.exit(1); }
const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs');
const cfg = readConfig({ DATA_DIR: DATA, STATIC_DIR: ROOT + '/dist', CACHE_DIR: mkdtempSync(path.join(tmpdir(), 'via-cache-')), LOG: '0', RATE_LIMIT_PER_MIN: '5000', WORKERS: '0', OSM_WARM: '' });
const h = createApp(cfg), srv = http.createServer(h); await new Promise(r => srv.listen(0, '127.0.0.1', r)); await h.backend.osmLoad(cfg);
const base = `http://127.0.0.1:${srv.address().port}`;
const J = async (p, o) => { const r = await realFetch(base + p, o); return { status: r.status, j: await r.json() }; };
const LA = 24.150, LO = 120.650, at = (i, j) => [+(LA + j * 0.001).toFixed(6), +(LO + i * 0.001).toFixed(6)], ll = p => p.join(',');
const A = at(0, 0), Z = at(4, 4), V1 = at(4, 0), V2 = at(0, 4);
let direct, withVia;
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&alternatives=0`); direct = r.j.data.routes[0]; ok('沒有途經點：照舊（沒有 legs、沒有途經點步驟）', r.status === 200 && !direct.legs && !direct.steps.some(s => s.type === 'waypoint')); }
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&alternatives=0&via=${ll(V1)};${ll(V2)}`); withVia = r.j.data && r.j.data.routes[0];
  ok('兩個途經點：200、兩段以上 legs、兩個途經點步驟', r.status === 200 && withVia.legs.length === 3 && withVia.steps.filter(s => s.type === 'waypoint').length === 2, r.status !== 200 ? JSON.stringify(r.j.error) : '');
  ok('總距離＝各段加總，比直達長', withVia.distanceM === withVia.legs.reduce((a, l) => a + l.distanceM, 0) && withVia.distanceM > direct.distanceM, `${direct.distanceM} → ${withVia.distanceM} m`);
  const w = withVia.steps.filter(s => s.type === 'waypoint'); ok('途經點步驟落在每段終點', w[0].index === withVia.legs[0].endIndex && w[1].index === withVia.legs[1].endIndex);
  const near = (g, p) => Math.hypot(g[1] - p[0], g[0] - p[1]) * 111e3 < 60; ok('途經點步驟的位置在途經點旁（60 m 內）', near(withVia.geometry[w[0].index], V1) && near(withVia.geometry[w[1].index], V2));
  ok('分段時間與座標對得上', withVia.timing.segS.length === withVia.geometry.length - 1 && Math.max(...withVia.timing.segWay) < withVia.ways.length);
  ok('回應帶 via 與說明', JSON.stringify(r.j.data.via) === JSON.stringify([V1, V2]) && r.j.data.notes.some(n => /途經 2 個地點/.test(n))); }
{ const r = await J('/api/v1/osm/route', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: ll(A), to: ll(Z), mode: 'car', alternatives: 0, via: [ll(V1), ll(V2)] }) });
  ok('POST：via 用陣列也可以，結果相同', r.status === 200 && r.j.data.routes[0].distanceM === withVia.distanceM); }
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&via=${Array(6).fill(ll(V1)).join(';')}`); ok('超過 5 個 → 400 TOO_MANY_VIA', r.status === 400 && r.j.error.code === 'TOO_MANY_VIA'); }
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&via=abc`); ok('格式錯 → 400 BAD_COORD（指出第幾個）', r.status === 400 && r.j.error.code === 'BAD_COORD' && /via\[0\]/.test(r.j.error.message)); }
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&via=23.0,119.0`); ok('途經點附近沒有路 → 錯誤訊息指出是哪一段', r.status >= 400 && /第 1 段|第 2 段/.test(r.j.error.message), r.j.error && r.j.error.message); }
{ const r = await J(`/api/v1/osm/route?from=${ll(A)}&to=${ll(Z)}&mode=car&alternatives=all&via=${ll(V1)}`); const ks = r.j.data.routes.map(x => x.key);
  ok('alternatives=all：每條回傳的路線都分段規劃（測試路網上最短＝最快，只回一條）', r.status === 200 && ks.includes('fastest') && r.j.data.routes.every(x => x.legs && x.legs.length === 2), ks.join(',')); }

console.log('③ 網頁：規劃、導航、偏航重新規劃');
await import('../js/main.js');
const { State: S, Hooks } = await import('../js/state.js'), { osmPlan, osmPoint, osmReroute } = await import('../js/osm.js');
const { addVia, removeVia, moveVia, viaParam, viaRemaining } = await import('../js/via.js'), { NavigationEngine } = await import('../js/navigation.js'), { VoiceTemplates } = await import('../js/voice.js');
el('mode').value = 'car';
const seen = []; globalThis.fetch = (u, o) => { seen.push(String(u)); return realFetch(base + '/' + String(u).replace(/^\//, ''), o); };
S.fromPoint = osmPoint(A[1], A[0], '起點'); S.toPoint = osmPoint(Z[1], Z[0], '終點'); S.via = [];
ok('Hooks.viaParam 已登記', typeof Hooks.viaParam === 'function' && typeof Hooks.addVia === 'function');
S.fromPoint = null;                                       // 沒有起點時加途經點：不會觸發規劃
addVia(osmPoint(V2[1], V2[0], '第二站（最近道路：x）')); addVia(osmPoint(V1[1], V1[0], '第一站'));
ok('新增途經點：名稱去掉括號說明', S.via.length === 2 && S.via[0].name === '第二站');
moveVia(1, -1); ok('上下移動', S.via[0].name === '第一站' && S.via[1].name === '第二站');
ok('viaParam：緯度,經度;緯度,經度', viaParam() === `${V1[0].toFixed(6)},${V1[1].toFixed(6)};${V2[0].toFixed(6)},${V2[1].toFixed(6)}`);
for (let k = 0; k < 4; k++) addVia(osmPoint(V1[1], V1[0], '多' + k));
ok('最多 5 個', S.via.length === 5); while (S.via.length > 2) removeVia(S.via.length - 1); ok('刪除', S.via.length === 2);
S.fromPoint = osmPoint(A[1], A[0], '起點');
const res = await osmPlan(S.fromPoint, S.toPoint), it = res.items[0], man = it.route._man;
ok('規劃時帶上 via', seen.some(u => /route\?.*via=/.test(u)));
const wps = man.filter(m => m.turnType === 'waypoint');
ok('路線步驟有兩個途經點，路名欄是途經點名稱', wps.length === 2 && wps[0].roadName === '第一站' && wps[1].roadName === '第二站' && wps[0].wp === 1 && wps[1].wp === 2, JSON.stringify(wps.map(w => [w.wp, w.roadName])));
ok('規劃時重設「已經過」計數', S.viaDone === 0 && viaRemaining() === 2);
// 導航：沿路線幾何每 8 m 一筆定位
{ const eng = new NavigationEngine(), route = it.route, g = route._ll, passed = [], ev = []; let t = 1e6;
  eng.on((type, s) => { ev.push(type); if (type === 'step-passed') passed.push(s.passed); });
  eng.start(route, man, () => 10);
  const pts = []; for (let i = 0; i < g.length - 1; i++) { const [a, c] = [g[i], g[i + 1]], L = Math.hypot((c[0] - a[0]) * 101e3, (c[1] - a[1]) * 111e3), n = Math.max(1, Math.ceil(L / 8)); for (let k = 0; k < n; k++) pts.push([a[0] + (c[0] - a[0]) * k / n, a[1] + (c[1] - a[1]) * k / n, Math.atan2((c[0] - a[0]) * 101e3, (c[1] - a[1]) * 111e3) * 180 / Math.PI]); }
  pts.push([...g[g.length - 1], 0]); for (let k = 0; k < 4; k++) pts.push([...g[g.length - 1], 0]);
  for (const [lo, la, hd] of pts) { t += 1000; eng.update({ lat: la, lon: lo, accuracy: 4, timestamp: t, speed: 8, heading: (hd + 360) % 360 }); }
  const pw = passed.filter(p => p.turnType === 'waypoint');
  ok('導航：依序通過兩個途經點（step-passed）', pw.length === 2 && pw[0].wp === 1 && pw[1].wp === 2, JSON.stringify(passed.map(p => p.turnType)));
  ok('導航：通過途經點不算抵達；最後只抵達一次', ev.filter(e => e === 'arrived').length === 1 && ev.lastIndexOf('arrived') > ev.lastIndexOf('step-passed'), ev.filter(e => e !== 'update').join(','));
}
// 偏航重新規劃：已經過 1 個 → 只帶第 2 個
{ S.viaDone = 1; seen.length = 0;
  const r = await osmReroute({ lat: V1[0], lon: V1[1] + 0.0003, heading: null, speed: 0 }, 'fastest'), u = seen.find(x => /route\?/.test(x)) || '';
  const q = new URLSearchParams(u.split('?')[1]); ok('重新規劃只帶還沒到的途經點', q.get('via') === `${V2[0].toFixed(6)},${V2[1].toFixed(6)}`, q.get('via'));
  const w = r.route && r.route._man.filter(m => m.turnType === 'waypoint'); ok('重新規劃後的途經點編號與名稱接續原本的（第 2 站）', w && w.length === 1 && w[0].wp === 2 && w[0].roadName === '第二站', JSON.stringify(w && w.map(x => [x.wp, x.roadName]))); }
{ S.viaDone = 2; seen.length = 0; await osmReroute({ lat: Z[0], lon: Z[1] - 0.001, heading: null, speed: 0 }, 'fastest'); const u = seen.find(x => /route\?/.test(x)) || ''; ok('全部經過後：不帶 via', !/via=/.test(u)); }
el('mode').value = 'transit'; S.viaDone = 0;
console.log('④ 語音與文字');
ok('語音：前方即將抵達途經點（含名稱）', VoiceTemplates.ahead({ turnType: 'waypoint', roadName: '第一站', wp: 1 }, 300) === '前方300公尺，即將抵達途經點，第一站');
ok('語音：動作文字', VoiceTemplates.action({ turnType: 'waypoint', wp: 2 }) === '抵達途經點 2');
{ const { stepText } = await import('../js/ui-panels.js'); ok('逐步指示文字', /途經點 1：第一站/.test(stepText({ turnType: 'waypoint', wp: 1, roadName: '第一站', distanceFromPrev: 120 }))); }
{ const { turnIcon } = await import('../js/ui-icons.js'); ok('導航轉向圖示', turnIcon({ turnType: 'waypoint' }) === 't_waypoint'); }

await new Promise(r => srv.close(r)); console.info = quiet;
done();
