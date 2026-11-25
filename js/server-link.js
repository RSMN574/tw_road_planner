// server-link.js — 連上「台灣通伺服器」（server/server.mjs）：讀 api/v1/health，伺服器的全台 OSM 道路圖好了就啟用
// v1.18：網頁一定要由伺服器提供（舊的本機路網、前端 TDX 代理、本機公車／捷運／YouBike 檔案都已移除；大眾運輸、即時路況、店家地點都在伺服器）
import { State } from './state.js';
import { esc } from './util.js';
import { osmAttach } from './osm.js';

const setStat = h => { const e = document.getElementById('serverStat'); if (e) e.innerHTML = h; };
export async function detectServer(fetchImpl = fetch) {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
  try { const r = await fetchImpl('api/v1/health', { cache: 'no-store' }); if (!r.ok) return null; const j = await r.json(); return j && j.ok ? j.data : null; } catch { return null; }
}
export function init() { return linkServer(); }
async function waitOsm(fetchImpl, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const h = await detectServer(fetchImpl); if (!h || !h.osm) return;
    if (h.osm.loaded) { osmAttach(h.osm); setStat(`🖥 已連線伺服器 v${esc(h.version)}<br>全台 OSM 道路圖 ✓`); return; }
    if (!h.osm.loading) { setStat(`🖥 已連線伺服器 v${esc(h.version)}<br>⚠ 伺服器沒有載入全台 OSM 道路圖：${esc(h.osm.reason || '')}`); return; }
  }
}
export async function linkServer(fetchImpl = fetch) {
  const h = await detectServer(fetchImpl);
  if (!h) {                                                                                // 用 file:// 或一般靜態主機開啟：沒有伺服器就不能規劃
    const ph = document.getElementById('placeholder'); if (ph) ph.innerHTML = '<p>這個網頁需要由台灣通伺服器提供（<code>npm start</code> 後開 http://localhost:8080）。路線、大眾運輸、店家搜尋都在伺服器計算。</p>';
    return null;
  }
  State.server = h;
  if (h.osm && h.osm.loaded) { osmAttach(h.osm); setStat(`🖥 已連線伺服器 v${esc(h.version)}<br>全台 OSM 道路圖 ✓（${(h.osm.vertices || 0).toLocaleString()} 個路口／端點）`); }
  else if (h.osm && h.osm.loading) { setStat(`🖥 已連線伺服器 v${esc(h.version)}<br>全台 OSM 道路圖載入中…`); waitOsm(fetchImpl); }
  else setStat(`🖥 已連線伺服器 v${esc(h.version)}<br>⚠ 伺服器沒有載入全台 OSM 道路圖${h.osm && h.osm.reason ? '：' + esc(h.osm.reason) : ''}`);
  return h;
}
