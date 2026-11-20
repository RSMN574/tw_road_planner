#!/usr/bin/env node
// osm-buildings.mjs — 從台灣 OSM PBF 擷取建築物外框與高度 → <圖的資料夾>/osm-buildings.twbld（伺服器的建築圖磚、網頁的 2D／3D 建築用）
//   npm run osm:buildings                     （PBF：data/osm/raw 最新的一個；輸出到 current.json 指向的圖資料夾）
//   npm run osm:buildings -- --pbf <檔案> --dir data/osm/graph/20261117
// 約 1～3 分鐘、記憶體約 1.5～2.5 GB（三趟讀 PBF：relation → way → node）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBuildings, writeBuildings, SRC } from '../../server/osm/buildings.mjs';
import { parseCli } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), cli = parseCli(['pbf', 'dir', 'raw']);
const rawDir = path.resolve(cli.str('raw') || path.join(ROOT, 'data/osm/raw'));
let pbf = cli.str('pbf') || cli.rest.find(x => /\.osm\.pbf$/i.test(x));
if (!pbf) { const c = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith('.osm.pbf')).map(f => ({ f, t: statSync(path.join(rawDir, f)).mtimeMs })).sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)) : []; if (c.length) pbf = path.join(rawDir, c[0].f); }
if (!pbf || !existsSync(pbf)) { console.error('✗ 找不到 OSM PBF；用 --pbf 指定，或先 npm run osm:download'); process.exit(1); }
let dir = cli.str('dir');
if (!dir) { const cur = path.join(ROOT, 'data/osm/graph/current.json'); if (!existsSync(cur)) { console.error('✗ 沒有 data/osm/graph/current.json；先 npm run osm:build，或用 --dir 指定輸出資料夾'); process.exit(1); } dir = path.join(ROOT, 'data/osm/graph', JSON.parse(readFileSync(cur, 'utf8')).dir); }
dir = path.resolve(dir);
const t0 = Date.now(); console.log(`讀取 ${pbf}`);
const x = extractBuildings(pbf, { log: console.log });
const out = path.join(dir, 'osm-buildings.twbld'), w = writeBuildings(out, x, { source: path.basename(pbf) });
const s = x.stats, pct = k => (100 * s.bySource[k] / Math.max(1, s.ways)).toFixed(1);
const rep = { builtAt: new Date().toISOString(), source: path.basename(pbf), count: w.count, bytes: w.bytes, seconds: (Date.now() - t0) / 1000, stats: s, heightSourcePct: Object.fromEntries(SRC.map((n, i) => [n, +pct(i)])) };
writeFileSync(path.join(dir, 'buildings-report.json'), JSON.stringify(rep, null, 1));
console.log(`✅ ${out}：${w.count.toLocaleString()} 棟、${(w.bytes / 1048576).toFixed(1)} MB、${rep.seconds.toFixed(1)} 秒`);
console.log(`   高度來源：${SRC.map((n, i) => `${n} ${pct(i)}%`).join('、')}；building:part ${s.parts}（未使用）、缺節點 ${s.missingNodes}、未封閉 ${s.tooFewNodes}、multipolygon outer ${s.relationOuters}`);
