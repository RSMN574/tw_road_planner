#!/usr/bin/env node
// osm-audit.mjs — 全台 OSM 道路圖稽核（RoadGraphValidator，server/osm/audit.mjs）
//   npm run osm:audit                         （data/osm/graph/current.json 指向的那一份；約 2～4 分鐘、記憶體約 2 GB）
//   npm run osm:audit -- --dir data/osm/graph/20261117 --skip counties
//   --skip topology,connectivity,counties     略過某些檢查
// 輸出：<圖的資料夾>/audit.json、audit.md，並複製一份到 docs/reports/osm-audit-<資料日期>.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph } from '../../server/osm/graph-file.mjs';
import { OsmRouter } from '../../server/osm/router.mjs';
import { altLoader, readAltHead } from '../../server/osm/alt.mjs';
import { auditTopology, auditConnectivity, auditCounties, auditConditional, auditMarkdown } from '../../server/osm/audit.mjs';
import { parseCli } from './cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), cli = parseCli(['dir', 'graph-root', 'skip']);
let dir = cli.str('dir') || cli.tokens.find(t => existsSync(path.join(t, 'osm-graph.twosm')));
if (!dir) {
  const root = path.resolve(cli.str('graph-root') || path.join(ROOT, 'data/osm/graph')), cur = path.join(root, 'current.json');
  if (!existsSync(cur)) { console.error(`✗ 找不到 ${cur}；先用 npm run osm:build 建圖，或用 --dir 指定圖的資料夾`); process.exit(1); }
  dir = path.join(root, JSON.parse(readFileSync(cur, 'utf8')).dir);
}
dir = path.resolve(dir); const gf = path.join(dir, 'osm-graph.twosm'), skip = new Set(String(cli.str('skip') || '').split(',').filter(Boolean));
const t0 = Date.now(), log = s => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
log(`讀取 ${gf}`);
const g = readGraph(gf), af = path.join(dir, 'osm-alt.bin');
let alt = null; if (existsSync(af)) { try { const h = readAltHead(af).head; if (!h.meta || h.meta.graphCreated === g.head.created) alt = altLoader(af); } catch { alt = null; } }
const R = new OsmRouter(g, { alt });
const rep = { graph: path.relative(ROOT, gf).split(path.sep).join('/'), dataTimestamp: g.header?.replication?.timestamp || null, auditedAt: new Date().toISOString() };
if (!skip.has('topology')) { log('① 拓樸、幾何、交叉'); rep.topology = auditTopology(g, R, { log }); }
if (!skip.has('connectivity')) { log('② 各運具連通性'); rep.connectivity = auditConnectivity(g, R, { log }); }
rep.conditional = auditConditional(g);
if (!skip.has('counties')) { log('③ 跨縣市可達性（真實路由）'); rep.counties = auditCounties(R, { log }); }
rep.seconds = +((Date.now() - t0) / 1000).toFixed(1);
writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(rep, null, 1));
const md = auditMarkdown(rep); writeFileSync(path.join(dir, 'audit.md'), md);
const rd = path.join(ROOT, 'docs/reports'); mkdirSync(rd, { recursive: true });
const tag = (rep.dataTimestamp || '').slice(0, 10).replace(/-/g, '') || path.basename(dir);
writeFileSync(path.join(rd, `osm-audit-${tag}.md`), md);
log(`✅ ${path.join(dir, 'audit.md')}、docs/reports/osm-audit-${tag}.md`);
