#!/usr/bin/env node
// transit-sync.mjs — 把 TDX 的公車／捷運靜態資料抓到本機快取，並印出資料品質報告。
//
//   node tools/transit-sync.mjs                  只抓到期的資料
//   node tools/transit-sync.mjs --force          全部重抓
//   node tools/transit-sync.mjs --offline        不連網，只用磁碟上已有的資料重建並印報告
//   選項：--city Taichung  --operators TMRT   （v1.16：--city all＝全台 22 縣市＋公路客運＋台灣好行；也可 --city Taipei,NewTaipei,InterCity）
//   v1.11：--rail TRA,THSR（台鐵、高鐵：車站、定期／當日時刻表、票價、即時誤點）  --extras（捷運站別時刻表、跨系統轉乘、共站、GIS 軌道線型）
//         全台建議：--city Taipei --operators TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT --rail TRA,THSR --extras（伺服器的 /api/v1/transit/plan 讀同一個快取）
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveToken } from './_tdx.mjs';
import { createTdxFetcher, createTransitData } from '../server/transit/snapshot.mjs';
import { dateStrOf } from '../server/transit/time.mjs';

// 參數：--key 值。值可以是「TRA,THSR」或被 PowerShell 拆開的「TRA THSR」（收集到下一個 -- 為止）；--key 後面沒有值 → 用預設值
const has = k => process.argv.includes('--' + k), arg = (k, d) => { const i = process.argv.indexOf('--' + k); if (i < 0) return d; const v = []; for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) v.push(process.argv[j]); const s = v.join(',').split(/[\s,]+/).filter(Boolean).join(','); return s || d; };
const tk = resolveToken(), dir = path.join(tk.cfg.cacheDir, 'transit');
const fetchJson = tk.getToken ? createTdxFetcher({ upstream: tk.cfg.tdx.upstream, getToken: tk.getToken, log: console.log }) : null;
const td = createTransitData({ dir, city: arg('city', 'Taichung'), operators: arg('operators', 'TMRT').split(',').filter(Boolean), rail: arg('rail', '').split(',').filter(Boolean), extras: has('extras'), fetchJson, log: console.log });
td.load();
if (!has('offline')) {
  if (!tk.getToken) { console.error('找不到 TDX token：在 .env 設 TDX_CLIENT_ID＋TDX_CLIENT_SECRET（TDX 會員中心的 API 金鑰），或設定 TOKEN_FILE、TDX_TOKEN_URL＋TDX_API_KEY（或加 --offline 只用現有快取）'); process.exit(2); }
  const t0 = Date.now(), r = await td.refresh({ force: has('force') });
  for (const x of r.report) console.log(`  ${({ updated: '↻ 已更新', unchanged: '＝ 沒變', fresh: '· 未到期', failed: x.optional ? '△ 抓不到（選用）' : '✗ 抓不到（必要）' })[x.action]}  ${x.name}${x.rows != null ? `（${x.rows} 筆）` : ''}${x.error ? ' — ' + x.error + (x.keptOld ? '；沿用舊資料' : '') : ''}`);
  console.log(`同步完成：${r.changed} 種資料有變動（${Date.now() - t0} ms）\n`);
}
const s = td.status();
if (!s.version) { console.log('目前沒有任何資料。'); process.exit(1); }
console.log(`資料版本 ${s.version}（建立 ${s.buildMs} ms；快取位置 ${dir}）`);
console.log(`站點 ${s.stats.stops}（公車 ${s.stats.busStops}、捷運 ${s.stats.metroStations}）；路線型態 ${s.stats.patterns}（公車 ${s.stats.busPatterns}、捷運 ${s.stats.metroPatterns}）`);
console.log(`班次 ${s.stats.trips}（其中 ${s.stats.estimatedTrips} 班的中途站時刻是用站間行駛時間推算）；完全沒有班次／班距資料的型態 ${s.stats.noServiceInfo}`);
const today = dateStrOf(Date.now()), v = td.store.day(today), by = {}; for (const i of v.info) by[i] = (by[i] || 0) + 1;
console.log(`今天（${today}）：${v.trips} 班；各型態資料來源 ${JSON.stringify(by)}（daily＝當日班表、schedule＝固定班表、frequency＝只有班距、none＝資訊不足、not-today＝班表註明今天不開）`);
for (const [op, r] of Object.entries(s.detail.rail || {})) console.log(`軌道 ${op}：${r.stops} 站、${r.patterns} 種停靠型態、${r.trips} 班（當日停駛 ${r.suspended}、部分停駛 ${r.partial}）${r.missing.length ? '；缺 ' + r.missing.join('、') : ''}`);
if (s.detail.crossTransfers) console.log(`跨系統轉乘（StationTransfer／TransferStations）：${s.detail.crossTransfers} 筆`);
for (const [op, m] of Object.entries(s.detail.metro || {})) console.log(`捷運 ${op}：${m.patterns} 個方向型態、${m.withFreq} 個有班距、站間時間推估的型態 ${m.runEstimatedPatterns}${m.missing.length ? '；缺 ' + m.missing.join('、') : ''}`);
if (s.warnings.length) { console.log(`\n資料警告（${s.warnings.length}）：`); for (const w of s.warnings.slice(0, 40)) console.log('  - ' + w); }
