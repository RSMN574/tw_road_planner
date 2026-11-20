// bench-browser.cjs — 真實瀏覽器（Chromium）效能量測：載入路網、導航中每筆 GPS 的主執行緒耗時、偏航重新規劃
//   NODE_PATH=$(npm root -g) node test/bench-browser.cjs [路網資料夾]     （預設 /tmp/big/graph；需含 nodes.json、edges.json、roads.json）
// 輸出 JSON 一行，給「優化前後」比較用。GPS 序列只存在於量測腳本裡。
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const SRC = process.argv[2] || '/tmp/big/graph', LABEL = process.argv[3] || '';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-site-')), DIST = process.env.DIST || path.resolve(__dirname, '../dist');
fs.cpSync(DIST, TMP, { recursive: true }); fs.mkdirSync(TMP + '/data/graph', { recursive: true });
for (const f of fs.readdirSync(SRC)) fs.copyFileSync(path.join(SRC, f), path.join(TMP, 'data/graph', f));
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs'), geo = await import('../js/geo.js');
  console.info = console.log = () => {}; const out = process.stdout.write.bind(process.stdout);
  const cfg = readConfig({ DATA_DIR: TMP + '/data', STATIC_DIR: TMP, CACHE_DIR: TMP + '/.cache', LOG: '0', RATE_LIMIT_PER_MIN: '100000' });
  engine.loadData(cfg); const app = createApp(cfg); if (app.ready) await app.ready;
  const server = require('http').createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); const URL_ = `http://localhost:${server.address().port}/`;
  const nodes = JSON.parse(fs.readFileSync(SRC + '/nodes.json')), byId = new Map(nodes.map(n => [n.id, n])), ll = id => { const n = byId.get(id); const [lon, lat] = geo.twd97ToLonLat(n.x / 100, n.y / 100); return [lat, lon]; };
  const A = ll('n20_20'), B = ll('n220_160');
  const browser = await chromium.launch(), res = { label: LABEL };
  // ① 載入（冷：沒有 HTTP／SW 快取；熱：同一個瀏覽器再開一次）
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['geolocation'], geolocation: { latitude: A[0], longitude: A[1], accuracy: 8 } });
  await ctx.addInitScript(() => { window.SpeechSynthesisUtterance = function (t) { this.text = t; }; Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { getVoices: () => [{ name: 'x', lang: 'zh-TW' }], addEventListener() {}, resume() {}, cancel() {}, speak(u) { setTimeout(() => u.onend && u.onend(), 5); } } }); });
  if (process.env.NAVCAM) await ctx.addInitScript(m => { try { if (m.includes('north')) localStorage.setItem('nav.orient', '"north"'); if (m.includes('flat')) localStorage.setItem('nav.tilt', 'false'); } catch {} }, process.env.NAVCAM);   // 比較用：NAVCAM=north,flat
  const page = await ctx.newPage(); let bytes = 0;
  if (+process.env.CPU > 1) { const c0 = await ctx.newCDPSession(page); await c0.send('Emulation.setCPUThrottlingRate', { rate: +process.env.CPU }); res.cpuThrottle = +process.env.CPU; }   // 模擬手機 CPU（例如 CPU=4：慢 4 倍） page.on('response', async r => { if (/\/data\//.test(r.url())) { try { const h = await r.headerValue('content-length'); bytes += +h || 0; } catch {} } });
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const loadOnce = async () => { const t0 = Date.now(); await page.goto(URL_); await page.waitForFunction(() => /節點/.test(document.getElementById('stats').textContent), null, { timeout: 120000 }); return Date.now() - t0; };
  res.coldLoadMs = await loadOnce(); res.coldBytes = bytes; await page.evaluate(() => navigator.serviceWorker && navigator.serviceWorker.ready); await wait(1500); bytes = 0;
  res.warmLoadMs = await loadOnce(); res.warmBytes = bytes;
  // ② 規劃長路線並開始導航
  await page.fill('#from', `${A[0]},${A[1]}`); await page.press('#from', 'Enter'); await page.fill('#to', `${B[0]},${B[1]}`); await page.press('#to', 'Enter');
  const tp = Date.now(); await page.click('#go'); await page.waitForSelector('#routes .rt', { timeout: 60000 }); res.planMs = Date.now() - tp;
  await page.click('#startNav'); await page.waitForFunction(() => !document.getElementById('navUI').hidden);
    // 沿路線取樣 GPS：從頁面拿路線座標（世代座標 → 經緯度在 Node 這邊換）
  const pts = await page.evaluate(() => (window.__nav.routeLL()));
  const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
  const metric = async () => { const m = (await cdp.send('Performance.getMetrics')).metrics; const g = k => m.find(x => x.name === k).value; return { task: g('TaskDuration'), script: g('ScriptDuration'), layout: g('LayoutDuration') + g('RecalcStyleDuration') }; };
  // 沿路線以 15 m/s（54 km/h）、每秒一筆前進；之後轉 90° 開離路線（同樣速度）直到重新規劃完成
  const P = pts || [A, B], mLat = 110574, mLon = 111320 * Math.cos(P[0][0] * Math.PI / 180), xy = P.map(([la, lo]) => [(lo - P[0][1]) * mLon, (la - P[0][0]) * mLat]);
  const cum = [0]; for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const at = s => { let i = 0; while (i < xy.length - 2 && cum[i + 1] < s) i++; const L = cum[i + 1] - cum[i] || 1, t = Math.min(1, (s - cum[i]) / L); return [xy[i][0] + (xy[i + 1][0] - xy[i][0]) * t, xy[i][1] + (xy[i + 1][1] - xy[i][1]) * t, Math.atan2(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1])]; };
  const toLL = (x, y) => [P[0][0] + y / mLat, P[0][1] + x / mLon], K = +process.env.FIXES || 30, SP = 15;
  const send = async (x, y) => { const [la, lo] = toLL(x, y); await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 6 }); await wait(1000); };
  // 畫面流暢度：記錄每一幀的間隔（60 Hz 下理想是 16.7 ms；越長代表越卡）
  await page.evaluate(() => { const d = window.__frames = []; let last = performance.now(); const f = t => { d.push(t - last); last = t; if (!window.__stopFrames) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  const m0 = await metric();
  for (let i = 0; i < K; i++) { const [x, y] = at(200 + i * SP); await send(x, y); }
  const m1 = await metric(); res.navFixes = K; res.navTaskMsPerFix = +((m1.task - m0.task) * 1000 / K).toFixed(1); res.navScriptMsPerFix = +((m1.script - m0.script) * 1000 / K).toFixed(1); res.navLayoutMsPerFix = +((m1.layout - m0.layout) * 1000 / K).toFixed(1);
  const fr = await page.evaluate(() => { window.__stopFrames = true; const d = window.__frames.slice(2).sort((a, b) => a - b); return { n: d.length, p95: d[Math.floor(d.length * 0.95)], p99: d[Math.floor(d.length * 0.99)], max: d[d.length - 1], over50: d.filter(x => x > 50).length }; });
  res.framesPerFix = +(fr.n / K).toFixed(1); res.frameP99Ms = +fr.p99.toFixed(1); res.frameMaxMs = +fr.max.toFixed(1); res.framesOver50ms = fr.over50;
  res.svgNodes = await page.evaluate(() => document.querySelectorAll('svg *').length);
  { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); const m = (await cdp.send('Performance.getMetrics')).metrics, g = k => (m.find(x => x.name === k) || {}).value; res.jsHeapUsedMB = +(g('JSHeapUsedSize') / 1048576).toFixed(1); res.domNodes = g('Nodes'); }
  const [x0, y0, h] = at(200 + (K - 1) * SP), nx = Math.cos(h), ny = -Math.sin(h), r0 = await metric(), tr = Date.now(); let n = 0;
  res.trace = []; for (; n < 25 && !(await page.evaluate(() => window.__nav.reroutes() > 0)); n++) { await send(x0 + nx * SP * (n + 1), y0 + ny * SP * (n + 1)); res.trace.push(await page.evaluate(() => window.__nav.status() + ":" + (window.__nav.dbg ? window.__nav.dbg() : ""))); }
  res.rerouted = await page.evaluate(() => window.__nav.reroutes() > 0); res.offrouteFixesUntilReroute = n; res.offrouteM = n * SP;
  const r1 = await metric(); res.offrouteTaskMs = +((r1.task - r0.task) * 1000).toFixed(0);
  res.errors = errs.slice(0, 3);
  out(JSON.stringify(res) + '\n');
  await browser.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
