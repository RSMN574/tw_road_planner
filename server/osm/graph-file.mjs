// graph-file.mjs — OSM 道路圖的二進位檔（TWOSM1）
//   'TWOSM1\0\0'（8 bytes）＋ 表頭長度（uint32）＋ 表頭 JSON ＋ 對齊 8 bytes 的各區段（型別陣列原樣）
// 讀檔時各陣列直接是檔案緩衝區上的檢視（不複製），台灣全島也能在數秒內載入。
import { readFileSync, renameSync, openSync, writeSync, readSync, closeSync } from 'node:fs';

export const MAGIC = 'TWOSM1\0\0', VERSION = 1;
const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array };

// g：buildTopology 的結果；meta：來源檔資訊等
export function writeGraph(path, g, meta = {}) {
  const sec = [], put = (name, arr) => sec.push({ name, arr });
  for (const k of ['osm', 'lat', 'lon', 'flags', 'level']) put('v.' + k, g.V[k]);
  const bv = [...g.V.barrier.keys()], bacc = new Uint8Array(bv.length * 5); bv.forEach((v, i) => bacc.set(g.V.barrier.get(v), i * 5));
  put('v.bar.v', Int32Array.from(bv)); put('v.bar.acc', bacc);
  for (const k of ['u', 'v', 'way', 'len', 'sig', 'ref0', 'goff']) put('e.' + k, g.E[k]);
  for (const k of ['lat', 'lon', 'node', 'cum']) put('g.' + k, g.G[k]);
  for (const k of Object.keys(g.W)) if (k !== 'n' && ArrayBuffer.isView(g.W[k])) put('w.' + k, g.W[k]);
  const strBytes = Buffer.from(g.strings.join('\0'), 'utf8'); put('strings', new Uint8Array(strBytes.buffer, strBytes.byteOffset, strBytes.length));
  const restr = Buffer.from(JSON.stringify(g.restrictions.rules), 'utf8'); put('restrictions', new Uint8Array(restr.buffer, restr.byteOffset, restr.length));
  let off = 0; const desc = sec.map(s => { const d = { name: s.name, type: s.arr.constructor.name, length: s.arr.length, offset: off }; off += Math.ceil(s.arr.byteLength / 8) * 8; return d; });
  const head = Buffer.from(JSON.stringify({ version: VERSION, created: new Date().toISOString(), meta, counts: { vertices: g.V.n, edges: g.E.n, ways: g.W.n, geometry: g.G.lat.length, restrictions: g.restrictions.rules.length }, pbfHeader: g.header, stats: g.stats, restrictionStats: g.restrictions.stats, sections: desc }), 'utf8');
  const pre = Buffer.alloc(12); pre.write(MAGIC, 0, 'latin1'); pre.writeUInt32LE(head.length, 8);
  const pad0 = (8 - ((12 + head.length) % 8)) % 8, tmp = path + '.tmp', fd = openSync(tmp, 'w');
  try {
    writeSync(fd, pre); writeSync(fd, head); writeSync(fd, Buffer.alloc(pad0));
    for (const s of sec) { const b = Buffer.from(s.arr.buffer, s.arr.byteOffset, s.arr.byteLength); writeSync(fd, b); const p = (8 - (b.length % 8)) % 8; if (p) writeSync(fd, Buffer.alloc(p)); }
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  return { bytes: 12 + head.length + pad0 + off };
}

export function readGraph(path) {
  const buf = readFileSync(path);
  if (buf.toString('latin1', 0, 8) !== MAGIC) throw new Error(`${path} 不是 TWOSM1 道路圖檔`);
  const hl = buf.readUInt32LE(8), head = JSON.parse(buf.toString('utf8', 12, 12 + hl)), base = 12 + hl + (8 - ((12 + hl) % 8)) % 8;
  if (head.version !== VERSION) throw new Error(`道路圖版本 ${head.version}，這支程式只讀 ${VERSION}，請重新建圖`);
  // 對齊：Node 的 Buffer 可能不是 8 bytes 對齊，必要時複製一份
  const ab = (buf.byteOffset % 8 === 0) ? buf.buffer : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), b0 = (buf.byteOffset % 8 === 0) ? buf.byteOffset : 0;
  const S = {}; for (const d of head.sections) S[d.name] = new TYPES[d.type](ab, b0 + base + d.offset, d.length);
  const V = { n: head.counts.vertices, osm: S['v.osm'], lat: S['v.lat'], lon: S['v.lon'], flags: S['v.flags'], level: S['v.level'], barrier: new Map() };
  for (let i = 0; i < S['v.bar.v'].length; i++) V.barrier.set(S['v.bar.v'][i], S['v.bar.acc'].subarray(i * 5, i * 5 + 5));
  const E = { n: head.counts.edges }; for (const k of ['u', 'v', 'way', 'len', 'sig', 'ref0', 'goff']) E[k] = S['e.' + k];
  const G = {}; for (const k of ['lat', 'lon', 'node', 'cum']) G[k] = S['g.' + k];
  const W = { n: head.counts.ways }; for (const d of head.sections) if (d.name.startsWith('w.')) W[d.name.slice(2)] = S[d.name];
  const strings = Buffer.from(S.strings.buffer, S.strings.byteOffset, S.strings.length).toString('utf8').split('\0');
  const rules = JSON.parse(Buffer.from(S.restrictions.buffer, S.restrictions.byteOffset, S.restrictions.length).toString('utf8'));
  return { head, header: head.pbfHeader, stats: head.stats, V, E, G, W, strings, restrictions: { rules, stats: head.restrictionStats } };
}
// 只讀表頭（檢查用，不載入整張圖）
export function readGraphHead(path) {
  const fd = openSync(path, 'r'); try {
    const pre = Buffer.alloc(12); readSync(fd, pre, 0, 12, 0); if (pre.toString('latin1', 0, 8) !== MAGIC) throw new Error(`${path} 不是 TWOSM1 道路圖檔`);
    const hl = pre.readUInt32LE(8), hb = Buffer.alloc(hl); readSync(fd, hb, 0, hl, 12); return JSON.parse(hb.toString('utf8'));
  } finally { closeSync(fd); }
}
