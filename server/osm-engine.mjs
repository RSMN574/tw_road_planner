// osm-engine.mjs — 伺服器端的全台 OSM 道路圖：路線、地圖圖磚、最近道路、路名搜尋
// 圖檔由 tools/osm/osm-build.mjs 產生（data/osm/graph/current.json 指向最新的一份）；沒有圖檔時這些 API 回 503，其他功能照常。
// 在背景執行緒（worker_threads）或主執行緒執行；每個執行緒各載入一份（全台約 300 MB＋各運具用到時才建的表）
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readGraph } from './osm/graph-file.mjs';
import { OsmRouter } from './osm/router.mjs';
import { altLoader, readAltHead } from './osm/alt.mjs';
import { HIGHWAYS } from './osm/tags.mjs';
import { PROFILES, PROFILE_IX, ST, access4 } from './osm/access.mjs';
import { ApiError } from './http-util.mjs';
import { readBuildings, buildingTile, SRC as BLD_SRC } from './osm/buildings.mjs';
import { loadPois, searchPois, nearbyPois, poiDetail, findPoi } from './osm/poi.mjs';
import { CATEGORIES as POI_CATS } from './osm/poi-categories.mjs';
import { readPlacesStatic, STATIC_FILE as PLACES_FILE } from './places/tdx-places.mjs';
import { transitConfigure, transitPlan, transitStatus, transitPrepare } from './transit-engine.mjs';
import { mapEvents, overlayAt, eventActive } from './traffic/events.mjs';
import { buildSections, matchSections, levelTables, liveBySection, flowOverlay, mergeOverlays, routeFlow, simplify as flowSimplify, LV, LV_LABEL } from './traffic/flow.mjs';
import { readGz, STATIC_FILE, LIVE_FILE } from './traffic/flow-sync.mjs';

