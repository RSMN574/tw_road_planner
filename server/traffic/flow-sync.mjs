// flow-sync.mjs — 抓 TDX 路況資訊 v2 到 CACHE_DIR/traffic：
//   靜態（每 7 天或手動）：發布路段 Section＋線形 SectionShape＋壅塞水準表 CongestionLevel → flow-static.json.gz（13 個機關 × 3 ＝ 39 次呼叫）
//   即時（預設每 5 分鐘）：Live → flow-live.json.gz（13 次呼叫；約 3,700 次／天 ≈ 2.5 點／天）
// 給 tools/traffic-flow-sync.mjs 與伺服器的定時更新共用。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';
import { FLOW_AUTHORITIES, listOf } from './flow.mjs';

export const STATIC_FILE = 'flow-static.json.gz', LIVE_FILE = 'flow-live.json.gz', STATIC_MAX_AGE_MS = 7 * 864e5;
const writeGz = (f, obj) => { writeFileSync(f + '.tmp', gzipSync(JSON.stringify(obj), { level: 6 })); renameSync(f + '.tmp', f); };
export const readGz = f => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
export const staticAgeMs = dir => { const f = path.join(dir, STATIC_FILE); return existsSync(f) ? Date.now() - statSync(f).mtimeMs : Infinity; };

async function get(fetchJson, p) {
  const r = await fetchJson('/Road/Traffic/' + p + '?%24format=JSON');
  return r && r.status === 200 && r.data ? r.data : { error: `HTTP ${r ? r.status : '—'}` };
}
export async function syncStatic(fetchJson, dir, { authorities = FLOW_AUTHORITIES, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true }); const byAuthority = {}, report = [];
  for (const a of authorities) {
    const sections = await get(fetchJson, 'Section/' + a), shapes = await get(fetchJson, 'SectionShape/' + a), levels = await get(fetchJson, 'CongestionLevel/' + a);
    const ns = listOf(sections, 'Sections').length, nh = listOf(shapes, 'SectionShapes').length;
    if (sections.error) { report.push(`✗ ${a}：路段 ${sections.error}`); log(report[report.length - 1]); continue; }
    byAuthority[a] = { sections: { Sections: listOf(sections, 'Sections'), LinkVersion: sections.LinkVersion, UpdateTime: sections.UpdateTime }, shapes: { SectionShapes: listOf(shapes, 'SectionShapes') }, levels: { CongestionLevels: listOf(levels, 'CongestionLevels') } };
    report.push(`✓ ${a}：路段 ${ns}、線形 ${nh}${shapes.error ? `（線形 ${shapes.error}）` : ''}、壅塞水準表 ${listOf(levels, 'CongestionLevels').length}${levels.error ? `（${levels.error}）` : ''}`); log(report[report.length - 1]);
  }
  writeGz(path.join(dir, STATIC_FILE), { fetchedAt: Date.now(), source: 'TDX 路況資訊 v2', byAuthority });
  return { report, authorities: Object.keys(byAuthority).length };
}
export async function syncLive(fetchJson, dir, { authorities = FLOW_AUTHORITIES, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true }); const byAuthority = {}, report = []; let n = 0;
  for (const a of authorities) {
    const w = await get(fetchJson, 'Live/' + a); if (w.error) { report.push(`✗ ${a}：${w.error}`); continue; }
    const L = listOf(w, 'LiveTraffics').map(x => ({ SectionID: x.SectionID, TravelTime: x.TravelTime, TravelSpeed: x.TravelSpeed, CongestionLevelID: x.CongestionLevelID, CongestionLevel: x.CongestionLevel, DataCollectTime: x.DataCollectTime }));
    byAuthority[a] = { LiveTraffics: L, UpdateTime: w.UpdateTime, SrcUpdateTime: w.SrcUpdateTime }; n += L.length; report.push(`✓ ${a}：${L.length}`); log(report[report.length - 1]);
  }
  writeGz(path.join(dir, LIVE_FILE), { fetchedAt: Date.now(), source: 'TDX 路況資訊 v2（即時）', byAuthority });
  return { report, sections: n };
}
