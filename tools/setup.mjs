#!/usr/bin/env node
// setup.mjs — 一鍵安裝：檢查環境 → npm install → 建立 .env → 打包網頁 →（選用）下載台灣 OSM 並建立道路圖、地標表、建築、店家地點 →（選用）TDX 大眾運輸與道路事件 →（選用）測試、啟動
//
//   npm run setup                    互動式（每個大步驟會先問）
//   npm run setup -- --yes           全部用預設答案（含下載與建立地圖資料）
//   npm run setup -- --no-data       只裝程式，不下載地圖資料
//   npm run setup -- --transit       同步 TDX 大眾運輸與道路事件（需要 .env 裡的 TDX 金鑰）
//   npm run setup -- --test --start  裝好後跑測試、啟動伺服器
//   npm run setup -- --force         已有的地圖資料也重建
// Windows 可直接雙擊 install.cmd；macOS／Linux：sh install.sh（這兩個會先確認有沒有 Node.js）
//
// 原則：不覆蓋既有的 .env 與資料；每一步失敗就停下，印出可以單獨重跑的指令；不會自動 commit、不會刪任何檔案。
import { existsSync, copyFileSync, readFileSync, readdirSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), has = f => argv.includes(f);
const YES = has('--yes') || has('-y'), FORCE = has('--force');
const isWin = process.platform === 'win32', tty = process.stdin.isTTY && process.stdout.isTTY;
const C = { b: s => `\x1b[1m${s}\x1b[0m`, g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, d: s => `\x1b[2m${s}\x1b[0m` };
const t0 = Date.now(), done = [], skipped = [];
let stepNo = 0;
const step = t => console.log('\n' + C.b(`[${++stepNo}] ${t}`));
const info = t => console.log('    ' + t), warn = t => console.log('    ' + C.y('⚠ ' + t)), ok = t => console.log('    ' + C.g('✓ ' + t));
function fail(msg, retry) { console.log('\n' + C.r('✗ ' + msg)); if (retry) console.log('  修正後可以單獨重跑：' + C.b(retry) + '，或再執行一次安裝（已完成的步驟會略過）'); process.exit(1); }

// 執行指令（顯示輸出）；npm 在 Windows 要經過 shell
function run(cmd, args, { retry, env } = {}) {
  console.log(C.d(`    $ ${cmd} ${args.join(' ')}`));
  const s = Date.now(), r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin && /^npm$/.test(cmd), env: { ...process.env, ...env } });
  if (r.error) fail(`無法執行 ${cmd}：${r.error.message}`, retry);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} 失敗（結束代碼 ${r.status}）`, retry || `${cmd} ${args.join(' ')}`);
  return (Date.now() - s) / 1000;
}
let rl = null;
async function ask(q, def = true) {
  if (has('--no-' + q.key)) return false; if (has('--' + q.key)) return true;
  if (YES) return def; if (!tty) return false;                                  // 不是互動式終端機、也沒指定：選用步驟一律略過
  rl = rl || createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`    ${q.text} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
  return a ? /^y/.test(a) : def;
}
const gb = n => (n / 1024 ** 3).toFixed(1) + ' GB';
const exists = p => existsSync(path.join(ROOT, p));
function curGraphDir() { try { const c = JSON.parse(readFileSync(path.join(ROOT, 'data/osm/graph/current.json'), 'utf8')); return path.join('data/osm/graph', c.dir); } catch { return null; } }
function envHasTdx() {
  const e = { ...process.env }; try { for (const l of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !(m[1] in e)) e[m[1]] = m[2]; } } catch { /* 沒有 .env */ }
  return !!((e.TDX_TOKEN_URL && e.TDX_API_KEY) || (e.TDX_CLIENT_ID && e.TDX_CLIENT_SECRET) || e.TOKEN_FILE);
}

console.log(C.b('台灣通 一鍵安裝') + C.d(`（${ROOT}）`));

// ---------- 1. 環境 ----------
step('檢查環境');
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 18) fail(`Node.js ${process.versions.node} 太舊，需要 18 以上（建議 22 LTS）`, null);
ok(`Node.js ${process.versions.node}${maj < 22 || (maj === 22 && min < 15) ? C.y('（可用；若 OSM 檔改成 zstd 壓縮需要 22.15 以上）') : ''}`);
const npmV = spawnSync('npm', ['--version'], { shell: isWin, encoding: 'utf8' });
if (npmV.status !== 0) fail('找不到 npm（通常和 Node.js 一起安裝）', null); ok(`npm ${npmV.stdout.trim()}`);
const mem = os.totalmem(); ok(`記憶體 ${gb(mem)}、CPU ${os.cpus().length} 核`);
if (mem < 7.5 * 1024 ** 3) warn('記憶體小於 8 GB：建立全台資料（建築、店家地點峰值約 4～6 GB）可能失敗，可以只建道路圖或改在較大的機器上建');
let freeDisk = Infinity; try { const s = statfsSync(ROOT); freeDisk = s.bavail * s.bsize; ok(`磁碟可用 ${gb(freeDisk)}`); } catch { /* 舊版 Node 沒有 statfs */ }

// ---------- 2. 套件 ----------
step('安裝套件（npm install）');
info('本專案沒有外部套件（零依賴），這一步只確認 npm 正常');
run('npm', ['install', '--no-audit', '--no-fund'], { retry: 'npm install' }); done.push('npm install');

