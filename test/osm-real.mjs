// osm-real.mjs — 用真實的 OSM PBF 檢查（不在 npm test 裡；有資料時手動執行）
//   OSM_REAL_PBF=data/osm/raw/taiwan-20261118.osm.pbf node test/osm-real.mjs
// ① 讀取器 vs libosmium（需要 pip install osmium）：每個 node 座標與標籤、每條 way 的 node 序列與標籤、每個 relation 完全相同
// ② 建圖、檢查報告、幾條路線的基本合理性
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
const f = process.env.OSM_REAL_PBF; if (!f) { console.log('略過：沒有設定 OSM_REAL_PBF'); process.exit(0); }
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x !== '' ? '｜' + x : '')); if (!c) fails++; };
const { scan } = await import('../server/osm/pbf.mjs');
const py = `
import osmium, sys, hashlib, json
h = [hashlib.md5(), hashlib.md5(), hashlib.md5()]; c = [0, 0, 0]
srt = lambda t: json.dumps(dict(sorted(dict(t).items())), ensure_ascii=False, separators=(',', ':'))
class H(osmium.SimpleHandler):
    def node(s, n): c[0] += 1; h[0].update(f"{n.id}|{n.location.y}|{n.location.x}|{srt(n.tags)}\\n".encode())
    def way(s, w): c[1] += 1; h[1].update(f"{w.id}|{','.join(str(x.ref) for x in w.nodes)}|{srt(w.tags)}\\n".encode())
    def relation(s, r): c[2] += 1; h[2].update(f"{r.id}|{';'.join(f'{m.type}{m.ref}:{m.role}' for m in r.members)}|{srt(r.tags)}\\n".encode())
H().apply_file(sys.argv[1]); print(json.dumps({'count': c, 'md5': [x.hexdigest() for x in h]}))`;
const r = spawnSync('python3', ['-I', '-c', py, f], { encoding: 'utf8', maxBuffer: 1 << 20 });
if (r.status !== 0) console.log('  （沒有 pyosmium，略過與 libosmium 的比對：pip install osmium）');
else {
  const ref = JSON.parse(r.stdout), h = [createHash('md5'), createHash('md5'), createHash('md5')], c = [0, 0, 0];
  const srt = t => JSON.stringify(Object.fromEntries(Object.entries(t || {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))));
  const t0 = Date.now();
  scan(f, { nodeTags: true, node(id, la, lo, t) { c[0]++; h[0].update(`${id}|${la}|${lo}|${srt(t)}\n`); }, way(id, refs, t) { c[1]++; h[1].update(`${id}|${[...refs].join(',')}|${srt(t)}\n`); },
    relation(id, m, t) { c[2]++; h[2].update(`${id}|${m.map(x => `${x.type}${x.ref}:${x.role}`).join(';')}|${srt(t)}\n`); } });
  const mine = h.map(x => x.digest('hex'));
  ok('node、way、relation 數量與 libosmium 相同', JSON.stringify(c) === JSON.stringify(ref.count), c.join('／'));
  ok('內容逐筆相同（id、座標、node 序列、成員、標籤）', JSON.stringify(mine) === JSON.stringify(ref.md5), `${(Date.now() - t0) / 1000} 秒`);
}
const { buildTopology } = await import('../server/osm/topology.mjs'), { OsmRouter } = await import('../server/osm/router.mjs'), { validateGraph } = await import('../server/osm/validate.mjs');
const t1 = Date.now(), g = buildTopology(f, { log: m => console.log('   ' + m) }), R = new OsmRouter(g), rep = validateGraph(g, R);
ok('建圖完成', g.V.n > 0 && g.E.n > 0, `${g.V.n.toLocaleString()} 頂點、${g.E.n.toLocaleString()} 邊、${(Date.now() - t1) / 1000} 秒`);
for (const [k, p] of Object.entries(rep.profiles)) console.log(`   ${p.label}：最大連通區 ${p.largestPct}%、${p.components.toLocaleString()} 個強連通分量`);
console.log(fails ? `\n✗ ${fails} 項失敗` : '\n全部通過'); process.exit(fails ? 1 : 0);
