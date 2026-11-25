#!/usr/bin/env node
// places-sync.mjs — TDX 停車場與充電站（靜態）→ CACHE_DIR/places/places-static.json.gz（約 45 次呼叫；伺服器每 7 天也會自己更新）
//   npm run places:sync
// 即時剩餘車位、充電槍狀態不在這裡抓：使用者查看時由伺服器向 TDX 取（快取 3 分鐘）
import path from 'node:path';
import { resolveToken } from './_tdx.mjs';
import { createTdxFetcher } from '../server/transit/snapshot.mjs';
import { syncPlacesStatic } from '../server/places/tdx-places.mjs';
const tk = resolveToken();
if (!tk.getToken) { console.error('找不到 TDX token：在 .env 設 TDX_CLIENT_ID＋TDX_CLIENT_SECRET，或 TOKEN_FILE、TDX_TOKEN_URL＋TDX_API_KEY'); process.exit(2); }
const t0 = Date.now(), dir = path.join(tk.cfg.cacheDir, 'places');
const r = await syncPlacesStatic(createTdxFetcher({ upstream: tk.cfg.tdx.upstream, getToken: tk.getToken, log: console.log }), dir, { log: console.log });
console.log(`✅ 停車場 ${r.parking}、充電站 ${r.ev}、台北市停車場名稱 ${r.taipei} → ${dir}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
