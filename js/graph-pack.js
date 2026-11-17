// graph-pack.js — 路網二進位封包（graph.bin）：把「建好的圖」直接存成型別陣列，網頁載入時不必解析 JSON、也不必重新建圖
//
// ・由伺服器（server/engine.mjs）或工具（tools/pack-graph.mjs）在 Node 端從 nodes/edges/roads.json 產生；瀏覽器與伺服器共用這支程式
// ・內容與 buildGraphCore 解析 JSON 的結果完全相同（測試逐欄比對）；只有 adjEdge（沒有任何模組使用）不收錄
// ・為了讓 gzip／brotli 壓得更小：位移改存「長度」、遞增的數列存「與前一個的差」、鄰接點存「與起點的差」、edgeId 盡量存成數字
// 檔案格式：'TWGRAPH1'（8 bytes）＋ 表頭長度（uint32）＋ 表頭 JSON ＋ 對齊 8 bytes 的各區段
import { State } from './state.js';

export const PACK_MAGIC = 'TWGRAPH1', PACK_VERSION = 1;
const T = { u8: Uint8Array, u16: Uint16Array, i32: Int32Array, u32: Uint32Array, f32: Float32Array, f64: Float64Array };
// 表頭 JSON：NaN／Infinity 要原樣保留（道路屬性的 NaN 代表「沒有資料」，變成 null 會被當成 0）
const rep = (k, v) => typeof v === 'number' && !Number.isFinite(v) ? { __n: String(v) } : v, rev = (k, v) => v && typeof v === 'object' && typeof v.__n === 'string' ? Number(v.__n) : v;
const isIntStr = s => typeof s === 'string' && /^-?(0|[1-9]\d{0,8})$/.test(s);

// ---------- 編碼（Node 端）----------
// 非負整數：用放得下的最小型別
function uint(a) { let mx = 0; for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i]; return mx < 256 ? Uint8Array.from(a) : mx < 65536 ? Uint16Array.from(a) : Uint32Array.from(a); }
// 位移陣列（長度 n+1、遞增）→ 每段的長度
const lensOf = off => { const l = new Array(off.length - 1); for (let i = 0; i < l.length; i++) l[i] = off[i + 1] - off[i]; return uint(l); };
// 與前一個的差
const delta = a => { const d = new Int32Array(a.length); for (let i = 0; i < a.length; i++) d[i] = a[i] - (i ? a[i - 1] : 0); return d; };
// 數值陣列：能無損存成較小的型別就用小的
function smallest(a) {
  let int = true, f32 = true;
  for (let i = 0; i < a.length && (int || f32); i++) { const v = a[i]; if (int && !(Number.isInteger(v) && v >= -2147483648 && v <= 2147483647)) int = false; if (f32 && Math.fround(v) !== v) f32 = false; }
  return int ? Int32Array.from(a) : f32 ? Float32Array.from(a) : Float64Array.from(a);
}
// 字串陣列：全部是「標準寫法的整數」就存數字（差值），否則存成一段 UTF-8 ＋ 每個字串的長度（UTF-16 單位；解碼時整段解一次再切）
function packStrings(name, arr, put) {
  if (arr.every(isIntStr)) { put(name + '.num', delta(Int32Array.from(arr, Number))); return 'num'; }
  put(name + '.txt', new TextEncoder().encode(arr.join(''))); put(name + '.len', uint(arr.map(s => s.length))); return 'txt';
}

