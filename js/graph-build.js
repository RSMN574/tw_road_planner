// graph-build.js — 從分檔 JSON 建圖（純資料處理，不碰 DOM；瀏覽器與伺服器共用）
import { State } from './state.js';
import { reprojectTransit } from './transit.js';
import { hlCache, nearbyCache } from './constants.js';
import { autoUnit } from './geo.js';
import { buildSpatialIndex, detectCoordType } from './graph-core.js';
import { applyRoadTable, readRoadAttr } from './road-attrs.js';
import { ubProject } from './ubike.js';
import { applyPack } from './graph-pack.js';

//   nodes.json: [{id, lon, lat} | {id, x, y} | {id, lon, lat, ...}]
//   edges.json: [{from, to, w | length}]
//   roads.json: [{name, nodes:[id...]}] 或 [{name}] 或 ["道路名"] 或 {路名:{edgeIds}}
// input：{ nodes, edges, roads }（JSON）或 { pack }（graph.bin 封包，見 graph-pack.js）
// onParsed：解析完、收尾前呼叫（伺服器在這時產生封包——此時道路屬性只有 roads.json 的，還沒套用屬性表）
export function buildGraphCore(input, onParsed) {
  if (input && input.pack) { applyPack(input.pack); onParsed && onParsed(); finalizeGraph(); return; }
  parseGraphJson(input); onParsed && onParsed(); finalizeGraph();
}
function parseGraphJson({ nodes, edges, roads }) {
    State.edgeIdToNodes = new Map();
  // ====== 1. nodes 容器 ======
  let nodesArr = nodes;
  if (!Array.isArray(nodesArr)) {
    nodesArr = nodes.nodes || nodes.data || nodes.items || nodes.features || null;
  }
  if (!Array.isArray(nodesArr) || nodesArr.length === 0) {
    if (nodes && typeof nodes === 'object') {
      const keys = Object.keys(nodes);
      if (keys.length > 0) {
        nodesArr = keys.map(k => {
          const v = nodes[k];
          return (typeof v === 'object' && v !== null)
            ? { id: k, ...v }
            : { id: k, lon: v[0], lat: v[1] };
        });
      }
    }
  }
  if (!Array.isArray(nodesArr) || nodesArr.length === 0) throw new Error('nodes.json 格式無法辨識');

  let n = nodesArr.length;
  State.nodeIds = new Array(n);
  State.nodeIdToIdx = new Map();
  State.nodeXY = new Float64Array(n * 5);

  const sample = nodesArr[0];
  const hasCoordsArray = Array.isArray(sample?.coordinates);
  const hasGeo = sample?.geometry?.coordinates;

  for (let i = 0; i < n; i++) {
    const nd = nodesArr[i] || {};
    const id = String(nd.id ?? nd.nodeId ?? nd.node_id ?? nd.osm_id ?? nd.name ?? i);
    State.nodeIds[i] = id;
    State.nodeIdToIdx.set(id, i);

    let lon, lat;
    if (hasCoordsArray)        { lon = nd.coordinates[0]; lat = nd.coordinates[1]; }
    else if (hasGeo)           { lon = nd.geometry.coordinates[0]; lat = nd.geometry.coordinates[1]; }
    else if (Array.isArray(nd)){ lon = nd[0]; lat = nd[1];     } else {
      lon = nd.lon ?? nd.lng ?? nd.longitude ?? nd.x ?? nd.X ?? 0;
      lat = nd.lat ?? nd.latitude  ?? nd.y ?? nd.Y ?? 0;
    }

    // 兜底：id 形如 "xy:X,Y" 或 "X,Y" 時直接解析座標
    if (!isFinite(lon) || !isFinite(lat) || (lon === 0 && lat === 0)) {
      const m = id.match(/^(?:xy[:\s]*)?(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/i);
      if (m) { lon = +m[1]; lat = +m[2]; }
    }

    State.nodeXY[i*5+2] = lon;
    State.nodeXY[i*5+3] = lat;
  }

     // ====== 2. edges / adjacency 容器 ======
  let edgesArr = edges;
  if (!Array.isArray(edgesArr)) {
    edgesArr = edges?.edges || edges?.data || edges?.items || edges?.links || edges?.features
            || edges?.adjacency || edges?.adj || null;
  }

  if (!Array.isArray(edgesArr) && edges && typeof edges === 'object') {
    const sampleVals = Object.values(edges).slice(0, 5);
    const isAdjacency = sampleVals.some(v =>
      (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') ||
      (v && typeof v === 'object' && !Array.isArray(v))
    );

if (isAdjacency) {
  const arr = [];
  let pos = 0;                         // ← 合成 edgeId 的计数器
  for (const [key, val] of Object.entries(edges)) {
    if (!val) continue;

    // 形态 1：val 本身是一条边对象
    if (typeof val === 'object' && !Array.isArray(val)) {
      const f = val.from ?? val.source ?? val.u ?? val.a ?? val.start;
      const t = val.to   ?? val.target ?? val.v ?? val.b ?? val.end;
      if (f !== undefined && t !== undefined) {
        const w   = Number(val.w ?? val.weight ?? val.length ?? val.distance ?? 1) || 1;
        const eid = val.edgeId ?? val.edge_id ?? pos++;    // ← 回退到位置索引
        arr.push({ from: String(f), to: String(t), w, edgeId: eid });
        continue;
      }
      const sub = Object.entries(val);
      if (sub.length > 0 && sub.every(([, v]) => typeof v === 'number')) {
        for (const [toId, w] of sub) {
          arr.push({ from: key, to: toId, w, edgeId: pos++ });
        }
      }
      continue;
    }

    // 形态 2：val 是数组
    if (Array.isArray(val)) {
      for (const x of val) {
        if (x == null) continue;
        if (typeof x === 'object') {
          const t   = x.to ?? x.target ?? x.v ?? x.node ?? x.nodeId ?? x.node_id; // 注意：不要用 x.id
          const w   = Number(x.w ?? x.weight ?? x.length ?? x.distance ?? 1) || 1;
          const eid = x.edgeId ?? x.edge_id ?? pos++;        // ← 回退到位置索引
          if (t !== undefined) arr.push({ from: key, to: String(t), w, edgeId: eid });
        } else {
          arr.push({ from: key, to: String(x), w: 1, edgeId: pos++ });
        }
      }
    }
  }
  edgesArr = arr;
  console.info(`ℹ 展開鄰接表 → ${arr.length} 條有向邊；首條：`, arr[0]);
  console.info(`ℹ edgeId 采用「位置索引」合成；示例：`, arr.slice(0, 3).map(e => e.edgeId));
} else {
      const arr = [];
      for (const [k, v] of Object.entries(edges)) {
        const parts = k.split(/[,|_\-]/);
        if (parts.length >= 2) arr.push({ from: parts[0], to: parts[1], w: Number(v) || 1 });
      }
      edgesArr = arr;
    }
  }
  if (!Array.isArray(edgesArr)) edgesArr = [];

  // ====== 2.5 從邊資料補全 nodes.json 缺少的節點 ======
  {
    const pending = new Map();   // id → [lon, lat] or null
    for (const e of edgesArr) {
      if (!e) continue;
      const f = e.from, t = e.to;
      if (f !== undefined) {
        const id = String(f);
        if (!State.nodeIdToIdx.has(id) && !pending.has(id)) pending.set(id, null);
      }
      if (t !== undefined) {
        const id = String(t);
        if (!State.nodeIdToIdx.has(id) && !pending.has(id)) pending.set(id, null);
      }
    }

    if (pending.size > 0) {
      const nOld = State.nodeIds.length;
      const nNew = nOld + pending.size;
      const newNodeIds = new Array(nNew);
      const newNodeXY  = new Float64Array(nNew * 5);

      for (let i = 0; i < nOld; i++) {
        newNodeIds[i]      = State.nodeIds[i];
        newNodeXY[i*5+2]   = State.nodeXY[i*5+2];
        newNodeXY[i*5+3]   = State.nodeXY[i*5+3];
      }

      let idx = nOld;
      for (const id of pending.keys()) {
        newNodeIds[idx] = id;
        const m = id.match(/^(?:xy[:\s]*)?(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)$/i);
        if (m) {
          newNodeXY[idx*5+2] = +m[1];
          newNodeXY[idx*5+3] = +m[2];
        }
        State.nodeIdToIdx.set(id, idx);
        idx++;
      }

      State.nodeIds = newNodeIds;
      State.nodeXY  = newNodeXY;
      n = nNew;
      console.info(`ℹ 從邊資料補全 ${pending.size} 個節點（總節點 ${n}）`);
    }
  }
  // ====== 3. 鄰接表（動態） ======
  const deg = new Uint32Array(n);
  // 有向邊暫存：預先配置的型別陣列（不夠才加倍），取代逐筆 push 的一般陣列（大路網上省下大量記憶體與 GC）
  let cap = Math.max(16, (Array.isArray(edgesArr) ? edgesArr.length : 0) * 2 + 16), m = 0;
  let eFrom = new Uint32Array(cap), eTo = new Uint32Array(cap), eW = new Float64Array(cap);
  const grow = () => { cap *= 2; const f = new Uint32Array(cap), t = new Uint32Array(cap), w = new Float64Array(cap); f.set(eFrom); t.set(eTo); w.set(eW); eFrom = f; eTo = t; eW = w; };
  let unresolved = 0;
  const samples = [];

  const idMap = State.nodeIdToIdx;
  // 快速路徑：ID 字串（或數字）直接命中 —— 絕大多數的邊都走這裡；其餘格式才進入下面的寬鬆解析
  function resolveIdx(v) {
    if (typeof v === 'string') { if (v.length && v.trim() === v) { const i = idMap.get(v); if (i !== undefined) return i; } }   // 前後有空白的 ID 要先去空白，交給寬鬆解析
    else if (typeof v === 'number') { const i = idMap.get(String(v)); if (i !== undefined) return i; }
    return resolveSlow(v);
  }
  function resolveSlow(v) {
    if (v === undefined || v === null || v === '') return -1;

    // 物件再遞迴
    if (typeof v === 'object' && !Array.isArray(v)) {
      const inner = v.id ?? v.nodeId ?? v.node_id ?? v.index ?? v.idx ?? v.value;
      if (inner !== undefined) return resolveIdx(inner);
    }

    const s = String(v).trim();

    // 1. 精確命中
    if (State.nodeIdToIdx.has(s)) return State.nodeIdToIdx.get(s);

    // 2. 去前綴（"node_123" → "123"、"n:123" → "123"）
    const stripped = s.replace(/^(node[_:]|n[_:]|id[_:]|osm[_:]|v[_:])/i, '');
    if (stripped !== s && State.nodeIdToIdx.has(stripped)) return State.nodeIdToIdx.get(stripped);

    // 3. 加前綴（"123" → "node_123"）
    for (const p of ['node_', 'n_', 'id_', 'osm_']) {
      if (State.nodeIdToIdx.has(p + s)) return State.nodeIdToIdx.get(p + s);
    }

    // 4. 數字索引
    const num = Number(s);
    if (Number.isInteger(num) && num >= 0 && num < n) return num;

    return -1;
  }

  function pick(o, keys) {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
  }

  const eEid = [];   // 与 eFrom/eTo 同步：每条有向边的 edgeId（字符串或 null）
  function addEdge(a, b, w, eid) {
    const eidStr = (eid !== undefined && eid !== null && eid !== '') ? String(eid) : null;
    if (m + 2 > cap) grow();
    eFrom[m] = a; eTo[m] = b; eW[m] = w; m++; eEid.push(eidStr); deg[a]++;
    eFrom[m] = b; eTo[m] = a; eW[m] = w; m++; eEid.push(eidStr); deg[b]++;
  }
  // 每條輸入邊解析出的端點（只記一般物件格式，下面 3.5 直接重用，不必再解析一次）；-2 = 沒記錄
  const ends = new Int32Array(Array.isArray(edgesArr) ? edgesArr.length * 2 : 0).fill(-2);

  const FROM_KEYS = ['from','source','u','a','start','fromId','from_id','fromNode','from_node',
                     'startNode','start_node','node1','n1','fromIndex','from_index'];
  const TO_KEYS   = ['to','target','v','b','end','toId','to_id','toNode','to_node',
                     'endNode','end_node','node2','n2','toIndex','to_index'];
  const W_KEYS    = ['w','weight','length','distance','cost','l','len','dist','km'];

  for (let ei = 0; ei < edgesArr.length; ei++) {
    const e = edgesArr[ei];
    if (!e) continue;

    // (A) 純陣列 [from, to] / [from, to, w]
    if (Array.isArray(e)) {
      const fi = resolveIdx(e[0]), ti = resolveIdx(e[1]);
      if (fi < 0 || ti < 0) { unresolved++; if (samples.length < 3) samples.push(e); continue; }
      let w = Number(e[2] ?? 1);
      if (!isFinite(w) || w <= 0) w = 1;
         addEdge(fi, ti, w, e.edgeId);
      continue;
    }

    // (B) 折線：{nodes: [a, b, c, ...], w}
    if (Array.isArray(e.nodes) && e.nodes.length >= 2) {
      const segs = e.nodes.length - 1;
      let w = Number(pick(e, W_KEYS) ?? 1) / segs;
      if (!isFinite(w) || w <= 0) w = 1;
      const segList = [];
      let ok = true;
      for (let k = 0; k < segs; k++) {
        const a = resolveIdx(e.nodes[k]);
        const b = resolveIdx(e.nodes[k + 1]);
        if (a < 0 || b < 0) { ok = false; break; }
        segList.push([a, b]);
      }
      if (!ok) { unresolved++; if (samples.length < 3) samples.push(e); continue; }
    for (const [a, b] of segList) addEdge(a, b, w, e.edgeId);
      continue;
    }

    // (C) 一般物件
    const fi = resolveIdx(pick(e, FROM_KEYS));
    const ti = resolveIdx(pick(e, TO_KEYS));
    ends[ei * 2] = fi; ends[ei * 2 + 1] = ti;
    let w = Number(pick(e, W_KEYS) ?? 1);
    if (!isFinite(w) || w <= 0) w = 1;
    if (fi < 0 || ti < 0) { unresolved++; if (samples.length < 3) samples.push(e); continue; }
       addEdge(fi, ti, w, e.edgeId);
  }

  State.adjOffset = new Uint32Array(n + 1);
  let sum = 0;
  for (let i = 0; i < n; i++) { State.adjOffset[i] = sum; sum += deg[i]; }
  State.adjOffset[n] = sum;

  State.adjTo   = new Uint32Array(m);
  State.adjW    = new Float64Array(m);
  State.adjEdge = new Uint32Array(m);
  State.adjEid  = new Array(m);                       // ← 新增
  const cursor = new Uint32Array(n);
  for (let k = 0; k < m; k++) {
    const u = eFrom[k];
    const pos = State.adjOffset[u] + cursor[u]++;
    State.adjTo[pos]   = eTo[k];
    State.adjW[pos]    = eW[k];
    State.adjEdge[pos] = k;
    State.adjEid[pos]  = eEid[k];                     // ← 新增
  }
  for (let i = 0; i < n; i++) State.nodeXY[i*5+4] = deg[i];

  // 診斷輸出（在 DevTools Console 看得到）
  if (unresolved > 0) {
    console.warn(`⚠ ${unresolved} 條邊端點解析失敗（共 ${edgesArr.length} 條）`);
    console.warn('  邊範例：', samples);
    console.warn('  節點 ID 範例：', Array.from(State.nodeIdToIdx.keys()).slice(0, 5));
  }
  if (edgesArr.length > 0 && m === 0) {
    console.error('❌ 所有邊都無法解析！請比對 edges.json 欄位名稱與節點 ID 格式');
    console.error('  第一條邊：', edgesArr[0]);
    console.error('  節點 ID 範例：', Array.from(State.nodeIdToIdx.keys()).slice(0, 5));
  }

  // 不依赖 addEdge 有没有传 eid，直接从 edgesArr 扫一遍
// ====== 3.5 edgeId → 輸入邊（缺 edgeId 用索引兜底）——只在下面「roads.json 用 edgeIds 指定道路」時用來找節點 ======
// 以前每個 edgeId 建一個 Set（大路網上數十萬個物件）；改成「edgeId → 第一條輸入邊」＋ 同 ID 的串列，節點順序與以前完全相同
State.edgeIdToNodes = new Map();                       // 保留欄位相容；內容不再常駐（沒有其他模組使用）
const eidHead = new Map(), eidNext = new Int32Array(Array.isArray(edgesArr) ? edgesArr.length : 0).fill(-1), eidTail = new Map();
{
  let cnt = 0;
  for (let i = 0; i < edgesArr.length; i++) {
    const e = edgesArr[i];
    if (!e) continue;
    const eid = e.edgeId ?? e.edge_id ?? e.id ?? i;   // ← 一定会有值
    let fi = ends[i * 2], ti = ends[i * 2 + 1];
    if (fi === -2) { fi = resolveIdx(pick(e, FROM_KEYS)); ti = resolveIdx(pick(e, TO_KEYS)); ends[i * 2] = fi; ends[i * 2 + 1] = ti; }
    if (fi < 0 || ti < 0) continue;
    const k = String(eid), t = eidTail.get(k);
    if (t === undefined) eidHead.set(k, i); else eidNext[t] = i;
    eidTail.set(k, i);
    cnt++;
  }
  eidTail.clear();
  console.info(`ℹ edgeId→nodes：${eidHead.size} 个 key，覆盖 ${cnt} 条边`);
}
  // ====== 4. roads 容器（强化：array / object / edgeIds / 节点属性） ======
  let roadsArr = roads;

  // (a) 常见包装
  if (!Array.isArray(roadsArr) && roads && typeof roads === 'object') {
    roadsArr = roads.roads || roads.data || roads.items || roads.list || null;
  }

  // (b) 对象格式：{ "台湾大道": [1,2,3] } / { "台湾大道": { nodes:[...] } } / { "台湾大道": { edgeIds:[...] } }
  if (!Array.isArray(roadsArr) && roads && typeof roads === 'object') {
    const metaKeys = new Set(['version','meta','metadata','created','updated','source','count']);
    const entries = Object.entries(roads).filter(([k]) => !metaKeys.has(k.toLowerCase()));
    if (entries.length > 0) {
      roadsArr = entries.map(([name, v]) => {
        if (Array.isArray(v)) return { name, nodes: v };
        if (v && typeof v === 'object') {
          return {
            ...v,
            name: v.name ?? v.roadName ?? v.road_name ?? name,
            nodes: v.nodes ?? v.nodeIds ?? v.node_ids ?? v.node_list ?? v.ids ?? [],
            edgeIds: v.edgeIds ?? v.edge_ids ?? v.edges ?? []
          };
        }
        return { name };
      });
    }
  }

  State.roadNames = [];
  State.roadNameToNodes = new Map();
  State.edgeIdToRoadNames = new Map();                // ← 新增
  State.edgeAttr = new Map(); State.RA = null; State.graphVersion++; State.vehCache = null; State.alt = null; State.altCache = null;

  // (c) 从 nodes.json 的属性提取道路名称
  {
    const ROAD_KEYS = ['road','roadName','road_name','street','street_name','streetName',
                       'highway','highway_name','highwayName','way_name','wayName','way'];
    for (let i = 0; i < n; i++) {
      const nd = nodesArr[i];
      if (!nd || typeof nd !== 'object' || Array.isArray(nd)) continue;

      let rname = null;
      for (const k of ROAD_KEYS) {
        if (typeof nd[k] === 'string' && nd[k].length > 0 && nd[k].length < 60) { rname = nd[k]; break; }
      }
      if (!rname && typeof nd.name === 'string' && nd.name.length < 60 && /[路街道巷弄]/.test(nd.name)) {
        rname = nd.name;
      }
      if (!rname) continue;

      let arr = State.roadNameToNodes.get(rname);
      if (!arr) { arr = []; State.roadNameToNodes.set(rname, arr); State.roadNames.push(rname); }
      arr.push(i);
    }
  }

  // (d) 从 roads.json 补上 name → 节点（nodes 或 edgeIds 两种来源）
  // 注意：edgeIdToRoadNames 的 Set 可能被多條邊共用，其他模組只能讀、不可修改
const E2R = State.edgeIdToRoadNames, soleName = new Map(), owned = new WeakSet();
if (Array.isArray(roadsArr)) {
  for (const r of roadsArr) {
    if (!r) continue;
    const name = typeof r === 'string' ? r
               : (r.name ?? r.roadName ?? r.road_name ?? r.street ?? r.streetName);
    if (!name || typeof name !== 'string') continue;

    let arr = State.roadNameToNodes.get(name);
    if (!arr) { arr = []; State.roadNameToNodes.set(name, arr); State.roadNames.push(name); }
    const seen = new Set(arr);

    // —— 直接给节点 id 的多种写法
    let nodeList = r.nodes ?? r.nodeIds ?? r.node_ids ?? r.nodeList ?? r.node_list
                ?? r.vertices ?? r.vertexIds ?? r.vertex_ids
                ?? r.points ?? r.ids ?? r.list;
    if (typeof nodeList === 'string') nodeList = nodeList.split(/[,\s]+/).filter(Boolean);
    if (Array.isArray(nodeList)) {
      for (const nid of nodeList) {
        const idx = resolveIdx(nid);
        if (idx >= 0 && !seen.has(idx)) { arr.push(idx); seen.add(idx); }
      }
    }

      const attr = readRoadAttr(r);
      let edgeIdList = r.edgeIds ?? r.edge_ids ?? r.edges;
      if (Array.isArray(edgeIdList)) {
        let one = soleName.get(name); if (!one) { one = new Set([name]); soleName.set(name, one); }
        for (const eid of edgeIdList) {
          const k = String(eid);
          // ① 反查：edgeId → 道路名。只屬於一條路的 edgeId 共用同一個 Set（唯讀）；第二個路名出現時才複製成自己的 Set
          const ns = E2R.get(k);
          if (!ns) E2R.set(k, one);
          else if (!ns.has(name)) { if (owned.has(ns)) ns.add(name); else { const c = new Set(ns); c.add(name); owned.add(c); E2R.set(k, c); } }
          if (attr) State.edgeAttr.set(k, attr);
          // ② 顺推：edgeId → 节点（依輸入順序，去重）
          for (let i = eidHead.get(k) ?? -1; i >= 0; i = eidNext[i]) {
            const a = ends[i * 2], b = ends[i * 2 + 1];
            if (!seen.has(a)) { arr.push(a); seen.add(a); }
            if (!seen.has(b)) { arr.push(b); seen.add(b); }
          }
        }
      }
  }
}
  State.roadNames.sort();

if (State.roadNames.length === 0) {
  console.warn('%c⚠ 未载入任何道路名称', 'color:#dc2626;font-weight:bold');
} else {
  const emptyCount = [...State.roadNameToNodes.values()].filter(a => a.length === 0).length;
  if (emptyCount > 0) {
    console.warn(`⚠ ${emptyCount} / ${State.roadNames.length} 个道路名称未绑定节点`);
    console.warn('  roads.json 第一条示例：',
                 JSON.stringify(roadsArr[0], null, 2)?.slice(0, 600));
    console.warn('  edges.json 第一条示例（展开后）：',
                 JSON.stringify(edgesArr[0], null, 2));
    console.warn('  抽样 edgeIds：',
                 JSON.stringify((roadsArr[0]?.edgeIds ?? roadsArr[0]?.edge_ids ?? [])?.slice?.(0, 5) ?? 'N/A'));
    console.warn('  edgeIdToNodes 前 3 个 key：',
                 JSON.stringify([...eidHead.keys()].slice(0, 3)));
  } else {
    console.info(`✅ 道路名映射成功：${State.roadNames.length} 条道路`);
  }
}
  State.N = n; State.E = m / 2; State.loaded = true;
}
// 共同收尾（JSON 與封包都走這裡）：座標型別、空間索引、所有依賴舊圖的快取作廢
function finalizeGraph() {
    // ====== 空間索引（找最近節點用） ======
  State.coordType = detectCoordType();
  console.info(`%c座標型別 coordType = ${State.coordType}`, 'color:#2563eb;font-weight:bold');
  buildSpatialIndex();
  if (State.N === 0) throw new Error('節點數為 0');
  if (State.E === 0) console.warn('⚠ 邊數為 0，路線規劃將無法運作');
  // 圖換了：所有依賴舊圖的快取一律作廢（graphVersion 讓查詢快取自動失效）
  State.routeSet = []; State.activeKey = null; State.selStep = -1; State.hScale = null; State.SPD = null; State.RA = null; State.graphVersion++; State.vehCache = null; State.alt = null; State.altCache = null; State.adjFrom = null; State.UBC = null; State.BSC = null; applyRoadTable(); State.UB && ubProject(); hlCache.clear(); nearbyCache.key = null; State.projUnit = autoUnit(); reprojectTransit(); State.busSug = null;
  State.currentRoute = null;
}
