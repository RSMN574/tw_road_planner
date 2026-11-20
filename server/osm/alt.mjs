// alt.mjs — ALT（A*、地標、三角不等式）：全台跨縣市路線的加速
//
// 建圖時為每種運具選幾個地標 L（台灣本島外圍的 8 個方向），算出每個頂點到地標、地標到每個頂點的最短時間，存成 osm-alt.bin。
// 搜尋時 d(v, 終點) ≥ max(d(L,終點) − d(L,v), d(v,L) − d(終點,L))，比「直線距離 ÷ 最高速度」緊很多，A* 少展開很多邊。
// 下界成立的條件：地標表用的權重 ≤ 實際搜尋的成本。這裡用「時間」、不含轉向限制、不擋障礙物、未知與有條件的路段都算可走，
// 實際搜尋的成本 ＝ 時間 × 係數（≥1）＋ 轉向延遲（≥0）＋ …，所以一定成立；路線結果與不用地標時完全相同（只是比較快）。
// 模型參數（速度表、延遲表）改了，表上會記錄的指紋（MODEL_KEY）就對不上，搜尋會自動不用它。
// 儲存：每個頂點每個地標兩個 uint16（往返時間，單位 unit 秒，65535＝到不了）。全台 140 萬頂點、8 個地標：每種運具約 45 MB。
import { openSync, readSync, writeSync, closeSync, renameSync } from 'node:fs';
import { MinHeap } from '../../js/heap.js';
import { MODEL_KEY, CLASS_COST, FERRY_BOARD_COST } from './router.mjs';
import { HIGHWAYS } from './tags.mjs';
import { NF } from './topology.mjs';
import { isBlocked, costFactor, DEFAULT_POLICY } from './access.mjs';

export const ALT_MAGIC = 'TWALT1\0\0';
const INF16 = 65535, SAT16 = 65534;                         // 65535＝到不了；65534＝太遠（這個地標對這個頂點不提供下界）

