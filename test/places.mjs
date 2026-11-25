// places.mjs — 停車場與充電站（v1.17）：TDX 靜態資料 → 地點紀錄（座標檢查、同名重複站合併）、併入 OSM 地點（去重、台北依名稱對應）、
// 詳細資料、即時剩餘車位與充電槍狀態（解析、機車位、不支援的縣市、快取、失敗）、同步（假的 TDX）、伺服器 /api/v1/poi/live
import http from 'node:http';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
console.info = () => {}; console.warn = () => {};
let fails = 0; const ok = (n, c, x = '') => { console.log((c ? '  ✓ ' : '  ✗ ') + n + (x ? '｜' + x : '')); if (!c) fails++; };
const PL = await import('../server/places/tdx-places.mjs'), P = await import('../server/osm/poi.mjs');

const S = {
  fetchedAt: 1, parking: {
    Taichung: [{ CarParkID: 'TC1', CarParkName: { Zh_tw: '測試立體停車場' }, CarParkPosition: { PositionLat: 24.1372, PositionLon: 120.6869 }, Address: '台中市中區', FareDescription: '30元/時', IsMotorcycle: 0 },
      { CarParkID: 'BAD', CarParkName: { Zh_tw: '座標錯誤' }, CarParkPosition: { PositionLat: 0, PositionLon: 0 } }],
    NantouCounty: [{ CarParkID: 'NT1', CarParkName: { Zh_tw: '南投停車場' }, CarParkPosition: { PositionLat: 23.91, PositionLon: 120.68 } }] },
  ev: { Taichung: [
    { StationID: 'E1', StationName: { Zh_tw: '測試充電站' }, PositionLat: 24.1380, PositionLon: 120.6870, ChargingPoints: 2, Connectors: [{ Type: 2, Power: 2, Quantity: 2 }], ChargingRate: '10元/度', ServiceTime: '24小時', ParkingRate: '免費' },
    { StationID: 'E2', StationName: { Zh_tw: '測試充電站' }, PositionLat: 24.13801, PositionLon: 120.68701, ChargingPoints: 1, Connectors: [{ Type: 6, Power: 1, Quantity: 1 }] }] },
  taipeiNames: [{ id: 'T1', name: '府前廣場地下停車場', total: 1998 }, { id: 'T2', name: '重複名稱停車場', total: 10 }, { id: 'T3', name: 'OSM 沒有的停車場', total: 5 }] };

console.log('① TDX → 地點紀錄');
const R = PL.placesToRecords(S);
ok('座標不在台灣範圍的不收', !R.id.includes('p:Taichung:BAD'));
ok('代碼：p:縣市:代碼、e:縣市:代碼', R.id.includes('p:Taichung:TC1') && R.id.includes('e:Taichung:E1'));
{ const i = R.id.indexOf('e:Taichung:E1'); ok('同名、20 m 內的兩個充電站合併成一筆（即時狀態用兩個代碼加總、充電槍合併）', !R.id.includes('e:Taichung:E2') && JSON.stringify(R.ext[i].ids) === '["e:Taichung:E1","e:Taichung:E2"]' && R.ext[i].connectors.length === 2 && R.ext[i].points === 3, JSON.stringify(R.ext[i].connectors)); }
ok('即時：台中停車場有、南投沒有（OAS 的剩餘車位列舉）', R.ext[R.id.indexOf('p:Taichung:TC1')].live === true && R.ext[R.id.indexOf('p:NantouCounty:NT1')].live === false);
ok('充電槍文字：CCS2 DC×2', R.ext[R.id.indexOf('e:Taichung:E1')].connectors[0] === 'CCS2 DC×2');

