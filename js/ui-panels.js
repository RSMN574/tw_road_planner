// ui-panels.js
import { State } from './state.js';
import { pickRecommended } from './bus-plan.js';
import { VEHICLES, getMode, limitStats, speedInfo, vehicleAllows } from './vehicle.js';
import { ALGO, CLS_LABEL } from './constants.js';
import { esc, fmtClock, fmtClockS, fmtDist, todayStr } from './util.js';
import { edgeRoad, findNearestNode, snapEdge } from './graph-core.js';
import { ensureRA } from './road-attrs.js';
import { ubNear } from './ubike.js';
import { busNearIdx, routeKindOf } from './bus-core.js';
import { countTurns, generateManeuvers, stopsOf } from './analysis.js';
import { legsOf, suggestBusMulti } from './bus-plan.js';
import { TDX, annotateJourney } from './tdx.js';
import { journeyToSug, ttSearch } from './timetable.js';
import { clientToWorld, fitBase, render, resetView, scheduleRender } from './render-core.js';
import { osmAnalysisRows, osmInspect, osmOn } from './osm.js';

// 起終點的世界座標：本機路網的節點用節點座標；OSM 選的點（idx = -1）用點本身的座標
const ptXY = p => (p.idx >= 0 ? [State.nodeXY[p.idx*5+2], State.nodeXY[p.idx*5+3]] : [p.lon, p.lat]);

export function renderRouteList() {
  document.getElementById('routes').innerHTML = State.routeSet.map(it => it.route
    ? `<div class="rt ${it.key === State.activeKey ? 'active' : ''}" data-k="${it.key}">
         <input type="checkbox" data-k="${it.key}" ${it.visible ? 'checked' : ''}>
         <span class="sw" style="background:${it.color}"></span><b>${it.label}</b>
         ${(it.route.distance/1000).toFixed(2)} km · 約 ${Math.round(it.min)} 分<br>
         <small>${it.seq.length ? esc(it.seq.join(' → ')) : '（無路名）'}</small>${metricsHtml(it)}</div>`
    : `<div class="rt na"><input type="checkbox" disabled><span class="sw" style="background:#cbd5e1"></span><b>${it.label}</b> ${esc(it.msg)}</div>`
  ).join('');
}

export function setActive(key) {
  const it = State.routeSet.find(x => x.key === key);
  if (!it || !it.route || !it.visible) return;
  State.activeKey = key; State.currentRoute = it.route; State.selStep = -1;
  renderRouteList(); renderSteps(); renderStops(); renderAnalysis(); scheduleRender();
}

export function stepColor(s) {
  return s.turnType === 'ferry' ? '#0891b2' : s.turnType === 'uturn' ? '#7c3aed' : s.dir === 'left' ? '#2563eb' : s.dir === 'right' ? '#dc2626' : '#64748b';
}

export function stepText(s) {
  if (s.turnType === 'start')  return `起點：從 ${esc(s.roadName || '起點')} 出發`;
  if (s.turnType === 'arrive') return `${fmtDist(s.distanceFromPrev)} 抵達：${esc(s.roadName || '終點')}`;
  if (s.turnType === 'ferry') return `${fmtDist(s.distanceFromPrev)} ⛴ 搭乘渡輪 ${esc(s.roadName || '')}${s.spd ? ` <small style="color:#64748b">（${esc(s.spd)}）</small>` : ''}`;
  const d = s.dir === 'left' ? '左' : '右';
  const act = { straight: '直行', slight: `微${d}轉`, turn: `${d}轉`, sharp: `急${d}轉`, uturn: '迴轉' }[s.turnType];
  return `${fmtDist(s.distanceFromPrev)} ${act} ${esc(s.roadName)}${s.spd ? ` <small style="color:#64748b">（${esc(s.spd)}）</small>` : ''}`;
}

export function renderSteps() {
  const el = document.getElementById('steps'), r = State.currentRoute;
  if (!r) { el.innerHTML = ''; return; }
  if (!r._man) r._man = generateManeuvers(r);
  el.innerHTML = `<h3>路線詳情（${r._label}・${r._man.length} 步）</h3>` +
    r._man.map((m, i) => `<div class="step" data-i="${i}"><span class="dot" style="background:${stepColor(m)}"></span><span>${stepText(m)}</span></div>`).join('');
}