// ---------- 道路事件（v1.11；tools/traffic-sync.mjs 寫到 CACHE_DIR/traffic/events.json）----------
let traffic = { events: [], fetchedAt: null, sig: '', injected: false }, ovCache = { key: '', v: null };
function loadTraffic() {
  if (traffic.injected || !cfgRef) return traffic;
  const f = path.join(cfgRef.cacheDir || '.cache', 'traffic', 'events.json'); if (!existsSync(f)) { traffic = { events: [], fetchedAt: null, sig: '', injected: false }; return traffic; }
  const st = statSync(f), sg = st.mtimeMs + ':' + st.size; if (sg === traffic.sig) return traffic;
  try { const j = JSON.parse(readFileSync(f, 'utf8')); traffic = { events: j.events || [], fetchedAt: j.fetchedAt || null, source: j.source || 'TDX', sig: sg, injected: false }; } catch { /* 寫到一半：下次再讀 */ }
  return traffic;
}
export function setTrafficEvents(events, fetchedAt = Date.now()) { traffic = { events: events || [], fetchedAt, sig: 'injected:' + Date.now(), injected: true, source: '測試資料' }; ovCache = { key: '', v: null }; }
function trafficOverlay(at) {
  const T = loadTraffic(); if (!T.events.length || !R) return null;
  const mk = T.sig + '|' + info.version; if (!ovCache.mapped || ovCache.mk !== mk) ovCache = { mk, mapped: mapEvents(T.events, R), key: '', v: null };   // 事件位置：資料變了才重算
  const key = Math.floor(at / 60e3); if (ovCache.key === key) return ovCache.v;
  const b = overlayAt(ovCache.mapped, at); ovCache.key = key; ovCache.v = { ...b, fetchedAt: T.fetchedAt, total: T.events.length, source: T.source }; return ovCache.v;
}
// ---------- 即時路況（v1.15；traffic/flow.mjs）----------
// 靜態路段（路段、線形、壅塞水準表）→ 對應到有向邊（約 20 秒；結果存在 CACHE_DIR/traffic/flow-match.json，路網或路段資料變了才重算）
// 即時檔（伺服器每 5 分鐘更新）→ 每個路段的狀態 → 各運具的路網加權（汽車、大型車、機車；步行與自行車不套用）
const FLOW_EMPTY = () => ({ ssig: '', lsig: '', sections: null, states: new Map(), ov: new Map(), fetchedAt: null });
let FL = FLOW_EMPTY();
const FLOW_MODES = new Set(['car', 'heavy', 'moto']), FLOW_WINDOW_MS = 30 * 60e3, FLOW_MAX_AGE_MS = 20 * 60e3;
function loadFlow() {
  if (!R || !cfgRef) return FL;
  const dir = path.join(cfgRef.cacheDir || '.cache', 'traffic'), fS = path.join(dir, STATIC_FILE), fL = path.join(dir, LIVE_FILE);
  if (!existsSync(fS)) { if (FL.sections) FL = FLOW_EMPTY(); return FL; }
  const st = statSync(fS), ss = st.mtimeMs + ':' + st.size + ':' + info.version;
  if (ss !== FL.ssig) {
    const S = readGz(fS), by = S.byAuthority || {}, sections = buildSections(by), tables = levelTables(Object.fromEntries(Object.entries(by).map(([a, d]) => [a, d.levels])));
    const fM = path.join(dir, 'flow-match.json'); let match = null;
    try { const c = JSON.parse(readFileSync(fM, 'utf8')); if (c.key === ss) match = { arcSec: new Map(c.arcs.map((a, i) => [a, c.secs[i]])), stats: c.stats }; } catch { /* 沒有快取 */ }
    if (!match) { match = matchSections(sections, R); try { writeFileSync(fM + '.tmp', JSON.stringify({ key: ss, arcs: [...match.arcSec.keys()], secs: [...match.arcSec.values()], stats: match.stats })); renameSync(fM + '.tmp', fM); } catch { /* 唯讀：下次再算 */ } }
    const { V, E } = R.g, secArcs = sections.map(() => []), box = new Float64Array(sections.length * 4).fill(NaN);
    for (const [a, si] of match.arcSec) { secArcs[si].push(a); for (const v of [E.u[a >> 1], E.v[a >> 1]]) { const lo = V.lon[v] / 1e7, la = V.lat[v] / 1e7, b = si * 4; if (!(box[b] <= lo)) box[b] = lo; if (!(box[b + 2] >= lo)) box[b + 2] = lo; if (!(box[b + 1] <= la)) box[b + 1] = la; if (!(box[b + 3] >= la)) box[b + 3] = la; } }
    FL = { ...FLOW_EMPTY(), ssig: ss, sections, tables, match, secArcs, box, staticAt: S.fetchedAt || null, authorities: Object.keys(by) };
  }
  if (existsSync(fL)) { const s2 = statSync(fL), ls = s2.mtimeMs + ':' + s2.size; if (ls !== FL.lsig) { try { const L = readGz(fL); FL.states = liveBySection(L, FL.tables, FL.sections); FL.fetchedAt = L.fetchedAt || null; FL.liveAuth = Object.entries(L.byAuthority || {}).map(([a, w]) => [a, (w.LiveTraffics || []).length]); FL.lsig = ls; FL.ov = new Map(); } catch { /* 寫到一半 */ } } }
  return FL;
}
// 這次規劃要用的即時路況加權（只用在出發時間 30 分鐘內、資料 20 分鐘內的路段）
function flowFor(key, at) {
  const F = loadFlow(); if (!F.sections || !F.states.size || !FLOW_MODES.has(key) || Math.abs(at - Date.now()) > FLOW_WINDOW_MS) return null;
  const k = key + '|' + Math.floor(Date.now() / 60e3); let o = F.ov.get(k);
  if (!o) { F.ov = new Map(); o = flowOverlay(F.match, F.sections, F.states, R.profile(key), R, { maxAgeMs: FLOW_MAX_AGE_MS }); F.ov.set(k, o); }
  return o;
}
// 路線經過的路況：每一小段的狀態＋各狀態的長度
function flowOfRoute(r) {
  const F = FL; if (!F.sections || !F.states.size || !r.segArc) return undefined;
  const c = r.coords, len = []; for (let i = 0; i + 1 < c.length; i++) { const R0 = Math.PI / 180, a = c[i], b = c[i + 1], h = Math.sin((b[1] - a[1]) * R0 / 2) ** 2 + Math.cos(a[1] * R0) * Math.cos(b[1] * R0) * Math.sin((b[0] - a[0]) * R0 / 2) ** 2; len.push(12742000 * Math.asin(Math.sqrt(h))); }
  return routeFlow(r.arcs, r.segArc, len, F.match, F.sections, F.states);
}
export function osmTrafficFlow(q = {}) {
  need(); const F = loadFlow(), base = { available: !!(F.sections && F.states.size), fetchedAt: F.fetchedAt ? new Date(F.fetchedAt).toISOString() : null, staticAt: F.staticAt ? new Date(F.staticAt).toISOString() : null, source: 'TDX 路況資訊 v2', levels: LV_LABEL };
  if (!F.sections) return { ...base, sections: [], note: '沒有即時路況資料：執行 npm run traffic:flow，或在 .env 設 TDX 金鑰讓伺服器自動更新（TRAFFIC_POLL_MIN）' };
  if (!q.bbox) return { ...base, sectionsTotal: F.sections.length, matchedArcs: F.match.arcSec.size, match: F.match.stats, live: F.liveAuth || [], counts: (() => { const c = {}; for (const x of F.states.values()) c[LV_LABEL[x.lv]] = (c[LV_LABEL[x.lv]] || 0) + 1; return c; })() };
  const bb = String(q.bbox).split(',').map(Number); if (bb.length !== 4 || bb.some(x => !Number.isFinite(x))) throw new ApiError(400, 'BAD_PARAM', 'bbox 需要「西,南,東,北」');
  const wide = bb[2] - bb[0] > 0.6, tol = (bb[2] - bb[0]) / 1500, out = [], now = Date.now();
  for (let si = 0; si < F.sections.length && out.length < 4000; si++) {
    const b = si * 4; if (!(F.box[b] <= bb[2] && F.box[b + 2] >= bb[0] && F.box[b + 1] <= bb[3] && F.box[b + 3] >= bb[1])) continue;
    const sec = F.sections[si], st = F.states.get(sec.key); if (!st || st.lv === LV.UNKNOWN || (st.at && now - st.at > FLOW_MAX_AGE_MS)) continue;
    if (wide && !(sec.cls === 0 || sec.cls === 1)) continue;                                       // 縮很小時只畫國道、快速道路
    const lines = []; let cur = null;
    for (const a of F.secArcs[si]) { const e = a >> 1, L = R.g.E.len[e], p = a & 1 ? R.cut(e, 0, L).reverse() : R.cut(e, 0, L);
      if (cur && Math.abs(cur[cur.length - 1][0] - p[0][0]) < 1e-7 && Math.abs(cur[cur.length - 1][1] - p[0][1]) < 1e-7) cur.push(...p.slice(1)); else { cur = p.slice(); lines.push(cur); } }
    out.push({ k: sec.key, n: sec.name, lv: st.lv, v: st.v, g: lines.map(l => flowSimplify(l, tol).map(([lo, la]) => [+lo.toFixed(5), +la.toFixed(5)])) });
  }
  return { ...base, sections: out, truncated: out.length >= 4000 };
}
export function osmTrafficEvents(q = {}) {
  need(); const T = loadTraffic(), at = departMs(q.at), o = trafficOverlay(at), hit = new Map((o ? o.hits : []).map(h => [h.eventId, h]));
  return { available: T.events.length > 0, fetchedAt: T.fetchedAt ? new Date(T.fetchedAt).toISOString() : null, source: T.source || null, at: new Date(at).toISOString(),
    // bbox=西,南,東,北（地圖圖層用）：只回這個範圍內、現在有效的事件，欄位精簡、最多 400 筆
    events: (() => { const bb = q.bbox ? String(q.bbox).split(',').map(Number) : null; if (bb && (bb.length !== 4 || bb.some(x => !Number.isFinite(x)))) throw new ApiError(400, 'BAD_PARAM', 'bbox 需要「西,南,東,北」');
      if (!bb) return T.events.map(e => ({ ...e, active: eventActive(e, at), mapped: hit.get(e.eventId) || null }));
      const inB = e => e.geometry && e.geometry.flat().some(([lo, la]) => lo >= bb[0] && lo <= bb[2] && la >= bb[1] && la <= bb[3]);
      return T.events.filter(e => eventActive(e, at) !== false && inB(e)).slice(0, 400).map(e => { const g = e.geometry.flat(), c = g.reduce((a, p) => [a[0] + p[0] / g.length, a[1] + p[1] / g.length], [0, 0]);
        return { eventId: e.eventId, type: e.type, typeCode: e.typeCode, title: e.title, description: e.description, severity: e.severity, severityLabel: e.severityLabel, at: [+c[1].toFixed(6), +c[0].toFixed(6)], area: g.length > 1, roads: e.affectedRoad.map(r => r.road), startTime: e.startTime, endTime: e.endTime, source: e.source, mapped: !!hit.get(e.eventId) }; }); })(), skipped: o ? o.skipped : null,
    note: T.events.length ? '只用 TDX 實際提供的事件；沒有座標的不推測位置（列出但不影響路線）' : '沒有道路事件資料：執行 node tools/traffic-sync.mjs（需要 TDX 金鑰）' };
}

