// 路線計算放到背景執行緒（worker_threads）：結果與主執行緒相同、主執行緒不被卡住、錯誤碼照舊、逾時與執行緒當掉會自動重開
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log0 = console.log; console.info = () => {}; console.warn = () => {};
const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs'), engine = await import('../server/engine.mjs');
const { workerBackend } = await import('../server/backend.mjs'), { lonLatToTWD97: tw } = await import('../js/geo.js'), { readPackHeader } = await import('../js/graph-pack.js');
let fails = 0; const ok = (n, c, x = '') => { log0((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 測試路網：140×140 格子（19,600 節點），間距 120 m；每 10 條是主要道路 ----
const DATA = mkdtempSync(path.join(tmpdir(), 'tt-w-')), N = 140, G = 120; mkdirSync(DATA + '/graph');
const LON0 = 120.6, LAT0 = 24.1, mLat = 110574, mLon = 111320 * Math.cos(LAT0 * Math.PI / 180), ll = (x, y) => [LON0 + x / mLon, LAT0 + y / mLat];
{ const nodes = [], edges = [], roads = {}; let eid = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const [lo, la] = ll(i * G, j * G), [e, n] = tw(lo, la); nodes.push({ id: `n${i}_${j}`, x: Math.round(e * 100), y: Math.round(n * 100) }); }
  const addE = (a, b, nm) => { for (const [x, y] of [[a, b], [b, a]]) { edges.push({ from: x, to: y, w: G, edgeId: eid }); (roads[nm] = roads[nm] || { edgeIds: [] }).edgeIds.push(eid++); } };
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { if (i + 1 < N) addE(`n${i}_${j}`, `n${i + 1}_${j}`, `東西${j}路`); if (j + 1 < N) addE(`n${i}_${j}`, `n${i}_${j + 1}`, `南北${i}路`); }
  for (const [f, d] of [['nodes', nodes], ['edges', edges], ['roads', roads]]) writeFileSync(`${DATA}/graph/${f}.json`, JSON.stringify(d)); }
const STATIC = mkdtempSync(path.join(tmpdir(), 'tt-ws-')); cpSync(ROOT + '/dist', STATIC, { recursive: true });
const env = { DATA_DIR: DATA, STATIC_DIR: STATIC, CACHE_DIR: DATA + '/.cache', LOG: '0', RATE_LIMIT_PER_MIN: '100000', ADMIN_TOKEN: 'adm', WARMUP: '0' };
const P = (i, j) => { const [lo, la] = ll(i * G, j * G); return `${la.toFixed(7)},${lo.toFixed(7)}`; };
const serve = async h => { const s = http.createServer(h); await new Promise(r => s.listen(0, '127.0.0.1', r)); return { s, B: `http://127.0.0.1:${s.address().port}` }; };
const J = async (B, p, o) => { const r = await fetch(B + p, o); return { status: r.status, j: await r.json() }; };
// 主執行緒卡頓：每 5 ms 排一次計時器，記錄實際延遲的最大值
const lagDuring = async fn => { let max = 0, last = performance.now(), on = true; const tick = () => { const t = performance.now(); max = Math.max(max, t - last - 5); last = t; if (on) setTimeout(tick, 5); }; setTimeout(tick, 5); const r = await fn(); on = false; await sleep(10); return { r, lagMs: max }; };
const heavy = k => Array.from({ length: 6 }, (_, i) => `/api/v1/route?from=${P(2 + i + k, 3)}&to=${P(N - 3 - i, N - 4 - k)}&mode=car&goal=alt&steps=0`);

log0('① 背景執行緒載入路網');
const cfgW = readConfig({ ...env, WORKERS: '2' }), appW = createApp(cfgW), be = appW.backend;
ok('設定 WORKERS=2 → 使用 worker_threads', be.kind === 'worker' && be.size === 2);
const t0 = Date.now(), info = await be.load(cfgW);
ok('兩個執行緒都載入完成（第一個建封包，第二個直接讀封包）', info.loaded && info.nodes === N * N, `${info.nodes} 節點、${Date.now() - t0} ms`);
ok('主執行緒沒有載入路網（記憶體只有背景執行緒那份）', engine.dataInfo().loaded !== true);
const { s: sW, B: BW } = await serve(appW);
const h = await J(BW, '/api/v1/health');
ok('health 顯示計算模式與執行緒數', h.j.data.compute.mode === 'worker_threads' && h.j.data.compute.size === 2 && h.j.data.graph.nodes === N * N, JSON.stringify(h.j.data.compute));
const pk = await fetch(BW + '/data/graph/graph.bin', { headers: { 'accept-encoding': 'identity' } }), buf = new Uint8Array(await pk.arrayBuffer());
ok('graph.bin 由主執行緒提供（背景執行緒建好的封包）', pk.status === 200 && readPackHeader(buf).head.N === N * N);

log0('② 結果與主執行緒計算相同');
const qs = [`/api/v1/route?from=${P(3, 5)}&to=${P(120, 90)}&mode=car&goal=compare`, `/api/v1/route?from=${P(10, 100)}&to=${P(60, 2)}&mode=walk&goal=compare`, `/api/v1/multimodal?from=${P(5, 5)}&to=${P(30, 40)}&modes=car,bike,walk`];
const wRes = []; for (const q of qs) wRes.push((await J(BW, q)).j.data);
engine.loadData(cfgW); const appI = createApp(readConfig({ ...env, WORKERS: '0' })), { s: sI, B: BI } = await serve(appI);
const iRes = []; for (const q of qs) iRes.push((await J(BI, q)).j.data);
ok('三種查詢（汽車、步行、多運具）結果完全一樣', qs.every((_, i) => JSON.stringify(wRes[i]) === JSON.stringify(iRes[i])), wRes.map(r => (r.routes ? r.routes.map(x => x.durationS).join('/') : r.options.map(o => o.durationS).join('/'))).join(' ｜ '));

log0('③ 主執行緒不被卡住');
const runAll = async (B, k) => Promise.all(heavy(k).map(q => J(B, q)));
const inl = await lagDuring(() => runAll(BI, 0)), wrk = await lagDuring(() => runAll(BW, 1));
log0(`   6 個同時的長路線（ALT 替代路線）：主執行緒最長卡住 ${inl.lagMs.toFixed(0)} ms（同步計算）→ ${wrk.lagMs.toFixed(0)} ms（背景執行緒）`);
ok('背景執行緒：計算都成功', wrk.r.every(r => r.status === 200));
ok('背景執行緒：主執行緒最長卡頓 < 40 ms，且遠小於同步計算', wrk.lagMs < 40 && wrk.lagMs < inl.lagMs / 3, `${wrk.lagMs.toFixed(0)} vs ${inl.lagMs.toFixed(0)} ms`);
{ let healthMs = 0; const p = runAll(BW, 2); await sleep(5); const a = performance.now(); await J(BW, '/api/v1/health'); healthMs = performance.now() - a; await p;
  ok('長路線計算中，health 仍立即回應', healthMs < 50, healthMs.toFixed(0) + ' ms'); }
const st = be.stats(); ok('兩個執行緒都有分到工作（依忙碌程度分配）', st.jobs >= 12 && st.maxQueue >= 1, JSON.stringify(st));

log0('④ 錯誤碼照舊（跨執行緒保留 ApiError）');
const e1 = await J(BW, '/api/v1/route?from=abc&to=1,2'), e2 = await J(BW, `/api/v1/route?from=${P(3, 3)}&to=${P(3, 3)}`), e3 = await J(BW, `/api/v1/route?from=${P(3, 3)}&to=${P(9, 9)}&mode=plane`);
ok('格式錯誤 → 400 BAD_COORD 類錯誤', e1.status === 400 && /COORD|PARAM|BAD/.test(e1.j.error.code), e1.j.error.code);
ok('同一點 → 422 SAME_POINT', e2.status === 422 && e2.j.error.code === 'SAME_POINT');
ok('不支援的交通方式 → 400 BAD_MODE', e3.status === 400 && e3.j.error.code === 'BAD_MODE');

log0('⑤ 執行緒當掉／逾時會自動重開');
{ const w0 = be._workers[0]; w0.busy += 1000;                                     // 讓下一個請求一定排到另一個執行緒，確認另一個照常服務
  const pr = J(BW, heavy(3)[0]); await sleep(30); w0.busy -= 1000; await be._workers[0].terminate();
  const r = await pr; ok('其中一個執行緒結束時，另一個照常服務', r.status === 200);
  await sleep(50); const again = await J(BW, `/api/v1/route?from=${P(4, 4)}&to=${P(50, 60)}&mode=bike`);
  ok('結束的執行緒自動重開並重新載入路網，之後的請求正常', again.status === 200 && be.stats().restarts >= 1, `重開 ${be.stats().restarts} 次`); }
{ const tiny = workerBackend(cfgW, { size: 1, timeoutMs: 5 }); await tiny.load(cfgW);
  let err = null; try { await tiny.route({ from: P(1, 1), to: P(N - 2, N - 2), mode: 'car', goal: 'pareto' }); } catch (e) { err = e; }
  ok('超過時間上限 → 504 COMPUTE_TIMEOUT，並重開該執行緒', err && err.status === 504 && err.code === 'COMPUTE_TIMEOUT', err && err.code);
  await sleep(300); ok('逾時後執行緒已重開', tiny.stats().restarts === 1 && tiny.stats().timeouts === 1); await tiny.close(); }

log0('⑥ 管理：重新載入');
const rl = await J(BW, '/api/v1/admin/reload', { method: 'POST', headers: { authorization: 'Bearer adm' } });
ok('POST /admin/reload 在背景執行緒重新載入', rl.status === 200 && rl.j.data.reloaded && rl.j.data.nodes === N * N);
const after = await J(BW, `/api/v1/route?from=${P(3, 5)}&to=${P(120, 90)}&mode=car&goal=compare`);
ok('重新載入後結果不變', JSON.stringify(after.j.data) === JSON.stringify(wRes[0]));

sW.close(); sI.close(); await be.close();
log0(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
