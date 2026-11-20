// server-link.js — 網頁由「台灣通伺服器」（server/server.mjs）提供時的自動設定
// ・讀 api/v1/health：伺服器有 TDX 金鑰 → 自動改用內建代理（金鑰只在伺服器，不經過瀏覽器）
// ・伺服器上有道路屬性表／公車／捷運／YouBike → 自動載入（預設路徑網頁本來就會抓；自訂檔名時這裡補抓）
// 用 file:// 或一般靜態主機開啟時，這裡什麼都不做，網頁照原本的方式運作。
import { State } from './state.js';
import { TDX } from './tdx.js';
import { loadRoadTable } from './road-attrs.js';
import { loadBus, loadMetro } from './transit.js';
import { loadUbike } from './ubike.js';
import { esc } from './util.js';
import { osmAttach } from './osm.js';

const setStat = h => { const e = document.getElementById('serverStat'); if (e) e.innerHTML = h; };
export async function detectServer(fetchImpl = fetch) {
  if (typeof location === 'undefined' || !/^https?:$/.test(location.protocol)) return null;
  try { const r = await fetchImpl('api/v1/health', { cache: 'no-store' }); if (!r.ok) return null; const j = await r.json(); return j && j.ok ? j.data : null; } catch { return null; }
}
// 網頁本來就會自動抓這些固定路徑（見 road-attrs／transit／ubike 的 init）；伺服器用了不同檔名時才需要這裡補抓
const DEFAULT_FILES = { roadTable: 'data/road-attrs.json', bus: 'data/bus/graph.json', metro: 'data/metro.json', youbike: 'data/ubike.json' };
export function init() { return linkServer(); }
async function waitOsm(fetchImpl, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const h = await detectServer(fetchImpl); if (!h || !h.osm) return;
    if (h.osm.loaded) { osmAttach(h.osm); const e = document.getElementById('serverStat'); if (e) e.innerHTML = e.innerHTML.replace('全台 OSM 道路圖載入中…', '全台 OSM 道路圖 ✓'); return; }
    if (!h.osm.loading) return;
  }
}
export async function linkServer(fetchImpl = fetch) {
  const h = await detectServer(fetchImpl); if (!h) return null;
  State.server = h; const notes = [];
  // 全台 OSM 道路圖：伺服器在背景載入（約幾秒），還沒好就稍後再問
  if (h.osm && h.osm.loaded) { osmAttach(h.osm); notes.push(`全台 OSM 道路圖 ✓（${(h.osm.vertices || 0).toLocaleString()} 個路口／端點）`); }
  else if (h.osm && h.osm.loading) { notes.push('全台 OSM 道路圖載入中…'); waitOsm(fetchImpl); }
  if (h.tdx && h.tdx.configured && !TDX.proxy) {
    TDX.proxy = new URL(h.tdx.proxyBase || 'tdx', location.href).href.replace(/\/+$/, '');
    const inp = document.getElementById('tdxProxy'); if (inp) inp.value = TDX.proxy;
    notes.push('TDX 即時資料：使用伺服器內建代理');
  }
  const jobs = [['roadTable', '道路屬性表', loadRoadTable], ['metro', '捷運', loadMetro], ['bus', '公車', loadBus], ['youbike', 'YouBike', loadUbike]];
  for (const [k, label, fn] of jobs) {
    const f = h.files && h.files[k]; if (!f) continue;
    if (f === DEFAULT_FILES[k]) { notes.push(`${label} ✓`); continue; }
    try { const r = await fetchImpl(f, { cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); fn(await r.json()); notes.push(`${label} ✓`); }
    catch (e) { notes.push(`${label} 載入失敗（${esc(e.message)}）`); }
  }
  setStat(`🖥 已連線伺服器 v${esc(h.version)}${h.graph ? `（路網 ${h.graph.nodes.toLocaleString()} 節點）` : ''}<br>${notes.join('、') || '伺服器沒有提供額外資料'}`);
  return h;
}
