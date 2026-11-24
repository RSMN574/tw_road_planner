#!/usr/bin/env node
// osm-poi.mjs — 從台灣 OSM PBF 擷取店家地點（POI）→ <圖的資料夾>/osm-poi.json.gz（伺服器的 /api/v1/poi/* 用）
//   npm run osm:poi                          （PBF：data/osm/raw 最新的；輸出到 current.json 指向的圖資料夾）
//   npm run osm:poi -- --pbf <檔案> --dir data/osm/graph/20261117
// 約 1 分鐘、記憶體約 2 GB（兩趟讀 PBF：way → node）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPois, writePois } from '../../server/osm/poi.mjs';
import { CATEGORIES } from '../../server/osm/poi-categories.mjs';
import { parseCli } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), cli = parseCli(['pbf', 'dir', 'raw']);
const rawDir = path.resolve(cli.str('raw') || path.join(ROOT, 'data/osm/raw'));
let pbf = cli.str('pbf') || cli.rest.find(x => /\.osm\.pbf$/i.test(x));
if (!pbf) { const c = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith('.osm.pbf')).map(f => ({ f, t: statSync(path.join(rawDir, f)).mtimeMs })).sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)) : []; if (c.length) pbf = path.join(rawDir, c[0].f); }
if (!pbf || !existsSync(pbf)) { console.error('✗ 找不到 OSM PBF；用 --pbf 指定，或先 npm run osm:download'); process.exit(1); }
let dir = cli.str('dir');
if (!dir) { const cur = path.join(ROOT, 'data/osm/graph/current.json'); if (!existsSync(cur)) { console.error('✗ 沒有 data/osm/graph/current.json；先 npm run osm:build，或用 --dir 指定'); process.exit(1); } dir = path.join(ROOT, 'data/osm/graph', JSON.parse(readFileSync(cur, 'utf8')).dir); }
dir = path.resolve(dir);
console.log(`讀取 ${pbf}`);
const x = extractPois(pbf, { log: console.log }), out = path.join(dir, 'osm-poi.json.gz'), w = writePois(out, x, { source: path.basename(pbf) });
const s = x.stats, top = Object.entries(s.byCat).sort((a, b) => b[1] - a[1]);
writeFileSync(path.join(dir, 'poi-report.json'), JSON.stringify({ builtAt: new Date().toISOString(), source: path.basename(pbf), bytes: w.bytes, ...s }, null, 1));
console.log(`✅ ${out}：${w.count.toLocaleString()} 個地點（點 ${s.nodes.toLocaleString()}、面 ${s.ways.toLocaleString()}、沒有名稱但保留 ${s.unnamedKept.toLocaleString()}），${(w.bytes / 1048576).toFixed(1)} MB，${s.seconds.toFixed(1)} 秒`);
console.log('   ' + top.map(([c, n]) => `${(CATEGORIES[c] || {}).label || c} ${n.toLocaleString()}`).join('、'));
