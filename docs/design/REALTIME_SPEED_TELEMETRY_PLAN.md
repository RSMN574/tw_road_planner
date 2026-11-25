# 即時公車捷運、導航速度與速限、匿名交通資料：規劃（需求第十二～十六節）

狀態：**F 期（公車即時，v1.19.0）、H 期（導航速度與速限，v1.20.0）已實作**；G、I、J、K 尚未開始。你的決定（2026-11-25）：先做 **F 公車即時**；交通資料**上傳原始 GPS 軌跡、由伺服器轉成路段統計**；上傳的資料保存 **365 天**後自動刪除（原始軌跡的隱私風險最高，I 期實作時會再確認原始點是否要比路段統計更早刪除）。以下「實際支援」都來自 `docs/oas/` 的 OAS 與 2026-11-25 17:28 對 TDX 的實際呼叫（每個端點 `$top=2`，共 8 次）。

## 1. API 實際支援情況（已查證）

### 1.1 公車

| 資料 | 端點 | 實際回應（台中，真實呼叫） | 用途 |
|---|---|---|---|
| 車輛 GPS（A1 定時） | `/v2/Bus/RealTimeByFrequency/City/{City}`（22 縣市＋InterCity＋台灣好行） | ✓ `PlateNumb`、`RouteUID`、`SubRouteUID`、`Direction`、`BusPosition`、`Speed`、`Azimuth`、`DutyStatus`、`BusStatus`、`GPSTime`、`UpdateTime` | 地圖公車 Marker、方向、車號、資料時間 |
| 車輛到離站（A2 定點） | `/v2/Bus/RealTimeNearStop/City/{City}` | ✓ 另有 `StopUID`、`StopSequence`、`A2EventType`（進／離站）、`TripStartTime` | 目前所在站、下一站、班次（發車時間） |
| 預估到站（N1） | `/v2/Bus/EstimatedTimeOfArrival/City/{City}` | ✓ `RouteUID`、`SubRouteUID`、`Direction`、`StopUID`、`StopSequence`、`EstimateTime`、`StopStatus`、`NextBusTime`、`Estimates[]`（含 `IsLastBus`）、`SrcUpdateTime` | 站牌到站時間、下一班、末班車 |
| 路線線形 | `/v2/Bus/Shape/City/{City}`（已同步） | ✓ | 公車位置吸附到實際路線 |
| 通阻／公告 | `/v2/Bus/Alert`、`/v2/Bus/News` | 未呼叫 | 暫停營運、改道 |
| DRTS、科學園區接駁 | `/v3/Bus/DRTS/...`、`/v3/Bus/Shuttle/...` | 未呼叫 | 第二批 |

已有的程式：`server/transit/eta-store.mjs` 已用 `SubRouteUID｜Direction｜StopUID` 當鍵、記錄資料時間、判斷過期（180 秒）、區分 StopStatus，**但還沒有接上任何同步或 API**。

### 1.2 捷運／輕軌

| 系統 | 到站看板 LiveBoard | 列車即時位置 LivePosition | 出入口 StationExit | 通阻 Alert |
|---|:-:|:-:|:-:|:-:|
| 台北捷運 TRTC | ✓（實測：有倒數 `EstimateTime`、方向 `TripHeadSign`、`ServiceStatus`；**沒有月台欄位**） | ✗ | ✓ | ✓（實測：正常營運） |
| 新北捷運 NTMC（環狀線） | ✓ | ✗ | ✓ | ✓ |
| 桃園捷運 TYMC | ✓（**只有 A1～A21**） | ✗ | ✓ | ✓ |
| 台中捷運 TMRT | **✗（實測回 400：不接受 TMRT）** | ✗ | ✓ | ✓ |
| 高雄捷運 KRTC | ✓ | ✗ | ✓ | ✓ |
| 高雄輕軌 KLRT | ✓ | **✓（實測：經緯度、速度、方位角、GPSTime）** | ✗ | ✓ |
| 淡海輕軌 NTALRT、安坑輕軌 NTDLRT | ✓ | ✗ | ✗ | ✓ |
| 貓空纜車 TRTCMG | ✗ | ✗ | ✓ | ✓ |

→ **只有高雄輕軌有真實列車位置**。其他系統只能顯示到站倒數，並標示「目前無列車位置資料」，不從倒數推算列車位置。台中捷運只能顯示時刻表（已有），標示「TDX 未提供台中捷運即時到站」。

### 1.3 台鐵、高鐵
- 台鐵 v3 `TrainLiveBoard`（實測：車次、目前車站、`TrainStationStatus`、`DelayTime`）、`StationLiveBoard`：可做「列車目前在哪一站」（車站層級，不是 GPS）。
- 台鐵誤點 `LiveTrainDelay` 已在用（v1.11）。高鐵 OAS 沒有即時列車位置。