// 從 State（剛由 JSON 建好、尚未套用道路屬性表）產生封包；meta 會原樣放進表頭（例如來源檔案的大小與時間）
export function encodePack(meta = {}) {
  const S = State, N = S.N, M = S.adjTo.length, sec = [], put = (name, arr) => sec.push({ name, arr });
  // 節點座標：整數座標（例如 TWD97 公分）存差值，否則原樣
  const xs = new Float64Array(N), ys = new Float64Array(N);
  for (let i = 0; i < N; i++) { xs[i] = S.nodeXY[i * 5 + 2]; ys[i] = S.nodeXY[i * 5 + 3]; }
  const cx = smallest(xs), cy = smallest(ys), intXY = cx instanceof Int32Array && cy instanceof Int32Array;
  if (intXY) { put('x.d', delta(cx)); put('y.d', delta(cy)); } else { put('x', cx); put('y', cy); }
  const idKind = packStrings('id', S.nodeIds, put);
  put('deg', lensOf(S.adjOffset));
  const to = new Int32Array(M); for (let u = 0; u < N; u++) for (let k = S.adjOffset[u]; k < S.adjOffset[u + 1]; k++) to[k] = S.adjTo[k] - u;
  put('to.d', to); put('w', smallest(S.adjW));
  // edgeId：不重複的 ID 表 ＋ 每條有向邊的編號（-1 = 沒有 ID；存與前一條的差）
  const eidIx = new Map(), eids = [], ix = new Int32Array(M);
  for (let k = 0; k < M; k++) { const e = S.adjEid[k]; if (e == null) { ix[k] = -1; continue; } let j = eidIx.get(e); if (j === undefined) { j = eids.length; eids.push(e); eidIx.set(e, j); } ix[k] = j; }
  for (const e of S.edgeIdToRoadNames.keys()) if (!eidIx.has(e)) { eidIx.set(e, eids.length); eids.push(e); }        // 只出現在 roads.json 的 edgeId 也要收錄
  for (const e of S.edgeAttr.keys()) if (!eidIx.has(e)) { eidIx.set(e, eids.length); eids.push(e); }
  put('eix.d', delta(ix));
  const eidKind = packStrings('eid', eids, put);
  // 道路名（已排序）、路名 → 節點（各路內部存差值）、edgeId → 路名（保留加入順序：第一個路名就是顯示用的路名）
  const roads = S.roadNames, rIx = new Map(roads.map((r, i) => [r, i])), roadKind = packStrings('road', roads, put);
  const rnLen = [], rn = []; for (const r of roads) { const a = S.roadNameToNodes.get(r) || []; rnLen.push(a.length); for (let i = 0; i < a.length; i++) rn.push(a[i] - (i ? a[i - 1] : 0)); }
  put('rn.len', uint(rnLen)); put('rn.d', Int32Array.from(rn));
  const erE = [], erLen = [], erR = [];
  for (const [e, ns] of S.edgeIdToRoadNames) { erE.push(eidIx.get(e)); erLen.push(ns.size); for (const r of ns) erR.push(rIx.get(r)); }
  put('er.e', delta(Int32Array.from(erE))); put('er.len', uint(erLen)); put('er.r', uint(erR));
  // 道路屬性（roads.json 裡的寬度、速限等；同一條路的屬性共用同一個物件）
  const attrs = [], aIx = new Map(), eaE = [], eaA = [];
  for (const [e, a] of S.edgeAttr) { let j = aIx.get(a); if (j === undefined) { j = attrs.length; attrs.push(a); aIx.set(a, j); } eaE.push(eidIx.get(e)); eaA.push(j); }
  put('ea.e', delta(Int32Array.from(eaE))); put('ea.a', uint(eaA));
  const head = { v: PACK_VERSION, N, M, E: S.E, intXY, idKind, eidKind, roadKind, attrs, meta, sections: [] };
  // 排版：表頭 → 各區段（8 bytes 對齊，解碼時可以直接建型別陣列視圖，不必複製）
  let off = 0; for (const s of sec) { off = (off + 7) & ~7; head.sections.push({ name: s.name, type: Object.keys(T).find(k => s.arr.constructor === T[k]), offset: off, length: s.arr.length }); off += s.arr.byteLength; }
  const hb = new TextEncoder().encode(JSON.stringify(head, rep)), base = (12 + hb.length + 7) & ~7, buf = new Uint8Array(base + off);
  buf.set(new TextEncoder().encode(PACK_MAGIC), 0); new DataView(buf.buffer).setUint32(8, hb.length, true); buf.set(hb, 12);
  sec.forEach((s, i) => buf.set(new Uint8Array(s.arr.buffer, s.arr.byteOffset, s.arr.byteLength), base + head.sections[i].offset));
  return buf;
}

