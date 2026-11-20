#!/usr/bin/env node
// osm-alt.mjs — 只建（或重建）地標表 osm-alt.bin（ALT：全台長距離路線加速），不重建道路圖
// 用法：npm run osm:alt                       （data/osm/graph/current.json 指向的那一份）
//       npm run osm:alt -- --dir data/osm/graph/20261117
//       npm run osm:alt -- --profile car,moto   （只建這幾種運具；其餘照舊保留在檔案裡的不會保留——檔案整個重寫）
// 用途：osm-build 用 --no-alt 先建圖（機器較慢或記憶體較小時分兩步）、或時間模型參數改了（MODEL_KEY 不同，舊表會自動停用）
// 伺服器會偵測到新的地標表並自動重新載入（或用 POST /api/v1/admin/reload）
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGraph } from '../../server/osm/graph-file.mjs';
import { OsmRouter, MODEL_KEY } from '../../server/osm/router.mjs';
import { buildAlt, writeAlt } from '../../server/osm/alt.mjs';
import { PROFILES } from '../../server/osm/access.mjs';
import { parseCli } from './cli.mjs';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), cli = parseCli(['dir', 'graph-root', 'profile']);
let dir = cli.str('dir') || cli.tokens.find(t => existsSync(path.join(t, 'osm-graph.twosm')));
if (!dir) {
  const root = path.resolve(cli.str('graph-root') || path.join(ROOT, 'data/osm/graph')), cur = path.join(root, 'current.json');
  if (!existsSync(cur)) { console.error(`✗ 找不到 ${cur}；先用 npm run osm:build 建圖，或用 --dir 指定圖的資料夾`); process.exit(1); }
  dir = path.join(root, JSON.parse(readFileSync(cur, 'utf8')).dir);
}
dir = path.resolve(dir); const gf = path.join(dir, 'osm-graph.twosm');
if (!existsSync(gf)) { console.error(`✗ 找不到 ${gf}`); process.exit(1); }
const want = (cli.str('profile') || cli.tokens.filter(t => PROFILES.some(p => p.key === t)).join(',') || PROFILES.map(p => p.key).join(',')).split(/[\s,]+/).filter(Boolean);
const bad = want.filter(k => !PROFILES.some(p => p.key === k)); if (bad.length) { console.error(`✗ 不認得的運具：${bad.join('、')}（可用：${PROFILES.map(p => p.key).join('、')}）`); process.exit(1); }
const t0 = Date.now(); console.log(`讀取 ${gf}…`);
const g = readGraph(gf), R = new OsmRouter(g), tables = {}, model = createHash('md5').update(MODEL_KEY).digest('hex').slice(0, 10);   // 時間模型參數的指紋（短）
console.log(`地標表（ALT，時間模型 ${model}）：${want.join('、')}`);
for (const k of want) tables[k] = buildAlt(R, k, { log: console.log });
const af = path.join(dir, 'osm-alt.bin'), aw = writeAlt(af, tables, { graphCreated: g.head.created });
// manifest 一併更新
const mf = path.join(dir, 'manifest.json');
if (existsSync(mf)) { try { const m = JSON.parse(readFileSync(mf, 'utf8')); m.alt = { file: 'osm-alt.bin', bytes: aw.bytes, seconds: (Date.now() - t0) / 1000, model, profiles: Object.fromEntries(Object.entries(tables).filter(([, t]) => t).map(([k, t]) => [k, { landmarks: t.k, unitS: t.unit }])) }; writeFileSync(mf, JSON.stringify(m, null, 2)); } catch (e) { console.warn('⚠ 無法更新 manifest.json：' + e.message); } }
console.log(`✅ ${af}：${(aw.bytes / 1048576).toFixed(1)} MB，${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
