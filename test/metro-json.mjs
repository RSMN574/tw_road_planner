// 捷運真實資料：TDX S2STravelTime（站間時間）、ODFare（票價）→ data/metro.json → 網頁圖、轉乘方案分段、API
// 資料形狀照 TDX 實際回應（使用者提供的台中捷運樣本：RouteID G-1、Sequence、RunTime／StopTime；ODFare 的 TicketType／FareClass／Price）
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { ok, done } from './helpers.mjs';
import * as C from './metro-city.mjs';
const quiet = f => { const a = console.info, b = console.warn; console.info = console.warn = () => {}; try { return f(); } finally { console.info = a; console.warn = b; } };
const geo = await import('../js/geo.js'); await import('../js/main.js');
const { State } = await import('../js/state.js'), { buildGraph } = await import('../js/loader.js'), T = await import('../js/transit.js'), BP = await import('../js/bus-plan.js');
const { buildMetroJson } = await import('../server/transit/metro-json.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- TDX 形狀的原始資料（綠線 18 站）----
const G = C.greenLine(), order = T.metroToGraph(G).lines[0].uids.map(u => u.replace(/^TMRT-/, '')), nm = id => ({ Zh_tw: G.find(s => s.StationID === id).StationName.Zh_tw, En: 'x' });
const run = i => 70 + ((i * 37) % 90), stop = i => (i === 0 ? 0 : 20 + (i % 3) * 5);
const tt = (ids, seq0) => ids.slice(0, -1).map((a, i) => ({ Sequence: seq0 + i, FromStationID: a, FromStationName: nm(a), ToStationID: ids[i + 1], ToStationName: nm(ids[i + 1]), RunTime: run(i), StopTime: stop(i) }));
const s2s = [{ LineNo: '1', LineID: 'G', RouteID: 'G-1', TrainType: 0, TravelTimes: [...tt(order, 1), ...tt([...order].reverse(), order.length)] }];
const odFare = []; for (const a of order) for (const b of order) if (a !== b) { const d = Math.abs(order.indexOf(a) - order.indexOf(b)), p = 20 + 5 * Math.floor(d / 3);
  odFare.push({ OriginStationID: a, OriginStationName: nm(a), DestinationStationID: b, DestinationStationName: nm(b), TrainType: 0, Fares: [{ TicketType: 1, FareClass: 1, Price: p }, { TicketType: 1, FareClass: 4, Price: Math.round(p / 2) }, { TicketType: 3, FareClass: 1, Price: p }], TravelTime: d * 2, TravelDistance: d * 1.1, SrcUpdateTime: '2026-11-17T02:54:24+08:00', UpdateTime: '2026-11-18T01:53:20+08:00', VersionID: 2317 }); }
odFare.find(r => r.OriginStationID === 'G0' && r.DestinationStationID === 'G3').Fares = [{ TicketType: 1, FareClass: 1, Price: 20 }, { TicketType: 1, FareClass: 4, Price: 10 }, { TicketType: 1, FareClass: 5, Price: 10 }, { TicketType: 1, FareClass: 7, Price: 10 }, { TicketType: 3, FareClass: 1, Price: 20 }];   // 使用者提供的樣本
const stationOfLine = [{ LineNo: '1', LineID: 'G', Stations: order.map((id, i) => ({ Sequence: i + 1, StationID: id, StationName: nm(id) })) }];
const frequency = [{ LineID: 'G', RouteID: 'G-1', ServiceDay: { Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 1, Sunday: 1 }, Headways: [{ StartTime: '06:00', EndTime: '24:00', MinHeadwayMins: 8, MaxHeadwayMins: 10 }] }];
const raw = { station: G, stationOfLine, s2s, frequency, odFare };

console.log('① data/metro.json 內容（TDX 原始欄位）');
const json = buildMetroJson(raw, { operator: 'TMRT', fetchedAt: { s2s: Date.parse('2026-11-18T00:00:00Z') } });
ok('放進 Stations、StationOfLine、S2STravelTime、Frequency、ODFare', ['Stations', 'StationOfLine', 'S2STravelTime', 'Frequency', 'ODFare'].every(k => Array.isArray(json[k]) && json[k].length));
ok('台中捷運沒有 LineTransfer 不算缺；缺首末班、出入口照實列出', !json.meta.missing.includes('LineTransfer') && json.meta.missing.includes('FirstLastTimetable') && json.meta.missing.includes('StationExit'), json.meta.missing.join('、'));
ok('ODFare 精簡（去掉四國語言站名），票價欄位原樣保留', !('OriginStationName' in json.ODFare[0]) && json.ODFare.length === 18 * 17 && json.ODFare.every(r => r.Fares.length >= 3 && r.TravelTime != null), `${(JSON.stringify(json.ODFare).length / 1024).toFixed(0)} KB（原始 ${(JSON.stringify(odFare).length / 1024).toFixed(0)} KB）`);
let err = null; try { buildMetroJson({ s2s }); } catch (e) { err = e.message; } ok('沒有車站資料：明確報錯', /Station/.test(err || ''));

console.log('② 網頁的捷運圖用真實站間時間與票價');
const g = T.metroToGraph(json), adj = (a, b) => g.adjacency['TMRT-' + a].find(e => e.to === 'TMRT-' + b).travel_times[0].run_time;
ok('全部站間都有 TDX 時間 → 不再標示推估', g.meta.runSrc === 'TDX S2STravelTime' && g.meta.order === 'TDX StationOfLine');
const i3 = order.indexOf('G3'); ok('站間時間＝RunTime＋StopTime（同一筆資料，雙向各自）', adj(order[i3], order[i3 + 1]) === run(i3) + stop(i3) && adj(order[i3 + 1], order[i3]) === run(order.length - 2 - i3) + stop(order.length - 2 - i3), `${adj(order[i3], order[i3 + 1])} 秒`);
ok('票價表：G0→G3 全票單程 20、電子票證 20（樣本）', JSON.stringify(g.meta.fares['TMRT-G0>TMRT-G3']) === '[20,20]' && g.meta.fareSrc === 'TDX ODFare');
ok('只用成人票價（敬老、愛心等不混進來）', Object.values(g.meta.fares).every(([a, c]) => a >= 20 && c >= 20));
const g0 = T.metroToGraph(G); ok('沒有 ODFare 時不顯示票價（不推估）', g0.meta.fares === null);

console.log('③ 轉乘方案分段：捷運段附票價');
const city = C.makeMetroCity({ toTWD97: geo.lonLatToTWD97 });
quiet(() => { buildGraph(city.road); T.loadBus(city.bus); T.loadMetro(json); });
const W = p => geo.lonLatToWorld(p.lon, p.lat), S = id => C.st(G, id), [fx, fy] = W(C.near(S('G3'), 60, 40)), [tx, ty] = W(C.near(S('G16'), -50, 60));
const opts = BP.suggestBusMulti(fx, fy, tx, ty), withMetro = opts.find(o => BP.legsOf(o).some(l => l.type === 'METRO_RIDE')), ml = withMetro && BP.legsOf(withMetro).find(l => l.type === 'METRO_RIDE');
ok('METRO_RIDE 附 TDX 票價（全票）', !!ml && ml.fare && ml.fare.single > 0 && ml.fare.card > 0 && /ODFare/.test(ml.fare.src), ml ? `${State.bus.names[ml.from]}→${State.bus.names[ml.to]}：${ml.fare.single} 元` : '');
ok('來源標示：行駛時間來自 TDX S2STravelTime', /S2STravelTime/.test(ml.src), ml.src);
const bl = BP.legsOf(withMetro).find(l => l.type === 'BUS_RIDE'); ok('公車段沒有票價資料就不顯示', !bl || !bl.fare);

console.log('④ 產生工具（tools/metro-json.mjs）與 API');
const D = mkdtempSync(path.join(os.tmpdir(), 'bp-mj-')), raw_ = D + '/.c/transit/raw'; mkdirSync(raw_, { recursive: true }); mkdirSync(D + '/data/graph', { recursive: true }); mkdirSync(D + '/data/bus');
for (const [k, v] of Object.entries(raw)) if (k !== 's2s') writeFileSync(`${raw_}/metro.TMRT.${k}.json.gz`, gzipSync(JSON.stringify(v)));
writeFileSync(D + '/.c/transit/meta.json', JSON.stringify({ 'metro.TMRT.station': { fetchedAt: Date.parse('2026-11-18T00:00:00Z') } }));
writeFileSync(D + '/s2s-manual.json', JSON.stringify(s2s));                                    // 模擬 transit-sync 遇到 429：S2S 改用手動下載的檔案
const env = { ...process.env, DATA_DIR: D + '/data', CACHE_DIR: D + '/.c' }, tool = path.join(ROOT, 'tools/metro-json.mjs'), runT = (...a) => spawnSync(process.execPath, [tool, ...a], { env, encoding: 'utf8' });
const c1 = runT('--check'); ok('--check：只報告不寫檔；缺 S2S 時行駛時間標示推估', c1.status === 0 && /推估/.test(c1.stdout) && !existsSync(D + '/data/metro.json'), c1.stdout.split('\n')[1]);
writeFileSync(D + '/data/metro.json', JSON.stringify(G));
const c2 = runT('--s2s', D + '/s2s-manual.json'); const out = JSON.parse(readFileSync(D + '/data/metro.json', 'utf8'));
ok('--s2s 手動檔案：寫入 data/metro.json，舊檔備份成 .bak', c2.status === 0 && out.S2STravelTime.length === 1 && existsSync(D + '/data/metro.json.bak') && /TDX S2STravelTime/.test(c2.stdout), c2.stdout.split('\n').find(l => l.includes('行駛時間')));
const c3 = runT('--s2s', D + '/s2s-manual.json'); ok('內容沒變：不重寫', /沒有變動/.test(c3.stdout));
for (const k of ['nodes', 'edges', 'roads']) writeFileSync(`${D}/data/graph/${k}.json`, JSON.stringify(city.road[k])); writeFileSync(D + '/data/bus/graph.json', JSON.stringify(city.bus));
const { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
quiet(() => engine.loadData(readConfig({ DATA_DIR: D + '/data', CACHE_DIR: D + '/.c', LOG: '0' })));
const q = p => `${p.lat},${p.lon}`, r = engine.transit({ from: q(C.near(S('G3'), 60, 40)), to: q(C.near(S('G16'), -50, 60)) }), leg = r.options.flatMap(o => o.legs).find(l => l.type === 'METRO_RIDE');
ok('API：METRO_RIDE 附 fare（adultSingle、adultCard、來源）', leg && leg.fare && leg.fare.adultSingle > 0 && leg.fare.currency === 'TWD' && leg.fare.source === 'TDX Metro/ODFare', JSON.stringify(leg && leg.fare));
ok('API：health 的捷運資料來源顯示 TDX 站間時間', engine.dataInfo().transit.metroDataSource.runTime === 'TDX S2STravelTime', JSON.stringify(engine.dataInfo().transit.metroDataSource));
rmSync(D, { recursive: true, force: true });
done();
