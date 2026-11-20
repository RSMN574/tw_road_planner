// rail-fixture.mjs — 多運具測試資料（v1.11）：欄位照 docs/oas/tdx-rail-v2.json、tdx-gis-v3.json、tdx-bus-v2.json 的 Schema；
// 數字全部是人工設定的「模擬資料」，不代表任何真實班次、票價或車站位置。
// 車站都放在 test/fixtures/osm/tw-mini.osm.pbf 的 5×5 格子路網上（格點 (i, j)：緯度 24.150＋j×0.001、經度 120.650＋i×0.001），步行用真的 OSM 步行路網計算。
const nm = s => ({ Zh_tw: s, En: s });
const pos = (lat, lon) => ({ PositionLat: lat, PositionLon: lon, GeoHash: '' });
export const DATE = '2026-11-20';                        // 週五
const WK = { Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 0, Sunday: 0 };
const at = (i, j, dy = 0, dx = 0) => [24.150 + j * 0.001 + dy, 120.650 + i * 0.001 + dx];
export const PLACES = { O: at(0, 0, 0.0001, 0.0001), D: at(4, 4, -0.0001, -0.0001) };
const st = (op, id, name, [lat, lon], extra = {}) => ({ StationUID: `${op}-${id}`, StationID: id, StationName: nm(name), StationPosition: pos(lat, lon), LocationCity: '測試市', UpdateTime: '2026-11-19T03:00:00+08:00', VersionID: 1, ...extra });
const stops = rows => rows.map(([id, name, arr, dep], i) => ({ StopSequence: i + 1, StationID: id, StationName: nm(name), ArrivalTime: arr, DepartureTime: dep }));

