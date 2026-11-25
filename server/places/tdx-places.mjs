// tdx-places.mjs — TDX 停車資訊 v1、綠色運輸-充電樁 v1 → 地點（v1.17）
//   靜態（每 7 天）：路外停車場 CarPark（20 縣市＋國道服務區）、充電站 Station（21 縣市＋國道服務區）、台北市停車場名稱（台北的 CarPark 是空的，見下）
//   即時（查詢時才抓、快取 3 分鐘）：停車場剩餘車位 ParkingAvailability（12 縣市＋國道服務區）、充電槍狀態 ConnectorLiveStatus（21 縣市＋國道服務區）
//
// 實測（2026-11-25）：台北市 /Parking/OffStreet/CarPark/City/Taipei 回 0 筆，但剩餘車位有 1,196 個停車場（只有名稱、沒有座標）
//   → 台北的停車場只在名稱與 OSM 的停車場「正規化後完全相同、而且台北範圍內只有一個」時才放上地圖，並標示「位置依名稱對應 OSM」；對不到的不猜。
// 回應的陣列欄位：CarParks、ParkingAvailabilities、Stations、LiveStatuses（OAS 的包裝物件）
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import path from 'node:path';

const OAS_CITIES = ['Taipei', 'NewTaipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung', 'Keelung', 'Hsinchu', 'HsinchuCounty', 'MiaoliCounty', 'ChanghuaCounty', 'NantouCounty', 'YunlinCounty', 'ChiayiCounty', 'Chiayi', 'PingtungCounty', 'YilanCounty', 'HualienCounty', 'TaitungCounty', 'KinmenCounty', 'PenghuCounty', 'LienchiangCounty'];
export const PK_CITIES = OAS_CITIES.filter(c => c !== 'NewTaipei');                                  // CarPark 的 City 列舉（沒有新北）
export const PK_LIVE_CITIES = ['Taipei', 'Taoyuan', 'Taichung', 'Tainan', 'Kaohsiung', 'Keelung', 'ChanghuaCounty', 'YunlinCounty', 'PingtungCounty', 'YilanCounty', 'HualienCounty', 'KinmenCounty'];
export const EV_CITIES = OAS_CITIES.filter(c => c !== 'LienchiangCounty');                            // EV 的 City 列舉（沒有連江）
export const STATIC_FILE = 'places-static.json.gz', STATIC_MAX_AGE_MS = 7 * 864e5;
export const SPACE_TYPE = { 1: '自小客車', 2: '機車', 5: '大型車', 7: '孕婦及親子', 9: '身障汽車', 11: '電動汽車', 12: '電動機車' };
export const CONNECTOR = { 1: 'CCS1', 2: 'CCS2', 3: 'CHAdeMO', 4: 'Tesla', 5: 'J1772', 6: 'Type 2', 254: '其他', 255: '未知' };
export const CONNECTOR_STATUS = { 1: '可使用', 2: '使用中', 3: '故障' };
export const FULL_STATUS = { 0: '尚有空位', 1: '車位將滿', 2: '車位已滿', 3: '過度擁擠' }, SERVICE_STATUS = { 0: '休息中', 1: '營業中', 2: '暫停營業', 3: '非營業時段' };

const zh = o => (o && typeof o === 'object' ? (o.Zh_tw ?? o.En ?? null) : (typeof o === 'string' ? o : null));
export const listOf = (w, k) => (Array.isArray(w) ? w : w && Array.isArray(w[k]) ? w[k] : w ? Object.values(w).find(Array.isArray) || [] : []);
const pathOf = { carPark: a => (a === 'Freeway' ? '/v1/Parking/OffStreet/CarPark/Road/Freeway/ServiceArea' : `/v1/Parking/OffStreet/CarPark/City/${a}`),
  avail: a => (a === 'Freeway' ? '/v1/Parking/OffStreet/ParkingAvailability/Road/Freeway/ServiceArea' : `/v1/Parking/OffStreet/ParkingAvailability/City/${a}`),
  evStation: a => (a === 'Freeway' ? '/v1/EV/Station/Freeway/ServiceArea' : `/v1/EV/Station/City/${a}`),
  evLive: a => (a === 'Freeway' ? '/v1/EV/ConnectorLiveStatus/Freeway/ServiceArea' : `/v1/EV/ConnectorLiveStatus/City/${a}`) };
export const livePath = (kind, auth) => (kind === 'p' ? (auth === 'Freeway' || PK_LIVE_CITIES.includes(auth) ? pathOf.avail(auth) : null) : (auth === 'Freeway' || EV_CITIES.includes(auth) ? pathOf.evLive(auth) : null)) ;

