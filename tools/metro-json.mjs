#!/usr/bin/env node
// metro-json.mjs — 用 transit-sync 抓到的 TDX 捷運資料產生 data/metro.json（網頁與伺服器都讀這個檔）
//
//   node tools/metro-json.mjs                       依 transit-sync 快取產生（預設業者 TMRT）
//   node tools/metro-json.mjs --check               只檢查、印報告，不寫檔
//   node tools/metro-json.mjs --s2s s2s.json        某種資料改用你手動下載的 TDX JSON（例如 transit-sync 遇到 429 限流時）
//       可用：--station --stationOfLine --stationOfRoute --s2s --frequency --firstLast --lineTransfer --stationExit --odFare
//   選項：--operators TMRT,TRTC   --out data/metro.json
// 寫入前會把舊檔備份成 metro.json.bak；寫完請重新載入（WATCH_DATA=1 會自動；或 POST /api/v1/admin/reload；或重啟伺服器）。
import path from 'node:path';
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'node:fs';
import { loadDotEnv, readConfig } from '../server/config.mjs';
import { buildMetroJson, readMetroRaw, METRO_KEYS } from '../server/transit/metro-json.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; }, has = k => process.argv.includes('--' + k);
loadDotEnv(); const cfg = readConfig(), dir = path.join(cfg.cacheDir, 'transit'), ops = arg('operators', 'TMRT').split(',').filter(Boolean), out = path.resolve(arg('out', cfg.files.metro));
const { raw, fetchedAt } = readMetroRaw(dir, ops);
for (const [k] of METRO_KEYS) { const f = arg(k); if (!f) continue;                              // 手動提供的檔案（TDX 原樣 JSON：陣列，或 { data: [...] }）
  const j = JSON.parse(readFileSync(f, 'utf8')), rows = Array.isArray(j) ? j : (j.data ?? j.Data);
  if (!Array.isArray(rows)) { console.error(`✗ ${f} 不是 TDX 的 JSON 陣列`); process.exit(2); }
  raw[k] = rows; fetchedAt[k] = null; console.log(`  使用手動檔案 ${k}：${f}（${rows.length} 筆）`); }

let json; try { json = buildMetroJson(raw, { operator: ops.join(','), fetchedAt }); } catch (e) { console.error('✗ ' + e.message + `（快取位置 ${dir}）`); process.exit(1); }
// 用網頁同一套程式檢查：站序、站間時間、票價都讀得懂
await import('../js/main.js').catch(() => {}); const { metroToGraph } = await import('../js/transit.js');
const g = metroToGraph(json), nF = g.meta.fares ? Object.keys(g.meta.fares).length : 0;
console.log(`捷運 ${ops.join('、')}：${Object.keys(g.nodes).length} 站；${g.lines.map(l => `${l.line} ${l.stations.length} 站`).join('、')}`);
console.log(`  站序：${g.meta.order}｜行駛時間：${g.meta.runSrc}｜班距：${json.Frequency ? 'TDX Frequency' : '沒有（候車時間推估）'}｜首末班：${json.FirstLastTimetable ? 'TDX' : '沒有'}｜票價：${nF ? `TDX ODFare ${nF} 組起訖` : '沒有'}`);
if (json.meta.missing.length) console.log(`  缺少：${json.meta.missing.join('、')}（對應部分標示「推估」）`);
if (g.meta.lone.length) console.log(`  ⚠ ${g.meta.lone.length} 站沒有連線：${g.meta.lone.slice(0, 8).join('、')}`);
if (has('check')) process.exit(0);
const body = JSON.stringify(json);
const strip = t => { try { const j = JSON.parse(t); if (j && j.meta) delete j.meta.generatedAt; return JSON.stringify(j); } catch { return t; } };
if (existsSync(out)) { const old = readFileSync(out, 'utf8'); if (strip(old) === strip(body)) { console.log(`沒有變動：${out}`); process.exit(0); } copyFileSync(out, out + '.bak'); console.log(`  舊檔備份：${out}.bak`); }
writeFileSync(out + '.tmp', body); renameSync(out + '.tmp', out);
console.log(`✅ 已寫入 ${out}（${(body.length / 1024).toFixed(0)} KB）。重新載入：WATCH_DATA=1 會自動；或 POST /api/v1/admin/reload；或重啟伺服器（server_2：pm2 restart index）`);
