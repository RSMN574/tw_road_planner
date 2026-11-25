#!/usr/bin/env node
// osm-speedlimits.mjs — 從 OSM PBF 抽出道路圖沒有存的速限標籤（v1.20），寫到道路圖資料夾的 speed-extra.json
//   maxspeed:conditional（時段速限）、maxspeed:variable（可變速限）、maxspeed:advisory（建議速限）、maxspeed:lanes（各車道）、
//   maxspeed:type／source:maxspeed＝sign（依現場標誌登錄 → 可信度較高）
// 用法：npm run osm:speedlimits [-- --pbf 檔案 --dir 道路圖資料夾]（預設：data/osm/raw 最新的 PBF、data/osm/graph/current.json 指的資料夾）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../../server/osm/pbf.mjs';
import { parseCli } from './cli.mjs';
import { parseConditional } from '../../server/osm/speed-limit.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), cli = parseCli(['pbf', 'dir', 'raw']);
const rawDir = path.resolve(cli.str('raw') || path.join(ROOT, 'data/osm/raw'));
let pbf = cli.str('pbf') || cli.rest.find(x => /\.osm\.pbf$/i.test(x));
if (!pbf) { const c = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith('.osm.pbf')).map(f => ({ f, t: statSync(path.join(rawDir, f)).mtimeMs })).sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)) : []; if (c.length) pbf = path.join(rawDir, c[0].f); }
if (!pbf || !existsSync(pbf)) { console.error('✗ 找不到 OSM PBF；用 --pbf 指定，或先 npm run osm:download'); process.exit(1); }
let dir = cli.str('dir');
if (!dir) { const cur = path.join(ROOT, 'data/osm/graph/current.json'); if (!existsSync(cur)) { console.error('✗ 沒有 data/osm/graph/current.json；先 npm run osm:build，或用 --dir 指定'); process.exit(1); } dir = path.join(ROOT, 'data/osm/graph', JSON.parse(readFileSync(cur, 'utf8')).dir); }
dir = path.resolve(dir);
console.log(`讀取 ${pbf}`);
const t0 = Date.now(), ways = {}, st = { highwayWays: 0, cond: 0, condUnparsed: 0, variable: 0, advisory: 0, lanes: 0, sign: 0 };
scan(pbf, { way(id, refs, t) {
  if (!t || !t.highway) return; st.highwayWays++;
  const x = {};
  if (t['maxspeed:conditional']) { x.cond = t['maxspeed:conditional']; st.cond++; if (!parseConditional(x.cond).ok) st.condUnparsed++; }
  if (t['maxspeed:variable']) { x.variable = t['maxspeed:variable']; st.variable++; }
  if (t['maxspeed:advisory']) { x.advisory = t['maxspeed:advisory']; st.advisory++; }
  if (t['maxspeed:lanes']) { x.lanes = t['maxspeed:lanes']; st.lanes++; }
  if (t.maxspeed && (t['maxspeed:type'] === 'sign' || t['source:maxspeed'] === 'sign')) { x.sign = 1; st.sign++; }
  if (Object.keys(x).length) ways[String(id)] = x;
} });
const out = path.join(dir, 'speed-extra.json'), doc = { version: new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Object.keys(ways).length, builtAt: new Date().toISOString(), source: path.basename(pbf), stats: st, ways };
writeFileSync(out + '.tmp', JSON.stringify(doc)); renameSync(out + '.tmp', out);
console.log(`✅ ${out}：${Object.keys(ways).length} 條道路（時段速限 ${st.cond}${st.condUnparsed ? `，其中 ${st.condUnparsed} 條無法解析` : ''}、可變 ${st.variable}、建議 ${st.advisory}、各車道 ${st.lanes}、依標誌登錄 ${st.sign}），${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
