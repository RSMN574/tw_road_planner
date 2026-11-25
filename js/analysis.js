// analysis.js — 路線分析（v1.18：只有伺服器的全台 OSM 路線；本機路網的適宜性評分、公車站點建議已隨舊路網移除）
import { worldHaversine } from './geo.js';

// 路名序列（相鄰相同的合併）
export function roadSeqOf(r) { const s = []; for (const n of (r._osm && r._osm.roads) || []) if (s[s.length - 1] !== n) s.push(n); return s; }
// 導航步驟：伺服器算好、osm.js 轉換成 route._man
export function generateManeuvers(route) { return route._man || []; }
// 依每段所屬的 way 路名分段（start／end 是 coords 的段號）；len 用大圓距離
export function segmentsOf(route) {
  if (route._segs) return route._segs;
  const sr = route._osm || {}, T = sr.timing || {}, sw = T.segWay || [], ll = route._ll || [], segs = [], nm = i => { const w = (sr.ways || [])[sw[i]]; return w ? (w.name || w.ref || '') : ''; };
  let cur = '', st = 0;
  for (let i = 0; i < sw.length; i++) { const n = nm(i); if (!i) cur = n; else if (n !== cur) { segs.push({ name: cur, start: st, end: i }); cur = n; st = i; } }
  if (sw.length) segs.push({ name: cur, start: st, end: sw.length });
  for (const sg of segs) { let len = 0; for (let i = sg.start; i < sg.end && ll[i + 1]; i++) len += worldHaversine(ll[i][0], ll[i][1], ll[i + 1][0], ll[i + 1][1]); sg.len = len; }
  return route._segs = segs;
}
// 轉彎數：伺服器步驟中的轉向（微轉、轉彎、急轉、迴轉）
export function countTurns(r) { return (r._man || []).filter(m => ['slight', 'turn', 'sharp', 'uturn'].includes(m.turnType)).length; }
