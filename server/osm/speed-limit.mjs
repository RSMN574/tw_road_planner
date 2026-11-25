// speed-limit.mjs — SpeedLimitService（v1.20）：路段速限，含來源、版本、可信度；沒有可靠來源就回「速限未知」，不填猜測值
//
// 來源與優先順序（依行駛方向，以有向邊 arc 為單位）：
//   1. TDX 官方（路況 v2 的路段 SpeedLimit；實測只有國道有值）→ 可信度 high
//   2. OSM maxspeed:conditional（時段條件成立時）→ medium
//   3. OSM maxspeed:forward／:backward（依方向）或 maxspeed → 有 maxspeed:type／source:maxspeed＝sign（照標誌登錄）為 high，否則 medium
//   4. OSM 區域代碼（maxspeed=TW:urban 等）→ 法定速限，low（不是現場標誌）
//   5. 都沒有 → 未知（路線的時間估算會依道路類別推估，但那個推估值不是速限，不顯示成速限）
// 另外標示：可變速限（maxspeed:variable，例如依天候）、建議速限（maxspeed:advisory）、各車道不同（maxspeed:lanes）、OSM 與官方不一致
// 車種：步行不適用；其他運具（汽車、機車、腳踏車）都用道路的速限（OSM 的大型車速限 maxspeed:hgv 屬於大貨車，本系統沒有大貨車模式，不使用）

const TPE = 8 * 3600e3, DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim()); return m ? +m[1] * 60 + +m[2] : NaN; };
function parseDays(s) {
  const out = new Set();
  for (const part of s.split(',')) { const m = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim()); if (!m) return null; let i = DAYS.indexOf(m[1]); const j = DAYS.indexOf(m[2] || m[1]); for (;;) { out.add(i); if (i === j) break; i = (i + 1) % 7; } }
  return out;
}
// "50 @ (20:00 - 24:00, 00:00 - 06:00)"、"30 @ (20:00-06:00)"、"40 @ (Mo-Fr 07:00-09:00)"；多條以 ; 分隔。解析不了的條件回傳 ok:false（照實標示，不套用）
export function parseConditional(s) {
  const rules = [];
  for (const raw of String(s || '').split(/;(?![^()]*\))/)) {
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:km\/h)?\s*@\s*\(?([^()]*)\)?\s*$/.exec(raw); if (!m) { if (raw.trim()) return { ok: false, rules: [] }; continue; }
    const kmh = +m[1], spans = [];
    for (const seg of m[2].split(',')) {
      const t = seg.trim(), d = /^((?:(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?,?)+)\s+(.*)$/.exec(t);
      let days = null, times = t; if (d) { days = parseDays(d[1].replace(/,$/, '')); times = d[2]; if (!days) return { ok: false, rules: [] }; }
      const r = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(times.trim()); if (!r) return { ok: false, rules: [] };
      const a = hm(r[1]), b = hm(r[2]); if (!Number.isFinite(a) || !Number.isFinite(b)) return { ok: false, rules: [] };
      spans.push({ a, b, days });
    }
    if (!spans.length) return { ok: false, rules: [] };
    rules.push({ kmh, spans });
  }
  return { ok: rules.length > 0, rules };
}
// 台北時間 atMs 時，哪一條條件成立（跨午夜的區間：20:00-06:00）
export function conditionalAt(parsed, atMs) {
  if (!parsed || !parsed.ok || atMs == null) return null;
  const d = new Date(atMs + TPE), min = d.getUTCHours() * 60 + d.getUTCMinutes(), wd = d.getUTCDay();
  for (const r of parsed.rules) for (const s of r.spans) {
    const inT = s.a <= s.b ? min >= s.a && min < s.b : min >= s.a || min < s.b, dayOk = !s.days || s.days.has(s.a <= s.b || min >= s.a ? wd : (wd + 6) % 7);
    if (inT && dayOk) return r.kmh;
  }
  return null;
}

