// 測試共用：模擬瀏覽器 DOM（只有測試用；產品程式不含任何假資料）
export const els = {};
export const el = id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false, style: {}, dataset: {}, children: [], classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, appendChild() {}, remove() {} });
export const svgS = { clientWidth: 800, clientHeight: 600, classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), set innerHTML(v) {}, insertAdjacentHTML() {}, appendChild() {} };
globalThis.document = { addEventListener() {}, querySelector: () => null, documentElement: { dataset: {} }, body: { classList: { add() {}, remove() {} } }, getElementById: id => id === 'routeSvg' ? svgS : el(id), createElementNS: () => ({ setAttribute() {} }), createElement: () => el('x') };
globalThis.window = { addEventListener() {} }; globalThis.requestAnimationFrame = f => f(); globalThis.fetch = () => Promise.reject(new Error('offline'));
globalThis.localStorage = { _: {}, getItem(k) { return this._[k] ?? null; }, setItem(k, v) { this._[k] = String(v); } };
const origErr = console.error; console.error = (...a) => { if (!/^載入 \.\//.test(String(a[0]))) origErr(...a); };
let fails = 0;
export const ok = (name, c, extra = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + name + (extra ? '｜' + extra : '')); if (!c) fails++; };
export const done = () => { console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0); };
export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export const gauss = R => Math.sqrt(-2 * Math.log(R() || 1e-9)) * Math.cos(2 * Math.PI * R());
