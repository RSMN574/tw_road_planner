#!/usr/bin/env node
// server.mjs — 台灣通 MaaS 伺服器（零依賴，Node ≥ 18）
// 一支程式同時提供：① 網頁（dist/，打開網址就能用）② API（/api/v1/*：全台 OSM 路線、大眾運輸、店家地點、即時路況）③ TDX 代理（/tdx/api/*）
// v1.18：舊的台中路網（engine.mjs）與 /api/v1/route|transit|multimodal|geocode|reverse|nearby-roads 已移除（回 410，訊息指向新的 API）
// 啟動：npm start（會先打包 dist/）；設定見 .env.example
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, watch } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadDotEnv, readConfig } from './config.mjs';
import { ApiError, Lru, clientIp, deduper, fail, ok, params, rateLimiter, rid, sendJson } from './http-util.mjs';
import { createStatic } from './static.mjs';
import { createTdxProxy } from './tdx-proxy.mjs';
import { createBackend } from './backend.mjs';
import zlib from 'node:zlib';

// TDX token 從哪裡來：opts.getToken（外部提供，例如掛在 server_2 時讀它的 token.txt）＞ TDX_TOKEN_URL＋TDX_API_KEY
export function tdxSource(cfg, opts = {}) {
  if (opts.getToken) return opts.tokenSource || 'external';
  return cfg.tdx.tokenUrl && cfg.tdx.apiKey ? 'token-url' : null;
}