export function setHighlight(name) {
  State.highlightRoad = name;
  const el = document.getElementById('hlInfo');
  el.style.display = name ? 'block' : 'none';
  el.textContent = name ? `已高亮：${name}` : '';
}

export function toggleHighlight(name) {
  if (!name) { showStatus('此段沒有路名，無法高亮', 'loading'); return; }
  setHighlight(State.highlightRoad === name ? null : name);          // 再點同一條路取消
  scheduleRender();
}

export const GOAL_TAG = { fastest: '最快抵達', fewer: '最少轉乘', lesswalk: '最少步行', pareto: 'Pareto 最優（時間最短者）' };
export function updateBusSuggestion() {
  State.busOpts = []; State.busSel = 0; State.busSug = null; State.busRec = -1;
  if (State.bus && State.bus.x && State.fromPoint && State.toPoint) {
    const [fx, fy] = ptXY(State.fromPoint), [tx, ty] = ptXY(State.toPoint);
    State.busOpts = suggestBusMulti(fx, fy, tx, ty);
    if (getMode() === 'transit') {
      const goal = document.getElementById('goal').value; State.paretoOnly = goal === 'pareto';
      State.busRec = pickRecommended(State.busOpts, goal); if (State.busRec >= 0) State.busSel = State.busRec;
    }
    State.busSug = State.busOpts[State.busSel];
  }
  renderBusBox(); scheduleRender();
  enrichBusSuggestion(false);
}
// 大眾運輸方案：把畫面縮放到整個方案（起點、各站、終點）
export function fitToTransit() {
  const o = State.busSug, b = State.bus; if (!o || o.error || !b || !b.x) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; const add = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  add(o.ox, o.oy); add(o.dx, o.dy); for (const r of o.rides) for (const i of r.stops) add(b.sx[i], b.sy[i]);
  if (!isFinite(x0)) return; fitBase(x0, x1, y0, y1, 60); resetView(); render();
}