// ---------- 解碼（瀏覽器／伺服器）----------
export function readPackHeader(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 12 || new TextDecoder().decode(u8.subarray(0, 8)) !== PACK_MAGIC) throw new Error('不是路網封包（graph.bin）');
  const hl = new DataView(u8.buffer, u8.byteOffset).getUint32(8, true), head = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl)), rev);
  if (head.v !== PACK_VERSION) throw new Error(`路網封包版本不符（檔案 v${head.v}，程式 v${PACK_VERSION}）`);
  return { head, u8, base: (12 + hl + 7) & ~7 };
}
// 把封包內容放進 State（等同 buildGraphCore 解析 JSON 的結果）；之後由呼叫端做共同的收尾（座標型別、空間索引、快取作廢）
export function applyPack(buf) {
  const { head: H, u8, base } = readPackHeader(buf), S = State;
  const get = name => { const s = H.sections.find(x => x.name === name); if (!s) throw new Error('路網封包缺少區段 ' + name); const C = T[s.type], at = u8.byteOffset + base + s.offset;
    return at % C.BYTES_PER_ELEMENT === 0 ? new C(u8.buffer, at, s.length) : new C(u8.slice(base + s.offset, base + s.offset + s.length * C.BYTES_PER_ELEMENT).buffer); };
  const strings = (name, kind) => {
    if (kind === 'num') { const d = get(name + '.num'), out = new Array(d.length); let v = 0; for (let i = 0; i < d.length; i++) { v += d[i]; out[i] = String(v); } return out; }
    const big = new TextDecoder().decode(get(name + '.txt')), len = get(name + '.len'), out = new Array(len.length); let p = 0;
    for (let i = 0; i < len.length; i++) { out[i] = big.slice(p, p + len[i]); p += len[i]; }
    return out;
  };
  const N = H.N, M = H.M;
  S.nodeXY = new Float64Array(N * 5);
  if (H.intXY) { const dx = get('x.d'), dy = get('y.d'); let x = 0, y = 0; for (let i = 0; i < N; i++) { x += dx[i]; y += dy[i]; S.nodeXY[i * 5 + 2] = x; S.nodeXY[i * 5 + 3] = y; } }
  else { const xs = get('x'), ys = get('y'); for (let i = 0; i < N; i++) { S.nodeXY[i * 5 + 2] = xs[i]; S.nodeXY[i * 5 + 3] = ys[i]; } }
  S.nodeIds = strings('id', H.idKind);
  S.nodeIdToIdx = lazyIdMap(S.nodeIds);
  const deg = get('deg'), td = get('to.d'), off = new Uint32Array(N + 1), to = new Uint32Array(M);
  for (let u = 0; u < N; u++) { off[u + 1] = off[u] + deg[u]; S.nodeXY[u * 5 + 4] = deg[u]; for (let k = off[u]; k < off[u + 1]; k++) to[k] = u + td[k]; }
  S.adjOffset = off; S.adjTo = to; S.adjW = Float64Array.from(get('w')); S.adjEdge = null;
  const eids = strings('eid', H.eidKind), ed = get('eix.d'), adjEid = new Array(M); let j = 0;
  for (let k = 0; k < M; k++) { j += ed[k]; adjEid[k] = j < 0 ? null : eids[j]; }
  S.adjEid = adjEid; S.edgeIdToNodes = new Map();
  S.roadNames = strings('road', H.roadKind);
  const rnLen = get('rn.len'), rn = get('rn.d'); S.roadNameToNodes = new Map(); let p = 0;
  for (let i = 0; i < rnLen.length; i++) { const a = new Array(rnLen[i]); let v = 0; for (let q = 0; q < a.length; q++) { v += rn[p++]; a[q] = v; } S.roadNameToNodes.set(S.roadNames[i], a); }
  const erE = get('er.e'), erLen = get('er.len'), erR = get('er.r'), one = new Map(); S.edgeIdToRoadNames = new Map(); let e = 0; p = 0;
  for (let i = 0; i < erLen.length; i++) {
    e += erE[i]; let set;
    if (erLen[i] === 1) { const r = S.roadNames[erR[p++]]; set = one.get(r); if (!set) { set = new Set([r]); one.set(r, set); } }        // 只屬於一條路：共用（唯讀）
    else { set = new Set(); for (let q = 0; q < erLen[i]; q++) set.add(S.roadNames[erR[p++]]); }
    S.edgeIdToRoadNames.set(eids[e], set);
  }
  const eaE = get('ea.e'), eaA = get('ea.a'); S.edgeAttr = new Map(); e = 0;
  for (let i = 0; i < eaA.length; i++) { e += eaE[i]; S.edgeAttr.set(eids[e], H.attrs[eaA[i]]); }
  S.N = N; S.E = H.E; S.loaded = true;
  return H;
}
// 節點 ID → 索引：大路網上一次建 140 萬筆的 Map 很花時間，改成第一次查詢時才建
function lazyIdMap(ids) {
  let m = null; const real = () => m || (m = new Map(ids.map((id, i) => [id, i])));
  return { get: k => real().get(k), has: k => real().has(k), set: (k, v) => real().set(k, v), get size() { return real().size; }, keys: () => real().keys(), [Symbol.iterator]: () => real()[Symbol.iterator]() };
}