export function createApp(cfg, opts = {}) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const src = tdxSource(cfg, opts), tdx = createTdxProxy({ ...cfg.tdx, getToken: opts.getToken || null });
  const stat = createStatic(cfg), cache = new Lru(300, 10 * 60e3), dedupe = deduper();
  const engine = opts.backend || createBackend(cfg);                                  // 路線計算：主執行緒（WORKERS=0）或背景執行緒（見 backend.mjs）
  const limitApi = rateLimiter(cfg.rateLimit), limitTdx = rateLimiter(cfg.tdxRateLimit), limitTile = rateLimiter(cfg.rateLimit ? cfg.rateLimit * 20 : 0), started = Date.now(), counters = { requests: 0, cacheHits: 0, errors: 0 };
  const tiles = new Lru(600, 24 * 3600e3);                                        // OSM 地圖圖磚（壓縮前的 JSON）

  // 相同參數＋相同 OSM 圖版本 → 直接回快取（重建圖後自動失效）；同時進來的相同請求共用一次計算
  // 路線的出發時間：沒給或 now → 換成 5 分鐘一格的時間（時段條件的轉向限制會依時間不同；快取鍵要含時間）
  const slot = q => (q.depart === undefined || q.depart === '' || q.depart === 'now' ? { ...q, depart: String(Math.floor(Date.now() / 300e3) * 300e3) } : q);
  const osmVer = () => (engine.osmInfo ? engine.osmInfo().version || '' : '');
  let liveFn = null, liveTried = false;
  const placesLive = async () => { if (liveFn || liveTried) return liveFn; liveTried = true; try { const { resolveToken } = await import('../tools/_tdx.mjs'), tk = opts.placesFetch ? { getToken: true } : resolveToken(); if (!tk.getToken) return null;
    const { createLive } = await import('./places/tdx-places.mjs'), fetchJson = opts.placesFetch || (await import('./transit/snapshot.mjs')).createTdxFetcher({ upstream: cfg.tdx.upstream, getToken: tk.getToken });
    liveFn = createLive({ fetchJson, ttlMs: cfg.placesLiveTtlS * 1000 }); } catch { liveFn = null; } return liveFn; };
  const osmCall = async (name, q, fn) => {
    const key = 'osm:' + name + '|' + osmVer() + '|' + JSON.stringify(Object.keys(q).sort().map(k => [k, q[k]]));
    const hit = cache.get(key); if (hit) { counters.cacheHits++; return { data: hit, cached: true }; }
    const data = await dedupe(key, () => fn(q)); cache.set(key, data); return { data, cached: false };
  };
  const API = {
    'GET /api/v1/health': () => ({ data: health() }),
    'GET /api/v1/osm/info': () => ({ data: engine.osmInfo ? engine.osmInfo() : { loaded: false } }),
    'GET /api/v1/osm/route': q => osmCall('route', slot(q), engine.osmRoute), 'POST /api/v1/osm/route': q => osmCall('route', slot(q), engine.osmRoute),
    'GET /api/v1/osm/nearest': q => osmCall('nearest', q, engine.osmNearest),
    // v1.11 全台多運具大眾運輸（台鐵、高鐵、捷運、輕軌、公車；RAPTOR）：出發時間沒給＝現在（換成 1 分鐘一格，快取鍵才正確）
    'GET /api/v1/transit/plan': q => osmCall('transitPlan', q.depart === undefined || q.depart === '' || q.depart === 'now' ? { ...q, depart: String(Math.floor(Date.now() / 60e3) * 60e3) } : q, engine.osmTransitPlan),
    'GET /api/v1/transit/status': () => engine.osmTransitStatus().then(d => ({ data: d })),
    // v1.13 店家地點（OSM POI）：搜尋、附近、單一地點、類別
    'GET /api/v1/poi/search': q => osmCall('poiSearch', { ...q, at: String(Math.floor(Date.now() / 60e3) * 60e3) }, engine.osmPoiSearch),
    'GET /api/v1/poi/nearby': q => osmCall('poiNearby', { ...q, _t: String(Math.floor(Date.now() / 60e3)) }, engine.osmPoiNearby),
    'GET /api/v1/poi/detail': q => osmCall('poiDetail', { ...q, _t: String(Math.floor(Date.now() / 60e3)) }, engine.osmPoiDetail),
    // v1.17 停車場剩餘車位、充電槍狀態（TDX，查看時才抓，快取 PLACES_LIVE_TTL_S 秒）：ids＝p:縣市:代碼,e:縣市:代碼
    'GET /api/v1/poi/live': async q => { const ids = String(q.ids || '').split(',').map(s => s.trim()).filter(Boolean); if (!ids.length) throw new ApiError(400, 'MISSING_PARAM', '需要 ids（p:縣市:代碼 或 e:縣市:代碼，逗號分隔）');
      const live = await placesLive(); if (!live) return { data: { available: false, items: {}, note: '伺服器沒有 TDX 金鑰，無法取得即時剩餘車位與充電槍狀態' } };
      return { data: { available: true, items: await live(ids), ttlS: cfg.placesLiveTtlS, source: '交通部 TDX 停車資訊、綠色運輸-充電樁' } }; },
    'GET /api/v1/poi/categories': q => osmCall('poiCategories', q, engine.osmPoiCategories),
    // v1.11 道路事件（TDX）：列表＋對應到路網的結果；路線 API 預設會避開封閉、加權施工／壅塞（events=0 關閉）
    // v1.15 即時路況（TDX 路況資訊 v2）：bbox＝地圖圖層；沒有 bbox＝狀態與統計。快取 1 分鐘
    'GET /api/v1/traffic/flow': q => osmCall('trafficFlow', { ...q, _t: String(Math.floor(Date.now() / 60e3)) }, engine.osmTrafficFlow),
    'GET /api/v1/traffic/events': q => engine.osmTrafficEvents(q).then(d => ({ data: d })),
    'GET /api/v1/osm/search': q => osmCall('search', q, engine.osmSearch),
    'POST /api/v1/admin/reload': (q, req) => {
      if (!cfg.adminToken || req.headers.authorization !== 'Bearer ' + cfg.adminToken) throw new ApiError(401, 'UNAUTHORIZED', '需要 ADMIN_TOKEN');
      return engine.osmLoad(cfg).catch(e => ({ loaded: false, error: e.message })).then(o => { cache.clear(); tiles.clear(); return { data: { reloaded: true, osm: o } }; });
    }
  };
  // v1.18 已移除的舊路網 API：回 410 並指出新的 API（舊的整合不會默默拿到 404）
  const GONE = { '/api/v1/route': '/api/v1/osm/route', '/api/v1/transit': '/api/v1/transit/plan', '/api/v1/multimodal': '/api/v1/transit/plan', '/api/v1/geocode': '/api/v1/osm/search 或 /api/v1/poi/search', '/api/v1/reverse': '/api/v1/osm/nearest', '/api/v1/nearby-roads': '/api/v1/osm/nearest', '/api/v1/traffic': '/api/v1/traffic/flow 與 /api/v1/traffic/events' };
  for (const [g, to] of Object.entries(GONE)) for (const m of ['GET', 'POST']) API[`${m} ${g}`] = () => { throw new ApiError(410, 'GONE', `${g} 已在 v1.18 移除（舊的台中路網），請改用 ${to}`); };
  function health() {
    const o = engine.osmInfo ? engine.osmInfo() : { loaded: false };
    return { status: o.loaded ? 'ok' : 'loading', version: pkg.version, uptimeS: Math.round((Date.now() - started) / 1000),
      osm: o,
      tdx: { configured: tdx.configured, source: src, proxyBase: 'tdx' }, traffic: { pollMin: cfg.traffic ? cfg.traffic.pollMin : 0 }, compute: engine.stats(),
      cache: { entries: cache.size, hits: counters.cacheHits, sharedInflight: dedupe.shared, static: stat.stats(), tdx: tdx.stats } };
  }
  const corsHeaders = req => {
    const o = req.headers.origin; if (!o || !cfg.corsOrigins.length) return {};
    if (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(o)) return { 'Access-Control-Allow-Origin': cfg.corsOrigins.includes('*') ? '*' : o, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Max-Age': '600' };
    return {};
  };
  const security = (req) => {
    const h = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()' };
    if (cfg.tls || (cfg.trustProxy && req.headers['x-forwarded-proto'] === 'https')) h['Strict-Transport-Security'] = 'max-age=15552000';
    return h;
  };

  const handler = async function (req, res) {
    const t0 = process.hrtime.bigint(), id = rid(), ip = clientIp(req, cfg.trustProxy); counters.requests++;
    for (const [k, v] of Object.entries({ ...security(req), ...corsHeaders(req), 'X-Request-Id': id })) res.setHeader(k, v);
    res.on('finish', () => { if (cfg.log) console.log(`${new Date().toISOString()} ${ip} ${req.method} ${req.url.slice(0, 160)} ${res.statusCode} ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}ms`); });
    let url; try { url = new URL('http://x' + (req.url.startsWith('/') ? req.url : '/' + req.url)); } catch { return fail(res, new ApiError(400, 'BAD_URL', '網址格式錯誤'), { requestId: id }); }
    const p = url.pathname;
    if (/(^|\/)\.\.(\/|$)|%2e%2e|%2f%2e|\\/i.test(req.url.split('?')[0])) return fail(res, new ApiError(400, 'BAD_PATH', '不合法的路徑'), { requestId: id });   // 路徑穿越一律拒絕（不論後面接什麼）
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      // ---- OSM 地圖圖磚：/api/v1/osm/tiles/{z}/{x}/{y}.json（瀏覽器可快取；版本改了 ETag 就變）----
      // v1.11：建築 /api/v1/osm/buildings/{z}/{x}/{y}.json（同樣的快取方式；z 是 512 像素圖磚的層級，≥ 15）
      const tm0 = /^\/api\/v1\/osm\/(tiles|buildings)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})\.json$/.exec(p), bld = !!tm0 && tm0[1] === 'buildings', tm = tm0 && [tm0[0], tm0[2], tm0[3], tm0[4]];
      if (tm) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '圖磚只接受 GET');
        limitTile(ip);
        const bv = bld && engine.osmInfo && engine.osmInfo().buildings ? engine.osmInfo().buildings.version || '' : '';
        const ver = osmVer() + (bld ? '|b' + bv : ''), etag = `"${bld ? 'b' : 't'}${Buffer.from(ver).toString('base64url').slice(-16)}-${tm[1]}-${tm[2]}-${tm[3]}"`, key = (bld ? 'b|' : '') + ver + '|' + tm[1] + '/' + tm[2] + '/' + tm[3];
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=86400' }); return res.end(); }
        let t = tiles.get(key);
        if (!t) { const raw = Buffer.from(JSON.stringify(await dedupe('tile|' + key, () => (bld ? engine.osmBuildingTile : engine.osmTile)({ z: tm[1], x: tm[2], y: tm[3] })))); t = { raw }; tiles.set(key, t); }
        // 壓縮後的版本也快取（同一張圖磚很多人看）
        const ae = String(req.headers['accept-encoding'] || ''), enc = t.raw.length <= 1024 ? null : /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
        if (enc && !t[enc]) t[enc] = enc === 'br' ? zlib.brotliCompressSync(t.raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }) : zlib.gzipSync(t.raw, { level: 6 });
        const body = enc ? t[enc] : t.raw;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ETag: etag, Vary: 'Accept-Encoding', 'Content-Length': body.length, ...(enc ? { 'Content-Encoding': enc } : {}) });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      // ---- API ----
      if (p.startsWith('/api/')) {
        const h = API[`${req.method === 'HEAD' ? 'GET' : req.method} ${p.replace(/\/+$/, '')}`];
        if (!h) { const any = Object.keys(API).some(k => k.endsWith(' ' + p.replace(/\/+$/, ''))); throw any ? new ApiError(405, 'METHOD_NOT_ALLOWED', `${p} 不支援 ${req.method}`) : new ApiError(404, 'NOT_FOUND', `沒有這個 API：${p}`); }
        if (!p.endsWith('/health')) limitApi(ip);
        const ms0 = Date.now(), q = await params(req, url), r = await h(q, req);
        return ok(res, r.data, { requestId: id, ms: Date.now() - ms0, cached: !!r.cached, osmVersion: osmVer() });
      }
      // ---- TDX 代理 ----
      if (p.startsWith('/tdx/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'TDX 代理只接受 GET');
        limitTdx(ip);
        try { const r = await tdx.handle(req.url.slice('/tdx/api'.length)); res.writeHead(r.status, { 'Content-Type': r.type, 'Cache-Control': 'no-store', 'X-Cache': r.cached ? 'HIT' : 'MISS' }); return res.end(req.method === 'HEAD' ? undefined : r.body); }
        catch (e) { throw new ApiError(e.status || 502, e.code || 'UPSTREAM_ERROR', e.message); }
      }
      // ---- 靜態檔 ----
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '只接受 GET');
      if (await stat.serve(req, res, p)) return;
      if (p === '/' && await stat.serve(req, res, '/index.html')) return;
      throw new ApiError(404, 'NOT_FOUND', '找不到檔案');
    } catch (e) {
      counters.errors++;
      if (res.headersSent) { res.destroy(); return; }
      if (!p.startsWith('/api/') && !p.startsWith('/tdx/') && e instanceof ApiError && e.status === 404) return sendJson(res, 404, { error: 'Not found' });   // 與原 server_2 相同的 404 格式
      return fail(res, e, { requestId: id });
    }
  };
  handler.stat = stat; handler.tdx = tdx; handler.cache = cache; handler.tiles = tiles; handler.backend = engine;
  return handler;
}

