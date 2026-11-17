// loader.js
import { State } from './state.js';
import { DATA_BASE, REQUIRED_FILES } from './constants.js';
import { buildGraphCore } from './graph-build.js';
import { fileInput, fileList, fileName, fileZone, loaderProgress, loaderText, placeholder } from './dom.js';
import { fitGraph, render, resetView } from './render-core.js';
import { setHighlight, showStatus } from './ui-panels.js';

// ============================================================
// 從分檔 JSON 建圖
//   nodes.json: [{id, lon, lat} | {id, x, y} | {id, lon, lat, ...}]
//   edges.json: [{from, to, w | length}]
//   roads.json: [{name, nodes:[id...]}] 或 [{name}] 或 ["道路名"]
// ============================================================
// ============================================================
// 改良版 buildGraph：自動偵測多種 JSON 格式
// ============================================================

export function buildGraph(input) {
  buildGraphCore(input);
  document.getElementById('stats').textContent =
    `${State.N.toLocaleString()} 節點 · ${State.E.toLocaleString()} 邊 · ${State.roadNames.length.toLocaleString()} 道路 · ${State.coordType}`;
  setHighlight(null);
  placeholder.classList.remove('hidden');
  resetView(); fitGraph(); render();
}

// ============================================================
// 自動載入分檔 JSON
// ============================================================

// 下載並回報進度（有 Content-Length 才有百分比）；回傳 ArrayBuffer
async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url, { cache: 'no-cache' });                // no-cache＝每次向伺服器確認（ETag 沒變就回 304，不重新下載）
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const total = +r.headers.get('content-length') || 0, enc = r.headers.get('content-encoding');
  if (!r.body || !r.body.getReader) return { buf: await r.arrayBuffer(), type: r.headers.get('content-type') || '' };
  const reader = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress && onProgress(got, enc ? 0 : total); }   // 壓縮傳輸時 Content-Length 是壓縮後大小，不能當分母
  const buf = new Uint8Array(got); let p = 0; for (const x of parts) { buf.set(x, p); p += x.length; }
  return { buf: buf.buffer, type: r.headers.get('content-type') || '' };
}
const mb = n => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';
const paint = () => new Promise(r => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => setTimeout(r, 0)) : setTimeout(r, 0)));   // 讓「載入中」文字先畫出來再做重活

function loadedOK(label) {
  loaderText.textContent = '載入完成！';
  setTimeout(() => document.getElementById('loader').classList.add('hidden'), 400);
  fileName.textContent = label;
  fileZone.classList.add('hasFile');
  const roadInfo = State.roadNames.length === 0 ? '（⚠ 未載入道路名稱，僅能用座標定位）' : `（${State.roadNames.length.toLocaleString()} 條道路）`;
  showStatus(`✅ 已自動載入路網<br>${State.N.toLocaleString()} 節點 · ${State.E.toLocaleString()} 邊${roadInfo}<br>座標型別：<b>${State.coordType}</b>`, 'success');
}

