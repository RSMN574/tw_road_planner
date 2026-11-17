// planners.js
import { State } from './state.js';
import { ALGO, DASH, MODES, PAL } from './constants.js';
import { busModeOn, ensureRA, speedOfEdge } from './road-attrs.js';
import { PREFS, avoidTollOn, ensureVeh, getMode, getPref, getVehicleKey, makeCost, opsModeOn, routeTimeS, tollLength } from './vehicle.js';
import { buildAvoidSet, countTurns, edgeCov, getW, roadSeqOf, routeMetrics, scoreRoutes } from './analysis.js';
import { buildLandmarks, dijkstraTurns, makeHeuristic, overlapRatio, spSearch } from './router.js';
import { labelSetting, solve, yenK } from './router-multi.js';
import { qv } from './ctx.js';

// 查詢結果快取（LRU 30 筆）：key 含起終點、交通方式、目標、避開收費、偏好、權重、演算法與資料版本（State.graphVersion），資料一變就不會用到過期結果
function planKey(s0, e0, q) {
  const g = id => qv(id);
  return JSON.stringify([g('mode'), g('goal'), opsModeOn(), avoidTollOn(), getVehicleKey(), getPref(), State.routerMode, q || '', s0, e0, getW(), g('ubR'), g('kPaths'), busModeOn(), State.graphVersion, State.UB ? State.UB.n : 0, State.bus ? State.bus.n : 0]);
}
export function planAll(s0, e0, q) {
  const key = planKey(s0, e0, q), hit = State.planCache.get(key);
  if (hit) { State.planCache.delete(key); State.planCache.set(key, hit); for (const it of hit) it.visible = true; return hit; }
  const out = planAllRaw(s0, e0, q);
  State.planCache.set(key, out); if (State.planCache.size > 30) State.planCache.delete(State.planCache.keys().next().value);
  return out;
}

// A* 啟發函式：只用「每公尺成本下界」＋地標（由同一成本函式建立），不會高估 → 仍保證最佳
function heurFor(vk, p, e0, base, mper, tollOff, ignoreForb) {
  const alt = (State.routerMode === 'astar' || State.routerMode === 'mlevel') && State.N >= 20000 ? buildLandmarks(`${vk}|${p.a},${p.b},${p.d}${ignoreForb ? '|nf' : ''}${tollOff ? '|nt' : ''}`, base) : null;
  return makeHeuristic(e0, mper, alt);
}

function planAllRaw(s0, e0, q) {
  if (getMode() === 'transit') return [];                            // 大眾運輸由 updateBusSuggestion 處理，不走道路候選
  if (opsModeOn()) return planBus(s0, e0);                           // 營運規劃（公車業者）：適宜性／YouBike／站牌多目標候選
  const goal = qv('goal', 'compare');
  if (goal === 'alt') return planK(s0, e0);
  if (goal === 'pareto') return planPareto(s0, e0);
  const vk = getVehicleKey(), tollOff = avoidTollOn(), avoid = q ? buildAvoidSet(q) : null, pref = getPref(), V = ensureVeh(vk), ignoreForb = false;
  return MODES.filter(m => m.key !== 'avoid' || q).map(m => {          // 沒輸入要避開的道路 → 不顯示「避開」這一項
    const item = { ...m, route: null, visible: true, msg: '', plain: true };
    const p = m.key === 'shortest' ? PREFS.short : m.key === 'fastest' ? PREFS.fast : pref;      // 最短/最快用固定權重；「依偏好」與「避開」用使用者的 α、β、δ
    const { fn: base, mper } = makeCost(vk, p, ignoreForb, tollOff);
    let fn = base;
    if (m.key === 'avoid') {
      if (!avoid || avoid.size === 0) { item.msg = `找不到名為「${q}」的道路`; return item; }
      const AV = new Uint8Array(State.adjTo.length);                  // 1=可走 2=禁行（惰性填入）
      fn = (eid, w, k) => { let t = AV[k]; if (!t) AV[k] = t = avoid.has(eid) ? 2 : 1; return t === 2 ? Infinity : base(eid, w, k); };
    }
    const hf = (State.routerMode === 'astar' || State.routerMode === 'mlevel') ? heurFor(vk, p, e0, base, mper, tollOff, ignoreForb) : null;
    const r = solve(s0, e0, fn, hf);
    if (!r) { item.msg = tollOff ? '找不到路線（已避開國道，或此交通方式無法通行）' : '找不到路線（此交通方式可能無法通行）'; return item; }
    r._color = m.color; r._label = m.label;
    Object.assign(item, { route: r, min: routeTimeS(r, V) / 60, seq: roadSeqOf(r), met: routeMetrics(r), turns: countTurns(r), algo: ALGO[State.routerMode], veh: vk, toll: tollLength(r) });
    r._plain = true; return item;
  });
}