export async function start(cfg = readConfig({ WORKERS: '1', ...process.env })) {
  if (!existsSync(cfg.staticDir + '/index.html')) console.warn(`⚠ ${cfg.staticDir}/index.html 不存在：請先執行 npm run build（或用 npm start）`);
  const handler = createApp(cfg), be = handler.backend;
  // 全台 OSM 道路圖：在背景載入，不擋伺服器啟動
  if (cfg.osm && cfg.osm.enabled && be.osmLoad) be.osmLoad(cfg).then(async o => {
    if (!o.loaded) { console.log(`   OSM 道路圖：${o.reason || '未載入'}`); return; }
    console.log(`✅ OSM 道路圖：${o.vertices.toLocaleString()} 頂點、${o.edges.toLocaleString()} 邊（資料時間 ${o.dataTimestamp || '—'}），${o.loadMs} ms${o.alt ? `；長距離加速（ALT）：${o.alt.join('、')}` : '；沒有地標表（長距離較慢）'}`);
    if (cfg.osm.warm.length) { const ms = await be.osmWarmup(cfg.osm.warm); console.log(`   OSM 預熱（${cfg.osm.warm.join('、')}）：${ms} ms`); }
  }).catch(e => console.error('❌ OSM 道路圖載入失敗：' + e.message));
  const server = cfg.tls ? https.createServer({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, handler) : http.createServer(handler);
  server.requestTimeout = 60000; server.headersTimeout = 20000; server.keepAliveTimeout = 5000;
  await new Promise(r => server.listen(cfg.port, cfg.host, r));
  const addr = server.address(), shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log(`🚀 ${cfg.tls ? 'https' : 'http'}://${shown}:${addr.port}/   （API：/api/v1/health；TDX 代理：${tdxSource(cfg) ? '已設定' : '未設定'}）`);
  if (!cfg.tls) console.log('   ℹ 手機 GPS 需要 HTTPS：正式環境請放在 Caddy／Nginx 後面（見 deploy/），或設定 TLS_CERT、TLS_KEY');
  if (cfg.watch) { let tm = null; try { watch(cfg.dataDir, { recursive: true }, () => { clearTimeout(tm); tm = setTimeout(() => { be.osmReloadIfChanged().catch(() => false).then(co => { if (co) { handler.cache.clear(); handler.tiles.clear(); console.log('🔄 OSM 道路圖已更新，重新載入'); } }).catch(e => console.error('重新載入失敗：', e.message)); }, 2000); }); } catch (e) { console.warn('無法監看資料夾：', e.message); } }
  // v1.15 即時路況定時更新（主執行緒只抓資料寫檔；各執行緒看到檔案變了會自己重新讀）
  if (cfg.transitSyncHours > 0 && cfg.osm && cfg.osm.enabled) startTransitSync(cfg);
  if (cfg.osm && cfg.osm.enabled) startPlacesSync(cfg);
  if (cfg.traffic && cfg.traffic.pollMin > 0) startFlowPoller(cfg).catch(e => console.warn('   即時路況更新未啟動：' + e.message));
  const stop = sig => { console.log(`收到 ${sig}，關閉中…`); server.close(() => be.close().finally(() => process.exit(0))); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { loadDotEnv(); start(readConfig({ WORKERS: '1', ...process.env })); }   // 獨立執行：預設 1 個背景計算執行緒（WORKERS=0 改回主執行緒）

// ---------- 即時路況定時更新（v1.15）----------
async function startFlowPoller(cfg) {
  const { resolveToken } = await import('../tools/_tdx.mjs'), { createTdxFetcher } = await import('./transit/snapshot.mjs'), F = await import('./traffic/flow-sync.mjs');
  const tk = resolveToken(); if (!tk.getToken) { console.log('   即時路況：沒有 TDX 金鑰，不自動更新（npm run traffic:flow 可手動抓）'); return; }
  const fetchJson = createTdxFetcher({ upstream: cfg.tdx.upstream, getToken: tk.getToken }), dir = path.join(cfg.cacheDir, 'traffic');
  let busy = false;
  const tick = async () => {
    if (busy) return; busy = true;
    try {
      if (F.staticAgeMs(dir) > F.STATIC_MAX_AGE_MS) { const r = await F.syncStatic(fetchJson, dir); console.log(`   即時路況：靜態路段已更新（${r.authorities} 個機關）`); }
      const l = await F.syncLive(fetchJson, dir); if (cfg.log) console.log(`   即時路況：${l.sections} 個路段（${new Date().toLocaleTimeString('zh-TW', { hour12: false })}）`);
    } catch (e) { console.warn('   即時路況更新失敗：' + e.message); } finally { busy = false; }
  };
  console.log(`   即時路況：每 ${cfg.traffic.pollMin} 分鐘向 TDX 更新（TRAFFIC_POLL_MIN）`);
  setTimeout(tick, 5000).unref(); setInterval(tick, cfg.traffic.pollMin * 60e3).unref();
}

// ---------- 大眾運輸資料定時同步（v1.16）：用子行程跑 tools/transit-sync.mjs（全台公車建資料要 1.5 GB 記憶體，不放在主行程）----------
function startTransitSync(cfg) {
  const T = cfg.transit, args = [fileURLToPath(new URL('../tools/transit-sync.mjs', import.meta.url)), '--city', String(T.city || ''), '--operators', T.metro.join(','), '--rail', T.rail.join(','), '--extras'];
  let busy = false;
  const run = async () => {
    if (busy) return; busy = true;
    try {
      const { resolveToken } = await import('../tools/_tdx.mjs'); if (!resolveToken().getToken) return;
      const { spawn } = await import('node:child_process'), t0 = Date.now();
      await new Promise(res => { const p = spawn(process.execPath, ['--max-old-space-size=6144', ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
        p.on('close', code => { const m = /同步完成：(\d+) 種資料有變動/.exec(out); console.log(`   大眾運輸同步：${code === 0 ? (m ? m[1] + ' 種資料有變動' : '完成') : '失敗（代碼 ' + code + '）'}，${Math.round((Date.now() - t0) / 1000)} 秒`); res(); }); });
    } catch (e) { console.warn('   大眾運輸同步失敗：' + e.message); } finally { busy = false; }
  };
  console.log(`   大眾運輸：每 ${cfg.transitSyncHours} 小時自動同步到期的資料（TRANSIT_SYNC_HOURS）`);
  setTimeout(run, 60e3).unref(); setInterval(run, cfg.transitSyncHours * 3600e3).unref();
}

// ---------- 停車場與充電站靜態資料（v1.17）：超過 7 天就重抓（約 45 次呼叫）----------
function startPlacesSync(cfg) {
  const run = async () => {
    try {
      const P = await import('./places/tdx-places.mjs'), dir = path.join(cfg.cacheDir, 'places'); if (P.placesAgeMs(dir) < P.STATIC_MAX_AGE_MS) return;
      const { resolveToken } = await import('../tools/_tdx.mjs'), tk = resolveToken(); if (!tk.getToken) return;
      const { createTdxFetcher } = await import('./transit/snapshot.mjs'), r = await P.syncPlacesStatic(createTdxFetcher({ upstream: cfg.tdx.upstream, getToken: tk.getToken }), dir);
      console.log(`   停車場與充電站：已更新（停車場 ${r.parking}、充電站 ${r.ev}）`);
    } catch (e) { console.warn('   停車場與充電站更新失敗：' + e.message); }
  };
  setTimeout(run, 90e3).unref(); setInterval(run, 12 * 3600e3).unref();
}
