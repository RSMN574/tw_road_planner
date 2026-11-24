// ui-icons.js — 自繪圖示（v1.12）：簡單幾何線條 SVG，24×24、線寬 2、顏色跟隨文字（currentColor）
// 全部是本專案自己畫的，不取自任何圖標庫或第三方導航 App（避免授權問題）。
// 打包會合併模組：頂層名稱用 ic 前綴
const IC_P = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5 20 20',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6',
  layers: 'M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5',
  event: 'M12 3 2.5 20h19L12 3zM12 10v4.5M12 17.2v.3',
  cube: 'M12 3 4 7v10l8 4 8-4V7l-8-4zM4 7l8 4 8-4M12 11v10',
  north: 'M12 3 7 20l5-4 5 4-5-17z',
  locate: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3',
  plus: 'M12 5v14M5 12h14', minus: 'M5 12h14',
  home: 'M4 11 12 4l8 7M6 10v10h12V10M10 20v-5h4v5',
  work: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  swap: 'M7 4v16M4 7l3-3 3 3M17 20V4M14 17l3 3 3-3',
  car: 'M5 16V11l2-5h10l2 5v5M5 16h14M5 16v2M19 16v2M7.5 13.5h.01M16.5 13.5h.01M5 11h14',
  moto: 'M5 17a3 3 0 1 0 0-.01M19 17a3 3 0 1 0 0-.01M5 17l4-7h5l2 4h3M12 10l-1-3h3',
  bike: 'M5.5 17a3.5 3.5 0 1 0 0-.01M18.5 17a3.5 3.5 0 1 0 0-.01M5.5 17 9 9h6l3.5 8M9 9l3 8h-6.5M14 6h2',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-.01M10 21l2-6 3 3v3M9 12l2-4 3 1 2 3M12 15l-1-4',
  transit: 'M7 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM5 11h14M8 21l2-4M16 21l-2-4M8.5 14h.01M15.5 14h.01',
  close: 'M6 6l12 12M18 6 6 18', more: 'M5 12h.01M12 12h.01M19 12h.01',
  route: 'M6 19a2 2 0 1 0 0-.01M18 5a2 2 0 1 0 0-.01M6 17V9a4 4 0 0 1 4-4h2M18 7v8a4 4 0 0 1-4 4h-2',
  light: 'M9 3h6v18H9zM12 7h.01M12 12h.01M12 17h.01',
  toll: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9.5c0-1.2 1.3-2 3-2s3 .8 3 2-1.3 1.7-3 2-3 .8-3 2 1.3 2 3 2 3-.8 3-2M12 6v1.5M12 16.5V18',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z', sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  // 轉向（車頭朝上）
  t_straight: 'M12 20V4M6 10l6-6 6 6',
  t_left: 'M17 20v-8a3 3 0 0 0-3-3H5M9 4.5 4.5 9 9 13.5', t_right: 'M7 20v-8a3 3 0 0 1 3-3h9M15 4.5 19.5 9 15 13.5',
  t_slight_left: 'M15 20v-7L8 6M7 11V5h6', t_slight_right: 'M9 20v-7l7-7M17 11V5h-6',
  t_sharp_left: 'M16 4v9a4 4 0 0 1-4 4H6M6 11v6h6', t_sharp_right: 'M8 4v9a4 4 0 0 0 4 4h6M18 11v6h-6',
  t_uturn: 'M8 20V9a4 4 0 0 1 8 0v4M12.5 9.5 16 13l3.5-3.5', t_arrive: 'M6 21V4M6 4h11l-2 4 2 4H6', t_ferry: 'M3 17c2 2 4 2 6 0s4-2 6 0 4 2 6 0M5 14l1-5h12l1 5M12 4v5',
  warn: 'M12 3 2.5 20h19L12 3zM12 10v4.5M12 17.2v.3',
  // 店家地點類別（v1.13）
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  food: 'M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M16 3c-2 0-3 2.5-3 6h3v12M16 3v18',
  cafe: 'M4 9h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9zM17 10h1.5a2.5 2.5 0 0 1 0 5H17M8 3v3M12 3v3',
  store: 'M4 9l1.5-5h13L20 9M4 9h16M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 11v9h14v-9M10 20v-5h4v5',
  cart: 'M3 4h2l2.4 11h10.2L20 7H6.2M9 20a1 1 0 1 0 0-.01M17 20a1 1 0 1 0 0-.01',
  fuel: 'M5 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h14M5 10h10M15 8l3 3v6a1.5 1.5 0 0 0 3 0V9l-3-3',
  parking: 'M5 3h14v18H5zM10 17V7h3a3 3 0 0 1 0 6h-3',
  bank: 'M3 9l9-5 9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18',
  health: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v8M8 12h8',
  pill: 'M9.5 4.5a4.2 4.2 0 0 1 6 6l-5 5a4.2 4.2 0 0 1-6-6l5-5zM7 7l6 6',
  bed: 'M3 19V6M3 14h18v5M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5a1.5 1.5 0 1 0 0-.01',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  park: 'M12 21v-6M12 3 6 12h3l-3 4h12l-3-4h3l-6-9z',
  school: 'M2 9l10-5 10 5-10 5L2 9zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6',
  temple: 'M3 8h18L12 3 3 8zM5 8v2h14V8M7 10v9M17 10v9M3 21h18M10 21v-5h4v5',
  toilet: 'M7 5a1.5 1.5 0 1 0 0-.01M17 5a1.5 1.5 0 1 0 0-.01M5 21v-6H4l1.5-6h3L10 15H9v6M15 21V9h4v6h-1v6M12 3v18',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  flag: 'M6 21V4M6 4h11l-2 4 2 4H6'
};
export function icon(name, size = 24, extra = '') {
  const d = IC_P[name] || IC_P.more;
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}><path d="${d}"/></svg>`;
}
// 導航步驟 → 轉向圖示名稱
export function turnIcon(st) {
  if (!st) return 't_straight';
  if (st.turnType === 'arrive') return 't_arrive'; if (st.turnType === 'ferry') return 't_ferry'; if (st.turnType === 'uturn') return 't_uturn';
  const L = st.dir === 'left'; if (st.turnType === 'sharp') return L ? 't_sharp_left' : 't_sharp_right'; if (st.turnType === 'turn') return L ? 't_left' : 't_right'; if (st.turnType === 'slight') return L ? 't_slight_left' : 't_slight_right';
  return 't_straight';
}
export const ICON_NAMES = Object.keys(IC_P);
