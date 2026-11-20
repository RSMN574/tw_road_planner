// restrictions.mjs — OSM 轉向限制（relation type=restriction）→ 圖上的「有向邊 → 有向邊」限制
//
// 有向邊（arc）編號：邊 e 順著 way 方向＝2e、反方向＝2e+1
// 支援：
//  ・restriction=no_left_turn／no_right_turn／no_straight_on／no_u_turn／no_entry／no_exit
//          only_left_turn／only_right_turn／only_straight_on／only_u_turn
//  ・via 是 node（最常見）或一條／多條 way（例如經過中央分隔島的迴轉）
//  ・type=restriction:<運具>、restriction:<運具>=…（只限某些運具）、except=bicycle;psv…（排除某些運具）
//  ・restriction:conditional、day_on/hour_on（依時段）→ 記錄為「有條件」，預設不套用，路徑規劃會提示
//  ・from／to 道路穿過 via 點（沒在 via 切斷）時，用轉彎角度判斷是哪一個方向
// 無法對應的限制（找不到道路、via 不相接、格式錯誤…）不套用，原因列在報告裡。
import { bearingE7, distE7, bsearch } from './grow.mjs';
import { PROFILE_IX } from './access.mjs';
import { parseConditionalValue } from './conditional.mjs';

export const PM = { car: 1, heavy: 2, moto: 4, bike: 8, foot: 16 }, VEHICLES_MASK = 1 | 2 | 4 | 8;
// OSM 運具鍵 → 本系統運具
const MODE_MASK = { motorcar: 1, motor_vehicle: 1 | 2 | 4, vehicle: 1 | 2 | 4 | 8, motorcycle: 2 | 4, moped: 4, mofa: 4, bicycle: 8, foot: 16, hgv: 0, psv: 0, bus: 0, taxi: 0, emergency: 0, goods: 0, agricultural: 0, hazmat: 0, caravan: 0, motorhome: 0, coach: 0, minibus: 0, share_taxi: 0, tourist_bus: 0, carpool: 0, hov: 0 };
const VALID = /^(no|only)_(left_turn|right_turn|straight_on|u_turn|entry|exit)$/;

// 第一趟讀 relation 時呼叫：只留轉向限制
export function collectRestriction(id, members, t) {
  const type = t.type || ''; if (type !== 'restriction' && !type.startsWith('restriction:')) return null;
  const from = [], to = [], viaN = [], viaW = [], bad = [];
  for (const m of members) {
    if (m.role === 'from') (m.type === 'w' ? from : bad).push(m.ref);
    else if (m.role === 'to') (m.type === 'w' ? to : bad).push(m.ref);
    else if (m.role === 'via') (m.type === 'n' ? viaN : m.type === 'w' ? viaW : bad).push(m.ref);
  }
  // 規則：一般的 restriction 對所有「車輛」有效（不含行人）；type=restriction:<運具> 或 restriction:<運具>=… 只對該運具
  const entries = [], exceptMask = String(t.except || '').split(';').map(s => s.trim()).filter(Boolean).reduce((a, k) => a | (MODE_MASK[k] ?? 0), 0);
  const legacyCond = ['day_on', 'day_off', 'hour_on', 'hour_off'].filter(k => t[k]).map(k => `${k}=${t[k]}`).join(' ');
  if (type.startsWith('restriction:')) { const md = type.slice(12), v = t['restriction:' + md] || t.restriction; if (v) entries.push({ value: v, mask: (MODE_MASK[md] ?? 0) & ~exceptMask, cond: legacyCond || null, src: 'type=' + type }); }
  else if (t.restriction) entries.push({ value: t.restriction, mask: VEHICLES_MASK & ~exceptMask, cond: legacyCond || null, src: 'restriction' });
  for (const k in t) {
    const m = /^restriction:([a-z_]+)$/.exec(k); if (!m || m[1] === 'conditional' || type.startsWith('restriction:')) continue;
    const mm = MODE_MASK[m[1]] ?? 0; if (!mm) continue;
    for (const e of entries) e.mask &= ~mm;                                           // 該運具改用專屬的值
    entries.push({ value: t[k], mask: mm & ~exceptMask, cond: legacyCond || null, src: k });
  }
  // 條件式可能含有 ;（例如 no_left_turn @ (Mo-Fr 07:00-09:00; Sa 08:00-12:00)），要依括號深度切開
  if (t['restriction:conditional']) for (const { value, cond } of parseConditionalValue(t['restriction:conditional'])) {
    if (/^[a-z_]+$/.test(value)) entries.push({ value, mask: VEHICLES_MASK & ~exceptMask, cond, src: 'restriction:conditional' });
  }
  return { id, from, to, viaN, viaW, bad, entries, tags: t };
}

