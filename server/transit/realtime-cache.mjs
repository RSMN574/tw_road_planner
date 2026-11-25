// realtime-cache.mjs — RealtimeDataCache（v1.19）：即時資料共用的快取、請求合併、逾時、錯誤冷卻、上游呼叫預算
// ・同一個鍵在 ttl 內直接回快取；同時進來的相同請求只打一次上游
// ・上游失敗：錯誤也快取 errTtl 秒（不連續轟炸 TDX）；有舊資料時回舊資料並標示 stale
// ・每分鐘上游呼叫上限（REALTIME_MAX_CALLS_PER_MIN）：超過時有舊資料就回舊資料，沒有就回 503——不為了即時而超過 API 使用限制
import { ApiError } from '../http-util.mjs';

export function createRealtimeCache({ now = () => Date.now(), maxEntries = 3000, maxCallsPerMin = 300 } = {}) {
  const map = new Map(), inflight = new Map(), calls = [], stats = { hits: 0, misses: 0, shared: 0, errors: 0, timeouts: 0, budgetDenied: 0, upstreamCalls: 0 };
  const budgetOk = () => { const t = now(); while (calls.length && t - calls[0] > 60e3) calls.shift(); return calls.length < maxCallsPerMin; };
  // 回傳 { value, fetchedAt, cached, stale, error }；loader 回傳 value（失敗就丟錯）
  async function get(key, { ttlMs, errTtlMs = 10e3, timeoutMs = 9000 }, loader) {
    const t = now(), e = map.get(key);
    if (e && !e.error && t - e.fetchedAt < ttlMs) { stats.hits++; return { value: e.value, fetchedAt: e.fetchedAt, cached: true, stale: false }; }
    if (e && e.error && t - e.errAt < errTtlMs) { stats.hits++; return e.last ? { value: e.last.value, fetchedAt: e.last.fetchedAt, cached: true, stale: true, error: e.error } : { error: e.error, fetchedAt: null }; }
    if (inflight.has(key)) { stats.shared++; return inflight.get(key); }
    if (!budgetOk()) { stats.budgetDenied++; const last = e && (e.error ? e.last : e); if (last) return { value: last.value, fetchedAt: last.fetchedAt, cached: true, stale: true, error: '已達每分鐘上游呼叫上限，暫用上一筆資料' }; throw new ApiError(503, 'REALTIME_BUDGET', '即時資料請求過多，請稍後再試'); }
    stats.misses++; calls.push(t); stats.upstreamCalls++;
    const p = (async () => {
      let timer; try {
        const v = await Promise.race([loader(), new Promise((_, rej) => { timer = setTimeout(() => { stats.timeouts++; rej(new Error('上游逾時')); }, timeoutMs); })]);
        const rec = { value: v, fetchedAt: now() }; map.set(key, rec); trim(); return { value: v, fetchedAt: rec.fetchedAt, cached: false, stale: false };
      } catch (err) {
        stats.errors++; const prev = map.get(key), last = prev ? (prev.error ? prev.last : prev) : null;
        map.set(key, { error: err.message || String(err), errAt: now(), last }); trim();
        return last ? { value: last.value, fetchedAt: last.fetchedAt, cached: true, stale: true, error: err.message } : { error: err.message || String(err), fetchedAt: null };
      } finally { clearTimeout(timer); inflight.delete(key); }
    })();
    inflight.set(key, p); return p;
  }
  function trim() { while (map.size > maxEntries) map.delete(map.keys().next().value); }
  return { get, stats, get size() { return map.size; }, callsLastMin: () => { budgetOk(); return calls.length; } };
}
