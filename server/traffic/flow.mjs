// flow.mjs — TDX 即時路況（路況資訊 v2：發布路段、線形、即時速度、壅塞水準）→ 對應到 OSM 路網的有向邊 → 路線時間加權、地圖紅黃綠
//
// 實際回應與 OAS 的差異（2026-11-24 實測）：陣列欄位名是 Sections／SectionShapes／LiveTraffics／CongestionLevels（OAS 寫 Items）；
// 縣市的壅塞級別有到 6，意義依各機關的 CongestionLevelID 表 → 用表裡的 LevelName 分類，不直接看數字。
// 即時路況只有高公局、公路局與 11 個縣市提供（OAS 的 City 列舉）。
import { HIGHWAYS } from '../osm/tags.mjs';

export const FLOW_CITIES = ['Taipei', 'Keelung', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung', 'YilanCounty', 'MiaoliCounty', 'ChanghuaCounty', 'YunlinCounty', 'PingtungCounty'];
export const FLOW_AUTHORITIES = ['Freeway', 'Highway', ...FLOW_CITIES.map(c => 'City/' + c)];
export const LV = { UNKNOWN: 0, FREE: 1, SLOW: 2, JAM: 3, CLOSED: -1 };
export const LV_LABEL = { 0: '無資料', 1: '順暢', 2: '車多', 3: '壅塞', '-1': '道路封閉' };

// 回應的陣列（OAS 寫 Items；實際是 Sections 等）
export const listOf = (w, ...keys) => { if (!w) return []; if (Array.isArray(w)) return w; for (const k of [...keys, 'Items']) if (Array.isArray(w[k])) return w[k]; const a = Object.values(w).find(Array.isArray); return a || []; };

// WKT：LINESTRING／MULTILINESTRING → [[[lon,lat],…],…]
// TDX 的 Geometry 字串最多 500 字（實測：國道 465 條有 445 條被截斷），被截斷時最後一個點的數字不完整 → 丟掉
export const isTruncated = wkt => { const s = String(wkt || '').trim(); return s.length >= 500 && !/\)\s*$/.test(s); };
export function parseLines(wkt) {
  const s = String(wkt || '').trim(); if (!/^(MULTI)?LINESTRING/i.test(s)) return [];
  const parts = s.replace(/^MULTILINESTRING\s*\(/i, '').replace(/^LINESTRING\s*/i, '').split(/\)\s*,\s*\(/);
  if (isTruncated(s)) { const last = parts.length - 1, i = parts[last].lastIndexOf(','); parts[last] = i > 0 ? parts[last].slice(0, i) : ''; }
  return parts.map(p => p.replace(/[()]/g, '').split(',').map(q => q.trim().split(/\s+/).map(Number)).filter(q => q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1]))).filter(l => l.length >= 2);
}

