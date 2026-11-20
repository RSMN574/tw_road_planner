// buildings.mjs — OSM 建築物（building=*）：從 PBF 擷取外框與高度、存成二進位檔（TWBLD1）、依圖磚查詢
//
// 高度的來源一律記錄、不混在一起：
//   0 OSM height（＝真實資料，height 標籤，單位公尺；有 min_height 一併採用）
//   1 OSM building:levels × 3.0 m（由樓層數推算；+ roof:levels 也算）
//   2 推估：沒有任何高度資料 → 依建築類型的保守值（多半 2 層 6 m），畫面用虛線、半透明標示「推估」，不當成真實高度
// 不處理：building:part（3D 細部）只計數；多重多邊形（type=multipolygon）建築只取 outer 外框、不挖洞
import { readFileSync, openSync, writeSync, closeSync, renameSync } from 'node:fs';
import { scan } from './pbf.mjs';
import { Grow, bsearch } from './grow.mjs';

export const MAGIC = 'TWBLD1\0\0', LEVEL_M = 3.0;
export const SRC = ['OSM height', 'OSM building:levels × 3 m', '推估（無高度資料）'];
// 沒有高度資料時的保守估計（公尺）：只用來畫 3D 示意，畫面標示「推估」
const EST = { house: 6, detached: 6, residential: 9, apartments: 15, commercial: 9, retail: 6, industrial: 8, warehouse: 8, school: 12, hospital: 15, office: 15, church: 10, temple: 8, shed: 3, roof: 4, garage: 3, garages: 3, hut: 3, kiosk: 3, carport: 3, greenhouse: 4, service: 4, yes: 6 };
export function parseHeight(v) {
  if (v == null || v === '') return NaN; const s = String(v).trim().toLowerCase().replace(',', '.');
  let m = /^(-?\d+(?:\.\d+)?)\s*(m|meters?|公尺)?$/.exec(s); if (m) return +m[1];
  m = /^(\d+(?:\.\d+)?)\s*(ft|')$/.exec(s); if (m) return +m[1] * 0.3048;
  m = /^(\d+)'\s*(\d+)"$/.exec(s); if (m) return +m[1] * 0.3048 + +m[2] * 0.0254;
  return NaN;
}
export function heightOf(t) {
  const h = parseHeight(t.height ?? t['building:height']), lv = parseFloat(t['building:levels']), rl = parseFloat(t['roof:levels']), mh = parseHeight(t.min_height), ml = parseFloat(t['building:min_level']);
  const minH = Number.isFinite(mh) && mh >= 0 ? mh : Number.isFinite(ml) && ml >= 0 ? ml * LEVEL_M : 0;
  if (Number.isFinite(h) && h > 0 && h < 1000) return { h, minH: Math.min(minH, h), src: 0, levels: Number.isFinite(lv) ? lv : 0 };
  if (Number.isFinite(lv) && lv > 0 && lv < 200) { const H = (lv + (Number.isFinite(rl) && rl > 0 ? rl : 0)) * LEVEL_M; return { h: H, minH: Math.min(minH, H), src: 1, levels: lv }; }
  const e = EST[t.building] ?? EST.yes; return { h: e, minH: 0, src: 2, levels: 0 };
}

// ---------- 擷取（tools/osm/osm-buildings.mjs 用）----------
export function extractBuildings(pbf, { log = () => {} } = {}) {
  const t0 = Date.now(), outerWays = new Map(), stats = { ways: 0, relations: 0, relationOuters: 0, parts: 0, tooFewNodes: 0, missingNodes: 0, bySource: [0, 0, 0] };
  // 第一趟：relation（multipolygon 建築的 outer）
  scan(pbf, { relation(id, members, t) {
    if (t.type !== 'multipolygon' || !t.building || t.building === 'no') return; stats.relations++;
    for (const m of members) if (m.type === 'w' && (m.role === 'outer' || m.role === '')) outerWays.set(m.ref, t);
  } });
  log(`  建築 relation ${stats.relations}、outer way ${outerWays.size}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  // 第二趟：way
  const refs = new Grow(Float64Array, 1 << 22), off = new Grow(Int32Array, 1 << 20), H = new Grow(Float32Array, 1 << 20), MH = new Grow(Float32Array, 1 << 20), SR = new Grow(Uint8Array, 1 << 20), LV = new Grow(Uint8Array, 1 << 20), TY = new Grow(Int32Array, 1 << 20), NM = new Grow(Int32Array, 1 << 20), ID = new Grow(Float64Array, 1 << 20);
  const strings = [''], strIx = new Map([['', 0]]), str = s => { s = s || ''; let i = strIx.get(s); if (i === undefined) { i = strings.length; strings.push(s); strIx.set(s, i); } return i; };
  off.push(0);
  scan(pbf, { way(id, r, t) {
    if (t['building:part'] && t['building:part'] !== 'no') { stats.parts++; return; }
    let tags = t; if (!t.building || t.building === 'no') { const rt = outerWays.get(id); if (!rt) return; tags = { ...rt, ...t, building: rt.building }; stats.relationOuters++; }
    if (r.length < 4 || r[0] !== r[r.length - 1]) { stats.tooFewNodes++; return; }      // 只收封閉的外框
    const hh = heightOf(tags); refs.pushArr(r.subarray(0, r.length - 1)); off.push(refs.n);
    H.push(hh.h); MH.push(hh.minH); SR.push(hh.src); LV.push(Math.min(255, Math.round(hh.levels))); TY.push(str(tags.building)); NM.push(str(tags.name || tags['name:zh'] || '')); ID.push(id);
    stats.bySource[hh.src]++; stats.ways++;
  } });
  log(`  建築 way ${stats.ways.toLocaleString()}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）；節點參照 ${refs.n.toLocaleString()}`);
  // 第三趟：node 座標
  const ids = refs.trim(), uniq = Float64Array.from(ids).sort(); let u = 0; for (let i = 0; i < uniq.length; i++) if (i === 0 || uniq[i] !== uniq[i - 1]) uniq[u++] = uniq[i];
  const nLat = new Int32Array(u).fill(-2147483648), nLon = new Int32Array(u);
  scan(pbf, { nodeKey: id => bsearch(uniq, id, u), node(id, la, lo, tg, k) { nLat[k] = la; nLon[k] = lo; } });
  log(`  節點座標 ${u.toLocaleString()}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  // 組合：缺座標的建築整棟略過
  const n = stats.ways, O = off.trim(), lat = new Int32Array(ids.length), lon = new Int32Array(ids.length), keep = new Uint8Array(n); let bad = 0;
  for (let b = 0; b < n; b++) { let ok = true; for (let k = O[b]; k < O[b + 1]; k++) { const j = bsearch(uniq, ids[k], u); if (j < 0 || nLat[j] === -2147483648) { ok = false; break; } lat[k] = nLat[j]; lon[k] = nLon[j]; } keep[b] = ok ? 1 : 0; if (!ok) bad++; }
  stats.missingNodes = bad;
  return { n, off: O, lat, lon, keep, h: H.trim(), minH: MH.trim(), src: SR.trim(), levels: LV.trim(), type: TY.trim(), name: NM.trim(), id: ID.trim(), strings, stats, seconds: (Date.now() - t0) / 1000 };
}

// ---------- 檔案（TWBLD1）----------
// 只存保留的建築；格網索引（約 0.002 度 ≈ 200 m）放在檔案裡，伺服器讀檔後直接查
export function writeBuildings(path, x, meta = {}) {
  const idx = []; for (let b = 0; b < x.n; b++) if (x.keep[b]) idx.push(b);
  const N = idx.length, off = new Int32Array(N + 1); for (let i = 0; i < N; i++) off[i + 1] = off[i] + (x.off[idx[i] + 1] - x.off[idx[i]]);
  const lat = new Int32Array(off[N]), lon = new Int32Array(off[N]), bb = new Int32Array(N * 4);
  const h = new Uint16Array(N), mh = new Uint16Array(N), src = new Uint8Array(N), lv = new Uint8Array(N), ty = new Int32Array(N), nm = new Int32Array(N), id = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const b = idx[i]; let y0 = Infinity, y1 = -Infinity, x0 = Infinity, x1 = -Infinity;
    for (let k = x.off[b], j = off[i]; k < x.off[b + 1]; k++, j++) { lat[j] = x.lat[k]; lon[j] = x.lon[k]; if (x.lat[k] < y0) y0 = x.lat[k]; if (x.lat[k] > y1) y1 = x.lat[k]; if (x.lon[k] < x0) x0 = x.lon[k]; if (x.lon[k] > x1) x1 = x.lon[k]; }
    bb.set([y0, x0, y1, x1], i * 4); h[i] = Math.min(65535, Math.round(x.h[b] * 10)); mh[i] = Math.min(65535, Math.round(x.minH[b] * 10)); src[i] = x.src[b]; lv[i] = x.levels[b]; ty[i] = x.type[b]; nm[i] = x.name[b]; id[i] = x.id[b];
  }
  // 格網：每棟依外接框中心登記到一個格子（建築都很小；查詢時把範圍外擴一格即可）
  let gy0 = Infinity, gx0 = Infinity, gy1 = -Infinity, gx1 = -Infinity; for (let i = 0; i < N; i++) { const cy = (bb[i * 4] + bb[i * 4 + 2]) / 2, cx = (bb[i * 4 + 1] + bb[i * 4 + 3]) / 2; if (cy < gy0) gy0 = cy; if (cy > gy1) gy1 = cy; if (cx < gx0) gx0 = cx; if (cx > gx1) gx1 = cx; }
  if (!N) { gy0 = gx0 = gy1 = gx1 = 0; }
  let C = 20000, ny, nx; for (;;) { ny = Math.floor((gy1 - gy0) / C) + 1; nx = Math.floor((gx1 - gx0) / C) + 1; if (nx * ny <= 2e7) break; C *= 2; }
  const cell = i => Math.floor(((bb[i * 4] + bb[i * 4 + 2]) / 2 - gy0) / C) * nx + Math.floor(((bb[i * 4 + 1] + bb[i * 4 + 3]) / 2 - gx0) / C);
  const start = new Int32Array(nx * ny + 1); for (let i = 0; i < N; i++) start[cell(i) + 1]++; for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * ny), list = new Int32Array(N); for (let i = 0; i < N; i++) list[fill[cell(i)]++] = i;
  const sec = [['off', off], ['lat', lat], ['lon', lon], ['bb', bb], ['h', h], ['mh', mh], ['src', src], ['lv', lv], ['ty', ty], ['nm', nm], ['id', id], ['gstart', start], ['glist', list]];
  const strB = Buffer.from(x.strings.join('\0'), 'utf8'); sec.push(['strings', new Uint8Array(strB.buffer, strB.byteOffset, strB.length)]);
  let o = 0; const desc = sec.map(([name, a]) => { const d = { name, type: a.constructor.name, length: a.length, offset: o }; o += Math.ceil(a.byteLength / 8) * 8; return d; });
  const head = Buffer.from(JSON.stringify({ version: 1, created: new Date().toISOString(), meta, count: N, grid: { C, y0: gy0, x0: gx0, ny, nx }, stats: { ...x.stats, kept: N }, sections: desc }), 'utf8');
  const pre = Buffer.alloc(12); pre.write(MAGIC, 0, 'latin1'); pre.writeUInt32LE(head.length, 8);
  const pad0 = (8 - ((12 + head.length) % 8)) % 8, tmp = path + '.tmp', fd = openSync(tmp, 'w');
  try { writeSync(fd, pre); writeSync(fd, head); writeSync(fd, Buffer.alloc(pad0)); for (const [, a] of sec) { const b = Buffer.from(a.buffer, a.byteOffset, a.byteLength); writeSync(fd, b); const p = (8 - (b.length % 8)) % 8; if (p) writeSync(fd, Buffer.alloc(p)); } }
  finally { closeSync(fd); }
  renameSync(tmp, path); return { count: N, bytes: 12 + head.length + pad0 + o };
}
const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };
export function readBuildings(path) {
  const buf = readFileSync(path); if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error(`${path} 不是 TWBLD1 建築檔`);
  const hl = buf.readUInt32LE(8), head = JSON.parse(buf.toString('utf8', 12, 12 + hl)), base = 12 + hl + (8 - ((12 + hl) % 8)) % 8;
  const ab = buf.byteOffset % 8 === 0 ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), b0 = buf.byteOffset % 8 === 0 ? buf.byteOffset : 0;
  const S = {}; for (const d of head.sections) S[d.name] = new TYPES[d.type](ab, b0 + base + d.offset, d.length);
  const strings = Buffer.from(S.strings.buffer, S.strings.byteOffset, S.strings.length).toString('utf8').split('\0');
  return { head, n: head.count, grid: head.grid, ...S, strings };
}