async function get(fetchJson, p, key) { const r = await fetchJson(p + '?%24format=JSON'); return r && r.status === 200 && r.data ? { rows: listOf(r.data, key) } : { error: `HTTP ${r ? r.status : '—'}`, rows: [] }; }
export async function syncPlacesStatic(fetchJson, dir, { log = () => {}, parking = [...PK_CITIES, 'Freeway'], ev = [...EV_CITIES, 'Freeway'] } = {}) {
  mkdirSync(dir, { recursive: true }); const out = { fetchedAt: Date.now(), source: 'TDX 停車資訊 v1、綠色運輸-充電樁 v1', parking: {}, ev: {}, taipeiNames: [] }, report = [];
  for (const a of parking) { const r = await get(fetchJson, pathOf.carPark(a), 'CarParks'); out.parking[a] = r.rows; report.push(`${r.error ? '✗' : '✓'} 停車場 ${a}：${r.error || r.rows.length}`); log(report[report.length - 1]); }
  { const r = await get(fetchJson, pathOf.avail('Taipei'), 'ParkingAvailabilities'); out.taipeiNames = r.rows.map(x => ({ id: x.CarParkID, name: zh(x.CarParkName), total: x.TotalSpaces ?? null })); report.push(`${r.error ? '✗' : '✓'} 台北市停車場名稱（剩餘車位清單）：${r.error || r.rows.length}`); log(report[report.length - 1]); }
  for (const a of ev) { const r = await get(fetchJson, pathOf.evStation(a), 'Stations'); out.ev[a] = r.rows; report.push(`${r.error ? '✗' : '✓'} 充電站 ${a}：${r.error || r.rows.length}`); log(report[report.length - 1]); }
  const f = path.join(dir, STATIC_FILE); writeFileSync(f + '.tmp', gzipSync(JSON.stringify(out), { level: 6 })); renameSync(f + '.tmp', f);
  return { report, parking: Object.values(out.parking).reduce((a, x) => a + x.length, 0), ev: Object.values(out.ev).reduce((a, x) => a + x.length, 0), taipei: out.taipeiNames.length };
}
export const readPlacesStatic = f => JSON.parse(gunzipSync(readFileSync(f)).toString('utf8'));
export const placesAgeMs = dir => { const f = path.join(dir, STATIC_FILE); return existsSync(f) ? Date.now() - statSync(f).mtimeMs : Infinity; };

// 靜態資料 → 地點紀錄（與 osm-poi 同樣的欄位，另加 ext：來源、即時資料的代碼、費率等）
export function placesToRecords(S) {
  const R = { id: [], name: [], en: [], brand: [], alt: [], cat: [], lat: [], lon: [], addr: [], hours: [], phone: [], web: [], level: [], area: [], ext: [] };
  const push = (o) => { for (const k of Object.keys(R)) R[k].push(o[k] ?? (k === 'area' ? 0 : k === 'ext' ? null : '')); };
  const addr = a => (typeof a === 'string' ? a : a && typeof a === 'object' ? [a.City, a.Town, a.Road, a.Section, a.Lane, a.Alley, a.No].filter(Boolean).join('') : '');
  for (const [auth, rows] of Object.entries(S.parking || {})) for (const x of rows) {
    const la = +x.CarParkPosition?.PositionLat, lo = +x.CarParkPosition?.PositionLon; if (!(la > 20 && la < 27 && lo > 117 && lo < 123)) continue;
    push({ id: `p:${auth}:${x.CarParkID}`, name: zh(x.CarParkName) || '停車場', cat: 'parking', lat: Math.round(la * 1e7), lon: Math.round(lo * 1e7), addr: x.Address || '', phone: x.Telephone || '',
      ext: { src: 'TDX', kind: 'p', auth, id: x.CarParkID, desc: x.Description || null, fare: x.FareDescription || null, moto: x.IsMotorcycle === 1, ev: x.EVRechargingAvailable === 1, live: !!livePath('p', auth), loc: 'tdx' } });
  }
  for (const [auth, rows] of Object.entries(S.ev || {})) for (const x of rows) {
    const la = +x.PositionLat, lo = +x.PositionLon; if (!(la > 20 && la < 27 && lo > 117 && lo < 123)) continue;
    const con = (x.Connectors || []).map(c => `${CONNECTOR[c.Type] || '未知'} ${c.Power === 2 ? 'DC' : c.Power === 1 ? 'AC' : ''}×${c.Quantity ?? '?'}`.replace(' ×', '×'));
    push({ id: `e:${auth}:${x.StationID}`, name: zh(x.StationName) || '充電站', cat: 'charging', lat: Math.round(la * 1e7), lon: Math.round(lo * 1e7), addr: addr(x.Location && (x.Location.Address || x.Location.Place && x.Location.Place.POI)) || '', phone: x.Telephone || '', level: x.Floors || '',
      ext: { src: 'TDX', kind: 'e', auth, id: x.StationID, desc: x.Description || null, connectors: con, points: x.ChargingPoints ?? null, chargingRate: x.ChargingRate || null, parkingRate: x.ParkingRate || null, serviceTime: x.ServiceTime || null, restriction: x.UsageRestriction || null, live: !!livePath('e', auth), loc: 'tdx' } });
  }
  // 同名、20 m 內的重複站（實測台中「Acon-eco 台中和雲復興路四段一站」有兩個 StationID，多半是交流／直流分開登錄）→ 合併成一筆，即時狀態加總（ext.ids）
  const keep = [], seen = new Map();
  for (let i = 0; i < R.id.length; i++) {
    const k = R.cat[i] + '|' + String(R.name[i]).replace(/\s+/g, '') + '|' + Math.round(R.lat[i] / 2000) + '|' + Math.round(R.lon[i] / 2000);   // 2000（1e-7 度）≈ 20 m
    const j = seen.get(k);
    if (j == null) { seen.set(k, i); R.ext[i].ids = [R.id[i]]; keep.push(i); continue; }
    const a = R.ext[j], b = R.ext[i]; a.ids.push(R.id[i]);
    if (b.connectors) a.connectors = [...(a.connectors || []), ...b.connectors]; if (b.points != null) a.points = (a.points || 0) + b.points;
  }
  if (keep.length < R.id.length) for (const k of Object.keys(R)) R[k] = keep.map(i => R[k][i]);
  return R;
}

