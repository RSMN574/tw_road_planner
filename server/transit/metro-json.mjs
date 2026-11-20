// metro-json.mjs — 把 transit-sync 抓到的 TDX 捷運原始資料，組成網頁與伺服器共用的 data/metro.json（TDX 原始欄位，不改名、不補資料）
//   { Stations, StationOfLine, StationOfRoute, S2STravelTime, Frequency, FirstLastTimetable, LineTransfer, StationExit, ODFare, Line, meta }
// 沒有的資料就不放（例如台中捷運沒有 LineTransfer）；meta.missing 列出缺哪些，網頁與 health 會照實顯示「推估」。
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { LINE_TRANSFER_OPS } from './metro-provider.mjs';

export const METRO_KEYS = [['station', 'Stations'], ['stationOfLine', 'StationOfLine'], ['stationOfRoute', 'StationOfRoute'], ['s2s', 'S2STravelTime'], ['frequency', 'Frequency'],
  ['firstLast', 'FirstLastTimetable'], ['lineTransfer', 'LineTransfer'], ['stationExit', 'StationExit'], ['odFare', 'ODFare'], ['line', 'Line']];

// ODFare 每一筆有四種語言的站名與更新時間；只留計算要用的欄位（台北捷運約 1.4 萬筆，省很多）
const slimFare = rows => rows.map(r => ({ OriginStationID: r.OriginStationID, DestinationStationID: r.DestinationStationID, TrainType: r.TrainType, Fares: r.Fares, TravelTime: r.TravelTime, TravelDistance: r.TravelDistance }));

export function buildMetroJson(raw, { operator = null, fetchedAt = {}, now = Date.now() } = {}) {
  if (!Array.isArray(raw.station) || !raw.station.length) throw new Error('沒有 Station（車站）資料：請先執行 node tools/transit-sync.mjs');
  const out = {}, have = [], missing = [];
  for (const [k, K] of METRO_KEYS) {
    const v = raw[k];
    if (Array.isArray(v) && v.length) { out[K] = k === 'odFare' ? slimFare(v) : v; have.push(K); }
    else if (!(k === 'lineTransfer' && operator && !LINE_TRANSFER_OPS.includes(operator)) && !['line', 'stationOfRoute'].includes(k)) missing.push(K);
  }
  out.meta = { generator: 'bus-planner tools/metro-json.mjs', operator, generatedAt: new Date(now).toISOString(), source: 'TDX Rail/Metro（transit-sync 快取）', datasets: have,
    fetchedAt: Object.fromEntries(Object.entries(fetchedAt).filter(([, v]) => v).map(([k, v]) => [k, new Date(v).toISOString()])), missing };
  return out;
}

// 從 transit-sync 的快取資料夾讀原始資料（<cacheDir>/transit/raw/metro.<OP>.<key>.json.gz）；多個業者就把同種資料接在一起
export function readMetroRaw(dir, operators) {
  const raw = {}, fetchedAt = {}; let meta = {};
  try { meta = JSON.parse(readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch {}
  for (const op of [].concat(operators)) for (const [k] of METRO_KEYS) {
    const f = path.join(dir, 'raw', `metro.${op}.${k}.json.gz`); if (!existsSync(f)) continue;
    const rows = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')); if (!Array.isArray(rows)) continue;
    raw[k] = (raw[k] || []).concat(rows); const t = meta[`metro.${op}.${k}`]?.fetchedAt ?? null; if (t) fetchedAt[k] = Math.max(fetchedAt[k] || 0, t);
  }
  return { raw, fetchedAt };
}
