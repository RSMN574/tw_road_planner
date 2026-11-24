// poi.mjs — 店家地點（POI）：從 OSM PBF 擷取、存檔（osm-poi.json.gz）、載入建索引、搜尋與排序、附近查詢、營業時間判斷
// 規劃：docs/design/POI_SEARCH_PLAN.md。資料只來自 OpenStreetMap（ODbL）；沒有評分、評論。
//
// 搜尋：名稱、品牌、英文名、別名正規化（全形→半形、小寫、臺→台、去空白標點）後建「相鄰兩字」倒排索引；
//   查詢先取兩字組合的交集，再確認整段字串真的有出現（不只是字都有）。品牌同義詞展開（小七＝7-11）；
//   類別詞（加油站、ATM…）變成「附近的這一類」。排序＝文字相符程度 − 距離懲罰；連鎖店同名只列最近幾家。
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { scan } from './pbf.mjs';
import { Grow, bsearch } from './grow.mjs';
import { categoryOf, CATEGORIES, CAT_WORDS, SYNONYMS } from './poi-categories.mjs';
import { compileCondition } from './conditional.mjs';

export const POI_VERSION = 1;
// ---------- 正規化 ----------
export function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/臺/g, '台').replace(/[\s　'’"“”`·・.,，、。:：;；!！?？()（）\[\]［］{}「」『』<>《》〈〉\-–—_/\\|+&＆@#~～*]/g, '');
}
const bigrams = s => { const out = []; for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2)); return out; };
const DROP = /^(附近的?|最近的?|周邊的?|找)|(附近|在哪裡?|在哪)$/g;