// ---------- 圖磚查詢 ----------
const tile2lon = (x, z) => x / 2 ** z * 360 - 180, tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(n)); };
function simplifyRing(pts, tol) {                                                // 閉合環的簡化（Douglas–Peucker，首尾視為相連）
  const n = pts.length / 2; if (n <= 4 || !(tol > 0)) return pts;
  const keep = new Uint8Array(n); keep[0] = 1; let far = 0, fd = -1; for (let i = 1; i < n; i++) { const d = Math.hypot(pts[2 * i] - pts[0], pts[2 * i + 1] - pts[1]); if (d > fd) { fd = d; far = i; } } keep[far] = 1;
  const st = [[0, far], [far, n]];
  while (st.length) {
    const [a, b0] = st.pop(), b = b0 % n, ax = pts[2 * a], ay = pts[2 * a + 1], dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay, L2 = dx * dx + dy * dy; let md = -1, mi = -1;
    for (let i = a + 1; i < b0; i++) { const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay, t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0, d = Math.hypot(px - t * dx, py - t * dy); if (d > md) { md = d; mi = i; } }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b0]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]); return out;
}
// z：512 像素圖磚的層級（≥ 15）；回傳 { v, z, x, y, bbox, extent, types, names, b: [[h(dm), minH(dm), src, typeIx, nameIx(0＝無), x0, y0, dx, dy, …]], dropped }
export function buildingTile(B, z, x, y, { extent = 4096, maxFeatures = 12000 } = {}) {
  const west = tile2lon(x, z), east = tile2lon(x + 1, z), north = tile2lat(y, z), south = tile2lat(y + 1, z);
  const lo0 = Math.round(west * 1e7), lo1 = Math.round(east * 1e7), la0 = Math.round(south * 1e7), la1 = Math.round(north * 1e7), G = B.grid;
  const sx = extent / (lo1 - lo0), sy = extent / (la1 - la0), tol = extent / 512 * 0.5, minArea = (extent / 512) ** 2 * 1.5;   // 小於約 1.5 平方像素的建築不送
  const out = { v: 1, z, x, y, bbox: [west, south, east, north].map(v => Math.round(v * 1e6) / 1e6), extent, types: [], names: [], b: [], dropped: 0, sourceLabels: SRC };
  const tyIx = new Map(), nmIx = new Map(), cy0 = Math.max(0, Math.floor((la0 - G.y0) / G.C) - 1), cy1 = Math.min(G.ny - 1, Math.floor((la1 - G.y0) / G.C) + 1), cx0 = Math.max(0, Math.floor((lo0 - G.x0) / G.C) - 1), cx1 = Math.min(G.nx - 1, Math.floor((lo1 - G.x0) / G.C) + 1);
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
    const c = cy * G.nx + cx; if (c < 0 || c >= G.nx * G.ny) continue;
    for (let t = B.gstart[c]; t < B.gstart[c + 1]; t++) {
      const i = B.glist[t], ccy = (B.bb[i * 4] + B.bb[i * 4 + 2]) / 2, ccx = (B.bb[i * 4 + 1] + B.bb[i * 4 + 3]) / 2;
      if (ccy < la0 || ccy >= la1 || ccx < lo0 || ccx >= lo1) continue;          // 每棟只放在中心點所在的圖磚（不重複）
      const pts = []; for (let k = B.off[i]; k < B.off[i + 1]; k++) pts.push(Math.round((B.lon[k] - lo0) * sx), Math.round((la1 - B.lat[k]) * sy));
      let area = 0; for (let k = 0, m = pts.length / 2; k < m; k++) { const j = (k + 1) % m; area += pts[2 * k] * pts[2 * j + 1] - pts[2 * j] * pts[2 * k + 1]; }
      if (Math.abs(area) / 2 < minArea) { out.dropped++; continue; }
      const s = simplifyRing(pts, tol); if (s.length < 6) { out.dropped++; continue; }
      if (out.b.length >= maxFeatures) { out.dropped++; continue; }
      const tn = B.strings[B.ty[i]] || 'yes'; let ti = tyIx.get(tn); if (ti === undefined) { ti = out.types.length; out.types.push(tn); tyIx.set(tn, ti); }
      const nn = B.strings[B.nm[i]] || ''; let ni = 0; if (nn) { ni = nmIx.get(nn); if (ni === undefined) { out.names.push(nn); ni = out.names.length; nmIx.set(nn, ni); } }
      const f = [B.h[i], B.mh[i], B.src[i], ti, ni, s[0], s[1]]; for (let k = 2; k < s.length; k += 2) f.push(s[k] - s[k - 2], s[k + 1] - s[k - 1]);
      out.b.push(f);
    }
  }
  return out;
}
