// pwa.js — PWA：Service Worker 註冊、離線提示、加入主畫面、深色／淺色主題
// Service Worker 需要 HTTPS（或 localhost）；用 file:// 直接開啟時只會略過，其餘功能不受影響。
const byId = id => document.getElementById(id);
const pwaStore = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

export function applyTheme(t) {                                              // t：'dark' | 'light' | null（跟隨系統）
  const dark = t ? t === 'dark' : (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = dark ? '#0b1220' : '#1e293b';
  return dark ? 'dark' : 'light';
}
export function init() {
  applyTheme(pwaStore.get('theme'));
  byId('themeBtn')?.addEventListener('click', e => { e.stopPropagation(); const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; pwaStore.set('theme', next); applyTheme(next); });
  if (typeof matchMedia !== 'undefined') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!pwaStore.get('theme')) applyTheme(null); });
  const sync = () => { const off = typeof navigator !== 'undefined' && navigator.onLine === false; const bar = byId('offlineBar'); if (bar) bar.hidden = !off; };
  window.addEventListener('online', sync); window.addEventListener('offline', sync); sync();
  // 手機：點標題列收合／展開面板
  const panel = byId('panel'); document.querySelector('#panel h1')?.addEventListener('click', () => { if (matchMedia('(max-width: 800px)').matches) panel.classList.toggle('collapsed'); });
  // 加入主畫面（Android Chrome 的安裝提示；iOS 要用「分享 → 加入主畫面」）
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; const b = byId('installBtn'); if (b) b.hidden = false; });
  byId('installBtn')?.addEventListener('click', async e => { e.stopPropagation(); if (!deferred) return; deferred.prompt(); try { await deferred.userChoice; } catch {} deferred = null; byId('installBtn').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(e => console.warn('Service Worker 註冊失敗：', e && e.message));
}
