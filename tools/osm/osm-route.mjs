#!/usr/bin/env node
// osm-route.mjs — 用 OSM 道路圖試算路線（檢查單行、禁行、轉向限制）
//   npm run osm:route -- --from 25.0478,121.5170 --to 25.0340,121.5645 --profile car,moto,foot
//   node tools/osm/osm-route.mjs --from 24.1477,120.6736 --to 24.1631,120.6476 --profile car [--graph data/osm/graph/…/osm-graph.twosm] [--geojson out.geojson] [--conditional]
//   起點、終點都是「緯度,經度」。Windows PowerShell 用 npm run 時旗標會被 npm 吃掉、逗號會被拆開，這裡也認得（見 cli.mjs）
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readGraph } from '../../server/osm/graph-file.mjs';
import { OsmRouter } from '../../server/osm/router.mjs';
import { parseCli, isNum } from './cli.mjs';
const cli = parseCli(['from', 'to', 'profile', 'graph', 'geojson']);
const PROFILE_KEYS = ['car', 'heavy', 'moto', 'bike', 'foot'], ALIAS = { walk: 'foot', walking: 'foot', bicycle: 'bike', cycle: 'bike', motorcycle: 'moto', scooter: 'moto', motorcar: 'car' };
const nums = cli.tokens.filter(isNum).map(Number), words = cli.tokens.filter(t => !isNum(t));
const notes = [];
// 座標：--from／--to 的值；不夠兩個數字時依序從一般參數補（PowerShell 會把 25.0478,121.5170 拆成兩個參數）
const coord = k => {
  const v = (cli.str(k) || '').split(/[\s,]+/).filter(isNum).map(Number);
  while (v.length < 2 && nums.length) v.push(nums.shift());
  if (v.length !== 2) return null;
  if (Math.abs(v[0]) > 90 && Math.abs(v[1]) <= 90) { notes.push(`${k === 'from' ? '起點' : '終點'}看起來是「經度,緯度」，已對調成 ${v[1]},${v[0]}`); v.reverse(); }
  return v;
};
const from = coord('from'), to = coord('to');
const named = [...(cli.str('profile') || '').split(/[\s,]+/), ...words].map(w => w.trim().toLowerCase()).map(w => ALIAS[w] || w);
const profiles = [...new Set(named.filter(w => PROFILE_KEYS.includes(w)))];
const geojson = cli.str('geojson') || words.find(w => /\.geojson$/i.test(w)), graphArg = cli.str('graph') || words.find(w => /\.twosm$/i.test(w));
const unknown = words.filter(w => w && !PROFILE_KEYS.includes(ALIAS[w.toLowerCase()] || w.toLowerCase()) && w !== geojson && w !== graphArg);
if (!from || !to) {
  console.error(`✗ 需要起點和終點（緯度,經度）。例：
   npm run osm:route -- --from 25.0478,121.5170 --to 25.0340,121.5645 --profile car,moto,foot
   node tools/osm/osm-route.mjs --from "25.0478,121.5170" --to "25.0340,121.5645" --profile "car,moto,foot"
  運具：car 汽車、heavy 大型重機、moto 機車、bike 自行車、foot 步行`);
  process.exit(2);
}
if (unknown.length) notes.push(`看不懂的參數已略過：${unknown.join(' ')}（運具只有 car、heavy、moto、bike、foot）`);
if (!profiles.length) profiles.push('car');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let gf = graphArg; if (!gf) { const c = path.join(ROOT, 'data/osm/graph/current.json'); if (!existsSync(c)) { console.error('✗ 沒有道路圖：先執行 tools/osm/osm-build.mjs'); process.exit(2); } gf = path.join(ROOT, 'data/osm/graph', JSON.parse(readFileSync(c, 'utf8')).graph); }
const t0 = Date.now(), g = readGraph(gf), R = new OsmRouter(g, { applyConditional: cli.on('conditional') });
for (const n of notes) console.log('⚠ ' + n);
console.log(`載入 ${g.V.n.toLocaleString()} 頂點、${g.E.n.toLocaleString()} 邊（${Date.now() - t0} ms）`);
for (const p of profiles) {
  const t0p = performance.now(); R.components(p); R.edgeIndex(); const initMs = performance.now() - t0p;      // 第一次用這個運具：成本表、連通結構、路段索引
  if (initMs > 50) console.log(`（${p} 第一次使用：建索引 ${initMs.toFixed(0)} ms）`);
  const t1 = performance.now(), r = R.route({ from, to, profile: p }), ms = (performance.now() - t1).toFixed(0);
  if (r.error) { console.log(`${p}：${r.message}（${ms} ms）`); continue; }
  console.log(`${p}：${(r.distanceM / 1000).toFixed(2)} km、約 ${Math.round(r.durationS / 60)} 分；搜尋 ${r.settled.toLocaleString()} 條有向邊、${ms} ms；起終點吸附 ${r.snap.fromM}／${r.snap.toM} m`);
  console.log(`   經過：${r.ways.filter(w => w.m > 50).slice(0, 12).map(w => `${w.name || w.ref || w.highway}（${w.m} m）`).join(' → ')}`);
  const wn = r.warnings; if (wn.unknownM || wn.limitedM || wn.conditionalM) console.log(`   ⚠ 通行未知 ${wn.unknownM} m、有條件 ${wn.limitedM} m、依時段 ${wn.conditionalM} m`);
  if (geojson) writeFileSync(geojson.replace(/(\.\w+)?$/, `-${p}$1`), JSON.stringify({ type: 'Feature', properties: { profile: p, distanceM: r.distanceM, durationS: r.durationS, ways: r.ways }, geometry: { type: 'LineString', coordinates: r.coords } }));
}