// 壅塞級別名稱 → 分類
export function classifyName(n) {
  const s = String(n || '').trim();
  // 服務水準字母（台北市：A 最好 … F 最差，而且 F 的級別代碼是 0）
  if (/^[AB]$/i.test(s)) return LV.FREE; if (/^[CD]$/i.test(s)) return LV.SLOW; if (/^[EF]$/i.test(s)) return LV.JAM;
  if (/封閉/.test(s)) return LV.CLOSED;
  if (/未知|不足|無資料|異常/.test(s)) return LV.UNKNOWN;
  if (/嚴重|壅塞|擁擠|擁塞|阻塞|雍塞/.test(s)) return LV.JAM;
  if (/車多|稍|緩慢|車流量大/.test(s)) return LV.SLOW;
  if (/順暢|暢通|正常/.test(s)) return LV.FREE;
  return LV.UNKNOWN;
}
// 各機關的壅塞水準表：authority → CongestionLevelID → Level → 分類
export function levelTables(byAuthority) {
  const T = {};
  for (const [auth, w] of Object.entries(byAuthority || {})) {
    const m = T[auth] = {};
    for (const g of listOf(w, 'CongestionLevels')) {
      const x = m[g.CongestionLevelID] = { byLevel: {}, speed: null };
      for (const l of g.Levels || []) x.byLevel[l.Level] = classifyName(l.LevelName);
      // 以速度分級的表：保留速度區間（實測台北市的級別數字和表對不上：資料用 1～6、表寫 0～5，0 其實是「沒有速度」）
      if (g.MeasureIndex === 'Speed') {
        x.speed = (g.Levels || []).filter(l => l.Level !== -1 && l.LowValue != null).map(l => ({ lv: l.Level, lo: +l.LowValue, hi: l.TopValue == null ? Infinity : +l.TopValue, c: classifyName(l.LevelName) })).filter(r => r.c !== LV.UNKNOWN);
        x.range = Object.fromEntries(x.speed.map(r => [r.lv, r]));
      }
    }
  }
  return T;
}
// 一筆即時資料的分類：速度為 0＝沒有資料；以速度分級的表 → 用實際速度落在哪個區間；否則依級別名稱；都沒有時用速度與速限推估
export function classifyLive(x, tables, auth, limitKmh) {
  const lv = Number(x.CongestionLevel), v = Number(x.TravelSpeed);
  if (lv === -99 || !Number.isFinite(lv)) return LV.UNKNOWN;
  if (lv === -1) return LV.CLOSED;
  if (!(v > 0)) return LV.UNKNOWN;
  const t = tables && tables[auth] && tables[auth][x.CongestionLevelID];
  // 機關公布的級別在表裡 → 照機關的判斷（不用速度去推翻：公路局有些路段級別與表的速度區間不一致，以公布的級別為準）
  if (t && t.byLevel[lv] != null && t.byLevel[lv] !== LV.UNKNOWN) return t.byLevel[lv];
  // 表裡沒有這個級別（台北市資料用到 6，表只到 5）→ 依速度落在表的哪個區間
  if (t && t.speed && t.speed.length) { const r = t.speed.find(q => v >= q.lo && v < q.hi); if (r) return r.c; }
  if (lv === 0) return LV.UNKNOWN;
  if (!(limitKmh > 0)) return LV.UNKNOWN;
  const r = v / limitKmh; return r >= 0.7 ? LV.FREE : r >= 0.4 ? LV.SLOW : LV.JAM;
}

// 靜態資料整理：sections（含線形）→ 精簡陣列
export function buildSections(byAuthority) {
  const out = [];
  for (const [auth, d] of Object.entries(byAuthority)) {
    // 代碼：宜蘭的路段代碼有「ILA:Section:」前綴、線形沒有 → 比對時去掉前綴
    const bare = id => String(id || '').replace(/^.*:/, ''), raw = new Map(listOf(d.shapes, 'SectionShapes').map(s => [bare(s.SectionID), s.Geometry])), shapes = new Map([...raw].map(([k, g]) => [k, parseLines(g)]));
    for (const s of listOf(d.sections, 'Sections')) {
      const lines = shapes.get(bare(s.SectionID)) || [], nm = (s.RoadName || '') + (s.SectionName || '');
      // 道路分類：雲林把所有路段都標成 0（國道）→ 名稱沒有國道／高速時不採信
      const cls = s.RoadClass === 0 && !/國道|高速/.test(nm) ? null : s.RoadClass ?? null;
      const pt = p => (p && +p.PositionLat && +p.PositionLon ? [+p.PositionLon, +p.PositionLat] : null), M = s.SectionMile || {};
      out.push({ key: auth + ':' + s.SectionID, auth, id: s.SectionID, name: s.SectionName || '', road: s.RoadName || '', roadId: s.RoadID || '', cls, dir: s.RoadDirection || '', limit: s.SpeedLimit || null, km: s.SectionLength || null, lines,
        trunc: isTruncated(raw.get(bare(s.SectionID))), startPt: pt(s.SectionStart), endPt: pt(s.SectionEnd), k0: kmOf(M.StartKM), k1: kmOf(M.EndKM) });
    }
  }
  // 終點：沒有 SectionEnd 時，用同一條路、同方向、起點里程＝本段終點里程的下一段的起點
  const kk = (x, k) => x.auth + '|' + x.roadId + '|' + x.dir + '|' + k.toFixed(2), next = new Map();
  for (const x of out) if (x.k0 != null) next.set(kk(x, x.k0), x);
  for (const x of out) if (!x.endPt && x.k1 != null) { const n = next.get(kk(x, x.k1)); if (n && n !== x) x.endPt = n.startPt || (n.lines[0] && n.lines[0][0]) || null; }
  return out;
}
// 里程「12K+345」→ 12.345、「0K+0」→ 0、「12K+5」→ 12.005（+ 後面是公尺）
export const kmOf = v => { const m = /^\s*(\d+)\s*K\s*\+?\s*(\d*)/i.exec(String(v || '')); return m ? +m[1] + (m[2] ? +m[2] / 1000 : 0) : null; };

