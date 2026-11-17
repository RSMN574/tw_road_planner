// proxy.mjs — 獨立的 TDX 代理（零依賴，Node ≥ 18）。如果已經用 server/server.mjs 部署，就不需要這支：伺服器內建同樣的代理（/tdx）。
// 啟動：TOKEN_URL=https://rsmn574.com/tokens API_KEY=你的金鑰 node proxy.mjs
// 頁面「Proxy 網址」填 http://localhost:8787 即可。
import http from 'node:http';
import { createTdxProxy } from './server/tdx-proxy.mjs';
const { TOKEN_URL, API_KEY, TS = '', PORT = '8787', HOST = '127.0.0.1', ORIGIN = '*', UPSTREAM = 'https://tdx.transportdata.tw/api/basic/v2' } = process.env;
if (!TOKEN_URL || !API_KEY) { console.error('請設定環境變數 TOKEN_URL 與 API_KEY'); process.exit(1); }
const tdx = createTdxProxy({ tokenUrl: TOKEN_URL, apiKey: API_KEY, ts: TS, upstream: UPSTREAM });
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Accept', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '600' };
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method !== 'GET' || !req.url.startsWith('/api/')) { res.writeHead(404, cors); return res.end('Not found'); }
  try { const r = await tdx.handle(req.url.slice(4)); res.writeHead(r.status, { ...cors, 'Content-Type': r.type }); res.end(r.body); }
  catch (e) { res.writeHead(e.status || 502, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message), code: e.code })); }
});
server.listen(+PORT, HOST, () => console.log(`TDX proxy：http://${HOST}:${server.address().port}  →  ${UPSTREAM}`));
