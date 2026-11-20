// snapshot.mjs — 向 TDX 取大眾運輸靜態資料、存到磁碟、建立 TimetableStore。
//
// ・每種資料各自有更新週期；只抓到期的，內容雜湊沒變就不重建（Incremental Update）
// ・原始回應以 gzip 存在 <cacheDir>/transit/raw/，伺服器重啟直接讀檔，不必重抓、也不必每次查詢重新解析
// ・任何一種資料抓失敗：保留舊檔繼續用，並把錯誤記在 status()；絕不刪除既有資料
// ・store.version 會跟著資料內容改變，路線快取用它當鍵的一部分（Graph Version）
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';
import { buildBus } from './bus-provider.mjs';
import { buildMetro, LINE_TRANSFER_OPS } from './metro-provider.mjs';
export { LINE_TRANSFER_OPS };
import { createStore } from './timetable-store.mjs';
import { buildRail, attachStationTimetables, railTransfers, railFares, railShapes, traDelays, metroModeOf } from './rail-provider.mjs';

const H = 3600e3;
// 要抓的資料清單。path 是 TDX basic v2 底下的路徑；optional＝抓不到也能運作（對應功能會標示資訊不足）
// v1.11：opts.rail＝['TRA','THSR']（台鐵、高鐵）、opts.extras＝true（捷運站別時刻表、跨系統轉乘、共站、GIS 軌道線型）
// 各端點接受哪些業者代碼，依 docs/oas/tdx-rail-v2.json、tdx-gis-v3.json 的 enum（不在 enum 裡的不問，避免 HTTP 400 浪費額度）
export const OAS_METRO_ENUM = {
  Station: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TRTCMG', 'TMRT', 'NTMC', 'NTALRT'], Line: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TRTCMG', 'TMRT', 'NTMC', 'NTALRT'],
  StationOfLine: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TRTCMG', 'TMRT', 'NTMC', 'NTALRT'], StationOfRoute: ['TRTC', 'KRTC', 'TYMC', 'NTDLRT', 'TMRT', 'NTMC', 'NTALRT', 'TRTCMG', 'KLRT'],
  S2STravelTime: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'TMRT', 'NTMC'], Frequency: ['TRTC', 'TYMC', 'TMRT', 'NTMC', 'KRTC'], FirstLastTimetable: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'TMRT', 'NTMC', 'TRTCMG'],
  StationExit: ['TRTC', 'KRTC', 'TYMC', 'TRTCMG', 'TMRT', 'NTMC'], ODFare: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TRTCMG', 'TMRT', 'NTMC', 'NTALRT'],
  StationTimeTable: ['TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'NTALRT', 'NTMC'], StationTransfer: ['TRTC', 'NTMC', 'TYMC'], Alert: ['TYMC', 'KRTC', 'KLRT', 'TRTC', 'TRTCMG', 'TMRT', 'NTMC', 'NTALRT', 'NTDLRT']
};
export const OAS_GIS_LINE_ENUM = ['TRA', 'THSR', 'TRTC', 'KRTC', 'TYMC', 'KLRT', 'NTDLRT', 'TMRT', 'NTMC', 'TRTCMG', 'NTALRT', 'AFR'];
export function datasetList(city = 'Taichung', operators = ['TMRT'], { rail = [], extras = false, date = null } = {}) {
  const bus = (name, p, ttl, optional = false) => ({ name: `bus.${name}`, group: 'bus', key: name, path: `/Bus/${p}/City/${city}?%24format=JSON`, ttlMs: ttl, optional });
  const out = city ? [bus('stopOfRoute', 'StopOfRoute', 24 * H), bus('schedule', 'Schedule', 24 * H, true), bus('daily', 'DailyTimeTable', 6 * H, true), bus('s2s', 'S2STravelTime', 7 * 24 * H, true)] : [];
  for (const op of operators) for (const [key, p, optional, ttl = 24 * H] of [['station', 'Station', false], ['line', 'Line', true], ['stationOfLine', 'StationOfLine', true], ['stationOfRoute', 'StationOfRoute', true], ['s2s', 'S2STravelTime', true],
    ['frequency', 'Frequency', true], ['firstLast', 'FirstLastTimetable', true], ['lineTransfer', 'LineTransfer', true], ['stationExit', 'StationExit', true], ['odFare', 'ODFare', true, 7 * 24 * H],
    ...(extras ? [['stationTimeTable', 'StationTimeTable', true, 7 * 24 * H], ['stationTransfer', 'StationTransfer', true, 7 * 24 * H]] : [])]) {
    if (key === 'lineTransfer' && !LINE_TRANSFER_OPS.includes(op)) continue;     // TDX 回 400「RailSystem 'TMRT' is not accepted but TRTC, KRTC, TYMC, NTMC」：其他業者不提供，不必每次都問
    if (OAS_METRO_ENUM[p] && !OAS_METRO_ENUM[p].includes(op) && extras) continue;  // v1.11（extras 模式）：OAS 沒列的業者不問
    out.push({ name: `metro.${op}.${key}`, group: 'metro', operator: op, key, path: `/Rail/Metro/${p}/${op}?%24format=JSON`, ttlMs: ttl, optional, wrap: key === 'stationTransfer' });
  }
  if (extras) {
    for (const sys of ['TRTC_NTMC', 'KRTC']) out.push({ name: `metroShared.${sys}.transferStations`, group: 'metroShared', key: 'transferStations', operator: sys, path: `/Rail/Metro/TransferStations/${sys}?%24format=JSON`, ttlMs: 7 * 24 * H, optional: true });
    for (const op of [...new Set([...operators, ...rail])]) if (OAS_GIS_LINE_ENUM.includes(op)) out.push({ name: `gis.${op}.line`, group: 'gis', key: 'line', operator: op, path: `/V3/Map/Rail/Network/Line/OperatorCode/${op}?%24format=JSON`, ttlMs: 30 * 24 * H, optional: true });
  }
  // 台鐵、高鐵：當日時刻表的路徑含日期（每天換一次）
  const day = date || new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  for (const op of rail) {
    if (op !== 'TRA' && op !== 'THSR') continue;
    out.push({ name: `rail.${op}.station`, group: 'rail', operator: op, key: 'station', path: `/Rail/${op}/Station?%24format=JSON`, ttlMs: 7 * 24 * H, optional: false });
    out.push({ name: `rail.${op}.general`, group: 'rail', operator: op, key: 'general', path: `/Rail/${op}/GeneralTimetable?%24format=JSON`, ttlMs: 24 * H, optional: true });
    out.push({ name: `rail.${op}.daily`, group: 'rail', operator: op, key: 'daily', path: `/Rail/${op}/DailyTimetable/TrainDate/${day}?%24format=JSON`, ttlMs: 6 * H, optional: true, date: day });
    out.push({ name: `rail.${op}.odFare`, group: 'rail', operator: op, key: 'odFare', path: `/Rail/${op}/ODFare?%24format=JSON`, ttlMs: 7 * 24 * H, optional: true });
    if (op === 'TRA') out.push({ name: 'realtime.TRA.liveDelay', group: 'realtime', operator: op, key: 'liveDelay', path: '/Rail/TRA/LiveTrainDelay?%24format=JSON', ttlMs: 2 * 60e3, optional: true });
  }
  return out;
}

