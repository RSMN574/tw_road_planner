// scc.mjs — 強連通分量（迭代版 Tarjan，避免遞迴爆堆疊）
// n：頂點數；usable[v]：這個頂點要不要算；outs(v)：v 能直接走到的頂點陣列
// 回傳 comp[v]（不可用的頂點為 -1）、分量數、各分量大小
export function scc(n, usable, outs) {
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n), comp = new Int32Array(n).fill(-1), stack = new Int32Array(n);
  const callV = new Int32Array(n), callK = new Int32Array(n), list = new Array(n); let sp = 0, idx = 0, nc = 0;
  for (let r = 0; r < n; r++) {
    if (!usable[r] || index[r] >= 0) continue;
    let cs = 0; callV[cs] = r; callK[cs] = 0; cs++;
    index[r] = low[r] = idx++; stack[sp++] = r; onStack[r] = 1; list[r] = outs(r);
    while (cs) {
      const v = callV[cs - 1], L = list[v];
      if (callK[cs - 1] < L.length) {
        const w = L[callK[cs - 1]++];
        if (index[w] < 0) { index[w] = low[w] = idx++; stack[sp++] = w; onStack[w] = 1; list[w] = outs(w); callV[cs] = w; callK[cs] = 0; cs++; }
        else if (onStack[w] && index[w] < low[v]) low[v] = index[w];
      } else {
        cs--; list[v] = null;
        if (cs) { const p = callV[cs - 1]; if (low[v] < low[p]) low[p] = low[v]; }
        if (low[v] === index[v]) { let w; do { w = stack[--sp]; onStack[w] = 0; comp[w] = nc; } while (w !== v); nc++; }
      }
    }
  }
  const size = new Int32Array(nc); for (let v = 0; v < n; v++) if (comp[v] >= 0) size[comp[v]]++;
  return { comp, count: nc, size };
}
