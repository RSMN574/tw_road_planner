// express-mount.mjs — 把 bus-planner 掛進現有的 Express 伺服器（例如 rsmn574.com 的 server_2）
//
//   import { busPlanner } from './bus-planner/server/express-mount.mjs';
//   app.use('/bus-planner', busPlanner());      // 放在 cors／rate limit／express.json() 之前
//
// ・網頁、路網資料、/api/v1/*、/tdx 代理全部在 /bus-planner/ 底下，原伺服器的路由完全不受影響
// ・TDX token：直接讀原伺服器由 cron 更新的 token.txt（TOKEN_FILE），不另外取 token、不需要金鑰
// ・路網在背景執行緒（worker_threads，BUS_PLANNER_WORKERS，預設 1）載入與計算：載入和每次路線搜尋都不會卡住原伺服器的其他請求
// ・設定都用 BUS_PLANNER_ 開頭的環境變數，不會跟原伺服器的 .env 衝突
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ROOT, readConfig } from './config.mjs';
import { createApp } from './server.mjs';

export function busPlanner(opts = {}) {
  const e = process.env, E = (k, d) => (e['BUS_PLANNER_' + k] ?? d);
  const dist = path.join(ROOT, 'dist');
  const cfg = readConfig({
    DATA_DIR: E('DATA_DIR', path.join(ROOT, 'data')),
    // 有打包好的 dist/ 就用；沒有（例如 dist 被 .gitignore 排除）就直接提供原始碼（ES Modules），一樣能用
    STATIC_DIR: E('STATIC_DIR', existsSync(path.join(dist, 'index.html')) ? dist : ROOT),
    CACHE_DIR: E('CACHE_DIR', path.join(ROOT, '.cache')),
    TRUST_PROXY: E('TRUST_PROXY', '1'),                       // 原伺服器在 Nginx 後面（app.set('trust proxy', 1)）
    LOG: E('LOG', '0'), RATE_LIMIT_PER_MIN: E('RATE_LIMIT_PER_MIN', '120'), TDX_RATE_LIMIT_PER_MIN: E('TDX_RATE_LIMIT_PER_MIN', '60'),
    ROUTER: E('ROUTER', 'astar'), ALT_CACHE: E('ALT_CACHE', '12'), WARMUP: E('WARMUP', '0'), MAX_SNAP_M: E('MAX_SNAP_M', '1000'),
    WORKERS: E('WORKERS', '1'), WORKER_TIMEOUT_MS: E('WORKER_TIMEOUT_MS', '60000'),           // 路線計算放背景執行緒：不卡 server_2 的其他請求
    OSM: E('OSM', '1'), OSM_GRAPH_DIR: E('OSM_GRAPH_DIR', 'osm/graph'), OSM_WARM: E('OSM_WARM', 'car'),   // 全台 OSM 道路圖（tools/osm/osm-build.mjs 建好的 data/osm/graph）
    ADMIN_TOKEN: E('ADMIN_TOKEN', ''), CORS_ORIGINS: E('CORS_ORIGINS', ''), TDX_CACHE_MS: E('TDX_CACHE_MS', '15000'),
    TDX_UPSTREAM: E('TDX_UPSTREAM', 'https://tdx.transportdata.tw/api/basic/v2'), ...(opts.env || {})
  });
  const tokenFile = opts.tokenFile ?? e.TOKEN_FILE ?? path.resolve(process.cwd(), 'token.txt');      // 與原伺服器同一個 token.txt
  const getToken = opts.getToken || (async () => (await readFile(tokenFile, 'utf8')).trim());
  const handler = createApp(cfg, { getToken, tokenSource: 'token.txt' });

  const be = handler.backend; let readyP = null;
  const load = () => be.load(cfg).then(async i => {
    console.log(`[bus-planner] 路網：${i.nodes.toLocaleString()} 節點、${i.edges.toLocaleString()} 邊（${i.loadMs} ms${be.size ? `，${be.size} 個背景計算執行緒` : ''}）；選用資料：${Object.entries(i.data).filter(([, v]) => v).map(([k]) => k).join('、') || '無'}`);
    if (cfg.warm) { const ms = await be.warmup(); if (ms) console.log(`[bus-planner] A* 地標預熱 ${ms} ms`); }
    handler.cache.clear(); return i;
  }).catch(err => { console.error('[bus-planner] 路網載入失敗：' + err.message + '（網頁仍可開，路線 API 會回 503）'); return null; });
  // 全台 OSM 道路圖：台中路網載入後在背景載入（約幾秒；沒有圖檔時 OSM API 回 503，其他照常）
  const loadOsm = () => (cfg.osm && cfg.osm.enabled && be.osmLoad ? be.osmLoad(cfg).then(async o => {
    if (!o.loaded) { console.log(`[bus-planner] OSM 道路圖：${o.reason || '未載入'}`); return o; }
    console.log(`[bus-planner] OSM 道路圖：${o.vertices.toLocaleString()} 頂點、${o.edges.toLocaleString()} 邊（${o.loadMs} ms${o.alt ? '，ALT 地標 ' + o.alt.join('、') : ''}）`);
    if (cfg.osm.warm.length) await be.osmWarmup(cfg.osm.warm);
    handler.cache.clear(); handler.tiles.clear(); return o;
  }).catch(err => { console.error('[bus-planner] OSM 道路圖載入失敗：' + err.message); return null; }) : Promise.resolve(null));
  let osmP = null;
  readyP = (opts.loadNow ? load() : new Promise(r => setTimeout(() => r(load()), opts.loadDelayMs ?? 0))).then(i => { osmP = loadOsm(); mw.osmReady = osmP; return i; });

  const mw = (req, res) => {
    // 「/bus-planner」沒有結尾斜線 → 轉到「/bus-planner/」，網頁裡的相對路徑（data/、api/、sw.js）才會正確
    const orig = String(req.originalUrl || req.url), [p, q] = orig.split('?');
    if (req.url.split('?')[0] === '/' && !p.endsWith('/')) { res.writeHead(301, { Location: p + '/' + (q ? '?' + q : '') }); return res.end(); }
    handler(req, res);
  };
  mw.cfg = cfg; mw.handler = handler; mw.reload = load; mw.ready = readyP; mw.close = () => be.close();
  return mw;
}