let G = null, R = null, info = { loaded: false, reason: 'OSM 道路圖尚未載入' }, cfgRef = null, sig = '', names = null, B = null, bFile = null, P = null, pFile = null;
const MODES = { car: 'car', heavy: 'heavy', moto: 'moto', bike: 'bike', walk: 'foot', foot: 'foot' };
const LABEL = { fastest: '最快', shortest: '最短距離' };
const ESTIMATE = '依速限與道路類別推估（含路口與轉彎延遲，未含即時路況）';
const SHORTEST_MAX_KM = 60;

// ---------- 載入 ----------
function currentFiles(cfg) {
  const dir = cfg.osm.dir, cur = path.join(dir, 'current.json');
  if (!existsSync(cur)) return null;
  const c = JSON.parse(readFileSync(cur, 'utf8')), gf = path.join(dir, c.graph), d = path.dirname(gf);
  return { cur, graph: gf, alt: path.join(d, 'osm-alt.bin'), manifest: path.join(d, 'manifest.json'), buildings: path.join(d, 'osm-buildings.twbld'), poi: path.join(d, 'osm-poi.json.gz'), current: c };
}
const fileSig = f => f ? [f.cur, f.graph, f.alt, f.buildings, f.poi].filter(existsSync).map(x => `${x}:${statSync(x).mtimeMs}:${statSync(x).size}`).join('|') : '';
export function loadOsm(cfg) {
  cfgRef = cfg; const t0 = Date.now(); transitConfigure(cfg);
  if (!cfg.osm || !cfg.osm.enabled) { info = { loaded: false, disabled: true, reason: 'OSM 道路圖已停用（OSM=0）' }; G = R = null; names = major = null; return info; }
  const f = currentFiles(cfg); if (!f || !existsSync(f.graph)) { info = { loaded: false, reason: `沒有 OSM 道路圖（${path.join(cfg.osm.dir, 'current.json')}）；用 npm run osm:build 建立` }; G = R = null; return info; }
  G = readGraph(f.graph); names = major = null;
  let alt = null, altInfo = null;
  if (existsSync(f.alt)) { try { const h = readAltHead(f.alt).head; if (!h.meta || !h.meta.graphCreated || h.meta.graphCreated === G.head.created) { alt = altLoader(f.alt); altInfo = Object.keys(h.profiles); } } catch { alt = null; } }
  R = new OsmRouter(G, { alt });
  const man = existsSync(f.manifest) ? JSON.parse(readFileSync(f.manifest, 'utf8')) : {};
  sig = fileSig(f); B = null; P = null; pFile = existsSync(f.poi) ? f.poi : null;   // 店家地點：預熱時載入（沒預熱就第一次查詢時；約 2 秒、堆積約 115 MB）
  bFile = existsSync(f.buildings) ? f.buildings : null;   // 建築檔第一次用到時才載入（約 70 MB）
  const bRep = bFile && existsSync(path.join(path.dirname(f.graph), 'buildings-report.json')) ? JSON.parse(readFileSync(path.join(path.dirname(f.graph), 'buildings-report.json'), 'utf8')) : null;
  info = { loaded: true, dir: path.relative(cfg.dataDir, path.dirname(f.graph)).split(path.sep).join('/'), vertices: G.V.n, edges: G.E.n, ways: G.W.n, dataTimestamp: f.current.dataTimestamp || G.header?.replication?.timestamp || null,
    builtAt: f.current.builtAt || man.builtAt || null, source: man.source || null, sourceMd5: man.sourceMd5 || null, sourceMd5Verified: !!man.sourceMd5Verified, alt: altInfo, modes: Object.keys(MODES).filter(m => m !== 'foot'), loadMs: Date.now() - t0,
    version: `${f.current.dir}|${f.current.builtAt || ''}`,
    flow: (() => { const F = FL; return F.sections ? { available: F.states.size > 0, sections: F.sections.length, fetchedAt: F.fetchedAt ? new Date(F.fetchedAt).toISOString() : null } : { available: false }; })(),
    poi: pFile ? { available: true, version: String(Math.round(statSync(pFile).mtimeMs)) + (plSig ? '+' + plSig : ''), tdxPlaces: P && P.D.placesStats ? P.D.placesStats : null } : { available: false, reason: '沒有 osm-poi.json.gz；用 npm run osm:poi 建立' },
    buildings: bFile ? { available: true, count: bRep ? bRep.count : null, heightSourcePct: bRep ? bRep.heightSourcePct : null, version: String(Math.round(statSync(bFile).mtimeMs)), minZoom512: 15 } : { available: false, reason: '沒有 osm-buildings.twbld；用 npm run osm:buildings 建立' } };
  return info;
}
export const osmInfo = () => info;
export function osmReloadIfChanged() { if (!cfgRef) return false; const s = fileSig(currentFiles(cfgRef)); if (s === sig) return false; loadOsm(cfgRef); return true; }
// 預熱：建好常用運具的表（第一位使用者不用等 1～2 秒）
export function osmWarmup(modes = []) {
  if (!R) return 0; const t0 = Date.now();
  for (const m of modes) { const k = MODES[m]; if (!k) continue; R.components(k); R.altFor(k); }
  if (modes.length) { R.edgeIndex(); R.turnGeo(); }
  try { const t = Date.now(), ok = transitPrepare(R); if (ok) console.log(`   大眾運輸轉乘預先建立：${Date.now() - t} ms`); } catch (e) { /* 沒有大眾運輸資料：第一次查詢時回 503 */ }
  try { loadTraffic(); trafficOverlay(Date.now()); } catch { /* 沒有道路事件 */ }
  try { const t = Date.now(), F = loadFlow(); if (F.sections) console.log(`   即時路況：${F.sections.length} 個路段、對應 ${F.match.arcSec.size} 段有向邊，${Date.now() - t} ms`); } catch (e) { console.warn('   即時路況載入失敗：' + e.message); }
  try { if (pFile && !P) { const t = Date.now(); needPoi(); console.log(`   店家地點索引：${P.n} 筆${P.D.placesStats ? `（含 TDX 停車場 ${P.D.placesStats.tdxParking}、充電站 ${P.D.placesStats.tdxCharging}）` : ''}，${Date.now() - t} ms`); } } catch (e) { console.warn('   店家地點載入失敗：' + e.message); }
  return Date.now() - t0;
}
const need = () => { if (!R) throw new ApiError(503, 'OSM_NOT_LOADED', info.reason || '伺服器沒有載入 OSM 道路圖'); };
const num = (v, name, lo, hi) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new ApiError(400, 'BAD_PARAM', `${name} 需要介於 ${lo}～${hi} 的數字`, { got: v ?? null }); return x; };
function latLon(v, name) {
  if (v && typeof v === 'object') return [num(v.lat, name + '.lat', -90, 90), num(v.lon ?? v.lng, name + '.lon', -180, 180)];
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(v ?? ''));
  if (!m) throw new ApiError(400, 'BAD_COORD', `${name} 需要「緯度,經度」（WGS84，例如 25.0478,121.5170）`, { got: v ?? null });
  return [num(m[1], name + ' 緯度', -90, 90), num(m[2], name + ' 經度', -180, 180)];
}
const bool = (v, d) => v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v));
const r6 = x => Math.round(x * 1e6) / 1e6;
// 出發時間：ISO 字串、毫秒、'now'；給條件式轉向限制用。沒給＝現在（伺服器會先換成 5 分鐘一格的時間，快取鍵才正確）
export function departMs(v, now = Date.now()) {
  if (v === undefined || v === null || v === '' || v === 'now') return now;
  if (/^\d{10,14}$/.test(String(v))) return +v;
  const t = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(v)) ? String(v) : String(v) + '+08:00');
  if (!Number.isFinite(t)) throw new ApiError(400, 'BAD_PARAM', 'depart 需要 ISO 時間（例如 2026-11-20T08:00）、毫秒或 now', { got: v });
  return t;
}

