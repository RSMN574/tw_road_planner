// pbf.mjs — OpenStreetMap PBF 讀取器（純 Node：node:fs＋node:zlib，不需外部套件）
//
// 格式：https://wiki.openstreetmap.org/wiki/PBF_Format
//   檔案 = 連續的「4 bytes 長度（大端）＋ BlobHeader ＋ Blob」；第一個是 OSMHeader，其餘是 OSMData（PrimitiveBlock）
//   Blob 可能是 raw／zlib／zstd（Node 22.15＋）；lzma、lz4 不支援時會明確報錯
//
// 用法（同步、串流讀檔，不會把整個檔案讀進記憶體）：
//   const h = readHeader(path)                       → { bbox, writingProgram, source, replication: { timestamp, sequence, baseUrl }, required, optional }
//   scan(path, { node, way, relation, nodeTags, blobs, onBlob })
//     node(id, lat7, lon7, tags|null, key)            座標是整數「1e-7 度」；tags 只在 nodeTags=true 且該點有標籤時才建立
//     nodeKey(id) → 數字：< 0 表示不要這個點（跳過，不建立標籤物件）；≥ 0 會原樣傳給 node() 的第 5 個參數
//     way(id, refs:Float64Array, tags)
//     relation(id, members:[{type:'n'|'w'|'r', ref, role}], tags)
//     blobs：只讀這些 blob（index 陣列；第二趟只讀含 node 的區塊用）；onBlob(i, kinds) 回報每個 blob 含哪些元素
// OSM ID 可能超過 2^32（台灣的 node id 已經 > 1e10），全部用 JS number（2^53 內精確）
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';
import * as zlib from 'node:zlib';

// ---------- protobuf 解碼 ----------
class Pb {
  constructor(buf, pos = 0, end = buf.length) { this.b = buf; this.p = pos; this.e = end; }
  more() { return this.p < this.e; }
  varint() {                                            // 無號 varint（最多 64 位；超過 2^53 的值會失去精度——OSM 的 ID、座標不會）
    const b = this.b; let x = 0, s = 0, c;
    do { c = b[this.p++]; if (s < 28) x |= (c & 0x7f) << s; else x += (c & 0x7f) * 2 ** s; s += 7; } while (c & 0x80);
    return s <= 28 ? x >>> 0 : x;
  }
  svarint() { const v = this.varint(); return v % 2 === 1 ? -(v + 1) / 2 : v / 2; }   // zigzag
  int64() { const v = this.varint(); return v >= 2 ** 63 ? v - 2 ** 64 : v; }          // 負的 int64（10 bytes）
  tag() { const t = this.varint(); this.wt = t & 7; return t >>> 3; }
  bytes() { const n = this.varint(), s = this.p; this.p += n; return this.b.subarray(s, s + n); }
  sub() { const n = this.varint(), s = this.p; this.p += n; return new Pb(this.b, s, s + n); }
  skip() { switch (this.wt) { case 0: this.varint(); break; case 1: this.p += 8; break; case 2: { const n = this.varint(); this.p += n; break; } case 5: this.p += 4; break; default: throw new Error('PBF：不支援的 wire type ' + this.wt); } }
  // packed 欄位
  packedVarint(out) { const n = this.varint(), end = this.p + n; while (this.p < end) out.push(this.varint()); return out; }
  packedSvarintDelta(out) { const n = this.varint(), end = this.p + n; let acc = 0; while (this.p < end) { acc += this.svarint(); out.push(acc); } return out; }
}
const utf8 = new TextDecoder('utf-8');

