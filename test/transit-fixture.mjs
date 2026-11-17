// transit-fixture.mjs — 測試用的小型城市（TDX 回應的形狀）。所有數字都是人工設定的測試資料，不代表任何真實班次。
const nm = s => ({ Zh_tw: s, En: s });
const pos = (lat, lon) => ({ PositionLat: lat, PositionLon: lon });
const WK = { Sunday: 0, Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1, Saturday: 0 }, WE = { Sunday: 1, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 1 };
const hm = s => `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}`;
export const DATE_WEEKDAY = '2026-11-17', DATE_WEEKEND = '2026-11-21';        // 週二、週六

// 站牌：東西向一排 A..F（去程在北側 uid 結尾 0、回程在南側結尾 1）
const names = ['甲站', '乙站', '丙站', '丁站', '戊站', '己站'];
const stop = (k, dir, seq) => ({ StopUID: `TXG${100 + k}${dir}`, StopID: `${100 + k}${dir}`, StopName: nm(names[k]), StopSequence: seq, StopPosition: pos(24.15 + (dir ? -0.0002 : 0.0002), 120.64 + k * 0.005), StationID: `S${k}`, StationGroupID: `G${k}` });
const sor = (route, sub, dir, name, ks, extra = {}) => ({ RouteUID: 'TXG' + route, RouteID: route, RouteName: nm(name), SubRouteUID: 'TXG' + sub, SubRouteID: sub, SubRouteName: nm(name), Direction: dir, City: 'Taichung',
  Operators: [{ OperatorID: 'OP1', OperatorName: nm('測試客運') }], UpdateTime: '2026-11-16T03:00:00+08:00', Stops: ks.map((k, i) => stop(k, dir, i + 1)), ...extra });

