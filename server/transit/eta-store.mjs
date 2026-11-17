// eta-store.mjs — 公車即時到站（ETA）的儲存與判讀。與固定時刻表完全分開：這裡只放 TDX 回報的即時資料。
//
// ・鍵：SubRouteUID（沒有才用 RouteUID）｜Direction｜StopUID —— 不用路線名稱、不混方向
// ・每筆都記 DataTime／UpdateTime；超過 staleS 秒就是「過期」，不會被當成即時資料
// ・查不到 → kind:'none'（沒有資料），絕不回傳推測值
import { parseStamp } from './time.mjs';

// TDX StopStatus：0 正常、1 尚未發車、2 交管不停靠、3 末班車已過、4 今日未營運
export const STOP_STATUS = { 1: '尚未發車', 2: '交管不停靠', 3: '末班車已過', 4: '今日未營運' };

export function createEtaStore({ staleS = 180, maxAgeMs = 10 * 60e3, now = () => Date.now() } = {}) {
  const map = new Map(), routes = new Map(), stats = { ingested: 0, hits: 0, misses: 0, stale: 0, dropped: 0 };
  const keyOf = (sub, route, dir, stop) => `${sub || route}|${dir ?? '?'}|${stop}`;
  // rows：TDX EstimatedTimeOfArrival 的陣列；fetchedAt：這批資料取得的時間
  function ingest(rows, fetchedAt = now()) {
    let n = 0;
    for (const it of Array.isArray(rows) ? rows : []) {
      if (!it || !it.StopUID || !(it.SubRouteUID || it.RouteUID)) { stats.dropped++; continue; }
      // 資料時間：優先用來源端產生資料的時間（SrcUpdateTime／DataTime），其次平台更新時間；都沒有 → 沒辦法判斷新舊，視為過期
      const t = [it.SrcUpdateTime, it.DataTime, it.UpdateTime, it.SrcTransTime].map(parseStamp).find(Number.isFinite);
      const ests = (Array.isArray(it.Estimates) && it.Estimates.length ? it.Estimates : (typeof it.EstimateTime === 'number' ? [{ EstimateTime: it.EstimateTime, PlateNumb: it.PlateNumb, IsLastBus: it.IsLastBus }] : []))
        .filter(x => typeof x.EstimateTime === 'number' && x.EstimateTime >= 0).map(x => ({ sec: x.EstimateTime, plate: x.PlateNumb && x.PlateNumb !== '-1' ? x.PlateNumb : null, last: x.IsLastBus === true || x.IsLastBus === 1 }));
      const nb = parseStamp(it.NextBusTime);
      const rec = { dataMs: t ?? null, fetchedAt, status: it.StopStatus ?? 0, ests, nextBusMs: Number.isFinite(nb) ? nb : null, seq: it.StopSequence ?? null, plate: it.PlateNumb && it.PlateNumb !== '-1' ? it.PlateNumb : null,
        routeUID: it.RouteUID ?? null, subRouteUID: it.SubRouteUID ?? null, direction: it.Direction ?? null, stopUID: it.StopUID };
      for (const k of new Set([keyOf(it.SubRouteUID, it.RouteUID, it.Direction, it.StopUID), keyOf(null, it.RouteUID, it.Direction, it.StopUID)])) if (!k.startsWith('undefined') && !k.startsWith('null')) map.set(k, rec);
      if (it.RouteUID) routes.set(it.RouteUID, fetchedAt); n++;
    }
    stats.ingested += n; return n;
  }
  // 查一個站牌的即時狀態。回傳 kind：
  //   live（arrivals：預估到站的絕對時間）／stale（過期）／status（尚未發車、未營運…）／nodata（有這筆但沒有預估時間）／none（完全沒有資料）
  function get({ subRouteUID = null, routeUID = null, direction = null, stopUID }, at = now()) {
    const rec = map.get(keyOf(subRouteUID, routeUID, direction, stopUID)) || (subRouteUID && routeUID ? map.get(keyOf(null, routeUID, direction, stopUID)) : null);
    if (!rec) { stats.misses++; return { kind: 'none', text: '沒有即時資料' }; }
    stats.hits++;
    const ageS = rec.dataMs == null ? Infinity : (at - rec.dataMs) / 1000, base = { dataMs: rec.dataMs, ageS: Number.isFinite(ageS) ? Math.round(ageS) : null, seq: rec.seq, source: 'TDX Bus/EstimatedTimeOfArrival' };
    if (ageS > staleS) { stats.stale++; return { kind: 'stale', text: rec.dataMs == null ? '即時資料沒有時間戳，無法確認新舊' : `即時資料已過期（${Math.round(ageS)} 秒前）`, ...base }; }
    if (rec.status !== 0) return { kind: 'status', status: rec.status, text: STOP_STATUS[rec.status] || `狀態碼 ${rec.status}`, nextBusMs: rec.nextBusMs, ...base };
    if (!rec.ests.length) return { kind: 'nodata', text: '沒有預估到站時間', nextBusMs: rec.nextBusMs, ...base };
    return { kind: 'live', text: '即時預估', arrivals: rec.ests.map(e => ({ ms: rec.dataMs + e.sec * 1000, plate: e.plate, last: e.last })), ...base,
      confidence: ageS <= 60 ? 'high' : 'medium' };                                                          // 可信度只看資料新舊，不做其他假設
  }
  function prune(at = now()) { let n = 0; for (const [k, r] of map) if (at - r.fetchedAt > maxAgeMs) { map.delete(k); n++; } return n; }
  const routeFetchedAt = routeUID => routes.get(routeUID) ?? null;
  return { ingest, get, prune, routeFetchedAt, stats, get size() { return map.size; } };
}