// ---------- 即時（伺服器主執行緒；查詢時才抓，快取 3 分鐘）----------
export function createLive({ fetchJson, ttlMs = 180e3, now = () => Date.now() }) {
  const cache = new Map(), inflight = new Map();
  async function table(kind, auth) {
    const p = livePath(kind, auth); if (!p) return { unsupported: true };
    const c = cache.get(p); if (c && now() - c.at < ttlMs) return c;
    if (inflight.has(p)) return inflight.get(p);
    const job = (async () => {
      const r = await fetchJson(p + '?%24format=JSON'); if (!r || r.status !== 200 || !r.data) { const e = { error: `HTTP ${r ? r.status : '—'}`, at: now(), map: new Map() }; cache.set(p, { ...e, at: now() - ttlMs + 30e3 }); return e; }   // 失敗：30 秒後再試
      const map = new Map();
      if (kind === 'p') for (const x of listOf(r.data, 'ParkingAvailabilities')) {
        const sp = new Map((x.Availabilities || []).map(a => [a.SpaceType, a])), car = sp.get(1), moto = sp.get(2), v = n => (Number.isFinite(+n) && +n >= 0 ? +n : null);
        map.set(String(x.CarParkID), { available: v(car ? car.AvailableSpaces : x.AvailableSpaces), total: v(car ? car.NumberOfSpaces : x.TotalSpaces), motoAvailable: moto ? v(moto.AvailableSpaces) : null, motoTotal: moto ? v(moto.NumberOfSpaces) : null,
          full: FULL_STATUS[x.FullStatus] ?? null, service: SERVICE_STATUS[x.ServiceStatus] ?? null, at: Date.parse(x.DataCollectTime || '') || null });
      } else for (const x of listOf(r.data, 'LiveStatuses')) {
        const k = String(x.StationID), o = map.get(k) || { available: 0, inUse: 0, fault: 0, total: 0, at: null }; o.total++;
        if (x.ConnectorStatus === 1) o.available++; else if (x.ConnectorStatus === 2) o.inUse++; else if (x.ConnectorStatus === 3) o.fault++;
        const t = Date.parse(x.LastUpdateTime || ''); if (t && (!o.at || t > o.at)) o.at = t; map.set(k, o);
      }
      const v = { at: now(), map }; cache.set(p, v); return v;
    })().finally(() => inflight.delete(p));
    inflight.set(p, job); return job;
  }
  // ids：「p:縣市:代碼」「e:縣市:代碼」
  return async function live(ids) {
    const out = {}, groups = new Map();
    for (const id of ids.slice(0, 60)) { const m = /^([pe]):([A-Za-z]+):(.+)$/.exec(id); if (!m) continue; const k = m[1] + '|' + m[2]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push([id, m[3]]); }
    for (const [k, list] of groups) {
      const [kind, auth] = k.split('|'), t = await table(kind, auth);
      for (const [id, code] of list) out[id] = t.unsupported ? { unsupported: true, note: kind === 'p' ? '這個縣市沒有提供即時剩餘車位' : '沒有即時充電槍狀態' } : t.error ? { error: t.error } : (t.map.get(code) ? { ...t.map.get(code), fetchedAt: t.at } : { missing: true, note: '即時資料裡沒有這個地點' });
    }
    return out;
  };
}
