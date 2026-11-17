// static.mjs — 靜態檔：網頁（dist/）與路網資料（data/）
// ・只開放白名單路徑（不會把伺服器程式、.env、package.json 送出去）
// ・ETag + If-None-Match → 304；小檔在記憶體預先壓縮（br/gzip），大檔（路網 JSON）壓縮一次存到磁碟快取，之後直接串流
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fsp, renameSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.bin': 'application/octet-stream' };
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.bin']);
const MEM_LIMIT = 8 * 1024 * 1024;            // 8 MB 以下：記憶體壓縮快取；以上：磁碟 gzip 快取
const WEB_OK = /^(index\.html|sw\.js|manifest\.webmanifest|(css|js|icons)\/[\w.\-\/]+)$/;   // 網頁白名單
const DATA_OK = /^[\w.\-\/]+\.(json|bin)$/;                                           // data/ 只開放 .json 與路網封包 .bin

export function createStatic({ staticDir, dataDir, cacheDir, memLimit = MEM_LIMIT }) {
  const mem = new Map(), disk = new Map(), building = new Map();
  mkdirSync(cacheDir, { recursive: true });

  function resolve(urlPath) {
    let p; try { p = decodeURIComponent(urlPath); } catch { return null; }
    if (p.includes('\0') || p.includes('\\')) return null;
    p = path.posix.normalize(p).replace(/^\/+/, '');
    if (p === '' ) p = 'index.html';
    if (p.split('/').some(s => s === '..' || s.startsWith('.'))) return null;          // 擋 ../ 與隱藏檔
    let base, rel;
    if (p.startsWith('data/')) { rel = p.slice(5); if (!DATA_OK.test(rel)) return null; base = dataDir; }
    else { rel = p; if (!WEB_OK.test(rel)) return null; base = staticDir; }
    const full = path.resolve(base, rel); if (!full.startsWith(path.resolve(base) + path.sep)) return null;
    return { full, rel: p, kind: p.startsWith('data/') ? 'data' : 'web' };
  }
  function cacheControl(f) {
    if (f.kind === 'data') return 'no-cache';                                          // 路網可能更新：每次用 ETag 確認（沒變就 304）
    if (/^(index\.html|sw\.js|manifest\.webmanifest)$/.test(f.rel)) return 'no-cache';   // 入口與 Service Worker 不能被長期快取
    if (f.rel.startsWith('icons/')) return 'public, max-age=604800';
    return 'public, max-age=3600';
  }
  const accepts = (req, enc) => new RegExp(`\\b${enc}\\b`).test(String(req.headers['accept-encoding'] || ''));

  // 大檔：背景壓縮到磁碟（同一檔案只會壓一次；壓完前先送未壓縮版本）
  function diskGzip(full, st) {
    const key = `${full}|${st.size}|${st.mtimeMs}`, hit = disk.get(full);
    if (hit && hit.key === key && existsSync(hit.file)) return hit.file;
    if (!building.has(key)) {
      const file = path.join(cacheDir, crypto.createHash('sha1').update(key).digest('hex') + '.gz'), tmp = file + '.tmp';
      building.set(key, pipeline(createReadStream(full), zlib.createGzip({ level: 6 }), createWriteStream(tmp))
        .then(() => { renameSync(tmp, file); disk.set(full, { key, file }); })
        .catch(e => console.warn('預先壓縮失敗：', full, e.message)).finally(() => building.delete(key)));
    }
    return null;
  }
  async function warm(fullPaths) { await Promise.all(fullPaths.filter(existsSync).map(f => { const st = statSync(f); if (st.size > memLimit) { diskGzip(f, st); return building.get(`${f}|${st.size}|${st.mtimeMs}`); } }).filter(Boolean)); }

  async function serve(req, res, urlPath, extraHeaders = {}) {
    const f = resolve(urlPath); if (!f) return false;
    let st; try { st = await fsp.stat(f.full); } catch { return false; }
    if (!st.isFile()) return false;
    const ext = path.extname(f.full).toLowerCase(), etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl(f), ETag: etag, Vary: 'Accept-Encoding', ...extraHeaders };
    if (f.rel === 'sw.js') h['Service-Worker-Allowed'] = '/';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); res.end(); return true; }
    const head = req.method === 'HEAD';
    if (COMPRESSIBLE.has(ext) && st.size > 1024) {
      if (st.size <= memLimit) {
        const key = `${f.full}|${st.size}|${st.mtimeMs}`; let e = mem.get(f.full);
        if (!e || e.key !== key) { const raw = await fsp.readFile(f.full); e = { key, br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }), gz: zlib.gzipSync(raw, { level: 9 }) }; mem.set(f.full, e); }
        const enc = accepts(req, 'br') ? 'br' : accepts(req, 'gzip') ? 'gzip' : null;
        if (enc) { const body = enc === 'br' ? e.br : e.gz; res.writeHead(200, { ...h, 'Content-Encoding': enc, 'Content-Length': body.length }); res.end(head ? undefined : body); return true; }
      } else if (accepts(req, 'gzip')) {
        const gz = diskGzip(f.full, st);
        if (gz) { const gst = await fsp.stat(gz); res.writeHead(200, { ...h, 'Content-Encoding': 'gzip', 'Content-Length': gst.size }); if (head) res.end(); else await pipeline(createReadStream(gz), res).catch(() => {}); return true; }
      }
    }
    res.writeHead(200, { ...h, 'Content-Length': st.size });
    if (head) res.end(); else await pipeline(createReadStream(f.full), res).catch(() => {});
    return true;
  }
  return { serve, resolve, warm, stats: () => ({ memFiles: mem.size, diskFiles: disk.size, compressing: building.size }) };
}