console.log('② 併入 OSM 地點');
const osm = { id: [], name: [], en: [], brand: [], alt: [], cat: [], lat: [], lon: [], addr: [], hours: [], phone: [], web: [], level: [], area: [] };
const add = (id, name, cat, la, lo) => { for (const k of Object.keys(osm)) osm[k].push(k === 'id' ? id : k === 'name' ? name : k === 'cat' ? cat : k === 'lat' ? Math.round(la * 1e7) : k === 'lon' ? Math.round(lo * 1e7) : k === 'area' ? 0 : ''); };
add('n1', '測試立體停車場', 'parking', 24.13722, 120.68692);        // 與 TDX 同名、約 3 m → 以 TDX 為準
add('n2', '', 'parking', 24.13730, 120.68690);                      // 沒有名稱、約 9 m → 以 TDX 為準
add('n3', '別的停車場', 'parking', 24.13740, 120.68690);             // 有名稱但不同 → 保留
add('n4', '測試立體停車場', 'cafe', 24.13722, 120.68692);            // 不同類別 → 保留
add('n5', '府前廣場地下停車場', 'parking', 25.0400, 121.5100);        // 台北：唯一同名 → 對應
add('n6', '重複名稱停車場', 'parking', 25.0500, 121.5200); add('n7', '重複名稱停車場', 'parking', 25.0510, 121.5210);   // 台北：同名兩個 → 不對應
const X = P.buildIndex(P.mergePlaces(osm, S)), st = X.D.placesStats;
ok('同類、60 m 內同名或 40 m 內沒有名稱的 OSM 停車場 → 以 TDX 為準（不重複列）', P.findPoi(X, 'n1') < 0 && P.findPoi(X, 'n2') < 0 && st.osmReplaced === 2, JSON.stringify(st));
ok('不同名稱或不同類別的 OSM 地點保留', P.findPoi(X, 'n3') >= 0 && P.findPoi(X, 'n4') >= 0);
ok('台北：名稱唯一相同 → 用 OSM 的位置，OSM 那筆不重複列', P.findPoi(X, 'p:Taipei:T1') >= 0 && P.findPoi(X, 'n5') < 0 && st.taipeiMatched === 1);
ok('台北：同名有兩個、或 OSM 沒有 → 不放（不猜位置）', P.findPoi(X, 'p:Taipei:T2') < 0 && P.findPoi(X, 'p:Taipei:T3') < 0 && P.findPoi(X, 'n6') >= 0);
{ const d = P.poiDetail(X, P.findPoi(X, 'p:Taipei:T1')); ok('台北對應的停車場：標示位置來源、保留 OSM 連結、可查即時', /依名稱對應/.test(d.tdx.location) && d.osm && d.osm.id === '5' && d.live === 'p:Taipei:T1'); }
{ const d = P.poiDetail(X, P.findPoi(X, 'e:Taichung:E1')); ok('充電站詳細：充電槍、費率、開放時間、來源（沒有 OSM 連結）', d.tdx.kind === 'charging' && d.tdx.chargingRate === '10元/度' && d.tdx.serviceTime === '24小時' && d.osm === null && /充電樁/.test(d.source)); }
{ const r = P.searchPois(X, { q: '停車場', near: [24.1372, 120.6869], now: Date.now() }); const t = r.results.find(x => x.id === 'p:Taichung:TC1');
  ok('搜尋「停車場」：TDX 停車場帶 liveIds 與來源', t && t.source === 'TDX' && JSON.stringify(t.liveIds) === '["p:Taichung:TC1"]'); }

console.log('③ 即時狀態');
const calls = []; let fail = false;
const fake = async p => { calls.push(p); if (fail) return { status: 503 };
  if (/ParkingAvailability\/City\/Taichung/.test(p)) return { status: 200, data: { ParkingAvailabilities: [
    { CarParkID: 'TC1', TotalSpaces: 300, AvailableSpaces: 100, Availabilities: [{ SpaceType: 1, NumberOfSpaces: 200, AvailableSpaces: 50 }, { SpaceType: 2, NumberOfSpaces: 100, AvailableSpaces: 50 }], ServiceStatus: 1, FullStatus: 0, DataCollectTime: '2026-11-25T10:00:00+08:00' },
    { CarParkID: 'TC2', TotalSpaces: 10, AvailableSpaces: -9, Availabilities: [], ServiceStatus: 2, FullStatus: 2 }] } };
  if (/ConnectorLiveStatus\/City\/Taichung/.test(p)) return { status: 200, data: { LiveStatuses: [{ StationID: 'E1', ConnectorStatus: 1, LastUpdateTime: '2026-11-25T10:00:00+08:00' }, { StationID: 'E1', ConnectorStatus: 2 }, { StationID: 'E1', ConnectorStatus: 3 }] } };
  return { status: 404 }; };
