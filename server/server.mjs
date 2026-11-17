#!/usr/bin/env node
// server.mjs — 台灣通 MaaS 伺服器（零依賴，Node ≥ 18）
// 一支程式同時提供：① 網頁（dist/，打開網址就能用）② 路網資料（data/，gzip＋ETag）③ API（/api/v1/*）④ TDX 代理（/tdx/api/*）
// 啟動：npm start（會先打包 dist/）；設定見 .env.example
import http from 'node:http';
import https from 'node:https';
import { readFileSync, existsSync, watch } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { loadDotEnv, readConfig } from './config.mjs';
import { ApiError, Lru, clientIp, deduper, fail, ok, params, rateLimiter, rid, sendJson } from './http-util.mjs';
import { createStatic } from './static.mjs';
import { createTdxProxy } from './tdx-proxy.mjs';
import * as engine from './engine.mjs';

// TDX token 從哪裡來：opts.getToken（外部提供，例如掛在 server_2 時讀它的 token.txt）＞ TDX_TOKEN_URL＋TDX_API_KEY
export function tdxSource(cfg, opts = {}) {
  if (opts.getToken) return opts.tokenSource || 'external';
  return cfg.tdx.tokenUrl && cfg.tdx.apiKey ? 'token-url' : null;
}

export function createApp(cfg, opts = {}) {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const src = tdxSource(cfg, opts), tdx = createTdxProxy({ ...cfg.tdx, getToken: opts.getToken || null });
  const stat = createStatic(cfg), cache = new Lru(300, 10 * 60e3), dedupe = deduper();
  const limitApi = rateLimiter(cfg.rateLimit), limitTdx = rateLimiter(cfg.tdxRateLimit), started = Date.now(), counters = { requests: 0, cacheHits: 0, errors: 0 };

  // 相同參數＋相同路網版本 → 直接回快取；同時進來的相同請求共用一次計算
  const cachedCall = async (name, q, fn) => {
    const key = name + '|' + engine.dataInfo().graphVersion + '|' + JSON.stringify(Object.keys(q).sort().map(k => [k, q[k]]));
    const hit = cache.get(key); if (hit) { counters.cacheHits++; return { data: hit, cached: true }; }
    const data = await dedupe(key, () => fn(q)); cache.set(key, data); return { data, cached: false };
  };
  const API = {
    'GET /api/v1/health': () => ({ data: health() }),
    'GET /api/v1/geocode': q => cachedCall('geocode', q, engine.geocode),
    'GET /api/v1/reverse': q => cachedCall('reverse', q, engine.reverse),
    'GET /api/v1/nearby-roads': q => cachedCall('nearby', q, engine.nearbyRoads),
    'GET /api/v1/route': q => cachedCall('route', q, engine.route), 'POST /api/v1/route': q => cachedCall('route', q, engine.route),
    'GET /api/v1/transit': q => cachedCall('transit', q, engine.transit), 'POST /api/v1/transit': q => cachedCall('transit', q, engine.transit),
    'GET /api/v1/multimodal': q => cachedCall('multi', q, engine.multimodal), 'POST /api/v1/multimodal': q => cachedCall('multi', q, engine.multimodal),
    'GET /api/v1/traffic': () => { throw new ApiError(501, 'NO_DATA_SOURCE', '目前沒有即時交通／壅塞資料來源；路線時間只依速限推估'); },
    'POST /api/v1/admin/reload': (q, req) => {
      if (!cfg.adminToken || req.headers.authorization !== 'Bearer ' + cfg.adminToken) throw new ApiError(401, 'UNAUTHORIZED', '需要 ADMIN_TOKEN');
      const info = engine.loadData(cfg); cache.clear(); return { data: { reloaded: true, ...info } };
    }
  };
  function health() {
    const i = engine.dataInfo();
    return { status: i.loaded ? 'ok' : 'loading', version: pkg.version, uptimeS: Math.round((Date.now() - started) / 1000),
      graph: i.loaded ? { nodes: i.nodes, edges: i.edges, roads: i.roads, coordType: i.coordType, graphVersion: i.graphVersion, loadedAt: i.loadedAt, loadMs: i.loadMs, loadedFrom: i.loadedFrom, pack: engine.graphPack() ? { bytes: engine.graphPack().bytes, gzip: engine.graphPack().gz ? engine.graphPack().gz.length : null, br: engine.graphPack().br ? engine.graphPack().br.length : null } : null } : null,
      data: i.data || {}, files: i.files || {}, warnings: i.warnings || [], transitStops: i.transitStops || 0,
      tdx: { configured: tdx.configured, source: src, proxyBase: 'tdx' }, traffic: { available: false },
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
      // ---- API ----
      if (p.startsWith('/api/')) {
        const h = API[`${req.method === 'HEAD' ? 'GET' : req.method} ${p.replace(/\/+$/, '')}`];
        if (!h) { const any = Object.keys(API).some(k => k.endsWith(' ' + p.replace(/\/+$/, ''))); throw any ? new ApiError(405, 'METHOD_NOT_ALLOWED', `${p} 不支援 ${req.method}`) : new ApiError(404, 'NOT_FOUND', `沒有這個 API：${p}`); }
        if (!p.endsWith('/health')) limitApi(ip);
        const ms0 = Date.now(), q = await params(req, url), r = await h(q, req);
        return ok(res, r.data, { requestId: id, ms: Date.now() - ms0, cached: !!r.cached, graphVersion: engine.dataInfo().graphVersion });
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
      if (p === '/data/graph/graph.bin' && engine.graphPack() && await servePack(req, res)) return;
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
  // 路網封包：記憶體裡已壓縮好的版本（br／gzip）；壓縮完成前先從磁碟快取送原始檔
  async function servePack(req, res) {
    const pk = engine.graphPack(), ae = String(req.headers['accept-encoding'] || ''), h = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: pk.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === pk.etag) { res.writeHead(304, h); res.end(); return true; }
    const enc = pk.br && /\bbr\b/.test(ae) ? 'br' : pk.gz && /\bgzip\b/.test(ae) ? 'gzip' : null;
    if (enc) { const body = enc === 'br' ? pk.br : pk.gz; res.writeHead(200, { ...h, 'Content-Encoding': enc, 'Content-Length': body.length }); res.end(req.method === 'HEAD' ? undefined : body); return true; }
    let body; try { body = readFileSync(pk.file); } catch { return false; }
    res.writeHead(200, { ...h, 'Content-Length': body.length }); res.end(req.method === 'HEAD' ? undefined : body); return true;
  }
  handler.stat = stat; handler.tdx = tdx; handler.cache = cache;
  return handler;
}

export async function start(cfg = readConfig()) {
  if (!existsSync(cfg.staticDir + '/index.html')) console.warn(`⚠ ${cfg.staticDir}/index.html 不存在：請先執行 npm run build（或用 npm start）`);
  try { const i = engine.loadData(cfg); console.log(`✅ 路網：${i.nodes.toLocaleString()} 節點、${i.edges.toLocaleString()} 邊、${i.roads.toLocaleString()} 道路（${i.coordType}），${i.loadMs} ms`); for (const w of i.warnings) console.warn('⚠ ' + w);
    console.log(`   選用資料：${Object.entries(i.data).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join(' ')}`);
    if (cfg.warm) { const ms = engine.warmup(); if (ms) console.log(`   預熱：常用交通方式的 A* 地標已建好（${ms} ms）`); } }
  catch (e) { console.error('❌ 路網載入失敗：' + e.message); console.error('   伺服器仍會啟動（網頁可開），但路線 API 會回 503。'); }
  const handler = createApp(cfg);
  const server = cfg.tls ? https.createServer({ cert: readFileSync(cfg.tls.cert), key: readFileSync(cfg.tls.key) }, handler) : http.createServer(handler);
  server.requestTimeout = 60000; server.headersTimeout = 20000; server.keepAliveTimeout = 5000;
  await new Promise(r => server.listen(cfg.port, cfg.host, r));
  const addr = server.address(), shown = cfg.host === '0.0.0.0' ? 'localhost' : cfg.host;
  console.log(`🚀 ${cfg.tls ? 'https' : 'http'}://${shown}:${addr.port}/   （API：/api/v1/health；TDX 代理：${tdxSource(cfg) ? '已設定' : '未設定'}）`);
  if (!cfg.tls) console.log('   ℹ 手機 GPS 需要 HTTPS：正式環境請放在 Caddy／Nginx 後面（見 deploy/），或設定 TLS_CERT、TLS_KEY');
  // 先把大的路網檔壓縮好，第一位使用者就能拿到 gzip
  handler.stat.warm(['nodes', 'edges', 'roads'].map(n => `${cfg.files.graph}/${n}.json`)).catch(() => {});
  if (cfg.watch) { let tm = null; try { watch(cfg.dataDir, { recursive: true }, () => { clearTimeout(tm); tm = setTimeout(() => { try { if (engine.reloadIfChanged()) console.log('🔄 資料已更新，路網重新載入'); } catch (e) { console.error('重新載入失敗：', e.message); } }, 2000); }); } catch (e) { console.warn('無法監看資料夾：', e.message); } }
  const stop = sig => { console.log(`收到 ${sig}，關閉中…`); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM')); process.once('SIGINT', () => stop('SIGINT'));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) { loadDotEnv(); start(readConfig()); }
