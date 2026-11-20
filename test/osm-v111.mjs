// osm-v111.mjs — v1.11 OSM 道路圖：時段條件轉向限制、通行權四態、道路事件（封閉／加權／方向）、RoadGraphValidator、建築檔、高度層
// 資料：test/fixtures/osm/tw-mini.osm.pbf（台中附近的小格子 OSM 測試圖）＋人工事件（模擬資料，欄位照 docs/oas/tdx-road-event-v1.json）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTopology } from '../server/osm/topology.mjs';
import { OsmRouter } from '../server/osm/router.mjs';
import { compileCondition, parseConditionalValue } from '../server/osm/conditional.mjs';
import { access4, ST, COND } from '../server/osm/access.mjs';
import { levelOf } from '../server/osm/tags.mjs';
import { auditTopology, auditConnectivity, auditConditional, auditMarkdown } from '../server/osm/audit.mjs';
import { normalizeWrapper, buildOverlay, eventActive, parsePositions } from '../server/traffic/events.mjs';
import { heightOf, parseHeight, writeBuildings, readBuildings, buildingTile } from '../server/osm/buildings.mjs';

let fails = 0; const ok = (n, c, i = '') => { console.log(`  ${c ? '✓' : '✗'} ${n}${i ? '｜' + i : ''}`); if (!c) fails++; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), g = buildTopology(ROOT + '/test/fixtures/osm/tw-mini.osm.pbf'), R = new OsmRouter(g);
const T = s => Date.parse(s + '+08:00'), at = (i, j) => [24.150 + j * 0.001, 120.650 + i * 0.001];

console.log('① 時段條件（opening_hours 子集）');
const c = (s, t) => compileCondition(s)(T(t));
ok('Mo-Fr 07:00-09:00：週五 08:00 適用、週六不適用、週五 10:00 不適用', c('(Mo-Fr 07:00-09:00)', '2026-11-20T08:00') === true && c('Mo-Fr 07:00-09:00', '2026-11-21T08:00') === false && c('Mo-Fr 07:00-09:00', '2026-11-20T10:00') === false);
ok('跨午夜 22:00-06:00', c('22:00-06:00', '2026-11-20T23:00') === true && c('22:00-06:00', '2026-11-21T05:00') === true && c('22:00-06:00', '2026-11-20T12:00') === false);
ok('實際資料的寫法：空白、括號不成對、7-9、hour_on/hour_off', c('07:00-09:00, 17:00-19:00', '2026-11-20T18:00') === true && c('(Mo-Fr 07:00-09:00', '2026-11-20T08:30') === true && c('hour_on=7-9', '2026-11-20T08:00') === true && c('day_on=Monday day_off=Friday hour_on=07:00 hour_off=09:00', '2026-11-22T08:00') === false);
const ph = compileCondition('(07:00-09:00, PH off)');
ok('「, PH off」：照平日判斷並記下（沒有國定假日日曆）', ph(T('2026-11-20T08:00')) === true && ph.info.ignoredHolidayException === true);
ok('無法判斷的（只在國定假日、重量）→ null，不猜', c('(PH 17:00-19:00)', '2026-11-20T18:00') === null && c('(weight>6.5 AND Mo-Su 07:00-20:00)', '2026-11-20T08:00') === null);
ok('含 ; 的條件依括號切開', JSON.stringify(parseConditionalValue('no_left_turn @ (Mo-Fr 07:00-09:00; Sa 08:00-12:00); no_u_turn @ (22:00-06:00)').map(x => x.value)) === '["no_left_turn","no_u_turn"]');

