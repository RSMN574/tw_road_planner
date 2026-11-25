// ui-panels.js — 路線清單、逐步指示、路線分析、道路資訊、狀態列（v1.18：只有全台 OSM 路線；舊路網的公車建議、時刻表搜尋、站點建議、適宜性評分已移除）
import { State } from './state.js';
import { esc, fmtDist } from './util.js';
import { generateManeuvers } from './analysis.js';
import { clientToWorld, scheduleRender } from './render-core.js';
import { osmAnalysisRows, osmInspect } from './osm.js';

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
  renderRouteList(); renderSteps(); renderAnalysis(); scheduleRender();
}

export function stepColor(s) {
  return s.turnType === 'ferry' ? '#0891b2' : s.turnType === 'uturn' ? '#7c3aed' : s.dir === 'left' ? '#2563eb' : s.dir === 'right' ? '#dc2626' : '#64748b';
}

export function stepText(s) {
  if (s.turnType === 'start')  return `起點：從 ${esc(s.roadName || '起點')} 出發`;
  if (s.turnType === 'arrive') return `${fmtDist(s.distanceFromPrev)} 抵達：${esc(s.roadName || '終點')}`;
  if (s.turnType === 'waypoint') return `${fmtDist(s.distanceFromPrev)} 📍 途經點 ${s.wp || ''}：${esc(s.roadName || '')}`;
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

// 路線清單的附註：轉彎數、國道（收費）長度、資料備註
export function metricsHtml(it) {
  let h = `<br><small>轉彎 ${it.turns ?? 0} 次` + (it.toll > 0 ? ` · 含國道 ${(it.toll / 1000).toFixed(1)} km（收費路段，費用未計算）` : '') + `</small>`;
  if (it.note) h += `<br><small style="color:#b45309">${esc(it.note)}</small>`;
  return h;
}

// 點地圖查道路資訊：問伺服器（OSM）
export function inspectAt(sx, sy) { const [wx, wy] = clientToWorld(sx, sy); osmInspect(wx, wy, document.getElementById('roadInfo')); }

export function renderAnalysis() {
  const box = document.getElementById('analysisBox'), it = State.routeSet.find(x => x.key === State.activeKey && x.route);
  if (!it || !State.currentRoute) { box.innerHTML = ''; return; }
  box.innerHTML = `<div style="font-size:13px;font-weight:600;margin:14px 0 4px;color:#334155">路線分析</div><table style="font-size:12px;width:100%;border-collapse:collapse">` +
    osmAnalysisRows(it).map(([a, b]) => `<tr><td style="color:#64748b;padding:2px 6px 2px 0;white-space:nowrap;vertical-align:top">${esc(a)}</td><td>${esc(b)}</td></tr>`).join('') + '</table>';
}

export function showStatus(html, type) {
  const el = document.getElementById('status');
  el.innerHTML = html;
  el.className = type === 'error' ? 'error' : type === 'loading' ? 'loading' : '';
  el.style.display = 'block';
}
