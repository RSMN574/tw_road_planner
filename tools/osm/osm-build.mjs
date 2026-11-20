#!/usr/bin/env node
// osm-build.mjs — 從台灣 OSM PBF 建立道路拓樸圖（汽車、大型重機、機車、自行車、步行共用一套圖）
//
//   node --max-old-space-size=4096 tools/osm/osm-build.mjs
//   選項：--pbf <檔案>（預設：data/osm/raw 下載紀錄的最新一筆；沒有紀錄就用資料夾裡最新的 *.osm.pbf）  --md5 <值>（手動下載時用 Geofabrik 的 MD5 驗證）  --raw <資料夾>  --out data/osm/graph  --no-osmium  --no-alt（不建地標表）  --tags（另存每條道路的原始標籤）
//
// 1. 有安裝 osmium-tool 時先用 osmium tags-filter 只留道路、轉向限制與它們的 node（檔案小很多、建圖快）；沒有就直接讀原檔（兩趟）
// 2. 建圖（server/osm/topology.mjs）、檢查（validate.mjs）
// 3. 輸出到 data/osm/graph/<資料日期>/：osm-graph.twosm、manifest.json、report.json、report.md（不覆蓋舊的建置），最後才更新 current.json
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, statSync, createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCli } from './cli.mjs';
import { buildTopology } from '../../server/osm/topology.mjs';
import { writeGraph, readGraphHead } from '../../server/osm/graph-file.mjs';
import { OsmRouter } from '../../server/osm/router.mjs';
import { buildAlt, writeAlt } from '../../server/osm/alt.mjs';
import { PROFILES } from '../../server/osm/access.mjs';
import { validateGraph, reportMarkdown } from '../../server/osm/validate.mjs';

