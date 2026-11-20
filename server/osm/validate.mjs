// validate.mjs — 道路圖品質檢查：各運具的連通性（強連通分量）、孤立點、死路、通行狀態分布、速限缺漏、轉向限制
import { PROFILES, ST_KEY, ST_LABEL } from './access.mjs';
import { HIGHWAYS } from './tags.mjs';

export function validateGraph(g, router) {
  const { V, E, W } = g, rep = { profiles: {}, roads: {} };
  // 道路長度：各類別、有無速限
  let total = 0, withSpeed = 0; const byClass = {};
  for (let e = 0; e < E.n; e++) { const w = E.way[e], L = E.len[e], h = HIGHWAYS[W.hw[w]]; total += L; if (Number.isFinite(W.maxspeed[w])) withSpeed += L; byClass[h] = (byClass[h] || 0) + L; }
  rep.roads = { totalKm: +(total / 1000).toFixed(1), maxspeedTaggedPct: +(100 * withSpeed / Math.max(1, total)).toFixed(1), byClassKm: Object.fromEntries(Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, +(v / 1000).toFixed(1)])) };
  // 速限來源（以長度計，渡輪除外）：maxspeed 標籤／區域速限代碼（TW:urban 等）／依道路類別推估
  const src = { tag: 0, zone: 0, class: 0 }, ferry = { ways: new Set(), km: 0, withDuration: new Set(), carAllowed: new Set(), names: new Map() };
  for (let e = 0; e < E.n; e++) {
    const w = E.way[e], L = E.len[e];
    if (router.isFerry(2 * e)) { ferry.ways.add(w); ferry.km += L / 1000; if (W.ferryS && Number.isFinite(W.ferryS[w])) ferry.withDuration.add(w); if ((router.status(2 * e, 0) & 7) === 1) ferry.carAllowed.add(w); const n = router.wayName(w) || '（無名稱）'; ferry.names.set(n, (ferry.names.get(n) || 0) + L / 1000); continue; }
    if (W.hw[w] === router.pierHw) continue;
    const l = router.limitOf(2 * e); src[l.src || 'class'] += L;
  }
  const nonFerry = Math.max(1, src.tag + src.zone + src.class);
  rep.roads.limitSourcePct = { tag: +(100 * src.tag / nonFerry).toFixed(1), zone: +(100 * src.zone / nonFerry).toFixed(1), class: +(100 * src.class / nonFerry).toFixed(1) };
  rep.ferries = { pierLinks: g.stats.ferryPierLinks || 0, unlinkedEnds: g.stats.ferryUnlinkedEnds || 0, ways: ferry.ways.size, km: +ferry.km.toFixed(1), withDuration: ferry.withDuration.size, carAllowedByTag: ferry.carAllowed.size, longest: [...ferry.names].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, km]) => ({ name: n, km: +km.toFixed(1) })) };
  for (const p of PROFILES) {
    const P = router.profile(p.key);
    const km = new Float64Array(7); let condKm = 0;
    for (let a = 0; a < 2 * E.n; a++) { const s = router.status(a, P.pi); km[s & 7] += E.len[a >> 1] / 1000; if (s & 8) condKm += E.len[a >> 1] / 1000; }
    const { comp, count, size, usable } = router.components(p.key), bb = [];
    const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => size[b] - size[a]), top = order.slice(0, 8), topSet = new Map(top.map((c, i) => [c, i]));
    for (const c of top) bb.push({ vertices: size[c], minLat: 90, maxLat: -90, minLon: 180, maxLon: -180 });
    for (let v = 0; v < V.n; v++) { const i = topSet.get(comp[v]); if (i === undefined) continue; const b = bb[i], la = V.lat[v] / 1e7, lo = V.lon[v] / 1e7; if (la < b.minLat) b.minLat = la; if (la > b.maxLat) b.maxLat = la; if (lo < b.minLon) b.minLon = lo; if (lo > b.maxLon) b.maxLon = lo; }
    let nUsable = 0; for (let v = 0; v < V.n; v++) if (usable[v]) nUsable++;
    const small = order.filter(c => size[c] <= 5).length;
    rep.profiles[p.key] = { label: p.label, usableVertices: nUsable, components: count, largestPct: count ? +(100 * size[order[0]] / Math.max(1, nUsable)).toFixed(2) : 0, tinyComponents: small,
      topComponents: bb.map(b => ({ vertices: b.vertices, bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat].map(x => +x.toFixed(4)) })),
      directedKm: Object.fromEntries(ST_KEY.map((k, i) => [k, +km[i].toFixed(1)])), conditionalKm: +condKm.toFixed(1), unknownSpeedArcs: P.unknownSpeedArcs,
      restrictionsUsed: P.used, conditionalRestrictionsNotApplied: P.condSkipped };
  }
  rep.labels = Object.fromEntries(ST_KEY.map((k, i) => [k, ST_LABEL[i]]));
  return rep;
}

