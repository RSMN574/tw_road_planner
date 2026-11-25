// 真實瀏覽器（Chromium + Playwright）：網頁使用伺服器的全台 OSM 道路圖——底圖圖磚、規劃、步驟與分析、路名搜尋、點地圖選點、道路資訊、
// GPS 導航（ETA 用伺服器的分段時間）、偏航後由伺服器重新規劃、渡輪。v1.18：OSM 是唯一的路網（舊的本機路網與「關閉 OSM」開關已移除）。
// 需要 Playwright（不在 npm test 內）：NODE_PATH=$(npm root -g) node test/browser-osm.cjs
// 用真實的全台圖：OSM_GRAPH_DIR=/path/to/data/osm/graph node test/browser-osm.cjs real（只跑台北的規劃與截圖）
// 注意：這裡的 GPS 序列只存在於測試；產品本身不含任何模擬定位。
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), FIX = ROOT + '/test/fixtures/osm/tw-mini.osm.pbf', REAL = process.argv[2] === 'real';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-web-')); fs.cpSync(ROOT + '/dist', TMP + '/site', { recursive: true }); fs.mkdirSync(TMP + '/data/osm/graph', { recursive: true });
const LAT0 = 24.150, LON0 = 120.650, D = 0.001, at = (i, j) => [LAT0 + j * D, LON0 + i * D];
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const SPY = `(() => { const spoken = []; window.__spoken = spoken; let cur = null;
 window.SpeechSynthesisUtterance = function (t) { this.text = t; };
 Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speaking: false, paused: false, getVoices: () => [{ name: 'Test zh-TW', lang: 'zh-TW' }], addEventListener() {}, resume() {}, cancel() { const u = cur; cur = null; if (u && u.onerror) setTimeout(() => u.onerror({ error: 'interrupted' }), 0); }, speak(u) { if (u.text.trim()) spoken.push(u.text); cur = u; setTimeout(() => { if (cur === u) { cur = null; u.onend && u.onend(); } }, 30); } } }); })();`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const hav = (a, b) => { const R = Math.PI / 180, h = Math.sin((b[0] - a[0]) * R / 2) ** 2 + Math.cos(a[0] * R) * Math.cos(b[0] * R) * Math.sin((b[1] - a[1]) * R / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(h)); };
const distToPoly = (p, P) => { let m = Infinity; for (let i = 0; i < P.length - 1; i++) for (let t = 0; t <= 1; t += 0.1) m = Math.min(m, hav(p, [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t])); return m; };