// ---------- 3. 設定檔 ----------
step('設定檔 .env');
if (exists('.env')) ok('已有 .env（不覆蓋）');
else if (exists('.env.example')) { copyFileSync(path.join(ROOT, '.env.example'), path.join(ROOT, '.env')); ok('已從 .env.example 建立 .env（全部是預設值，可以直接啟動）'); done.push('.env'); }
else warn('沒有 .env.example，略過');
info(C.d('TDX（大眾運輸、道路事件）需要在 .env 填 TDX_TOKEN_URL＋TDX_API_KEY，或 TDX_CLIENT_ID＋TDX_CLIENT_SECRET；.env 不要提交到 git'));

// ---------- 4. 打包網頁 ----------
step('打包網頁（dist/）');
run(process.execPath, ['build.mjs'], { retry: 'npm run build' }); done.push('打包網頁');

// ---------- 5. 地圖資料 ----------
step('全台地圖資料（OpenStreetMap）');
const gdir = curGraphDir(), haveGraph = !!gdir && exists(path.join(gdir, 'osm-graph.twosm'));
const haveBld = haveGraph && exists(path.join(gdir, 'osm-buildings.twbld')), havePoi = haveGraph && exists(path.join(gdir, 'osm-poi.json.gz'));
if (haveGraph) ok(`已有道路圖 ${gdir}${haveBld ? '、建築' : ''}${havePoi ? '、店家地點' : ''}`);
if (!(haveGraph && haveBld && havePoi) || FORCE) info('下載台灣 OSM（約 300 MB，時間依網路）＋建道路圖與地標表（約 1～2 分鐘）、建築（約 40 秒）、店家地點（約 40 秒），完成後約佔 850 MB；資料 © OpenStreetMap contributors（ODbL）');
if (freeDisk < 2 * 1024 ** 3) warn('磁碟可用空間小於 2 GB');
const wantData = has('--no-data') ? false : haveGraph && haveBld && havePoi && !FORCE ? false : await ask({ key: 'data', text: haveGraph ? '補齊／更新地圖資料？' : '下載並建立全台地圖資料？' }, true);
if (!wantData) { if (!(haveGraph && haveBld && havePoi) || FORCE) { skipped.push('地圖資料（之後可執行：npm run setup -- --data）'); info('略過。沒有道路圖時網頁仍可開，但全台路線、搜尋需要這份資料'); } }
else {
  const rawOk = exists('data/osm/raw') && readdirSafe('data/osm/raw').some(f => f.endsWith('.osm.pbf'));
  if (!rawOk || FORCE) { run(process.execPath, ['tools/osm/osm-download.mjs'], { retry: 'npm run osm:download' }); done.push('下載 OSM'); } else ok('已有 OSM 原始檔（data/osm/raw），不重新下載（要更新請加 --force）');
  if (!haveGraph || FORCE) { run(process.execPath, ['--max-old-space-size=4096', 'tools/osm/osm-build.mjs'], { retry: 'npm run osm:build' }); done.push('道路圖＋地標表'); } else ok('道路圖已存在');
  if (!haveBld || FORCE) { run(process.execPath, ['--max-old-space-size=6144', 'tools/osm/osm-buildings.mjs'], { retry: 'npm run osm:buildings' }); done.push('建築'); } else ok('建築已存在');
  if (!havePoi || FORCE) { run(process.execPath, ['--max-old-space-size=6144', 'tools/osm/osm-poi.mjs'], { retry: 'npm run osm:poi' }); done.push('店家地點'); } else ok('店家地點已存在');
}
function readdirSafe(d) { try { return readdirSync(path.join(ROOT, d)); } catch { return []; } }

// ---------- 6. TDX ----------
step('大眾運輸與道路事件（TDX，選用）');
if (!envHasTdx()) { info('.env 沒有 TDX 金鑰，略過（填好後執行：npm run setup -- --transit）'); if (has('--transit')) warn('指定了 --transit 但沒有金鑰'); skipped.push('TDX 同步'); }
else if (await ask({ key: 'transit', text: '同步全台大眾運輸（台鐵、高鐵、捷運、輕軌、台北公車）與道路事件？約 2～5 分鐘' }, false)) {
  run(process.execPath, ['tools/transit-sync.mjs', '--city', 'Taipei', '--operators', 'TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT', '--rail', 'TRA,THSR', '--extras'], { retry: 'npm run transit:sync -- --city Taipei --operators TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT --rail TRA,THSR --extras' });
  run(process.execPath, ['tools/traffic-sync.mjs'], { retry: 'npm run traffic:sync' }); done.push('TDX 同步');
} else { info('略過'); skipped.push('TDX 同步'); }

// ---------- 7. 測試 ----------
step('測試（選用，約 3～6 分鐘）');
if (await ask({ key: 'test', text: '執行全部測試（npm test）？' }, false)) { run('npm', ['test'], { retry: 'npm test' }); done.push('測試全部通過'); } else { info('略過'); skipped.push('測試'); }

if (rl) rl.close();
console.log('\n' + C.g(C.b(`✅ 安裝完成（${Math.round((Date.now() - t0) / 1000)} 秒）`)));
if (done.length) console.log('   完成：' + done.join('、'));
if (skipped.length) console.log('   略過：' + skipped.join('、'));
console.log(`   啟動：${C.b('npm start')} → 開 http://localhost:8080（埠號可在 .env 的 PORT 修改）`);
if (has('--start')) { console.log(''); run('npm', ['start']); }
