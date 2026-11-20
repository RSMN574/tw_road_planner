// browser-metro.cjs — 真實瀏覽器：大眾運輸模式要顯示捷運（公車＋捷運、跨線、時刻表搜尋）
//   NODE_PATH=$(npm root -g) node test/browser-metro.cjs
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
(async () => {
  const geo = await import('../js/geo.js'), C = await import('./metro-city.mjs'), city = C.makeMetroCity({ toTWD97: geo.lonLatToTWD97 });
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-')); fs.cpSync(path.resolve(__dirname, '../dist'), T, { recursive: true }); fs.mkdirSync(T + '/data/graph', { recursive: true }); fs.mkdirSync(T + '/data/bus', { recursive: true });
  for (const k of ['nodes', 'edges', 'roads']) fs.writeFileSync(`${T}/data/graph/${k}.json`, JSON.stringify(city.road[k]));
  fs.writeFileSync(T + '/data/bus/graph.json', JSON.stringify(city.bus)); fs.writeFileSync(T + '/data/metro.json', JSON.stringify(city.metro));
  const log = console.log; console.info = console.log = () => {};
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
  const cfg = readConfig({ DATA_DIR: T + '/data', STATIC_DIR: T, CACHE_DIR: T + '/.c', LOG: '0', RATE_LIMIT_PER_MIN: '100000' }); engine.loadData(cfg); const app = createApp(cfg); if (app.ready) await app.ready;
  const srv = require('http').createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const URL_ = `http://localhost:${srv.address().port}/`; console.log = log;
  const br = await chromium.launch(), ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }), page = await ctx.newPage(), errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL_); await page.waitForFunction(() => /節點/.test(document.getElementById('stats').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => /捷運：24 站/.test(document.getElementById('metroStat').textContent), null, { timeout: 30000 }).catch(() => {});
  const ms = await page.evaluate(() => document.getElementById('metroStat').textContent);
  console.log('① 載入'); ok('捷運資料載入：24 站、兩條線、轉乘連結', /24 站/.test(ms) && /跨線/.test(ms), ms.slice(0, 120));
  await page.selectOption('#mode', 'transit');
  const S = id => C.st([...C.greenLine(), ...C.testBlueLine()], id), go = async (a, z) => {
    await page.fill('#from', `${a.lat},${a.lon}`); await page.press('#from', 'Enter'); await page.fill('#to', `${z.lat},${z.lon}`); await page.press('#to', 'Enter');
    const before = await page.evaluate(() => (document.getElementById('busBox') || {}).textContent || '');
    await page.click('#go'); await page.waitForFunction(b => document.querySelectorAll('#busBox .busopt').length > 0 && document.getElementById('busBox').textContent !== b, before, { timeout: 30000 });   // 等到新結果出現（不是上一次的）
    return page.evaluate(() => [...document.querySelectorAll('#busBox .busopt')].map(e => e.textContent));
  };
  console.log('② 大眾運輸方案');
  const r1 = await go(C.near(S('G3'), 60, 40), C.near(S('G16'), -50, 60));
  ok('捷運站 → 捷運站：方案列表有 🚇 捷運綠線', r1.some(t => /🚇 捷運綠線/.test(t)), r1[0].slice(0, 80));
  const r5 = await go(C.near(S('TB1'), 40, 30), C.near(S('G4'), -60, 40));
  ok('跨線：藍線 → 轉乘步行 → 綠線', r5.some(t => /🚇 捷運TB線.*轉乘步行.*🚇 捷運綠線/.test(t)), r5.map(t => t.replace(/總時間.*/, '').slice(0, 90)).join(' ‖ '));
  const r2 = await go(C.near(S('G6'), 2400, -2400), C.near(S('G14'), 40, -30));
  ok('公車 → 捷運：顯示公車路線、轉乘步行與捷運', r2.some(t => /路（\d+ 站）.*轉乘步行.*🚇 捷運綠線/.test(t)));
  const svg = await page.evaluate(() => document.querySelectorAll('#routeSvg path').length);
  ok('地圖有畫出路線', svg > 0);
  ok('沒有頁面錯誤', errs.length === 0, errs.join(' / '));
  await br.close(); srv.close(); fs.rmSync(T, { recursive: true, force: true });
  console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