// Retry-After：秒數或 HTTP 日期；沒有就用指數退避
const retryAfterMs = (h, attempt) => { const v = h && h.get ? h.get('retry-after') : null; if (v != null && v !== '') { const n = Number(v); if (Number.isFinite(n)) return n * 1000; const t = Date.parse(v); if (Number.isFinite(t)) return t - Date.now(); } return 2000 * 2 ** attempt; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 簡單的 TDX 取資料函式：getToken() 由外部提供（例如讀 server_2 的 token.txt）。401 時重新要一次 token 再試。
// 限流：請求之間至少間隔 minGapMs；遇到 429（API rate limit exceeded）或 503，依 Retry-After（沒有就 2、4、8… 秒）等待後重試，最多 retries 次
export function createTdxFetcher({ upstream = 'https://tdx.transportdata.tw/api/basic/v2', getToken, timeoutMs = 60000, fetchImpl = globalThis.fetch, minGapMs = 1200, retries = 4, maxWaitMs = 60000, wait = sleep, log = () => {} }) {
  let last = 0, chain = Promise.resolve();
  const paced = fn => { const run = chain.then(async () => { const d = last + minGapMs - Date.now(); if (d > 0) await wait(d); try { return await fn(); } finally { last = Date.now(); } }); chain = run.catch(() => {}); return run; };
  return async function fetchJson(p) {
    const once = force => paced(async () => {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
      const base = /^\/v[13]\//i.test(p) ? upstream.replace(/\/+$/, '').replace(/\/v2$/i, '') : upstream.replace(/\/+$/, '');   // GIS 圖資在 /api/basic/v3、道路事件在 /api/basic/v1
      try { return await fetchImpl(base + p, { headers: { Authorization: 'Bearer ' + String(await getToken(force)).trim().replace(/^Bearer\s+/i, ''), Accept: 'application/json', 'Accept-Encoding': 'gzip' }, signal: ac.signal }); }
      finally { clearTimeout(t); }
    });
    let r = await once(false), tries = 0, renewed = false;
    for (;;) {
      if (r.status === 401 && !renewed) { renewed = true; try { await r.text(); } catch {} r = await once(true); continue; }   // token 過期：重新要一次
      if ((r.status === 429 || r.status === 503) && tries < retries) {
        const ms = Math.min(maxWaitMs, Math.max(1000, retryAfterMs(r.headers, tries))); tries++;
        log(`  … ${p.split('?')[0]}：HTTP ${r.status}（限流），${Math.round(ms / 1000)} 秒後重試（第 ${tries} 次）`);
        try { await r.text(); } catch {}
        await wait(ms); r = await once(false); continue;
      }
      break;
    }
    const text = await r.text();
    if (r.status !== 200) return { status: r.status, data: null, detail: text.slice(0, 200), retried: tries };
    let j; try { j = JSON.parse(text); } catch { return { status: 502, data: null, detail: '回應不是 JSON' }; }
    return { status: 200, data: Array.isArray(j) ? j : (j.data ?? j.Data ?? j), bytes: text.length };
  };
}

export function createTransitData({ dir, city = 'Taichung', operators = ['TMRT'], rail = [], extras = false, fetchJson = null, now = () => Date.now(), log = () => {} }) {
  const rawDir = path.join(dir, 'raw'), metaFile = path.join(dir, 'meta.json'), mkList = () => datasetList(city, operators, { rail, extras, date: new Date(now() + 8 * 3600e3).toISOString().slice(0, 10) });
  let list = mkList();
  let meta = {}, raw = {}, store = null, lastBuildMs = 0, refreshing = null, extra = {};
  const fileOf = d => path.join(rawDir, d.name + '.json.gz');
  const atomic = (f, buf) => { writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f); };
  function rebuild() {
    const t0 = Date.now(), busRaw = {}, metroRaw = {}, railRaw = {}, gis = {}, shared = [], rt = {}; let fetchedAt = null;
    for (const d of list) { const v = raw[d.name]; if (v == null) continue; fetchedAt = Math.max(fetchedAt ?? 0, meta[d.name]?.fetchedAt ?? 0);
      if (d.group === 'bus') busRaw[d.key] = v; else if (d.group === 'rail') (railRaw[d.operator] ??= {})[d.key] = v; else if (d.group === 'gis') gis[d.operator] = v;
      else if (d.group === 'metroShared') shared.push(...v); else if (d.group === 'realtime') rt[d.name] = v; else (metroRaw[d.operator] ??= {})[d.key] = v; }
    const bus = busRaw.stopOfRoute ? buildBus(busRaw, { fetchedAt: meta['bus.stopOfRoute']?.fetchedAt ?? null }) : null;
    const metroOps = Object.keys(metroRaw).filter(op => metroRaw[op].station);
    const metros = metroOps.map(op => { const r = metroRaw[op], m = buildMetro(r, { operator: op, fetchedAt: meta[`metro.${op}.station`]?.fetchedAt ?? null }); for (const s of m.stops) s.mode = metroModeOf(op); for (const p of m.patterns) p.mode = metroModeOf(op);   // 輕軌（KLRT、NTDLRT、NTALRT）獨立成 lrt
      if (r.stationTimeTable) m.stats.stationTimetable = attachStationTimetables(m, r.stationTimeTable, { operator: op }); return m; });
    const rails = Object.entries(railRaw).filter(([, r]) => r.station).map(([op, r]) => buildRail(r, { operator: op, fetchedAt: meta[`rail.${op}.station`]?.fetchedAt ?? null, dailyDate: list.find(d => d.name === `rail.${op}.daily`)?.date }));
    // 跨系統轉乘（StationTransfer、TransferStations）：站點代碼 → uid
    const byOpId = new Map(); for (const m of [...metros, ...rails]) for (const s of m.stops) byOpId.set(`${s.operator}|${s.stationId}`, s.uid);
    const byId = new Map(); for (const [k, u] of byOpId) { const id = k.slice(k.indexOf('|') + 1); byId.set(id, byId.has(id) ? null : u); }   // 沒寫業者時：代碼只對應到一個站才用（重複的不猜）
    const uidOf = (id, op) => { if (id == null) return null; if (op && byOpId.has(`${op}|${id}`)) return byOpId.get(`${op}|${id}`); return byId.get(String(id)) || null; };
    const xfer = railTransfers({ stationTransfer: metroOps.flatMap(op => metroRaw[op].stationTransfer || []), transferStations: shared }, uidOf);
    if (rails[0]) rails[0].transfers.push(...xfer); else if (metros[0]) metros[0].transfers.push(...xfer);
    store = createStore({ bus, metros, rails, builtAt: now(), datasetHashes: Object.fromEntries(list.map(d => [d.name, meta[d.name]?.hash ?? null])) });
    store.detail = { bus: bus?.stats ?? null, metro: Object.fromEntries(metros.map((m, i) => [metroOps[i], { ...m.stats, missing: m.missing }])), rail: Object.fromEntries(rails.map(r => [r.patterns[0]?.operator || r.stops[0]?.operator, { ...r.stats, missing: r.missing }])), crossTransfers: xfer.length };
    extra = { shapes: Object.entries(gis).flatMap(([op, v]) => railShapes(v, op, 'TDX GIS v3 Map/Rail/Network/Line')), fares: Object.fromEntries(Object.entries(railRaw).filter(([, r]) => r.odFare).map(([op, r]) => [op, railFares(r.odFare, op)])),
      metroFares: Object.fromEntries(metroOps.filter(op => metroRaw[op].odFare).map(op => [op, metroRaw[op].odFare])), delays: rt['realtime.TRA.liveDelay'] ? traDelays(rt['realtime.TRA.liveDelay'], now()) : null };
    lastBuildMs = Date.now() - t0; return store;
  }
  // 從磁碟載入（不連網）。沒有任何檔案時 store 為 null。
  function load() {
    if (existsSync(metaFile)) { try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch { meta = {}; } }
    raw = {};
    for (const d of list) if (existsSync(fileOf(d))) { try { raw[d.name] = JSON.parse(gunzipSync(readFileSync(fileOf(d))).toString('utf8')); } catch (e) { log(`[transit] 讀取 ${d.name} 失敗：${e.message}`); } }
    if (!Object.keys(raw).length) { store = null; return null; }
    return rebuild();
  }
  // 抓到期的資料；有變動才重建。only：只更新指定名稱；force：不管是否到期。
  async function refresh({ force = false, only = null } = {}) {
    if (!fetchJson) throw new Error('沒有設定 TDX 取資料的方式（fetchJson）');
    if (refreshing) return refreshing;                                                             // 同時多次呼叫只跑一次
    refreshing = (async () => {
      list = mkList();                                                                             // 當日時刻表的路徑含日期：每次更新前重算
      mkdirSync(rawDir, { recursive: true }); let changed = 0; const report = [];
      for (const d of list) {
        if (only && !only.includes(d.name)) continue;
        const m = meta[d.name] || {}, due = force || (m.error ? now() >= (m.retryAt || 0) : (!m.fetchedAt || now() - m.fetchedAt > d.ttlMs));
        if (!due) { report.push({ name: d.name, action: 'fresh' }); continue; }
        let r; try { r = await fetchJson(d.path); } catch (e) { r = { status: 0, data: null, detail: e.name === 'AbortError' ? '逾時' : e.message }; }
        if (r.status === 200 && d.wrap && r.data && !Array.isArray(r.data)) r = { ...r, data: [r.data] };   // StationTransfer 回傳的是包裝物件
        if (r.status !== 200 || !Array.isArray(r.data)) {
          // 404＝這個城市／業者沒有這種資料：照正常週期再問即可；其他錯誤（逾時、5xx、限流）10 分鐘後重試
          meta[d.name] = { ...m, triedAt: now(), retryAt: now() + (r.status === 404 ? d.ttlMs : 10 * 60e3), error: `HTTP ${r.status}${r.detail ? '：' + String(r.detail).slice(0, 120) : ''}` };
          report.push({ name: d.name, action: 'failed', error: meta[d.name].error, keptOld: raw[d.name] != null, optional: d.optional }); continue;
        }
        const body = JSON.stringify(r.data), hash = createHash('sha1').update(body).digest('hex').slice(0, 16);
        if (hash !== m.hash || raw[d.name] == null) { atomic(fileOf(d), gzipSync(body)); raw[d.name] = r.data; changed++; report.push({ name: d.name, action: 'updated', rows: r.data.length }); }
        else report.push({ name: d.name, action: 'unchanged', rows: r.data.length });
        meta[d.name] = { fetchedAt: now(), triedAt: now(), hash, rows: r.data.length, bytes: body.length, error: null };
      }
      atomic(metaFile, JSON.stringify(meta, null, 1));
      if (changed || !store) { if (Object.keys(raw).length) rebuild(); }
      return { changed, version: store?.version ?? null, report };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  const status = () => ({ city, operators, version: store?.version ?? null, builtAt: store?.builtAt ?? null, buildMs: lastBuildMs, stats: store?.stats ?? null, detail: store?.detail ?? null,
    datasets: list.map(d => ({ name: d.name, optional: d.optional, rows: meta[d.name]?.rows ?? null, fetchedAt: meta[d.name]?.fetchedAt ?? null, error: meta[d.name]?.error ?? null, loaded: raw[d.name] != null })),
    warnings: store?.warnings ?? [] });
  return { load, refresh, status, get store() { return store; }, get extra() { return extra; }, get datasets() { return list; } };
}
