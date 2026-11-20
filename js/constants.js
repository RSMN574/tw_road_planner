// constants.js

// string edgeId → Set<道路名>

export const DATA_BASE = './data/graph/';

export const REQUIRED_FILES = ['nodes.json', 'edges.json', 'roads.json'];

// ============================================================
// 規劃
// ============================================================
// ============================================================
// 三條候選路線
// ============================================================

export const MODES = [
  { key: 'shortest', label: '最短', color: '#f59e0b' },
  { key: 'fastest',  label: '最快', color: '#16a34a' },
  { key: 'pref',     label: '依偏好', color: '#7c3aed' },
  { key: 'avoid',    label: '避開', color: '#2563eb' }
];

// 資料沒有道路等級 → 依路名推估（km/h）：快速/大道 50、路 40、巷弄 20、其他 30

export const speedCache = new Map();

// ============================================================
// 分段 hover tooltip / 點擊高亮整條同名道路
// ============================================================

export const hlCache = new Map();

export const nearbyCache = { key: null, arr: null };

export const NEARBY_FRAC = 0.15;

// 走廊寬度 ≈ 路線外框較長邊的 15%（約 1～2 倍此值）

export const NEARBY_MAX_EDGES = 80000;

// ============================================================
// 公車系統：載入 graph.json → 轉 TWD97 → 路線外的公車建議（含轉乘）
// ============================================================

export const WALK_MPS = 1.2, WALK_MAX_M = 500, BOARD_WAIT_S = 300, TRANSFER_S = 300, GROUP_WALK_S = 90, BUS_MPS = 5.56;
// 捷運（metro.json 只有站點，沒有班距／行駛時間／時刻表，以下都是「假設」，介面上一律標示為系統推估）
export const METRO_HEADWAY_S = 480, METRO_WAIT_S = METRO_HEADWAY_S / 2, METRO_MPS = 9.7, METRO_DWELL_S = 30, METRO_CURVE = 1.15, MRT_TRANSFER_M = 150;
// 捷運轉乘（系統推估，介面一律標示）：進出站（街道 ↔ 月台，含閘門、電扶梯）、跨線換月台；候選範圍是「直線距離」，實際步行距離另由道路圖計算
export const METRO_ACCESS_S = 90, METRO_PLATFORM_S = 120, METRO_XFER_R = 300, METRO_LINE_XFER_R = 300, WALK_NET_MAX_M = 900, WALK_DETOUR = 1.4;
export const LINE_NAME = { G: '捷運綠線' };

export const MAX_BUS_OPTS = 8;
// YouBike 接駁（大眾運輸的第一／最後一哩）：全部是假設值，結果一律標示「推估」；可借車輛與空位沒有即時資料
export const YB_WALK_M = 400, YB_DOCK_M = 250, YB_RENT_S = 60, YB_RETURN_S = 60, YB_MAX_S = 900, YB_MIN_M = 500, YB_STOPS = 14;

export const CLS = { unknown: 0, general: 1, major: 2, minor: 3, alley: 4, bike: 5, walk: 6, other: 7, freeway: 8, expressway: 9 };

export const CLS_LABEL = ['未知', '一般道路', '主要道路', '次要道路', '巷弄', '自行車專用道', '步行專用道', '特殊道路', '國道', '快速道路'];

export const COS30 = Math.cos(Math.PI / 6);

// ============================================================
// 道路吸附 / 公車段沿道路 / 階段 5：寬度圖層、道路查詢、分析面板
// ============================================================

export const SNAP_MAX_M = 60, ALGO = { dijkstra: 'Dijkstra', astar: 'A*', bidir: '雙向 Dijkstra', mlevel: '多層級 Dijkstra（近似）' }, legCache = new Map();

// ---- 道路寬度分級圖層：只畫視窗內的邊；格子太多（縮太小）就提示放大 ----

export const WCOL = { a: '#166534', b: '#65a30d', c: '#f59e0b', d: '#ef4444', u: '#9ca3af', f: '#7c3aed' };

export const KIND_ETA = 'EstimatedTimeOfArrival', KIND_TT = 'DailyStopTimeTable', tdxCache = new Map(), tdxInflight = new Map();

export const STOP_TEXT = { 1: '尚未發車', 2: '交管不停靠', 3: '末班車已過', 4: '今日未營運' };

export const PAL = ['#f59e0b', '#16a34a', '#2563eb', '#7c3aed', '#ef4444', '#0891b2', '#a16207', '#be185d'], DASH = ['', '10 5', '2 6', '14 4 3 4', '6 6', '', '10 5', '2 6'];

// ============================================================
// RAPTOR／CSA：以 DailyStopTimeTable 的「預定時刻」搜尋；搜尋後再用 annotateJourney 疊上即時 ETA（ETA 優先）
// ============================================================

export const TT_BUF_MS = 60e3;
