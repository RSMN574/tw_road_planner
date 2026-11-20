// eta-params.js — 行程時間模型的參數表（網頁導航 ETA 與伺服器 OSM 路線搜尋共用，兩邊算出的時間才會一致）
// 所有數字都是「基礎模型假設」，沒有即時路況；有真實行程紀錄後可用 tools/eta-eval.mjs 驗證與調整
// CLS（道路類別）：0 未知、1 一般、2 主要、3 次要、4 巷弄、5 自行車道、6 步行道、7 特殊、8 國道、9 快速道路
// 平均速度 ÷ 速限（依 CLS：未知、一般、主要、次要、巷弄、自行車道、步行道、特殊、國道、快速道路）
export const FLOW = {
  car:   [0.62, 0.65, 0.72, 0.62, 0.50, 0.60, 0.60, 0.60, 0.88, 0.82],
  heavy: [0.64, 0.67, 0.74, 0.64, 0.52, 0.60, 0.60, 0.60, 0.86, 0.82],
  moto:  [0.70, 0.72, 0.78, 0.70, 0.60, 0.70, 0.70, 0.65, 0.85, 0.85],
  bus:   [0.55, 0.58, 0.64, 0.55, 0.45, 0.50, 0.50, 0.50, 0.80, 0.75],
  bike:  [0.85, 0.85, 0.85, 0.85, 0.80, 0.95, 0.80, 0.80, 0.85, 0.85],
  walk:  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
};
// 路口預期等待（秒）：四岔以上（多半有號誌）／三岔；轉向延遲（台灣靠右行駛：左轉較久）
export const DELAY = {
  car:   { j4: 12, j3: 5, left: 14, right: 6, slightL: 4, slightR: 3, sharpL: 16, sharpR: 8, uturn: 25 },
  heavy: { j4: 12, j3: 5, left: 14, right: 6, slightL: 4, slightR: 3, sharpL: 16, sharpR: 8, uturn: 25 },
  moto:  { j4: 10, j3: 4, left: 18, right: 5, slightL: 3, slightR: 2, sharpL: 18, sharpR: 6, uturn: 20 },   // 機車左轉多為兩段式
  bus:   { j4: 14, j3: 6, left: 16, right: 8, slightL: 5, slightR: 4, sharpL: 18, sharpR: 10, uturn: 30 },
  bike:  { j4: 10, j3: 4, left: 10, right: 3, slightL: 2, slightR: 1, sharpL: 10, sharpR: 4, uturn: 10 },
  walk:  { j4: 15, j3: 6, left: 0, right: 0, slightL: 0, slightR: 0, sharpL: 0, sharpR: 0, uturn: 0 }
};
export const CV = [0.3, 0.3, 0.28, 0.3, 0.35, 0.2, 0.15, 0.3, 0.15, 0.18];      // 路段時間變異係數（依 CLS）