// 地標表用的權重（一定 ≤ 實際成本）：時間 × 通行係數 × 道路等級係數（只影響選路的係數，一定會乘）＋ 從號誌路口出發的等待（經過號誌一定要等）
// 禁止與單行反向＝∞
//   上渡輪：從「只有這一條航線」的碼頭頂點上船，一定是從陸路上船 → 加上上船的選路成本
//   未知／有條件的係數：用預設政策的係數（×3、×8）。搜尋時的政策若比預設寬鬆（係數較小），地標表就不用（router.altFor 會檢查）
function lowerWeights(R, key) {
  const P = R.profile(key), { E, W, V } = R.g, CC = CLASS_COST[key] || {}, w = new Float32Array(R.M), ferryDeg = new Uint8Array(V.n);
  for (let e = 0; e < E.n; e++) if (W.hw[E.way[e]] === R.ferryHw) { ferryDeg[E.u[e]] = Math.min(255, ferryDeg[E.u[e]] + 1); ferryDeg[E.v[e]] = Math.min(255, ferryDeg[E.v[e]] + 1); }
  for (let a = 0; a < R.M; a++) {
    if (isBlocked(R.status(a, P.pi))) { w[a] = Infinity; continue; }
    const hwi = W.hw[E.way[a >> 1]], fer = hwi === R.ferryHw, cf = fer ? 1 : (CC[HIGHWAYS[hwi]] || 1), t = R.tail(a);
    const pf = costFactor(R.status(a, P.pi), DEFAULT_POLICY); if (pf === Infinity) { w[a] = Infinity; continue; }
    w[a] = P.time[a] * Math.max(1, pf) * cf + ((V.flags[t] & NF.SIGNAL) ? P.D.j4 : 0) + (fer && ferryDeg[t] === 1 ? FERRY_BOARD_COST : 0);
  }
  return w;
}
// 頂點上的 Dijkstra：fwd＝從 src 出發的時間；!fwd＝到 src 的時間
function dijkstra(R, w, src, fwd, dist, heap) {
  dist.fill(Infinity); dist[src] = 0; heap.n = 0; heap.push(0, src);
  const out = R.outArc, st = R.outStart;
  while (heap.n) {
    const [d, x] = heap.pop(); if (d > dist[x]) continue;
    for (let k = st[x]; k < st[x + 1]; k++) {
      const a = out[k], c = fwd ? w[a] : w[a ^ 1]; if (c === Infinity) continue;
      const y = R.head(a), nd = d + c; if (nd < dist[y]) { dist[y] = nd; heap.push(nd, y); }
    }
  }
}
// 選地標：這個運具最大的連通主幹裡，往 16 個方向最外側的頂點；方向依「最分散」的順序挑，彼此至少相隔 10 km，最多 k 個
export function pickLandmarks(R, key, k = 8) {
  const { V } = R.g, C = R.components(key), ND = 16;
  let big = -1; for (let c = 0; c < C.count; c++) if (big < 0 || C.size[c] > C.size[big]) big = c;
  if (big < 0) return [];
  const cosLat = Math.cos(23.7 * Math.PI / 180), dirs = Array.from({ length: ND }, (_, i) => [Math.cos(i * 2 * Math.PI / ND), Math.sin(i * 2 * Math.PI / ND)]), best = dirs.map(() => [-Infinity, -1]);
  for (let v = 0; v < V.n; v++) {
    if (C.comp[v] !== big) continue;
    const x = V.lon[v] / 1e7 * cosLat, y = V.lat[v] / 1e7;
    for (let i = 0; i < ND; i++) { const s = dirs[i][0] * x + dirs[i][1] * y; if (s > best[i][0]) best[i] = [s, v]; }
  }
  const order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15], out = [];   // 位元反轉順序：先挑相對的方向，再往中間補
  for (const i of order) { const v = best[i][1]; if (out.length < k && v >= 0 && out.every(u => Math.hypot((V.lat[u] - V.lat[v]) / 1e7 * 110.6, (V.lon[u] - V.lon[v]) / 1e7 * 101.9) >= 10)) out.push(v); }
  return out;
}
// 算一種運具的地標表
export function buildAlt(R, key, { k = 8, log = () => {} } = {}) {
  const t0 = Date.now(), n = R.g.V.n, L = pickLandmarks(R, key, k), K = L.length;
  if (!K) return null;
  const w = lowerWeights(R, key), dist = new Float64Array(n), heap = new MinHeap(1 << 16);
  const fwdF = new Float32Array(n * K), bwdF = new Float32Array(n * K); let max = 0;
  for (let i = 0; i < K; i++) {
    dijkstra(R, w, L[i], true, dist, heap); for (let v = 0; v < n; v++) { const d = dist[v]; fwdF[v * K + i] = d; if (d < Infinity && d > max) max = d; }
    dijkstra(R, w, L[i], false, dist, heap); for (let v = 0; v < n; v++) { const d = dist[v]; bwdF[v * K + i] = d; if (d < Infinity && d > max) max = d; }
  }
  // 單位：依 99.5% 的距離決定（遠到極端的少數頂點，例如太平島航線，存成 SAT＝「太遠，這個地標不用」，不讓整張表變粗）
  const sample = []; for (let j = 0; j < n * K; j += 7) { if (fwdF[j] < Infinity) sample.push(fwdF[j]); if (bwdF[j] < Infinity) sample.push(bwdF[j]); }
  sample.sort((x, y) => x - y); const p995 = sample.length ? sample[Math.floor(sample.length * 0.995)] : max;
  const unit = Math.max(1, Math.ceil(Math.min(max, p995 * 1.05) / 65000)), fwd = new Uint16Array(n * K), bwd = new Uint16Array(n * K), q = d => d === Infinity ? INF16 : Math.min(SAT16, Math.floor(d / unit));
  for (let j = 0; j < n * K; j++) { fwd[j] = q(fwdF[j]); bwd[j] = q(bwdF[j]); }
  log(`  ${key}：${K} 個地標、單位 ${unit} 秒、${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  return { key, k: K, unit, n, landmarks: L, fwd, bwd, model: MODEL_KEY };
}
// 寫檔：'TWALT1\0\0' ＋ 表頭長度（uint32）＋ 表頭 JSON ＋ 各運具的 fwd、bwd（8 bytes 對齊）
export function writeAlt(path, tables, meta = {}) {
  const list = Object.values(tables).filter(Boolean); let off = 0;
  const profiles = {}; for (const t of list) { const bytes = t.fwd.byteLength; profiles[t.key] = { k: t.k, unit: t.unit, n: t.n, landmarks: t.landmarks, fwd: off, bwd: off + Math.ceil(bytes / 8) * 8, length: t.fwd.length }; off += 2 * Math.ceil(bytes / 8) * 8; }
  const head = Buffer.from(JSON.stringify({ version: 1, model: MODEL_KEY, meta, profiles }), 'utf8'), pre = Buffer.alloc(12); pre.write(ALT_MAGIC, 0, 'latin1'); pre.writeUInt32LE(head.length, 8);
  const pad0 = (8 - ((12 + head.length) % 8)) % 8, tmp = path + '.tmp', fd = openSync(tmp, 'w');
  try {
    writeSync(fd, pre); writeSync(fd, head); writeSync(fd, Buffer.alloc(pad0));
    for (const t of list) for (const arr of [t.fwd, t.bwd]) { const b = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength); writeSync(fd, b); const p = (8 - (b.length % 8)) % 8; if (p) writeSync(fd, Buffer.alloc(p)); }
  } finally { closeSync(fd); }
  renameSync(tmp, path);
  return { bytes: 12 + head.length + pad0 + off };
}
// 讀表頭（不讀資料）；回傳 { head, base }
export function readAltHead(path) {
  const fd = openSync(path, 'r'); try {
    const pre = Buffer.alloc(12); readSync(fd, pre, 0, 12, 0); if (pre.toString('latin1', 0, 8) !== ALT_MAGIC) throw new Error(`${path} 不是地標表檔`);
    const hl = pre.readUInt32LE(8), hb = Buffer.alloc(hl); readSync(fd, hb, 0, hl, 12);
    return { head: JSON.parse(hb.toString('utf8')), base: 12 + hl + (8 - ((12 + hl) % 8)) % 8 };
  } finally { closeSync(fd); }
}
// 只讀一種運具（用到時才讀，記憶體只放用得到的）
export function loadAltProfile(path, key, info = null) {
  const { head, base } = info || readAltHead(path), p = head.profiles[key]; if (!p) return null;
  const fd = openSync(path, 'r'); try {
    const read = off => { const a = new Uint16Array(p.length), b = Buffer.from(a.buffer); let got = 0; while (got < b.length) { const r = readSync(fd, b, got, b.length - got, base + off + got); if (!r) throw new Error('地標表檔不完整'); got += r; } return a; };
    return { key, k: p.k, unit: p.unit, n: p.n, landmarks: p.landmarks, fwd: read(p.fwd), bwd: read(p.bwd), model: head.model };
  } finally { closeSync(fd); }
}
// 給 OsmRouter 的 alt 參數：用到哪種運具才讀哪一份
export function altLoader(path) {
  let info = null; try { info = readAltHead(path); } catch { return null; }
  return key => (info.head.profiles[key] ? loadAltProfile(path, key, info) : null);
}
