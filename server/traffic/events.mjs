// events.mjs — TrafficEventEngine（v1.11）：TDX 道路事件 → 統一格式 → 對應到 OSM 道路圖的有向邊 → 路線規劃的封閉／加權
//
// 資料：使用者提供的 OAS「道路事件 v1」（docs/oas/tdx-road-event-v1.json）
//   /v1/Traffic/RoadEvent/LiveEvent/Freeway、/LiveEvent/Highway、/LiveEvent/City/{City}（即時事件）
//   /v1/Traffic/RoadEvent/Event/Highway、/Event/City/{City}（預告性事件，例如施工、管制；Impact.Duration 有發生期間）
//   回應是包裝物件 { UpdateTime, UpdateInterval, SrcUpdateTime, AuthorityCode, Items: [...] }
// 每筆事件統一成：eventId、type、source、affectedRoad、geometry、startTime、endTime、severity、confidence、updatedAt（＋原始欄位 raw）
// 只用實際取得的資料；沒有座標的事件不猜位置（只列出，不影響路線）。
import { parseStamp } from '../transit/time.mjs';
import { parseWkt } from '../transit/rail-provider.mjs';

export const EVENT_TYPE = { 1: '交通事故', 2: '施工', 3: '壅塞', 4: '特殊管制', 5: '天氣', 6: '災害', 7: '活動', 8: '其它異常告警' };
export const SEVERITY = { '-99': '來源未提供', 0: '無影響', 1: '部分阻斷交通', 2: '完全阻斷交通', 254: '其他', 255: '未知' };
const DIR_DEG = { 北向: 0, 東北向: 45, 東向: 90, 東南向: 135, 南向: 180, 西南向: 225, 西向: 270, 西北向: 315 };
const inTW = (lon, lat) => lon > 116 && lon < 123.5 && lat > 20 && lat < 27;

