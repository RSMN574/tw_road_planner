// cli.mjs — OSM 工具共用的命令列參數解析
// 支援：--key value、--key=value、--no-key
// Windows PowerShell 直接打 `npm run osm:xxx -- --key value` 時，npm.ps1 會吃掉 `--`：
//   旗標名稱被 npm 當成它自己的設定（變成 npm_config_<key> 環境變數，值通常只剩 true／false），
//   值變成一般參數；沒加引號的「25.0478,121.5170」還會被 PowerShell 拆成「25.0478 121.517」。
// 這裡把這些情況都接回來：旗標也從 npm_config_* 讀，一般參數依空白、逗號拆開，交給各工具依內容認領（座標、運具名稱、.pbf 路徑、MD5）。
export function parseCli(valueKeys = [], argv = process.argv.slice(2), env = process.env) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith('--') || s === '--') { if (s !== '--') rest.push(s); continue; }
    const eq = s.indexOf('=');
    if (eq > 2) { opts[s.slice(2, eq)] = s.slice(eq + 1); continue; }
    const k = s.slice(2);
    if (valueKeys.includes(k) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[k] = argv[++i];
    else if (k.startsWith('no-')) opts[k.slice(3)] = false;
    else opts[k] = true;
  }
  // npm 吃掉的旗標：npm_config_<key>（npm 會把 - 換成 _）
  for (const k of new Set([...valueKeys, ...Object.keys(KNOWN_FLAGS)])) {
    if (opts[k] !== undefined) continue;
    const v = env['npm_config_' + k.replace(/-/g, '_')];
    if (v === undefined || v === '') continue;
    opts[k] = v === 'true' ? true : v === 'false' ? false : v;
  }
  const tokens = rest.flatMap(s => s.split(/[\s,]+/)).filter(Boolean);
  return { opts, rest, tokens, str: k => (typeof opts[k] === 'string' ? opts[k] : undefined), on: k => opts[k] === true || (typeof opts[k] === 'string' && opts[k] !== 'false') };
}
// 會被 npm 當成設定吃掉的布林旗標（從 npm_config_* 讀回來）
const KNOWN_FLAGS = { conditional: 1, osmium: 1, tags: 1, force: 1, alt: 1 };
export const isNum = s => /^-?\d+(\.\d+)?$/.test(s);