// ---------- 對應到 OSM 路網 ----------
const R2D = 180 / Math.PI, hav = (la1, lo1, la2, lo2) => { const R = Math.PI / 180, h = Math.sin((la2 - la1) * R / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin((lo2 - lo1) * R / 2) ** 2; return 12742000 * Math.asin(Math.min(1, Math.sqrt(h))); };
const brgOf = (a, b) => { const y = Math.sin((b[0] - a[0]) / R2D) * Math.cos(b[1] / R2D), x = Math.cos(a[1] / R2D) * Math.sin(b[1] / R2D) - Math.sin(a[1] / R2D) * Math.cos(b[1] / R2D) * Math.cos((b[0] - a[0]) / R2D); return (Math.atan2(y, x) * R2D + 360) % 360; };
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
// 道路分類 → 可接受的 OSM highway（避免市區道路對到上方的高架國道、國道對到下方的平面道路）
const MAIN = ['motorway', 'trunk'], LINKS = ['motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'];
const CLASS_HW = {
  0: new Set(MAIN),
  1: new Set([...MAIN, 'primary']), 2: new Set([...MAIN, 'primary', 'secondary']),
  3: new Set(['trunk', 'primary', 'secondary', 'tertiary', ...LINKS.slice(1)]),
  4: new Set(['primary', 'secondary', 'tertiary', 'unclassified', ...LINKS.slice(2)]),
  5: new Set(['secondary', 'tertiary', 'unclassified', 'residential']),
};
const ANY_LOCAL = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', ...LINKS]);
const hwOk = (cls, hw) => (CLASS_HW[cls] || ANY_LOCAL).has(hw);

// 沿線取樣（每 step 公尺一點，含方向）
function samples(line, step = 25) {
  const out = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], L = hav(a[1], a[0], b[1], b[0]); if (!(L > 0.5)) continue; const br = brgOf(a, b), n = Math.max(1, Math.ceil(L / step));
    for (let k = 0; k < n; k++) out.push({ lon: a[0] + (b[0] - a[0]) * k / n, lat: a[1] + (b[1] - a[1]) * k / n, brg: br, m: L / n });
  }
  const z = line[line.length - 1], y = line[line.length - 2]; if (y) out.push({ lon: z[0], lat: z[1], brg: brgOf(y, z), m: 0 });
  return out;
}
// 每個路段 → 有向邊（依取樣點吸附＋方向相符＋道路分類），衝突時給票數多的路段
// 搜尋半徑與取樣間距依道路分類：國道、快速道路的線形常在兩個分隔車道中間 → 半徑大、間距大；市區道路半徑小，避免對到旁邊的平行道路
const RADIUS = { 0: 40, 1: 35, 2: 30, 3: 28 }, STEP = { 0: 50, 1: 40, 3: 40 };
export function matchSections(sections, router, { radiusM = 22, maxAngle = 40, step = 25 } = {}) {
  const { E, W } = router.g, best = new Map(), stats = { sections: sections.length, withShape: 0, matched: 0, samples: 0, hitSamples: 0 }, t0 = Date.now();
  sections.forEach((s, si) => {
    if (!s.lines.length) return; stats.withShape++;
    const votes = new Map();
    const rad = RADIUS[s.cls] || radiusM, stp = STEP[s.cls] || step;
    const pts = s.lines.flat(), shapeM = s.lines.reduce((a, l) => a + l.slice(1).reduce((b, q, k) => b + hav(l[k][1], l[k][0], q[1], q[0]), 0), 0), coarse = shapeM / Math.max(1, pts.length - 1) > 150;
    for (const line of s.lines) for (const p of samples(line, stp)) {
      stats.samples++; let hit = false;
      for (const c of router.snapCandidates(p.lat, p.lon, 'car', { windowM: 12, maxM: rad })) {
        const hw = HIGHWAYS[W.hw[E.way[c.e]]]; if (!hwOk(s.cls, hw)) continue;
        const fwd = angDiff(c.brg, p.brg), bwd = angDiff((c.brg + 180) % 360, p.brg), a = fwd <= maxAngle ? 2 * c.e : bwd <= maxAngle ? 2 * c.e + 1 : -1; if (a < 0) continue;
        votes.set(a, (votes.get(a) || 0) + 1); hit = true; break;
      }
      if (hit) stats.hitSamples++;
    }
    // 線形被截斷（或很粗）而且知道終點：從最後一個有效點規劃到終點補齊；長度不超過直線距離的 1.5 倍＋200 m、八成以上走在這一類道路上才採用
    if ((s.trunc || coarse) && s.endPt && pts.length >= 2) {
      const A = pts[pts.length - 1], B = s.endPt, crow = hav(A[1], A[0], B[1], B[0]);
      if (crow > 30 && crow < 30000) {
        const r = router.route({ from: [A[1], A[0]], to: [B[1], B[0]], profile: 'car', metric: 'time', heading: brgOf(pts[pts.length - 2], A) });
        let okR = false;
        if (!r.error && r.snap && r.snap.fromM <= rad && r.snap.toM <= rad * 2 && r.distanceM <= crow * 1.5 + 200) {
          const want = CLASS_HW[s.cls], onM = want ? r.ways.filter(w => want.has(w.highway) || /_link$/.test(w.highway)).reduce((a, w) => a + w.m, 0) : r.distanceM;
          if (onM >= r.distanceM * 0.8) { okR = true; for (const a of r.arcs) votes.set(a, Math.max(votes.get(a) || 0, 3)); }
        }
        stats[okR ? 'extended' : 'extendRejected'] = (stats[okR ? 'extended' : 'extendRejected'] || 0) + 1;
      }
    }
    let any = false;
    const few = votes.size <= 2 && shapeM < stp * 3;                                           // 很短的路段（只有一兩個取樣點）：一票就算
    for (const [a, v] of votes) { const L = E.len[a >> 1]; if (v < 2 && L > stp * 1.6 && !few) continue;   // 長的邊只被一個取樣點碰到：多半是交叉路口旁經過
      const o = best.get(a); if (!o || o.v < v) { best.set(a, { s: si, v }); any = true; } }
    if (any) stats.matched++;
  });
  const arcSec = new Map(); for (const [a, o] of best) arcSec.set(a, o.s);
  const secM = new Float64Array(sections.length); for (const [a, s] of arcSec) secM[s] += E.len[a >> 1];
  stats.arcs = arcSec.size; stats.ms = Date.now() - t0;
  return { arcSec, secM, stats };
}

