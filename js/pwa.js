// pwa.js — PWA：Service Worker 註冊、離線提示、加入主畫面、深色／淺色主題
// Service Worker 需要 HTTPS（或 localhost）；用 file:// 直接開啟時只會略過，其餘功能不受影響。
// v1.12：主題三態——'auto'（跟隨系統；導航中另依日出日落，見 ui-shell.js）、'light'、'dark'；變更時發出 themechange 事件（地圖重畫）
const byId = id => document.getElementById(id);
const pwaStore = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
let pwaNight = null;                                                         // 導航中的日夜判斷（null＝不使用）

export const themePref = () => pwaStore.get('theme') || 'auto';
export function setThemePref(p) { pwaStore.set('theme', p === 'auto' ? '' : p); return applyTheme(p === 'auto' ? null : p); }
export function setNightHint(v) { pwaNight = v; return applyTheme(themePref() === 'auto' ? null : themePref()); }
export function applyTheme(t) {                                              // t：'dark' | 'light' | null（跟隨系統）
  const sys = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = t ? t === 'dark' : (pwaNight != null ? pwaNight : sys);
  const prev = document.documentElement.dataset.theme, now = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = now;
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#0e1116' : '#1a73e8';
  if (prev && prev !== now && typeof CustomEvent !== 'undefined' && document.dispatchEvent) document.dispatchEvent(new CustomEvent('themechange', { detail: now }));
  return now;
}
export function init() {
  applyTheme(pwaStore.get('theme') || null);
  byId('themeBtn')?.addEventListener('click', e => { e.stopPropagation(); setThemePref(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); });
  if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!pwaStore.get('theme')) applyTheme(null); });
  const sync = () => { const off = typeof navigator !== 'undefined' && navigator.onLine === false; const bar = byId('offlineBar'); if (bar) bar.hidden = !off; };
  window.addEventListener('online', sync); window.addEventListener('offline', sync); sync();
  // 手機面板的收合／拖拽改由 ui-shell.js 處理（底部可拖拽面板）
  // 加入主畫面（Android Chrome 的安裝提示；iOS 要用「分享 → 加入主畫面」）
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; const b = byId('installBtn'); if (b) b.hidden = false; });
  byId('installBtn')?.addEventListener('click', async e => { e.stopPropagation(); if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch {} deferred = null; byId('installBtn').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker 註冊失敗：', e && e.message));
}