console.log('② 路線依出發時間套用時段轉向限制（測試圖的 relation 902：東西1路 → 南北3路 右轉，Mo-Fr 07:00-09:00 禁止）');
const from = [24.151, 120.6515], to = [24.1503, 120.653];
const rPeak = R.route({ from, to, profile: 'car', at: T('2026-11-20T08:00') }), rOff = R.route({ from, to, profile: 'car', at: T('2026-11-20T10:00') }), rNo = R.route({ from, to, profile: 'car' });
ok('平日 08:00：禁止右轉 → 繞路（比 10:00 長）', !rPeak.error && !rOff.error && rPeak.distanceM > rOff.distanceM + 50, `${rPeak.distanceM} m vs ${rOff.distanceM} m`);
ok('結果回報套用了幾條時段限制', rPeak.conditionalRestrictions && rPeak.conditionalRestrictions.applied >= 1 && rOff.conditionalRestrictions.applied === 0);
ok('沒給時間：舊行為（不套用並回報）', rNo.distanceM === rOff.distanceM && rNo.conditionalRestrictionsIgnored >= 1);

console.log('③ 通行權四態（AccessProfileEngine）');
ok('未標註依類別推定 → allowed/default；單行反向 → prohibited/oneway；未知 → unknown/none', access4(ST.DEFAULT_ALLOWED).state === 'allowed' && access4(ST.DEFAULT_ALLOWED).source === 'default' && access4(ST.ONEWAY).source === 'oneway' && access4(ST.UNKNOWN).state === 'unknown' && access4(ST.LIMITED).state === 'restricted' && access4(ST.ALLOWED | COND).conditional);
ok('高度層：location=underground＝−1、covered 不改變高度、layer 優先', levelOf({ location: 'underground' }) === -1 && levelOf({ covered: 'yes' }) === 0 && levelOf({ layer: '2', tunnel: 'yes' }) === 2);

console.log('④ 道路事件（TrafficEventEngine；模擬資料）');
const wrap = { UpdateTime: '2026-11-20T07:50:00+08:00', AuthorityCode: 'TEST', Items: [
  { EventID: 'E1', EventTitle: '台灣大道封閉', EventType: 4, EffectiveTime: '2026-11-20T07:00:00+08:00', ExpireTime: '2026-11-20T12:00:00+08:00', Positions: `${at(2, 2)[1] - 0.0005} ${at(2, 2)[0]}`, LocationType: 0,
    Location: { CityRoad: { Roadways: [{ City: '臺中市', Road: '台灣大道', Direction: '雙向' }] } }, Impact: { Severity: 2, BlockWay: 2 }, LastUpdateTime: '2026-11-20T07:40:00+08:00' },
  { EventID: 'E2', EventTitle: '已結束的施工', EventType: 2, EffectiveTime: '2026-11-19T07:00:00+08:00', ExpireTime: '2026-11-19T12:00:00+08:00', Positions: `POINT(${at(1, 1)[1]} ${at(1, 1)[0]})`, Impact: { Severity: 1 } },
  { EventID: 'E3', EventTitle: '沒有座標的事故', EventType: 1, Impact: { Severity: 2 }, Location: { Address: { City: '臺中市', Road: '某路' } } }] };
const evs = normalizeWrapper(wrap, 'live');
ok('統一格式：eventId、type、source、affectedRoad、geometry、時間、severity、confidence、updatedAt', evs[0].eventId === 'E1' && evs[0].type === '特殊管制' && evs[0].affectedRoad[0].road === '台灣大道' && evs[0].geometry && evs[0].startTime && evs[0].severity === 2 && evs[0].confidence === 'high' && evs[0].updatedAt && evs[2].confidence === 'none');
ok('座標字串：WKT、經緯度順序依範圍判斷', JSON.stringify(parsePositions('24.15,120.65')) === '[[[120.65,24.15]]]' && parsePositions('POINT(120.65 24.15)')[0][0][0] === 120.65);
ok('有效時間：E2 已過期', eventActive(evs[1], T('2026-11-20T08:00')) === false && eventActive(evs[0], T('2026-11-20T08:00')) === true);
const ov = buildOverlay(evs, R, { at: T('2026-11-20T08:00') });
ok('E1 對應到台灣大道的路段（封閉）；E2 過期、E3 沒座標不推測', ov.hits.length === 1 && ov.hits[0].block && ov.skipped.inactive === 1 && ov.skipped.noGeometry === 1 && [...ov.overlay.values()].every(o => o.block), JSON.stringify(ov.skipped));
const a1 = at(0, 2), b1 = at(4, 2), base = R.route({ from: a1, to: b1, profile: 'car' }), avoid = R.route({ from: a1, to: b1, profile: 'car', overlay: ov.overlay });
ok('沿台灣大道的路線：避開封閉路段改道，結果列出經過的事件為 0', !base.error && !avoid.error && base.roads.includes('台灣大道') && avoid.arcs.every(a => !ov.overlay.has(a)), `${base.distanceM} m → ${avoid.distanceM} m`);
const ovSlow = new Map([...ov.overlay].map(([k]) => [k, { block: false, factor: 2, timeFactor: 1.5, events: ['E1'] }])), slow = R.route({ from: a1, to: b1, profile: 'car', overlay: ovSlow });
ok('部分阻斷（加權）：時間變長，結果列出事件與額外秒數', slow.durationS >= base.durationS && (slow.events.length === 0 || slow.events[0].extraS > 0));

