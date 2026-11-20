// make-transit-cache.mjs — 把 test/fixtures/rail-fixture.mjs（模擬資料）寫成伺服器讀的 TDX 快取（<dir>/transit/raw/*.json.gz）
// 用途：不需要 TDX 金鑰也能端對端測試 /api/v1/transit/plan 與網頁（資料是假的，只在台中附近的小範圍）
//   node test/make-transit-cache.mjs .cache/transit-fixture
//   CACHE_DIR=.cache/transit-fixture TRANSIT_CITY=Taichung TRANSIT_METRO=KRTC,KLRT,NTALRT TRANSIT_RAIL=TRA,THSR node server/server.mjs
import path from 'node:path';
import { createTransitData } from '../server/transit/snapshot.mjs';
import { railFixture, fakeTdx, DATE } from './fixtures/rail-fixture.mjs';
const dir = path.resolve(process.argv[2] || '.cache/transit-fixture'), fk = fakeTdx(railFixture());
const td = createTransitData({ dir: path.join(dir, 'transit'), city: 'Taichung', operators: ['KRTC', 'KLRT', 'NTALRT'], rail: ['TRA', 'THSR'], extras: true, fetchJson: fk.fetchJson, now: () => Date.now() });
const r = await td.refresh({ force: true });
console.log(`模擬資料已寫入 ${dir}/transit（${r.report.filter(x => x.action === 'updated').length} 種資料；版本 ${r.version}；班表日期依模擬資料：${DATE} 起的平日）`);