// 「事件代表點位坐標」（Positions）：WKT POINT、或「經度,緯度」「經度 緯度」，依數值範圍判斷哪個是經度
export function parsePositions(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const w = parseWkt(s); if (w) return w;
  const nums = s.split(/[\s,;]+/).map(Number).filter(Number.isFinite); if (nums.length < 2) return null;
  const pts = []; for (let i = 0; i + 1 < nums.length; i += 2) { const [a, b] = [nums[i], nums[i + 1]]; if (inTW(a, b)) pts.push([a, b]); else if (inTW(b, a)) pts.push([b, a]); }
  return pts.length ? [pts] : null;
}
function roadsOf(loc) {
  const out = [], push = (r, dir) => { if (r && typeof r === 'string') out.push({ road: r.trim(), direction: dir || null }); };
  if (!loc) return out;
  const f = loc.FreeExpressHighway; if (f) push(f.Road, f.Direction);
  for (const r of (loc.CityRoad && loc.CityRoad.Roadways) || []) push(r.Road, r.Direction);
  if (loc.Intersection) for (const r of loc.Intersection.Roads || []) push(r, null);
  if (loc.Address) push(loc.Address.Road, null);
  return out;
}
// 單筆事件 → 統一格式
export function normalizeEvent(e, { kind = 'live', wrapper = {} } = {}) {
  const imp = e.Impact || {}, dur = imp.Duration || {}, geo = parseWkt(e.Geometry) || parsePositions(e.Positions);
  const start = parseStamp(e.EffectiveTime || dur.DurationStartTime), end = parseStamp(e.ExpireTime || dur.DurationEndTime), upd = parseStamp(e.LastUpdateTime || e.PublishTime || wrapper.UpdateTime);
  const roads = roadsOf(e.Location), sev = imp.Severity ?? null;
  const confidence = geo && roads.length && sev != null && sev !== -99 && sev !== 255 ? 'high' : geo && (roads.length || sev != null) ? 'medium' : geo ? 'low' : 'none';
  return { eventId: String(e.EventID ?? ''), type: EVENT_TYPE[e.EventType] || '未知', typeCode: e.EventType ?? null, subType: e.EventSubType ?? null, kind, title: e.EventTitle || '', description: e.Description || imp.Description || '',
    source: e.Source || wrapper.AuthorityCode || 'TDX', authority: wrapper.AuthorityCode || null, affectedRoad: roads, geometry: geo, locationType: e.LocationType ?? null,
    startTime: Number.isFinite(start) ? start : null, endTime: Number.isFinite(end) ? end : null, severity: sev, severityLabel: SEVERITY[sev] ?? '未知', blockWay: imp.BlockWay ?? null, blockedLanes: imp.BlockedLanes ?? null,
    occur: dur.OccurType != null ? { type: dur.OccurType, days: dur.OccurDays || null, dates: dur.OccurDates || null, start: dur.StartTime || null, end: dur.EndTime || null } : null,
    detour: imp.Detour ? { description: imp.Detour.Description || '', geometry: parseWkt(imp.Detour.Geometry) } : null, confidence, updatedAt: Number.isFinite(upd) ? upd : null };
}
// 實測（2026-11-24）：TDX 回應的陣列鍵是 LiveEvents（即時）／Events（預告），不是 OAS 寫的 Items；同一個 EventID 會重複出現 → 依 EventID＋EventStep 去重
export function normalizeWrapper(w, kind) {
  const items = (w && (w.LiveEvents || w.Events || w.Items || w.items)) || (Array.isArray(w) ? w : []), seen = new Set(), out = [];
  for (const e of items) { const k = String(e.EventID) + '|' + (e.EventStep ?? ''); if (seen.has(k)) continue; seen.add(k); out.push(normalizeEvent(e, { kind, wrapper: w || {} })); }
  return out;
}
// 事件在 ms 這個時刻是否有效（有開始／結束時間就照時間；預告性事件的 Daily／Weekdays 依 OccurType 判斷時段）
export function eventActive(ev, ms) {
  if (ev.startTime != null && ms < ev.startTime) return false; if (ev.endTime != null && ms > ev.endTime) return false;
  const o = ev.occur; if (!o || o.type === 0 || o.type == null) return true;
  const d = new Date(ms + 8 * 3600e3), wd = d.getUTCDay(), hm = d.getUTCHours() * 60 + d.getUTCMinutes(), t = s => { const m = /^(\d{1,2}):(\d{2})/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };
  if (o.type === 2 && (wd === 0 || wd === 6)) return false; if ((o.type === 3 || o.type === 4) && wd !== 0 && wd !== 6) return o.type === 4 ? null : false;   // 4＝假日：國定假日無法判斷
  if (o.days && o.days.length && !o.days.includes(wd) && !o.days.includes(wd === 0 ? 7 : wd)) return false;
  const a = t(o.start), b = t(o.end); if (a != null && b != null) return a <= b ? hm >= a && hm < b : hm >= a || hm < b;
  return true;
}
// 對路線的影響：完全阻斷 → 封閉；部分阻斷、壅塞、施工 → 時間與成本加成；其他 → 只標示
export function impactOf(ev) {
  if (ev.severity === 2) return { block: true, factor: 1, timeFactor: 1, reason: `${ev.type}：${ev.severityLabel}` };
  if (ev.severity === 1) return { block: false, factor: 2, timeFactor: 1.5, reason: `${ev.type}：部分阻斷` };
  if (ev.typeCode === 3) return { block: false, factor: 1.6, timeFactor: 1.5, reason: '壅塞' };
  if (ev.typeCode === 2 || ev.typeCode === 4) return { block: false, factor: 1.3, timeFactor: 1.2, reason: `${ev.type}（影響程度${ev.severityLabel}）` };
  if (ev.severity === 0) return null;
  return { block: false, factor: 1.2, timeFactor: 1.1, reason: `${ev.type}（影響程度${ev.severityLabel}）` };
}
const nameMatch = (a, b) => !!a && !!b && (a.includes(b) || b.includes(a) || a.replace(/[臺]/g, '台').includes(b.replace(/[臺]/g, '台')));
// 事件 → 有向邊的 overlay：點事件找 60 m 內、線事件找 30 m 內的路段；有路名時路名要對得上（台＝臺），沒有路名的只收 15 m 內最近的路
// at＝null：不看時間（全部對應，給 mapEvents 快取用）
export function buildOverlay(events, router, { at = Date.now(), modes = null } = {}) {
  const ov = new Map(), hits = [], skipped = { inactive: 0, noGeometry: 0, noRoad: 0, noImpact: 0 }, { E, W } = router.g;
  for (const ev of events) {
    if (at != null && eventActive(ev, at) === false) { skipped.inactive++; continue; }
    if (!ev.geometry) { skipped.noGeometry++; continue; }
    const imp = impactOf(ev); if (!imp) { skipped.noImpact++; continue; }
    const pts = ev.geometry.flat(), point = pts.length === 1, rad = point ? 60 : 30, roads = ev.affectedRoad.map(r => r.road);
    const cand = new Map();
    for (let i = 0; i < pts.length; i++) {
      const sample = [pts[i]]; if (!point && i + 1 < pts.length) for (let t = 1; t < 4; t++) sample.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t / 4, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t / 4]);
      for (const [lon, lat] of sample) for (const c of router.snapCandidates(lat, lon, 'car', { windowM: rad, maxM: rad })) {
        const w = E.way[c.e], nm = router.wayName(w), ok = roads.length ? roads.some(r => nameMatch(nm, r) || nameMatch(router.g.strings[W.ref[w]] || '', r)) : c.distM <= 15;
        if (ok && (!cand.has(c.e) || cand.get(c.e).distM > c.distM)) cand.set(c.e, c);
      }
    }
    if (!cand.size) { skipped.noRoad++; continue; }
    // 方向：只阻斷單向（BlockWay=1）且有方向（北向…）時，只影響行進方向相符（±60°）的有向邊
    const dir = ev.blockWay === 1 ? ev.affectedRoad.map(r => DIR_DEG[r.direction]).find(x => x != null) : null;
    let arcs = 0;
    for (const [e, c] of cand) for (const a of [2 * e, 2 * e + 1]) {
      if (dir != null) { const brg = (c.brg + (a & 1 ? 180 : 0)) % 360, d = Math.abs(((brg - dir) % 360 + 540) % 360 - 180); if (d > 60) continue; }
      const o = ov.get(a) || { block: false, factor: 1, timeFactor: 1, events: [] };
      o.block = o.block || imp.block; o.factor = Math.max(o.factor, imp.factor); o.timeFactor = Math.max(o.timeFactor, imp.timeFactor); if (!o.events.includes(ev.eventId)) o.events.push(ev.eventId); ov.set(a, o); arcs++;
    }
    hits.push({ eventId: ev.eventId, arcs, arcList: [...cand.keys()].flatMap(e => [2 * e, 2 * e + 1]).filter(a => { const o = ov.get(a); return o && o.events.includes(ev.eventId); }), impact: imp, block: imp.block, reason: imp.reason, roads, confidence: ev.confidence });
  }
  return { overlay: ov, hits, skipped };
}

