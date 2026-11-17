// http-util.mjs — 統一回應格式、錯誤、請求參數、限流、LRU 快取、請求去重
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';

// 回應壓縮：瀏覽器支援 br／gzip 且內容 > 1 KB 時壓縮（路線幾何、公車清單這類大 JSON 可小 5～10 倍）
export function writeBody(req, res, status, headers, buf) {
  const ae = String((req && req.headers['accept-encoding']) || ''), h = { ...headers, Vary: 'Accept-Encoding' };
  if (buf.length > 1024) {
    if (/\bbr\b/.test(ae)) { buf = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } }); h['Content-Encoding'] = 'br'; }
    else if (/\bgzip\b/.test(ae)) { buf = zlib.gzipSync(buf, { level: 6 }); h['Content-Encoding'] = 'gzip'; }
  }
  h['Content-Length'] = buf.length; res.writeHead(status, h); res.end(req && req.method === 'HEAD' ? undefined : buf);
}

export class ApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
export const rid = () => randomBytes(6).toString('hex');

// 成功：{ ok:true, data, meta }；失敗：{ ok:false, error:{ code, message, details }, meta }
export function sendJson(res, status, body, extra = {}) {
  writeBody(res.req, res, status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }, Buffer.from(JSON.stringify(body)));
}
export const ok = (res, data, meta) => sendJson(res, 200, { ok: true, data, meta });
export function fail(res, e, meta = {}) {
  const status = e instanceof ApiError ? e.status : 500;
  const error = e instanceof ApiError ? { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } : { code: 'INTERNAL', message: '伺服器內部錯誤' };
  if (!(e instanceof ApiError)) console.error('[500]', e);
  sendJson(res, status, { ok: false, error, meta }, e && e.retryAfter ? { 'Retry-After': String(e.retryAfter) } : {});
}

export async function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0, over = false; const parts = [];
    req.on('data', c => { if (over) return; n += c.length; if (n > max) { over = true; parts.length = 0; reject(new ApiError(413, 'BODY_TOO_LARGE', `請求內容超過 ${max} bytes`)); } else parts.push(c); });   // 超過就丟棄其餘內容（繼續讀完，才能正常回應 413）
    req.on('end', () => { if (over) return; const s = Buffer.concat(parts).toString('utf8'); if (!s) return resolve({}); try { const j = JSON.parse(s); resolve(j && typeof j === 'object' ? j : {}); } catch { reject(new ApiError(400, 'BAD_JSON', '請求內容不是合法的 JSON')); } });
    req.on('error', reject);
  });
}
// GET 參數與 POST JSON 合併（POST 優先）
export async function params(req, url) {
  const q = Object.fromEntries(url.searchParams); if (req.method === 'POST') Object.assign(q, await readBody(req)); return q;
}

// 每個 IP 的固定視窗限流（每個視窗 N 次；預設視窗 1 分鐘）
export function rateLimiter(perMin, windowMs = 60000) {
  const m = new Map(); let sweep = Date.now(); const label = windowMs === 60000 ? '每分鐘' : `每 ${Math.round(windowMs / 60000)} 分鐘`;
  return ip => {
    if (!perMin) return; const now = Date.now(), w = Math.floor(now / windowMs);
    if (now - sweep > 2 * windowMs) { for (const [k, v] of m) if (v.w < w) m.delete(k); sweep = now; }
    let e = m.get(ip); if (!e || e.w !== w) m.set(ip, e = { w, n: 0 });
    if (++e.n > perMin) { const err = new ApiError(429, 'RATE_LIMITED', `請求太頻繁（${label}上限 ${perMin} 次），請稍後再試`); err.retryAfter = Math.ceil((windowMs - now % windowMs) / 1000); throw err; }
  };
}

// LRU（含逾時）
export class Lru {
  constructor(max = 300, ttlMs = 600000) { this.max = max; this.ttl = ttlMs; this.m = new Map(); }
  get(k) { const e = this.m.get(k); if (!e) return undefined; if (Date.now() - e.t > this.ttl) { this.m.delete(k); return undefined; } this.m.delete(k); this.m.set(k, e); return e.v; }
  set(k, v) { this.m.delete(k); this.m.set(k, { v, t: Date.now() }); while (this.m.size > this.max) this.m.delete(this.m.keys().next().value); }
  clear() { this.m.clear(); }
  get size() { return this.m.size; }
}

// 請求去重：相同 key 的請求還在進行中，就共用同一個結果（不重複計算／不重複打上游）
export function deduper() {
  const inflight = new Map();
  const run = (key, fn) => { let p = inflight.get(key); if (p) { run.shared++; return p; } p = Promise.resolve().then(fn).finally(() => inflight.delete(key)); inflight.set(key, p); return p; };
  run.shared = 0; run.inflight = inflight; return run;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) { const f = req.headers['x-forwarded-for']; if (f) return String(f).split(',')[0].trim(); }
  return req.socket.remoteAddress || '?';
}