export function busFixture() {
  const stopOfRoute = [
    sor('1', '10', 0, '1', [0, 1, 2, 3]), sor('1', '10', 1, '1', [3, 2, 1, 0]),                 // 路線 1：完整逐站時刻
    sor('2', '20', 0, '2', [0, 2, 4, 5]),                                                      // 路線 2：只給起站發車時間＋有 S2S
    sor('3', '30', 0, '3', [1, 3, 5]),                                                         // 路線 3：只有班距
    sor('4', '40', 0, '4', [0, 1, 4]),                                                         // 路線 4：只有當日班表
    sor('5', '50', 0, '同名', [2, 3, 4]), sor('6', '60', 0, '同名', [4, 3, 2].map(k => k)),      // 路線 5、6：顯示名稱相同、UID 不同
    sor('7', '70', 0, '7', [0, 5]),                                                            // 路線 7：沒有任何班次資料
    sor('8', '80', 0, '8', [1, 2, 3])                                                          // 路線 8：只給起站時間、沒有 S2S（不能推算）
  ];
  stopOfRoute[6].Stops.forEach(s => { s.StopUID = s.StopUID.replace(/0$/, '1'); s.StopID = s.StopID.replace(/0$/, '1'); });   // 路線 6 用南側站牌
  const tt = (id, t0, step, n, sd, uidOf, seq0 = 1) => ({ TripID: id, ServiceDay: sd, StopTimes: Array.from({ length: n }, (_, i) => ({ StopSequence: seq0 + i, StopUID: uidOf(i), ArrivalTime: hm(t0 + i * step), DepartureTime: hm(t0 + i * step) })) });
  const u = (ks, dir) => i => `TXG${100 + ks[i]}${dir}`;
  const schedule = [
    { RouteUID: 'TXG1', SubRouteUID: 'TXG10', Direction: 0, Timetables: [
      ...[6, 7, 8, 9].map(h => tt('1-0-' + h, h * 3600, 300, 4, WK, u([0, 1, 2, 3], 0))), tt('1-0-we', 10 * 3600, 300, 4, WE, u([0, 1, 2, 3], 0)),
      tt('1-0-night', 23 * 3600 + 50 * 60, 300, 4, WK, u([0, 1, 2, 3], 0)),                                           // 跨午夜：23:50、23:55、00:00、00:05
      tt('1-0-express', 7 * 3600 + 60, 120, 4, WK, u([0, 1, 2, 3], 0)),                                               // 07:01 發、會超過 07:00 那班（超車）
      { TripID: '1-0-bad', ServiceDay: WK, StopTimes: [{ StopSequence: 1, StopUID: 'TXG1000', DepartureTime: '12:00' }, { StopSequence: 2, StopUID: 'TXG1010', DepartureTime: '11:30' }] } ] },   // 時間倒退
    { RouteUID: 'TXG1', SubRouteUID: 'TXG10', Direction: 1, Timetables: [6, 7].map(h => tt('1-1-' + h, h * 3600 + 1800, 300, 4, WK, u([3, 2, 1, 0], 1))) },
    { RouteUID: 'TXG2', SubRouteUID: 'TXG20', Direction: 0, Timetables: [7, 8].map(h => ({ TripID: '2-' + h, ServiceDay: WK, StopTimes: [{ StopSequence: 1, StopUID: 'TXG1000', ArrivalTime: hm(h * 3600), DepartureTime: hm(h * 3600) }] })) },
    { RouteUID: 'TXG3', SubRouteUID: 'TXG30', Direction: 0, Frequencys: [{ StartTime: '06:00', EndTime: '09:00', MinHeadwayMins: 10, MaxHeadwayMins: 15, ServiceDay: WK }, { StartTime: '09:00', EndTime: '22:00', MinHeadwayMins: 20, MaxHeadwayMins: 30, ServiceDay: WK }] },
    { RouteUID: 'TXG5', SubRouteUID: 'TXG50', Direction: 0, Timetables: [tt('5-a', 8 * 3600, 240, 3, WK, u([2, 3, 4], 0))] },
    { RouteUID: 'TXG6', SubRouteUID: 'TXG60', Direction: 0, Timetables: [tt('6-a', 8 * 3600, 240, 3, WK, u([4, 3, 2], 1))] },
    { RouteUID: 'TXG8', SubRouteUID: 'TXG80', Direction: 0, Timetables: [{ TripID: '8-a', ServiceDay: WK, StopTimes: [{ StopSequence: 1, StopUID: 'TXG1010', DepartureTime: '09:00' }] }] },
    { RouteUID: 'TXG99', SubRouteUID: 'TXG990', Direction: 0, Timetables: [tt('x', 3600, 60, 2, WK, () => 'nope')] }                                                                       // 不存在的路線
  ];
  const daily = [{ RouteUID: 'TXG4', SubRouteUID: 'TXG40', Direction: 0, BusDate: DATE_WEEKDAY, Timetables: [tt('4-a', 9 * 3600, 360, 3, null, u([0, 1, 4], 0)), tt('4-b', 10 * 3600, 360, 3, null, u([0, 1, 4], 0))] },
    { RouteUID: 'TXG1', SubRouteUID: 'TXG10', Direction: 1, BusDate: DATE_WEEKDAY, Timetables: [tt('1-1-daily', 15 * 3600, 300, 4, null, u([3, 2, 1, 0], 1))] }];           // 路線 1 回程：今天有當日班表 → 取代固定班表
  const s2s = [{ RouteUID: 'TXG2', SubRouteUID: 'TXG20', Direction: 0, TravelTimes: [{ FromStopID: '1000', ToStopID: '1020', RunTime: 400 }, { FromStopID: '1020', ToStopID: '1040', RunTime: 500 }, { FromStopID: '1040', ToStopID: '1050', RunTime: 200 }] }];
  return { stopOfRoute, schedule, daily, s2s };
}
// DailyStopTimeTable 形狀（每站一串 TimeTables；沒有 Direction 欄位）
export const dailyStopFixture = () => [{ RouteUID: 'TXG1', SubRouteUID: 'TXG10', BusDate: DATE_WEEKEND + 'T00:00:00+08:00', Stops: [3, 2, 1, 0].map((k, i) => ({ StopUID: `TXG${100 + k}1`, StopID: `${100 + k}1`,
  TimeTables: [{ Sequence: 1, ArrivalTime: hm(13 * 3600 + i * 300), DepartureTime: hm(13 * 3600 + i * 300) }, { Sequence: 2, ArrivalTime: hm(14 * 3600 + i * 300), DepartureTime: hm(14 * 3600 + i * 300) }] })) }];