// 導航中重新規劃：只算「目前正在走的那一種」路線（最短／最快／依偏好），不重算整組候選與分析——偏航時越快給出新路線越好
export function planOne(s0, e0, key = 'fastest') {
  const vk = getVehicleKey(), tollOff = avoidTollOn(), p = key === 'shortest' ? PREFS.short : key === 'pref' ? getPref() : PREFS.fast, V = ensureVeh(vk);
  const { fn, mper } = makeCost(vk, p, false, tollOff);
  const hf = (State.routerMode === 'astar' || State.routerMode === 'mlevel') ? heurFor(vk, p, e0, fn, mper, tollOff, false) : null;
  const r = solve(s0, e0, fn, hf); if (!r) return null;
  const m = MODES.find(x => x.key === (key === 'shortest' || key === 'pref' ? key : 'fastest')) || MODES[0];
  r._color = m.color; r._label = m.label; r._plain = true;
  return { ...m, route: r, visible: true, msg: '', plain: true, min: routeTimeS(r, V) / 60, seq: [], met: null, turns: 0, algo: ALGO[State.routerMode], veh: vk, toll: tollLength(r) };
}

export function planBus(s0, e0) {
  const ra = ensureRA(), W = getW(), forb = ra.forb, hasUb = !!(State.UB && State.UB.x), hasBus = !!(State.bus && State.bus.x);
  const q = W.suit + (hasUb ? W.ub : 0) + (hasBus ? W.bus : 0), lam = W.dist > 0 ? Math.min(8, Math.max(0.5, q / W.dist)) : 4;   // 品質 vs 距離的相對重要性
  const pen = W.dist > 0 ? Math.min(300, W.turn / W.dist * 100) : 100;                                                           // 每次轉彎 ≈ 幾公尺
  const U = f => (eid, w, k) => forb[k] ? Infinity : f(w, k);                                                                      // 權重只加大 → A* 啟發仍成立
  const good = k => { let a = W.suit * ra.suit[k] / 100, d = W.suit; if (hasUb) { a += W.ub * edgeCov(k, 'ub') / 3; d += W.ub; } if (hasBus) { a += W.bus * edgeCov(k, 'bus') / 2; d += W.bus; } return d > 0 ? a / d : 0.5; };
  // b_suit 倍率 8：適宜性優先，願意繞路（b_comp 才是距離與品質的折衷）
  const specs = [
    { key: 'b_short', label: '最短距離', color: '#f59e0b', dash: '', fn: U(w => w) },
    { key: 'b_suit', label: '適宜性最高', color: '#16a34a', dash: '10 5', fn: U((w, k) => w * (1 + 8 * (1 - ra.suit[k] / 100))) },
    { key: 'b_ub', label: 'YouBike 最多', color: '#f97316', dash: '2 6', fn: U((w, k) => w * (1 + 2 * (1 - edgeCov(k, 'ub') / 3))), skip: hasUb ? '' : '未載入 YouBike 資料' },
    { key: 'b_comp', label: '綜合最高', color: '#2563eb', dash: '', fn: U((w, k) => w * (1 + lam * (1 - good(k)))), pen },
    { key: 'b_turn', label: '轉彎較少', color: '#7c3aed', dash: '14 4 3 4', fn: U(w => w), pen: 300, noRetry: true }];
  const seen = new Map(), items = [], sig = r => r.edgePath.map(k => State.adjEid[k]).join('|');
  for (const sp of specs) {
    const it = { key: sp.key, label: sp.label, color: sp.color, visible: true, route: null, msg: sp.skip || '' };
    items.push(it); if (sp.skip) continue;
    const run = fn => sp.pen > 0 ? dijkstraTurns(s0, e0, fn, sp.pen) : solve(s0, e0, fn);
    let r = run(sp.fn);
    if (!r) { it.msg = '找不到路線（可能被禁行道路截斷）'; continue; }
    let dup = seen.get(sig(r));
    if (dup && !sp.noRetry) {                                          // 與已有候選相同 → 懲罰已用邊後重試一次，要求「實際差異」
      const used = new Set(dup.route.edgePath), r2 = run((eid, w, k) => { const c = sp.fn(eid, w, k); return used.has(k) ? c * 1.6 : c; });
      if (r2 && !seen.has(sig(r2))) { r = r2; it.note = `原最佳解與「${dup.label}」相同，此為刻意避開重複邊的替代路線`; dup = null; }
    }
    if (dup) { it.msg = `與「${dup.label}」為相同路徑（已略過）`; continue; }
    r._color = sp.color; r._label = sp.label; r._dash = sp.dash;
    let t = 0; for (const k of r.edgePath) t += State.adjW[k] / 1000 / speedOfEdge(State.adjEid[k]);
    Object.assign(it, { route: r, min: t * 60, seq: roadSeqOf(r), met: routeMetrics(r), turns: countTurns(r), algo: sp.pen > 0 ? 'Dijkstra（有向邊狀態，含轉彎罰分）' : ALGO[State.routerMode] }); seen.set(sig(r), it);
  }
  scoreRoutes(items); return items;
}