// 在頂點 v 的轉彎角度：進來的 arc a、出去的 arc b；右轉為正（0＝直行、±180＝迴轉）
export function arcBearings(g) {
  const { E, G } = g;
  const pt = (e, k) => [G.lat[k], G.lon[k]];
  // arc 的「靠近某端」的方向：往內走到 ≥ 10 m 的點，比只看第一段穩定
  function dirNear(a, atEnd) {
    const e = a >> 1, fwd = !(a & 1), s = E.goff[e], t = E.goff[e + 1] - 1;
    // 進入頂點（atEnd）：arc 的最後一段；離開頂點：arc 的第一段
    const endIx = (fwd === atEnd) ? t : s, step = endIx === t ? -1 : 1;
    const [la0, lo0] = pt(e, endIx); let k = endIx + step;
    while (k > s && k < t && distE7(la0, lo0, G.lat[k], G.lon[k]) < 10) k += step;
    const [la1, lo1] = pt(e, k);
    return atEnd ? bearingE7(la1, lo1, la0, lo0) : bearingE7(la0, lo0, la1, lo1);
  }
  return (a, b) => { let d = dirNear(b, false) - dirNear(a, true); while (d <= -180) d += 360; while (d > 180) d -= 360; return d; };
}

const TARGET = { left_turn: -90, right_turn: 90, straight_on: 0, u_turn: 180 };
function score(kind, ang, uturn) {
  if (kind === 'u_turn') return uturn ? 0 : 180 - Math.abs(ang);
  if (uturn) return 999;
  const t = TARGET[kind]; return t == null ? 0 : Math.abs(ang - t);
}