const LABEL = { tdx: 'TDX 官方速限', osm: 'OSM 速限標籤', 'osm-sign': 'OSM 速限標籤（依現場標誌登錄）', 'osm-cond': 'OSM 時段速限', 'osm-zone': '法定速限（OSM 區域代碼）' };
// router：OsmRouter；extra：{ version, ways: { wayId: { cond, variable, advisory, lanes, sign } } }（tools/osm/osm-speedlimits.mjs）；official(arc) → { kmh, name, auth } 或 null
export function createSpeedLimits({ router, extra = null, official = null, officialVersion = '', graphVersion = 'osm' } = {}) {
  const { W, E } = router.g, xw = extra && extra.ways ? extra.ways : {}, parsedCond = new Map();
  const version = [graphVersion, extra ? 'x' + (extra.version || extra.builtAt || '1') : 'x-', 'tdx' + (officialVersion || '-')].join('|');
  const condOf = wid => { if (!parsedCond.has(wid)) parsedCond.set(wid, xw[wid] && xw[wid].cond ? parseConditional(xw[wid].cond) : null); return parsedCond.get(wid); };
  function forArc(a, mode = 'car', atMs = null) {
    if (mode === 'walk' || mode === 'foot') return { kmh: null, source: null, confidence: 'na', label: '步行不適用' };
    const w = E.way[a >> 1], wid = String(W.id[w]), x = xw[wid] || null, notes = [];
    const dir = a & 1 ? W.maxB[w] : W.maxF[w], tag = Number.isFinite(dir) ? dir : W.maxspeed[w], zone = W.zoneMax ? W.zoneMax[w] : 0;
    if (x && x.variable) notes.push('可變速限（' + (x.variable === 'weather' ? '依天候' : x.variable) + '），以現場標誌為準');
    if (x && x.advisory) notes.push(`建議速限 ${x.advisory} km/h`);
    if (x && x.lanes) notes.push(`各車道速限不同（${x.lanes}），顯示最高者`);
    const off = official ? official(a) : null;
    if (off && off.kmh > 0) { if (Number.isFinite(tag) && Math.round(tag) !== off.kmh) notes.push(`OSM 標 ${Math.round(tag)} km/h，與官方不同，採官方`); return { kmh: off.kmh, source: 'tdx', confidence: 'high', label: LABEL.tdx + (off.auth ? `（${off.auth}）` : ''), notes, wayId: wid }; }
    const ck = condOf(wid);
    if (ck && ck.ok) { const v = conditionalAt(ck, atMs); if (v != null) return { kmh: v, source: 'osm-cond', confidence: 'medium', label: LABEL['osm-cond'], notes: [...notes, `時段條件：${x.cond}`], wayId: wid }; notes.push(`另有時段速限：${x.cond}`); }
    else if (ck && !ck.ok) notes.push(`另有時段速限但無法解析：${x.cond}`);
    if (Number.isFinite(tag) && tag > 0) { const sign = !!(x && x.sign); return { kmh: Math.round(tag), source: sign ? 'osm-sign' : 'osm', confidence: sign ? 'high' : 'medium', label: LABEL[sign ? 'osm-sign' : 'osm'], notes, wayId: wid }; }
    if (zone > 0) return { kmh: zone, source: 'osm-zone', confidence: 'low', label: LABEL['osm-zone'], notes, wayId: wid };
    return { kmh: null, source: null, confidence: 'unknown', label: '速限未知', notes, wayId: wid };
  }
  // 一條路線（describe 的結果）每一小段的速限：table（去重）＋seg（每段在 table 的位置）
  function forRoute(r, mode, atMs) {
    const table = [], idx = new Map(), seg = [], arcs = r.arcs || [], sa = r.segArc || [];
    for (let i = 0; i < sa.length; i++) {
      const a = arcs[sa[i]]; if (a == null) { seg.push(-1); continue; }
      const L = forArc(a, mode, atMs), k = JSON.stringify([L.kmh, L.source, L.notes, L.wayId]);
      let j = idx.get(k); if (j == null) { j = table.length; idx.set(k, j); table.push(L); } seg.push(j);
    }
    return { table, seg, version, at: atMs != null ? new Date(atMs).toISOString() : null };
  }
  return { forArc, forRoute, version };
}
