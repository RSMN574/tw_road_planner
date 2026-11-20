// backend.mjs — 路線計算在哪裡跑
//   ・inline（WORKERS=0）：跟以前一樣在主執行緒同步計算（測試、很小的路網）
//   ・worker（WORKERS≥1，預設 1）：放到 worker_threads 背景執行緒；主執行緒只處理網頁、TDX 代理、快取、排隊，
//     大路網上一次較久的搜尋不會卡住同一個 Node 程序裡的其他請求（例如 server_2 的其他 API）
// 記憶體：每個背景執行緒各自載入一份路網；主執行緒不載入（WORKERS=1 時總記憶體與原本相同，WORKERS=N 約 N 倍）。
import { Worker } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { gzip, brotliCompress, constants as Z } from 'node:zlib';
import { ApiError } from './http-util.mjs';
import * as engine from './engine.mjs';
import * as osm from './osm-engine.mjs';

export const OPS = ['route', 'transit', 'multimodal', 'geocode', 'reverse', 'nearbyRoads'];
export const OSM_OPS = ['osmRoute', 'osmNearest', 'osmSearch', 'osmTile', 'osmBuildingTile', 'osmTransitPlan', 'osmTransitStatus', 'osmTrafficEvents'];          // 全台 OSM 道路圖（osm-engine.mjs）；沒有圖檔時回 503

export function inlineBackend() {
  const be = { kind: 'inline', size: 0, dataInfo: engine.dataInfo, graphPack: engine.graphPack,
    load: async cfg => engine.loadData(cfg), reloadIfChanged: async () => engine.reloadIfChanged(), warmup: async () => engine.warmup(),
    stats: () => ({ mode: 'inline' }), close: async () => {} };
  for (const op of OPS) be[op] = async q => engine[op](q);
  Object.assign(be, { osmInfo: osm.osmInfo, osmLoad: async cfg => osm.loadOsm(cfg), osmReloadIfChanged: async () => osm.osmReloadIfChanged(), osmWarmup: async m => osm.osmWarmup(m || []) });
  for (const op of OSM_OPS) be[op] = async q => osm[op](q);
  return be;
}

// 主執行緒這邊的路網封包（graph.bin）：檔案由背景執行緒建好寫到快取資料夾，這裡讀進來做 br／gzip（壓縮在 libuv 執行緒池，不卡主執行緒）
async function adoptPack(meta) {
  if (!meta) return null;
  const p = { ...meta, gz: null, br: null, ready: null };
  p.ready = readFile(meta.file).then(buf => Promise.all([
    new Promise(r => gzip(buf, { level: 6 }, (e, out) => { if (!e) p.gz = out; r(); })),
    new Promise(r => brotliCompress(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 6, [Z.BROTLI_PARAM_SIZE_HINT]: buf.length } }, (e, out) => { if (!e) p.br = out; r(); }))
  ])).catch(() => {});
  return p;
}

const revive = e => {
  if (e.api) { const x = new ApiError(e.status, e.code, e.message, e.details); if (e.retryAfter) x.retryAfter = e.retryAfter; return x; }
  const x = new Error(e.message); if (e.stack) x.stack = e.stack; return x;
};