// ---------- 即時資料 → 每個路段的狀態、路網加權 ----------
// live：{ byAuthority: { Freeway: wrapper, … }, fetchedAt }；回傳 Map(key → { lv, v, t, at })
export function liveBySection(live, tables, sections) {
  const lim = new Map(sections.map(s => [s.key, s.limit])), out = new Map();
  for (const [auth, w] of Object.entries((live && live.byAuthority) || {})) for (const x of listOf(w, 'LiveTraffics')) {
    const key = auth + ':' + x.SectionID, v = Number(x.TravelSpeed), at = Date.parse(x.DataCollectTime || '') || null;
    out.set(key, { lv: classifyLive(x, tables, auth, lim.get(key)), v: v > 0 ? v : null, t: Number(x.TravelTime) > 0 ? Number(x.TravelTime) : null, at });
  }
  return out;
}
// 路網加權：模型速度比即時速度快 → 時間乘上比值（1～5 倍；即時比模型快時不加快，保持 A* 的下界）；封閉 → 20 倍（盡量避開，但即時資料偶有誤報，不直接禁行）
export function flowOverlay(match, sections, states, P, router, { maxAgeMs = 20 * 60e3, now = Date.now() } = {}) {
  const ov = new Map(), EL = router.g.E.len; let n = 0;
  for (const [a, si] of match.arcSec) {
    const s = states.get(sections[si].key); if (!s || (s.at && now - s.at > maxAgeMs)) continue;
    let f = 1;
    // 只在機關判定車多／壅塞／封閉時加權：TDX 的平均速度已含路口等候，模型另外算路口延遲 → 順暢路段若也依速度加權會重複計算
    if (s.lv !== LV.SLOW && s.lv !== LV.JAM && s.lv !== LV.CLOSED) continue;
    if (s.lv === LV.CLOSED) f = 20;
    else if (s.v && P && P.time[a] > 0 && P.time[a] < Infinity) { const vm = EL[a >> 1] / P.time[a] * 3.6; if (s.v < vm) f = Math.min(5, vm / s.v); }
    else if (s.lv === LV.JAM) f = 2; else if (s.lv === LV.SLOW) f = 1.3;
    if (f > 1.02) { ov.set(a, { block: false, factor: f, timeFactor: f, flow: s.lv }); n++; }
  }
  return { overlay: ov, arcs: n };
}
// 兩個 overlay 合併（道路事件＋即時路況）：封閉取或、係數取大
export function mergeOverlays(a, b) {
  if (!a || !a.size) return b; if (!b || !b.size) return a;
  const m = new Map(a);
  for (const [k, o] of b) { const x = m.get(k); m.set(k, x ? { ...x, block: x.block || o.block, factor: Math.max(x.factor, o.factor), timeFactor: Math.max(x.timeFactor, o.timeFactor), flow: o.flow } : o); }
  return m;
}
// 路線經過的路況：每段座標 → 路段狀態（segArc：每一小段屬於哪一條有向邊）
export function routeFlow(arcs, segArc, segLen, match, sections, states) {
  const runs = [], sum = { knownM: 0, freeM: 0, slowM: 0, jamM: 0, closedM: 0 }; let cur = null;
  for (let i = 0; i < segArc.length; i++) {
    const a = segArc[i] >= 0 ? arcs[segArc[i]] : -1, si = a >= 0 ? match.arcSec.get(a) : undefined, s = si != null ? states.get(sections[si].key) : null, lv = s ? s.lv : LV.UNKNOWN, L = segLen[i] || 0;
    if (lv !== LV.UNKNOWN) { sum.knownM += L; if (lv === LV.FREE) sum.freeM += L; else if (lv === LV.SLOW) sum.slowM += L; else if (lv === LV.JAM) sum.jamM += L; else if (lv === LV.CLOSED) sum.closedM += L; }
    if (cur && cur[2] === lv && cur[1] === i) cur[1] = i + 1; else { cur = [i, i + 1, lv]; runs.push(cur); }
  }
  for (const k in sum) sum[k] = Math.round(sum[k]);
  return { ...sum, runs: runs.filter(r => r[2] !== LV.UNKNOWN) };
}
// 地圖圖層：範圍內的路段（Douglas-Peucker 簡化）
export function simplify(pts, tol) {
  if (pts.length <= 2 || !(tol > 0)) return pts; const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1; const st = [[0, pts.length - 1]];
  while (st.length) { const [i, j] = st.pop(); const [ax, ay] = pts[i], [bx, by] = pts[j], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let m = -1, md = tol * tol;
    for (let k = i + 1; k < j; k++) { const [px, py] = pts[k]; let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const ex = ax + t * dx - px, ey = ay + t * dy - py, d = ex * ex + ey * ey; if (d > md) { md = d; m = k; } }
    if (m > 0) { keep[m] = 1; st.push([i, m], [m, j]); } }
  return pts.filter((_, k) => keep[k]);
}