// 兩段式（全台實測：對應 3,000 筆事件約 7 秒）：mapEvents 只在事件資料變動時做一次；overlayAt 每分鐘依時間篩選，幾毫秒
export function mapEvents(events, router) { const b = buildOverlay(events, router, { at: null }); return { hits: b.hits, skipped: b.skipped, byId: new Map(events.map(e => [e.eventId, e])) }; }
export function overlayAt(mapped, at) {
  const ov = new Map(), hits = [], skipped = { ...mapped.skipped, inactive: 0 };
  for (const h of mapped.hits) {
    if (eventActive(mapped.byId.get(h.eventId), at) === false) { skipped.inactive++; continue; }
    for (const a of h.arcList) { const o = ov.get(a) || { block: false, factor: 1, timeFactor: 1, events: [] }; o.block = o.block || h.impact.block; o.factor = Math.max(o.factor, h.impact.factor); o.timeFactor = Math.max(o.timeFactor, h.impact.timeFactor); if (!o.events.includes(h.eventId)) o.events.push(h.eventId); ov.set(a, o); }
    hits.push({ eventId: h.eventId, arcs: h.arcList.length, block: h.block, reason: h.reason, roads: h.roads, confidence: h.confidence });
  }
  return { overlay: ov, hits, skipped };
}