// 捷運：G 線 5 站（有 S2S、班距、首末班車）；B 線 3 站（只有站序，其他都缺），G3 與 B2 是轉乘站
export function metroFixture() {
  const st = (id, name, lat, lon) => ({ StationUID: 'TMRT-' + id, StationID: id, StationName: nm(name), StationPosition: pos(lat, lon) });
  const station = [st('G1', '綠一', 24.16, 120.64), st('G2', '綠二', 24.16, 120.65), st('G3', '綠三', 24.16, 120.66), st('G4', '綠四', 24.16, 120.67), st('G5', '綠五', 24.16, 120.68),
    st('B1', '藍一', 24.15, 120.66), st('B2', '藍二', 24.1602, 120.6602), st('B3', '藍三', 24.17, 120.66)];
  const stationOfLine = [{ LineID: 'G', LineNo: 'G', Stations: [1, 2, 3, 4, 5].map(i => ({ Sequence: i, StationID: 'G' + i, StationName: nm('綠' + i) })) },
    { LineID: 'B', LineNo: 'B', Stations: [1, 2, 3].map(i => ({ Sequence: i, StationID: 'B' + i })) }];
  const line = [{ LineID: 'G', LineName: nm('綠線') }, { LineID: 'B', LineName: nm('藍線') }];
  const s2s = [{ LineID: 'G', TravelTimes: [1, 2, 3, 4].map(i => ({ Sequence: i, FromStationID: 'G' + i, ToStationID: 'G' + (i + 1), RunTime: 120, StopTime: 25 })) }];
  const frequency = [{ LineID: 'G', ServiceDay: WK, Headways: [{ PeakFlag: '1', StartTime: '07:00', EndTime: '09:00', MinHeadwayMins: 4, MaxHeadwayMins: 6 }, { PeakFlag: '0', StartTime: '09:00', EndTime: '24:00', MinHeadwayMins: 8, MaxHeadwayMins: 10 }, { PeakFlag: '0', StartTime: '06:00', EndTime: '07:00', MinHeadwayMins: 8, MaxHeadwayMins: 10 }] },
    { LineID: 'G', ServiceDay: WE, Headways: [{ PeakFlag: '0', StartTime: '06:00', EndTime: '24:00', MinHeadwayMins: 10, MaxHeadwayMins: 12 }] }];
  const fl = (s, dest, first, last) => ({ LineID: 'G', StationID: s, DestinationStaionID: dest, FirstTrainTime: first, LastTrainTime: last, ServiceDay: { ...WK, Saturday: 1, Sunday: 1 } });
  const firstLast = [fl('G1', 'G5', '06:00', '00:00'), fl('G3', 'G5', '06:05', '00:05'), fl('G5', 'G1', '06:00', '23:50'), fl('G3', 'G1', '06:05', '23:55')];
  const lineTransfer = [{ FromLineID: 'G', FromStationID: 'G3', ToLineID: 'B', ToStationID: 'B2', IsOnSiteTransfer: 1, TransferTime: 4 }, { FromLineID: 'B', FromStationID: 'B2', ToLineID: 'G', ToStationID: 'G3', IsOnSiteTransfer: 1, TransferTime: 4 }];
  const stationExit = [{ StationID: 'G1', ExitID: '1', ExitName: nm('出口1'), ExitPosition: pos(24.1601, 120.6401) }, { StationID: 'G1', ExitID: '2', ExitName: nm('出口2'), ExitPosition: pos(24.1599, 120.6399) }];
  return { station, stationOfLine, line, s2s, frequency, firstLast, lineTransfer, stationExit };
}
// ETA 一筆
export const eta = (o = {}) => ({ RouteUID: 'TXG1', SubRouteUID: 'TXG10', Direction: 0, StopUID: 'TXG1000', StopSequence: 1, StopStatus: 0, EstimateTime: 240, PlateNumb: 'ABC-123', SrcUpdateTime: '2026-11-17T08:00:00+08:00', UpdateTime: '2026-11-17T08:00:05+08:00', ...o });