// ---------- 路線 ----------
// q：from、to（緯度,經度）、mode（car／heavy／moto／bike／walk）、alternatives（預設 1：最快＋最短）、heading（偏航重新規劃時的行進方向，度）、steps（預設 1）
export function osmRoute(q) {
  need(); const mode = q.mode || 'car', key = MODES[mode];
  if (!key) throw new ApiError(400, 'BAD_MODE', `mode 只能是 ${Object.keys(MODES).filter(m => m !== 'foot').join('、')}`);
  const from = latLon(q.from, 'from'), to = latLon(q.to, 'to'), via = parseVia(q.via), heading = q.heading === undefined || q.heading === '' ? null : num(q.heading, 'heading', -360, 720);
  const at = bool(q.conditional, true) ? departMs(q.depart) : null;   // conditional=0：不判斷時段（舊行為：有條件的限制一律不套用）
  const tov = bool(q.events, true) ? trafficOverlay(at ?? departMs(q.depart)) : null; let overlay = tov && tov.overlay.size ? tov.overlay : null;   // events=0：不考慮道路事件
  const fl = bool(q.traffic, true) ? flowFor(key, at ?? departMs(q.depart)) : null; if (fl && fl.overlay.size) overlay = mergeOverlays(overlay, fl.overlay);   // traffic=0：不用即時路況
  // 最短距離：只在直線距離 ≤ 60 km 時另外算（長距離的「最短」幾乎都是繞山路、小路，時間多很多，又要多花 1 秒以上）；alternatives=all 一律算
  const pts = [from, ...via, to], crowKm = pts.slice(1).reduce((a, p, i) => a + Math.hypot((p[0] - pts[i][0]) * 110.6, (p[1] - pts[i][1]) * 111.3 * Math.cos(p[0] * Math.PI / 180)), 0), alt = String(q.alternatives ?? '1');
  const kinds = /^(all|2)$/i.test(alt) || (bool(alt, true) && crowKm <= SHORTEST_MAX_KM) ? ['fastest', 'shortest'] : ['fastest'], out = [];
  for (const kind of kinds) {
    const r = via.length ? routeVia(pts, { profile: key, metric: kind === 'shortest' ? 'distance' : 'time', heading, at, overlay }) : R.route({ from, to, profile: key, metric: kind === 'shortest' ? 'distance' : 'time', heading, at, overlay });
    if (r.error) { if (kind === 'fastest') throw new ApiError(r.error === 'NO_NEARBY_ROAD' ? 422 : 404, r.error, r.message, r.snap ? { snap: r.snap } : undefined); continue; }
    if (kind === 'shortest' && out[0] && out[0]._arcs === r.arcs.join(',')) { out[0].alsoShortest = true; continue; }   // 最短＝最快：只回一條
    out.push({ key: kind, label: LABEL[kind], ok: true, distanceM: r.distanceM, durationS: r.durationS, driveS: r.driveS, delayS: r.delayS, estimate: ESTIMATE,
      geometry: r.coords.map(([lo, la]) => [r6(lo), r6(la)]), roads: r.roads, ways: r.ways.map(w => ({ name: w.name, ref: w.ref, highway: w.highway, m: w.m, limitKmh: w.limitKmh, limitSrc: w.limitSrc })),
      steps: bool(q.steps, true) ? r.steps.map(s => ({ ...s, at: s.at ? [r6(s.at[0]), r6(s.at[1])] : undefined })) : undefined,
      timing: r.timing, legs: r.legs, flow: flowOfRoute(r), signals: r.signals, ferries: r.ferries, warnings: r.warnings, snap: r.snap, conditionalRestrictionsIgnored: r.conditionalRestrictionsIgnored, conditionalRestrictions: r.conditionalRestrictions, events: r.events && r.events.length ? r.events : undefined, _arcs: r.arcs.join(',') });
  }
  for (const o of out) delete o._arcs;
  const notes = []; if (kinds.length === 1 && bool(alt, true)) notes.push(`直線距離 ${Math.round(crowKm)} km：長距離只提供最快路線（最短距離路線通常繞山路、小路）`);
  if (tov && tov.hits.length) { const used = new Set(out.flatMap(o => (o.events || []).map(x => x.id))); notes.push(`道路事件：${tov.hits.length} 筆有效事件已對應到路網（封閉 ${tov.hits.filter(h => h.block).length} 筆避開、其餘加權）${used.size ? `；路線經過 ${used.size} 筆事件的路段` : ''}`); }
  if (at != null) notes.push(`轉向限制的時段條件依出發時間 ${new Date(at + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')}（台北）判斷`);
  if (fl) notes.push(`即時路況：${fl.arcs.toLocaleString()} 段道路依 TDX 即時速度加權（${FL.fetchedAt ? new Date(FL.fetchedAt + 8 * 3600e3).toISOString().slice(11, 16) : '—'} 更新）`);
  else if (FL.sections && FLOW_MODES.has(key) && FL.states.size && Math.abs((at ?? departMs(q.depart)) - Date.now()) > FLOW_WINDOW_MS) notes.push('即時路況只用在 30 分鐘內出發的路線');
  if (via.length) notes.push(`途經 ${via.length} 個地點：分段規劃後接起來（每段各自最快／最短；不含在途經點停留的時間）`);
  return { engine: 'osm', mode, via: via.length ? via.map(([la, lo]) => [r6(la), r6(lo)]) : undefined, traffic: tov ? { events: tov.total, mapped: tov.hits.length, blocked: tov.hits.filter(h => h.block).length, fetchedAt: tov.fetchedAt ? new Date(tov.fetchedAt).toISOString() : null, source: tov.source, reasons: Object.fromEntries(tov.hits.filter(h => out.some(o => (o.events || []).some(x => x.id === h.eventId))).map(h => [h.eventId, h.reason])) } : null, depart: at != null ? new Date(at).toISOString() : null, data: { dataTimestamp: info.dataTimestamp, builtAt: info.builtAt, source: 'OpenStreetMap（© OpenStreetMap contributors，ODbL）' }, routes: out, notes };
}