// ---------- Blob ----------
const zstdOk = typeof zlib.zstdDecompressSync === 'function';
function readExact(fd, n, pos) { const b = Buffer.allocUnsafe(n); let got = 0; while (got < n) { const r = readSync(fd, b, got, n - got, pos + got); if (r <= 0) throw new Error(`PBF：檔案在 ${pos + got} bytes 處意外結束（下載不完整？）`); got += r; } return b; }
function* blobs(path) {
  const fd = openSync(path, 'r'), size = fstatSync(fd).size; let pos = 0, i = 0;
  try {
    while (pos < size) {
      const hl = readExact(fd, 4, pos).readUInt32BE(0); pos += 4;
      if (hl > 64 * 1024) throw new Error(`PBF：BlobHeader 長度 ${hl} 不合理（不是 PBF 檔，或檔案損毀）`);
      const h = new Pb(readExact(fd, hl, pos)); pos += hl;
      let type = '', datasize = 0;
      while (h.more()) { const f = h.tag(); if (f === 1) type = utf8.decode(h.bytes()); else if (f === 3) datasize = h.varint(); else h.skip(); }
      if (datasize > 64 * 1024 * 1024) throw new Error(`PBF：Blob 長度 ${datasize} 超過 64 MB 上限`);
      yield { i: i++, type, pos, datasize, fd };
      pos += datasize;
    }
  } finally { closeSync(fd); }
}
function inflateBlob(fd, pos, n) {
  const p = new Pb(readExact(fd, n, pos)); let raw = null, rawSize = 0, z = null, kind = '';
  while (p.more()) { const f = p.tag();
    if (f === 1) raw = p.bytes(); else if (f === 2) rawSize = p.varint(); else if (f === 3) { z = p.bytes(); kind = 'zlib'; }
    else if (f === 4) { p.skip(); kind = 'lzma'; } else if (f === 5) { p.skip(); kind = 'bzip2'; } else if (f === 6) { p.skip(); kind = 'lz4'; } else if (f === 7) { z = p.bytes(); kind = 'zstd'; } else p.skip(); }
  if (raw) return raw;
  if (kind === 'zlib') { const out = zlib.inflateSync(z); if (rawSize && out.length !== rawSize) throw new Error(`PBF：解壓後長度 ${out.length} ≠ 標示的 ${rawSize}（檔案損毀）`); return out; }
  if (kind === 'zstd') { if (!zstdOk) throw new Error('PBF：這個檔案用 zstd 壓縮，需要 Node 22.15 以上（或先用 osmium cat 轉成 zlib）'); return zlib.zstdDecompressSync(z); }
  throw new Error(`PBF：不支援的壓縮方式 ${kind || '（空的 Blob）'}；請用 osmium cat 重新輸出`);
}

// ---------- OSMHeader ----------
export function readHeader(path) {
  for (const b of blobs(path)) {
    if (b.type !== 'OSMHeader') throw new Error('PBF：第一個區塊不是 OSMHeader（不是 OSM PBF 檔？）');
    const p = new Pb(inflateBlob(b.fd, b.pos, b.datasize)), h = { required: [], optional: [], bbox: null, writingProgram: '', source: '', replication: {} };
    while (p.more()) { const f = p.tag();
      if (f === 1) { const q = p.sub(), bb = {}; while (q.more()) { const g = q.tag(); const v = q.svarint() / 1e9; if (g === 1) bb.left = v; else if (g === 2) bb.right = v; else if (g === 3) bb.top = v; else if (g === 4) bb.bottom = v; } h.bbox = bb; }
      else if (f === 4) h.required.push(utf8.decode(p.bytes())); else if (f === 5) h.optional.push(utf8.decode(p.bytes()));
      else if (f === 16) h.writingProgram = utf8.decode(p.bytes()); else if (f === 17) h.source = utf8.decode(p.bytes());
      else if (f === 32) h.replication.timestamp = new Date(p.int64() * 1000).toISOString(); else if (f === 33) h.replication.sequence = p.int64(); else if (f === 34) h.replication.baseUrl = utf8.decode(p.bytes());
      else p.skip(); }
    const bad = h.required.filter(x => !['OsmSchema-V0.6', 'DenseNodes', 'Sort.Type_then_ID', 'Sort.Geographic', 'HistoricalInformation'].includes(x));
    if (bad.length) throw new Error('PBF：需要不支援的功能 ' + bad.join(', '));
    if (h.required.includes('HistoricalInformation')) throw new Error('PBF：這是含歷史版本的檔案（.osh.pbf），請改用一般的 .osm.pbf');
    return h;
  }
  throw new Error('PBF：空的檔案');
}

// ---------- OSMData ----------
// 只解碼呼叫端要的元素；不要的群組（例如第一趟只要 way、relation 時的 dense node）直接跳過
export function scan(path, { node = null, nodeKey = null, way = null, relation = null, nodeTags = false, only = null, onBlob = null, onProgress = null } = {}) {
  const st = { blobs: 0, nodes: 0, ways: 0, relations: 0, bytes: 0 };
  for (const b of blobs(path)) {
    if (b.type !== 'OSMData') continue;
    if (only && !only.has(b.i)) continue;
    const buf = inflateBlob(b.fd, b.pos, b.datasize); st.blobs++; st.bytes += b.datasize;
    const kinds = decodeBlock(buf, { node, nodeKey, way, relation, nodeTags }, st);
    if (onBlob) onBlob(b.i, kinds);
    if (onProgress && st.blobs % 200 === 0) onProgress(st);
  }
  return st;
}

