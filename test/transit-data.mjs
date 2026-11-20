// transit-data.mjs — 階段 1：大眾運輸資料層（時間工具、公車／捷運正規化、班次表、ETA、同步快取）
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ok, done } from './helpers.mjs';
import * as T from '../server/transit/time.mjs';
import { buildBus } from '../server/transit/bus-provider.mjs';
import { buildMetro } from '../server/transit/metro-provider.mjs';
import { createStore } from '../server/transit/timetable-store.mjs';
import { createEtaStore } from '../server/transit/eta-store.mjs';
import { createTdxFetcher, createTransitData, datasetList } from '../server/transit/snapshot.mjs';
import { DATE_WEEKDAY as D1, DATE_WEEKEND as D2, busFixture, dailyStopFixture, eta, metroFixture } from './transit-fixture.mjs';

console.log('— 時間（Asia/Taipei）');
ok('HH:MM 與 ≥24 小時', T.parseHms('07:30') === 27000 && T.parseHms('25:10') === 90600 && Number.isNaN(T.parseHms('7點')) && Number.isNaN(T.parseHms('07:75')));
ok('純日期不會被當成 UTC（不差 8 小時）', T.parseDateOnly('2026-11-17') === '2026-11-17' && T.parseDateOnly('2026-11-17T00:00:00+08:00') === '2026-11-17' && T.parseDateOnly('2026-11-16T23:30:00') === '2026-11-16');
ok('UTC 時間換成台北日期', T.dateStrOf(Date.parse('2026-11-16T16:30:00Z')) === '2026-11-17' && T.weekdayOf(D1) === 2 && T.weekdayOf(D2) === 6);
ok('午夜與加減日', T.midnightMs(D1) === Date.parse('2026-11-16T16:00:00Z') && T.addDays('2026-12-31', 1) === '2027-01-01' && T.addDays(D1, -1) === '2026-11-16');
const sd = T.serviceDatesAt(Date.parse('2026-11-17T00:20:00+08:00'));
ok('凌晨同時屬於前一營運日（24:20）與今天', sd.length === 2 && sd[0].date === '2026-11-16' && sd[0].sec === 87600 && sd[1].sec === 1200 && T.serviceDatesAt(Date.parse('2026-11-17T12:00:00+08:00')).length === 1);
ok('ServiceDay 遮罩；沒有資料＝不知道', T.runsOn(T.dayMask({ Monday: 1, Tuesday: 1 }), D1) === true && T.runsOn(T.dayMask({ Monday: 1, Saturday: 0 }), D2) === false && T.runsOn(T.dayMask(null), D1) === null);

console.log('— 公車：站序、方向、子路線');
const raw = busFixture(), bus = buildBus(raw), P = id => bus.patterns.find(p => p.id === id);
ok('路線型態以 SubRouteUID＋Direction 為鍵', bus.patterns.length === 9 && !!P('TXG10|0') && !!P('TXG10|1'));
ok('去回程各自獨立、站序相反、站牌不同', P('TXG10|0').stops.join() === 'TXG1000,TXG1010,TXG1020,TXG1030' && P('TXG10|1').stops.join() === 'TXG1031,TXG1021,TXG1011,TXG1001');
ok('顯示名稱相同的兩條路線不會混在一起', P('TXG50|0').name === '同名' && P('TXG60|0').name === '同名' && P('TXG50|0').trips.length === 1 && P('TXG60|0').trips.length === 1 && P('TXG50|0').stops[0] !== P('TXG60|0').stops[0]);
const shuffled = buildBus({ stopOfRoute: [{ ...raw.stopOfRoute[0], Stops: [...raw.stopOfRoute[0].Stops].reverse() }] });
ok('站序只看 StopSequence（輸入順序打亂也一樣）', shuffled.patterns[0].stops.join() === P('TXG10|0').stops.join());
ok('回程的班次不會掛到去程', P('TXG10|0').trips.every(t => String(t.id).startsWith('1-0')) && P('TXG10|1').trips.every(t => String(t.id).startsWith('1-1')));