export function workerBackend(cfg, { size = 1, timeoutMs = 60000, quiet = !cfg.log } = {}) {
  size = Math.max(1, Math.min(16, size | 0));
  const workers = [], pending = new Map(), st = { jobs: 0, errors: 0, timeouts: 0, restarts: 0, maxQueue: 0, totalMs: 0 };
  let info = { loaded: false }, pack = null, seq = 0, closed = false, cfgRef = cfg, loading = null, osmInfo = { loaded: false, reason: 'OSM 道路圖尚未載入' }, osmWanted = false;

  const send = (w, op, arg, ms = timeoutMs) => new Promise((resolve, reject) => {
    const id = ++seq, job = { w, op, resolve, reject, t0: Date.now(), timer: null };
    if (ms > 0) job.timer = setTimeout(() => {                                       // 太久：回 504，並重開這個執行緒（它可能卡在很大的搜尋）
      if (!pending.has(id)) return; pending.delete(id); w.busy--; st.timeouts++;
      reject(new ApiError(504, 'COMPUTE_TIMEOUT', `路線計算超過 ${Math.round(ms / 1000)} 秒，已中止`));
      w.terminate().catch(() => {});
    }, ms);
    pending.set(id, job); w.busy++; st.maxQueue = Math.max(st.maxQueue, w.busy);
    w.postMessage({ id, op, arg });
  });

  function spawn(i) {
    const w = new Worker(new URL('./route-worker.mjs', import.meta.url), { workerData: { quiet } });
    w.busy = 0; w.unref();                                                          // 不讓背景執行緒擋住程序結束
    w.on('message', m => {
      const job = pending.get(m.id); if (!job) return;
      pending.delete(m.id); clearTimeout(job.timer); w.busy--; st.jobs++; st.totalMs += m.ms || 0;
      if (m.ok) job.resolve(m.r); else { st.errors++; job.reject(revive(m.e)); }
    });
    w.on('error', e => console.error('[bus-planner] 背景執行緒錯誤：' + (e && e.message)));
    w.on('exit', () => {
      for (const [id, job] of pending) if (job.w === w) { pending.delete(id); clearTimeout(job.timer); job.reject(new ApiError(503, 'WORKER_RESTARTED', '計算執行緒重新啟動中，請再試一次')); }
      if (closed || workers[i] !== w) return;
      st.restarts++; const nw = spawn(i); workers[i] = nw;
      if (info.loaded) send(nw, 'load', cfgRef, 0).catch(e => console.error('[bus-planner] 重新啟動的執行緒載入路網失敗：' + e.message));   // 先排「載入」，之後的請求自然排在它後面
      if (osmWanted) send(nw, 'osmLoad', cfgRef, 0).catch(e => console.error('[bus-planner] 重新啟動的執行緒載入 OSM 道路圖失敗：' + e.message));
    });
    return w;
  }
  for (let i = 0; i < size; i++) workers.push(spawn(i));

  const pick = () => workers.reduce((a, b) => (b.busy < a.busy ? b : a));
  const need = () => { if (!info.loaded) throw new ApiError(503, 'GRAPH_NOT_LOADED', loading ? '路網載入中，請稍候' : '路網尚未載入'); };

  // 第一個執行緒先載入（必要時從 JSON 建圖並寫出 graph.bin），其餘的再同時載入——它們會直接讀 graph.bin，也避免同時寫同一個快取檔
  async function loadAll(c, op = 'load') {
    const first = await send(workers[0], op, c, 0);
    if (!first) return null;                                                        // reloadIfChanged：沒有變動
    await Promise.all(workers.slice(1).map(w => send(w, op === 'reloadIfChanged' ? 'load' : op, c, 0)));
    info = first.info; pack = await adoptPack(first.pack); return info;
  }
  const be = {
    kind: 'worker', size,
    dataInfo: () => info, graphPack: () => pack,
    load: c => { cfgRef = c || cfgRef; const p = loadAll(cfgRef); loading = p; return p.finally(() => { if (loading === p) loading = null; }); },
    reloadIfChanged: async () => !!(await loadAll(cfgRef, 'reloadIfChanged')),
    warmup: async () => Math.max(0, ...(await Promise.all(workers.map(w => send(w, 'warmup', null, 0))))),
    stats: () => ({ mode: 'worker_threads', size, busy: workers.map(w => w.busy), jobs: st.jobs, errors: st.errors, timeouts: st.timeouts, restarts: st.restarts, maxQueue: st.maxQueue, avgMs: st.jobs ? +(st.totalMs / st.jobs).toFixed(1) : 0 }),
    close: async () => { closed = true; await Promise.all(workers.map(w => w.terminate().catch(() => {}))); },
    // OSM 道路圖：各執行緒依序載入（一次一個，避免同時讀好幾份大檔造成記憶體高峰）
    osmInfo: () => osmInfo,
    osmLoad: async c => { cfgRef = c || cfgRef; osmWanted = true; if (!osmInfo.loaded) osmInfo = { loaded: false, loading: true }; let first = null; for (const w of workers) { const r = await send(w, 'osmLoad', cfgRef, 0); if (!first) first = r; } osmInfo = first || { loaded: false }; return osmInfo; },
    osmReloadIfChanged: async () => { if (!osmWanted) return false; const r = await send(workers[0], 'osmReloadIfChanged', null, 0); if (!r) return false; for (const w of workers.slice(1)) await send(w, 'osmLoad', cfgRef, 0); osmInfo = r; return true; },
    osmWarmup: async m => Math.max(0, ...(await Promise.all(workers.map(w => send(w, 'osmWarmup', m || [], 0))))),
    _workers: workers
  };
  for (const op of OPS) be[op] = async q => { need(); return send(pick(), op, q); };
  for (const op of OSM_OPS) be[op] = async q => { if (!osmInfo.loaded) throw new ApiError(503, 'OSM_NOT_LOADED', osmInfo.reason || 'OSM 道路圖尚未載入'); return send(pick(), op, q); };
  return be;
}

export const createBackend = (cfg, opts = {}) => (cfg.workers > 0 ? workerBackend(cfg, { size: cfg.workers, timeoutMs: cfg.workerTimeoutMs, ...opts }) : inlineBackend());
