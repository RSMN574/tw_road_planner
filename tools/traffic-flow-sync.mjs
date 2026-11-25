#!/usr/bin/env node
// traffic-flow-sync.mjs — TDX 即時路況（路況資訊 v2）→ CACHE_DIR/traffic/flow-*.json.gz
//   npm run traffic:flow                 即時路況（靜態路段資料沒有或超過 7 天時會先抓靜態）
//   npm run traffic:flow -- --static     強制重抓靜態路段、線形、壅塞水準表
//   選項：--authorities Freeway,Highway,City/Taipei
// 伺服器設定 TRAFFIC_POLL_MIN（預設 5；0＝關閉）時會自己定時更新，不必另外排程。
import path from 'node:path';
import { resolveToken } from './_tdx.mjs';
import { createTdxFetcher } from '../server/transit/snapshot.mjs';
import { syncLive, syncStatic, staticAgeMs, STATIC_MAX_AGE_MS } from '../server/traffic/flow-sync.mjs';
import { FLOW_AUTHORITIES } from '../server/traffic/flow.mjs';
import { parseCli } from './osm/cli.mjs';

const cli = parseCli(['authorities']), tk = resolveToken();
if (!tk.getToken) { console.error('找不到 TDX token：在 .env 設 TDX_CLIENT_ID＋TDX_CLIENT_SECRET，或 TOKEN_FILE、TDX_TOKEN_URL＋TDX_API_KEY'); process.exit(2); }
const fetchJson = createTdxFetcher({ upstream: tk.cfg.tdx.upstream, getToken: tk.getToken, log: console.log }), dir = path.join(tk.cfg.cacheDir, 'traffic');
const auth = cli.str('authorities') ? cli.str('authorities').split(',').map(s => s.trim()).filter(Boolean) : FLOW_AUTHORITIES;
const t0 = Date.now();
if (cli.on('static') || staticAgeMs(dir) > STATIC_MAX_AGE_MS) { console.log('靜態路段資料（路段、線形、壅塞水準表）…'); const s = await syncStatic(fetchJson, dir, { authorities: auth, log: console.log }); console.log(`  ${s.authorities} 個機關`); }
console.log('即時路況…'); const l = await syncLive(fetchJson, dir, { authorities: auth });
console.log(l.report.join('\n')); console.log(`✅ ${l.sections} 個路段的即時路況 → ${dir}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