console.log('— 公車：班次時刻');
const night = P('TXG10|0').trips.find(t => t.id === '1-0-night');
ok('跨午夜的班次接續為 24:00 之後', night.dep.join() === [85800, 86100, 86400, 86700].join());
ok('時間倒退的班次被排除並記錄', !P('TXG10|0').trips.some(t => t.id === '1-0-bad') && bus.warnings.some(w => w.includes('倒退')));
ok('對不到路線的時刻資料被記錄，不會亂掛', bus.warnings.some(w => w.includes('找不到對應的路線型態')));
const r2 = P('TXG20|0').trips[0];
ok('只給起站時間＋有站間行駛時間 → 推算並標示 est', r2.est === true && r2.arr.join() === [25200, 25600, 26100, 26300].join() && P('TXG20|0').runSource === 'TDX Bus/S2STravelTime');
const r8 = P('TXG80|0').trips[0];
ok('只給起站時間、沒有行駛時間 → 不推算（保持空白）', r8.partial === true && r8.est === false && Number.isNaN(r8.arr[1]) && r8.dep[0] === 32400);
ok('完整時刻的班次不標示 est', P('TXG10|0').trips.every(t => !t.est) && P('TXG10|0').runSource === '時刻表中位數');
ok('只有班距的路線：保留班距、沒有假班次', P('TXG30|0').trips.length === 0 && P('TXG30|0').freqs.length === 2 && P('TXG30|0').freqs[0].minS === 600 && P('TXG30|0').freqs[0].maxS === 900);
ok('完全沒有班次資料 → 標示資訊不足（不是停駛）', P('TXG70|0').trips.length === 0 && bus.stats.noService === 1 && bus.warnings.some(w => w.includes('不代表停駛')));
const bus2 = buildBus({ stopOfRoute: raw.stopOfRoute, dailyStop: dailyStopFixture() });
ok('DailyStopTimeTable（沒有 Direction）依站序掛到正確方向', bus2.patterns.find(p => p.id === 'TXG10|1').trips.length === 2 && bus2.patterns.find(p => p.id === 'TXG10|0').trips.length === 0 && bus2.patterns.find(p => p.id === 'TXG10|1').trips[0].date === D2);

console.log('— 捷運');
const mraw = metroFixture(), metro = buildMetro(mraw, { operator: 'TMRT' }), M = id => metro.patterns.find(p => p.id === id);
ok('每條線兩個方向各一個型態', metro.patterns.length === 4 && M('TMRT-G|0').stops.join() === 'TMRT-G1,TMRT-G2,TMRT-G3,TMRT-G4,TMRT-G5' && M('TMRT-G|1').stops[0] === 'TMRT-G5' && M('TMRT-G|0').name === '綠線');
ok('有 S2S：行駛與停站時間來自資料（反向沿用同一站間）', M('TMRT-G|0').runTimes.join() === '120,120,120,120' && M('TMRT-G|0').dwell[0] === 25 && M('TMRT-G|1').runTimes[0] === 120 && M('TMRT-G|0').runEstimated === 0);
ok('沒有 S2S：以距離推估並標示', M('TMRT-B|0').runEstimated === 2 && M('TMRT-B|0').runSource.includes('推估') && M('TMRT-B|0').runTimes.every(x => x > 0));
ok('班距依時段、依星期', M('TMRT-G|0').freqs.length === 4 && M('TMRT-B|0').freqs.length === 0);
ok('首末班車依終點分到正確方向', M('TMRT-G|0').firstLast[0][0].first === 21600 && M('TMRT-G|0').firstLast[0][0].last === 86400 && M('TMRT-G|1').firstLast[0][0].last === 85800 && M('TMRT-G|1').firstLast[2][0].last === 86100 && M('TMRT-G|0').firstLast[4].length === 0);
ok('站內轉乘與出入口保留原始時間與座標', metro.transfers.length === 2 && metro.transfers[0].sec === 240 && metro.transfers[0].onSite === true && metro.exits.length === 2 && metro.exits[0].station === 'TMRT-G1');
const m0 = buildMetro({ station: mraw.station, stationOfLine: mraw.stationOfLine }, { operator: 'TMRT' });
ok('缺少的資料種類會明講（TMRT 本來就沒有 LineTransfer，不算缺）', m0.missing.length === 4 && !m0.missing.some(x => x.includes('LineTransfer')) && buildMetro({ station: mraw.station, stationOfLine: mraw.stationOfLine }, { operator: 'TRTC' }).missing.length === 5 && m0.warnings.some(w => w.includes('缺少資料')) && m0.patterns.every(p => p.runEstimated > 0 && !p.freqs.length));

