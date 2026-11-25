// bus-realtime.mjs — BusRealtimeService（v1.19）：公車即時到站（N1）、車輛位置（A1）、到離站（A2）、路線線形（Shape）
// 只抓有人在看的站牌、路線（$filter），不輪詢全縣市；透過 RealtimeDataCache 快取、合併請求、限制每分鐘呼叫數
//
// 配對規則（絕不以路線名稱配對）：
//   站牌到站：SubRouteUID（沒有才用 RouteUID）＋Direction＋StopUID（eta-store 的鍵；不同子路線不混）
//   車輛：RouteUID 相同、Direction 相同、SubRouteUID 兩邊都有時必須相同
// 位置：吸附到 TDX 的路線線形（Bus/Shape）上；離線形太遠或沒有線形 → 顯示原始 GPS 並標示，不畫直線動畫
// 新舊：GPSTime 超過 gpsStaleS 秒（預設 180：實測台中 A1 約每分鐘更新一次，取約 3 個週期）→ 過期（灰色、標示幾秒前）；超過 dropS 秒 → 不顯示（不把舊位置當即時位置）
import { createEtaStore, STOP_STATUS } from './eta-store.mjs';
import { parseStamp } from './time.mjs';

export const BUS_STATUS = { 0: '正常', 1: '車禍', 2: '故障', 3: '塞車', 4: '緊急求援', 5: '加油', 90: '不明', 91: '去回不明', 98: '偏移路線', 99: '非營運狀態', 100: '客滿', 101: '包車出租', 255: '未知' };
export const DUTY_STATUS = { 0: '正常', 1: '開始', 2: '結束' };
const SRC = 'TDX 公車動態資訊 v2';
const q = s => `'${String(s).replace(/'/g, "''")}'`;
// 路線型態的來源 → TDX 路徑（A1：RealTimeByFrequency、A2：RealTimeNearStop、N1：EstimatedTimeOfArrival、Shape）
export function busRtPath(source, kind) {
  if (source.kind === 'InterCity') return `/Bus/${kind}/InterCity`;
  if (source.kind === 'TaiwanTrip') return `/Tourism/Bus/${kind}/TaiwanTrip`;
  if (!source.city) return null;
  return `/Bus/${kind}/City/${encodeURIComponent(source.city)}`;
}
const zh = v => (v && typeof v === 'object' ? v.Zh_tw ?? v.En ?? null : v ?? null);

// ---------- 幾何：線形解析、投影 ----------
export function parseLineWkt(wkt) {
  const s = String(wkt || ''), out = [];
  for (const m of s.matchAll(/\(([^()]+)\)/g)) { const line = m[1].split(',').map(p => p.trim().split(/\s+/).map(Number)).filter(p => p.length >= 2 && p.every(Number.isFinite)).map(p => [p[0], p[1]]); if (line.length >= 2) out.push(line); }
  return out;
}
// 多段線形接成一條（依序首尾相接；接不上就以最長的那段為主）
function oneLine(lines) { if (!lines.length) return null; if (lines.length === 1) return lines[0]; const out = [...lines[0]]; for (const l of lines.slice(1)) out.push(...l); return out; }
const K = lat => [111320 * Math.cos(lat * Math.PI / 180), 110574];
// 點投影到折線：{ along（公尺）、distM、pt[lon,lat]、bearing }
export function projectOnLine(line, lon, lat) {
  const [kx, ky] = K(lat); let best = null, acc = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - lon) * kx, ay = (line[i][1] - lat) * ky, bx = (line[i + 1][0] - lon) * kx, by = (line[i + 1][1] - lat) * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, L = Math.sqrt(L2);
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, px = ax + dx * t, py = ay + dy * t, d = Math.hypot(px, py);
    if (!best || d < best.distM) best = { distM: d, along: acc + L * t, pt: [lon + px / kx, lat + py / ky], bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
    acc += L;
  }
  return best;
}
// 簡化（給地圖畫線用；Douglas–Peucker，公尺）
export function simplifyLine(pts, tolM = 4) {
  if (pts.length < 3) return pts; const [kx, ky] = K(pts[0][1]), keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) { const [a, b] = st.pop(); let md = 0, mi = -1; const ax = pts[a][0] * kx, ay = pts[a][1] * ky, bx = pts[b][0] * kx, by = pts[b][1] * ky, dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] * kx - ax) * dy - (pts[i][1] * ky - ay) * dx) / L; if (d > md) { md = d; mi = i; } }
    if (md > tolM) { keep[mi] = 1; st.push([a, mi], [mi, b]); } }
  return pts.filter((_, i) => keep[i]);
}