// 報告（Markdown，繁體中文）
export function reportMarkdown(g, rep, meta = {}) {
  const s = g.stats, r = g.restrictions.stats, L = [];
  L.push(`# OSM 道路圖建置報告`, '', `- 來源：${meta.source || '—'}`, `- 資料時間（PBF 表頭）：${g.header?.replication?.timestamp || '（檔案未記錄）'}；序號 ${g.header?.replication?.sequence ?? '—'}`, `- 產生程式：${g.header?.writingProgram || '—'}`, `- 建圖時間：${new Date().toISOString()}（${s.buildSeconds} 秒）`, '');
  L.push('## 規模', '', '| 項目 | 數量 |', '|---|---|', `| 讀到的 way | ${s.ways.toLocaleString()} |`, `| 進路網的道路 way | ${s.routableWays.toLocaleString()} |`, `| 道路節點（OSM node） | ${s.nodes.toLocaleString()} |`,
    `| 頂點（路口、端點） | ${s.vertices.toLocaleString()} |`, `| 邊 | ${s.edges.toLocaleString()} |`, `| 幾何點 | ${s.geometryPoints.toLocaleString()} |`, `| 道路總長 | ${rep.roads.totalKm.toLocaleString()} km |`, `| 有標速限的比例（以長度計） | ${rep.roads.maxspeedTaggedPct}% |`, '');
  L.push('## 時間模型', '', `- 速限來源（以長度計）：maxspeed 標籤 ${rep.roads.limitSourcePct.tag}%、區域速限代碼（TW:urban → 法定 50 km/h）${rep.roads.limitSourcePct.zone}%、依道路類別推估 ${rep.roads.limitSourcePct.class}%`,
    '- 路段時間＝長度 ÷（速限 × 各運具在該類道路的平均／速限比例）；經過路口加號誌等待、轉向延遲（左轉較久，機車兩段式左轉）；參數與網頁導航 ETA 相同（js/eta-params.js），沒有即時路況', '');
  L.push('## 渡輪（route=ferry）', '', `- ${rep.ferries.ways} 條航線、${rep.ferries.km} km；有標航行時間（duration）${rep.ferries.withDuration} 條，其餘依平均航速 25 km/h 推估；標明可載汽車 ${rep.ferries.carAllowedByTag} 條（其他汽機車為「未知」）`,
    `- 航線端點沒接上道路的，已接到 300 m 內最近的道路頂點（碼頭連接，推估）：${rep.ferries.pierLinks} 處；接不上的端點 ${rep.ferries.unlinkedEnds} 處（多半是國外港口）`,
    `- 航行時間不含候船與班次；最長的幾條：${rep.ferries.longest.map(f => `${f.name} ${f.km} km`).join('、') || '無'}`, '');
  L.push('## 資料問題', '', `- 找不到座標的 node：${s.missingNodes}（道路在缺點處斷開）`, `- 高度層衝突（不同 layer／橋／隧道在中間點共用 node）：${s.layerConflictNodes} 個點，已拆成不同頂點、不相連${s.layerConflictSample.length ? '；例：node ' + s.layerConflictSample.slice(0, 10).join('、') : ''}`,
    `- 孤立頂點：${s.isolatedVertices}；死路端點：${s.deadEnds.toLocaleString()}；長度為 0 的邊：${s.zeroLengthEdges}；封閉道路（已在中點切開）：${s.closedWays}`,
    `- 沒進路網的 highway：${Object.entries(s.skipped).map(([k, v]) => `${k} ${v}`).join('、') || '無'}`,
    `- 不認得的通行值（評估次數）：${Object.entries(s.unknownAccessValues).slice(0, 15).map(([k, v]) => `${k} ×${v}`).join('、') || '無'}`, '');
  L.push('## 轉向限制', '', `- relation：${r.relations}；套用 ${r.applied}（via node ${r.applied - r.viaWay}、via way ${r.viaWay}）；有時段條件 ${r.conditional}（預設不套用）`,
    `- 只准（only_*）${r.onlyRules}、禁止（no_*）${r.noRules}；from 道路穿過 via 點 ${r.fromPassThrough}、to 道路穿過 via 點 ${r.toPassThrough}（依轉彎角度判斷方向）`,
    `- 沒套用：${Object.entries(g.restrictions.skipped).filter(([k]) => k !== 'samples').map(([k, v]) => `${k} ${v}`).join('、') || '無'}`, '');
  L.push('## 各運具', '', '| 運具 | 可用頂點 | 強連通分量 | 最大分量占比 | 允許（標籤） | 推定允許 | 未知 | 有條件 | 禁止（標籤） | 推定禁止 | 單行反向 |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [k, p] of Object.entries(rep.profiles)) { const d = p.directedKm; L.push(`| ${p.label} | ${p.usableVertices.toLocaleString()} | ${p.components.toLocaleString()} | ${p.largestPct}% | ${d.allowed} | ${d.default_allowed} | ${d.unknown} | ${d.limited} | ${d.restricted} | ${d.default_restricted} | ${d.oneway} |`); }
  L.push('', '（長度單位：公里，以「有向」計，雙向道路算兩次；未知＝未標註且沒有可靠預設，不當成允許或禁止）', '');
  L.push('## 最大的幾個連通區（汽車）', '', ...rep.profiles.car.topComponents.map((c, i) => `${i + 1}. ${c.vertices.toLocaleString()} 個頂點，範圍 ${c.bbox.join(', ')}`), '');
  return L.join('\n');
}