// ---------- 途經點（v1.14）：via=緯度,經度;緯度,經度（最多 MAX_VIA 個）----------
const MAX_VIA = 5;
function parseVia(v) {
  if (v === undefined || v === null || v === '') return [];
  const parts = (Array.isArray(v) ? v : String(v).split(/[;|]/)).map(x => (typeof x === 'string' ? x.trim() : x)).filter(x => x !== '' && x != null);
  if (parts.length > MAX_VIA) throw new ApiError(400, 'TOO_MANY_VIA', `途經點最多 ${MAX_VIA} 個`, { got: parts.length });
  return parts.map((p, i) => latLon(p, `via[${i}]`));
}
// 分段規劃 A→V1→…→B，再接成一條：座標、步驟（中間的「抵達」改成「途經點」）、分段時間、經過的道路、渡輪、事件都依序接起來
// 每一段的出發時間＝前面各段的行駛時間累計（條件式轉向限制、道路事件依那個時間判斷）；heading 只用在第一段
function routeVia(pts, { profile, metric, heading, at, overlay }) {
  const legs = []; let t = at;
  for (let k = 0; k + 1 < pts.length; k++) {
    const r = R.route({ from: pts[k], to: pts[k + 1], profile, metric, heading: k ? null : heading, at: t, overlay });
    if (r.error) return { ...r, message: `第 ${k + 1} 段（${k ? '途經點 ' + k : '起點'} → ${k + 2 < pts.length ? '途經點 ' + (k + 1) : '終點'}）：${r.message}` };
    legs.push(r); if (t != null) t += r.durationS * 1000;
  }
  return mergeLegs(legs);
}
export function mergeLegs(legs) {
  const coords = [], steps = [], ways = [], segS = [], segCls = [], segKnown = [], segWay = [], segArc = [], delays = [], ferries = [], ev = new Map(), out = [], warnings = {}; let arcOff = 0;
  let dist = 0, dur = 0, drive = 0, delay = 0, signals = 0;
  legs.forEach((r, k) => {
    const T = r.timing, same = coords.length && r.coords.length && Math.abs(coords[coords.length - 1][0] - r.coords[0][0]) < 1e-9 && Math.abs(coords[coords.length - 1][1] - r.coords[0][1]) < 1e-9;
    const off = coords.length ? (same ? coords.length - 1 : coords.length) : 0, wOff = ways.length;
    if (coords.length && !same) { segS.push(0); segCls.push(T.segCls[0] ?? 0); segKnown.push(1); segWay.push(wOff); segArc.push(-1); }   // 兩段吸附點不同：補一小段（時間 0）讓分段時間對得上座標
    coords.push(...(same ? r.coords.slice(1) : r.coords));
    segS.push(...T.segS); segCls.push(...T.segCls); segKnown.push(...T.segKnown); segWay.push(...T.segWay.map(w => w + wOff)); segArc.push(...(r.segArc || []).map(x => (x < 0 ? -1 : x + arcOff))); arcOff += r.arcs.length;
    for (const [i, d] of T.delays) delays.push([i + off, d]);
    ways.push(...r.ways);
    for (const s of r.steps) {
      if (k && s.type === 'start') continue;                                   // 第二段起：「出發」併進前一個途經點
      const st = { ...s, index: s.index + off, fromStartM: s.fromStartM + Math.round(dist) };
      if (s.type === 'arrive' && k < legs.length - 1) { st.type = 'waypoint'; st.waypoint = k + 1; }
      steps.push(st);
    }
    for (const f of r.ferries) ferries.push({ ...f, fromStartM: f.fromStartM + Math.round(dist) });
    for (const e of r.events || []) { const h = ev.get(e.id) || { id: e.id, m: 0, extraS: 0 }; h.m += e.m; h.extraS += e.extraS; ev.set(e.id, h); }
    for (const [w, m] of Object.entries(r.warnings || {})) warnings[w] = (warnings[w] || 0) + m;
    dist += r.distanceM; dur += r.durationS; drive += r.driveS; delay += r.delayS; signals += r.signals || 0;
    out.push({ distanceM: r.distanceM, durationS: r.durationS, endIndex: coords.length - 1, snap: r.snap });
  });
  const roads = []; for (const w of ways) { const n = w.name || w.ref; if (n && roads[roads.length - 1] !== n) roads.push(n); }
  const f = legs[0], l = legs[legs.length - 1];
  return { distanceM: dist, durationS: dur, driveS: drive, delayS: delay, arcs: legs.flatMap(r => r.arcs), coords, ways, roads, steps,
    timing: { segS, segCls, segKnown, segWay, delays }, segArc, ferries, signals, warnings,
    conditionalRestrictionsIgnored: f.conditionalRestrictionsIgnored, conditionalRestrictions: f.conditionalRestrictions,
    events: [...ev.values()], legs: out, snap: { ...f.snap, to: l.snap.to, toM: l.snap.toM, via: out.slice(0, -1).map(x => x.snap.to) } };
}

// ---------- 建築圖磚（z 是 512 像素圖磚的層級，≥ 15）----------
export function osmBuildingTile(q) {
  need(); const z = num(q.z, 'z', 0, 20) | 0, x = num(q.x, 'x', 0, 2 ** z - 1) | 0, y = num(q.y, 'y', 0, 2 ** z - 1) | 0;
  if (!bFile) throw new ApiError(404, 'NO_BUILDINGS', '伺服器沒有建築資料（npm run osm:buildings）');
  if (z < 15) return { v: 1, z, x, y, b: [], types: [], names: [], note: '建築只在 z15（512 像素圖磚）以上提供' };
  if (!B) B = readBuildings(bFile);
  return buildingTile(B, z, x, y);
}
export const buildingSources = () => BLD_SRC;

