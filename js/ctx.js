// ctx.js — 查詢參數的來源
// 瀏覽器：讀表單欄位（#mode、#goal…）。伺服器：沒有 DOM，用 withQuery({...}, fn) 在同步執行 fn 的期間提供參數。
// 路線搜尋全程是同步的，所以同一時間只會有一組參數生效，多個請求不會互相干擾。
let cur = null;
export const hasDom = () => typeof document !== 'undefined' && !!document.getElementById;
export function withQuery(q, fn) { const prev = cur; cur = q; try { return fn(); } finally { cur = prev; } }
export function qv(id, def = '') {
  if (cur) return id in cur && cur[id] != null ? String(cur[id]) : String(def);
  if (!hasDom()) return String(def); const e = document.getElementById(id); return e && e.value != null ? e.value : String(def);
}
export function qc(id, def = false) {
  if (cur) return id in cur ? !!cur[id] && cur[id] !== '0' && cur[id] !== 'false' : def;
  if (!hasDom()) return def; const e = document.getElementById(id); return e ? !!e.checked : def;
}
const NULL_EL = { textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} } };
export const uiEl = id => (hasDom() && document.getElementById(id)) || NULL_EL;      // 只用來顯示狀態文字；伺服器上寫入會被忽略