(async () => {
  let graphDir = TMP + '/data/osm/graph';
  if (REAL) graphDir = process.env.OSM_GRAPH_DIR;
  else { const b = spawnSync(process.execPath, [ROOT + '/tools/osm/osm-build.mjs', '--pbf', FIX, '--out', graphDir, '--no-osmium'], { encoding: 'utf8' }); if (b.status) { console.log(b.stderr); process.exit(1); } }
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'); console.info = () => {};
  const cfg = readConfig({ DATA_DIR: TMP + '/data', STATIC_DIR: TMP + '/site', CACHE_DIR: TMP + '/.cache', LOG: '0', RATE_LIMIT_PER_MIN: '100000', OSM_GRAPH_DIR: graphDir, WORKERS: '0' });
  const app = createApp(cfg); await app.backend.osmLoad(cfg); await app.backend.osmWarmup(['car']);
  const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); const URL_ = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch(), reqs = [];
  const mk = async (opts = {}) => { const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['geolocation'], geolocation: { latitude: LAT0, longitude: LON0, accuracy: 10 }, ...opts }); await ctx.addInitScript(SPY); const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); page.on('request', r => { if (/api\/v1\/osm\//.test(r.url())) reqs.push(r.url()); }); return { ctx, page, errs }; };
  const ready = page => page.waitForFunction(() => /OSM/.test(document.getElementById('stats').textContent), null, { timeout: 20000 });
  const setPt = async (page, id, [la, lo]) => { await page.fill('#' + id, `${la},${lo}`); await page.press('#' + id, 'Enter'); };
  const plan = async (page, from, to, mode = 'car') => { await page.selectOption('#mode', mode); await setPt(page, 'from', from); await setPt(page, 'to', to); await page.click('#go'); await page.waitForFunction(() => /找到|❌/.test(document.getElementById('status').textContent), null, { timeout: 30000 }); };
  const tilesDrawn = page => page.evaluate(() => { const g = document.querySelector('#osmBase'); return g ? g.querySelectorAll('path').length : 0; });

  if (REAL) {
    console.log('真實全台圖：台北車站 → 台北 101');
    const { ctx, page, errs } = await mk({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }); await page.goto(URL_); await ready(page);
    await page.waitForFunction(() => document.querySelectorAll('#osmBase path').length > 3, null, { timeout: 20000 }); await wait(1500);
    await page.screenshot({ path: process.env.SHOT_DIR + '/osm-taiwan.png' });
    await plan(page, [25.0478, 121.5170], [25.0340, 121.5645]); await wait(2500);
    const st = await page.evaluate(() => ({ status: document.getElementById('status').innerText, routes: document.getElementById('routes').innerText, steps: document.querySelectorAll('#steps .step').length, an: document.getElementById('analysisBox').innerText }));
    console.log(st.status, '\n', st.routes, '\n', st.an); await page.screenshot({ path: process.env.SHOT_DIR + '/osm-taipei-route.png' });
    await page.click('#clear'); await page.mouse.move(980, 420); for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -300); await wait(80); } await wait(3000); await page.screenshot({ path: process.env.SHOT_DIR + '/osm-taipei-zoom.png' });
    await plan(page, [24.1477, 120.6736], [23.5654, 119.5793]); await wait(2500); console.log(await page.evaluate(() => document.getElementById('status').innerText + '\n' + document.getElementById('routes').innerText));
    await page.screenshot({ path: process.env.SHOT_DIR + '/osm-penghu.png' });
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); await browser.close(); server.close(); process.exit(fails ? 1 : 0);
  }

  console.log('① 自動使用伺服器的 OSM 道路圖，畫出底圖');
  { const { ctx, page, errs } = await mk(); await page.goto(URL_); await ready(page);
    const s = await page.evaluate(() => ({ noSwitch: !document.getElementById('osmOn'), attr: !document.getElementById('osmAttr').hidden, stats: document.getElementById('stats').textContent, status: document.getElementById('status').textContent, ph: document.getElementById('placeholder').classList.contains('hidden') }));
    ok('沒有「關閉 OSM」開關、顯示 OSM 版權標示、沒有「載入失敗」的錯誤', s.noSwitch && s.attr && !/自動載入失敗/.test(s.status) && /OSM/.test(s.status) && s.ph, JSON.stringify(s));
    await page.mouse.move(640, 400); for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, -500); await wait(60); }
    // 放大到測試資料（台中附近一小塊）：把畫面中心移過去
    await setPt(page, 'from', at(0, 0)); await setPt(page, 'to', at(4, 4)); await page.click('#go'); await page.waitForSelector('#routes .rt', { timeout: 20000 }); await wait(1200);
    const n = await tilesDrawn(page); ok('底圖圖磚：畫出道路（只抓看得到的圖磚）', n > 0, `${n} 個 path、${reqs.filter(u => /tiles/.test(u)).length} 個圖磚請求`);
    ok('圖磚請求帶圖檔版本（重建圖後瀏覽器快取自動失效）', reqs.filter(u => /tiles/.test(u)).every(u => /\?v=/.test(u)));
    const r = await page.evaluate(() => ({ list: document.getElementById('routes').innerText, steps: [...document.querySelectorAll('#steps .step')].map(e => e.innerText), an: document.getElementById('analysisBox').innerText, segs: document.querySelectorAll('#routeSvg .route-seg').length, nav: document.getElementById('startNav').disabled }));
    ok('規劃：路線清單（距離、時間、路名）', /最快/.test(r.list) && /km/.test(r.list) && /分/.test(r.list), r.list.replace(/\s+/g, ' ').slice(0, 120));
    ok('步驟：起點…抵達，含路名與速限來源', r.steps.length >= 3 && /起點/.test(r.steps[0]) && /抵達/.test(r.steps.at(-1)) && r.steps.some(t => /速限/.test(t)), r.steps.slice(0, 3).join(' / '));
    ok('路線分析：資料來源 OSM、時間組成（行駛＋路口與轉彎）、速限資料覆蓋、通行資料', /OpenStreetMap/.test(r.an) && /路口與轉彎/.test(r.an) && /速限資料/.test(r.an) && /通行資料/.test(r.an), r.an.replace(/\s+/g, ' ').slice(0, 160));
    ok('地圖上畫出路線（依路名分段）；可以開始導航', r.segs > 0 && r.nav === false);
    // 路名搜尋（伺服器）
    await page.fill('#to', '台灣'); await page.waitForFunction(() => document.querySelectorAll('#toResult div').length > 0, null, { timeout: 8000 });
    const hits = await page.evaluate(() => [...document.querySelectorAll('#toResult div')].map(d => d.innerText)); ok('路名搜尋（伺服器 OSM）', hits.some(h => /台灣大道/.test(h)), hits.slice(0, 3).join(' / '));
    await page.click('#toResult div'); await page.waitForFunction(() => /最近道路/.test(document.getElementById('toInfo').textContent), null, { timeout: 8000 }).catch(() => {});
    ok('選搜尋結果當終點，並顯示最近道路', /台灣大道/.test(await page.evaluate(() => document.getElementById('toInfo').textContent)));
    // 點地圖：查道路資訊
    await page.selectOption('#clickMode', 'inspect'); const box = await page.evaluate(() => { const c = document.querySelector('#routeSvg .route-seg'); const b = c.getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2]; });
    await page.mouse.click(box[0], box[1]); await page.waitForFunction(() => /OSM/.test(document.getElementById('roadInfo').textContent), null, { timeout: 8000 }).catch(() => {});
    const info = await page.evaluate(() => document.getElementById('roadInfo').innerText); ok('道路資訊（OSM）：類別、速限來源、各運具通行', /類別/.test(info) && /速限/.test(info) && /通行：汽車/.test(info), info.replace(/\s+/g, ' ').slice(0, 140));
    await page.selectOption('#clickMode', 'pick');
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }

  console.log('② 渡輪、步行');
  { const { ctx, page, errs } = await mk(); await page.goto(URL_); await ready(page);
    await plan(page, at(4, 4), [LAT0 + 0.004, LON0 + 0.022], 'walk');
    const r = await page.evaluate(() => ({ steps: [...document.querySelectorAll('#steps .step')].map(e => e.innerText), list: document.getElementById('routes').innerText, an: document.getElementById('analysisBox').innerText }));
    ok('步行搭渡輪：步驟有「搭乘渡輪」，清單與分析註明不含候船', r.steps.some(t => /渡輪/.test(t)) && /渡輪/.test(r.list) && /候船/.test(r.an), r.steps.filter(t => /渡輪/.test(t)).join(''));
    await plan(page, at(4, 4), [LAT0 + 0.004, LON0 + 0.022], 'car');
    ok('汽車到不了只載人的渡輪小島：顯示找不到路線', /❌/.test(await page.evaluate(() => document.getElementById('status').textContent)));
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }

  console.log('③ GPS 導航（ETA 用伺服器的分段時間）、偏航由伺服器重新規劃');
  { const { ctx, page, errs } = await mk({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); await page.goto(URL_); await ready(page);
    await plan(page, at(0, 0), at(4, 4)); await page.click('#startNav'); await page.waitForSelector('#navUI:not([hidden])');
    const R = await page.evaluate(() => window.__nav.routeLL());
    await ctx.setGeolocation({ latitude: R[0][0], longitude: R[0][1], accuracy: 8 }); await wait(1300);
    const s0 = await page.evaluate(() => ({ rem: document.getElementById('navRem').textContent, left: document.getElementById('navLeft').textContent, dist: document.getElementById('navDist').textContent, note: document.getElementById('navNote').textContent }));
    ok('開始導航：剩餘距離、剩餘時間、下一個轉彎', /m|km/.test(s0.rem) && /分/.test(s0.left) && /公尺|公里/.test(s0.dist), JSON.stringify(s0));
    // 沿路線前進 200 m
    const along = s => { let acc = 0; for (let i = 0; i < R.length - 1; i++) { const L = hav(R[i], R[i + 1]); if (s <= acc + L || i === R.length - 2) { const t = Math.min(1, (s - acc) / L); return [R[i][0] + (R[i + 1][0] - R[i][0]) * t, R[i][1] + (R[i + 1][1] - R[i][1]) * t]; } acc += L; } };
    for (let s = 40; s <= 200; s += 40) { const [la, lo] = along(s); await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 8 }); await wait(1050); }
    const s1 = await page.evaluate(() => document.getElementById('navRem').textContent); ok('沿路線前進：剩餘距離變少（沿路線，不是直線）', parseFloat(s1) < parseFloat(s0.rem) || /km/.test(s0.rem), `${s0.rem} → ${s1}`);
    // 偏航：沿一條離路線 ≥ 60 m 的格子道路走
    const lines = []; for (let j = 0; j <= 4; j++) lines.push([0, 1, 2, 3, 4].map(i => at(i, j))); for (let i = 0; i <= 4; i++) lines.push([0, 1, 2, 3, 4].map(j => at(i, j)));
    let off = null; for (const L of lines) for (const dirL of [L, [...L].reverse()]) { const pts = []; for (let k = 0; k < dirL.length - 1; k++) for (let t = 0; t < 1; t += 0.25) pts.push([dirL[k][0] + (dirL[k + 1][0] - dirL[k][0]) * t, dirL[k][1] + (dirL[k + 1][1] - dirL[k][1]) * t]); const far = pts.filter(p => distToPoly(p, R) > 60); if (far.length >= 8 && (!off || far.length > off.length)) off = far; }
    ok('找得到偏離路線的測試路徑', !!off, off ? `${off.length} 點` : '');
    const before = reqs.filter(u => /osm\/route/.test(u)).length;
    for (const [la, lo] of (off || []).slice(0, 12)) { await ctx.setGeolocation({ latitude: la, longitude: lo, accuracy: 8 }); await wait(1050); }
    await page.waitForFunction(() => window.__nav.reroutes() > 0, null, { timeout: 10000 }).catch(() => {}); await wait(500);
    const rr = await page.evaluate(() => ({ n: window.__nav.reroutes(), spoken: window.__spoken.slice(), dist: document.getElementById('navDist').textContent })), after = reqs.filter(u => /osm\/route/.test(u));
    ok('偏航 → 伺服器重新規劃（帶行進方向 heading），只問一次', rr.n >= 1 && after.length - before >= 1 && after.length - before <= 2 && after.slice(before).some(u => /heading=/.test(u) || /alternatives=0/.test(u)), `${rr.n} 次、${after.length - before} 個請求`);
    ok('語音：偏離路線 → 正在重新規劃 → 已重新規劃', rr.spoken.includes('您已偏離路線') && rr.spoken.includes('已重新規劃路線'), rr.spoken.join(' / '));
    await page.click('#navEnd');
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }

  console.log('④ 舊版的「關閉 OSM」設定（localStorage osm.on=0）不再有作用');
  { const { ctx, page, errs } = await mk(); await page.goto(URL_); await page.evaluate(() => localStorage.setItem('osm.on', '0')); await page.reload(); await ready(page);
    const s = await page.evaluate(() => ({ attr: document.getElementById('osmAttr').hidden, body: document.body.classList.contains('osm-map') }));
    ok('仍使用 OSM（顯示版權標示、OSM 底圖配色）', !s.attr && s.body, JSON.stringify(s));
    ok('沒有 JS 錯誤', errs.length === 0, errs.join(' | ')); await ctx.close(); }

  await browser.close(); server.close(); console.log(fails ? `\n❌ ${fails} 項失敗` : '\n✅ 全部通過'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