export function railFixture({ delay101 = null } = {}) {
  const TRA = {
    station: [st('TRA', '1000', '測試台中', at(0, 1, 0, 0.0001)), st('TRA', '1010', '測試新烏日', at(2, 4, 0, 0.0001))],
    general: [
      { UpdateTime: '2026-11-19', VersionID: 1, GeneralTimetable: { GeneralTrainInfo: { TrainNo: '101', Direction: 0, StartingStationID: '1000', EndingStationID: '1010', EndingStationName: nm('測試新烏日'), TrainTypeID: '1131', TrainTypeName: nm('區間車'), DailyFlag: 1 },
        StopTimes: stops([['1000', '測試台中', '08:04:00', '08:05:00'], ['1010', '測試新烏日', '08:15:00', '08:16:00']]), ServiceDay: WK, SrcUpdateTime: '2026-11-19T03:00:00+08:00' } },
      { UpdateTime: '2026-11-19', VersionID: 1, GeneralTimetable: { GeneralTrainInfo: { TrainNo: '105', Direction: 0, StartingStationID: '1000', EndingStationID: '1010', EndingStationName: nm('測試新烏日'), TrainTypeID: '1131', TrainTypeName: nm('區間車'), DailyFlag: 1 },
        StopTimes: stops([['1000', '測試台中', '08:39:00', '08:40:00'], ['1010', '測試新烏日', '08:50:00', '08:51:00']]), ServiceDay: WK, SrcUpdateTime: '2026-11-19T03:00:00+08:00' } },
      // 跨午夜：23:50 出發、00:10 到（應換算成 24:10）
      { UpdateTime: '2026-11-19', VersionID: 1, GeneralTimetable: { GeneralTrainInfo: { TrainNo: '199', Direction: 0, StartingStationID: '1000', EndingStationID: '1010', TrainTypeID: '1131', TrainTypeName: nm('區間車'), DailyFlag: 1 },
        StopTimes: stops([['1000', '測試台中', '23:49:00', '23:50:00'], ['1010', '測試新烏日', '00:10:00', '00:10:00']]), ServiceDay: WK } }
    ],
    // 當日：103 次停駛（SuspendedFlag=1），不能出現在結果裡
    daily: [{ TrainDate: DATE, DailyTrainInfo: { TrainNo: '103', Direction: 0, StartingStationID: '1000', EndingStationID: '1010', TrainTypeID: '1131', TrainTypeName: nm('區間車'), SuspendedFlag: 1 },
      StopTimes: stops([['1000', '測試台中', '08:09:00', '08:10:00'], ['1010', '測試新烏日', '08:12:00', '08:12:00']]), UpdateTime: '2026-11-20T00:10:00+08:00', VersionID: 1 }],
    odFare: [{ OriginStationID: '1000', DestinationStationID: '1010', Direction: 0, Fares: [{ TicketType: '測試票種甲', Price: 15 }, { TicketType: '測試票種乙', Price: 21 }], UpdateTime: '2026-11-19T03:00:00+08:00', VersionID: 1 }]
  };
  const THSR = {
    station: [st('THSR', '1040', '測試高鐵台中', at(2, 3, 0.0001, 0.0001)), st('THSR', '1070', '測試高鐵左營', at(4, 0, 0.0001, 0.0001))],
    general: [
      { UpdateTime: '2026-11-19', EffectiveDate: '2026-01-01', ExpiringDate: '2026-12-31', VersionID: 1, GeneralTimetable: { GeneralTrainInfo: { TrainNo: '0803', Direction: 0, StartingStationID: '1040', EndingStationID: '1070', EndingStationName: nm('測試高鐵左營') },
        StopTimes: stops([['1040', '測試高鐵台中', '08:25:00', '08:25:00'], ['1070', '測試高鐵左營', '09:10:00', '09:10:00']]), ServiceDay: WK } },
      { UpdateTime: '2026-11-19', EffectiveDate: '2026-01-01', ExpiringDate: '2026-12-31', VersionID: 1, GeneralTimetable: { GeneralTrainInfo: { TrainNo: '0805', Direction: 0, StartingStationID: '1040', EndingStationID: '1070', EndingStationName: nm('測試高鐵左營') },
        StopTimes: stops([['1040', '測試高鐵台中', '08:55:00', '08:55:00'], ['1070', '測試高鐵左營', '09:40:00', '09:40:00']]), ServiceDay: WK } }
    ],
    odFare: [{ OriginStationID: '1040', DestinationStationID: '1070', Direction: 0, Fares: [{ TicketType: 1, FareClass: 1, CabinClass: 1, Price: 790 }, { TicketType: 1, FareClass: 1, CabinClass: 3, Price: 765 }, { TicketType: 1, FareClass: 2, CabinClass: 1, Price: 395 }] }]
  };
  const KRTC = {   // 捷運：只有班距（Frequency）＋站間時間（S2STravelTime），沒有站別時刻表
    station: [st('KRTC', 'R16', '測試左營', at(3, 0, 0.0002, 0)), st('KRTC', 'R15', '測試生態園區', at(3, 2, -0.0004, 0.0001)), st('KRTC', 'R14', '測試巨蛋', at(3, 3, 0.0001, 0))],
    stationOfRoute: [{ RouteID: 'R-1', LineID: 'R', Direction: 0, Stations: [{ Sequence: 1, StationID: 'R16' }, { Sequence: 2, StationID: 'R15' }, { Sequence: 3, StationID: 'R14' }] }],
    line: [{ LineID: 'R', LineName: nm('紅線') }],
    s2s: [{ LineID: 'R', RouteID: 'R-1', TravelTimes: [{ FromStationID: 'R16', ToStationID: 'R15', RunTime: 120, StopTime: 25 }, { FromStationID: 'R15', ToStationID: 'R14', RunTime: 120, StopTime: 25 }] }],
    frequency: [{ LineID: 'R', RouteID: 'R-1', ServiceDay: { ...WK }, Headways: [{ StartTime: '06:00', EndTime: '23:59', MinHeadwayMins: 6, MaxHeadwayMins: 8 }], UpdateTime: '2026-11-19T03:00:00+08:00' }],
    odFare: [{ OriginStationID: 'R16', DestinationStationID: 'R14', Fares: [{ TicketType: 1, FareClass: 1, Price: 25 }] }]
  };
  const KLRT = {   // 輕軌：站別時刻表（StationTimeTable，實際發車時刻）＋站間時間
    station: [st('KLRT', 'C14', '測試輕軌巨蛋', at(4, 3, 0.0001, 0.0001)), st('KLRT', 'C13', '測試輕軌終點', at(4, 4, 0, 0.0001))],
    stationOfRoute: [{ RouteID: 'C-1', LineID: 'C', Direction: 0, Stations: [{ Sequence: 1, StationID: 'C14' }, { Sequence: 2, StationID: 'C13' }] }],
    s2s: [{ LineID: 'C', TravelTimes: [{ FromStationID: 'C14', ToStationID: 'C13', RunTime: 120, StopTime: 20 }] }],
    stationTimeTable: [{ RouteID: 'C-1', LineID: 'C', StationID: 'C14', Direction: 0, DestinationStaionID: 'C13', Timetables: ['09:30', '09:40', '09:50', '10:00', '10:10'].map((t, i) => ({ Sequence: i + 1, DepartureTime: t, ArrivalTime: t })), ServiceDay: { ServiceTag: '平日', Monday: true, Tuesday: true, Wednesday: true, Thursday: true, Friday: true, Saturday: false, Sunday: false, NationalHolidays: false } }]
  };
  const NTALRT = { station: [st('NTALRT', 'K01', '測試沒有班次的站', at(1, 3)), st('NTALRT', 'K02', '測試沒有班次的站二', at(1, 4))], stationOfRoute: [{ RouteID: 'K-1', LineID: 'K', Direction: 0, Stations: [{ Sequence: 1, StationID: 'K01' }, { Sequence: 2, StationID: 'K02' }] }] };
  const shared = [{ SystemID: 'KRTC', TransferStationID: 'X1', Stations: [{ StationID: 'R14', StationName: '測試巨蛋' }, { StationID: 'C14', StationName: '測試輕軌巨蛋' }] }];
  const gis = { THSR: [{ LineID: 'THSR', LineName: nm('高鐵'), Geometry: `LINESTRING(${at(2, 3, 0.0001, 0.0001)[1]} ${at(2, 3, 0.0001, 0.0001)[0]}, 120.6560 24.1520, ${at(4, 0, 0.0001, 0.0001)[1]} ${at(4, 0, 0.0001, 0.0001)[0]})` }] };
  // 公車：起點附近直達終點附近，但很慢（0 次轉乘的替代方案）
  const busStop = (k, [lat, lon], seq) => ({ StopUID: `TXG90${k}`, StopID: `90${k}`, StopName: nm(['測試公車起站', '測試公車迄站'][k]), StopSequence: seq, StopPosition: pos(lat, lon), StationID: `B${k}` });
  const bus = {
    stopOfRoute: [{ RouteUID: 'TXG99', RouteID: '99', RouteName: nm('99'), SubRouteUID: 'TXG990', SubRouteID: '990', SubRouteName: nm('99'), Direction: 0, City: 'Taichung', Operators: [{ OperatorID: 'OP', OperatorName: nm('測試客運') }], UpdateTime: '2026-11-19T03:00:00+08:00',
      Stops: [busStop(0, at(0, 0, 0.0003, 0.0002), 1), busStop(1, at(4, 4, -0.0003, -0.0002), 2)] }],
    schedule: [{ RouteUID: 'TXG99', SubRouteUID: 'TXG990', Direction: 0, Timetables: [{ TripID: '99-1', ServiceDay: WK, StopTimes: [{ StopSequence: 1, StopUID: 'TXG900', ArrivalTime: '08:05', DepartureTime: '08:05' }, { StopSequence: 2, StopUID: 'TXG901', ArrivalTime: '10:30', DepartureTime: '10:30' }] }] }]
  };
  const live = delay101 == null ? [] : [{ TrainNo: '101', StationID: '1000', StationName: nm('測試台中'), DelayTime: delay101, SrcUpdateTime: '2026-11-20T08:00:00+08:00', UpdateTime: '2026-11-20T08:00:00+08:00' }];
  return { TRA, THSR, KRTC, KLRT, NTALRT, shared, gis, bus, live };
}
// 假的 TDX：依路徑回傳上面的資料（其他回 404），並記下被問了哪些路徑
export function fakeTdx(fx) {
  const seen = [];
  const route = p => {
    const m = (re) => re.exec(p);
    let x;
    if ((x = m(/^\/Rail\/(TRA|THSR)\/Station/))) return fx[x[1]].station;
    if ((x = m(/^\/Rail\/(TRA|THSR)\/GeneralTimetable/))) return fx[x[1]].general;
    if ((x = m(/^\/Rail\/(TRA|THSR)\/DailyTimetable\/TrainDate\//))) return fx[x[1]].daily || [];
    if ((x = m(/^\/Rail\/(TRA|THSR)\/ODFare/))) return fx[x[1]].odFare;
    if (m(/^\/Rail\/TRA\/LiveTrainDelay/)) return fx.live;
    if ((x = m(/^\/Rail\/Metro\/(\w+)\/(\w+)\?/))) { const [, ep, op] = x; const key = { Station: 'station', StationOfRoute: 'stationOfRoute', Line: 'line', S2STravelTime: 's2s', Frequency: 'frequency', ODFare: 'odFare', StationTimeTable: 'stationTimeTable', TransferStations: 'shared' }[ep];
      if (ep === 'TransferStations') return op === 'KRTC' ? fx.shared : null; const d = fx[op] && fx[op][key]; return d || null; }
    if ((x = m(/^\/V3\/Map\/Rail\/Network\/Line\/OperatorCode\/(\w+)/))) return fx.gis[x[1]] || null;
    if (m(/^\/Bus\/StopOfRoute\/City\/Taichung/)) return fx.bus.stopOfRoute;
    if (m(/^\/Bus\/Schedule\/City\/Taichung/)) return fx.bus.schedule;
    return null;
  };
  return { seen, fetchJson: async p => { seen.push(p); const d = route(p); return d ? { status: 200, data: d } : { status: 404, data: null, detail: 'not found' }; } };
}
