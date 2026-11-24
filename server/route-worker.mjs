// route-worker.mjs — 背景執行緒：自己載入一份路網（engine.mjs），依序處理主執行緒送來的計算請求
// 每個背景執行緒各有一份路網（記憶體 × 執行緒數）；主執行緒不載入路網，只負責網頁、TDX 代理、快取與排隊。
import { parentPort, workerData } from 'node:worker_threads';
import * as engine from './engine.mjs';
import * as osm from './osm-engine.mjs';

if (workerData && workerData.quiet) { console.info = () => {}; console.log = () => {}; }      // LOG=0：模組載入訊息不輸出（警告與錯誤照常）

const packMeta = () => { const p = engine.graphPack(); return p ? { etag: p.etag, file: p.file, bytes: p.bytes, from: p.from } : null; };
const OPS = {
  load: cfg => ({ info: engine.loadData(cfg), pack: packMeta() }),
  reloadIfChanged: () => (engine.reloadIfChanged() ? { info: engine.dataInfo(), pack: packMeta() } : null),
  warmup: () => engine.warmup(),
  route: q => engine.route(q), transit: q => engine.transit(q), multimodal: q => engine.multimodal(q),
  geocode: q => engine.geocode(q), reverse: q => engine.reverse(q), nearbyRoads: q => engine.nearbyRoads(q),
  osmLoad: cfg => osm.loadOsm(cfg), osmReloadIfChanged: () => (osm.osmReloadIfChanged() ? osm.osmInfo() : null), osmWarmup: m => osm.osmWarmup(m || []),
  osmRoute: q => osm.osmRoute(q), osmNearest: q => osm.osmNearest(q), osmSearch: q => osm.osmSearch(q), osmTile: q => osm.osmTile(q), osmBuildingTile: q => osm.osmBuildingTile(q), osmTransitPlan: q => osm.osmTransitPlan(q), osmTransitStatus: () => osm.osmTransitStatus(), osmTrafficEvents: q => osm.osmTrafficEvents(q), osmPoiSearch: q => osm.osmPoiSearch(q), osmPoiNearby: q => osm.osmPoiNearby(q), osmPoiDetail: q => osm.osmPoiDetail(q), osmPoiCategories: () => osm.osmPoiCategories(),
  ping: () => 'pong'
};

parentPort.on('message', ({ id, op, arg }) => {
  const t0 = performance.now(); let msg;
  try {
    if (!OPS[op]) throw new Error('未知的工作：' + op);
    msg = { id, ok: true, r: OPS[op](arg) };
  } catch (e) {
    msg = { id, ok: false, e: { message: e.message, status: e.status, code: e.code, details: e.details, retryAfter: e.retryAfter, api: e.status != null && e.code != null, stack: e.status == null ? e.stack : undefined } };
  }
  msg.ms = performance.now() - t0;
  parentPort.postMessage(msg);
});
