// _tdx.mjs — 工具共用：決定 TDX token 從哪裡來（與伺服器相同的規則，金鑰不會印出來）
//   1. 環境變數 TOKEN_FILE 指到的檔案   2. server_2 根目錄的 token.txt（bus-planner 的上一層）   3. .env 的 TDX_TOKEN_URL＋TDX_API_KEY
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadDotEnv, readConfig } from '../server/config.mjs';
import { createTdxProxy } from '../server/tdx-proxy.mjs';

export function resolveToken() {
  loadDotEnv(); const cfg = readConfig();
  const files = [process.env.TOKEN_FILE, path.resolve(ROOT, '..', 'token.txt'), path.resolve(process.cwd(), 'token.txt')].filter(Boolean), file = files.find(f => existsSync(f));
  if (file) return { cfg, source: file, getToken: async () => (await readFile(file, 'utf8')).trim() };
  if (cfg.tdx.tokenUrl && cfg.tdx.apiKey) { const p = createTdxProxy(cfg.tdx); return { cfg, source: 'TDX_TOKEN_URL', getToken: force => p._token(force) }; }
  return { cfg, source: null, getToken: null };
}
