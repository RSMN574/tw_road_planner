// bench-transit.mjs — 階段 0：現有公車搜尋（suggestBusMulti）的效能基準。
//   node test/bench-transit.mjs            印出報告並寫入 test/bench-baseline.json
// 之後新引擎會用同一座合成城市、同一組起訖點再跑一次，才能做「優化前後」的比較。
import { writeFileSync } from 'node:fs';
import './helpers.mjs';
import { makeCity, roadGraphOf } from './transit-city.mjs';
const log = console.log; console.log = console.info = console.warn = console.error = () => {};
await import('../js/main.js');
const { State } = await import('../js/state.js'), { buildGraph } = await import('../js/loader.js'), { lonLatToTWD97, lonLatToWorld } = await import('../js/geo.js');
const { loadBus } = await import('../js/transit.js'), { suggestBusMulti, moaStar } = await import('../js/bus-plan.js');

const city = makeCity(); global.gc?.(); const mem0 = process.memoryUsage().heapUsed;
let t = performance.now(); buildGraph(roadGraphOf(city, lonLatToTWD97)); loadBus(city.old); const loadMs = performance.now() - t;
global.gc?.(); const memLoaded = process.memoryUsage().heapUsed;
const b = State.bus, times = [], counts = [], pops = []; let found = 0, single = 0, noStop = 0, noLink = 0, peak = 0;
const xy = p => lonLatToWorld(p.lon, p.lat);
for (let round = 0; round < 2; round++) for (const od of city.od) {              // 第一輪暖機，第二輪計時
  const [fx, fy] = xy(od.from), [tx, ty] = xy(od.to), t0 = performance.now(), r = suggestBusMulti(fx, fy, tx, ty), ms = performance.now() - t0;
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  if (!round) continue;
  times.push(ms);
  if (r[0]?.error) { if (/沒有公車站/.test(r[0].error)) noStop++; else noLink++; counts.push(0); continue; }
  found++; counts.push(r.length); if (r.length === 1) single++;
  pops.push(moaStar(fx, fy, tx, ty).pops ?? 0);
}
times.sort((a, c) => a - c); const q = p => times[Math.min(times.length - 1, Math.floor(times.length * p))], avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1), mb = x => +(x / 1048576).toFixed(1);
const out = { engine: '現有：suggestBusMulti（靜態圖、固定候車 300 秒、不看出發時間）', at: new Date().toISOString(), node: process.version,
  city: { stops: b.n, routeEdges: b.eTo.length, routes: b.routeLabels.length, odPairs: city.od.length }, loadMs: +loadMs.toFixed(1),
  search: { avgMs: +avg(times).toFixed(2), p50Ms: +q(0.5).toFixed(2), p95Ms: +q(0.95).toFixed(2), maxMs: +times[times.length - 1].toFixed(2) },
  results: { found, noStopNearby: noStop, noConnection: noLink, avgOptions: +avg(counts.filter(Boolean)).toFixed(1), singleOption: single },
  expanded: { note: '現有搜尋沒有統計展開的節點／邊數；只有多目標搜尋有彈出次數', moaPopsAvg: Math.round(avg(pops)), dijkstraRunsPerQuery: '約 15～31 次（每次配置與邊數等長的陣列）' },
  memory: { loadedMB: mb(Math.max(0, memLoaded - mem0)), peakHeapMB: mb(peak) }, cache: { hitRate: null, note: '現有搜尋本身沒有快取（伺服器層另有結果快取）' },
  timeAware: false, departAt: false, arriveBy: false };
console.log = log;
log('現有公車搜尋基準（合成城市，固定種子）');
log(`  規模：${out.city.stops} 站牌、${out.city.routes} 條路線、${out.city.routeEdges} 條搭乘邊、${out.city.odPairs} 組起訖點`);
log(`  搜尋耗時：平均 ${out.search.avgMs} ms｜中位 ${out.search.p50Ms}｜P95 ${out.search.p95Ms}｜最慢 ${out.search.maxMs}`);
log(`  結果：找到 ${found} 組（平均 ${out.results.avgOptions} 條、只有 1 條的 ${single} 組）｜附近沒站 ${noStop}｜無連線 ${noLink}`);
log(`  多目標搜尋平均彈出 ${out.expanded.moaPopsAvg} 次；記憶體：路網載入約 ${out.memory.loadedMB} MB、尖峰堆積 ${out.memory.peakHeapMB} MB`);
log('  不支援：依出發時間搜尋、指定抵達時間、依實際班次計算候車');
writeFileSync(new URL('./bench-baseline.json', import.meta.url), JSON.stringify(out, null, 1));
log('已寫入 test/bench-baseline.json');
process.exit(0);