// ---------- 全台大眾運輸（v1.11；transit-engine.mjs）----------
// q：from、to（緯度,經度）、depart（ISO／毫秒／now）、modes（bus,metro,lrt,tra,thsr）、maxWalk（公尺）、maxTransfers
export function osmTransitPlan(q) {
  need(); const from = latLon(q.from, 'from'), to = latLon(q.to, 'to'), modes = String(q.modes || '').split(',').map(x => x.trim()).filter(Boolean);
  const bad = modes.filter(m => !['bus', 'metro', 'lrt', 'tra', 'thsr'].includes(m)); if (bad.length) throw new ApiError(400, 'BAD_MODE', 'modes 只能是 bus、metro、lrt、tra、thsr', { got: bad });
  return transitPlan({ from, to, departMs: departMs(q.depart), modes, maxWalkM: q.maxWalk != null && q.maxWalk !== '' ? num(q.maxWalk, 'maxWalk', 100, 3000) : undefined, maxTransfers: q.maxTransfers != null && q.maxTransfers !== '' ? num(q.maxTransfers, 'maxTransfers', 0, 5) : undefined, walkGeometry: bool(q.walkGeometry, true) }, R);
}
export const osmTransitStatus = () => transitStatus();

// ---------- 店家地點（POI；osm/poi.mjs）----------
// v1.17：TDX 停車場與充電站（CACHE_DIR/places/places-static.json.gz）併入；檔案更新後下一次查詢重新建索引（約 2 秒）
let plSig = '';
const needPoi = () => {
  need(); if (!pFile) throw new ApiError(404, 'NO_POI', '伺服器沒有店家地點資料（npm run osm:poi）');
  const f = path.join(cfgRef.cacheDir || '.cache', 'places', PLACES_FILE), st = existsSync(f) ? statSync(f) : null, sg = st ? st.mtimeMs + ':' + st.size : '';
  if (!P || sg !== plSig) { let places = null; if (sg) try { places = readPlacesStatic(f); } catch { /* 寫到一半：先不併 */ } P = loadPois(pFile, { places }); plSig = places ? sg : ''; }
  return P;
};
// 沒有門牌的地點：補「附近道路」（最近的有名稱道路；只做前幾筆，標示是推出來的）
function withRoad(list) { for (const r of list.slice(0, 20)) if (!r.address) { const c = R.snapCandidates(r.lat, r.lon, 'foot', { windowM: 40, maxM: 150 }).find(x => R.wayName(G.E.way[x.e])); if (c) r.nearRoad = R.wayName(G.E.way[c.e]); } return list; }
const optNear = q => (q.near ? latLon(q.near, 'near') : null);
export function osmPoiSearch(q) {
  const X = needPoi(), s = String(q.q ?? '').trim(); if (!s && !q.category) throw new ApiError(400, 'MISSING_PARAM', '需要 q（店名、品牌或類別）或 category');
  if (q.category && !POI_CATS[q.category]) throw new ApiError(400, 'BAD_PARAM', 'category 不認得（見 /api/v1/poi/categories）');
  const bb = q.bbox ? String(q.bbox).split(',').map(Number) : null; if (bb && (bb.length !== 4 || bb.some(x => !Number.isFinite(x)))) throw new ApiError(400, 'BAD_PARAM', 'bbox 需要「西,南,東,北」');
  const r = searchPois(X, { q: s, near: optNear(q), category: q.category || null, openNow: bool(q.openNow, false), limit: Math.min(30, Math.max(1, +q.limit || 15)), bbox: bb, now: q.at ? departMs(q.at) : Date.now() });
  return { ...r, results: withRoad(r.results), source: '© OpenStreetMap contributors（ODbL）' };
}
export function osmPoiNearby(q) {
  const X = needPoi(), [lat, lon] = latLon(q.lat != null ? { lat: q.lat, lon: q.lon } : q.at, 'lat/lon'); if (q.category && !POI_CATS[q.category]) throw new ApiError(400, 'BAD_PARAM', 'category 不認得');
  const r = nearbyPois(X, { lat, lon, category: q.category || null, radiusKm: num(q.radius ?? 1000, 'radius', 50, 5000) / 1000, limit: Math.min(50, Math.max(1, +q.limit || 20)), openNow: bool(q.openNow, false) });
  return { ...r, results: withRoad(r.results), source: '© OpenStreetMap contributors（ODbL）' };
}
export function osmPoiDetail(q) {
  const X = needPoi(), i = findPoi(X, q.id); if (i < 0) throw new ApiError(404, 'POI_NOT_FOUND', '找不到這個地點（資料可能已更新）');
  const d = poiDetail(X, i); return withRoad([d])[0];
}
export function osmPoiCategories() { const X = needPoi(); return { categories: Object.entries(POI_CATS).map(([code, c]) => ({ code, label: c.label, icon: c.icon, group: c.group, words: c.words, count: X.counts[code] || 0 })), total: X.n }; }

// ---------- 最近的道路 ----------
export function osmNearest(q) {
  need(); const [lat, lon] = latLon(q.lat != null ? { lat: q.lat, lon: q.lon ?? q.lng } : q.at, 'lat/lon'), key = MODES[q.mode || 'car'] || 'car';
  const c = R.snapCandidates(lat, lon, key, { windowM: 0, maxM: Math.min(2000, Math.max(10, +q.radius || 500)) })[0];
  if (!c) throw new ApiError(404, 'NO_ROAD_NEARBY', '附近找不到這種運具可用的道路');
  const { W, E } = G, w = E.way[c.e], lim = R.limitOf(2 * c.e), st = PROFILES.map(p => [p.key, R.status(2 * c.e, PROFILE_IX[p.key]) & 7]);
  return { name: G.strings[W.name[w]] || '', ref: G.strings[W.ref[w]] || '', highway: HIGHWAYS[W.hw[w]], distanceM: Math.round(c.distM), at: [r6(c.lat7 / 1e7), r6(c.lon7 / 1e7)], bearing: Math.round(c.brg),
    limitKmh: Math.round(lim.kmh), limitSrc: lim.src || 'class', osmWay: W.id[w], access: Object.fromEntries(st.map(([k, s]) => [k, ['unknown', 'allowed', 'default_allowed', 'limited', 'restricted', 'default_restricted', 'oneway'][s]])),
    // v1.11：四態＋來源，兩個方向（forward＝順著 OSM way 的方向）
    accessProfile: Object.fromEntries(PROFILES.map(p => [p.key, { forward: access4(R.status(2 * c.e, PROFILE_IX[p.key])), backward: access4(R.status(2 * c.e + 1, PROFILE_IX[p.key])) }])),
    structure: { bridge: !!W.bridge[w], tunnel: !!W.tunnel[w], layer: W.layer[w], level: W.level[w], lanes: W.lanes[w] || null, widthM: Number.isFinite(W.width[w]) && W.width[w] > 0 ? W.width[w] : null } };
}

