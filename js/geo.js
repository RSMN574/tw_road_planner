// geo.js
import { State } from './state.js';

export const isGeo = () => State.coordType === 'wgs84';

// 「權重單位 / 座標單位」的下界（校準值）


export function nodeDist(a, b) {           // 世界座標距離：projected 歐氏；wgs84 haversine（公尺）
  const x1 = State.nodeXY[a*5+2], y1 = State.nodeXY[a*5+3], x2 = State.nodeXY[b*5+2], y2 = State.nodeXY[b*5+3];
  if (!isGeo()) return Math.hypot(x2 - x1, y2 - y1);
  const R = Math.PI/180, dLat = (y2 - y1)*R, dLon = (x2 - x1)*R;
  const h = Math.sin(dLat/2)**2 + Math.cos(y1*R)*Math.cos(y2*R)*Math.sin(dLon/2)**2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// projUnit：道路圖座標 1 單位 = 幾公尺


export function lonLatToTWD97(lon, lat) {                // GRS80 / TM2 121°E（EPSG:3826），Krüger 級數
  const a = 6378137, f = 1/298.257222101, n = f/(2-f), k0 = 0.9999;
  const A = a/(1+n) * (1 + n*n/4 + n**4/64);
  const al = [n/2 - 2*n*n/3 + 5*n**3/16, 13*n*n/48 - 3*n**3/5, 61*n**3/240];
  const p = lat*Math.PI/180, l = (lon - 121)*Math.PI/180, c = 2*Math.sqrt(n)/(1+n), sp = Math.sin(p);
  const t = Math.sinh(Math.atanh(sp) - c*Math.atanh(c*sp));
  const xi = Math.atan2(t, Math.cos(l)), eta = Math.atanh(Math.sin(l)/Math.sqrt(1 + t*t));
  let E = eta, Nn = xi;
  for (let j = 1; j <= 3; j++) { E += al[j-1]*Math.cos(2*j*xi)*Math.sinh(2*j*eta); Nn += al[j-1]*Math.sin(2*j*xi)*Math.cosh(2*j*eta); }
  return [250000 + k0*A*E, k0*A*Nn];
}

// TWD97（EPSG:3826）→ WGS84 經緯度：Krüger 反算級數（與上面的正算互逆，誤差 < 1 mm）
export function twd97ToLonLat(E, N) {
  const a = 6378137, f = 1/298.257222101, n = f/(2-f), k0 = 0.9999, A = a/(1+n) * (1 + n*n/4 + n**4/64);
  const be = [n/2 - 2*n*n/3 + 37*n**3/96, n*n/48 + n**3/15, 17*n**3/480], de = [2*n - 2*n*n/3 - 2*n**3, 7*n*n/3 - 8*n**3/5, 56*n**3/15];
  const xi = N/(k0*A), eta = (E - 250000)/(k0*A); let xp = xi, ep = eta;
  for (let j = 1; j <= 3; j++) { xp -= be[j-1]*Math.sin(2*j*xi)*Math.cosh(2*j*eta); ep -= be[j-1]*Math.cos(2*j*xi)*Math.sinh(2*j*eta); }
  const chi = Math.asin(Math.sin(xp)/Math.cosh(ep)); let phi = chi;
  for (let j = 1; j <= 3; j++) phi += de[j-1]*Math.sin(2*j*chi);
  return [121 + Math.atan2(Math.sinh(ep), Math.cos(xp))*180/Math.PI, phi*180/Math.PI];
}
// 道路圖座標 → WGS84 [lon, lat]（lonLatToWorld 的反函式）
export function worldToLonLat(x, y) { return isGeo() ? [x, y] : twd97ToLonLat(x * State.projUnit, y * State.projUnit); }

export function worldDistM(x1, y1, x2, y2) {
  if (!isGeo()) return Math.hypot(x2 - x1, y2 - y1) * State.projUnit;
  const R = Math.PI/180, h = Math.sin((y2-y1)*R/2)**2 + Math.cos(y1*R)*Math.cos(y2*R)*Math.sin((x2-x1)*R/2)**2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function worldHaversine(x1, y1, x2, y2) {
  const R = Math.PI/180, h = Math.sin((y2-y1)*R/2)**2 + Math.cos(y1*R)*Math.cos(y2*R)*Math.sin((x2-x1)*R/2)**2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// 座標假設：經緯度對調？單位(m/座標單位)？TWD67 平移(公尺)

export function autoUnit() {
  let mx = 0; for (let i = 0; i < State.N; i += 997) mx = Math.max(mx, Math.abs(State.nodeXY[i*5+2]), Math.abs(State.nodeXY[i*5+3]));
  return (!isGeo() && mx > 5e7) ? 0.01 : 1;                         // 座標過大 → 單位是 cm
}

// GPS（WGS84 經緯度）→ 道路圖座標。道路圖是經緯度就直接用；是 TWD97 就轉換並除以單位（cm 資料 projUnit=0.01）
export function lonLatToWorld(lon, lat) {
  if (isGeo()) return [lon, lat];
  const [e, n] = lonLatToTWD97(lon, lat); return [e / State.projUnit, n / State.projUnit];
}