// 參數（cli.mjs）：PowerShell 用 npm run 時旗標會被 npm 吃掉，.pbf 路徑、32 碼 MD5 會變成一般參數 → 依內容認回來
const cli = parseCli(['pbf', 'md5', 'raw', 'out']), arg = (k, d) => cli.str(k) ?? d;
const pbfArg = arg('pbf') || cli.rest.map(x => x.trim()).find(x => /\.osm\.pbf$/i.test(x)), md5Arg = (arg('md5') || cli.tokens.find(x => /^[0-9a-f]{32}$/i.test(x)) || '').trim().toLowerCase();
const noOsmium = cli.opts.osmium === false, keepTags = cli.on('tags');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), rawDir = path.resolve(arg('raw', path.join(ROOT, 'data/osm/raw'))), outRoot = path.resolve(arg('out', path.join(ROOT, 'data/osm/graph')));
const md5File = f => new Promise((r, j) => { const h = createHash('md5'); createReadStream(f).on('data', d => h.update(d)).on('end', () => r(h.digest('hex'))).on('error', j); });
const mp = path.join(rawDir, 'manifest.json'), man = existsSync(mp) ? JSON.parse(readFileSync(mp, 'utf8')) : { downloads: [] };
let pbf = pbfArg, src = null;
if (!pbf) {
  // 1) 下載工具的紀錄；2) 沒有紀錄時，找 data/osm/raw 裡最新的 *.osm.pbf（例如用瀏覽器手動下載後放進來的）
  const cand = existsSync(rawDir) ? readdirSync(rawDir).filter(f => f.endsWith('.osm.pbf')).map(f => ({ f, t: statSync(path.join(rawDir, f)).mtimeMs })).sort((a, b) => b.t - a.t || b.f.localeCompare(a.f)) : [];   // 修改時間相同（Windows 複製檔案會保留時間）時，檔名日期較新的優先
  if (man.downloads.length && existsSync(path.join(rawDir, man.downloads.at(-1).file)) && (!cand.length || cand[0].f === man.downloads.at(-1).file)) src = man.downloads.at(-1);
  else if (cand.length) { pbf = path.join(rawDir, cand[0].f); console.log(`使用 ${pbf}${cand.length > 1 ? `（資料夾裡最新的；共 ${cand.length} 個）` : ''}`); }
  else {
    console.error(`✗ 找不到 OSM 檔案。三種做法擇一：
   1. 把 taiwan-*.osm.pbf 放進 ${rawDir}，再執行一次
   2. 指定檔案：npm run osm:build -- --pbf "C:\路徑\taiwan-20261117.osm.pbf"
   3. 用工具下載（會驗證 MD5）：npm run osm:download`); process.exit(2);
  }
  if (src) pbf = path.join(rawDir, src.file);
}
pbf = path.resolve(pbf); if (!existsSync(pbf)) { console.error('✗ 找不到 ' + pbf); process.exit(2); }
if (!src) src = man.downloads.find(d => path.resolve(rawDir, d.file) === pbf) || null;
// MD5：下載紀錄有就比對；手動下載的檔案可用 --md5 <值>（Geofabrik 網頁上的 .md5）或放在旁邊的 .md5 檔驗證
const md5 = await md5File(pbf);
if (src && src.md5) {
  if (md5 !== src.md5) { console.error(`✗ ${path.basename(pbf)} 的 MD5（${md5}）跟下載紀錄（${src.md5}）不同，檔案可能被改過或損毀`); process.exit(1); }
  const want = md5Arg;
  if (want && want !== md5) { console.error(`✗ MD5 不符：檔案 ${md5}、--md5 ${want}（下載不完整或檔案損毀，請重新下載）`); process.exit(1); }
  if (want && !src.md5Verified) { src.md5Verified = true; src.md5VerifiedWith = '--md5'; writeFileSync(mp, JSON.stringify(man, null, 2)); }   // 手動下載的檔案補驗證：記進下載紀錄
  console.log(src.md5Verified ? `原始檔 MD5 相符：${md5}（已與 Geofabrik 官方 MD5 比對）` : `原始檔 MD5 與登記時相同：${md5}（手動下載，尚未與 Geofabrik 官方 MD5 比對；可加 --md5 <值> 驗證）`);
}
else {
  const side = [pbf + '.md5', path.join(path.dirname(pbf), 'taiwan-latest.osm.pbf.md5')].find(f => existsSync(f)), want = (md5Arg || (side ? readFileSync(side, 'utf8') : '')).trim().split(/\s+/)[0].toLowerCase();
  if (want) { if (want !== md5) { console.error(`✗ MD5 不符：檔案 ${md5}、應為 ${want}（下載不完整或檔案損毀，請重新下載）`); process.exit(1); } console.log(`原始檔 MD5 相符：${md5}（${md5Arg ? '--md5' : path.basename(side)}）`); }
  else console.log(`⚠ 沒有官方 MD5 可比對（手動下載的檔案）；檔案 MD5：${md5}。可到 Geofabrik 網頁核對，或下次加 --md5 <值>。建圖時仍會逐一檢查每個資料區塊，檔案不完整會停下來。`);
  // 手動放進 data/osm/raw 的檔案也記一筆，之後建圖、報告都查得到來源與版本
  if (path.dirname(pbf) === rawDir && !man.downloads.some(d => d.file === path.basename(pbf))) {
    const { readHeader } = await import('../../server/osm/pbf.mjs'); let hd = null; try { hd = readHeader(pbf); } catch (e) { console.error('✗ 不是有效的 OSM PBF：' + e.message); process.exit(1); }
    src = { file: path.basename(pbf), url: 'manual', downloadedAt: new Date(statSync(pbf).mtimeMs).toISOString(), registeredAt: new Date().toISOString(), bytes: statSync(pbf).size, md5, md5Verified: !!want,
      pbf: { replicationTimestamp: hd.replication.timestamp || null, sequence: hd.replication.sequence ?? null, baseUrl: hd.replication.baseUrl || null, writingProgram: hd.writingProgram, bbox: hd.bbox } };
    man.downloads.push(src); writeFileSync(mp + '.tmp', JSON.stringify(man, null, 2)); renameSync(mp + '.tmp', mp);
    console.log(`已記錄到 ${mp}（資料時間 ${src.pbf.replicationTimestamp || '檔案未記錄'}）`);
  }
}

// ---------- 1. osmium 預先篩選 ----------
let input = pbf, osmium = null;
if (!noOsmium) {
  const v = spawnSync('osmium', ['--version'], { encoding: 'utf8' });
  if (v.status === 0) {
    osmium = v.stdout.split('\n')[0].trim(); const work = path.join(outRoot, '_work'); mkdirSync(work, { recursive: true });
    const filtered = path.join(work, path.basename(pbf).replace(/\.osm\.pbf$/, '') + '-roads.osm.pbf'), t0 = Date.now();
    console.log(`osmium tags-filter（${osmium}）：只留 highway、渡輪、轉向限制…`);
    const r = spawnSync('osmium', ['tags-filter', pbf, 'w/highway', 'w/route=ferry', 'r/type=restriction', 'r/type=restriction:*', '-o', filtered, '--overwrite'], { stdio: 'inherit' });
    if (r.status !== 0) { console.error('✗ osmium tags-filter 失敗；可加 --no-osmium 直接讀原檔'); process.exit(1); }
    console.log(`  ${(statSync(pbf).size / 1048576).toFixed(0)} MB → ${(statSync(filtered).size / 1048576).toFixed(0)} MB（${(Date.now() - t0) / 1000} 秒）`);
    input = filtered;
  } else console.log('沒有安裝 osmium-tool（apt install osmium-tool），改用內建讀取器直接讀原檔（較慢，但結果相同）');
}