export function finishItem(label, i, r, algo, vk, plain) {
  r._color = PAL[i % 8]; r._label = label; r._dash = DASH[i % 8];
  let t = 0, toll = 0;
  if (vk) { t = routeTimeS(r, ensureVeh(vk)) / 60; toll = tollLength(r); } else { for (const k of r.edgePath) t += State.adjW[k] / 1000 / speedOfEdge(State.adjEid[k]); t *= 60; }
  if (plain) r._plain = true;
  return { key: 'k' + i, label, color: PAL[i % 8], visible: true, route: r, msg: '', min: t, seq: roadSeqOf(r), met: routeMetrics(r), turns: countTurns(r), algo, veh: vk, plain: !!plain, toll };
}

// 汽車 K 條替代路線／Pareto：以「時間成本」搜尋（成本單位＝秒），啟發函式只用下界
export function planK(s0, e0) {
  const vk = getVehicleKey(), tollOff = avoidTollOn(), p = PREFS.fast, { fn, mper } = makeCost(vk, p, false, tollOff);
  const K = Math.max(2, Math.min(8, +qv('kPaths', 5) || 5)), t0 = performance.now(), hf = heurFor(vk, p, e0, fn, mper, tollOff, false), rs = yenK(s0, e0, fn, K, 30, 0.85, hf);
  // 格子狀路網常見：Yen 的前幾名都是「只差一小段」的近似路線，被重疊過濾掉 → 用懲罰法補足（已用過的邊加權後重搜，成本只會變大，A* 下界仍成立）
  if (rs.length && rs.length < K) {
    const pen = new Float64Array(State.adjTo.length).fill(1), best = rs[0].cost, costOf = r => { let c = 0; for (const k of r.edgePath) c += fn(State.adjEid[k], State.adjW[k], k); return c; };
    for (let it = 0; it < K * 3 && rs.length < K; it++) {
      for (const r of rs) for (const k of r.edgePath) pen[k] *= 1.35;
      const r = spSearch(s0, e0, (eid, w, k) => fn(eid, w, k) * pen[k], v => hf(v)); if (!r) break;
      const real = costOf(r); if (real > best * 1.6) break;                                   // 太繞就不要
      if (rs.every(x => overlapRatio(x, r) <= 0.85)) { r.cost = real; r._penalty = true; rs.push(r); }
    }
    rs.sort((a, b) => a.cost - b.cost);
  }
  console.info(`ℹ Yen K=${K}：找到 ${rs.length} 條，${Math.round(performance.now() - t0)} ms`);
  if (!rs.length) return [{ key: 'k0', label: '替代路線', color: '#94a3b8', visible: true, route: null, msg: tollOff ? '找不到路線（已避開國道）' : '找不到路線' }];
  return rs.map((r, i) => { const it = finishItem(i ? `替代 ${i}` : '第 1 條（最快）', i, r, r._penalty ? `懲罰法替代路線（Yen 的近似解重疊太多）` : `Yen K 條（K=${K}，以時間為成本）`, vk, true); if (i) it.note = `與第 1 條重疊 ${Math.round(overlapRatio(rs[0], r) * 100)}%，約多 ${Math.max(0, Math.round(it.min - (rs[0].cost / 60)))} 分`; return it; });
}

export function planPareto(s0, e0) {
  const vk = getVehicleKey(), tollOff = avoidTollOn(), p = PREFS.fast, V = ensureVeh(vk), { fn, mper } = makeCost(vk, p, false, tollOff), hf = heurFor(vk, p, e0, fn, mper, tollOff, false);
  const crit = k => { const w = State.adjW[k]; return [w / (V.spd[k] / 3.6), w, w * V.risk[k]]; };     // [時間 s, 距離 m, 風險當量]
  const rs = labelSetting(s0, e0, fn, { eps: 0.03, maxLab: 8, bound: 1.5, crit, hf, h0: hf });
  if (!rs.length) return [{ key: 'k0', label: 'Pareto', color: '#94a3b8', visible: true, route: null, msg: tollOff ? '找不到路線（已避開國道）' : '找不到路線' }];
  const arg = d => rs.reduce((a, r, i) => r.crit[d] < rs[a].crit[d] - 1e-9 ? i : a, 0), iD = arg(1), iR = arg(2), hasRisk = rs.some(r => r.crit[2] > 0);
  return rs.map((r, i) => { const it = finishItem(i === 0 ? '時間最短' : i === iD ? '距離最短' : (hasRisk && i === iR) ? '風險最低' : `折衷 ${i + 1}`, i, r, 'Label Setting（時間×距離×風險）', vk, true);
    it.note = `時間 ${(r.crit[0] / 60).toFixed(1)} 分｜距離 ${(r.crit[1] / 1000).toFixed(2)} km` + (hasRisk ? `｜風險當量 ${Math.round(r.crit[2])}` : ''); return it; });
}
