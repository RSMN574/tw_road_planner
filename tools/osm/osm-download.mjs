#!/usr/bin/env node
// osm-download.mjs — 下載 Geofabrik 台灣 OSM PBF，驗證 MD5 與檔案完整性，保留原始檔並記錄來源版本
//
//   node tools/osm/osm-download.mjs
//   選項：--url https://download.geofabrik.de/asia/taiwan-latest.osm.pbf   --dir data/osm/raw   --force（MD5 跟上次一樣也重新下載）
//
// 檔名用 PBF 表頭裡的資料時間：taiwan-YYYYMMDD.osm.pbf（不覆蓋舊檔）；data/osm/raw/manifest.json 記錄每一次下載：
//   來源網址、下載時間、HTTP Last-Modified／ETag、大小、MD5（Geofabrik 提供的與實際計算的）、PBF 資料時間與序號、產生程式、範圍
import { fileURLToPath } from 'node:url';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCli } from './cli.mjs';
import { readHeader } from '../../server/osm/pbf.mjs';

const cli = parseCli(['url', 'dir']), arg = (k, d) => cli.str(k) ?? d, has = k => cli.on(k);   // 參數解析見 cli.mjs（PowerShell＋npm 也認得）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const url = arg('url', 'https://download.geofabrik.de/asia/taiwan-latest.osm.pbf'), dir = path.resolve(arg('dir', path.join(ROOT, 'data/osm/raw')));
mkdirSync(dir, { recursive: true });
const manPath = path.join(dir, 'manifest.json'), man = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : { downloads: [] };

const md5r = await fetch(url + '.md5');
if (!md5r.ok) { console.error(`✗ 取不到 MD5（${url}.md5：HTTP ${md5r.status}）`); process.exit(1); }
const md5Expected = (await md5r.text()).trim().split(/\s+/)[0].toLowerCase();
if (!/^[0-9a-f]{32}$/.test(md5Expected)) { console.error('✗ MD5 檔內容不對：' + md5Expected); process.exit(1); }
const last = man.downloads[man.downloads.length - 1];
if (last && last.md5 === md5Expected && existsSync(path.join(dir, last.file)) && !has('force')) { console.log(`沒有新版本：${last.file}（MD5 ${md5Expected}、資料時間 ${last.pbf.replicationTimestamp}）。要重新下載請加 --force`); process.exit(0); }

const res = await fetch(url);
if (!res.ok) { console.error(`✗ 下載失敗：HTTP ${res.status}`); process.exit(1); }
const total = +res.headers.get('content-length') || 0, part = path.join(dir, `download-${Date.now()}.osm.pbf.part`), out = createWriteStream(part), h = createHash('md5');
let got = 0, lastLog = 0; const t0 = Date.now();
console.log(`下載 ${url}${total ? `（${(total / 1048576).toFixed(0)} MB）` : ''}…`);
try {
  for await (const chunk of res.body) {
    h.update(chunk); got += chunk.length;
    if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    if (Date.now() - lastLog > 5000) { lastLog = Date.now(); console.log(`  … ${(got / 1048576).toFixed(0)} MB${total ? `（${(100 * got / total).toFixed(0)}%）` : ''}`); }
  }
  await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
} catch (e) { try { unlinkSync(part); } catch {} console.error('✗ 下載中斷：' + e.message); process.exit(1); }
const md5 = h.digest('hex');
if (total && got !== total) { unlinkSync(part); console.error(`✗ 大小不符：收到 ${got}、應為 ${total}`); process.exit(1); }
if (md5 !== md5Expected) { unlinkSync(part); console.error(`✗ MD5 不符：計算 ${md5}、Geofabrik ${md5Expected}（檔案已刪除，請重新下載）`); process.exit(1); }
let hd; try { hd = readHeader(part); } catch (e) { unlinkSync(part); console.error('✗ 不是有效的 PBF：' + e.message); process.exit(1); }
const ts = hd.replication.timestamp || res.headers.get('last-modified') || new Date().toISOString(), day = new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');
let file = `taiwan-${day}.osm.pbf`; if (existsSync(path.join(dir, file))) file = `taiwan-${day}-${md5.slice(0, 8)}.osm.pbf`;
renameSync(part, path.join(dir, file));
const rec = { file, url, downloadedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), lastModified: res.headers.get('last-modified'), etag: res.headers.get('etag'), bytes: got, md5, md5Verified: true,
  pbf: { replicationTimestamp: hd.replication.timestamp || null, sequence: hd.replication.sequence ?? null, baseUrl: hd.replication.baseUrl || null, writingProgram: hd.writingProgram, bbox: hd.bbox, required: hd.required, optional: hd.optional } };
man.downloads.push(rec); writeFileSync(manPath + '.tmp', JSON.stringify(man, null, 2)); renameSync(manPath + '.tmp', manPath);
console.log(`✅ ${file}：${(got / 1048576).toFixed(1)} MB、MD5 ${md5}（與 Geofabrik 相符）、資料時間 ${rec.pbf.replicationTimestamp || '未記錄'}、序號 ${rec.pbf.sequence ?? '—'}`);
console.log(`   紀錄：${manPath}；下一步：node tools/osm/osm-build.mjs`);
