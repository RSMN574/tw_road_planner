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

export function buildTransfers(store, router = null, { radiusM = 450, maxWalkS = 480, log = () => {} } = {}) {
  const t0 = Date.now(), N = store.stops.length, grid = stopGrid(store.stops), lists = Array.from({ length: N }, () => new Map());
  const snaps = new Array(N).fill(null), st = { osmPairs: 0, crowPairs: 0, tdx: 0, colocated: 0, unsnapped: 0, rejectedByWalk: 0 };
  const access = i => STATION_ACCESS_S[store.stops[i].mode] ?? 0;
  if (router) for (let i = 0; i < N; i++) { const s = store.stops[i]; if (s.lat == null) continue; snaps[i] = router.footSnap(s.lat, s.lon, 300); if (!snaps[i]) st.unsnapped++; }
  const pri = k => (k === 1 ? 2 : k === 3 ? 1 : 0);                                // TDX 有時間的 > TDX 共站 > 步行估算
  const put = (i, j, s, m, kind, extra) => { const o = lists[i].get(j); if (!o || pri(kind) > pri(o.kind) || (pri(kind) === pri(o.kind) && s < o.s)) lists[i].set(j, { s, m, kind, ...extra }); };
  for (let i = 0; i < N; i++) {
    const s = store.stops[i]; if (s.lat == null) continue;
    const cand = grid.near(s.lat, s.lon, radiusM).filter(([j]) => j !== i); if (!cand.length) continue;
    if (router && snaps[i]) {
      const reach = router.footReach(snaps[i], { maxS: maxWalkS });
      for (const [j] of cand) { const r = snaps[j] ? reach.at(snaps[j]) : null; if (!r) { st.rejectedByWalk++; continue; } put(i, j, r.s + access(i) + access(j), r.m, 0); st.osmPairs++; }
    } else for (const [j, d] of cand) { put(i, j, Math.round(d * 1.35 / 1.2) + access(i) + access(j), Math.round(d * 1.35), 2); st.crowPairs++; }
  }
  // TDX 的站內轉乘：有時間就用；共站沒有時間 → 用上面的步行結果，沒有就 180 秒並標示
  const idx = store.stopIndex;
  for (const t of store.transfers || []) {
    const i = idx.get(t.from), j = idx.get(t.to); if (i == null || j == null || i === j) continue;
    if (t.sec != null) { put(i, j, t.sec, null, 1, { onSite: t.onSite, source: t.source }); st.tdx++; }
    else { const w = lists[i].get(j); put(i, j, w ? w.s : 180, w ? w.m : null, 3, { onSite: t.onSite, source: t.source }); st.colocated++; }
  }
  // 壓成 CSR
  const start = new Int32Array(N + 1); for (let i = 0; i < N; i++) start[i + 1] = start[i] + lists[i].size;
  const to = new Int32Array(start[N]), sec = new Int32Array(start[N]), m = new Int32Array(start[N]), kind = new Uint8Array(start[N]), meta = new Map();
  for (let i = 0; i < N; i++) { let k = start[i]; for (const [j, o] of lists[i]) { to[k] = j; sec[k] = o.s; m[k] = o.m ?? -1; kind[k] = o.kind; if (o.source) meta.set(k, { source: o.source, onSite: o.onSite }); k++; } }
  const out = { start, to, sec, m, kind, meta, snaps, grid, stats: { ...st, pairs: start[N], ms: Date.now() - t0, router: !!router } };
  log(`  轉乘：${start[N]} 條（OSM 步行 ${st.osmPairs}、TDX ${st.tdx}、共站 ${st.colocated}、直線推估 ${st.crowPairs}；步行到不了而排除 ${st.rejectedByWalk}），${out.stats.ms} ms`);
  return out;
}