export function renderBusBox() {
  const box = document.getElementById('busBox');
  if (!State.busSug) { box.innerHTML = ''; return; }
  const ybChk = State.UB && State.UB.x ? `<label style="font-size:12px;display:block;margin:2px 0"><input type="checkbox" id="ubikeLink" ${State.ubikeLink !== false ? 'checked' : ''} style="width:auto"> 🚲 YouBike 接駁（起點騎到較遠的站、下車後騎到終點；時間推估，未含即時可借車輛）</label>` : '';
  if (State.busSug.error) { box.innerHTML = `<div class="rt na">🚌 公車建議：${esc(State.busSug.error)}</div>` + ybChk; return; }
  const car = State.routeSet.find(x => x.key === 'fastest' && x.route), flowOf = o => legsOf(o).map(l =>            // 步行、公車、捷運、轉乘步行都列出
    l.type === 'WALK' ? (l.m >= 1 ? `步行 ${fmtDist(l.m)}` : '') : l.type === 'TRANSFER' ? (l.sameStop ? '' : `<span title="${esc(l.src)}">轉乘步行 ${fmtDist(l.m)}</span>`) :
    l.type === 'BIKE' ? `<span title="${esc(l.src)}" style="color:#c2410c">🚲 YouBike ${fmtDist(l.m)}（${esc(l.from.name)} → ${esc(l.to.name)}，約 ${Math.round(l.sec / 60)} 分）</span>` :
    `${l.type === 'METRO_RIDE' ? '🚇 ' : ''}${esc(l.route)}（${l.stops} 站${l.fare ? `・<span title="TDX 票價（全票）：單程票 ${l.fare.single ?? '—'} 元、電子票證 ${l.fare.card ?? '—'} 元">${l.fare.card ?? l.fare.single} 元</span>` : ''}）`).filter(Boolean).join(' → ');
  let h = `<div style="font-size:13px;font-weight:600;margin:12px 0 2px;color:#334155"><input type="checkbox" id="busChk" ${State.busVisible ? 'checked' : ''} style="width:auto"> 🚌 公車方案（共 ${State.busOpts.length} 種，其中 ${State.busOpts.filter(o => o.pareto).length} 種為 Pareto 最優）</div>` +
    ybChk +
    `<label style="font-size:12px;display:block;margin:2px 0"><input type="checkbox" id="parOnly" ${State.paretoOnly ? 'checked' : ''} style="width:auto"> 只顯示 Pareto 最優（時間、步行、轉乘、候車四項都沒有被其他方案全面超越）</label>` +
    (car ? `<div style="font-size:11px;color:#64748b">開車最快約 ${Math.round(car.min)} 分（估）</div>` : '');
  State.busOpts.forEach((o, i) => {
    if (State.paretoOnly && !o.pareto && i !== State.busSel) return;
    const c = o.crit;
    h += `<div class="rt busopt ${i === State.busSel ? 'active' : ''}" data-i="${i}"><b>${i + 1}.</b> ${i === State.busRec ? `<span style="font-size:10px;padding:0 4px;border-radius:3px;background:#16a34a;color:#fff">推薦：${GOAL_TAG[document.getElementById('goal').value] || ''}</span> ` : ''}${o.transfers === 0 ? '直達' : '轉乘 ' + o.transfers + ' 次'} · 系統推估約 ${Math.round(o.sec / 60)} 分${o.pareto ? ' <span style="font-size:10px;padding:0 4px;border-radius:3px;background:#7c3aed;color:#fff">Pareto</span>' : ''}<br><small>${flowOf(o)}</small>` +
      (c ? `<br><small style="color:#64748b">總時間 ${Math.round(c.time / 60)} 分｜步行 ${Math.round(c.walk)} m｜轉乘 ${c.transfers} 次｜候車 ${Math.round(c.wait / 60)} 分（假設班距，非即時）</small>` : '') + '</div>';
    if (i === State.busSel) h += liveHtml(o);
  });
  box.innerHTML = h;
}

export function metricsHtml(it) {
  const m = it.met; if (!m && !it.plain) return '';
  if (it.plain) {                                              // 一般導航：不顯示 YouBike／適宜性／站牌，只留轉彎、收費與備註
    let h = `<br><small>轉彎 ${it.turns ?? 0} 次` + (it.toll > 0 ? ` · 含國道 ${(it.toll / 1000).toFixed(1)} km（收費路段，費用未計算）` : '') + `</small>`;
    if (it.note) h += `<br><small style="color:#b45309">${esc(it.note)}</small>`;
    return h;
  }
  const parts = [`適宜性 ${Math.round(m.suit)}／100`, `未知屬性 ${Math.round(m.unkRatio * 100)}%`];
  if (m.ub) parts.push(`YouBike ${m.ub.count} 站（${m.ub.R} m 內，容量 ${m.ub.cap}）`);
  if (m.bus) parts.push(`公車站牌 ${m.bus.count} 站`);
  let h = '';
  if (it.score) {
    const c = it.score.comp, r = v => v == null ? '—' : Math.round(v);
    h += `<br><b style="color:#1d4ed8">${it.score.best ? '⭐ ' : ''}總分 ${Math.round(it.score.total)}</b> <small>適宜性 ${r(c.suit)}｜距離 ${r(c.dist)}｜轉彎 ${it.turns} 次（${r(c.turn)}）｜YouBike ${r(c.ub)}｜站牌 ${r(c.bus)}</small>`;
    h += `<br><small>${esc(it.score.reasons)}</small>`;
    if (it.score.skipped.length) h += `<br><small style="color:#94a3b8">未計入（無資料）：${it.score.skipped.join('、')}</small>`;
  }
  h += `<br><small>${parts.join(' · ')}</small>`;
  if (it.note) h += `<br><small style="color:#b45309">${esc(it.note)}</small>`;
  if (m.confirmList.length) h += `<br><small style="color:#b45309">待確認：${esc(m.confirmList.join('、'))}</small>`;
  return h;
}

