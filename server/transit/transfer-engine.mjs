// transfer-engine.mjs — TransferEngine：站與站之間的轉乘關係（v1.11）
//
// ・站外步行轉乘：用 OSM 步行路網實際走一次（OsmRouter.footReach，有上限的 Dijkstra），不是直線距離；
//   先用直線距離篩出 radiusM 內的候選，再以實際步行時間決定是否相連（走不到、被河或快速道路隔開的就不連）
// ・站內轉乘：TDX 有給的（Metro LineTransfer、StationTransfer 的 MinTransferTime、TransferStations 共站）優先，標示來源
// ・絕不因為站名相同就合併：兩個站是不是同一處，只看座標、步行路徑與 TDX 的轉乘資料
// ・車站本身的進出時間（月台↔地面出口）沒有資料 → 用保守的固定值並標示「推估」（STATION_ACCESS_S）
// ・沒有 OSM 路網時（例如只用本機資料測試）退回「直線 × 1.35 ÷ 1.2 m/s」，每一條都標示是直線推估
export const STATION_ACCESS_S = { tra: 120, thsr: 240, metro: 90, lrt: 30, bus: 0 };     // 進出站（月台到地面）的推估時間
export const MIN_CHANGE_S = { tra: 180, thsr: 300, metro: 60, lrt: 60, bus: 30 };          // 同一站換車至少預留（下車→上另一班）
export const KIND = ['OSM 步行路徑', 'TDX 轉乘資料', '直線距離推估（沒有步行路網）', 'TDX 共站（沒有轉乘時間，依步行推估）'];
const hav = (a, b, c, d) => { const R = Math.PI / 180, h = Math.sin((c - a) * R / 2) ** 2 + Math.cos(a * R) * Math.cos(c * R) * Math.sin((d - b) * R / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))); };

// 站點的格網（約 550 m），查附近的站用
export function stopGrid(stops, C = 0.005) {
  const g = new Map(); stops.forEach((s, i) => { if (s.lat == null) return; const k = Math.floor(s.lat / C) * 100000 + Math.floor(s.lon / C); let a = g.get(k); if (!a) g.set(k, a = []); a.push(i); });
  return { near(lat, lon, rM) { const out = [], r = Math.ceil(rM / 550) + 0; const cy = Math.floor(lat / C), cx = Math.floor(lon / C);
    for (let y = cy - r - 1; y <= cy + r + 1; y++) for (let x = cx - r - 1; x <= cx + r + 1; x++) for (const i of g.get(y * 100000 + x) || []) { const s = stops[i], d = hav(lat, lon, s.lat, s.lon); if (d <= rM) out.push([i, d]); }
    return out; } };
}

export function buildTransfers(store, router = null, { radiusM = 450, maxWalkS = 480, maxBusPairs = 24, log = () => {} } = {}) {
  const t0 = Date.now(), N = store.stops.length, grid = stopGrid(store.stops), lists = Array.from({ length: N }, () => new Map());
  const snaps = new Array(N).fill(null), st = { osmPairs: 0, crowPairs: 0, tdx: 0, colocated: 0, unsnapped: 0, rejectedByWalk: 0 };
  const access = i => STATION_ACCESS_S[store.stops[i].mode] ?? 0;
  if (router) for (let i = 0; i < N; i++) { const s = store.stops[i]; if (s.lat == null) continue; snaps[i] = router.footSnap(s.lat, s.lon, 300); if (!snaps[i]) st.unsnapped++; }
  const pri = k => (k === 1 ? 2 : k === 3 ? 1 : 0);                                // TDX 有時間的 > TDX 共站 > 步行估算
  const put = (i, j, s, m, kind, extra) => { const o = lists[i].get(j); if (!o || pri(kind) > pri(o.kind) || (pri(kind) === pri(o.kind) && s < o.s)) lists[i].set(j, { s, m, kind, ...extra }); };
  for (let i = 0; i < N; i++) {
    const s = store.stops[i]; if (s.lat == null) continue;
    const rail = s.mode !== 'bus', cand = grid.near(s.lat, s.lon, radiusM).filter(([j]) => j !== i); if (!cand.length) continue;
    if (router && snaps[i]) {
      const reach = router.footReach(snaps[i], { maxS: maxWalkS });
      for (const [j] of cand) { const r = snaps[j] ? reach.at(snaps[j]) : null; if (!r) {
        // 軌道／捷運站之間直線 450 m 內、步行路網卻走不到（OSM 常缺站內通道；實測高鐵台中↔台鐵新烏日，TDX StationTransfer 也沒有軌道轉乘）→ 直線推估並標示
        const d = rail && store.stops[j].mode !== 'bus' ? hav(s.lat, s.lon, store.stops[j].lat, store.stops[j].lon) : Infinity;
        if (d <= 450) { put(i, j, Math.round(d * 1.35 / 1.2) + access(i) + access(j), Math.round(d * 1.35), 2); st.crowRail = (st.crowRail || 0) + 1; continue; }
        st.rejectedByWalk++; continue; } put(i, j, r.s + access(i) + access(j), r.m, 0); st.osmPairs++; }
    } else for (const [j, d] of cand) { put(i, j, Math.round(d * 1.35 / 1.2) + access(i) + access(j), Math.round(d * 1.35), 2); st.crowPairs++; }
  }
  // TDX 的站內轉乘：有時間就用；共站沒有時間 → 用上面的步行結果，沒有就 180 秒並標示
  const idx = store.stopIndex;
  for (const t of store.transfers || []) {
    const i = idx.get(t.from), j = idx.get(t.to); if (i == null || j == null || i === j) continue;
    if (t.sec != null) { put(i, j, t.sec, null, 1, { onSite: t.onSite, source: t.source }); st.tdx++; }
    else { const w = lists[i].get(j); put(i, j, w ? w.s : 180, w ? w.m : null, 3, { onSite: t.onSite, source: t.source }); st.colocated++; }
  }
  // v1.16 全台公車：公車站之間只留步行最近的 maxBusPairs 個（實測 15.6 萬站、450 m 內平均 66 個鄰站 → 1,027 萬條，建置 59 秒、查詢變慢）；
  // 連到軌道／捷運站、TDX 轉乘資料的一律保留（換乘鐵路最重要）
  if (maxBusPairs > 0) for (let i = 0; i < N; i++) {
    const L = lists[i]; if (L.size <= maxBusPairs) continue;
    const keep = [], bus = [];
    for (const [j, o] of L) (store.stops[j].mode !== 'bus' || o.kind === 1 || o.kind === 3 ? keep : bus).push([j, o]);
    bus.sort((a, b) => a[1].s - b[1].s); st.prunedBusPairs = (st.prunedBusPairs || 0) + Math.max(0, bus.length - maxBusPairs);
    lists[i] = new Map([...keep, ...bus.slice(0, maxBusPairs)]);
  }
  // 壓成 CSR
  const start = new Int32Array(N + 1); for (let i = 0; i < N; i++) start[i + 1] = start[i] + lists[i].size;
  const to = new Int32Array(start[N]), sec = new Int32Array(start[N]), m = new Int32Array(start[N]), kind = new Uint8Array(start[N]), meta = new Map();
  for (let i = 0; i < N; i++) { let k = start[i]; for (const [j, o] of lists[i]) { to[k] = j; sec[k] = o.s; m[k] = o.m ?? -1; kind[k] = o.kind; if (o.source) meta.set(k, { source: o.source, onSite: o.onSite }); k++; } }
  const out = { start, to, sec, m, kind, meta, snaps, grid, stats: { ...st, pairs: start[N], ms: Date.now() - t0, router: !!router } };
  log(`  轉乘：${start[N]} 條（OSM 步行 ${st.osmPairs}、TDX ${st.tdx}、共站 ${st.colocated}、直線推估 ${st.crowPairs}；步行到不了而排除 ${st.rejectedByWalk}），${out.stats.ms} ms`);
  return out;
}