export function createBusRealtime({ fetchJson, cache, now = () => Date.now(), staleS = 180, gpsStaleS = 180, dropS = 600, snapM = 60, ttl = {} } = {}) {
  const T = { stopEta: 20e3, routeEta: 20e3, a1: 15e3, a2: 15e3, shape: 6 * 3600e3, ...ttl };
  const eta = createEtaStore({ staleS, now });
  const call = async path => { const r = await fetchJson(path); if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`TDX HTTP ${r.status}${r.detail ? '：' + String(r.detail).slice(0, 120) : ''}`); return r.data; };
  const srcKey = s => s.kind + ':' + (s.city || '');
  const get = (key, ms, path) => cache.get(key, { ttlMs: ms }, () => call(path));

  // ---- 站牌：每個路線型態的到站狀態 ----
  function classify(r, live, sch, t) {
    const base = { scheduled: sch };
    if (live.kind === 'live') {
      const arr = live.arrivals.filter(a => a.ms >= t - 30e3).map(a => ({ etaS: Math.max(0, Math.round((a.ms - t) / 1000)), plate: a.plate, last: a.last }));
      if (arr.length) return { ...base, state: 'realtime', label: arr[0].etaS < 60 ? '即將進站' : `約 ${Math.round(arr[0].etaS / 60)} 分`, arrivals: arr, dataMs: live.dataMs, ageS: live.ageS, confidence: live.confidence, lastBus: arr.some(a => a.last) };
      return { ...base, state: 'nodata', label: '即時預估時間已過，等待更新', dataMs: live.dataMs, ageS: live.ageS };
    }
    if (live.kind === 'status') {
      const st = { 1: 'notDeparted', 2: 'noStop', 3: 'ended', 4: 'suspended' }[live.status] || 'status';
      return { ...base, state: st, label: STOP_STATUS[live.status] || live.text, nextBusMs: live.nextBusMs, dataMs: live.dataMs, ageS: live.ageS };
    }
    if (live.kind === 'stale') return { ...base, state: 'stale', label: live.text, dataMs: live.dataMs, ageS: live.ageS };
    // 沒有即時資料：不代表今天不營運——有預定時刻就顯示預定時刻
    if (sch && sch.next && sch.next.length) return { ...base, state: 'scheduled', label: '預定時刻（非即時）', nextBusMs: live.nextBusMs ?? null };
    return { ...base, state: 'nodata', label: live.kind === 'nodata' ? '沒有預估到站時間' : '尚無即時資料', nextBusMs: live.nextBusMs ?? null };
  }
  async function stopArrivals(info) {
    const t = now(), uid = info.stop.uid, groups = new Map(), errors = [];
    for (const r of info.routes) { const p = busRtPath(r.source, 'EstimatedTimeOfArrival'); if (p) groups.set(srcKey(r.source), p); }
    const fetched = {};
    await Promise.all([...groups].map(async ([k, p]) => {
      const res = await get(`n1s|${k}|${uid}`, T.stopEta, `${p}?%24filter=StopUID%20eq%20${encodeURIComponent(q(uid))}&%24format=JSON`);
      if (res.value && !res.cached) eta.ingest(res.value, res.fetchedAt); else if (res.value && res.stale) eta.ingest(res.value, res.fetchedAt);
      fetched[k] = { fetchedAt: res.fetchedAt, stale: !!res.stale, error: res.error || null }; if (res.error) errors.push(res.error);
    }));
    const routes = info.routes.map(r => {
      const f = fetched[srcKey(r.source)], live = r.terminal && r.stops > 1 ? { kind: 'terminal' } : eta.get({ subRouteUID: r.subRouteUID, routeUID: r.routeUID, direction: r.direction, stopUID: uid }, t);
      if (live.kind === 'terminal') return { ...r, rt: { state: 'terminal', label: '終點站（下車）', scheduled: r.scheduled } };
      if (!f || (f.error && !f.fetchedAt)) return { ...r, rt: { ...classify(r, { kind: 'none' }, r.scheduled, t), state: r.scheduled && r.scheduled.next && r.scheduled.next.length ? 'scheduled' : 'error', label: f && f.error ? '即時資料暫時無法取得' : '此路線沒有即時資料來源', error: f && f.error } };
      return { ...r, rt: classify(r, live, r.scheduled, t) };
    });
    return { stop: info.stop, routes, fetchedAt: t, source: SRC + '（EstimatedTimeOfArrival N1）', errors: [...new Set(errors)], staleAfterS: staleS };
  }

  // ---- 路線：車輛位置、目前站、下一站 ----
  async function routeVehicles(ri) {
    const t = now(), s = ri.source, k = srcKey(s), f = `?%24filter=RouteUID%20eq%20${encodeURIComponent(q(ri.routeUID))}&%24format=JSON`;
    const P = x => busRtPath(s, x); if (!P('RealTimeByFrequency')) return { route: ri, vehicles: [], shape: null, note: '這條路線沒有對應的即時資料來源', fetchedAt: t };
    const [a1, a2, n1, sh] = await Promise.all([get(`a1|${k}|${ri.routeUID}`, T.a1, P('RealTimeByFrequency') + f), get(`a2|${k}|${ri.routeUID}`, T.a2, P('RealTimeNearStop') + f),
      get(`n1r|${k}|${ri.routeUID}`, T.routeEta, P('EstimatedTimeOfArrival') + f), get(`shape|${k}|${ri.routeUID}`, T.shape, P('Shape') + f)]);
    const same = x => x && x.RouteUID === ri.routeUID && (ri.direction == null || x.Direction == null || x.Direction === ri.direction) && !(x.SubRouteUID && ri.subRouteUID && x.SubRouteUID !== ri.subRouteUID);
    // 線形：子路線＋方向 → 路線＋方向 → 路線
    const shapes = (sh.value || []).filter(x => x.RouteUID === ri.routeUID);
    const pick = shapes.find(x => x.SubRouteUID === ri.subRouteUID && x.Direction === ri.direction) || shapes.find(x => x.Direction === ri.direction && (!x.SubRouteUID || !ri.subRouteUID)) || (shapes.length === 1 && shapes[0].Direction == null ? shapes[0] : null);
    const line = pick ? oneLine(parseLineWkt(pick.Geometry)) : null;
    const stopAlong = line ? ri.stops.map(st => (st.lat != null ? projectOnLine(line, st.lon, st.lat) : null)) : null;
    const a2by = new Map(); for (const x of (a2.value || []).filter(same)) { const tt = parseStamp(x.GPSTime); const o = a2by.get(x.PlateNumb); if (!o || tt > o.t) a2by.set(x.PlateNumb, { t: tt, x }); }
    const n1by = new Map(); for (const x of (n1.value || []).filter(same)) for (const e of (x.Estimates && x.Estimates.length ? x.Estimates : [{ PlateNumb: x.PlateNumb, EstimateTime: x.EstimateTime }])) if (e.PlateNumb && e.PlateNumb !== '-1' && typeof e.EstimateTime === 'number') n1by.set(e.PlateNumb + '|' + x.StopUID, { s: e.EstimateTime, at: parseStamp(x.SrcUpdateTime || x.UpdateTime) });
    const seqIdx = new Map(ri.stops.map((st, i) => [st.seq, i])), uidIdx = new Map(ri.stops.map((st, i) => [st.uid, i]));
    let dropped = 0; const vehicles = [];
    for (const x of (a1.value || []).filter(same)) {
      const pos = x.BusPosition || {}, lon = +pos.PositionLon, lat = +pos.PositionLat, gt = parseStamp(x.GPSTime) ?? parseStamp(x.SrcUpdateTime); if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(lon > 116 && lon < 123 && lat > 21 && lat < 27)) continue;
      const ageS = Number.isFinite(gt) ? Math.round((t - gt) / 1000) : null; if (ageS == null || ageS > dropS) { dropped++; continue; }
      const pr = line ? projectOnLine(line, lon, lat) : null, snapped = !!(pr && pr.distM <= snapM);
      // 目前站：A2（到離站事件；同一台車、比 A1 舊不超過 3 分鐘）；下一站：A2 進站→下一站是後一站、離站→後一站；沒有 A2 → 依線形上的位置推算
      let cur = null, next = null, how = null; const a = a2by.get(x.PlateNumb);
      if (a && Number.isFinite(a.t) && Number.isFinite(gt) && gt - a.t < 180e3) {
        const i = a.x.StopSequence != null && seqIdx.has(a.x.StopSequence) ? seqIdx.get(a.x.StopSequence) : uidIdx.get(a.x.StopUID);
        if (i != null) { cur = { uid: ri.stops[i].uid, name: ri.stops[i].name, event: a.x.A2EventType === 1 ? '進站' : a.x.A2EventType === 0 ? '離站' : null, atMs: a.t }; next = i + 1 < ri.stops.length ? i + 1 : null; how = 'A2'; }
      }
      if (how == null && snapped && stopAlong) { const i = stopAlong.findIndex(p => p && p.along > pr.along + 15); if (i >= 0) { next = i; how = 'position'; } }
      const ns = next != null ? ri.stops[next] : null, ne = ns ? n1by.get(x.PlateNumb + '|' + ns.uid) : null;
      vehicles.push({ plate: x.PlateNumb, direction: x.Direction ?? null, subRouteUID: x.SubRouteUID ?? null, raw: [lon, lat], pos: snapped ? pr.pt : [lon, lat], snapped, offRouteM: pr ? Math.round(pr.distM) : null,
        azimuth: Number.isFinite(+x.Azimuth) ? +x.Azimuth : snapped ? Math.round(pr.bearing) : null, speedKmh: Number.isFinite(+x.Speed) ? +x.Speed : null, gpsMs: gt, ageS, stale: ageS > gpsStaleS,
        duty: DUTY_STATUS[x.DutyStatus] ?? null, dutyCode: x.DutyStatus ?? null, status: BUS_STATUS[x.BusStatus] ?? null, statusCode: x.BusStatus ?? null,
        current: cur, next: ns ? { uid: ns.uid, name: ns.name, seq: ns.seq, how, etaS: ne && Number.isFinite(ne.at) ? Math.max(0, Math.round(ne.s - (t - ne.at) / 1000)) : null } : null,
        tripStartMs: a ? parseStamp(a.x.TripStartTime) ?? null : null });
    }
    vehicles.sort((u, v) => (u.stale - v.stale) || (u.ageS - v.ageS));
    const err = [a1, a2, n1, sh].map(r => r.error).filter(Boolean);
    return { route: { pattern: ri.pattern, routeUID: ri.routeUID, subRouteUID: ri.subRouteUID, direction: ri.direction, name: ri.name, destination: ri.destination, source: ri.source },
      shape: line ? { coords: simplifyLine(line), source: 'TDX Bus/Shape' } : null, stops: ri.stops, vehicles, hiddenOld: dropped, fetchedAt: t,
      dataAt: { a1: a1.fetchedAt, a2: a2.fetchedAt, n1: n1.fetchedAt }, staleAfterS: gpsStaleS, hiddenAfterS: dropS,
      note: line ? null : '沒有這條路線的線形：位置顯示原始 GPS（未吸附到路線）', errors: [...new Set(err)], source: SRC + '（A1 定時、A2 定點、N1 預估到站、Shape 線形）' };
  }
  return { stopArrivals, routeVehicles, eta };
}
