#!/usr/bin/env node
// pack-graph.mjs — 把 nodes.json／edges.json／roads.json 轉成路網封包 graph.bin（放在同一個資料夾）
//
//   node tools/pack-graph.mjs                 預設 data/graph/
//   node tools/pack-graph.mjs 路網資料夾
//
// 什麼時候需要：網頁放在「一般靜態主機」（沒有跑台灣通伺服器）時。用台灣通伺服器（或掛在 server_2）時不用跑，伺服器會自動產生並快取。
// 注意：JSON 更新後要重新執行，否則網頁會載入舊的封包。
import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants as Z } from 'node:zlib';
import path from 'node:path';
import { ROOT } from '../server/config.mjs';

globalThis.document ??= { getElementById: () => null };                // 建圖程式在瀏覽器與 Node 共用；這裡不碰畫面
const dir = path.resolve(process.argv[2] || path.join(ROOT, 'data/graph')), f = n => path.join(dir, n + '.json');
if (!existsSync(f('nodes')) || !existsSync(f('edges'))) { console.error(`找不到 ${f('nodes')} 或 ${f('edges')}`); process.exit(2); }
const { buildGraphCore } = await import('../js/graph-build.js'), { encodePack, applyPack } = await import('../js/graph-pack.js'), { State } = await import('../js/state.js');
const log = console.log; console.info = console.warn = () => {};
const t0 = Date.now(), src = ['nodes', 'edges', 'roads'].filter(n => existsSync(f(n))).map(n => `${n}.json:${statSync(f(n)).size}:${Math.floor(statSync(f(n)).mtimeMs)}`).join('|');
let buf; buildGraphCore({ nodes: JSON.parse(readFileSync(f('nodes'), 'utf8')), edges: JSON.parse(readFileSync(f('edges'), 'utf8')), roads: existsSync(f('roads')) ? JSON.parse(readFileSync(f('roads'), 'utf8')) : [] }, () => { buf = encodePack({ source: src }); });
const N = State.N, E = State.E, out = path.join(dir, 'graph.bin'); writeFileSync(out + '.tmp', buf); renameSync(out + '.tmp', out);
applyPack(buf); if (State.N !== N || State.E !== E) { console.error('驗證失敗：封包讀回的節點／邊數不一致'); process.exit(1); }
const json = ['nodes', 'edges', 'roads'].filter(n => existsSync(f(n))).reduce((s, n) => s + statSync(f(n)).size, 0), mb = n => (n / 1048576).toFixed(2) + ' MB';
log(`✅ ${out}`);
log(`   ${N.toLocaleString()} 節點、${E.toLocaleString()} 邊（${Date.now() - t0} ms）`);
log(`   大小：JSON 三檔 ${mb(json)} → 封包 ${mb(buf.length)}（gzip ${mb(gzipSync(buf).length)}、brotli ${mb(brotliCompressSync(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 6 } }).length)}）`);
log('   網頁會優先載入 graph.bin；JSON 更新後請重新執行本指令。');