function decodeBlock(buf, cb, st) {
  const p = new Pb(buf), groups = []; let strings = null, gran = 100, latOff = 0, lonOff = 0;
  while (p.more()) { const f = p.tag();
    if (f === 1) { const q = p.sub(); strings = []; while (q.more()) { if (q.tag() === 1) strings.push(utf8.decode(q.bytes())); else q.skip(); } }
    else if (f === 2) { const n = p.varint(); groups.push([p.p, p.p + n]); p.p += n; }
    else if (f === 17) gran = p.varint(); else if (f === 19) latOff = p.int64(); else if (f === 20) lonOff = p.int64(); else p.skip(); }
  const toE7 = (off, v) => Math.round((off + gran * v) / 100);       // 奈度 → 1e-7 度
  let kinds = 0;                                                     // 1 node、2 way、4 relation
  for (const [s, e] of groups) {
    const g = new Pb(buf, s, e);
    while (g.more()) { const f = g.tag();
      if (f === 2) { kinds |= 1; if (!cb.node) { g.skip(); continue; } dense(g.sub(), strings, toE7, latOff, lonOff, cb, st); }
      else if (f === 1) { kinds |= 1; if (!cb.node) { g.skip(); continue; } plainNode(g.sub(), strings, toE7, latOff, lonOff, cb, st); }
      else if (f === 3) { kinds |= 2; if (!cb.way) { g.skip(); continue; } wayMsg(g.sub(), strings, cb, st); }
      else if (f === 4) { kinds |= 4; if (!cb.relation) { g.skip(); continue; } relMsg(g.sub(), strings, cb, st); }
      else g.skip(); }
  }
  return kinds;
}
function tagsOf(keys, vals, S) { const t = {}; for (let i = 0; i < keys.length; i++) t[S[keys[i]]] = S[vals[i]]; return t; }
function dense(q, S, toE7, latOff, lonOff, cb, st) {
  const ids = [], lats = [], lons = [], kv = [];
  while (q.more()) { const f = q.tag();
    if (f === 1) q.packedSvarintDelta(ids); else if (f === 8) q.packedSvarintDelta(lats); else if (f === 9) q.packedSvarintDelta(lons); else if (f === 10) q.packedVarint(kv); else q.skip(); }
  let j = 0;
  for (let i = 0; i < ids.length; i++) {
    const key = cb.nodeKey ? cb.nodeKey(ids[i]) : 0; let tags = null;          // nodeKey < 0：不要這個點（不建標籤物件、不呼叫）
    if (kv.length) {                                                   // keys_vals：每個點「k v k v … 0」
      if (kv[j] === 0) j++;
      else { if (cb.nodeTags && key >= 0) tags = {}; while (j < kv.length && kv[j] !== 0) { if (tags) tags[S[kv[j]]] = S[kv[j + 1]]; j += 2; } j++; }
    }
    st.nodes++; if (key >= 0) cb.node(ids[i], toE7(latOff, lats[i]), toE7(lonOff, lons[i]), tags, key);
  }
}
function plainNode(q, S, toE7, latOff, lonOff, cb, st) {
  let id = 0, lat = 0, lon = 0; const keys = [], vals = [];
  while (q.more()) { const f = q.tag(); if (f === 1) id = q.svarint(); else if (f === 2) q.packedVarint(keys); else if (f === 3) q.packedVarint(vals); else if (f === 8) lat = q.svarint(); else if (f === 9) lon = q.svarint(); else q.skip(); }
  st.nodes++; const key = cb.nodeKey ? cb.nodeKey(id) : 0; if (key < 0) return;
  cb.node(id, toE7(latOff, lat), toE7(lonOff, lon), cb.nodeTags && keys.length ? tagsOf(keys, vals, S) : null, key);
}
function wayMsg(q, S, cb, st) {
  let id = 0; const keys = [], vals = [], refs = [];
  while (q.more()) { const f = q.tag(); if (f === 1) id = q.int64(); else if (f === 2) q.packedVarint(keys); else if (f === 3) q.packedVarint(vals); else if (f === 8) q.packedSvarintDelta(refs); else q.skip(); }
  st.ways++; cb.way(id, Float64Array.from(refs), tagsOf(keys, vals, S));
}
function relMsg(q, S, cb, st) {
  let id = 0; const keys = [], vals = [], roles = [], mem = [], types = [];
  while (q.more()) { const f = q.tag(); if (f === 1) id = q.int64(); else if (f === 2) q.packedVarint(keys); else if (f === 3) q.packedVarint(vals); else if (f === 8) q.packedVarint(roles); else if (f === 9) q.packedSvarintDelta(mem); else if (f === 10) q.packedVarint(types); else q.skip(); }
  st.relations++;
  cb.relation(id, mem.map((ref, i) => ({ type: 'nwr'[types[i]] || '?', ref, role: S[roles[i]] || '' })), tagsOf(keys, vals, S));
}
