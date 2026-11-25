// traffic-flow.mjs — 即時路況（v1.15）：WKT 解析與截斷、里程、壅塞級別分類（名稱、服務水準字母、機關表、表外級別依速度、速度 0）、
// 路段整理（代碼前綴、雲林道路分類、里程接續推出終點）、對應到路網（方向、截斷補齊）、路網加權、路線路況、同步（假的 TDX）、伺服器 API
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf';
const origLog = console.log; console.info = () => {}; console.warn = () => {};
let fails = 0; const ok = (n, c, x = '') => { origLog((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const F = await import('../server/traffic/flow.mjs'), FS = await import('../server/traffic/flow-sync.mjs');

origLog('① 解析');
ok('LINESTRING', JSON.stringify(F.parseLines('LINESTRING(121.1 25.1, 121.2 25.2)')) === '[[[121.1,25.1],[121.2,25.2]]]');
ok('MULTILINESTRING', F.parseLines('MULTILINESTRING((1 2,3 4),(5 6,7 8))').length === 2);
{ const long = 'LINESTRING(' + Array.from({ length: 40 }, (_, i) => `121.${String(10000 + i).slice(1)} 25.${String(10000 + i).slice(1)}`).join(','), cut = long.slice(0, 500);
  ok('500 字截斷：判斷出來、丟掉數字不完整的最後一點', F.isTruncated(cut) && !F.isTruncated(long + ')') && F.parseLines(cut)[0].every(p => p[1] >= 25.0 && p[1] < 25.01) && F.parseLines(cut)[0].length < 40); }
ok('里程 12K+345 → 12.345、0K+0 → 0', F.kmOf('12K+345') === 12.345 && F.kmOf('0K+0') === 0 && F.kmOf('') === null);
ok('陣列欄位：實際的 Sections／LiveTraffics，也接受 OAS 的 Items', F.listOf({ Sections: [1] }, 'Sections').length === 1 && F.listOf({ Items: [1, 2] }, 'X').length === 2 && F.listOf(null).length === 0);

origLog('② 壅塞級別分類');
ok('名稱：順暢／車多／壅塞／嚴重壅塞／封閉／資料不足', [F.classifyName('順暢'), F.classifyName('車多'), F.classifyName('壅塞'), F.classifyName('極度壅塞'), F.classifyName('道路封閉'), F.classifyName('資料不足')].join() === [1, 2, 3, 3, -1, 0].join());
ok('服務水準字母：A、B 順暢；C、D 車多；E、F 壅塞', ['A', 'B', 'C', 'D', 'E', 'F'].map(F.classifyName).join() === '1,1,2,2,3,3');
const tables = F.levelTables({
  Freeway: { CongestionLevels: [{ CongestionLevelID: 'A', MeasureIndex: 'Speed', Levels: [{ Level: 1, LevelName: '順暢', LowValue: 80 }, { Level: 2, LevelName: '車多', LowValue: 60, TopValue: 79 }, { Level: 5, LevelName: '壅塞', LowValue: 0, TopValue: 19 }, { Level: -1, LevelName: '道路封閉', LowValue: -1, TopValue: -1 }] }] },
  'City/Taipei': { CongestionLevels: [{ CongestionLevelID: 'RoadClass6_default', MeasureIndex: 'Speed', Levels: [{ Level: 0, LevelName: 'F', LowValue: 0, TopValue: 20 }, { Level: 1, LevelName: 'A', LowValue: 40 }, { Level: 2, LevelName: 'B', LowValue: 35, TopValue: 40 }, { Level: 3, LevelName: 'C', LowValue: 30, TopValue: 35 }, { Level: 4, LevelName: 'D', LowValue: 25, TopValue: 30 }, { Level: 5, LevelName: 'E', LowValue: 20, TopValue: 25 }] }] } });
const cl = (auth, id, lv, v, lim) => F.classifyLive({ CongestionLevelID: id, CongestionLevel: String(lv), TravelSpeed: v }, tables, auth, lim);
ok('照機關的表：國道 2＝車多、5＝壅塞', cl('Freeway', 'A', 2, 65) === 2 && cl('Freeway', 'A', 5, 10) === 3);
ok('封閉（-1）、資料異常（-99）', cl('Freeway', 'A', -1, -1) === -1 && cl('Freeway', 'A', -99, 50) === 0);
ok('速度為 0＝沒有資料（台北市級別 0 但速度 0）', cl('City/Taipei', 'RoadClass6_default', 0, 0) === 0);
ok('表外級別（台北市資料用到 6）→ 依速度落在表的區間（15 km/h → F → 壅塞）', cl('City/Taipei', 'RoadClass6_default', 6, 15) === 3);
ok('沒有表：依速度與速限推估', cl('City/X', 'Z', 3, 20, 60) === 3 && cl('City/X', 'Z', 3, 50, 60) === 1);

origLog('③ 路段整理');
{ const secs = F.buildSections({
    'City/YilanCounty': { sections: { Sections: [{ SectionID: 'ILA:Section:S1', SectionName: '縣191(甲)', RoadName: '縣191', RoadClass: 4 }] }, shapes: { SectionShapes: [{ SectionID: 'S1', Geometry: 'LINESTRING(121.1 24.7,121.2 24.8)' }] } },
    'City/YunlinCounty': { sections: { Sections: [{ SectionID: 'T1', SectionName: '公園路', RoadName: '公園路', RoadClass: 0 }, { SectionID: 'T2', SectionName: '國道1號', RoadName: '國道1號', RoadClass: 0 }] }, shapes: { SectionShapes: [] } },
    Freeway: { sections: { Sections: [{ SectionID: '1', RoadID: '000010', RoadDirection: 'S', SectionMile: { StartKM: '0K+000', EndKM: '1K+100' }, RoadClass: 0, SectionName: '國道1號(a)' }, { SectionID: '2', RoadID: '000010', RoadDirection: 'S', SectionMile: { StartKM: '1K+100', EndKM: '2K+000' }, RoadClass: 0, SectionName: '國道1號(b)' }] },
      shapes: { SectionShapes: [{ SectionID: '1', Geometry: 'LINESTRING(121.70 25.10,121.71 25.11)' }, { SectionID: '2', Geometry: 'LINESTRING(121.72 25.12,121.73 25.13)' }] } } });
  const g = k => secs.find(s => s.key === k);
  ok('代碼前綴（宜蘭 ILA:Section:）不同也對得到線形', g('City/YilanCounty:ILA:Section:S1').lines.length === 1);
  ok('雲林把一般道路標成國道 → 不採信；真的國道保留', g('City/YunlinCounty:T1').cls === null && g('City/YunlinCounty:T2').cls === 0);
  ok('沒有終點座標：用里程接續的下一段起點', JSON.stringify(g('Freeway:1').endPt) === '[121.72,25.12]' && g('Freeway:2').endPt === null); }

origLog('④ 對應到路網（測試路網 tw-mini）');
const DATA = mkdtempSync(path.join(tmpdir(), 'flow-')), OUT = DATA + '/osm/graph'; mkdirSync(OUT, { recursive: true });
{ const b = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', OUT, '--no-osmium'], { encoding: 'utf8' }); if (b.status) { origLog(b.stderr); process.exit(1); } }
const { readGraph } = await import('../server/osm/graph-file.mjs'), { OsmRouter } = await import('../server/osm/router.mjs'), { readFileSync } = await import('node:fs');
const cur = JSON.parse(readFileSync(OUT + '/current.json', 'utf8')), R = new OsmRouter(readGraph(path.join(OUT, cur.graph)));
const LA = 24.150, LO = 120.650, at = (i, j) => [+(LA + j * 0.001).toFixed(6), +(LO + i * 0.001).toFixed(6)];
const ref = R.route({ from: at(0, 1), to: at(4, 1), profile: 'car' }), refRev = R.route({ from: at(4, 1), to: at(0, 1), profile: 'car' });
ok('測試用的參考路線', !ref.error && !refRev.error && ref.coords.length >= 2, ref.error || `${ref.distanceM} m`);
const wkt = pts => 'LINESTRING(' + pts.map(p => p[0].toFixed(6) + ' ' + p[1].toFixed(6)).join(',') + ')';
const secsT = F.buildSections({ 'City/Taichung': { sections: { Sections: [
  { SectionID: 'E', SectionName: '東向', RoadClass: 6 }, { SectionID: 'W', SectionName: '西向', RoadClass: 6 }, { SectionID: 'T', SectionName: '截斷', RoadClass: 6, SectionEnd: { PositionLon: ref.coords[ref.coords.length - 1][0], PositionLat: ref.coords[ref.coords.length - 1][1] } }] },
  shapes: { SectionShapes: [{ SectionID: 'E', Geometry: wkt(ref.coords) }, { SectionID: 'W', Geometry: wkt(refRev.coords) },
    { SectionID: 'T', Geometry: wkt(ref.coords.slice(0, Math.max(2, Math.ceil(ref.coords.length / 3)))).slice(0, -1) + ',120.6' + '1'.repeat(500) }] } } });
ok('截斷的測試路段：標成截斷、有終點', secsT[2].trunc && !!secsT[2].endPt);
const M = F.matchSections(secsT.slice(0, 2), R), arcsE = new Set([...M.arcSec].filter(([, s]) => s === 0).map(([a]) => a)), arcsW = new Set([...M.arcSec].filter(([, s]) => s === 1).map(([a]) => a));
const refSet = new Set(ref.arcs), recall = [...refSet].filter(a => arcsE.has(a)).length / refSet.size;
ok('東向路段對到參考路線的有向邊（召回 ≥ 80%）', recall >= 0.8, `${(recall * 100).toFixed(0)}%`);
ok('方向正確：西向路段對到反方向的邊，兩邊不重疊', arcsW.size > 0 && [...arcsW].every(a => !arcsE.has(a)) && [...arcsW].some(a => refSet.has(a ^ 1)));
const MT = F.matchSections([secsT[2]], R), arcsT = new Set(MT.arcSec.keys()), recallT = [...refSet].filter(a => arcsT.has(a)).length / refSet.size;
ok('截斷的線形：從最後一個有效點規劃到終點補齊', (MT.stats.extended || 0) === 1 && recallT >= 0.8, `補齊 ${MT.stats.extended || 0}、召回 ${(recallT * 100).toFixed(0)}%`);

origLog('⑤ 路網加權、路線路況');
{ const now = Date.now(), states = new Map([['City/Taichung:E', { lv: 3, v: 8, at: now }], ['City/Taichung:W', { lv: 1, v: 45, at: now }]]);
  const P = R.profile('car'), o = F.flowOverlay(M, secsT.slice(0, 2), states, P, R);
  ok('壅塞路段加權（> 1，≤ 5）、順暢路段不加權', [...arcsE].some(a => o.overlay.has(a) && o.overlay.get(a).timeFactor > 1 && o.overlay.get(a).timeFactor <= 5) && [...arcsW].every(a => !o.overlay.has(a)));
  const old = new Map([['City/Taichung:E', { lv: 3, v: 8, at: now - 3600e3 }]]); ok('過期（超過 20 分鐘）的資料不用', F.flowOverlay(M, secsT.slice(0, 2), old, P, R).arcs === 0);
  const closed = F.flowOverlay(M, secsT.slice(0, 2), new Map([['City/Taichung:E', { lv: -1, v: null, at: now }]]), P, R); ok('封閉：加權 20 倍（不直接禁行）', [...closed.overlay.values()].every(x => x.factor === 20 && !x.block) && closed.arcs > 0);
  const m = F.mergeOverlays(new Map([[1, { block: true, factor: 2, timeFactor: 2 }]]), new Map([[1, { block: false, factor: 3, timeFactor: 3 }], [2, { block: false, factor: 1.5, timeFactor: 1.5 }]]));
  ok('與道路事件合併：封閉取或、係數取大', m.get(1).block && m.get(1).factor === 3 && m.get(2).factor === 1.5);
  const r = R.route({ from: at(0, 1), to: at(4, 1), profile: 'car' }), len = r.coords.slice(1).map((q, i) => Math.hypot((q[0] - r.coords[i][0]) * 101e3, (q[1] - r.coords[i][1]) * 111e3));
  const f = F.routeFlow(r.arcs, r.segArc, len, M, secsT.slice(0, 2), states);
  ok('路線路況：壅塞長度、分段（每一小段的狀態）', f.jamM > r.distanceM * 0.5 && f.knownM >= f.jamM && f.runs.length >= 1 && f.runs.every(x => x[2] === 3), JSON.stringify({ jam: f.jamM, known: f.knownM, d: r.distanceM })); }
ok('線條簡化（Douglas-Peucker）', F.simplify([[0, 0], [1, 0.001], [2, 0], [3, 5]], 0.1).length === 3);

origLog('⑥ 同步（假的 TDX）');
{ const calls = [], fake = async p => { calls.push(p); if (/Kaohsiung/.test(p)) return { status: 400 };
    if (/\/Section\//.test(p)) return { status: 200, data: { Sections: [{ SectionID: '1' }] } }; if (/SectionShape/.test(p)) return { status: 200, data: { SectionShapes: [{ SectionID: '1', Geometry: 'LINESTRING(1 2,3 4)' }] } };
    if (/CongestionLevel/.test(p)) return { status: 200, data: { CongestionLevels: [] } }; if (/Live/.test(p)) return { status: 200, data: { LiveTraffics: [{ SectionID: '1', TravelSpeed: 50, TravelTime: 30, CongestionLevel: '1', CongestionLevelID: 'A', DataCollectTime: '2026-11-24T10:00:00+08:00', LinkIDs: [{ LinkID: 'x' }] }] } }; return { status: 404 }; };
  const dir = mkdtempSync(path.join(tmpdir(), 'flow-sync-')), s = await FS.syncStatic(fake, dir, { authorities: ['Freeway', 'City/Kaohsiung'] }), l = await FS.syncLive(fake, dir, { authorities: ['Freeway', 'City/Kaohsiung'] });
  ok('靜態：每個機關 3 次呼叫（路段、線形、壅塞水準表），路徑正確', calls.filter(p => /^\/Road\/Traffic\/(Section|SectionShape|CongestionLevel)\/Freeway\?%24format=JSON$/.test(p)).length === 3);
  ok('失敗的機關記錄下來、其他照常', s.authorities === 1 && s.report.some(x => /✗ City\/Kaohsiung/.test(x)) && l.report.some(x => /✗ City\/Kaohsiung/.test(x)) && l.sections === 1);
  const L = FS.readGz(path.join(dir, FS.LIVE_FILE)); ok('即時檔只留需要的欄位（不存 LinkIDs）', L.byAuthority.Freeway.LiveTraffics[0].TravelSpeed === 50 && !('LinkIDs' in L.byAuthority.Freeway.LiveTraffics[0]));
  ok('靜態資料的新舊（7 天重抓）', FS.staticAgeMs(dir) < 60e3 && FS.staticAgeMs(dir + '/none') === Infinity); }

origLog('⑦ 伺服器 API（測試路網＋假的路況檔）');
{
  const CACHE = mkdtempSync(path.join(tmpdir(), 'flow-cache-')), TD = CACHE + '/traffic'; mkdirSync(TD, { recursive: true });
  const nowIso = new Date(Date.now() - 60e3).toISOString();
  writeFileSync(TD + '/' + FS.STATIC_FILE, gzipSync(JSON.stringify({ fetchedAt: Date.now(), byAuthority: { 'City/Taichung': { sections: { Sections: [{ SectionID: 'E', SectionName: '測試東向', RoadClass: 6, SpeedLimit: 50 }] }, shapes: { SectionShapes: [{ SectionID: 'E', Geometry: wkt(ref.coords) }] }, levels: { CongestionLevels: [] } } } })));
  const live = lv => gzipSync(JSON.stringify({ fetchedAt: Date.now(), byAuthority: { 'City/Taichung': { LiveTraffics: [{ SectionID: 'E', TravelSpeed: lv === 3 ? 6 : 45, TravelTime: 60, CongestionLevel: String(lv), CongestionLevelID: 'X', DataCollectTime: nowIso }] } } }));
  writeFileSync(TD + '/' + FS.LIVE_FILE, live(3));
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs');
  const cfg = readConfig({ DATA_DIR: DATA, STATIC_DIR: ROOT + '/dist', CACHE_DIR: CACHE, LOG: '0', RATE_LIMIT_PER_MIN: '5000', WORKERS: '0', OSM_WARM: '', TRAFFIC_POLL_MIN: '0' });
  const h = createApp(cfg), srv = http.createServer(h); await new Promise(r => srv.listen(0, '127.0.0.1', r)); await h.backend.osmLoad(cfg);
  const base = `http://127.0.0.1:${srv.address().port}`, J = async p => { const r = await fetch(base + p); return { status: r.status, j: await r.json() }; };
  { const r = await J('/api/v1/traffic/flow'); ok('狀態：路段數、對應的有向邊、各狀態數量', r.status === 200 && r.j.data.available && r.j.data.sectionsTotal === 1 && r.j.data.matchedArcs > 0 && r.j.data.counts['壅塞'] === 1, JSON.stringify(r.j.data.counts)); }
  ok('對應結果存成快取檔', existsSync(TD + '/flow-match.json'));
  { const r = await J(`/api/v1/traffic/flow?bbox=${LO - 0.01},${LA - 0.01},${LO + 0.02},${LA + 0.02}`); ok('地圖圖層：範圍內的路段、狀態、路網線形', r.status === 200 && r.j.data.sections.length === 1 && r.j.data.sections[0].lv === 3 && r.j.data.sections[0].g[0].length >= 2); }
  { const r = await J(`/api/v1/traffic/flow?bbox=0,0,1,1`); ok('範圍外：沒有路段', r.j.data.sections.length === 0); }
  { const r = await J('/api/v1/traffic/flow?bbox=abc'); ok('bbox 格式錯 → 400', r.status === 400); }
  const q = `from=${at(0, 1).join(',')}&to=${at(4, 1).join(',')}&mode=car&alternatives=0`;
  const a = (await J('/api/v1/osm/route?' + q)).j.data, b = (await J('/api/v1/osm/route?' + q + '&traffic=0')).j.data; if (process.env.DBG) origLog(JSON.stringify({ a: [a.routes[0].durationS, a.routes[0].flow, a.notes], b: [b.routes[0].durationS, b.notes] }).slice(0, 900));
  // 不用即時路況：走參考道路（路況摘要顯示壅塞）；用即時路況：繞開壅塞的路（測試路網是格子，有平行道路）
  ok('traffic=0：照原本的路線，路況摘要顯示經過壅塞（長度、分段）', b.routes[0].flow && b.routes[0].flow.jamM > 0 && b.routes[0].flow.runs.length >= 1 && !b.notes.some(n => /即時路況：/.test(n)), JSON.stringify(b.routes[0].flow && { jam: b.routes[0].flow.jamM }));
  ok('用即時路況：避開壅塞路段（或走同一條但時間變長），並說明', a.notes.some(n => /即時路況：/.test(n)) && ((a.routes[0].flow.jamM < b.routes[0].flow.jamM * 0.5) || a.routes[0].durationS > b.routes[0].durationS), `壅塞 ${b.routes[0].flow.jamM} → ${a.routes[0].flow.jamM} m`);
  { const w = (await J(`/api/v1/osm/route?from=${at(0, 1).join(',')}&to=${at(4, 1).join(',')}&mode=walk&alternatives=0`)).j.data; ok('步行不套用即時路況', !w.notes.some(n => /即時路況：/.test(n))); }
  { const f = (await J('/api/v1/osm/route?' + q + '&depart=' + (Date.now() + 3 * 3600e3))).j.data; ok('3 小時後出發：不用即時路況，並說明', !f.notes.some(n => /即時路況：/.test(n)) && f.notes.some(n => /30 分鐘內/.test(n))); }
  writeFileSync(TD + '/' + FS.LIVE_FILE, live(1)); await new Promise(r => setTimeout(r, 30));
  { const r = await J(`/api/v1/traffic/flow?bbox=${LO - 0.01},${LA - 0.01},${LO + 0.02},${LA + 0.02}&x=1`); ok('即時檔更新後自動重新讀取（壅塞 → 順暢）', r.j.data.sections[0] && r.j.data.sections[0].lv === 1); }
  await new Promise(r => srv.close(r));
}
origLog(fails ? `\n✗ ${fails} 項失敗` : '\n✓ 即時路況測試全部通過');
process.exit(fails ? 1 : 0);