// ① 先試路網封包 graph.bin（伺服器自動產生，或用 tools/pack-graph.mjs 產生）：體積小很多，且不必解析 JSON、不必建圖
// ② 沒有封包（或封包壞掉、版本不符）才下載三個 JSON（同時下載，不再一個接一個）
export async function tryFetchAll() {
  document.getElementById('loader').classList.remove('hidden');
  loaderText.textContent = '載入路網…';
  loaderProgress.textContent = DATA_BASE;
  fileList.innerHTML = '';
  const row = name => { const el = document.createElement('div'); el.textContent = `${name} … `; fileList.appendChild(el); return el; };
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now(), ms = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);

  const pr = row('graph.bin');
  try {
    const { buf, type } = await fetchWithProgress(DATA_BASE + 'graph.bin', (got, total) => { loaderProgress.textContent = `graph.bin ${mb(got)}${total ? ' / ' + mb(total) : ''}`; });
    if (/text\/html|json/.test(type)) throw new Error('不是封包');
    loaderText.textContent = '建立路網…'; await paint();
    buildGraph({ pack: buf });
    pr.innerHTML = `graph.bin <span class="ok">✓</span>（${mb(buf.byteLength)}，${ms()} ms）`;
    State.loadInfo = { from: 'pack', ms: ms(), bytes: buf.byteLength };
    loadedOK('已自動載入路網封包');
    return;
  } catch (err) {
    pr.innerHTML = `graph.bin <span class="missing">—（${err.message}，改用 JSON）</span>`;
  }

  const results = {}, got = {};
  await Promise.all(REQUIRED_FILES.map(async f => {
    const el = row(f);
    try {
      const { buf } = await fetchWithProgress(DATA_BASE + f, n => { got[f] = n; loaderProgress.textContent = `下載中 ${mb(Object.values(got).reduce((a, b) => a + b, 0))}`; });
      results[f] = buf; el.innerHTML = `${f} <span class="ok">✓</span>`;
    } catch (err) {
      el.innerHTML = `${f} <span class="missing">✗ (${err.message})</span>`;
      console.warn(`載入 ${DATA_BASE + f} 失敗：`, err);
    }
  }));
  if (results['nodes.json'] && results['edges.json']) {
    try {
      loaderText.textContent = '解析與建立路網…'; await paint();
      const td = new TextDecoder(), parse = f => results[f] ? JSON.parse(td.decode(results[f])) : null;
      buildGraph({ nodes: parse('nodes.json'), edges: parse('edges.json'), roads: parse('roads.json') || [] });
      State.loadInfo = { from: 'json', ms: ms() };
      loadedOK('已自動載入分檔 JSON');
      return;
    } catch (err) {
      showStatus(`❌ 建圖失敗：${err.message}`, 'error');
      console.error(err);
    }
  } else {
    fileName.textContent = '自動載入失敗，請手動選擇 JSON 檔案';
    showStatus(`⚠ 自動載入失敗（可能是 file:// 協定限制）<br>請點上方「選擇 JSON 檔案」手動載入。`, 'error');
  }
  document.getElementById('loader').classList.add('hidden');
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  // ============================================================
  // 手動上傳多個 JSON 檔案
  // ============================================================

  fileZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = fileInput.files;
    if (!files || files.length === 0) return;

    document.getElementById('loader').classList.remove('hidden');
    loaderText.textContent = `讀取 ${files.length} 個檔案...`;
    loaderProgress.textContent = '';

    const byName = {};
    for (const f of files) {
      try {
        const text = await f.text();
        byName[f.name] = JSON.parse(text);
        loaderProgress.textContent = `已讀取 ${f.name}`;
      } catch (err) {
        console.warn(`解析 ${f.name} 失敗：`, err);
        showStatus(`❌ 解析 ${f.name} 失敗：${err.message}`, 'error');
      }
    }

    // 尋找 nodes/edges/roads（允許不同檔名後綴）
    function findAny(keys) {
      for (const k of keys) {
        for (const name of Object.keys(byName)) {
          if (name.toLowerCase().includes(k.toLowerCase())) return byName[name];
        }
      }
      return null;
    }
    const nodes     = findAny(['nodes', 'node']);
    const edges     = findAny(['edges', 'edge', 'links', 'arcs']);
    const adjacency = findAny(['adjacency', 'adjacency_list', 'adj', 'graph', 'network']);
    const roads     = findAny(['roads', 'road', 'streets', 'ways']);

    // 沒 edges 就用 adjacency 當 edges 來源
    const edgesSrc = edges || adjacency;
    if (!nodes || !edgesSrc) {
     showStatus('❌ 缺少 nodes.json，或 edges.json / adjacency.json 都找不到', 'error');
      document.getElementById('loader').classList.add('hidden');
      return;
    }
   
    try {
    
    buildGraph({ nodes, edges: edgesSrc, roads: roads || [] });
      loaderText.textContent = '載入完成！';
      setTimeout(() => document.getElementById('loader').classList.add('hidden'), 400);
      fileName.textContent = `已載入 ${files.length} 個檔案`;
      fileZone.classList.add('hasFile');
      showStatus(`✅ 已載入路網<br>${State.N.toLocaleString()} 節點 · ${State.E.toLocaleString()} 邊<br>座標型別：<b>${State.coordType}</b>`, 'success');
    } catch (err) {
      document.getElementById('loader').classList.add('hidden');
      showStatus(`❌ 建圖失敗：${err.message}`, 'error');
      console.error(err);
    }
  });
}