export function renderStops() {
  const box = document.getElementById('stopBox'), r = State.currentRoute;
  if (!r) { box.innerHTML = ''; return; }
  if (r._plain) { box.innerHTML = ''; return; }
  const sg = stopsOf(r); if (!sg) { box.innerHTML = ''; return; }
  box.innerHTML = `<div id="stopsHead" style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">建議公車站點（${sg.stops.length} 站）</div>
    <div style="font-size:11px;color:#64748b">沿路網站距：平均 ${Math.round(sg.avgGap)} m（最小 ${Math.round(sg.minGap)}、最大 ${Math.round(sg.maxGap)}）· 現有站牌 ${sg.existing} 站 · 需確認 ${sg.warned} 站</div>` +
    sg.stops.map(s => `<div class="step" style="cursor:default"><span class="dot" style="background:${s.score >= 70 ? '#16a34a' : s.score >= 50 ? '#f59e0b' : '#94a3b8'}"></span><span>${s.q}. ${esc(s.name)} · ${Math.round(s.dist)} m · ${Math.round(s.score)} 分
      ${s.why.length ? `<small style="color:#64748b">（${esc(s.why.join('、'))}）</small>` : ''}${s.warn.length ? `<small style="color:#b45309"> ⚠ ${esc(s.warn.join('、'))}</small>` : ''}</span></div>`).join('') +
    `<div style="font-size:11px;color:#94a3b8;margin-top:4px">分數為初始啟發式；YouBike 容量不代表公車需求。</div>`;
}