// v1.16：轉乘結果存檔（全台公車的站點多，步行轉乘要算一兩分鐘）。鍵＝站點（代碼、座標、類別）＋TDX 轉乘資料＋路網版本＋參數；任何一個變了就重算
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
export function transfersKey(store, router, opts = {}) {
  const h = createHash('sha1');
  for (const s of store.stops) h.update(`${s.uid}|${s.lat}|${s.lon}|${s.mode}\n`);
  for (const t of store.transfers || []) h.update(`${t.from}>${t.to}|${t.sec}|${t.onSite}|${t.source}\n`);
  h.update(`${router ? (router.g.head && router.g.head.created) || 'osm' : 'none'}|${opts.radiusM ?? 450}|${opts.maxWalkS ?? 480}|${opts.maxBusPairs ?? 24}|v5`);
  return h.digest('hex').slice(0, 20);
}
export function buildTransfersCached(store, router, { cacheFile = null, log = () => {}, ...opts } = {}) {
  const key = cacheFile ? transfersKey(store, router, opts) : null;
  if (key && existsSync(cacheFile)) {
    try {
      const t0 = Date.now(), c = JSON.parse(gunzipSync(readFileSync(cacheFile)).toString('utf8'));
      if (c.key === key) {
        const snaps = c.snaps.map(x => (x ? { e: x[0], along: x[1], L: x[2], snapM: x[3], lat7: x[4], lon7: x[5], isolated: !!x[6] } : null));
        const out = { start: Int32Array.from(c.start), to: Int32Array.from(c.to), sec: Int32Array.from(c.sec), m: Int32Array.from(c.m), kind: Uint8Array.from(c.kind), meta: new Map(c.meta), snaps, grid: stopGrid(store.stops), stats: { ...c.stats, cached: true, loadMs: Date.now() - t0 } };
        log(`  轉乘：讀取快取 ${out.start[out.start.length - 1]} 條（${out.stats.loadMs} ms）`); return out;
      }
    } catch { /* 快取壞掉：重算 */ }
  }
  const tr = buildTransfers(store, router, { log, ...opts });
  if (key) try {
    const body = { key, start: [...tr.start], to: [...tr.to], sec: [...tr.sec], m: [...tr.m], kind: [...tr.kind], meta: [...tr.meta], snaps: tr.snaps.map(s => (s ? [s.e, s.along, s.L, s.snapM, s.lat7, s.lon7, s.isolated ? 1 : 0] : null)), stats: tr.stats };
    writeFileSync(cacheFile + '.tmp', gzipSync(JSON.stringify(body), { level: 3 })); renameSync(cacheFile + '.tmp', cacheFile);
  } catch (e) { log('  轉乘快取寫入失敗：' + e.message); }
  return tr;
}