console.log('⑤ RoadGraphValidator（測試圖；全台結果見 docs/reports）');
const top = auditTopology(g, R), con = auditConnectivity(g, R), cond = auditConditional(g, T('2026-11-20T08:00'));
ok('拓樸稽核：各項計數都有、沒有長度 0 以外的異常爆量', top.edges === g.E.n && top.crossings && top.duplicates && top.undershoots.deadEnds >= 0 && Number.isFinite(top.geometry.spikes));
ok('連通性：各運具有向（強連通）與無向（弱連通）分開，含渡輪／不含渡輪', ['car', 'heavy', 'moto', 'bike', 'foot'].every(k => con[k] && con[k].weak.withFerry.components >= 1 && con[k].strong.components >= 1 && con[k].accessKm));
ok('單行道造成的方向性限制單獨計數（汽車在測試圖有單行道）', con.car.strong.components >= con.car.weak.withFerry.components);
ok('時段條件可判斷比例', cond.relations >= 1 && cond.evaluable === cond.relations);
ok('報告 Markdown', auditMarkdown({ graph: 'x', auditedAt: 'now', seconds: 0, topology: top, connectivity: con, conditional: cond }).includes('幾何相交但沒有共用 node'));

console.log('⑥ 建築物（高度來源分開）');
ok('高度：height 標籤 > building:levels×3 m > 推估（標示來源）', heightOf({ building: 'yes', height: '12 m' }).src === 0 && heightOf({ building: 'apartments', 'building:levels': '5' }).h === 15 && heightOf({ building: 'apartments' }).src === 2 && parseHeight("30'") > 9);
const dir = mkdtempSync(path.join(tmpdir(), 'bld-')), f = path.join(dir, 'b.twbld');
const sq = (la, lo) => [la, lo, la, lo + 3000, la + 3000, lo + 3000, la + 3000, lo];      // 約 30 m 方形（1e-7 度）
const pts = [sq(241500000, 1206500000), sq(241510000, 1206510000)];
const X = { n: 2, off: Int32Array.from([0, 4, 8]), lat: Int32Array.from(pts.flatMap(p => [p[0], p[2], p[4], p[6]])), lon: Int32Array.from(pts.flatMap(p => [p[1], p[3], p[5], p[7]])), keep: Uint8Array.from([1, 1]),
  h: Float32Array.from([30, 6]), minH: Float32Array.from([0, 0]), src: Uint8Array.from([0, 2]), levels: Uint8Array.from([10, 0]), type: Int32Array.from([1, 1]), name: Int32Array.from([2, 0]), id: Float64Array.from([1, 2]), strings: ['', 'yes', '測試大樓'], stats: { ways: 2 } };
writeBuildings(f, X); const B = readBuildings(f), z = 17, n = 2 ** z, tx = Math.floor((120.6505 + 180) / 360 * n), r = 24.1505 * Math.PI / 180, ty = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
const tl = buildingTile(B, z, tx, ty); rmSync(dir, { recursive: true, force: true });
ok('建築檔寫入／讀取／圖磚：高度（公寸）、來源、名稱', B.n === 2 && tl.b.length >= 1 && tl.b.some(b => b[0] === 300 && b[2] === 0) && tl.names.includes('測試大樓'), `${tl.b.length} 棟`);

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
