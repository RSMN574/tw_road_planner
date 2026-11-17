// heap.js

// ============================================================
// Binary Heap + Dijkstra
// ============================================================

export class MinHeap {        // 型別陣列二元堆：不再為每次 push 配置 [key,val] 陣列（原本是最大 GC 來源）
  constructor(cap = 1024) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; this._r = [0, 0]; }
  push(d, id) {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2), v2 = new Int32Array(this.n * 2);
      k2.set(this.k); v2.set(this.v); this.k = k2; this.v = v2;
    }
    const k = this.k, v = this.v; let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= d) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = d; v[i] = id;
  }
  pop() {                                  // 回傳可重用的 [key, val]（請立即解構）
    const k = this.k, v = this.v, r = this._r; r[0] = k[0]; r[1] = v[0];
    const n = --this.n;
    if (n > 0) {
      const d = k[n], id = v[n]; let i = 0;
      for (;;) {
        let c = 2*i + 1; if (c >= n) break;
        if (c + 1 < n && k[c+1] < k[c]) c++;
        if (k[c] >= d) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = d; v[i] = id;
    }
    return r;
  }
  top() { return this.k[0]; }
  get size() { return this.n; }
}