console.log('— 班次表（TimetableStore）');
const store = createStore({ bus, metros: [metro] }), pi = id => store.patterns.findIndex(p => p.id === id);
ok('公車站牌與捷運站各自是獨立節點', store.stats.busStops === 11 && store.stats.metroStations === 8 && store.stops.every(s => s.uid && s.mode && s.source));
ok('站點 → 經過的路線型態與站序位置', store.stopPatterns[store.stopIndex.get('TXG1000')].map(([p, pos]) => store.patterns[p].id + '@' + pos).sort().join() === 'TXG10|0@0,TXG20|0@0,TXG40|0@0,TXG70|0@0');
const v1 = store.day(D1), v2 = store.day(D2), gs = id => v1.groupsOf[pi(id)].map(g => v1.groups[g]);
ok('平日：固定班表依星期幾挑班次', gs('TXG10|0').reduce((a, g) => a + g.n, 0) === 6 && v1.info[pi('TXG10|0')] === 'schedule');
ok('假日：只剩假日班次', v2.groupsOf[pi('TXG10|0')].reduce((a, g) => a + v2.groups[g].n, 0) === 1);
ok('今天有當日班表 → 只用當日班表', v1.info[pi('TXG10|1')] === 'daily' && gs('TXG10|1')[0].n === 1 && v1.info[pi('TXG40|0')] === 'daily');
ok('沒有今天的當日班表 → 資訊不足，不是停駛', v2.info[pi('TXG40|0')] === 'none' && v2.info[pi('TXG70|0')] === 'none');
ok('固定班表註明今天不開 → not-today；只有班距 → frequency', v2.info[pi('TXG50|0')] === 'not-today' && v1.info[pi('TXG30|0')] === 'frequency');
ok('會超車的班次分到不同群組（群組內不超車）', gs('TXG10|0').length === 2 && gs('TXG10|0').every(g => { for (let k = 1; k < g.n; k++) for (let i = 0; i < g.S; i++) if (g.dep[k * g.S + i] < g.dep[(k - 1) * g.S + i]) return false; return true; }));
const g0 = gs('TXG10|0').find(g => g.n === 5);
ok('二分搜尋：最早搭得上的一班', store.earliest(g0, 1, 7 * 3600) === 1 && g0.dep[1 * g0.S + 1] === 7 * 3600 + 300 && store.earliest(g0, 0, 6 * 3600) === 0 && store.earliest(g0, 0, 86000) === -1 && store.earliest(g0, 0, 85000) === 4);
ok('二分搜尋：最晚抵達的一班（指定抵達時間用）', store.latest(g0, 3, 8 * 3600 + 900) === 2 && store.latest(g0, 3, 6 * 3600) === -1);
const g8 = gs('TXG80|0')[0];
ok('時刻未知的站不能上下車', store.earliest(g8, 0, 0) === 0 && store.earliest(g8, 1, 0) === -1 && g8.arr[2] === store.UNKNOWN);
ok('推算的班次帶 est 旗標', (gs('TXG20|0')[0].flags[0] & 1) === 1 && (g0.flags[0] & 1) === 0);
const f = store.freqAt(pi('TMRT-G|0'), D1, 8 * 3600), f2 = store.freqAt(pi('TMRT-G|0'), D1, 12 * 3600), f3 = store.freqAt(pi('TMRT-G|0'), D2, 8 * 3600);
ok('捷運班距：尖峰／離峰／假日不同', f.minS === 240 && f2.minS === 480 && f3.minS === 600 && f.source === 'TDX Metro/Frequency');
ok('沒有班距資料的時段與路線 → null（資訊不足）', store.freqAt(pi('TMRT-G|0'), D1, 3 * 3600) === null && store.freqAt(pi('TMRT-B|0'), D1, 8 * 3600) === null);
ok('凌晨查前一營運日的班距（24:xx）', store.freqAt(pi('TMRT-G|0'), D1, 23.9 * 3600) !== null);
ok('首末班車：營運中／已收班／尚未發車／不知道', store.serviceState(pi('TMRT-G|0'), 0, D1, 12 * 3600).state === 'open' && store.serviceState(pi('TMRT-G|1'), 0, D1, 23.9 * 3600).state === 'closed'
  && store.serviceState(pi('TMRT-G|0'), 0, D1, 5 * 3600).before === true && store.serviceState(pi('TMRT-B|0'), 0, D1, 12 * 3600).state === 'unknown' && store.serviceState(pi('TMRT-G|0'), 0, D1, 86400).state === 'open');