export function inspectAt(sx, sy) {
  if (osmOn()) { State.inspectEdge = null; const [wx, wy] = clientToWorld(sx, sy); osmInspect(wx, wy, document.getElementById('roadInfo')); return; }   // 全台 OSM：問伺服器
  const [x, y] = clientToWorld(sx, sy), k = findNearestNode(x, y), box = document.getElementById('roadInfo');
  if (k < 0) { State.inspectEdge = null; box.innerHTML = '<div class="rt na">附近找不到道路</div>'; scheduleRender(); return; }
  const sn = snapEdge(x, y, k), ra = ensureRA(), e = sn.edge, at = e >= 0 && State.adjEid[e] != null ? State.edgeAttr.get(State.adjEid[e]) : undefined;
  State.inspectEdge = sn;
  const rows = [['道路', e >= 0 ? (edgeRoad(e) || '（無路名）') : '（孤立節點）']];
  if (e >= 0) {
    rows.push(['路寬', at && at.width > 0 ? at.width + ' m' : '未知'], ['型態（原始）', at && at.type ? at.type : '無資料'], ['歸類', CLS_LABEL[ra.cls[e]]],
      ['速限', at && at.limit > 0 ? at.limit + ' km/h' : `未知（依道路類別推估 ${speedInfo(e).limit} km/h）`], ['各車種可否通行', Object.keys(VEHICLES).map(k => `${VEHICLES[k].label}${vehicleAllows(k, ra.cls[e]) ? '✓' : '✗'}`).join(' ')], ['公車適宜性', ra.forb[e] ? '不可通行（自行車／步行專用）' : ra.suit[e] + '／100' + (ra.unk[e] ? '（屬性待人工確認）' : '')],
      ['本段長度', Math.round(State.adjW[e]) + ' m']);
  }
  if (State.UB && State.UB.x) { const R = (+document.getElementById('ubR').value || 300), ids = ubNear(sn.px, sn.py, R); rows.push([`YouBike（${R} m 內）`, ids.length ? ids.length + ' 站：' + ids.slice(0, 3).map(i => State.UB.name[i].replace(/^YouBike2?\.0_/, '')).join('、') : '無']); }
  if (State.bus && State.bus.x) { const ids = busNearIdx(sn.px, sn.py, 100); rows.push(['公車站牌（100 m 內）', ids.length ? ids.length + ' 站：' + ids.slice(0, 3).map(i => State.bus.names[i]).join('、') : '無']); }
  box.innerHTML = `<div style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">🛣 道路資訊</div><table style="font-size:12px;width:100%;border-collapse:collapse">` +
    rows.map(([a, b]) => `<tr><td style="color:#64748b;padding:2px 6px 2px 0;white-space:nowrap">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('') +
    `</table><div style="font-size:11px;color:#94a3b8;margin-top:4px">適宜性為初始分析，非通行法規判定。</div>`;
  scheduleRender();
}

// ---- 左側路線分析面板 ----

export function renderAnalysis() {
  const box = document.getElementById('analysisBox'), it = State.routeSet.find(x => x.key === State.activeKey && x.route);
  if (!it || !State.currentRoute) { box.innerHTML = ''; return; }
  const m = it.met, s = it.score, r = v => v == null ? '—' : Math.round(v);
  if (it.route._osm) { box.innerHTML = `<div style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">路線分析</div><table style="font-size:12px;width:100%;border-collapse:collapse">` + osmAnalysisRows(it).map(([a, b]) => `<tr><td style="color:#64748b;padding:2px 6px 2px 0;white-space:nowrap;vertical-align:top">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('') + '</table>'; return; }
  const rows = it.plain ? [['路線', it.label], ['演算法', it.algo || ALGO[State.routerMode]], ['總距離', fmtDist(it.route.distance)], ...speedRows(it), ['轉彎數', it.turns ?? countTurns(it.route)], ['收費路段（國道）', it.toll > 0 ? `${(it.toll / 1000).toFixed(1)} km（費率未納入）` : '無']] : [['路線', it.label], ['演算法', it.algo || ALGO[State.routerMode]], ['總距離', fmtDist(it.route.distance)], ...speedRows(it), ['轉彎數', it.turns ?? countTurns(it.route)],
    ['YouBike 覆蓋', m.ub ? `${m.ub.count} 站（${m.ub.R} m 內，容量 ${m.ub.cap}）` : '未載入'], ['既有公車站牌', m.bus ? m.bus.count + ' 站（150 m 內）' : '未載入'],
    ['道路適宜性', Math.round(m.suit) + '／100'], ['未知屬性比例', Math.round(m.unkRatio * 100) + '%'], ['路線總評分', s ? `${r(s.total)}／100${s.best ? ' ⭐ 推薦' : ''}` : '（一般模式不評分）']];
  box.innerHTML = `<div style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">路線分析</div><table style="font-size:12px;width:100%;border-collapse:collapse">` +
    rows.map(([a, b]) => `<tr><td style="color:#64748b;padding:2px 6px 2px 0;white-space:nowrap">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('') + '</table>' +
    (s ? `<div style="font-size:12px;margin-top:4px">${esc(s.reasons)}</div>` : '') +
    (!it.plain && m.confirmList.length ? `<div style="font-size:12px;margin-top:4px;color:#b45309">需人工確認：${esc(m.confirmList.join('、'))}</div>` : '');
}

export async function enrichBusSuggestion(force) {
  const sug = State.busSug; if (!sug || sug.error) return;
  if (!(TDX.proxy || (TDX.apiKey && TDX.tokenUrl))) { sug.live = { state: 'nocfg' }; renderBusBox(); return; }
  const my = ++State.liveSeq; sug.live = { state: 'loading' }; renderBusBox();
  const dv = document.getElementById('depTime').value, now = State.tdxNow(), dep = dv ? Date.parse(`${todayStr(now)}T${dv}:00+08:00`) : now;
  try { const res = await annotateJourney(sug, dep, force); if (my !== State.liveSeq || sug !== State.busSug) return; sug.live = { state: 'done', ...res }; }
  catch (err) { if (my !== State.liveSeq) return; sug.live = { state: 'error', msg: err.message }; }
  renderBusBox();
}

export function liveHtml(sug) {
  const L = sug && sug.live; if (!L) return '';
  const box = c => `<div class="rt" style="cursor:default;margin-top:4px">${c}</div>`, m = s => Math.round(s / 60);
  if (L.state === 'nocfg') return box('<small>🕒 尚未設定 TDX（金鑰），目前只顯示「系統推估」，不是即時資訊。</small>');
  if (L.state === 'loading') return box('<small>🕒 正在取得 TDX 即時資料…</small>');
  if (L.state === 'error') return box(`<small>🕒 無法整合 TDX：${esc(L.msg)}，僅顯示系統推估。</small>`);
  const tag = (txt, color) => `<span style="font-size:10px;padding:0 4px;border-radius:3px;background:${color};color:#fff">${txt}</span>`, C = { '即時 ETA': '#16a34a', '預定時刻': '#2563eb' };
  const T = x => tag(x, C[x] || '#94a3b8');
  let h = `<b>🕒 時刻整合</b> 出發 ${fmtClock(L.depMs)}` + (L.ok ? ` → 抵達 ${fmtClock(L.arriveMs)} · 總旅行 ${m(L.totalS)} 分 · 轉乘 ${L.transfers}` : ' · <span style="color:#b91c1c">此方案目前無法搭乘</span>');
  for (const g of L.legs) {
    h += `<div style="margin-top:6px;border-top:1px dashed #e2e8f0;padding-top:4px"><b>${g.metro ? '🚇 ' : ''}${esc(g.route)}</b> ${esc(g.from)} → ${esc(g.to)}（${g.nStops} 站${g.dir != null ? '，方向 ' + g.dir : ''}${g.dest ? '，往 ' + esc(g.dest) : ''}）`;
    if (g.status) h += `<br><span style="color:#b91c1c">⚠ ${esc(g.status)}</span>`;
    else h += `<br><small>候車 ${m(g.waitS)} 分 ${T(g.waitSrc)}　上車 ${fmtClock(g.boardAt)}${g.plate ? '（' + esc(g.plate) + '）' : ''}<br>乘車 ${m(g.rideS)} 分 ${T(g.rideSrc)}　下車 ${fmtClock(g.alightAt)}</small>`;
    if (g.eta.uid) h += `<br><small style="color:#64748b">配對：TDX「${esc(g.eta.name || '')}」(${esc(g.eta.uid)}) 站序 ${g.eta.seq}，方向 ${g.eta.dir}${g.eta.dest ? '，往 ' + esc(g.eta.dest) : ''}${g.eta.countdown != null ? '，還有 ' + g.eta.countdown + ' 站' : ''}</small>`;
    h += `<br><small style="color:#64748b">ETA 狀態：${esc(g.eta.text)}${g.eta.updMs ? '（更新 ' + fmtClockS(g.eta.updMs) + '）' : ''}${g.deps.length ? '｜預定發車：' + g.deps.map(fmtClock).join('、') : ''}</small>`;
    for (const n of g.notes) h += `<br><small style="color:#b45309">⚠ ${esc(n)}</small>`;
    h += '</div>';
  }
  if (isFinite(L.updatedAt)) h += `<div style="font-size:11px;color:#64748b;margin-top:4px">資料更新：${fmtClockS(L.updatedAt)}（最舊一筆）。標示「系統推估」者不是即時資訊。</div>`;
  return box(h);
}

export async function runTT(force) {
  const box = document.getElementById('ttBox');
  if (!State.bus || !State.bus.x || !State.fromPoint || !State.toPoint) { box.innerHTML = '<div class="rt na">請先載入公車資料並設定起點、終點</div>'; return; }
  if (!(TDX.proxy || (TDX.apiKey && TDX.tokenUrl))) { box.innerHTML = '<div class="rt na">時刻表搜尋需要 TDX 設定（Token 端點與金鑰）</div>'; return; }
  box.innerHTML = '<div class="rt na">正在取得時刻表並搜尋…</div>';
  try {
    const algo = document.getElementById('ttAlgo').value, res = await ttSearch(algo, force);
    const [fx, fy] = ptXY(State.fromPoint), [tx, ty] = ptXY(State.toPoint);
    const mt = res.net.metro || { n: 0 };
    let h = `<div class="rt" style="cursor:default"><b>⏱ ${algo === 'csa' ? 'CSA' : 'RAPTOR'}</b>（公車：預定時刻表；納入 ${res.net.labels.length} 條路線、${res.net.pats.length} 個行駛方向，${Math.round(res.ms)} ms）` +
      (mt.n ? `<br><small>🚇 捷運 ${mt.n} 個方向以班距納入（班距：${esc(mt.freqSrc)}；首末班：${mt.hoursKnown ? 'TDX' : '沒有資料，未判斷是否已收班'}）</small>` : '');
    if (res.net.errors.length) h += `<br><small style="color:#b45309">⚠ 部分路線時刻表取得失敗：${esc([...new Set(res.net.errors)].join('、'))}</small>`;
    if (!res.js.length) h += `<br><small>${res.net.errors.length && !res.net.pats.length ? '無法取得時刻表，所以沒辦法搜尋（見上方錯誤）' : res.nOrig && res.nTarg ? '在這些路線的時刻表中找不到可搭乘的方案（可能已過末班或今日未營運）' : '起點或終點附近沒有可對應到時刻表的站牌'}</small></div>`;
    else {
      for (const j of res.js) {
        const rides = j.legs.filter(l => l.type === 'ride');
        h += `<div style="margin-top:6px;border-top:1px dashed #e2e8f0;padding-top:4px"><b>轉乘 ${rides.length - 1} 次</b> · 抵達 ${fmtClock(j.arriveMs)}（共 ${Math.round((j.arriveMs - res.dep) / 60000)} 分）<small>` +
          rides.map(l => `<br>${l.metro ? '🚇 ' : '🚌 '}${esc(l.label)} ${esc(State.bus.names[l.board])} ${fmtClock(l.dep)} → ${esc(State.bus.names[l.alight])} ${fmtClock(l.arr)}${l.stops ? `（${l.stops} 站）` : ''} ` +
            (l.est ? `<span style="font-size:10px;padding:0 4px;border-radius:3px;background:#f59e0b;color:#fff" title="${esc(l.src || '')}">班距推估</span>` : `<span style="font-size:10px;padding:0 4px;border-radius:3px;background:#2563eb;color:#fff">預定時刻</span>`)).join('') + '</small></div>';
      }
      if (res.later.length) h += `<div style="margin-top:6px;border-top:1px dashed #e2e8f0;padding-top:4px"><b>較晚出發的選項</b><small>` + res.later.map(j => { const rd = j.legs.filter(l => l.type === 'ride'); return `<br>${fmtClock(rd[0].dep)} 上車 · 轉乘 ${rd.length - 1} 次 · 抵達 ${fmtClock(j.arriveMs)}：${rd.map(l => esc(l.label)).join(' → ')}`; }).join('') + '</small></div>';
      h += '</div>';
      const best = res.js[res.js.length - 1];                                  // 最早抵達者：再疊上即時 ETA（ETA 優先）與狀態判斷
      const live = await annotateJourney(journeyToSug(res.net, best, fx, fy, tx, ty), res.dep, force);
      h += `<div style="font-size:12px;color:#475569;margin:4px 0">以下為最早抵達方案疊上 ETA 後的結果：</div>` + liveHtml({ live: { state: 'done', ...live } });
    }
    box.innerHTML = h;
  } catch (err) { box.innerHTML = `<div class="rt na">時刻表搜尋失敗：${esc(err.message)}</div>`; }
}

export function showStatus(html, type) {
  const el = document.getElementById('status');
  el.innerHTML = html;
  el.className = type === 'error' ? 'error' : type === 'loading' ? 'loading' : '';
  el.style.display = 'block';
}

// 速限與預估時間（依車種）：速限資料缺漏的部分是依道路類別推估，所以要同時顯示資料覆蓋率
function speedRows(it) {
  const st = limitStats(it.route), veh = VEHICLES[it.veh || 'bus'];
  return [['速限（資料）', st.cov > 0 ? `平均 ${Math.round(st.avg)} · 最高 ${st.max} km/h；資料覆蓋 ${Math.round(st.cov * 100)}%（其餘依類別推估）` : '資料沒有速限（時間依類別推估）'],
          [`預估行駛時間（${veh.label}）`, it.min != null ? `${it.min.toFixed(1)} 分${it.veh ? '' : '（依路名推估）'}（未含壅塞、收費）` : '—']];
}