let clock = 1e12; const live = PL.createLive({ fetchJson: fake, ttlMs: 180e3, now: () => clock });
{ const o = await live(['p:Taichung:TC1', 'p:Taichung:TC2', 'e:Taichung:E1', 'p:NantouCounty:NT1', 'p:Taichung:NONE', 'bad']);
  ok('停車場：汽車位（SpaceType 1）、機車位（2）、營業與滿位狀態', o['p:Taichung:TC1'].available === 50 && o['p:Taichung:TC1'].total === 200 && o['p:Taichung:TC1'].motoAvailable === 50 && o['p:Taichung:TC1'].full === '尚有空位' && o['p:Taichung:TC1'].service === '營業中');
  ok('負數的剩餘車位（未知）→ null，不顯示假數字', o['p:Taichung:TC2'].available === null && o['p:Taichung:TC2'].full === '車位已滿' && o['p:Taichung:TC2'].service === '暫停營業');
  ok('充電槍：可使用／使用中／故障 計數', o['e:Taichung:E1'].available === 1 && o['e:Taichung:E1'].inUse === 1 && o['e:Taichung:E1'].fault === 1 && o['e:Taichung:E1'].total === 3);
  ok('沒有即時資料的縣市：說明、不呼叫 TDX', o['p:NantouCounty:NT1'].unsupported && !calls.some(p => /Nantou/.test(p)));
  ok('即時資料裡沒有這個地點、格式錯的代碼', o['p:Taichung:NONE'].missing === true && !('bad' in o)); }
{ const n = calls.length; await live(['p:Taichung:TC1']); ok('3 分鐘內同一個縣市不再呼叫（快取）', calls.length === n); clock += 181e3; await live(['p:Taichung:TC1']); ok('超過 3 分鐘重新抓', calls.length === n + 1); }
{ fail = true; clock += 181e3; const o = await live(['e:Taichung:E1']); ok('TDX 失敗：回報錯誤，不給舊數字當即時', o['e:Taichung:E1'].error === 'HTTP 503'); fail = false; }

console.log('④ 同步（假的 TDX）');
{ const dir = mkdtempSync(path.join(tmpdir(), 'places-')), seen = [];
  const f2 = async p => { seen.push(p); if (/CarPark\/City\/Taichung/.test(p)) return { status: 200, data: { CarParks: S.parking.Taichung } }; if (/ParkingAvailability\/City\/Taipei/.test(p)) return { status: 200, data: { ParkingAvailabilities: [{ CarParkID: 'T1', CarParkName: { Zh_tw: '府前廣場地下停車場' }, TotalSpaces: 1998 }] } };
    if (/EV\/Station\/City\/Taichung/.test(p)) return { status: 200, data: { Stations: S.ev.Taichung } }; return { status: 200, data: { CarParks: [], Stations: [] } }; };
  const r = await PL.syncPlacesStatic(f2, dir, { parking: ['Taichung', 'Freeway'], ev: ['Taichung'] });
  ok('寫檔、統計、台北停車場名稱', existsSync(path.join(dir, PL.STATIC_FILE)) && r.parking === 2 && r.ev === 2 && r.taipei === 1 && PL.readPlacesStatic(path.join(dir, PL.STATIC_FILE)).taipeiNames[0].name === '府前廣場地下停車場');
  ok('路徑：國道服務區用 /Road/Freeway/ServiceArea', seen.some(p => p === '/v1/Parking/OffStreet/CarPark/Road/Freeway/ServiceArea?%24format=JSON')); }

console.log('⑤ 伺服器 /api/v1/poi/live');
{ const { createApp } = await import('../server/server.mjs'), { readConfig } = await import('../server/config.mjs');
  const cfg = readConfig({ DATA_DIR: mkdtempSync(path.join(tmpdir(), 'pl-data-')), CACHE_DIR: mkdtempSync(path.join(tmpdir(), 'pl-cache-')), LOG: '0', WORKERS: '0', OSM: '0', RATE_LIMIT_PER_MIN: '1000' });
  const h = createApp(cfg, { placesFetch: fake }), srv = http.createServer(h); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const J = async p => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`); return { status: r.status, j: await r.json() }; };
  { const r = await J('/api/v1/poi/live?ids=p:Taichung:TC1,e:Taichung:E1'); ok('回傳各地點的即時狀態與來源', r.status === 200 && r.j.data.available && r.j.data.items['p:Taichung:TC1'].available === 50 && r.j.data.items['e:Taichung:E1'].total === 3 && /TDX/.test(r.j.data.source)); }
  { const r = await J('/api/v1/poi/live'); ok('缺 ids → 400', r.status === 400 && r.j.error.code === 'MISSING_PARAM'); }
  await new Promise(r => srv.close(r)); if (h.close) await h.close(); }

console.log(fails ? `\n✗ ${fails} 項失敗` : '\n✓ 停車場與充電站測試全部通過');
process.exit(fails ? 1 : 0);
