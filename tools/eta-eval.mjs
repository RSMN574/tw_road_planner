#!/usr/bin/env node
// eta-eval.mjs — 用實際導航紀錄（導航畫面「⬇ 下載行程紀錄」的 JSON）計算 ETA 的真實誤差
//   node tools/eta-eval.mjs trip-1.json trip-2.json …
// 真值＝紀錄裡「抵達」事件的時間（沒有抵達事件的行程無法評估，會略過並說明）。
// 剩餘距離：用之後的 GPS 軌跡累加做對照（含 GPS 雜訊，只能當參考）。
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.log('用法：node tools/eta-eval.mjs <行程紀錄.json> …'); process.exit(2); }
const R = 6371000, rad = d => d * Math.PI / 180, hav = (a, b) => { const x = Math.sin(rad(b[1] - a[1]) / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(rad(b[2] - a[2]) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
const stat = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = a.reduce((p, q) => p + q, 0) / a.length; return { n: a.length, mean: m, p50: s[Math.floor(s.length * 0.5)], p90: s[Math.floor(s.length * 0.9)], max: s[s.length - 1] }; };
const all = { abs: [], pct: [], bias: [], rawAbs: [], dist: [], byConf: {} };
for (const f of files) {
  let j; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.log(`✗ ${f}：讀不到 JSON（${e.message}）`); continue; }
  const arr = (j.events || []).find(e => e[1] === 'arrived');
  if (!arr) { console.log(`△ ${f}：沒有「抵達」事件（中途結束導航），無法得知實際抵達時間，略過`); continue; }
  const T = arr[0], fx = (j.fixes || []).filter(x => x[0] <= T), cum = [0]; for (let i = 1; i < fx.length; i++) cum.push(cum[i - 1] + (fx[i][3] <= 30 && fx[i - 1][3] <= 30 ? hav(fx[i - 1], fx[i]) : 0));
  const distAfter = t => { let i = fx.findIndex(x => x[0] >= t); if (i < 0) return null; return cum[cum.length - 1] - cum[i]; };
  const rows = (j.preds || []).filter(p => p[0] < T && (T - p[0]) / 1000 >= 60), loc = { abs: [], pct: [], bias: [] };
  for (const [t, remM, rawS, shownS, conf] of rows) {
    const truth = (T - t) / 1000, e = shownS - truth;
    for (const o of [all, loc]) { o.abs.push(Math.abs(e)); o.pct.push(Math.abs(e) / truth * 100); o.bias.push(e); }
    all.rawAbs.push(Math.abs(rawS - truth)); (all.byConf[conf || '—'] ??= []).push(Math.abs(e) / truth * 100);
    const d = distAfter(t); if (d != null && remM != null) all.dist.push(Math.abs(remM - d));
  }
  const a = stat(loc.abs), p = stat(loc.pct), b = stat(loc.bias);
  console.log(`✓ ${f}：${j.meta?.vehicle ?? ''} 路線 ${j.meta?.routeM ?? '?'} m，行程 ${Math.round((T - (j.meta?.startedAt ?? T)) / 60000)} 分，評估 ${rows.length} 筆｜MAE ${a ? a.mean.toFixed(0) : '—'} 秒、MAPE ${p ? p.mean.toFixed(1) : '—'}%、偏差 ${b ? (b.mean >= 0 ? '+' : '') + b.mean.toFixed(0) : '—'} 秒｜重新規劃 ${(j.events || []).filter(e => e[1] === 'rerouted').length} 次`);
}
const a = stat(all.abs), p = stat(all.pct), b = stat(all.bias), r = stat(all.rawAbs), d = stat(all.dist);
if (!a) { console.log('\n沒有可評估的資料。'); process.exit(1); }
console.log(`\n合計 ${a.n} 筆（剩餘時間 ≥ 60 秒）`);
console.log(`  顯示的 ETA：MAE ${a.mean.toFixed(0)} 秒（中位 ${a.p50.toFixed(0)}、P90 ${a.p90.toFixed(0)}、最大 ${a.max.toFixed(0)}）、MAPE ${p.mean.toFixed(1)}%、偏差 ${(b.mean >= 0 ? '+' : '') + b.mean.toFixed(0)} 秒（負＝估得太早）`);
console.log(`  未平滑的模型值：MAE ${r.mean.toFixed(0)} 秒`);
for (const [k, v] of Object.entries(all.byConf)) { const s = stat(v); console.log(`  可信度「${k}」：${s.n} 筆，MAPE ${s.mean.toFixed(1)}%`); }
if (d) console.log(`  剩餘距離 vs 之後的 GPS 軌跡長度（含 GPS 雜訊，僅供參考）：平均差 ${d.mean.toFixed(0)} m、P90 ${d.p90.toFixed(0)} m`);