// ---------- 2. 建圖 ----------
const t0 = Date.now(), mem0 = process.memoryUsage().rss;
const g = buildTopology(input, { log: console.log, tagsFile: keepTags ? path.join(outRoot, '_work', 'ways-tags.ndjson.gz') : null });
const day = (g.header.replication.timestamp || new Date().toISOString()).slice(0, 10).replace(/-/g, ''), dir = path.join(outRoot, day); mkdirSync(dir, { recursive: true });
console.log('檢查連通性與通行狀態…');
const router = new OsmRouter(g), rep = validateGraph(g, router);
const meta = { source: src ? (src.url === 'manual' ? '手動下載：' + src.file : src.url) : pbf, sourceFile: path.basename(pbf), sourceMd5: md5, sourceMd5Verified: !!(src ? src.md5Verified : false), downloadedAt: src?.downloadedAt || null, dataTimestamp: g.header.replication.timestamp || null, sequence: g.header.replication.sequence ?? null,
  filteredWith: osmium, builtAt: new Date().toISOString(), node: process.version, builder: 'bus-planner server/osm/topology.mjs' };
const gf = path.join(dir, 'osm-graph.twosm'), w = writeGraph(gf, g, meta);
const check = readGraphHead(gf); if (check.counts.vertices !== g.V.n || check.counts.edges !== g.E.n) { console.error('✗ 寫出的圖檔表頭與記憶體中的圖不一致'); process.exit(1); }
// ---------- 3. 地標表（ALT：全台長距離路線加速；--no-alt 可略過）----------
let alt = null;
if (cli.opts.alt !== false) {
  console.log('地標表（ALT，長距離路線加速）…'); const ta = Date.now(), tables = {};
  for (const p of PROFILES) tables[p.key] = buildAlt(router, p.key, { log: console.log });
  const af = path.join(dir, 'osm-alt.bin'), aw = writeAlt(af, tables, { graphCreated: check.created });
  alt = { file: 'osm-alt.bin', bytes: aw.bytes, seconds: (Date.now() - ta) / 1000, profiles: Object.fromEntries(Object.entries(tables).filter(([, t]) => t).map(([k, t]) => [k, { landmarks: t.k, unitS: t.unit }])) };
}
const peakMB = (() => { try { const m = /VmHWM:\s+(\d+) kB/.exec(readFileSync('/proc/self/status', 'utf8')); return m ? Math.round(+m[1] / 1024) : null; } catch { return null; } })();
const manifest = { ...meta, graph: { file: 'osm-graph.twosm', bytes: w.bytes, md5: await md5File(gf) }, alt, counts: check.counts, buildSeconds: (Date.now() - t0) / 1000, peakRssMB: peakMB ?? Math.round(Math.max(mem0, process.memoryUsage().rss) / 1048576) };
writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ stats: g.stats, restrictions: { stats: g.restrictions.stats, skipped: g.restrictions.skipped }, validation: rep }, null, 1));
writeFileSync(path.join(dir, 'report.md'), reportMarkdown(g, rep, meta));
const cur = path.join(outRoot, 'current.json'); writeFileSync(cur + '.tmp', JSON.stringify({ dir: day, graph: day + '/osm-graph.twosm', dataTimestamp: meta.dataTimestamp, builtAt: meta.builtAt }, null, 2)); renameSync(cur + '.tmp', cur);
console.log(`✅ ${g.V.n.toLocaleString()} 個頂點、${g.E.n.toLocaleString()} 條邊、轉向限制 ${g.restrictions.stats.applied.toLocaleString()} 筆（${g.restrictions.rules.length.toLocaleString()} 條轉彎規則）；圖檔 ${(w.bytes / 1048576).toFixed(1)} MB；${manifest.buildSeconds} 秒；記憶體峰值 ${manifest.peakRssMB} MB`);
if (alt) console.log(`   地標表 ${(alt.bytes / 1048576).toFixed(1)} MB（${alt.seconds} 秒）`);
console.log(`   ${dir}/report.md`);