export function mapRestrictions(g, raws, { uniq, vertexOf, extra, wayIndex }) {
  const { E, W } = g, out = [], skipped = {}, st = { relations: raws.length, applied: 0, viaWay: 0, conditional: 0, ambiguousResolved: 0, fromPassThrough: 0, toPassThrough: 0, angleMismatch: 0, onlyRules: 0, noRules: 0 };
  const skip = (r, why) => { skipped[why] = (skipped[why] || 0) + 1; if (!skipped.samples) skipped.samples = {}; (skipped.samples[why] ||= []).length < 10 && skipped.samples[why].push(r.id); };
  const turn = arcBearings(g), from = a => (a & 1 ? E.v[a >> 1] : E.u[a >> 1]), to = a => (a & 1 ? E.u[a >> 1] : E.v[a >> 1]);
  const edgesOf = w => { const r = []; for (let e = W.edgeOff[w]; e < W.edgeOff[w + 1]; e++) r.push(e); return r; };
  const inArcs = (w, v) => { const r = []; for (const e of edgesOf(w)) { if (E.v[e] === v) r.push(2 * e); if (E.u[e] === v) r.push(2 * e + 1); } return r; };
  const outArcs = (w, v) => { const r = []; for (const e of edgesOf(w)) { if (E.u[e] === v) r.push(2 * e); if (E.v[e] === v) r.push(2 * e + 1); } return r; };
  const verticesOfNode = id => { const u = bsearch(uniq, id); if (u < 0 || vertexOf[u] < 0) return []; const r = [vertexOf[u]]; for (let l = 0; l < 32; l++) { const v = extra.get(u * 32 + l); if (v !== undefined) r.push(v); } return r; };

  for (const r of raws) {
    if (r.bad.length) { skip(r, 'member-type（成員類型不對）'); continue; }
    const ents = r.entries.filter(e => e.mask && VALID.test(e.value)); if (!ents.length) { skip(r, r.entries.length ? (r.entries.some(e => !VALID.test(e.value)) ? 'unknown-value（未知的 restriction 值）' : 'not-for-our-vehicles（只限公車等）') : 'no-restriction-tag'); continue; }
    if (!r.from.length || !r.to.length) { skip(r, 'missing-from-to'); continue; }
    if (r.viaN.length + (r.viaW.length ? 1 : 0) !== 1 || (r.viaN.length && r.viaW.length)) { skip(r, 'via（via 數量不對）'); continue; }
    const fw = r.from.map(wayIndex), tw = r.to.map(wayIndex);
    if (fw.some(x => x < 0) || tw.some(x => x < 0)) { skip(r, 'way-not-in-graph（道路不在路網內，可能在資料範圍外）'); continue; }
    for (const ent of ents) {
      const [kindNo, typ] = ent.value.split(/_(.+)/), kind = kindNo === 'only' ? 'only' : 'no';
      const base = { rel: r.id, value: ent.value, kind, mask: ent.mask, cond: ent.cond };
      if (r.viaN.length) {
        // via node：找出 from／to 都有碰到的頂點（高度層拆點時可能有好幾個）
        const vs = verticesOfNode(r.viaN[0]).filter(v => fw.some(w => inArcs(w, v).length) && tw.some(w => outArcs(w, v).length));
        if (!vs.length) { skip(r, 'via-not-connected（via 點不在 from／to 道路上）'); break; }
        const v = vs[0]; let pairs = [];
        if (fw.some(w => inArcs(w, v).length > 1)) st.fromPassThrough++;                  // from 道路穿過 via 點（OSM 規範要求在 via 斷開）：依轉彎角度判斷，兩個方向都符合時都套用
        if (tw.some(w => outArcs(w, v).length > 1)) st.toPassThrough++;
        for (const f of fw) for (const t of tw) for (const a of inArcs(f, v)) for (const b of outArcs(t, v)) pairs.push({ a, b, u: (a >> 1) === (b >> 1), ang: turn(a, b) });
        if (typ !== 'u_turn') pairs = pairs.filter(p => !p.u);                       // 迴轉以外的限制不會是「原路折返」
        if (!pairs.length) { skip(r, 'no-turn-pair'); break; }
        let chosen = pairs;
        if (pairs.length > 1 && typ !== 'entry' && typ !== 'exit') {
          // 同一組 from／to 道路有多種進出方式（道路穿過 via 點）：選轉彎角度最符合的
          const best = Math.min(...pairs.map(p => score(typ, p.ang, p.u)));
          chosen = pairs.filter(p => score(typ, p.ang, p.u) <= best + 25);
          if (chosen.length < pairs.length) st.ambiguousResolved++;
        }
        for (const p of chosen) {
          if (pairs.length === 1 && typ !== 'entry' && typ !== 'exit' && score(typ, p.ang, p.u) > 70) st.angleMismatch++;
          out.push({ ...base, from: p.a, via: v, to: p.b, angle: Math.round(p.ang) });
        }
        st.applied++; ent.cond ? st.conditional++ : 0; kind === 'only' ? st.onlyRules++ : st.noRules++;
      } else {
        // via way（一條或多條）：從 from 接上 via 的頂點，沿 via 道路走到接上 to 的頂點
        const vw = r.viaW.map(wayIndex); if (vw.some(x => x < 0)) { skip(r, 'via-way-not-in-graph'); break; }
        const viaE = new Set(vw.flatMap(edgesOf)), viaV = new Set(); for (const e of viaE) { viaV.add(E.u[e]); viaV.add(E.v[e]); }
        const starts = [], ends = new Set();
        for (const f of fw) for (const e of edgesOf(f)) for (const v of [E.u[e], E.v[e]]) if (viaV.has(v) && inArcs(f, v).some(a => !viaE.has(a >> 1))) starts.push(v);
        for (const t of tw) for (const e of edgesOf(t)) for (const v of [E.u[e], E.v[e]]) if (viaV.has(v) && outArcs(t, v).some(b => !viaE.has(b >> 1))) ends.add(v);
        let found = null;
        for (const s0 of new Set(starts)) {                                              // BFS 只走 via 道路
          const prev = new Map([[s0, -1]]), q = [s0];
          while (q.length && !found) { const x = q.shift(); if (ends.has(x) && x !== s0) { found = { s0, end: x, prev }; break; }
            for (const e of viaE) for (const [y, a] of [[E.v[e], 2 * e], [E.u[e], 2 * e + 1]]) if (from(a) === x && !prev.has(y)) { prev.set(y, a); q.push(y); } }
          if (found) break;
        }
        if (!found) { skip(r, 'via-way-not-connected（via 道路沒有連接 from 與 to）'); break; }
        const arcs = []; for (let x = found.end; x !== found.s0;) { const a = found.prev.get(x); arcs.push(a); x = from(a); } arcs.reverse();
        const ins = fw.flatMap(f => inArcs(f, found.s0)).filter(a => !viaE.has(a >> 1)), outs = tw.flatMap(t => outArcs(t, found.end)).filter(b => !viaE.has(b >> 1));
        if (!ins.length || !outs.length) { skip(r, 'via-way-no-arcs'); break; }
        for (const a of ins) for (const b of outs) out.push({ ...base, from: a, viaArcs: arcs, to: b });
        st.applied++; st.viaWay++; ent.cond ? st.conditional++ : 0; kind === 'only' ? st.onlyRules++ : st.noRules++;
      }
    }
  }
  return { rules: out, stats: st, skipped };
}
