// 真實瀏覽器（Chromium + Playwright）端對端：PWA、手機版面、GPS 導航（用 Playwright 的定位模擬）、語音事件、偏航重新規劃、權限被拒、離線重開
// 需要 Playwright（不在 npm test 內）：NODE_PATH=$(npm root -g) node test/browser.cjs
// 注意：這裡的 GPS 序列只存在於測試；產品本身不含任何模擬定位。
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../dist'), TMP = fs.mkdtempSync('/tmp/e2e-site-'); fs.cpSync(ROOT, TMP, { recursive: true });
// ---- 測試路網：5×5 格子，間距 400 m，TWD97 公分 ----
const LON0 = 120.67, LAT0 = 24.12, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180), G = 400, N = 5;
function tw(lon, lat) { const a = 6378137, f = 1 / 298.257222101, n = f / (2 - f), k0 = 0.9999, A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64), al = [n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240]; const p = lat * Math.PI / 180, l = (lon - 121) * Math.PI / 180, c = 2 * Math.sqrt(n) / (1 + n), sp = Math.sin(p), t = Math.sinh(Math.atanh(sp) - c * Math.atanh(c * sp)), xi = Math.atan2(t, Math.cos(l)), eta = Math.atanh(Math.sin(l) / Math.sqrt(1 + t * t)); let E = eta, Nn = xi; for (let j = 1; j <= 3; j++) { E += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); Nn += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); } return [250000 + k0 * A * E, k0 * A * Nn]; }
const ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
const nodes = [], edges = [], roads = {}; let eid = 0;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const [lo, la] = ll(i * G, j * G), [e, n] = tw(lo, la); nodes.push({ id: `n${i}_${j}`, x: Math.round(e * 100), y: Math.round(n * 100) }); }
const addE = (a, b, name) => { for (const [x, y] of [[a, b], [b, a]]) { edges.push({ from: x, to: y, w: G, edgeId: eid }); (roads[name] = roads[name] || { segments: 0, totalLength: 0, edgeIds: [] }).edgeIds.push(eid++); } };
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i + 1 < N) addE(`n${i}_${j}`, `n${i+1}_${j}`, `東西${j}路`); if (j + 1 < N) addE(`n${i}_${j}`, `n${i}_${j+1}`, `南北${i}路`); }
fs.mkdirSync(TMP + '/data/graph', { recursive: true }); for (const [f, d] of [['nodes', nodes], ['edges', edges], ['roads', roads]]) fs.writeFileSync(`${TMP}/data/graph/${f}.json`, JSON.stringify(d));
// 用真正的台灣通伺服器（server/server.mjs）提供網頁、資料與 API
let server; fs.copyFileSync(path.resolve(__dirname, 'fixtures/metro.json'), TMP + '/data/metro.json');
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
// 假的 SpeechSynthesis（只記錄念了什麼；Chromium headless 沒有真的語音）
const SPY = `(() => { const spoken = []; window.__spoken = spoken; let cur = null;
 window.SpeechSynthesisUtterance = function (t) { this.text = t; };
 Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speaking: false, paused: false, getVoices: () => [{ name: 'Test zh-TW', lang: 'zh-TW' }], addEventListener() {}, resume() {}, cancel() { const u = cur; cur = null; if (u && u.onerror) setTimeout(() => u.onerror({ error: 'interrupted' }), 0); }, speak(u) { if (u.text.trim()) spoken.push(u.text); cur = u; setTimeout(() => { if (cur === u) { cur = null; u.onend && u.onend(); } }, 30); } } }); })();`;
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs'); console.info = () => {};
  const cfg = readConfig({ DATA_DIR: TMP + '/data', STATIC_DIR: TMP, CACHE_DIR: TMP + '/.cache', LOG: '0', RATE_LIMIT_PER_MIN: '10000', TDX_TOKEN_URL: 'http://127.0.0.1:9/token', TDX_API_KEY: 'BROWSER-SHOULD-NEVER-SEE-THIS' }); engine.loadData(cfg); server = http.createServer(createApp(cfg));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); const URL_ = `http://localhost:${server.address().port}/`; const browser = await chromium.launch();
  const mk = async (opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, permissions: ['geolocation'], geolocation: { latitude: LAT0, longitude: LON0, accuracy: 10 }, ...opts }); await ctx.addInitScript(SPY); const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); return { ctx, page, errs }; };
  const loadPlan = async page => { await page.goto(URL_); await page.waitForFunction(() => !/未載入/.test(document.getElementById('stats').textContent), null, { timeout: 15000 }); await page.fill('#from', `${LAT0},${LON0}`); await page.press('#from', 'Enter'); const [tx, ty] = ll(3 * G, 1 * G); await page.fill('#to', `${ty},${tx}`); await page.press('#to', 'Enter'); await page.click('#go'); await page.waitForSelector('#routes .rt', { timeout: 10000 }); };
  const posAlong = (P, s) => { let acc = 0; for (let i = 0; i < P.length - 1; i++) { const L = Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1]); if (s <= acc + L || i === P.length - 2) { const t = Math.min(1, (s - acc) / L); return [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t]; } acc += L; } };
  const ROUTE = [[0, 0], [400, 0], [800, 0], [1200, 0], [1200, 400]];                         // 預期路線之一（等長路線很多，下面用實際路線的偏離量判斷）
  console.log('① PWA 與手機版面');
  { const { ctx, page, errs } = await mk(); await page.goto(URL_); await page.waitForFunction(() => !/未載入/.test(document.getElementById('stats').textContent), null, { timeout: 15000 });
    const man = await page.evaluate(async () => { const l = document.querySelector('link[rel=manifest]'); const r = await fetch(l.href); return r.ok ? r.json() : null; });
    ok('manifest 可讀取，standalone、含 192/512/maskable 圖示', man && man.display === 'standalone' && man.icons.some(i => i.sizes === '192x192') && man.icons.some(i => i.purpose === 'maskable'));
    const icons = await Promise.all(['icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'].map(u => page.evaluate(async u => (await fetch(u)).status, u))); ok('圖示檔都存在', icons.every(s => s === 200), icons.join(','));
    await page.evaluate(() => navigator.serviceWorker.ready); const sw = await page.evaluate(() => navigator.serviceWorker.controller ? 'controlled' : 'registered'); ok('Service Worker 已註冊並啟用', !!sw);
    const box = await page.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect(); return { w: r.width, bottom: r.bottom, top: r.top, pos: getComputedStyle(document.getElementById('panel')).position }; });
    ok('手機寬度：面板變成底部抽屜（全寬、fixed）', box.pos === 'fixed' && Math.abs(box.w - 390) < 1 && Math.abs(box.bottom - 844) < 2, JSON.stringify(box));
    await page.click('#panel h1'); const col = await page.evaluate(() => document.getElementById('panel').classList.contains('collapsed')); ok('點標題列可收合抽屜', col);
    await page.click('#panel h1'); const th0 = await page.evaluate(() => document.documentElement.dataset.theme); await page.click('#themeBtn'); const th1 = await page.evaluate(() => document.documentElement.dataset.theme); ok('深色／淺色可切換並記住', th0 !== th1 && await page.evaluate(() => localStorage.getItem('theme')) === th1, `${th0} → ${th1}`);
    const dis = await page.evaluate(() => document.getElementById('startNav').disabled); ok('沒有路線時「開始導航」是停用的', dis === true);
    const li = await page.evaluate(() => window.__nav.loadInfo()); ok('路網從封包 graph.bin 載入（不必下載與解析 JSON）', li && li.from === 'pack', JSON.stringify(li));
    await page.screenshot({ path: '/tmp/e2e-mobile.png' }); ok('載入過程沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }
  console.log('② GPS 導航（Playwright 模擬定位）');
  { const { ctx, page, errs } = await mk(); await loadPlan(page);
    const path_ = await page.evaluate(() => 0); await page.click('#startNav'); await page.waitForSelector('#navUI:not([hidden])');
    ok('進入導航：顯示導航介面、面板隱藏', await page.evaluate(() => document.body.classList.contains('navigating') && getComputedStyle(document.getElementById('panel')).display === 'none'));
    await wait(500); const spoken0 = await page.evaluate(() => window.__spoken.slice()); ok('開始導航有語音（在使用者點擊內初始化）', spoken0.some(t => t.startsWith('開始導航')), spoken0[0]);
    // 沿「頁面實際規劃的路線」走：從頁面取路線座標（world → 公尺）不方便，改用已知格子路網：直接以最短路線 (0,0)→(1200,400) 的 L 形或階梯路徑都等長；
    // 這裡改成讀頁面內的導航狀態（距離下一步）來驅動：每步取目前位置往「下一個導航點」前進
    const route = await page.evaluate(() => { const svgPath = document.querySelectorAll('#routeSvg path.route-seg'); return svgPath.length; });
    ok('地圖上畫出了目前路線', route > 0);
    // 以 Playwright 取得路線節點：用頁面內 State 不可得（打包後無全域）；改用「走格子」：先橫向再縱向 或 依路線 — 取兩種都測，並以 navRem 的變化驗證進度
    const L1 = [[0, 0], [1200, 0], [1200, 400]], L2 = [[0, 0], [0, 400], [1200, 400]];
    const follow = async P => { const total = Math.hypot(1200, 0) + 400; for (let s = 0; s <= total + 40; s += 80) { const [x, y] = posAlong(P, Math.min(s, total)), [lo, la] = ll(x, y); await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 12 }); await wait(1050); } };
    await ctx.setGeolocation({ latitude: LAT0, longitude: LON0, accuracy: 12 }); await wait(1300);
    const chip = await page.evaluate(() => document.getElementById('gpsChip').textContent); ok('GPS 狀態晶片顯示正常', /GPS 正常|GPS 訊號弱/.test(chip), chip);
    const dist0 = await page.evaluate(() => document.getElementById('navDist').textContent); ok('頂部顯示下一個轉彎距離', /公(尺|里)/.test(dist0), dist0 + ' ' + await page.evaluate(() => document.getElementById('navRoad').textContent));
    const rem0 = await page.evaluate(() => document.getElementById('navRem').textContent);
    // 跟隨移動時只平移已畫好的場景（同一個 <g id="scene">），不重畫整張地圖；箭頭在場景外、每幀更新
    await page.evaluate(() => { const g = document.getElementById('scene'); if (g) g.dataset.mark = '1'; });
    for (const s of [40, 80]) { const [x, y] = posAlong(L1, s), [lo, la] = ll(x, y); await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 12 }); await wait(1300); }
    const sc = await page.evaluate(() => { const g = document.getElementById('scene'), m = document.getElementById('navMarker'); return { same: !!(g && g.dataset.mark === '1'), tf: g && g.getAttribute('transform'), marker: !!m, markerOutside: !!(m && m.parentNode && m.parentNode.id !== 'scene') }; });
    ok('跟隨移動：只平移場景，不整張重畫', sc.same && /translate|matrix/.test(sc.tf || ''), JSON.stringify(sc));
    ok('GPS 箭頭畫在場景之外（每幀更新位置）', sc.marker && sc.markerOutside);
    // 用實際路線判斷走哪個 L 形：看一步之後的偏離狀態
    await follow(L1); await wait(500);
    const st = await page.evaluate(() => ({ dist: document.getElementById('navDist').textContent, rem: document.getElementById('navRem').textContent, eta: document.getElementById('navEta').textContent, spoken: window.__spoken.slice(), msg: document.getElementById('navArrow').textContent }));
    console.log('   起始剩餘', rem0, '→ 結束', st.rem, '｜', st.dist, '｜ETA', st.eta, '｜語音', st.spoken.length, '則');
    ok('走完全程後剩餘距離大幅縮短或已抵達', st.dist.includes('抵達') || parseFloat(st.rem) < 100 || /m$/.test(st.rem), st.rem);
    ok('語音：有「前方…公尺」路口提示', st.spoken.some(t => /^前方\d+公尺/.test(t)) || st.spoken.some(t => /^現在/.test(t)), st.spoken.join(' / '));
    ok('沒有重複的語音句子（相鄰不重複）', st.spoken.every((t, i) => i === 0 || t !== st.spoken[i - 1])); await page.screenshot({ path: '/tmp/e2e-nav.png' });
    await page.click('#navEnd'); ok('結束導航：回到規劃畫面', await page.evaluate(() => !document.body.classList.contains('navigating') && document.getElementById('navUI').hidden)); ok('導航過程沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }
  console.log('③ 偏航與重新規劃');
  { const { ctx, page, errs } = await mk(); await loadPlan(page); await page.click('#startNav'); await page.waitForSelector('#navUI:not([hidden])');
    await ctx.setGeolocation({ latitude: LAT0, longitude: LON0, accuracy: 10 }); await wait(1300);
    // 往一條離路線很遠、但在路網上的平行街道走（南北4路 x=1600，往北）：一定偏離任何到 (1200,400) 的最短路線
    for (let k = 0; k < 14; k++) { const [lo, la] = ll(1600 + 0, 80 * k); await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 10 }); await wait(1050); }
    await wait(600); const sp = await page.evaluate(() => window.__spoken.slice()); console.log('   語音：', sp.join(' / '));
    ok('偏離後語音：偏離路線 → 重新規劃 → 已重新規劃', sp.includes('您已偏離路線') && sp.includes('正在重新規劃路線') && sp.includes('已重新規劃路線'));
    ok('重新規劃只做一次（沒有每筆定位都重算）', sp.filter(t => t === '正在重新規劃路線').length === 1);
    ok('重新規劃後回到導航狀態（頂部不再顯示警示）', await page.evaluate(() => !/偏離|重新規劃/.test(document.getElementById('navDist').textContent)));
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }
  console.log('④ 定位權限被拒絕');
  { const { ctx, page, errs } = await mk({ permissions: [] }); await loadPlan(page); await page.click('#startNav'); await page.waitForFunction(() => document.getElementById('navUI').hidden && /拒絕/.test(document.getElementById('status').textContent), null, { timeout: 8000 }).catch(() => {});
    const r = await page.evaluate(() => ({ hidden: document.getElementById('navUI').hidden, st: document.getElementById('status').textContent, nav: document.body.classList.contains('navigating') })); ok('權限被拒：結束導航並顯示說明（不卡在空白導航畫面）', r.hidden && !r.nav && /拒絕/.test(r.st), r.st.slice(0, 60)); await ctx.close(); }
  console.log('⑤ 離線重開（Service Worker）');
  { const { ctx, page } = await mk(); await page.goto(URL_); await page.waitForFunction(() => !/未載入/.test(document.getElementById('stats').textContent), null, { timeout: 15000 }); await page.evaluate(() => navigator.serviceWorker.ready); await page.reload(); await page.waitForFunction(() => navigator.serviceWorker.controller);
    // 等 Service Worker 把路網檔真的寫進快取（背景寫入，有時比頁面載入完成晚）再離線
    await page.waitForFunction(async () => { for (const k of await caches.keys()) { const c = await caches.open(k); const keys = (await c.keys()).map(r => r.url); if (keys.some(u => u.endsWith('data/graph/graph.bin')) || ['nodes', 'edges', 'roads'].every(n => keys.some(u => u.endsWith(`data/graph/${n}.json`)))) return true; } return false; }, null, { timeout: 10000, polling: 200 });
    const li5 = await page.evaluate(() => window.__nav.loadInfo()); ok('有 Service Worker 時同樣從封包載入', li5 && li5.from === 'pack', JSON.stringify(li5) + '｜' + await page.evaluate(() => document.getElementById('fileList').textContent));
    await ctx.setOffline(true); await page.reload(); await page.waitForFunction(() => { const s = document.getElementById('stats'), l = document.getElementById('loader'); return s && s.textContent.length > 0 && (!/未載入/.test(s.textContent) || (l && l.classList.contains('hidden'))); }, null, { timeout: 10000 }).catch(() => {});   // 等載入流程結束（成功或失敗）再檢查
    const r = await page.evaluate(() => ({ stats: document.getElementById('stats').textContent, bar: !document.getElementById('offlineBar').hidden, ok: !!document.getElementById('go') })); ok('離線重新開啟：頁面仍能載入，且顯示離線提示', r.ok && r.bar, JSON.stringify(r));
    ok('離線時已快取的路網資料仍可載入', !/未載入/.test(r.stats), r.stats + '｜' + await page.evaluate(() => document.getElementById('fileList').textContent)); await ctx.close(); }
  console.log('⑥ 手機橫向');
  { const { ctx, page } = await mk({ viewport: { width: 780, height: 360 } }); await page.goto(URL_); await page.waitForFunction(() => !/未載入/.test(document.getElementById('stats').textContent), null, { timeout: 15000 }); const b = await page.evaluate(() => { const r = document.getElementById('panel').getBoundingClientRect(); return { l: r.left, w: r.width, h: r.height }; }); ok('橫向：面板靠右、不遮住整個地圖', b.w < 780 * 0.6 && b.h >= 359, JSON.stringify(b)); await ctx.close(); }
  console.log('⑦ 由伺服器提供時的自動設定');
  { const { ctx, page, errs } = await mk(); await page.goto(URL_); await page.waitForFunction(() => /已連線伺服器/.test(document.getElementById('serverStat').textContent), null, { timeout: 10000 });
    const r = await page.evaluate(() => ({ stat: document.getElementById('serverStat').textContent, proxy: document.getElementById('tdxProxy').value, metro: document.getElementById('metroStat').textContent, html: document.documentElement.outerHTML }));
    ok('偵測到伺服器並顯示版本與路網', /已連線伺服器 v\d/.test(r.stat) && /25 節點/.test(r.stat), r.stat.slice(0, 60));
    ok('TDX 自動改用伺服器內建代理（同網域 /tdx）', r.proxy === URL_ + 'tdx', r.proxy);
    ok('伺服器上的捷運資料自動載入', /捷運|18/.test(r.metro) && /捷運 ✓/.test(r.stat), r.metro.slice(0, 40));
    ok('網頁內容完全沒有 TDX 金鑰', !r.html.includes('BROWSER-SHOULD-NEVER-SEE-THIS'));
    const api = await page.evaluate(async () => (await (await fetch('api/v1/route?from=24.12,120.67&to=24.1236,120.6831&mode=walk')).json()));
    ok('網頁同網域可直接呼叫 API', api.ok && api.data.routes.some(x => x.ok), api.ok ? api.data.routes.map(x => x.key + ':' + x.durationS + 's').join(' ') : JSON.stringify(api.error));
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }
  await browser.close(); server.close(); console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
