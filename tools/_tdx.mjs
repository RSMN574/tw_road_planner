// _tdx.mjs — 工具共用：決定 TDX token 從哪裡來（與伺服器相同的規則，金鑰不會印出來）
//   1. 環境變數 TOKEN_FILE 指到的檔案   2. server_2 根目錄的 token.txt（bus-planner 的上一層）   3. 專案根目錄的 token.txt
//   4. .env 的 TDX_CLIENT_ID＋TDX_CLIENT_SECRET（v1.11：直接向 TDX 官方 OAuth 取 token，TDX 會員中心「API 金鑰」的 Client Id／Client Secret）
//   5. .env 的 TDX_TOKEN_URL＋TDX_API_KEY（自架的 token 端點，例如 server_2 的 /tokens）
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadDotEnv, readConfig } from '../server/config.mjs';
import { createTdxProxy } from '../server/tdx-proxy.mjs';

export const TDX_AUTH_URL = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token';

// Client Credentials：token 快取到過期前 5 分鐘；401 時呼叫端會傳 force=true 重新取
export function clientCredentials(id, secret, { url = process.env.TDX_AUTH_URL || TDX_AUTH_URL, fetchImpl = globalThis.fetch } = {}) {
  let tok = null, exp = 0;
  return async (force = false) => {
    if (!force && tok && Date.now() < exp) return tok;
    const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString() });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch { /* 不是 JSON */ }
    if (!r.ok || !j || !j.access_token) throw new Error(`TDX 取 token 失敗（HTTP ${r.status}${j && j.error ? '：' + j.error + (j.error_description ? ' ' + j.error_description : '') : ''}）；請確認 TDX_CLIENT_ID／TDX_CLIENT_SECRET`);
    tok = j.access_token; exp = Date.now() + Math.max(60, (Number(j.expires_in) || 3600) - 300) * 1000; return tok;
  };
}

export function resolveToken() {
  loadDotEnv(); const cfg = readConfig();
  const files = [process.env.TOKEN_FILE, path.resolve(ROOT, '..', 'token.txt'), path.resolve(ROOT, 'token.txt')].filter(Boolean), file = files.find(f => existsSync(f));
  if (file) return { cfg, source: file, getToken: async () => (await readFile(file, 'utf8')).trim() };
  if (process.env.TDX_CLIENT_ID && process.env.TDX_CLIENT_SECRET) return { cfg, source: 'TDX_CLIENT_ID', getToken: clientCredentials(process.env.TDX_CLIENT_ID.trim(), process.env.TDX_CLIENT_SECRET.trim()) };
  if (cfg.tdx.tokenUrl && cfg.tdx.apiKey) { const p = createTdxProxy(cfg.tdx); return { cfg, source: 'TDX_TOKEN_URL', getToken: force => p._token(force) }; }
  return { cfg, source: null, getToken: null };
}