ok('班距型路線的累計行駛時間（含停站）', Array.from(store.patterns[pi('TMRT-G|0')].offArr).join() === '0,120,265,410,555');
const sB = createStore({ bus, metros: [metro] }), sC = createStore({ bus: buildBus({ ...raw, schedule: raw.schedule.slice(1) }), metros: [metro] });
ok('資料版本：內容相同則相同、內容不同則不同', sB.version === store.version && sC.version !== store.version);

console.log('— 即時到站（ETA）');
let now = Date.parse('2026-11-17T08:00:30+08:00'); const es = createEtaStore({ staleS: 180, now: () => now });
es.ingest([eta(), eta({ Direction: 1, StopUID: 'TXG1001', EstimateTime: 600 }), eta({ StopUID: 'TXG1010', StopStatus: 1, EstimateTime: undefined, NextBusTime: '2026-11-17T09:00:00+08:00' }), eta({ StopUID: 'TXG1020', StopStatus: 4, EstimateTime: undefined }),
  eta({ StopUID: 'TXG1030', EstimateTime: undefined }), eta({ StopUID: 'TXGold', SrcUpdateTime: '2026-11-17T07:50:00+08:00', UpdateTime: undefined }), eta({ StopUID: 'TXGnots', SrcUpdateTime: undefined, UpdateTime: undefined }), { StopUID: 'x' }]);
const q = (stopUID, direction = 0) => es.get({ subRouteUID: 'TXG10', routeUID: 'TXG1', direction, stopUID });
ok('即時：到站時間＝資料時間＋預估秒數', q('TXG1000').kind === 'live' && q('TXG1000').arrivals[0].ms === Date.parse('2026-11-17T08:04:00+08:00') && q('TXG1000').arrivals[0].plate === 'ABC-123' && q('TXG1000').confidence === 'high');
ok('方向不同查不到（不混用）', q('TXG1000', 1).kind === 'none' && q('TXG1001', 1).kind === 'live' && q('TXG1001', 0).kind === 'none');
ok('尚未發車／今日未營運來自 StopStatus', q('TXG1010').kind === 'status' && q('TXG1010').status === 1 && q('TXG1010').nextBusMs === Date.parse('2026-11-17T09:00:00+08:00') && q('TXG1020').status === 4);
ok('沒有預估時間 → nodata；沒有這筆 → none（不編造）', q('TXG1030').kind === 'nodata' && q('TXG9999').kind === 'none' && !('arrivals' in q('TXG9999')));
ok('過期資料不當成即時', q('TXGold').kind === 'stale' && q('TXGnots').kind === 'stale' && !('arrivals' in q('TXGold')));
now += 200e3; ok('原本即時的資料放久了也會變過期', q('TXG1000').kind === 'stale');
ok('統計與清除', es.stats.dropped === 1 && es.stats.hits > 0 && es.stats.misses > 0 && (now += 20 * 60e3, es.prune() > 0) && es.size === 0);

console.log('— 同步與磁碟快取');
const dir = mkdtempSync(path.join(os.tmpdir(), 'bp-transit-')), list = datasetList('Taichung', ['TMRT']);
let clock = Date.parse('2026-11-17T04:00:00+08:00'), calls = [], failing = new Set(), sched = raw.schedule;
const fakeFetch = async p => { calls.push(p); const d = list.find(x => x.path === p);
  if (failing.has(d.name)) return { status: 500, data: null, detail: 'boom' };
  const data = d.group === 'bus' ? ({ stopOfRoute: raw.stopOfRoute, schedule: sched, daily: raw.daily, s2s: raw.s2s })[d.key] : mraw[d.key];
  return data ? { status: 200, data } : { status: 404, data: null }; };