// ---------- 路名搜尋 ----------
// 同名道路全台很多（中山路…）：依「離 near 多遠」排序，每 2 km 範圍只列一次
function nameIndex() {
  if (names) return names;
  const { W, E } = G, m = new Map();
  for (let w = 0; w < W.n; w++) {
    const n = G.strings[W.name[w]]; if (!n || W.edgeOff[w + 1] <= W.edgeOff[w]) continue;
    const e = W.edgeOff[w] + ((W.edgeOff[w + 1] - W.edgeOff[w]) >> 1), g0 = E.goff[e];
    let a = m.get(n); if (!a) m.set(n, a = []); a.push(G.G.lat[g0], G.G.lon[g0], W.hw[w]);
  }
  return (names = { map: m, list: [...m.keys()] });
}
export function osmSearch(q) {
  need(); const s = String(q.q ?? '').trim(); if (!s) throw new ApiError(400, 'MISSING_PARAM', '缺少參數 q');
  const near = q.near ? latLon(q.near, 'near') : null, lim = Math.min(30, Math.max(1, +q.limit || 15)), N = nameIndex(), hits = [];
  const d2 = (la, lo) => near ? Math.hypot((la / 1e7 - near[0]) * 110.6, (lo / 1e7 - near[1]) * 101.9) : 0;
  for (const name of N.list) {
    if (!name.includes(s)) continue;
    const a = N.map.get(name), seen = [];
    for (let i = 0; i < a.length; i += 3) { const la = a[i], lo = a[i + 1]; if (seen.some(([x, y]) => Math.hypot((x - la) / 1e7 * 110.6, (y - lo) / 1e7 * 101.9) < 2)) continue; seen.push([la, lo]); hits.push({ name, lat: r6(la / 1e7), lon: r6(lo / 1e7), highway: HIGHWAYS[a[i + 2]], km: +d2(la, lo).toFixed(1), exact: name === s }); }
    if (hits.length > 5000) break;
  }
  hits.sort((x, y) => (y.exact - x.exact) || (x.km - y.km) || (x.name.length - y.name.length));
  return { results: hits.slice(0, lim), note: near ? '依離目前地圖中心的距離排序' : '同名道路全台很多，可加 near=緯度,經度 依距離排序' };
}

