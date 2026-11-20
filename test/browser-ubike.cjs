// browser-ubike.cjs — 真實瀏覽器：大眾運輸方案的 YouBike 接駁（列表顯示 🚲、地圖畫出騎乘路線、可關閉）
//   NODE_PATH=$(npm root -g) node test/browser-ubike.cjs
const { chromium } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
(async () => {
  const geo = await import('../js/geo.js'), C = await import('./metro-city.mjs'), city = C.makeMetroCity({ toTWD97: geo.lonLatToTWD97, routes: 40 }), yb = [];
  for (let c = 1; c < 80; c += 3) for (let r = 1; r < 62; r += 3) { const p = C.ll(c * 150 + 20, r * 150 + 15); yb.push({ StationUID: `TXG${c}_${r}`, StationID: `${c}_${r}`, StationName: { Zh_tw: `YouBike ${c}-${r}` }, StationPosition: { PositionLat: p.lat, PositionLon: p.lon }, BikesCapacity: 20 }); }
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-')); fs.cpSync(path.resolve(__dirname, '../dist'), T, { recursive: true }); fs.mkdirSync(T + '/data/graph', { recursive: true }); fs.mkdirSync(T + '/data/bus', { recursive: true });
  for (const k of ['nodes', 'edges', 'roads']) fs.writeFileSync(`${T}/data/graph/${k}.json`, JSON.stringify(city.road[k]));
  fs.writeFileSync(T + '/data/bus/graph.json', JSON.stringify(city.bus)); fs.writeFileSync(T + '/data/metro.json', JSON.stringify(city.metro)); fs.writeFileSync(T + '/data/ubike.json', JSON.stringify(yb));
  const log = console.log; console.info = console.log = () => {};
  const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
  const cfg = readConfig({ DATA_DIR: T + '/data', STATIC_DIR: T, CACHE_DIR: T + '/.c', LOG: '0', RATE_LIMIT_PER_MIN: '100000' }); engine.loadData(cfg); const app = createApp(cfg);
  const srv = require('http').createServer(app); await new Promise(r => srv.listen(0, '127.0.0.1', r)); const URL_ = `http://localhost:${srv.address().port}/`; console.log = log;
  // 起點：走路 500 m 內沒有站（用伺服器端同一套程式找）
  const BC = await import('../js/bus-core.js'), W = p => geo.lonLatToWorld(p.lon, p.lat); let O = null;
  for (let c = 2; c < 78 && !O; c++) for (let r = 2; r < 60 && !O; r++) { const p = C.ll(c * 150, r * 150), [x, y] = W(p); if (!BC.nearbyStops(x, y, 6, 500, 'out').length) O = p; }
  const D = C.near(C.st(city.metro, 'G16'), -50, 60);
  const br = await chromium.launch(), ctx = await br.newContext({ viewport: { width: 1280, height: 900 } }), page = await ctx.newPage(), errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL_); await page.waitForFunction(() => /節點/.test(document.getElementById('stats').textContent), null, { timeout: 60000 });
  await page.waitForFunction(() => /YouBike：\d+ 站/.test(document.getElementById('ubStat').textContent) && /捷運/.test(document.getElementById('metroStat').textContent), null, { timeout: 30000 }).catch(() => {});
  await page.selectOption('#mode', 'transit');
  await page.fill('#from', `${O.lat},${O.lon}`); await page.press('#from', 'Enter'); await page.fill('#to', `${D.lat},${D.lon}`); await page.press('#to', 'Enter');
  await page.click('#go'); await page.waitForFunction(() => document.querySelectorAll('#busBox .busopt').length > 0, null, { timeout: 30000 });
  const t = await page.evaluate(() => [...document.querySelectorAll('#busBox .busopt')].map(e => e.textContent));
  console.log('① YouBike 接駁');
  ok('方案列表顯示 🚲 YouBike（借車站 → 還車站、距離、時間）', t.some(x => /🚲 YouBike [\d.]+ (m|公尺|km|公里)（YouBike [\d-]+ → YouBike [\d-]+，約 \d+ 分）/.test(x)), t[0].slice(0, 140));
  const orange = await page.evaluate(() => [...document.querySelectorAll('#routeSvg path')].filter(p => p.getAttribute('stroke') === '#ea580c').length);
  ok('地圖畫出騎乘路線（橘色，沿道路）', orange >= 1, `${orange} 條`);
  await page.screenshot({ path: '/tmp/e2e-ubike.png' });
  await page.click('#ubikeLink'); await page.waitForFunction(() => /沒有公車站|找不到/.test(document.getElementById('busBox').textContent), null, { timeout: 15000 }).catch(() => {});
  const off = await page.evaluate(() => document.getElementById('busBox').textContent);
  ok('取消勾選「YouBike 接駁」：這個起點走路到不了任何站 → 顯示原因', /沒有公車站|找不到/.test(off), off.slice(0, 60));
  await page.click('#ubikeLink'); await page.waitForFunction(() => document.querySelectorAll('#busBox .busopt').length > 0, null, { timeout: 15000 }).catch(() => {});
  ok('再勾回來：YouBike 方案恢復（錯誤畫面也保留開關）', await page.evaluate(() => /🚲 YouBike/.test(document.getElementById('busBox').textContent)));
  ok('沒有頁面錯誤', errs.length === 0, errs.join(' / '));
  await br.close(); srv.close(); fs.rmSync(T, { recursive: true, force: true });
  console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