const td = createTransitData({ dir, fetchJson: fakeFetch, now: () => clock });
ok('一開始沒有資料', td.load() === null && td.status().version === null);
const r1 = await td.refresh();
const avail = list.filter(d => (d.group === 'bus' ? true : mraw[d.key] != null)).length;   // 有資料的種類（捷運 stationOfRoute、ODFare 在測試資料裡沒有 → 404）
ok('第一次同步：抓全部並建立資料庫', calls.length === list.length && r1.changed === avail && td.store.stats.patterns === 13 && r1.report.find(x => x.name === 'metro.TMRT.stationOfRoute').action === 'failed');
const ver1 = td.store.version; calls = []; await td.refresh();
ok('未到期：不重抓', calls.length === 0);
clock += 7 * 3600e3; calls = []; const r3 = await td.refresh();
ok('只抓到期的（當日班表 6 小時），內容沒變就不重建', calls.length === 1 && calls[0].includes('DailyTimeTable') && r3.changed === 0 && td.store.version === ver1);
clock += 24 * 3600e3; sched = raw.schedule.slice(0, 3); failing.add('bus.stopOfRoute'); const r4 = await td.refresh();
ok('部分失敗：沿用舊資料，其餘照常更新，版本改變', r4.report.find(x => x.name === 'bus.stopOfRoute').keptOld === true && td.store.stats.busPatterns === 9 && td.store.version !== ver1 && td.status().datasets.find(x => x.name === 'bus.stopOfRoute').error.includes('500'));
const td2 = createTransitData({ dir, now: () => clock }); td2.load();
ok('重啟後直接從磁碟載入（不連網）', td2.store.version === td.store.version && td2.store.stats.trips === td.store.stats.trips);
let refreshErr = null; try { await td2.refresh(); } catch (e) { refreshErr = e; }
ok('沒有設定取資料方式時明確報錯', !!refreshErr);
rmSync(dir, { recursive: true, force: true });
let tokCalls = 0; const fj = createTdxFetcher({ upstream: 'http://x', getToken: async force => { tokCalls++; return force ? 'good' : 'old'; },
  fetchImpl: async (u, o) => o.headers.Authorization === 'Bearer good' ? { status: 200, text: async () => '[{"a":1}]' } : { status: 401, text: async () => '' } });
const fr = await fj('/Bus/x');
ok('token 過期（401）會換新 token 重試', fr.status === 200 && fr.data[0].a === 1 && tokCalls === 2);
ok('台中捷運（TMRT）不再請求 LineTransfer（TDX 只接受 TRTC、KRTC、TYMC、NTMC）；台北捷運照常', !list.some(d => d.name === 'metro.TMRT.lineTransfer') && datasetList('Taipei', ['TRTC']).some(d => d.name === 'metro.TRTC.lineTransfer'));
ok('捷運票價 ODFare 列入同步清單（選用、每週更新）', list.some(d => d.name === 'metro.TMRT.odFare' && d.optional && d.path.includes('/Rail/Metro/ODFare/TMRT')));
{ // 429 限流：依 Retry-After 等待後重試；請求之間保持間隔
  const waits = [], seq = [429, 429, 200]; let n = 0;
  const f429 = createTdxFetcher({ upstream: 'http://x', getToken: async () => 't', minGapMs: 0, wait: async ms => { waits.push(ms); },
    fetchImpl: async () => { const st = seq[Math.min(n++, seq.length - 1)]; return { status: st, headers: { get: k => (k === 'retry-after' && st === 429 ? (n === 1 ? '3' : null) : null) }, text: async () => (st === 200 ? '[{"ok":1}]' : '{"message":"API rate limit exceeded"}') }; } });
  const r = await f429('/Rail/Metro/S2STravelTime/TMRT');
  ok('429 → 依 Retry-After（3 秒）、再指數退避（4 秒）重試，最後成功', r.status === 200 && r.data[0].ok === 1 && waits[0] === 3000 && waits[1] === 4000, waits.join('、'));
  let m = 0; const fAlways = createTdxFetcher({ upstream: 'http://x', getToken: async () => 't', minGapMs: 0, retries: 2, wait: async () => {}, fetchImpl: async () => { m++; return { status: 429, headers: { get: () => null }, text: async () => 'limit' }; } });
  const r2 = await fAlways('/x'); ok('一直 429：重試上限後回報失敗（不無限重試）', r2.status === 429 && m === 3 && r2.retried === 2);
  const gaps = [], fGap = createTdxFetcher({ upstream: 'http://x', getToken: async () => 't', minGapMs: 800, wait: async ms => { gaps.push(ms); }, fetchImpl: async () => ({ status: 200, text: async () => '[]' }) });
  await Promise.all([fGap('/a'), fGap('/b'), fGap('/c')]);
  ok('連續請求之間保持間隔（避免觸發限流）', gaps.length === 2 && gaps.every(g => g > 700 && g <= 800), gaps.map(g => Math.round(g)).join('、'));
}
done();