### 1.4 道路速限
- OSM：`maxspeed`、`maxspeed:forward`、`maxspeed:backward`、區域代碼（TW:urban）**已解析並依方向套用**；`maxspeed:conditional`、各車種速限（`maxspeed:hgv` 等）**尚未解析**。
- **全台只有 5.7% 的道路長度有 OSM 速限標籤**（另 0.1% 是區域代碼）；其餘 94.2% 目前的路線時間用「依道路類別推估」——這個推估值**不會**再被當成速限顯示。
- 官方速限：TDX 路況 v2 的路段（Section）有 `SpeedLimit` 欄位，實測 **只有國道 474 段有值**（90～110 km/h）；公路局 6,825 段與 11 個縣市全部是空的。`/V3/Map/Road/Network` 沒有速限欄位。
- 結論：導航畫面大多數道路會顯示「速限未知」。這是資料現況，不補猜測值。

### 1.5 API 使用量（TDX：1,500 次呼叫＝1 點）
- 全縣市 A1／N1 每 30 秒輪詢一次 ≈ 每天 22×2×2,880 ≈ 12.7 萬次 ≈ **85 點／天**，而且台北一次回應數 MB——不採用。
- 採用「有人在看才抓」：只抓使用者正在看的路線、站牌、車站（`/{City}/{RouteName}` 或 `$filter`），伺服器快取 20～30 秒、相同請求合併，所有使用者共用。估計少量使用者時每天數百～數千次。

## 2. 分期

| 期 | 內容 | 主要工作 |
|---|---|---|
| F | **公車即時** | `BusRealtimeService`（A1／A2／N1，依城市、路線獨立快取與輪詢、逾時、過期判斷）接上既有 `eta-store`；站牌卡（路線、方向、目的地、ETA、下一班、末班、StopStatus 六種狀態、資料時間與來源）；地圖公車圖層（只顯示選取的路線：位置吸附到 Bus Shape、方向箭頭、車號、下一站、資料時間；過期變灰並標示，不做假動畫）；獨立的 SVG 圖層，更新時只重畫這一層 |
| G | **捷運／輕軌／台鐵即時** | `MetroRealtimeService`（LiveBoard 7 系統、KLRT LivePosition、Alert）、`TrainRealtimeService`（TRA TrainLiveBoard／StationLiveBoard）；捷運線與站圖層、轉乘站、出入口；點車站看各方向到站；只有 KLRT 畫列車 Marker；共用 `RealtimeDataCache`、`TransitRealtimeRepository` |
| H | **導航速度＋速限** | 速度：GPS speed＋卡爾曼＋EMA＋異常值過濾（已有 `gps-filter` 的基礎）、靜止／低速／精度不足／中斷狀態；`SpeedLimitService`：OSM（含方向、新增 conditional 與車種）＋TDX 國道官方速限（對應到 OSM 已有的路段匹配）＋來源／版本／可信度；匹配用 OSM way id＋路線吸附＋行駛方向；導航面板：速度、速限或「速限未知」、比較、精度、路名、下一轉彎 |
| I | **匿名交通資料蒐集** | 同意流程與設定頁（獨立於導航、可暫停／停止、用途與保存政策、刪除）；品質檢查；上傳 API（批次、驗證、去重、限流）；伺服器儲存、保存期限、刪除 |
| J | **路段統計、ETA、儀表板** | `RoadSegmentStatistics`（最低樣本門檻、信心等級、時段分組）；歷史速度與即時分開接進 ETA；內部儀表板（ADMIN_TOKEN 保護）；ETA 評估（MAE／RMSE／MAPE，時間切分） |
| K | 報告 | `TAIWAN_MAP_NAVIGATION_V2_AUDIT.md` 新增第 12～16 章（原本的「12. 補充：真實 TDX 資料驗證」會改成附錄，避免編號重複） |

## 3. 誠實的限制（先講清楚）
- 目前**沒有任何 GPS 樣本**：J 期做得出資料表、API、儀表板與評估程式，但統計結果與模型誤差要等真的有人同意並開過車之後才有；在那之前報告只能標「未驗證」。測試只能用模擬資料，會明確標示。
- 系統**沒有帳號**：「使用者」只能用裝置上隨機產生的匿名 ID（存在瀏覽器）；刪除資料靠這個 ID 加一把只存在裝置上的刪除金鑰。清除瀏覽器資料後就無法再刪除舊資料——這點會在設定頁寫明，並用保存期限兜底。
- 背景導航：網頁在背景時瀏覽器可能停止定位（v1.7 起已說明），所以也不會在背景蒐集。