// ---------- 地圖圖磚 ----------
// 標準 XYZ 編號（Web Mercator 的格子），內容是範圍內的道路折線；不送整張圖給瀏覽器，只送看得到的那一塊
// 座標：圖磚內的整數格點（EXTENT＝4096；x 由西往東、y 由北往南，經緯度線性內插），第一點是絕對值、之後是差值
// 依縮放層級只放看得到的道路等級；同一條 way 相鄰的邊接成一條線；依縮放簡化（Douglas–Peucker，約 0.5 個像素）
const EXTENT = 4096;
const MIN_Z = { motorway: 6, trunk: 6, ferry: 7, primary: 7, secondary: 10, motorway_link: 12, trunk_link: 12, primary_link: 13, tertiary: 12, secondary_link: 13, tertiary_link: 14,
  unclassified: 13, residential: 14, road: 14, living_street: 15, busway: 15, service: 15, pedestrian: 15, track: 15, escape: 15, pier_link: 15, path: 16, cycleway: 15, footway: 16, steps: 16, bridleway: 16, corridor: 17 };
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'ferry', 'motorway_link', 'trunk_link', 'unclassified']);
let major = null;
function majorIndex() {                                                          // 低縮放用：只有主要道路的粗格網（0.05 度）
  if (major) return major;
  const { W, E } = G, Gg = G.G, C = 500000, cells = new Map();
  for (let e = 0; e < E.n; e++) {
    if (!MAJOR.has(HIGHWAYS[W.hw[E.way[e]]])) continue;
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (let k = E.goff[e]; k < E.goff[e + 1]; k++) { const a = Gg.lat[k], b = Gg.lon[k]; if (a < y0) y0 = a; if (a > y1) y1 = a; if (b < x0) x0 = b; if (b > x1) x1 = b; }
    for (let y = Math.floor(y0 / C); y <= Math.floor(y1 / C); y++) for (let x = Math.floor(x0 / C); x <= Math.floor(x1 / C); x++) { const k = y * 10000 + x; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(e); }
  }
  return (major = { C, cells });
}
const tile2lon = (x, z) => x / 2 ** z * 360 - 180, tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
function simplify(pts, tol) {                                                     // pts：[x, y, x, y…]（同一單位）
  const n = pts.length / 2; if (n < 3 || !(tol > 0)) return pts;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const st = [[0, n - 1]];
  while (st.length) {
    const [a, b] = st.pop(), ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay, L2 = dx * dx + dy * dy; let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) { const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, d = Math.hypot(px - t * dx, py - t * dy); if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]); return out;
}
// 首尾相接（同一個格點）的線接成一條（貪婪法；路口有好幾條時隨便接一條，只影響畫法不影響外觀）
function mergeLines(lines) {
  const ends = new Map(), used = new Uint8Array(lines.length), key = (a, i) => a[i] + ',' + a[i + 1], out = [];
  const add = (k, i) => { let a = ends.get(k); if (!a) ends.set(k, a = []); a.push(i); };
  lines.forEach((a, i) => { add(key(a, 0), i); add(key(a, a.length - 2), i); });
  const next = k => { const a = ends.get(k); if (!a) return -1; for (const i of a) if (!used[i]) return i; return -1; };
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue; used[i] = 1; let cur = lines[i].slice();
    for (const dir of [1, 0]) {                                                   // 先往尾端接，再往頭端接
      for (;;) {
        const k = dir ? key(cur, cur.length - 2) : key(cur, 0), j = next(k); if (j < 0) break; used[j] = 1;
        let b = lines[j]; const bHead = key(b, 0) === k;
        if (dir) { if (!bHead) b = rev(b); for (let t = 2; t < b.length; t++) cur.push(b[t]); }
        else { if (bHead) b = rev(b); cur = b.slice(0, b.length - 2).concat(cur); }
      }
    }
    out.push(cur);
  }
  return out;
}
const rev = a => { const r = []; for (let i = a.length - 2; i >= 0; i -= 2) r.push(a[i], a[i + 1]); return r; };
export function osmTile(q) {
  need(); const z = num(q.z, 'z', 0, 20) | 0, x = num(q.x, 'x', 0, 2 ** z - 1) | 0, y = num(q.y, 'y', 0, 2 ** z - 1) | 0;
  const west = tile2lon(x, z), east = tile2lon(x + 1, z), north = tile2lat(y, z), south = tile2lat(y + 1, z), padX = (east - west) * 0.03, padY = (north - south) * 0.03;
  const lo0 = Math.round((west - padX) * 1e7), lo1 = Math.round((east + padX) * 1e7), la0 = Math.round((south - padY) * 1e7), la1 = Math.round((north + padY) * 1e7);
  const { W, E } = G, Gg = G.G, edges = new Set(), out = { v: 2, z, x, y, bbox: [west, south, east, north].map(r6), extent: EXTENT, hw: [], names: [], roads: [], version: info.version };
  if (z >= 12) {
    const X = R.edgeIndex(), cy0 = Math.max(0, Math.floor((la0 - X.y0) / X.C)), cy1 = Math.min(X.ny - 1, Math.floor((la1 - X.y0) / X.C)), cx0 = Math.max(0, Math.floor((lo0 - X.x0) / X.C)), cx1 = Math.min(X.nx - 1, Math.floor((lo1 - X.x0) / X.C));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) { const c = cy * X.nx + cx; for (let i = X.start[c]; i < X.start[c + 1]; i++) edges.add(X.list[i]); }
  } else if (z >= 6) {
    const M = majorIndex();
    for (let cy = Math.floor(la0 / M.C); cy <= Math.floor(la1 / M.C); cy++) for (let cx = Math.floor(lo0 / M.C); cx <= Math.floor(lo1 / M.C); cx++) for (const e of M.cells.get(cy * 10000 + cx) || []) edges.add(e);
  }
  // 留下這個縮放層級看得到、且穿過圖磚的邊，依 way 分組
  const byWay = new Map();
  for (const e of edges) {
    const w = E.way[e], hw = HIGHWAYS[W.hw[w]]; if ((MIN_Z[hw] ?? 16) > z) continue;
    let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (let k = E.goff[e]; k < E.goff[e + 1]; k++) { const a = Gg.lat[k], b = Gg.lon[k]; if (a < y0) y0 = a; if (a > y1) y1 = a; if (b < x0) x0 = b; if (b > x1) x1 = b; }
    if (y1 < la0 || y0 > la1 || x1 < lo0 || x0 > lo1) continue;
    let a = byWay.get(w); if (!a) byWay.set(w, a = []); a.push(e);
  }
  const sx = EXTENT / (east - west) / 1e7, sy = EXTENT / (north - south) / 1e7, wE7 = west * 1e7, nE7 = north * 1e7, tol = EXTENT / 512 * 0.5;
  const hwIx = new Map(), nameIx = new Map(), showNames = z >= 14, pend = new Map();
  const emit = (hw, name, ow, pts, wm = 0) => {
    const s = simplify(pts, tol); let bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (let i = 0; i < s.length; i += 2) { if (s[i] < bx0) bx0 = s[i]; if (s[i] > bx1) bx1 = s[i]; if (s[i + 1] < by0) by0 = s[i + 1]; if (s[i + 1] > by1) by1 = s[i + 1]; }
    if (s.length < 4 || (bx1 - bx0) + (by1 - by0) < 1) return;                                  // 簡化後只剩一個點：不送（短的 way 不丟，否則長道路會斷成虛線）
    let hi = hwIx.get(hw); if (hi === undefined) { hi = out.hw.length; out.hw.push(hw); hwIx.set(hw, hi); }
    let ni = 0; if (name) { ni = nameIx.get(name); if (ni === undefined) { out.names.push(name); ni = out.names.length; nameIx.set(name, ni); } }
    const c = [s[0], s[1]]; for (let i = 2; i < s.length; i += 2) c.push(s[i] - s[i - 2], s[i + 1] - s[i - 1]);
    out.roads.push(wm ? [hi, ni, ow, c, wm] : [hi, ni, ow, c]);   // 第 5 欄（z15 以上、有資料時）：道路寬度（公尺；OSM width，沒有就 lanes×3.2）
  };
  const take = (w, pts) => {
    const hw = HIGHWAYS[W.hw[w]];
    if (!showNames) { let a = pend.get(hw); if (!a) pend.set(hw, a = []); a.push(pts); return; }  // 低縮放：先收集，同類道路首尾相接的再合併成一條線（圖磚小很多）
    const acc = W.acc[w * PROFILES.length], ow = (acc & 15) === ST.ONEWAY ? -1 : (acc >> 4) === ST.ONEWAY ? 1 : 0;   // 汽車單行：1＝順著線的方向、-1＝逆著
    emit(hw, G.strings[W.name[w]] || G.strings[W.ref[w]] || '', ow, pts, z >= 15 ? (W.width[w] > 0 && W.width[w] < 60 ? Math.round(W.width[w] * 10) / 10 : W.lanes[w] ? Math.round(W.lanes[w] * 32) / 10 : 0) : 0);
  };
  for (const [w, list] of byWay) {
    list.sort((p, q) => p - q);                                                   // 同一條 way 的邊在檔案裡是依序排列的
    let pts = null, prev = -2;
    for (const e of list) {
      const g0 = E.goff[e], g1 = E.goff[e + 1];
      if (pts && e === prev + 1 && Gg.lat[g0] === Gg.lat[E.goff[prev + 1] - 1] && Gg.lon[g0] === Gg.lon[E.goff[prev + 1] - 1]) {
        for (let k = g0 + 1; k < g1; k++) pts.push(Math.round((Gg.lon[k] - wE7) * sx), Math.round((nE7 - Gg.lat[k]) * sy));
      } else {
        if (pts) take(w, pts);
        pts = []; for (let k = g0; k < g1; k++) pts.push(Math.round((Gg.lon[k] - wE7) * sx), Math.round((nE7 - Gg.lat[k]) * sy));
      }
      prev = e;
    }
    if (pts) take(w, pts);
  }
  for (const [hw, lines] of pend) for (const pts of mergeLines(lines)) emit(hw, '', 0, pts);
  return out;
}
