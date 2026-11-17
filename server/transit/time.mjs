// time.mjs — 大眾運輸時間工具。全系統一律用 Asia/Taipei（UTC+8，沒有日光節約時間），不依賴伺服器所在時區。
//
// ・「營運日」：班次時刻以「營運日 00:00 起算的秒數」表示；跨午夜的班次寫成 24:10、25:30（屬於前一個營運日）
// ・所有函式都是純函式，方便測試
export const TZ_OFFSET_MS = 8 * 3600e3, DAY_S = 86400;
export const WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// 'HH:MM' 或 'HH:MM:SS'（小時可以 ≥ 24）→ 秒；格式不對回傳 NaN（不猜測）
export function parseHms(t) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(typeof t === 'string' ? t : '');
  if (!m || +m[2] > 59 || +(m[3] || 0) > 59 || +m[1] > 47) return NaN;
  return m[1] * 3600 + m[2] * 60 + +(m[3] || 0);
}
export const fmtHms = s => Number.isFinite(s) ? `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}` : '';

// 毫秒時間戳 → 台北的日期字串 'YYYY-MM-DD'
export const dateStrOf = ms => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
// 台北某日 00:00 的毫秒時間戳
export const midnightMs = dateStr => Date.parse(dateStr + 'T00:00:00+08:00');
export const addDays = (dateStr, n) => dateStrOf(midnightMs(dateStr) + n * DAY_S * 1000 + 3600e3);
export const weekdayOf = dateStr => new Date(midnightMs(dateStr) + TZ_OFFSET_MS).getUTCDay();          // 0=週日
// 營運日秒數 → 毫秒時間戳
export const toMs = (dateStr, sec) => midnightMs(dateStr) + sec * 1000;

// TDX 的日期欄位（'2026-11-17'、'2026-11-17T00:00:00+08:00'）→ 台北日期字串；看不懂回傳 null
// 注意：'2026-11-17' 交給 Date.parse 會被當成 UTC 午夜（差 8 小時），所以純日期直接取字串，不經過 Date
export function parseDateOnly(v) {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const ms = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : v + '+08:00');                          // 沒寫時區的時間一律視為台北時間
  return Number.isFinite(ms) ? dateStrOf(ms) : null;
}
// TDX 的時間戳（UpdateTime、SrcUpdateTime…）→ 毫秒；沒寫時區視為台北時間；看不懂回傳 NaN
export function parseStamp(v) {
  if (typeof v !== 'string' || !v) return NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : v + '+08:00');
}

// TDX ServiceDay（{Sunday:0|1,…,Saturday:0|1, NationalHolidays?:0|1}）→ 7 位元遮罩（bit0=週日）；沒有這個欄位回傳 null（＝不知道適用哪幾天）
export function dayMask(sd) {
  if (!sd || typeof sd !== 'object') return null;
  let mask = 0, seen = false;
  WEEK.forEach((d, i) => { if (sd[d] !== undefined && sd[d] !== null) { seen = true; if (Number(sd[d]) === 1 || sd[d] === true) mask |= 1 << i; } });
  return seen ? mask : null;
}
// 這個班次／班距在 dateStr 這天有沒有開？遮罩為 null（資料沒說）→ 回傳 null，由呼叫端決定並標示「不確定」
export const runsOn = (mask, dateStr) => mask === null || mask === undefined ? null : !!(mask & (1 << weekdayOf(dateStr)));

// 現在這個時刻可能屬於哪些營運日：今天，以及（凌晨時）前一天的 24:xx 班次
export function serviceDatesAt(ms) {
  const today = dateStrOf(ms), sec = (ms - midnightMs(today)) / 1000;
  return sec < 6 * 3600 ? [{ date: addDays(today, -1), sec: sec + DAY_S }, { date: today, sec }] : [{ date: today, sec }];
}