// ---------- 擷取 ----------
function addrOf(t) {
  if (t['addr:full']) return t['addr:full'];
  const hn = t['addr:housenumber'] ? String(t['addr:housenumber']) + (/[號号]$/.test(t['addr:housenumber']) || /[a-z]/i.test(t['addr:housenumber']) ? '' : '號') : '';
  const parts = [t['addr:city'], t['addr:district'] || t['addr:suburb'], t['addr:street'] || t['addr:place'], hn, t['addr:floor'] ? t['addr:floor'] + (/[樓楼f]$/i.test(t['addr:floor']) ? '' : '樓') : ''].filter(Boolean);
  return parts.length >= 2 || (t['addr:street'] && hn) ? parts.join('') : '';
}
export function extractPois(pbf, { log = () => {} } = {}) {
  const t0 = Date.now(), R = { id: [], name: [], en: [], brand: [], alt: [], cat: [], lat: [], lon: [], addr: [], hours: [], phone: [], web: [], level: [], area: [] };
  const st = { nodes: 0, ways: 0, unnamedKept: 0, skippedNoCat: 0, byCat: {} };
  const push = (id, t, la, lo, area, c) => {
    R.id.push(id); R.name.push(t.name || t['name:zh'] || t.brand || ''); R.en.push(t['name:en'] || ''); R.brand.push(t.brand || t['brand:zh'] || ''); R.alt.push([t.alt_name, t.official_name, t.short_name, t['name:zh-Hant']].filter(Boolean).join('|'));
    R.cat.push(c); R.lat.push(la); R.lon.push(lo); R.addr.push(addrOf(t)); R.hours.push(t.opening_hours || ''); R.phone.push(t.phone || t['contact:phone'] || ''); R.web.push(t.website || t['contact:website'] || '');
    R.level.push(t.level || t['addr:floor'] || ''); R.area.push(area ? 1 : 0); st.byCat[c] = (st.byCat[c] || 0) + 1; if (!t.name) st.unnamedKept++;
  };
  // 第一趟：way（面狀地點：學校、醫院、公園、大賣場…）→ 記下節點，之後取中心點
  const ways = [], refs = new Grow(Float64Array, 1 << 20), off = [0];
  scan(pbf, { way(id, r, t) { const c = categoryOf(t, !!(t.name || t.brand)); if (!c) return; ways.push({ id, t, c }); refs.pushArr(r); off.push(refs.n); } });
  log(`  面狀地點 ${ways.length.toLocaleString()}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  const ids = refs.trim(), uniq = Float64Array.from(ids).sort(); let u = 0; for (let i = 0; i < uniq.length; i++) if (!i || uniq[i] !== uniq[i - 1]) uniq[u++] = uniq[i];
  const nLat = new Int32Array(u), nLon = new Int32Array(u), have = new Uint8Array(u);
  // 第二趟：node（點狀地點，以及上面 way 的節點座標）
  scan(pbf, { nodeTags: true, nodeKey: () => 0, node(id, la, lo, t) {
    const j = bsearch(uniq, id, u); if (j >= 0) { nLat[j] = la; nLon[j] = lo; have[j] = 1; }
    if (!t) return; const c = categoryOf(t, !!(t.name || t.brand)); if (!c) return; push('n' + id, t, la, lo, false, c); st.nodes++;
  } });
  for (let w = 0; w < ways.length; w++) {
    // 封閉的 way 最後一個節點＝第一個：不要重複算
    const end = off[w + 1] - off[w] > 2 && ids[off[w + 1] - 1] === ids[off[w]] ? off[w + 1] - 1 : off[w + 1];
    let sla = 0, slo = 0, n = 0; for (let k = off[w]; k < end; k++) { const j = bsearch(uniq, ids[k], u); if (j < 0 || !have[j]) continue; sla += nLat[j]; slo += nLon[j]; n++; }
    if (!n) continue; push('w' + ways[w].id, ways[w].t, Math.round(sla / n), Math.round(slo / n), true, ways[w].c); st.ways++;
  }
  st.total = R.id.length; st.seconds = (Date.now() - t0) / 1000;
  return { R, stats: st };
}
export function writePois(file, x, meta = {}) {
  const body = gzipSync(JSON.stringify({ version: POI_VERSION, created: new Date().toISOString(), meta, stats: x.stats, ...x.R }), { level: 6 });
  writeFileSync(file + '.tmp', body); renameSync(file + '.tmp', file); return { bytes: body.length, count: x.R.id.length };
}

// ---------- 載入與索引 ----------
export function loadPois(file) { return buildIndex(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))); }
export function buildIndex(D) {
  const n = D.id.length, text = new Array(n), post = new Map(), uni = new Map();
  const add = (m, k, i) => { let a = m.get(k); if (!a) m.set(k, a = []); if (a[a.length - 1] !== i) a.push(i); };
  for (let i = 0; i < n; i++) {
    const fields = [D.name[i], D.brand[i], D.en[i], ...String(D.alt[i] || '').split('|')].map(norm).filter(Boolean), uniq = [...new Set(fields)];
    text[i] = uniq;
    for (const f of uniq) { for (const ch of new Set(f)) add(uni, ch, i); for (const b of new Set(bigrams(f))) add(post, b, i); }
  }
  const toTyped = m => { for (const [k, a] of m) m.set(k, Int32Array.from(a)); return m; };
  toTyped(post); toTyped(uni);
  // 空間格網（約 1 km）
  const C = 100000, grid = new Map(); for (let i = 0; i < n; i++) { const k = Math.floor(D.lat[i] / C) * 100000 + Math.floor(D.lon[i] / C); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i); }
  const counts = {}; for (const c of D.cat) counts[c] = (counts[c] || 0) + 1;
  return { D, n, text, post, uni, grid, C, counts, version: D.created || '' };
}

// ---------- 營業時間 ----------
const hoursCache = new Map();
export function openStatus(hours, ms = Date.now()) {
  if (!hours) return { state: 'unknown', text: '營業時間未提供' };
  let f = hoursCache.get(hours); if (!f) { f = compileCondition(hours); if (hoursCache.size > 20000) hoursCache.clear(); hoursCache.set(hours, f); }
  const v = f(ms); if (v == null) return { state: 'unknown', text: hours, raw: true };
  if (v && f(ms + 30 * 60e3) === false) return { state: 'closing', text: '即將打烊', raw: hours };
  return { state: v ? 'open' : 'closed', text: v ? '營業中' : '已打烊', raw: hours };
}

// ---------- 查詢 ----------
const hav = (la1, lo1, la2, lo2) => { const R = Math.PI / 180, h = Math.sin((la2 - la1) * R / 2) ** 2 + Math.cos(la1 * R) * Math.cos(la2 * R) * Math.sin((lo2 - lo1) * R / 2) ** 2; return 12742 * Math.asin(Math.min(1, Math.sqrt(h))); };
const SYN = new Map(); for (const g of SYNONYMS) { const ng = g.map(norm); for (const w of ng) SYN.set(w, ng); }
// 一個詞的候選（交集兩字組合，再確認整段出現）
function termHits(X, t) {
  if (!t) return null;
  let cand;
  if (t.length === 1) cand = X.uni.get(t) || new Int32Array(0);
  else { const lists = [...new Set(bigrams(t))].map(b => X.post.get(b) || new Int32Array(0)).sort((a, b) => a.length - b.length); cand = lists[0]; for (let k = 1; k < lists.length && cand.length; k++) { const s = new Set(lists[k]); cand = cand.filter(i => s.has(i)); } }
  const out = []; for (const i of cand) if (X.text[i].some(f => f.includes(t))) out.push(i); return out;
}
function textScore(X, i, alts) {
  let best = 0; const fs = X.text[i];
  for (const a of alts) for (let k = 0; k < fs.length; k++) { const f = fs[k], base = f === a ? 100 : f.startsWith(a) ? 78 : f.includes(a) ? 56 : 0; const s = base - (k > 0 ? 6 : 0) - Math.min(15, Math.max(0, f.length - a.length) * 0.6); if (s > best) best = s; }
  return best;
}
function nearbyIdx(X, la, lo, radiusKm, cat) {
  const out = [], C = X.C, dla = Math.ceil(radiusKm / 11.1) + 1, dlo = Math.ceil(radiusKm / (11.1 * Math.cos(la * Math.PI / 180))) + 1, cy = Math.floor(la * 1e7 / C), cx = Math.floor(lo * 1e7 / C);
  for (let y = cy - dla; y <= cy + dla; y++) for (let x = cx - dlo; x <= cx + dlo; x++) for (const i of X.grid.get(y * 100000 + x) || []) { if (cat && X.D.cat[i] !== cat) continue; const d = hav(la, lo, X.D.lat[i] / 1e7, X.D.lon[i] / 1e7); if (d <= radiusKm) out.push([i, d]); }
  return out;
}
export function poiSummary(X, i, near, now) {
  const D = X.D, c = CATEGORIES[D.cat[i]] || CATEGORIES.other, la = D.lat[i] / 1e7, lo = D.lon[i] / 1e7, o = openStatus(D.hours[i], now);
  return { id: D.id[i], name: D.name[i] || c.label, nameEn: D.en[i] || null, brand: D.brand[i] || null, category: D.cat[i], categoryLabel: c.label, icon: c.icon, lat: +la.toFixed(6), lon: +lo.toFixed(6),
    distanceM: near ? Math.round(hav(near[0], near[1], la, lo) * 1000) : null, address: D.addr[i] || null, open: o.state, openText: o.text, named: !!D.name[i] };
}
export function poiDetail(X, i, now = Date.now()) {
  const D = X.D, s = poiSummary(X, i, null, now), o = openStatus(D.hours[i], now);
  return { ...s, hours: D.hours[i] || null, hoursEvaluable: !!D.hours[i] && o.state !== 'unknown', phone: D.phone[i] || null, website: D.web[i] || null, level: D.level[i] || null, area: !!D.area[i],
    osm: { type: D.id[i][0] === 'n' ? 'node' : 'way', id: D.id[i].slice(1), url: `https://www.openstreetmap.org/${D.id[i][0] === 'n' ? 'node' : 'way'}/${D.id[i].slice(1)}` }, source: '© OpenStreetMap contributors（ODbL）' };
}
// 類別相關性：查詢字串含類別詞（「台大醫院」含「醫院」）→ 該類別加分；附屬設施（停車場、YouBike、廁所）沒被指名時扣分
const FACILITY = new Set(['parking', 'moto_parking', 'bike_rental', 'toilets', 'atm', 'charging']);
function catBias(nq) { const want = new Set(); for (const [w, c] of CAT_WORDS) if (w.length >= 2 && nq.includes(w)) want.add(c); return want; }
function textSearch(X, nq, words, near, cat) {
  const alts = SYN.get(nq) || [nq], set = new Set(); for (const a of alts) for (const i of termHits(X, a) || []) set.add(i);
  let anchor = null, where = null;
  if (words.length > 1 && !set.size) {
    // 多個詞：①每個詞都出現在名稱或地址（「全家 信義」）；②最後一個詞是地標（「麥當勞 台北車站」→ 在台北車站附近找麥當勞）
    const per = words.map(w => new Set((SYN.get(w) || [w]).flatMap(a => termHits(X, a) || [])));
    for (const i of per[0]) if (words.every((w, k) => per[k].has(i) || (X.D.addr[i] && norm(X.D.addr[i]).includes(w)))) set.add(i);
    if (!set.size) {
      const last = words[words.length - 1], head = words.slice(0, -1).join(''), lm = [...per[per.length - 1]].map(i => ({ i, s: textScore(X, i, [last]) - (near ? 8 * Math.log2(1 + hav(near[0], near[1], X.D.lat[i] / 1e7, X.D.lon[i] / 1e7)) : 0) })).sort((a, b) => b.s - a.s)[0];
      if (lm && textScore(X, lm.i, [last]) >= 78) { anchor = [X.D.lat[lm.i] / 1e7, X.D.lon[lm.i] / 1e7]; where = X.D.name[lm.i]; for (const a of SYN.get(head) || [head]) for (const i of termHits(X, a) || []) set.add(i); }
    }
  }
  // 「信義區 加油站」：類別＋地名 → 類別裡地址或名稱含這個地名的
  if (cat && nq && ![...set].some(i => X.D.cat[i] === cat)) for (let i = 0; i < X.n; i++) if (X.D.cat[i] === cat && ((X.D.addr[i] && norm(X.D.addr[i]).includes(nq)) || X.text[i].some(f => f.includes(nq)))) set.add(i);
  return { set, alts, anchor, where };
}
// q：查詢字串；near：[lat, lon]；category：類別代碼；openNow；limit
export function searchPois(X, { q = '', near = null, category = null, openNow = false, limit = 15, now = Date.now(), bbox = null } = {}) {
  let nq = norm(String(q).replace(DROP, '')); const words = String(q).trim().split(/\s+/).map(w => norm(w.replace(DROP, ''))).filter(Boolean);
  let cat = category && CATEGORIES[category] ? category : null, mode = 'text', anchorName = null;
  if (!cat && CAT_WORDS.has(nq)) { cat = CAT_WORDS.get(nq); mode = 'category'; }
  if (!cat && words.length > 1 && CAT_WORDS.has(words[words.length - 1])) { cat = CAT_WORDS.get(words.pop()); nq = words.join(''); }   // 「信義區 加油站」
  if (!cat && words.length > 1 && CAT_WORDS.has(words[0])) { cat = CAT_WORDS.get(words.shift()); nq = words.join(''); }                // 「加油站 信義區」
  let scored = [];
  if (mode === 'category' || (!nq && cat)) {
    if (!near) return { results: [], mode: 'category', category: cat, note: '用類別找需要位置（地圖中心或 GPS）' };
    let hits = []; for (const r of [1, 3, 10, 30]) { hits = nearbyIdx(X, near[0], near[1], r, cat); if (hits.length >= limit * 2) break; }
    scored = hits.map(([i, d]) => ({ i, d, s: 50 - 15 * Math.log2(1 + d) + (X.D.name[i] ? 3 : 0) }));
    mode = 'category';
  } else {
    if (!nq) return { results: [], mode: 'empty' };
    const T = textSearch(X, nq, words, near, cat), ref = T.anchor || near, want = catBias(nq); anchorName = T.where;
    for (const i of T.set) {
      if (cat && X.D.cat[i] !== cat) continue; const c = X.D.cat[i], d = ref ? hav(ref[0], ref[1], X.D.lat[i] / 1e7, X.D.lon[i] / 1e7) : 0;
      const bias = (want.has(c) ? 22 : 0) - (FACILITY.has(c) && !want.has(c) ? 18 : 0) + (X.D.area[i] ? 4 : 0);
      scored.push({ i, d, s: textScore(X, i, T.alts) + bias - (ref ? 15 * Math.log2(1 + d) : 0) });
    }
    if (T.anchor) { near = T.anchor; const close = scored.filter(x => x.d <= 5); if (close.length) scored = close; }   // 「店名 地標」：只留地標 5 km 內（有的話）
    // 類別＋地名，但沒有任何這一類的地址含地名：用最符合地名的地點當中心，找 3 km 內的這一類（「信義區 加油站」→ 信義區公所附近）
    if (cat && !scored.length && T.set.size) {
      const best = [...T.set].map(i => ({ i, s: textScore(X, i, [nq]) + (X.D.area[i] ? 6 : 0) - (FACILITY.has(X.D.cat[i]) ? 18 : 0) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 56) { near = [X.D.lat[best.i] / 1e7, X.D.lon[best.i] / 1e7]; anchorName = X.D.name[best.i]; scored = nearbyIdx(X, near[0], near[1], 3, cat).map(([i, d]) => ({ i, d, s: 50 - 15 * Math.log2(1 + d) })); mode = 'category'; }
    }
  }
  if (bbox) scored = scored.filter(({ i }) => { const la = X.D.lat[i] / 1e7, lo = X.D.lon[i] / 1e7; return lo >= bbox[0] && lo <= bbox[2] && la >= bbox[1] && la <= bbox[3]; });
  if (openNow) scored = scored.filter(({ i }) => ['open', 'closing'].includes(openStatus(X.D.hours[i], now).state));
  scored.sort((a, b) => b.s - a.s || a.d - b.d);
  // 同名連鎖店：同一個名稱最多 3 家（最相關／最近的），其餘只計 5 km 內的家數（「附近還有 N 家」）
  const per = new Map(), out = [], more = new Map();
  for (const x of scored) { const k = norm(X.D.name[x.i]) || X.D.cat[x.i]; const c = per.get(k) || 0; if (c >= 3 && mode !== 'category') { if (!near || x.d <= 5) more.set(k, (more.get(k) || 0) + 1); continue; } per.set(k, c + 1); out.push(x); if (out.length >= limit) break; }
  const results = out.map(({ i }) => poiSummary(X, i, near, now));
  for (const r of results) { const k = norm(r.name); if (more.has(k)) { r.moreSameName = more.get(k); more.delete(k); } }
  return { results, mode, category: cat, total: scored.length, near: anchorName ? { name: anchorName, lat: near[0], lon: near[1] } : null,
    note: anchorName ? `在「${anchorName}」附近找` : near ? '依相關程度與距離排序' : '沒有位置：只依相關程度排序' };
}
export function nearbyPois(X, { lat, lon, category = null, radiusKm = 1, limit = 20, now = Date.now(), openNow = false }) {
  let hits = nearbyIdx(X, lat, lon, radiusKm, category).sort((a, b) => a[1] - b[1]);
  if (openNow) hits = hits.filter(([i]) => ['open', 'closing'].includes(openStatus(X.D.hours[i], now).state));
  return { results: hits.slice(0, limit).map(([i]) => poiSummary(X, i, [lat, lon], now)), total: hits.length };
}
export const findPoi = (X, id) => { if (!X.byId) { X.byId = new Map(); X.D.id.forEach((v, i) => X.byId.set(v, i)); } return X.byId.get(String(id)) ?? -1; };
