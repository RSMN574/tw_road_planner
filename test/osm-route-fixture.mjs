// osm-route-fixture.mjs — 合成的「伺服器 OSM 路線」（v1.18：舊的本機路網移除後，導航測試改用這個）
// 欄位與 server/osm/router.mjs 的 describe() 相同：geometry（[lon, lat]）、distanceM、steps、ways、timing（segS／segCls／segKnown／segWay／delays），
// 再交給網頁真正使用的 osmRouteObj() 轉成 route 物件——導航引擎、ETA 模型、RouteTrack 吃到的跟實際規劃完全同一種格式。
// 每段時間與路口延遲照伺服器的公式（server/osm/router.mjs：速限 × FLOW[運具][道路類別]、號誌路口 j4、轉向延遲），參數表與伺服器共用（js/eta-params.js）。
// 這裡的道路、速限、號誌都是測試假設（格子城市：內部的十字路口都有號誌），不是真實資料。
import { osmRouteObj } from '../js/osm.js';
import { FLOW, DELAY } from '../js/eta-params.js';

const CAP = { car: Infinity, heavy: Infinity, moto: 50, bike: 18, walk: 4.5 };      // 與 server/osm/router.mjs 的 PROFILE_SPEED 相同

// 格子城市：n×n 個路口，(i, j) 在 (i·sp, j·sp) 公尺；每 4 條是主要道路（50 km/h），第 2、6… 條是次要道路（30），其餘一般道路（40）；道路類別照 server/osm/router.mjs 的 clsOf
export function gridCity({ LON0 = 120.62, LAT0 = 24.13, sp = 250, n = 14, uniform = null } = {}) {   // uniform：{ kmh, cls }＝每條路都一樣
  const mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180);
  const ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
  const kind = v => (v % 4 === 0 ? 'A' : v % 4 === 2 ? 'C' : 'B');
  const SPEC = { A: { kmh: 50, cls: 2, hw: 'primary' }, B: { kmh: 40, cls: 1, hw: 'tertiary' }, C: { kmh: 30, cls: 3, hw: 'secondary' } };
  const roadOf = (a, b) => { const h = a[1] === b[1], v = h ? a[1] : a[0], k = kind(v); return { name: `${h ? '東西' : '南北'}${k}${v}路`, id: (h ? 1000 : 2000) + v, ...SPEC[k], ...(uniform || {}) }; };
  const id = (i, j) => `n${i}_${j}`, parse = s => { const m = /n(\d+)_(\d+)/.exec(s); return [+m[1], +m[2]]; };
  // 路口的岔路數（格子邊緣 3、角落 2、內部 4）
  const deg = ([i, j]) => (Number.isInteger(i) && Number.isInteger(j) ? (i > 0) + (i < n - 1) + (j > 0) + (j < n - 1) : 2);
  // 曼哈頓路線（依轉折點，先東西再南北）→ 路口序列
  const manhattan = pts => { const out = []; for (let p = 0; p < pts.length - 1; p++) { let [i, j] = pts[p]; const [I, J] = pts[p + 1]; if (!out.length) out.push([i, j]); while (i !== I) { i += Math.sign(I - i); out.push([i, j]); } while (j !== J) { j += Math.sign(J - j); out.push([i, j]); } } return out; };
  const kmhOf = (vk, r) => (vk === 'walk' ? CAP.walk : Math.min(CAP[vk] ?? Infinity, r.kmh) * (FLOW[vk][r.cls] ?? FLOW[vk][0]));
  // 經過路口的延遲（秒）：伺服器 turnS 的格子版——十字路口有號誌（j4），三岔路口轉彎才加 j3，再加轉向延遲
  const junctionS = (vk, nd, dir) => { const D = DELAY[vk], g = deg(nd); let d = g >= 4 ? D.j4 : 0; if (dir && g >= 3) { if (!d) d += D.j3; d += dir === 'left' ? D.left : D.right; } return d; };
  // 路口序列（可以有小數座標＝路段中間，例如重新規劃時的目前位置）→ 伺服器格式的路線；每約 50 m 一個座標點（像真實 OSM 的中間節點）
  function serverRoute(nodes, { key = 'fastest', vk = 'car', step = 50 } = {}) {
    const geometry = [], segS = [], segCls = [], segKnown = [], segWay = [], delays = [], ways = [], steps = [];
    let dist = 0, since = 0;
    geometry.push(ll(nodes[0][0] * sp, nodes[0][1] * sp));
    for (let k = 0; k < nodes.length - 1; k++) {
      const a = nodes[k], b = nodes[k + 1], r = roadOf(a, b), Lab = Math.hypot(b[0] - a[0], b[1] - a[1]) * sp, cnt = Math.max(1, Math.round(Lab / step));
      if (!ways.length || ways[ways.length - 1].id !== r.id) ways.push({ id: r.id, name: r.name, ref: '', highway: r.hw, m: 0, limitKmh: r.kmh, limitSrc: 'tag' });
      const wi = ways.length - 1;
      if (k === 0) steps.push({ index: 0, type: 'start', dir: '', road: r.name, angle: 0, fromStartM: 0, distanceFromPrev: 0 });
      else {                                                                                  // 路口：轉向
        const p = nodes[k - 1], d1 = [a[0] - p[0], a[1] - p[1]], d2 = [b[0] - a[0], b[1] - a[1]], cr = d1[0] * d2[1] - d1[1] * d2[0];
        const dir = cr > 0 ? 'left' : cr < 0 ? 'right' : '', at = geometry.length - 1;
        if (dir || roadOf(p, a).name !== r.name) { steps.push({ index: at, type: dir ? 'turn' : 'straight', dir, road: r.name, angle: cr > 0 ? -90 : cr < 0 ? 90 : 0, fromStartM: Math.round(dist), distanceFromPrev: Math.round(since) }); since = 0; }
        const d = junctionS(vk, a, dir); if (d > 0) delays.push([at, d]);
      }
      const v = kmhOf(vk, r) / 3.6;
      for (let s = 1; s <= cnt; s++) {
        const f = s / cnt, L = Lab / cnt;
        geometry.push(ll((a[0] + (b[0] - a[0]) * f) * sp, (a[1] + (b[1] - a[1]) * f) * sp));
        segS.push(+(L / v).toFixed(2)); segCls.push(r.cls); segKnown.push(1); segWay.push(wi); ways[wi].m += L; dist += L; since += L;
      }
    }
    const last = nodes[nodes.length - 1], lr = roadOf(nodes[nodes.length - 2], last);
    steps.push({ index: geometry.length - 1, type: 'arrive', dir: '', road: lr.name, angle: 0, fromStartM: Math.round(dist), distanceFromPrev: Math.round(since) });
    const durationS = segS.reduce((p, q) => p + q, 0) + delays.reduce((p, [, d]) => p + d, 0);
    return { key, geometry, distanceM: Math.round(dist), durationS: Math.round(durationS), steps, ways, timing: { segS, segCls, segKnown, segWay, delays }, roads: ways.map(w => w.name), warnings: [] };
  }
  // 網頁的 route 物件（與 osm.js 規劃完成時相同）；edgePath＝每一小段的序號（舊版導航引擎的後備模型要用）
  const route = (nodes, o = {}) => { const r = osmRouteObj(serverRoute(nodes, o), '#2563eb', '最快'); r.edgePath = r._osm.timing.segS.map((_, i) => i); r.nodes = nodes; return r; };
  // 舊算法的速度（全程以速限行駛；機車上限 50、腳踏車 18、步行 4.5 km/h）：每一小段 m/s
  const freeMps = (r, vk = 'car') => k => { const w = r._osm.ways[r._osm.timing.segWay[k]]; return (vk === 'walk' ? CAP.walk : Math.min(CAP[vk] ?? Infinity, w.limitKmh)) / 3.6; };
  const metersOf = nodes => nodes.map(([i, j]) => [i * sp, j * sp]);
  return { n, sp, ll, kind, roadOf, deg, id, parse, manhattan, serverRoute, route, freeMps, metersOf, LON0, LAT0, mLat, mLon };
}

// 沿折線（公尺）走 s 公尺的位置
export function alongM(P, s) {
  let acc = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]);
    if (s <= acc + L || i === P.length - 2) { const t = Math.min(1, Math.max(0, (s - acc) / L)); return [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t]; }
    acc += L;
  }
  return P[P.length - 1];
}
export const lengthM = P => { let L = 0; for (let i = 0; i < P.length - 1; i++) L += Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); return L; };
