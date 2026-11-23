#!/usr/bin/env node
// traffic-sync.mjs — 抓 TDX 道路事件（OAS「道路事件 v1」）到 CACHE_DIR/traffic/events.json，伺服器的 OSM 路線規劃會讀它（封閉道路避開、施工／壅塞加權、顯示改道原因）
//   node tools/traffic-sync.mjs                  即時事件（高速公路、省道、各縣市）＋預告性事件（省道、各縣市）
//   node tools/traffic-sync.mjs --live-only      只抓即時事件
//   選項：--cities Taipei,NewTaipei,…（預設：OAS 列出的全部縣市）
// 需要 TDX 金鑰（與 transit-sync 相同的來源：TOKEN_FILE、server_2 的 token.txt，或 .env 的 TDX_TOKEN_URL＋TDX_API_KEY）。建議用排程每 1～5 分鐘執行一次。
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { resolveToken } from './_tdx.mjs';
import { createTdxFetcher } from '../server/transit/snapshot.mjs';
import { normalizeWrapper } from '../server/traffic/events.mjs';

// 依 docs/oas/tdx-road-event-v1.json 的 City enum（即時事件比預告性事件多了 Kaohsiung）
const LIVE_CITIES = ['Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung', 'Keelung', 'MiaoliCounty', 'ChiayiCounty', 'Chiayi', 'PingtungCounty', 'YilanCounty', 'KinmenCounty'];
const PLAN_CITIES = ['Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Keelung', 'MiaoliCounty', 'ChiayiCounty', 'Chiayi', 'PingtungCounty', 'YilanCounty', 'KinmenCounty'];
// 參數：--key 值。值可以是「TRA,THSR」或被 PowerShell 拆開的「TRA THSR」（收集到下一個 -- 為止）；--key 後面沒有值 → 用預設值
const has = k => process.argv.includes('--' + k), arg = (k, d) => { const i = process.argv.indexOf('--' + k); if (i < 0) return d; const v = []; for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith('--'); j++) v.push(process.argv[j]); const s = v.join(',').split(/[\s,]+/).filter(Boolean).join(','); return s || d; };
const tk = resolveToken(); if (!tk.getToken) { console.error('找不到 TDX token：在 .env 設 TDX_CLIENT_ID＋TDX_CLIENT_SECRET（TDX 會員中心的 API 金鑰），或設定 TOKEN_FILE、TDX_TOKEN_URL＋TDX_API_KEY'); process.exit(2); }
const fetchJson = createTdxFetcher({ upstream: tk.cfg.tdx.upstream, getToken: tk.getToken, log: console.log }), want = arg('cities', '') ? arg('cities').split(',') : null;
const jobs = [['live', '/v1/Traffic/RoadEvent/LiveEvent/Freeway'], ['live', '/v1/Traffic/RoadEvent/LiveEvent/Highway'], ...LIVE_CITIES.filter(c => !want || want.includes(c)).map(c => ['live', `/v1/Traffic/RoadEvent/LiveEvent/City/${c}`])];
if (!has('live-only')) jobs.push(['planned', '/v1/Traffic/RoadEvent/Event/Highway'], ...PLAN_CITIES.filter(c => !want || want.includes(c)).map(c => ['planned', `/v1/Traffic/RoadEvent/Event/City/${c}`]));
const events = [], report = [];
for (const [kind, p] of jobs) {
  const r = await fetchJson(p + '?%24format=JSON');
  if (r.status !== 200 || !r.data) { report.push(`✗ ${p}：HTTP ${r.status}`); continue; }
  const list = normalizeWrapper(r.data, kind); events.push(...list); report.push(`✓ ${p}：${list.length} 筆（有座標 ${list.filter(e => e.geometry).length}）`);
}
const dir = path.join(tk.cfg.cacheDir, 'traffic'); mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'events.json'); writeFileSync(out + '.tmp', JSON.stringify({ fetchedAt: Date.now(), source: 'TDX 道路事件 v1', events })); renameSync(out + '.tmp', out);
console.log(report.join('\n')); console.log(`✅ ${events.length} 筆事件 → ${out}`);
