// build.mjs — 零依賴打包：把 js/*.js 依 import 順序合併成單一 dist/index.html（CSS、JS 全內嵌，可直接雙擊開啟）
// 用法：node build.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
const mods = Object.fromEntries(readdirSync('js').filter(f => f.endsWith('.js')).map(f => [f.slice(0, -3), readFileSync(`js/${f}`, 'utf8')]));
const deps = m => [...mods[m].matchAll(/^import .*? from '\.\/([\w-]+)\.js';$/gm)].map(x => x[1]);
const order = [], seen = new Set();
const visit = m => { if (seen.has(m)) return; seen.add(m); deps(m).forEach(visit); order.push(m); };   // 無循環，所以簡單的 DFS 後序就是合法順序
Object.keys(mods).filter(m => m !== 'main').forEach(visit); visit('main');
const strip = (m, t) => t.replace(/^import .*?;\n/gm, '')
  .replace(/^export function init\(\)/m, `function init_${m.replace(/-/g, '_')}()`)      // 各模組的 init 改成不重名
  .replace(/^export (async function\*?|function\*?|const|let|class) ?/gm, (m, k) => k + (k.endsWith('*') ? ' ' : ' '));
const js = order.map(m => `// ---- ${m}.js ----\n${strip(m, mods[m])}`).join('\n');
if (/^(import|export) /m.test(js)) { console.error('✗ 打包失敗：仍有未處理的 import/export'); process.exit(1); }   // 不要悄悄產出壞檔
import vm from 'node:vm';
try { new vm.Script(js); } catch (e) { console.error('✗ 打包失敗：合併後的程式無法解析（常見原因：兩個模組有同名的頂層變數）\n  ' + e.message); process.exit(1); }
const css = readFileSync('css/app.css', 'utf8');
let html = readFileSync('index.html', 'utf8')
  .replace('<link rel="stylesheet" href="css/app.css">', () => `<style>\n${css}</style>`)
  .replace('<script type="module" src="js/main.js"></script>', () => `<script>\n${js}\n</script>`);
mkdirSync('dist', { recursive: true }); writeFileSync('dist/index.html', html);
// PWA 靜態檔一併複製到 dist（Service Worker 與 manifest 不能內嵌進 HTML）
import { cpSync, existsSync } from 'node:fs';
for (const f of ['sw.js', 'manifest.webmanifest']) if (existsSync(f)) cpSync(f, `dist/${f}`);
if (existsSync('icons')) cpSync('icons', 'dist/icons', { recursive: true });
console.log(`dist/index.html 已產生：${order.length} 個模組，${(html.length / 1024).toFixed(0)} KB`);
