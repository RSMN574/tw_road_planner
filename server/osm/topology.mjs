// topology.mjs — 從 OSM PBF 建立可做路徑搜尋的道路拓樸圖
//
// 規則：
//  1. 頂點只來自 OSM node（以 node id 判斷是不是同一點）；絕不用座標四捨五入合併
//  2. 頂點＝道路端點、兩條以上道路共用的 node、障礙物（barrier）、缺資料處的兩側、封閉道路的中點（避免自環）
//  3. way 在頂點處切成邊；每條邊保留原始 way id、沿線所有 node id、座標、累積距離
//  4. 只有「共用同一個 node」才是路口；幾何上交叉但沒共用 node（例如高架橋跨過平面道路）不相連
//  5. 共用 node、但兩條路都是「中間點」而且高度層（layer／橋／隧道）不同 → 視為資料錯誤，依高度層拆成不同頂點、不相連（報告列出）
//     道路端點接到別的高度層（例如橋的端點接平面道路）是正常的相接
//  6. 單行、各運具通行規則見 access.mjs；轉向限制見 restrictions.mjs
import { createWriteStream, writeSync, openSync, closeSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { scan, readHeader } from './pbf.mjs';
import { Grow, bsearch, distE7 } from './grow.mjs';
import { HW, skipReason, levelOf, isBridge, isTunnel, parseMaxspeed, zoneMaxspeed, parseDuration, parseWidth, parseLanes, parseLayer, smoothCode, tri, sidewalkCode, cyclewayOf, nameOf, parseIncline } from './tags.mjs';
import { wayAccess, nodeAccess, PROFILES, unknownValues } from './access.mjs';
import { collectRestriction, mapRestrictions } from './restrictions.mjs';

export const MISSING = -2147483648;
export const NF = { SIGNAL: 1, STOP: 2, GIVEWAY: 4, CROSSING: 8, BARRIER: 16, MINI_RB: 32, LEVEL_X: 64, TOLL: 128 };
export const WF = { MOTORROAD: 1, TOLL: 2, ROUNDABOUT: 4, ONEWAY_TAG: 8, AREA: 16, CONSTRUCTION_COND: 32 };

export function buildTopology(pbf, { log = () => {}, tagsFile = null } = {}) {
  unknownValues.clear();
  const T0 = Date.now(), header = readHeader(pbf), stats = { skipped: {}, ways: 0, routableWays: 0, relations: 0, restrictionRelations: 0 };
  // ---------- 字串表（名稱、ref、路面…）----------
  const strings = [''], sIx = new Map([['', 0]]), str = s => { if (!s) return 0; let i = sIx.get(s); if (i === undefined) { i = strings.length; strings.push(s); sIx.set(s, i); } return i; };
  // ---------- 第一趟：way、relation ----------
  const wayId = new Grow(Float64Array, 1 << 16), refOff = new Grow(Int32Array, 1 << 16), refs = new Grow(Float64Array, 1 << 20);
  const W = { hw: new Grow(Uint8Array), acc: new Grow(Uint8Array), name: new Grow(Int32Array), ref: new Grow(Int32Array), maxspeed: new Grow(Float32Array), maxF: new Grow(Float32Array), maxB: new Grow(Float32Array),
    lanes: new Grow(Uint8Array), width: new Grow(Float32Array), surface: new Grow(Int32Array), smooth: new Grow(Uint8Array), bridge: new Grow(Uint8Array), tunnel: new Grow(Uint8Array), layer: new Grow(Int8Array),
    level: new Grow(Int8Array), junction: new Grow(Int32Array), lit: new Grow(Uint8Array), sidewalk: new Grow(Uint8Array), cycleway: new Grow(Int32Array), incline: new Grow(Float32Array), flags: new Grow(Uint8Array),
    zoneMax: new Grow(Uint8Array), ferryS: new Grow(Float32Array) };                 // zoneMax：區域速限代碼換算的法定上限（0＝沒有）；ferryS：渡輪 duration（秒，NaN＝沒標）
  refOff.push(0);
  const relRaw = [], nodeBlobs = new Set(), accInfo = {};
  let tagFd = tagsFile ? openSync(tagsFile, 'w') : null, tagBuf = [];
  const flushTags = () => { if (tagFd != null && tagBuf.length) { writeSync(tagFd, gzipSync(tagBuf.join(''))); tagBuf = []; } };
  log('第一趟：讀道路（way）與轉向限制（relation）…');
  const s1 = scan(pbf, {
    way(id, r, t) {
      stats.ways++;
      if (!t.highway && t.route === 'ferry') { t = { ...t, highway: 'ferry' }; stats.ferryWays = (stats.ferryWays || 0) + 1; }   // 渡輪航線：當成 highway=ferry 進路網
      const why = skipReason(t) || (r.length < 2 ? 'too-short（少於 2 個點）' : null);
      if (why) { if (t.highway) stats.skipped[why] = (stats.skipped[why] || 0) + 1; return; }
      stats.routableWays++;
      wayId.push(id); refs.pushArr(r); refOff.push(refs.n);
      W.hw.push(HW[t.highway]); W.acc.pushArr(wayAccess(t, accInfo)); W.name.push(str(nameOf(t))); W.ref.push(str(t.ref || ''));
      W.maxspeed.push(parseMaxspeed(t.maxspeed)); W.maxF.push(parseMaxspeed(t['maxspeed:forward'])); W.maxB.push(parseMaxspeed(t['maxspeed:backward']));
      W.lanes.push(parseLanes(t.lanes)); W.width.push(parseWidth(t.width ?? t['est_width'])); W.surface.push(str(t.surface || '')); W.smooth.push(smoothCode(t.smoothness));
      W.bridge.push(isBridge(t) ? 1 : 0); W.tunnel.push(isTunnel(t) ? 1 : 0); W.layer.push(parseLayer(t.layer)); W.level.push(levelOf(t)); W.junction.push(str(t.junction || ''));
      W.lit.push(tri(t.lit)); W.sidewalk.push(sidewalkCode(t)); W.cycleway.push(str(cyclewayOf(t))); W.incline.push(parseIncline(t.incline));
      W.zoneMax.push(Number.isFinite(parseMaxspeed(t.maxspeed)) ? 0 : (zoneMaxspeed(t) || 0)); W.ferryS.push(t.highway === 'ferry' ? parseDuration(t.duration) : NaN);
      W.flags.push((t.motorroad === 'yes' ? WF.MOTORROAD : 0) | (t.toll === 'yes' ? WF.TOLL : 0) | (t.junction === 'roundabout' || t.junction === 'circular' ? WF.ROUNDABOUT : 0) | (t.oneway != null ? WF.ONEWAY_TAG : 0));
      if (tagFd != null) { tagBuf.push(JSON.stringify({ id, tags: t }) + '\n'); if (tagBuf.length >= 20000) flushTags(); }
    },
    relation(id, m, t) { stats.relations++; const r = collectRestriction(id, m, t); if (r) { stats.restrictionRelations++; relRaw.push(r); } },
    onBlob(i, kinds) { if (kinds & 1) nodeBlobs.add(i); },
    onProgress: s => log(`  … ${s.blobs} 個區塊、${s.ways.toLocaleString()} 條 way`)
  });
  if (tagFd != null) { flushTags(); closeSync(tagFd); }
  const NW = wayId.n, wid = wayId.trim(), roff = refOff.trim(); let R = refs.trim(); wayId.a = refOff.a = refs.a = null;     // 放掉成長用的大緩衝區
  for (let i = 1; i < NW; i++) if (wid[i] < wid[i - 1]) { stats.waysUnsorted = true; break; }
  log(`  way ${stats.ways.toLocaleString()} 條（進路網 ${NW.toLocaleString()}）、轉向限制 ${relRaw.length}、${(Date.now() - T0) / 1000} 秒`);

  // ---------- 需要的 node：排序去重 ----------
  let uniqAll = Float64Array.from(R).sort(); let NU = 0; for (let i = 0; i < uniqAll.length; i++) if (i === 0 || uniqAll[i] !== uniqAll[i - 1]) uniqAll[NU++] = uniqAll[i];
  const uniq = uniqAll.slice(0, NU); uniqAll = null;
  const nLat = new Int32Array(NU).fill(MISSING), nLon = new Int32Array(NU).fill(MISSING), nFlags = new Uint8Array(NU), barrier = new Map();
  // ---------- 第二趟：只讀含 node 的區塊，取需要的 node 座標與標籤 ----------
  log(`第二趟：讀 ${NU.toLocaleString()} 個道路節點的座標…`);
  let ptr = 0, last = -Infinity, sorted = true;
  scan(pbf, { only: nodeBlobs, nodeTags: true,
   nodeKey(id) {                                                                      // 只處理道路用到的 node（其他上千萬個點不建標籤物件）
    if (sorted && id >= last) { while (ptr < NU && uniq[ptr] < id) ptr++; last = id; return ptr < NU && uniq[ptr] === id ? ptr : -1; }
    sorted = false; return bsearch(uniq, id, NU);
   },
   node(id, la, lo, t, j) {
    nLat[j] = la; nLon[j] = lo;
    if (t) {
      let f = 0; const h = t.highway;
      if (h === 'traffic_signals' || t.crossing === 'traffic_signals') f |= NF.SIGNAL; if (h === 'stop') f |= NF.STOP; if (h === 'give_way') f |= NF.GIVEWAY;
      if (h === 'crossing' || t.crossing) f |= NF.CROSSING; if (h === 'mini_roundabout') f |= NF.MINI_RB; if (t.railway === 'level_crossing' || t.railway === 'crossing') f |= NF.LEVEL_X;
      if (t.barrier) f |= NF.BARRIER; if (t.barrier === 'toll_booth') f |= NF.TOLL;
      nFlags[j] = f; const a = nodeAccess(t); if (a) barrier.set(j, a);
    }
   } });
  if (!sorted) stats.nodesUnsorted = true;
  // 每個 ref 對應到哪個 uniq node（之後每個迴圈都要用）
  const refIx = new Int32Array(R.length); for (let i = 0; i < R.length; i++) refIx[i] = bsearch(uniq, R[i], NU);
  R = null;                                                                          // 之後只用 refIx
  let missing = 0; for (let j = 0; j < NU; j++) if (nLat[j] === MISSING) missing++;
  stats.nodes = NU; stats.missingNodes = missing;

  // ---------- 判斷頂點 ----------
  const use = new Uint8Array(NU), endp = new Uint8Array(NU), force = new Uint8Array(NU), lv0 = new Int8Array(NU).fill(-128), mixed = new Uint8Array(NU), lvOf = W.level.trim();
  let closedWays = 0;
  for (let w = 0; w < NW; w++) {
    const s = roff[w], e = roff[w + 1], lv = lvOf[w];
    for (let i = s; i < e; i++) {
      const u = refIx[i]; if (i > s && u === refIx[i - 1]) continue;
      if (use[u] < 255) use[u]++;
      if (i === s || i === e - 1) endp[u] = 1;
      else if (lv0[u] === -128) lv0[u] = lv; else if (lv0[u] !== lv) mixed[u] = 1;
      if (nLat[u] === MISSING) { if (i > s) force[refIx[i - 1]] = 1; if (i < e - 1) force[refIx[i + 1]] = 1; }
    }
    if (e - s > 3 && refIx[s] === refIx[e - 1]) { closedWays++; force[refIx[s + ((e - s) >> 1)]] = 1; }
  }
  const vertexOf = new Int32Array(NU).fill(-1), vNode = new Grow(Int32Array, 1 << 16), vLevel = new Grow(Int8Array, 1 << 16), extra = new Map();
  let conflicts = 0; const conflictSample = [];
  for (let u = 0; u < NU; u++) {
    if (nLat[u] === MISSING) continue;
    if (endp[u] || use[u] >= 2 || force[u] || barrier.has(u)) { vertexOf[u] = vNode.n; vNode.push(u); vLevel.push(lv0[u] === -128 ? 0 : lv0[u]); }
    if (mixed[u]) { conflicts++; if (conflictSample.length < 50) conflictSample.push(uniq[u]); }
  }
  // 高度層衝突的點：每個高度層各一個頂點
  const vertexAt = (u, lv, isEnd) => {
    if (!mixed[u]) return vertexOf[u];
    if (lv === lv0[u]) return vertexOf[u];
    const k = u * 32 + (lv + 16); let v = extra.get(k);
    if (v === undefined) {
      if (isEnd) return vertexOf[u];                                               // 端點接到不存在的高度層：接到第一個高度層
      v = vNode.n; vNode.push(u); vLevel.push(lv); extra.set(k, v);
    }
    return v;
  };
  // ---------- 切邊 ----------
  log('切分道路為邊…');
  const eU = new Grow(Int32Array, 1 << 18), eV = new Grow(Int32Array, 1 << 18), eWay = new Grow(Int32Array, 1 << 18), eLen = new Grow(Float32Array, 1 << 18), eSig = new Grow(Uint8Array, 1 << 18), eRef0 = new Grow(Int32Array, 1 << 18);
  const goff = new Grow(Int32Array, 1 << 18), gLat = new Grow(Int32Array, 1 << 20), gLon = new Grow(Int32Array, 1 << 20), gNode = new Grow(Float64Array, 1 << 20), gCum = new Grow(Float32Array, 1 << 20);
  const wayEdgeOff = new Int32Array(NW + 1); goff.push(0);
  let zeroLen = 0; const cur = [];
  const emit = (w, s, e) => {
    const lv = lvOf[w], a = cur[0], b = cur[cur.length - 1], ua = refIx[a], ub = refIx[b];
    eU.push(vertexAt(ua, lv, a === s || a === e - 1)); eV.push(vertexAt(ub, lv, b === s || b === e - 1)); eWay.push(w); eRef0.push(a - s);
    let L = 0, sig = 0;
    for (let k = 0; k < cur.length; k++) {
      const u = refIx[cur[k]];
      if (k) { const p = refIx[cur[k - 1]]; L += distE7(nLat[p], nLon[p], nLat[u], nLon[u]); }
      if (k && k < cur.length - 1 && (nFlags[u] & NF.SIGNAL)) sig++;
      gLat.push(nLat[u]); gLon.push(nLon[u]); gNode.push(uniq[u]); gCum.push(L);
    }
    if (L === 0) zeroLen++;
    eLen.push(L); eSig.push(Math.min(255, sig)); goff.push(gLat.n);
  };
  for (let w = 0; w < NW; w++) {
    const s = roff[w], e = roff[w + 1]; cur.length = 0; wayEdgeOff[w] = eU.n;
    for (let i = s; i < e; i++) {
      const u = refIx[i];
      if (nLat[u] === MISSING) { cur.length = 0; continue; }
      if (cur.length && u === refIx[cur[cur.length - 1]]) continue;
      if (!cur.length && vertexOf[u] < 0) continue;                               // 缺資料後面那段：從下一個頂點開始
      cur.push(i);
      if (cur.length >= 2 && vertexOf[u] >= 0) { emit(w, s, e); cur.length = 0; cur.push(i); }
    }
  }
  wayEdgeOff[NW] = eU.n;
  const NV = vNode.n, NE = eU.n, vn = vNode.trim();
  const V = { n: NV, node: vn, osm: Float64Array.from(vn, u => uniq[u]), lat: Int32Array.from(vn, u => nLat[u]), lon: Int32Array.from(vn, u => nLon[u]), flags: Uint8Array.from(vn, u => nFlags[u]), level: vLevel.trim(), barrier: new Map() };
  for (let v = 0; v < NV; v++) { const a = barrier.get(vn[v]); if (a) V.barrier.set(v, a); }
  const E = { n: NE, u: eU.trim(), v: eV.trim(), way: eWay.trim(), len: eLen.trim(), sig: eSig.trim(), ref0: eRef0.trim(), goff: goff.trim() };
  const G = { lat: gLat.trim(), lon: gLon.trim(), node: gNode.trim(), cum: gCum.trim() };
  for (const x of [eU, eV, eWay, eLen, eSig, eRef0, goff, gLat, gLon, gNode, gCum]) x.a = null;
  const Wo = { n: NW, id: wid, edgeOff: wayEdgeOff }; for (const k in W) { Wo[k] = W[k].trim(); W[k].a = null; }
  // 度數、孤立頂點
  const deg = new Uint32Array(NV); for (let e = 0; e < NE; e++) { deg[E.u[e]]++; if (E.v[e] !== E.u[e]) deg[E.v[e]]++; }
  let isolated = 0, deadEnds = 0, selfLoops = 0; for (let v = 0; v < NV; v++) { if (!deg[v]) isolated++; else if (deg[v] === 1) deadEnds++; }
  for (let e = 0; e < NE; e++) if (E.u[e] === E.v[e]) selfLoops++;
  Object.assign(stats, { vertices: NV, edges: NE, geometryPoints: G.lat.length, layerConflictNodes: conflicts, layerConflictSample: conflictSample, extraLevelVertices: extra.size, closedWays, zeroLengthEdges: zeroLen, isolatedVertices: isolated, deadEnds, selfLoops,
    accessDefaults: accInfo, unknownAccessValues: Object.fromEntries([...unknownValues].sort((a, b) => b[1] - a[1]).slice(0, 40)) });
  const graph = { header, strings, V, E, G, W: Wo, stats };
  // ---------- 轉向限制 ----------
  log(`對應轉向限制（${relRaw.length} 筆）…`);
  const wayMap = stats.waysUnsorted ? new Map(Array.from(wid, (id, i) => [id, i])) : null;
  graph.restrictions = mapRestrictions(graph, relRaw, { uniq, vertexOf, extra, wayIndex: wayMap ? id => wayMap.get(id) ?? -1 : id => bsearch(wid, id, NW) });
  linkFerryPiers(graph, str);
  stats.buildSeconds = (Date.now() - T0) / 1000;
  return graph;
}

// 渡輪碼頭：OSM 的航線常常畫到碼頭邊就停，沒有和道路共用 node（全台約四成的航線至少一端沒接上）
// → 航線端點若沒有任何道路相接，接到 300 m 內最近的道路頂點，補一條「碼頭連接（推估）」（highway=pier_link，通行狀態照抄航線）
// 只補端點、只接頂點，不切開道路；接不上（例如國外的港口）就維持原樣。數量記在 stats.ferryPierLinks、stats.ferryUnlinkedEnds
export function linkFerryPiers(g, str, maxM = 300) {
  const { V, E, G, W } = g, ferryHw = HW.ferry, pierHw = HW.pier_link, NP = 5;
  const road = new Uint8Array(V.n); for (let e = 0; e < E.n; e++) if (W.hw[E.way[e]] !== ferryHw) { road[E.u[e]] = 1; road[E.v[e]] = 1; }
  const C = 0.005, key = (la, lo) => Math.floor(la / 1e7 / C) * 100000 + Math.floor(lo / 1e7 / C), grid = new Map();
  for (let v = 0; v < V.n; v++) if (road[v]) { const k = key(V.lat[v], V.lon[v]); (grid.get(k) || grid.set(k, []).get(k)).push(v); }
  const links = [], done = new Set(); let unlinked = 0;
  for (let w = 0; w < W.n; w++) {
    if (W.hw[w] !== ferryHw || W.edgeOff[w + 1] <= W.edgeOff[w]) continue;
    for (const x of [E.u[W.edgeOff[w]], E.v[W.edgeOff[w + 1] - 1]]) {
      if (road[x] || done.has(x)) continue; done.add(x);
      const cy = Math.floor(V.lat[x] / 1e7 / C), cx = Math.floor(V.lon[x] / 1e7 / C); let best = -1, bd = maxM;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const y of grid.get((cy + dy) * 100000 + cx + dx) || []) { const d = distE7(V.lat[x], V.lon[x], V.lat[y], V.lon[y]); if (d < bd) { bd = d; best = y; } }
      if (best < 0) { unlinked++; continue; }
      links.push({ x, y: best, w, d: Math.max(0.5, bd) });
    }
  }
  g.stats.ferryPierLinks = links.length; g.stats.ferryUnlinkedEnds = unlinked;
  if (!links.length) return;
  const K = links.length, ext = (a, n) => { const b = new a.constructor(a.length + n); b.set(a); return b; };
  // 道路（way）：每條連接一條
  const W0 = W.n, name = str('碼頭連接（推估）');
  for (const k of Object.keys(W)) {
    if (k === 'n' || k === 'edgeOff' || !ArrayBuffer.isView(W[k])) continue;
    const per = k === 'acc' ? NP : 1, b = ext(W[k], K * per);
    if (b instanceof Float32Array || b instanceof Float64Array) b.fill(NaN, W0 * per);
    W[k] = b;
  }
  const eo = ext(W.edgeOff, K);
  links.forEach((l, i) => { const w = W0 + i; W.id[w] = -(W.id[l.w] * 10 + i % 10 + 1); W.hw[w] = pierHw; W.name[w] = name; W.acc.set(W.acc.subarray(l.w * NP, l.w * NP + NP), w * NP); eo[w + 1] = E.n + i + 1; });
  for (const k of ['maxspeed', 'maxF', 'maxB', 'width', 'incline', 'ferryS']) if (W[k]) W[k].fill(NaN, W0);
  W.edgeOff = eo; W.n = W0 + K;
  // 邊與幾何：兩點直線
  const E0 = E.n, G0 = G.lat.length;
  for (const k of ['u', 'v', 'way', 'len', 'sig', 'ref0']) E[k] = ext(E[k], K);
  const goff = ext(E.goff, K); for (const k of ['lat', 'lon', 'node', 'cum']) G[k] = ext(G[k], 2 * K);
  links.forEach((l, i) => {
    const e = E0 + i, gk = G0 + 2 * i;
    E.u[e] = l.y; E.v[e] = l.x; E.way[e] = W0 + i; E.len[e] = l.d; E.sig[e] = 0; E.ref0[e] = -1; goff[e] = gk; goff[e + 1] = gk + 2;
    G.lat[gk] = V.lat[l.y]; G.lon[gk] = V.lon[l.y]; G.node[gk] = V.osm[l.y]; G.cum[gk] = 0;
    G.lat[gk + 1] = V.lat[l.x]; G.lon[gk + 1] = V.lon[l.x]; G.node[gk + 1] = V.osm[l.x]; G.cum[gk + 1] = l.d;
  });
  E.goff = goff; E.n = E0 + K; g.stats.edges = E.n; g.stats.geometryPoints = G.lat.length;
}
