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
import { buildMetro } from './metro-provider.mjs';
import { createStore } from './timetable-store.mjs';

const H = 3600e3;
// 要抓的資料清單。path 是 TDX basic v2 底下的路徑；optional＝抓不到也能運作（對應功能會標示資訊不足）
export function datasetList(city = 'Taichung', operators = ['TMRT']) {
  const bus = (name, p, ttl, optional = false) => ({ name: `bus.${name}`, group: 'bus', key: name, path: `/Bus/${p}/City/${city}?%24format=JSON`, ttlMs: ttl, optional });
  const out = [bus('stopOfRoute', 'StopOfRoute', 24 * H), bus('schedule', 'Schedule', 24 * H, true), bus('daily', 'DailyTimeTable', 6 * H, true), bus('s2s', 'S2STravelTime', 7 * 24 * H, true)];
  for (const op of operators) for (const [key, p, optional] of [['station', 'Station', false], ['line', 'Line', true], ['stationOfLine', 'StationOfLine', true], ['stationOfRoute', 'StationOfRoute', true], ['s2s', 'S2STravelTime', true],
    ['frequency', 'Frequency', true], ['firstLast', 'FirstLastTimetable', true], ['lineTransfer', 'LineTransfer', true], ['stationExit', 'StationExit', true]])
    out.push({ name: `metro.${op}.${key}`, group: 'metro', operator: op, key, path: `/Rail/Metro/${p}/${op}?%24format=JSON`, ttlMs: 24 * H, optional });
  return out;
}

// 簡單的 TDX 取資料函式：getToken() 由外部提供（例如讀 server_2 的 token.txt）。401 時重新要一次 token 再試。
export function createTdxFetcher({ upstream = 'https://tdx.transportdata.tw/api/basic/v2', getToken, timeoutMs = 60000, fetchImpl = globalThis.fetch }) {
  return async function fetchJson(p) {
    const once = async force => {
      const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
      try { return await fetchImpl(upstream.replace(/\/+$/, '') + p, { headers: { Authorization: 'Bearer ' + String(await getToken(force)).trim().replace(/^Bearer\s+/i, ''), Accept: 'application/json', 'Accept-Encoding': 'gzip' }, signal: ac.signal }); }
      finally { clearTimeout(t); }
    };
    let r = await once(false); if (r.status === 401) r = await once(true);
    const text = await r.text();
    if (r.status !== 200) return { status: r.status, data: null, detail: text.slice(0, 200) };
    let j; try { j = JSON.parse(text); } catch { return { status: 502, data: null, detail: '回應不是 JSON' }; }
    return { status: 200, data: Array.isArray(j) ? j : (j.data ?? j.Data ?? j), bytes: text.length };
  };
}

export function createTransitData({ dir, city = 'Taichung', operators = ['TMRT'], fetchJson = null, now = () => Date.now(), log = () => {} }) {
  const rawDir = path.join(dir, 'raw'), metaFile = path.join(dir, 'meta.json'), list = datasetList(city, operators);
  let meta = {}, raw = {}, store = null, lastBuildMs = 0, refreshing = null;
  const fileOf = d => path.join(rawDir, d.name + '.json.gz');
  const atomic = (f, buf) => { writeFileSync(f + '.tmp', buf); renameSync(f + '.tmp', f); };
  function rebuild() {
    const t0 = Date.now(), busRaw = {}, metroRaw = {}; let fetchedAt = null;
    for (const d of list) { const v = raw[d.name]; if (v == null) continue; fetchedAt = Math.max(fetchedAt ?? 0, meta[d.name]?.fetchedAt ?? 0);
      if (d.group === 'bus') busRaw[d.key] = v; else (metroRaw[d.operator] ??= {})[d.key] = v; }
    const bus = busRaw.stopOfRoute ? buildBus(busRaw, { fetchedAt: meta['bus.stopOfRoute']?.fetchedAt ?? null }) : null;
    const metros = Object.entries(metroRaw).filter(([, r]) => r.station).map(([op, r]) => buildMetro(r, { operator: op, fetchedAt: meta[`metro.${op}.station`]?.fetchedAt ?? null }));
    store = createStore({ bus, metros, builtAt: now(), datasetHashes: Object.fromEntries(list.map(d => [d.name, meta[d.name]?.hash ?? null])) });
    store.detail = { bus: bus?.stats ?? null, metro: Object.fromEntries(metros.map((m, i) => [Object.keys(metroRaw).filter(op => metroRaw[op].station)[i], { ...m.stats, missing: m.missing }])) };
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
      mkdirSync(rawDir, { recursive: true }); let changed = 0; const report = [];
      for (const d of list) {
        if (only && !only.includes(d.name)) continue;
        const m = meta[d.name] || {}, due = force || (m.error ? now() >= (m.retryAt || 0) : (!m.fetchedAt || now() - m.fetchedAt > d.ttlMs));
        if (!due) { report.push({ name: d.name, action: 'fresh' }); continue; }
        let r; try { r = await fetchJson(d.path); } catch (e) { r = { status: 0, data: null, detail: e.name === 'AbortError' ? '逾時' : e.message }; }
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
  return { load, refresh, status, get store() { return store; }, datasets: list };
}
