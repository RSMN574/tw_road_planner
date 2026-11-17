#!/usr/bin/env node
// tdx-audit.mjs — 稽核：你的 TDX 帳號對「台中公車＋台中捷運」實際拿得到哪些資料、有哪些欄位。
//
//   node tools/tdx-audit.mjs                     （預設 Taichung、TMRT）
//   node tools/tdx-audit.mjs --city Taichung --operators TMRT --out audit.json
//
// 每個端點只取前 3 筆（$top=3），列出：HTTP 狀態、實際欄位、程式用到但回應裡沒有的欄位。
// 目的：程式只使用「確認存在」的欄位；缺的資料會讓對應功能標示為推估或資訊不足，而不是假設它存在。
import { writeFileSync } from 'node:fs';
import { resolveToken } from './_tdx.mjs';
import { createTdxFetcher, datasetList } from '../server/transit/snapshot.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const city = arg('city', 'Taichung'), operators = arg('operators', 'TMRT').split(',').map(s => s.trim()).filter(Boolean), outFile = arg('out', '');

// 程式實際讀取的欄位（缺了會影響的功能寫在後面）
const EXPECT = {
  'bus.stopOfRoute': [['RouteUID', '路線識別'], ['SubRouteUID', '子路線識別'], ['Direction', '方向'], ['Stops[].StopUID', '站牌識別'], ['Stops[].StopSequence', '站序'], ['Stops[].StopPosition.PositionLat', '站牌座標'], ['Stops[].StationGroupID', '同站群（對向站牌）']],
  'bus.schedule': [['SubRouteUID', '對應子路線'], ['Direction', '對應方向'], ['Timetables[].StopTimes[].DepartureTime', '逐班時刻'], ['Timetables[].StopTimes[].StopSequence', '時刻對站序'], ['Timetables[].ServiceDay', '星期幾行駛'], ['Frequencys[].MinHeadwayMins', '班距型路線']],
  'bus.daily': [['SubRouteUID', '對應子路線'], ['Direction', '對應方向'], ['BusDate', '班表日期'], ['Timetables[].StopTimes[].DepartureTime', '當日逐班時刻']],
  'bus.s2s': [['TravelTimes[].RunTime', '站間行駛時間'], ['TravelTimes[].FromStopID', '起站'], ['TravelTimes[].ToStopID', '迄站']],
  'bus.eta': [['RouteUID', '路線識別'], ['SubRouteUID', '子路線識別'], ['Direction', '方向'], ['StopUID', '站牌識別'], ['StopStatus', '站牌狀態'], ['EstimateTime', '預估秒數'], ['SrcUpdateTime', '資料時間（判斷是否過期）']],
  station: [['StationUID', '車站識別'], ['StationID', '車站代碼'], ['StationPosition.PositionLat', '座標']],
  stationOfLine: [['LineID', '路線'], ['Stations[].StationID', '車站'], ['Stations[].Sequence', '站序']],
  stationOfRoute: [['LineID', '路線'], ['RouteID', '營運路線'], ['Direction', '方向'], ['Stations[].Sequence', '站序']],
  s2s: [['TravelTimes[].FromStationID', '起站'], ['TravelTimes[].ToStationID', '迄站'], ['TravelTimes[].RunTime', '行駛時間'], ['TravelTimes[].StopTime', '停站時間']],
  frequency: [['LineID', '路線'], ['ServiceDay', '星期幾'], ['Headways[].StartTime', '時段'], ['Headways[].MinHeadwayMins', '班距']],
  firstLast: [['StationID', '車站'], ['DestinationStaionID', '往哪個終點（TDX 原始拼字）'], ['FirstTrainTime', '首班'], ['LastTrainTime', '末班'], ['ServiceDay', '星期幾']],
  lineTransfer: [['FromStationID', '起站'], ['ToStationID', '迄站'], ['TransferTime', '轉乘分鐘']],
  stationExit: [['StationID', '車站'], ['ExitPosition.PositionLat', '出入口座標']],
  line: [['LineID', '路線'], ['LineName.Zh_tw', '路線名稱']]
};
function paths(v, pre = '', out = new Set(), depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return out;
  if (Array.isArray(v)) { for (const x of v.slice(0, 5)) paths(x, pre + '[]', out, depth + 1); return out; }
  for (const [k, x] of Object.entries(v)) { const p = pre ? (pre.endsWith('[]') ? pre + '.' + k : pre + '.' + k) : k; out.add(p); paths(x, p, out, depth + 1); }
  return out;
}

const tk = resolveToken();
if (!tk.getToken) { console.error('找不到 TDX token：請設定 TOKEN_FILE（server_2 的 token.txt 路徑），或在 .env 設 TDX_TOKEN_URL＋TDX_API_KEY'); process.exit(2); }
const fetchJson = createTdxFetcher({ upstream: tk.cfg.tdx.upstream, getToken: tk.getToken, timeoutMs: 30000 });
const list = [...datasetList(city, operators), { name: 'bus.eta', group: 'bus', key: 'eta', path: `/Bus/EstimatedTimeOfArrival/City/${city}?%24format=JSON`, optional: true }];
const report = { at: new Date().toISOString(), city, operators, tokenSource: tk.source.replace(/.*[\\/]/, '…/'), datasets: [] };
console.log(`TDX 稽核：${city}／${operators.join('、')}（token 來源：${report.tokenSource}）\n`);
for (const d of list) {
  const p = d.path.replace('?', '?%24top=3&');
  let r; try { r = await fetchJson(p); } catch (e) { r = { status: 0, detail: e.message }; }
  const rows = Array.isArray(r.data) ? r.data : [], fields = [...paths(rows)].map(s => s.replace(/^\[\]\.?/, '')).filter(Boolean).sort();
  const exp = EXPECT[d.name] || EXPECT[d.key] || [], miss = r.status === 200 && rows.length ? exp.filter(([f]) => !fields.includes(f)) : [];
  const state = r.status !== 200 ? `✗ HTTP ${r.status}${r.detail ? '（' + String(r.detail).slice(0, 80) + '）' : ''}` : !rows.length ? '△ 回應是空的（這個城市／業者沒有這種資料）' : miss.length ? '△ 有資料，但缺部分欄位' : '✓ 可用';
  console.log(`${state.padEnd(4)} ${d.name}${d.optional ? '' : '（必要）'}`);
  for (const [f, why] of miss) console.log(`      缺 ${f} → 影響：${why}`);
  report.datasets.push({ name: d.name, path: d.path, status: r.status, sampleRows: rows.length, fields, missing: miss.map(([f, why]) => ({ field: f, affects: why })), available: r.status === 200 && rows.length > 0 });
  await new Promise(s => setTimeout(s, 250));                                                       // 不要打太快
}
const ok = report.datasets.filter(d => d.available).length;
console.log(`\n${ok}／${report.datasets.length} 種資料可用。`);
if (outFile) { writeFileSync(outFile, JSON.stringify(report, null, 1)); console.log('完整欄位清單已寫入 ' + outFile + '（不含 token）'); }
else console.log('加上 --out audit.json 可輸出完整欄位清單。');
