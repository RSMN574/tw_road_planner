// config.mjs — 伺服器設定：全部來自環境變數（可放在 .env，見 .env.example）。金鑰只存在伺服器端。
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 簡單的 .env 讀取（不覆蓋已存在的環境變數；零依賴）
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!existsSync(file)) return false;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line); if (!m || line.trim().startsWith('#')) continue;
    let v = m[2]; if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

const num = (v, d) => { const x = Number(v); return v !== undefined && v !== '' && Number.isFinite(x) ? x : d; };
const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v);

export function readConfig(env = process.env) {
  const data = path.resolve(ROOT, env.DATA_DIR || 'data'), opt = (v, def) => path.resolve(data, v || def);      // 載入時才檢查是否存在（之後新增的檔案，重新載入就會生效）
  return {
    port: num(env.PORT, 8080), host: env.HOST || '0.0.0.0',
    staticDir: path.resolve(ROOT, env.STATIC_DIR || 'dist'), dataDir: data,
    cacheDir: path.resolve(env.CACHE_DIR || path.join(ROOT, '.cache')),
    files: {                                                   // 選用資料：檔案存在才載入；網頁也會自動載入同一份
      graph: path.join(data, 'graph'),
      roadTable: opt(env.ROAD_TABLE, 'road-attrs.json'), bus: opt(env.BUS_GRAPH, 'bus/graph.json'),
      metro: opt(env.METRO, 'metro.json'), youbike: opt(env.YOUBIKE, 'ubike.json')
    },
    tls: env.TLS_CERT && env.TLS_KEY ? { cert: env.TLS_CERT, key: env.TLS_KEY } : null,
    trustProxy: bool(env.TRUST_PROXY, false),                  // 放在 Caddy／Nginx 後面時設 1，才會用 X-Forwarded-For 判斷用戶 IP
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),   // 預設不開放跨網域（同網域的網頁不需要）
    rateLimit: num(env.RATE_LIMIT_PER_MIN, 120), tdxRateLimit: num(env.TDX_RATE_LIMIT_PER_MIN, 60),
    // 全台 OSM 道路圖（tools/osm/osm-build.mjs 產生）：OSM=0 關閉；OSM_GRAPH_DIR 預設 data/osm/graph；OSM_WARM：啟動時先建好的運具（逗號分隔，空白＝不預熱）
    osm: { enabled: bool(env.OSM, true), dir: path.resolve(data, env.OSM_GRAPH_DIR || 'osm/graph'), warm: String(env.OSM_WARM ?? 'car').split(',').map(s => s.trim()).filter(Boolean) },
    // v1.11 全台大眾運輸規劃（/api/v1/transit/plan）：tools/transit-sync.mjs 抓到 CACHE_DIR/transit 的 TDX 資料（城市公車、捷運／輕軌、台鐵、高鐵）
    transit: { city: env.TRANSIT_CITY ?? 'Taichung', metro: String(env.TRANSIT_METRO ?? 'TMRT').split(',').map(s => s.trim()).filter(Boolean),
               rail: String(env.TRANSIT_RAIL ?? 'TRA,THSR').split(',').map(s => s.trim()).filter(Boolean), maxWalkM: num(env.TRANSIT_MAX_WALK_M, 1000) },
    maxSnapM: num(env.MAX_SNAP_M, 1000), defaultAlgo: env.ROUTER || 'astar', altCache: num(env.ALT_CACHE, 12), warm: bool(env.WARMUP, true),
    adminToken: env.ADMIN_TOKEN || '', watch: bool(env.WATCH_DATA, false), log: bool(env.LOG, true),
    // 路線計算放到背景執行緒（worker_threads）：0＝在主執行緒同步計算；N＝N 個背景執行緒，每個各載入一份路網（記憶體約 N 倍）
    workers: Math.max(0, Math.min(16, num(env.WORKERS, 0) | 0)), workerTimeoutMs: num(env.WORKER_TIMEOUT_MS, 60000),
    // TDX：向 token 端點（例如 rsmn574.com 的 POST /tokens）取得 token；掛在 server_2 裡時改由 server_2 的 token.txt 提供（見 server/express-mount.mjs）
    tdx: { tokenUrl: env.TDX_TOKEN_URL || '', apiKey: env.TDX_API_KEY || '', ts: env.TDX_TS || '',
           upstream: env.TDX_UPSTREAM || 'https://tdx.transportdata.tw/api/basic/v2', cacheMs: num(env.TDX_CACHE_MS, 15000), timeoutMs: num(env.TDX_TIMEOUT_MS, 10000) }
  };
}
