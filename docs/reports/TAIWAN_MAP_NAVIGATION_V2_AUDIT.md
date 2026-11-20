# 台灣通 v1.11.0 技術報告：全台 OSM 路網、大眾運輸、地圖引擎與智慧導航

- 版本：v1.10.0 → **v1.11.0**（`package.json`）
- 分支：`feature/v1.11-map-transit-nav`（從 `master` 的工作目錄開出；`master` 沒有被修改；**全部未 commit、未 push**）
- 日期：2026-11-20
- 資料：Geofabrik `taiwan-20261117.osm.pbf`（328 MB，資料時間 2026-11-17 21:24 UTC）；使用者提供的 TDX OAS（`docs/oas/`）
- 測試分類標示：**〔真〕** 真實資料測試、**〔模〕** 模擬資料測試、**〔單〕** 單元測試、**〔整〕** 整合測試、**〔未〕** 尚未測試

> 一句話結論：OSM 路網、轉向限制（含時段）、通行權、建築、地圖縮放／3D、HMM 導航都已用**真實的全台 OSM 資料**實作並驗證；台鐵／高鐵／捷運／輕軌已能實際參與 RAPTOR 路線規劃、輸出與地圖繪製，但因為開發環境**沒有 TDX 金鑰**，軌道與道路事件只用「依 OAS 欄位做的模擬資料」測過，**還不具備正式部署條件**（見第 11 節）。

---

## 1. 專案現況（修改前）

| 項目 | 現況（v1.10.0） |
|---|---|
| 技術架構 | 零依賴 Node 伺服器（`server/`，worker_threads 背景計算）＋零依賴網頁（`js/` 48 個 ES module，`build.mjs` 打包成單檔） |
| OSM 資料來源 | Geofabrik 台灣 PBF → `tools/osm/osm-build.mjs`（自寫 PBF 讀取器）→ `data/osm/graph/<日期>/osm-graph.twosm`（型別陣列二進位檔） |
| Graph 建立 | 頂點只來自 OSM node id（不用座標合併）；way 在路口切成邊；高度層衝突拆點；五種運具 4-bit 通行狀態；轉向限制 relation（via node／via way）；ALT 地標表 |
| GIS API | 只用 TDX 公車與台中捷運（`server/transit/*` 資料層已有，**伺服器端沒有時刻表路由**）；沒有台鐵、高鐵、輕軌；沒有用 GIS 圖資 API |
| 地圖 SDK | **沒有用 MapLibre／Leaflet／Google Maps**：自寫 SVG 渲染器（`render-core.js`）＋伺服器 JSON 向量圖磚（`/api/v1/osm/tiles`） |
| 導航 | GPS 卡爾曼濾波、視窗投影 Map Matching、偏航防抖、ETA 模型（路段速度＋路口延遲＋平滑）、自動鏡頭（速度／路口縮放、遲滯）、CSS 傾斜、語音（Web Speech） |
| 資料庫 | **沒有 PostgreSQL／MySQL／Redis**：路網是記憶體映射的型別陣列（CSR）、格網空間索引、LRU 快取；TDX 資料以 gzip JSON 快取 |

## 2. OSM 路網品質（〔真〕全台資料，`npm run osm:audit`，53 秒）

完整數字：`docs/reports/osm-audit-20261117.md`（也存一份在 `data/osm/graph/20261117/audit.md`）。

### 2.1 規模
1,407,386 頂點、1,825,124 邊、8,478,883 幾何點、823,749 條道路 way、195,366 km。

### 2.2 拓樸與幾何

| 檢查 | 結果 | 判讀 |
|---|---:|---|
| 孤立頂點（全圖） | 0 | 建圖只保留有邊的頂點 |
| 長度 0 的邊 | 32 | 少量，資料錯誤 |
| 自我迴圈 | 1,392 | 1,383 條 ≥ 20 m 是環狀道路（正常） |
| 重複邊（同兩端、同 node 序列） | 767 | 兩條 way 重疊畫線 |
| 平行邊（同兩端、幾何不同） | 9,978 | 通常正常 |
| 座標相同但 OSM node 不同（同高度層） | 57（其中 48 處兩邊都是道路端點） | **看起來相接、其實斷開**，影響連通 |
| 高度層衝突 node（建圖時已拆開） | 1,081 | 不同 layer／橋／隧道在中間點共用 node |
| 不合理長邊（依類別門檻） | 73 | 待人工檢查 |
| 單一線段 > 2 km | 9 | 可能缺 node |
| 折返尖刺 > 170° | 16 | 幾何錯誤 |
| 死路端點 | 323,222 | |
| 端點 ≤ 3 m 內有同高度道路卻沒接上（undershoot） | 7,243 | 多為 footway 5,014、steps 698、service 637 |

**實際交會 vs 只是幾何相交**（兩條路線段相交但沒有共用 node）：

| 類型 | 數量 | 判斷 |
|---|---:|---|
| 立體交叉（高度層不同，或任一條是橋／隧道） | 32,963 | 正常，不相連是對的 |
| 同高度、都是車道 | **247** | 疑似漏接路口（主要是 track×track 166、service×track 39） |
| 同高度、一邊是人行道／小徑 | 3,204 | 疑似缺穿越點（footway×footway 1,176） |
| 同高度、共線重疊 > 50 m | 13 | 重複畫線 |

> ⚠ **自我修正紀錄**：第一次跑稽核時「疑似漏接路口」是 67,439、「座標相同」是 8,022——這是我寫的稽核程式的錯誤：把（格子, 線段）、（緯度, 經度）打包成一個數字時超過 2^53，浮點數失真。修正後（以資料範圍為原點、兩鍵分開比較）重跑，數字如上表。抽查樣本都是同一處的不同線段，已合理。

### 2.3 單行道與轉向限制
- 單行：`oneway`、`oneway:bicycle`、`oneway:motor_vehicle`（等運具鍵）、`junction=roundabout`、國道隱含單行——v1.9 已實作，本版沿用。
- 轉向限制：3,170 個 relation，套用 2,885（via node 2,455、via way 430；no_* 2,455、only_* 430）；`except`、`restriction:<運具>`、多 via way 已支援。路由以「有向邊」為狀態，是 turn-aware routing。
- **新增：時段條件依出發時間判斷**（`server/osm/conditional.mjs`）。352 個有時段條件的 relation 中 **344（97.7%）可判斷**；2026-11-20 08:00（週五）適用 104 個（稽核時的時間）。無法判斷的 8 種寫法（只在國定假日 `PH …`、依重量 `weight>6.5`）**不套用並在路線結果回報**。`, PH off` 因為沒有國定假日日曆，照平日判斷並記錄（對禁止類限制是保守的）。
- 同時修正：舊版用 `;` 切 `restriction:conditional`，會把 `(Mo-Fr 07:00-09:00; Sa …)` 切壞；改成依括號深度切開，並重建了全台圖（舊建置備份在 `data/osm/graph/_backup-20261117-v1.10/`）。

### 2.4 橋梁、地下道與高度層
`bridge`、`tunnel`、`layer` 已用於判斷同一 node 上的不同高度道路（不相連）。**新增** `location=underground／underwater`＝−1、`overground／overhead／roof`＝+1；`covered=yes` 不改變高度（有頂蓋的平面道路）。`level`（室內樓層）已記錄。這次重建全台圖的高度層衝突數不變（1,081），表示 `location` 標籤在台灣道路上很少見。

### 2.5 各運具通行權限
共用一張圖、五個 Access Profile（car、heavy＝大型重機、moto、bike、foot），依 `motorcar > motor_vehicle > vehicle > access` 等鏈判斷，`:forward／:backward` 分方向。**新增對外四態**（`access4`）：`allowed／restricted／prohibited／unknown`＋來源（`tag`、`default`、`oneway`）。

全台有向公里數（〔真〕）：

| 運具 | allowed（標籤） | allowed（依類別推定） | restricted | prohibited（標籤） | prohibited（推定） | prohibited（單行反向） | unknown |
|---|---:|---:|---:|---:|---:|---:|---:|
| 汽車 | 2,526 | 251,310 | 5,508 | 4,799 | 49,253 | 20,351 | 56,985 |
| 機車 | 2,642 | 246,370 | 5,500 | 5,629 | 58,037 | 15,491 | 57,065 |
| 自行車 | 8,291 | 316,143 | 5,266 | 7,261 | 10,081 | 15,429 | 28,264 |
| 步行 | 8,752 | 360,746 | 5,714 | 4,279 | 8,943 | 14 | 2,286 |

說明：「依類別推定」不是「沒有標籤就當可通行」——它依的是 `highway` 這個標籤加上台灣法規（例如國道禁機車），與「標籤明確允許」分開記錄、分開顯示。真正沒有可靠依據的（例如汽車走 `highway=track`）是 `unknown`，路線規劃預設成本 ×3 並警告，不當成允許。

### 2.6 全台連通性（有向、無向分開）

| 運具 | 可用頂點 | 弱連通分量 | 最大弱連通（含渡輪／不含） | 孤立頂點 | 強連通分量 | 最大強連通 | 方向性受限（進得去出不來＋出得來進不去） |
|---|---:|---:|---|---:|---:|---:|---:|
| 汽車 | 1,178,782 | 1,313 | 98.86%／97.98% | 0 | 3,770 | 98.60% | 3,080 |
| 大型重機 | 1,171,572 | 1,395 | 98.75%／97.87% | 0 | 4,751 | 98.41% | 4,007 |
| 機車 | 1,169,034 | 1,461 | 98.73%／97.85% | 0 | 5,947 | 98.30% | 5,025 |
| 自行車 | 1,380,026 | 7,489 | 97.55%／96.62% | 0 | 11,209 | 97.24% | 4,170 |
| 步行 | 1,391,052 | 3,762 | 98.37%／97.41% | 0 | 4,113 | 98.34% | 439 |

- 「方向性受限」是在最大弱連通區內、但不在最大強連通區的頂點：多半是單行道、停車場出口、只出不進車道，**不等於資料錯誤**，報告分開列出。
- 汽車不含渡輪時無法連到本島的區域：澎湖 47 個分量（7,939 頂點）、金門 20（7,787）、本島內 1,295 個小區塊（4,731 頂點）。

**跨縣市實際路由〔真〕**：25 組（相鄰縣市＋長距離＋離島）全部有結果，只有臺北→金門 `NO_ROUTE`（OSM 沒有道路或航線連接，正確）。需要人工看的：臺南→高雄、花蓮→宜蘭的**步行**路線走了渡輪航段（OSM 的航線行人通行權多為「未知」）；臺北→臺東汽車 515 km（走西部國道＋南迴，比走蘇花更快，時間模型使然）；經渡輪到澎湖、馬祖的汽機車路線**不代表航線真的可載車**。

## 3. GIS OAS API 分析

使用者提供（`~/Downloads`，已複製到 `docs/oas/`）：GIS圖資 v3（39 條路徑）、公共運輸-軌道 v2（85）、公共運輸-公車 v2（79）、道路事件 v1（6）、路況資訊 v2（79）、自行車 v2（3）等。**GIS圖資 OAS 本身沒有時刻表**，只有圖資；時刻表、票價、即時在「軌道 v2」。

### 3.1 運輸系統支援程度（依 OAS 的 enum 判斷「API 有沒有提供」）

| 系統 | 車站 | 路線／站序 | 時刻表 | 班距 | 站間時間 | 即時 | 票價 | 轉乘 | 線型（GIS） | 本版是否接上 |
|---|---|---|---|---|---|---|---|---|---|---|
| 台鐵 TRA | ✓ Station | 由時刻表停靠站 | ✓ General／Daily（含停駛） | — | 由時刻表 | ✓ LiveTrainDelay、LiveBoard | ✓ ODFare（票種名稱字串） | — | ✓ Line/Station/Segment | ✓（即時誤點已計入） |
| 高鐵 THSR | ✓ | 由時刻表 | ✓ General（含有效期間）／Daily | — | 由時刻表 | AlertInfo、座位 | ✓ ODFare（票種/身分/車廂） | — | ✓ | ✓ |
| 台北捷運 TRTC／新北 NTMC／桃園 TYMC／高雄 KRTC | ✓ | ✓ StationOfRoute | ✓ StationTimeTable（站別） | ✓ | ✓ | LiveBoard、Alert | ✓ | ✓ LineTransfer、StationTransfer、TransferStations | ✓ | ✓ |
| 台中捷運 TMRT | ✓ | ✓ | ✗（StationTimeTable 沒有 TMRT） | ✓ | ✓ | Alert | ✓ | — | ✓ | ✓（依班距推估並標示） |
| 輕軌 KLRT／NTDLRT／NTALRT | ✓ | ✓ | ✓ StationTimeTable | ✗ | KLRT ✓，淡海／安坑 ✗ | LiveBoard | ✓ | — | ✓ | ✓（缺站間時間時依距離推估並標示） |
| 公車（城市） | ✓ | ✓ StopOfRoute | ✓ Schedule／DailyTimeTable | ✓ | ✓ | ✓ ETA | GIS 有 BusODFare（未接） | — | ✓ | ✓（一個縣市；票價未接） |

### 3.2 Schema 與更新頻率（本版設定的同步週期）
車站、線型每 7～30 天；定期時刻表、站序 24 小時；當日時刻表 6 小時（路徑含日期，每次更新重算）；台鐵即時誤點 2 分鐘（只用 15 分鐘內的資料）；道路事件建議 1～5 分鐘（排程）。所有原始回應以 gzip 保留在 `CACHE_DIR/transit/raw/`，`meta.json` 記錄抓取時間、雜湊、筆數、錯誤；資料版本＝各資料集雜湊（`store.version`）。

### 3.3 API 限制
- **沒有 TDX 金鑰時**：只能「訪客模式」，限瀏覽器、只能用基礎服務、每 IP 每日 20 次——**GIS 圖資屬於會員服務**。本開發環境找不到金鑰（`token.txt`、`.env` 都沒有），所以**沒有呼叫任何真實 TDX API**。
- 只問 OAS enum 有列的業者（例如 Frequency 不問 KLRT），避免 HTTP 400。
- 軌道 v2 的 `DestinationStaionID` 拼字照原樣處理。

### 3.4 缺少的資料
台中捷運沒有站別時刻表；淡海、安坑輕軌沒有站間時間；台鐵票價的票種是字串、無法可靠對應車種；沒有月台到月台的站內轉乘時間（只有部分系統的 MinTransferTime）；國定假日日曆。

## 4. 大眾運輸整合

### 4.1 統一資料模型（`server/transit/timetable-store.mjs` 擴充、`rail-provider.mjs` 新增）

| 模型 | 對應 |
|---|---|
| TransitOperator | `stop.operator`／`pattern.operator`（TRA、THSR、TRTC…） |
| TransitStation | `stops[]`：uid（TDX StationUID，不因名稱合併）、mode（bus／metro／lrt／tra／thsr）、座標、來源、版本、更新時間 |
| TransitRoute | `patterns[]`：同一組停靠站序＝一個型態（台鐵依停站模式分型態），保留方向、站序 |
| TransitTrip | `pattern.trips[]`：車次、kind（schedule／daily）、適用星期、有效期間、停駛 |
| TransitStopTime | `trip.dep[]／arr[]`（營運日秒數，跨午夜 24:xx） |
| TransitCalendar | ServiceDay 遮罩、THSR 有效期間、當日班表優先 |
| TransitRealtime | 台鐵 LiveTrainDelay（`traDelays`）、既有公車 ETA |
| TransitTransfer | `transfer-engine.mjs`：OSM 步行路徑、TDX 站內轉乘、共站 |

### 4.2 Transit Graph 與轉乘（TransferEngine）
- 站外步行：先以直線 450 m 篩候選，再用 **OSM 步行路網實際走**（`OsmRouter.footReach`，有上限的 Dijkstra）；走不到的不連（模擬測試中排除 2 對）。
- 站內轉乘：TDX 有時間的優先（StationTransfer 的 MinTransferTime、LineTransfer）；共站（TransferStations）沒有時間時用步行結果。
- 進出站時間沒有資料，用保守固定值並標示推估：台鐵 120 秒、高鐵 240、捷運 90、輕軌 30；同站換車預留：台鐵 180、高鐵 300、捷運／輕軌 60、公車 30。
- 時刻表運輸不是靜態道路邊：每段乘車都依班次時刻（時間相依）。

### 4.3 RAPTOR／CSA 評估
選 **RAPTOR**（`server/transit/raptor.mjs`）：直接使用已依時間排序的班次群組、天然得到「轉乘次數」維度；CSA 需要把全台班次攤平成連線並排序，記憶體與前處理成本高。實作：搭車抵達與步行抵達兩種標籤分開（轉乘集合不是遞移封閉的，否則較早的步行抵達會擋掉能再轉乘的搭車抵達——這是測試抓到的錯誤，已修正）；凌晨同時考慮前一營運日的 24:xx 班次；捷運／輕軌依「站別時刻表 → 班距推估 → 資訊不足不搭」的順序。多目標：主搜尋＋較短步行上限再跑一次，合併後取 Pareto（抵達 × 轉乘 × 步行），標記最快、最少轉乘、最少步行、最便宜（每段有票價時）、建議。

### 4.4 路線搜尋結果〔模〕〔整〕（`test/transit-rail.mjs`，28 項全過）
模擬資料：台鐵 2 站、高鐵 2 站、捷運 3 站（只有班距）、輕軌 2 站（站別時刻表）、沒有班次的輕軌、一條慢速公車；步行用真的 OSM 測試路網。
- 最快：台鐵 101 次 08:05 → 步行 120 m 轉高鐵 0803 次 08:25 → 捷運（依班距推估） → 共站轉輕軌 09:30 → 抵達 09:32（3 次轉乘）。
- 最少轉乘：公車直達（0 次轉乘，10:30）。
- 台鐵 101 次即時誤點 6 分 → 趕不上 0803，改搭 0805，抵達變晚。
- 當日停駛的車次不出現；跨午夜 23:50→00:10 換算成 24:10；運具篩選；太晚無班次時回空結果、不捏造；起點附近沒有車站時說明。
- 票價：高鐵 790、捷運 25；台鐵兩種票種 15～21 元不確定 → 總價不算。高鐵段沿 GIS WKT 線型。
- 查詢時間 5 ms（模擬資料）。〔未〕**全台真實資料的查詢時間沒有量**。

### 4.5 前端顯示〔整〕〔模〕
伺服器（真實全台 OSM 圖＋模擬軌道快取 `node test/make-transit-cache.mjs`）→ 網頁「大眾運輸」：HTTP 回應 1.4 秒（第一次含建立轉乘），清單、每段明細（車次、方向、上下車站、等候、步行來源、推估標示）、地圖依運具上色、步行段沿真實街道。已在內建瀏覽器實際操作確認。

## 5. 地圖引擎升級

| 項目 | 修改前 | 修改後 |
|---|---|---|
| 縮放上限 | 滾輪「起始畫面 ×20」、雙指 ×60、導航 ×60（全台起始時約 z12，25 m／像素） | **z5～z21**，依每像素公尺數換算（z19≈0.27 m／像素、z21≈0.07 m／像素），所有縮放都經 `clampScale` |
| 限制原因 | 上限是相對值、與底圖解析度無關；圖磚只抓到 z16 | — |
| 底圖解析度 | 圖磚 z16（512 像素）簡化容許 4 單位 | 圖磚抓到 z18（＝一般地圖 z19），座標量化 3.4 cm；z19 以上是向量 overzoom，畫面提示 |
| Vector Tiles | 自訂 JSON 向量圖磚（非 MVT） | 同上，新增道路寬度欄位；建築圖磚 `/api/v1/osm/buildings/{z}/{x}/{y}.json` |
| 道路顯示 | 固定像素寬 | z17 以上依實際寬度（`width`／`lanes`／類別典型值）、z17.5 單行箭頭、z18 路名放大 |
| 建築 | 無 | 604,029 棟（OSM），z16 外框、3D 2.5D 立體、z18 名稱；高度來源：OSM height 1.8%、樓層推算 11.1%、**推估 87.1%（虛線半透明）** |
| 縮放體驗 | 滾輪立即跳 | 平滑縮放（游標為中心）、拖曳慣性、雙指縮放＋旋轉、雙擊放大、鍵盤 ±、縮放層級與比例尺顯示 |
| 2D／3D、旋轉 | 只在導航時 | 瀏覽時也可旋轉、俯仰（0～55°）、指北針回北 |

**瀏覽器實測〔真〕**（內建瀏覽器、1024×768 桌面、全台真實圖、台北大安區；只量 JS 產生畫面的時間，不含排版／繪製）：z14 7.9 ms、z16 29.9 ms、z17 11.7 ms、z19 3.1 ms、z21 1.9 ms；3D 50°：z17.3 66.3 ms、z18.5 19.8 ms。3D 指標反投影誤差 0.0008 m（不反投影 234 m）。〔未〕手機實機效能、雙指手勢實機。

## 6. 智慧導航升級

| 項目 | 狀態 |
|---|---|
| GPS／Kalman／方向估算／精度判斷 | 既有（v1.8），未改 |
| Map Matching | **新增 HMM**（`js/hmm-match.js`，路線版 Newson–Krumm，線上 Viterbi）。〔模〕分隔道路去回、低速沒有方向：錯到另一側 視窗法 8～9% → HMM 0%；導航引擎中進度最大誤差 45 → 22 m、平均 8.2 → 6.5 m；高速情境不變差；不誤判偏航 |
| Route Progress／Off-route | 既有的防跳、遲滯、冷卻沿用；HMM 沒有候選時退回舊方法 |
| ETA | 既有：沿路線剩餘距離、路段速度、轉彎與路口延遲、平滑；**未使用即時路況**（TDX 路況 API 未接）。HMM 加入後 ETA 模擬指標不變（一般 MAPE 11.6%） |
| 重新導航 | 既有防抖與冷卻；**新增**：重新規劃時會套用道路事件（封閉避開）與時段轉向限制 |
| 語音 | 既有（前方／即將轉彎、偏航、重新規劃、抵達）；未改。〔未〕鎖定螢幕後的背景定位與播報（瀏覽器限制，無法保證） |
| 自動縮放／路口放大 | 既有（速度、路口、遲滯 15%、冷卻 2 秒）；上下限改用 z5～z21 |
| 3D 建築與路口 | 建築 2.5D 已可在導航傾斜時顯示；〔未〕交流道專用放大視圖 |

## 7. 架構與資料

```
TDX（軌道 v2／GIS v3／公車 v2／道路事件 v1）──transit-sync／traffic-sync──▶ CACHE_DIR（gzip JSON＋meta）
Geofabrik PBF──osm-build／osm-buildings──▶ data/osm/graph/<日期>/（osm-graph.twosm、osm-alt.bin、osm-buildings.twbld、audit.md）
                        │
 server.mjs（HTTP、快取、限流）──backend──▶ route-worker（worker_threads）
                                            ├ osm-engine：OsmRouter（turn-aware A*＋ALT、時段限制、事件 overlay、footReach）、圖磚、建築
                                            └ transit-engine：TimetableStore → TransferEngine → RAPTOR → 票價／線型
網頁：render-core（SVG）← osm.js（底圖）＋osm-buildings.js＋transit-plan.js；map-view.js（縮放／3D）；navigation.js＋hmm-match.js
```

模組對應需求名稱：RoadGraphValidator＝`server/osm/audit.mjs`；TurnRestrictionEngine＝`restrictions.mjs`＋`conditional.mjs`＋`router.profileAt`；AccessProfileEngine＝`access.mjs`；TransitDataAdapter＝`rail-provider.mjs`、`metro-provider.mjs`、`bus-provider.mjs`、`snapshot.mjs`；TransitGraphBuilder＝`timetable-store.mjs`；TransferEngine＝`transfer-engine.mjs`；TransitRouter＝`raptor.mjs`；MapMatcher＝`hmm-match.js`；RouteProgressEngine／ReRoutingEngine＝`navigation.js`；ETAEngine＝`eta-engine.js`；NavigationCamera／AutoZoomController＝`camera.js`＋`map-view.js`；TrafficEventEngine＝`server/traffic/events.mjs`。

**資料庫**：沒有使用 PostgreSQL／PostGIS／MySQL／Redis，所以**沒有資料庫遷移**；資料格式變更都向後相容（圖檔 TWOSM1 不變、圖磚多一個選用欄位、新增 TWBLD1 建築檔）。空間索引是格網（非 R-tree／GiST）。增量更新：TDX 只抓到期、雜湊沒變不重建；OSM 仍是整份重建（約 100 秒＋地標 31 秒）。

**API（新增）**：`GET /api/v1/transit/plan`、`GET /api/v1/transit/status`、`GET /api/v1/traffic/events`、`GET /api/v1/osm/buildings/{z}/{x}/{y}.json`；`/api/v1/osm/route` 新增 `depart`、`conditional`、`events`，回應新增 `conditionalRestrictions`、`traffic`、每條路線的 `events`；`/api/v1/osm/nearest` 新增 `accessProfile`、`structure`。

## 8. 修改紀錄

見 README〈v1.11.0〉的檔案清單。重要變更：
- `router.mjs`：`profileAt`（依時間的轉向限制，ALT 下界仍成立因為只會增加成本）、overlay（以有向邊為鍵）、`footSnap／footReach`。
- `restrictions.mjs`：條件式依括號切開。`tags.mjs`：`location` 高度層。`access.mjs`：`access4`。
- `osm-build.mjs`：Windows 上 `current.json` 寫出反斜線路徑（Linux 部署會壞）→ 改成 `/`；同時間檔案依檔名日期排序（修好 Windows 上原本失敗的 `test/osm-graph.mjs` 一項）。
- `snapshot.mjs`：軌道、GIS v3、道路事件 v1 的路徑；OAS enum 篩選；包裝物件回應；當日路徑含日期。
- 前端：`map-view.js`、`osm-buildings.js`、`transit-plan.js`、`hmm-match.js` 新增；`ui-events.js`、`ui-touch.js`、`nav-ui.js`、`osm.js`、`render-core.js`、`navigation.js` 修改。

## 9. 測試結果

`npm test`：**26 個測試檔全部通過**（671 個 ✓ 檢查，exit 0）。新增：

| 測試 | 類型 | 項目 | 結果 |
|---|---|---:|---|
| `test/osm-v111.mjs` | 〔單〕〔整〕〔模〕事件 | 27 | 全過：時段條件、依時間繞路（297 m vs 230 m）、四態、高度層、事件封閉改道（406 → 628 m）、稽核、建築檔 |
| `test/transit-rail.mjs` | 〔整〕〔模〕 | 28 | 全過（第 4.4 節） |
| `test/nav-hmm.mjs` | 〔模〕 | 8 | 全過（第 6 節） |
| `test/map-view.mjs` | 〔單〕 | 10 | 全過 |
| `npm run osm:audit` | 〔真〕 | — | 第 2 節 |
| 瀏覽器操作 | 〔真〕地圖／〔模〕軌道 | — | 縮放到 z19、3D、建築、反投影、大眾運輸清單與地圖 |

需求清單逐項：單行道〔整〕✓、禁止左右轉〔整〕✓（既有＋時段）、禁止迴轉〔整〕✓（既有）、橋梁地下道〔真〕✓、運具限制〔整〕〔真〕✓、跨縣市〔真〕✓、孤立節點／不連通〔真〕✓；台鐵、高鐵、捷運、輕軌、公車、公車轉捷運（〔未〕：模擬資料中公車沒有接捷運的情境）、台鐵轉高鐵〔模〕✓、高鐵轉捷運〔模〕✓、多次轉乘〔模〕✓、延誤〔模〕✓、無班次〔模〕✓、**跨縣市行程〔未〕**（需要真實資料）；最小／最大 Zoom〔單〕〔真〕✓、超出原生 Zoom〔真〕✓、高縮放道路與建築〔真〕✓、桌面滾輪〔真〕✓、**手機雙指〔未〕**（程式有，無實機）、旋轉／3D〔真〕✓、自動縮放（既有測試）、拖曳暫停跟隨（既有）；GPS 漂移／中斷／低速／平行道路〔模〕✓、偏航與重新導航（既有測試）、ETA〔模〕✓、路口放大（既有）、語音（既有測試）。

已知問題：`test/osm-graph.mjs` 的 MD5 情境原本在 Windows 失敗（已修）；3D 在 z17 的全畫面重繪 66 ms，手機可能卡頓；走步行的跨縣市路線會走渡輪（通行權未知）。

## 10. 後續工作

- **P0**：在有 TDX 金鑰的環境執行 `transit-sync --rail TRA,THSR --operators … --extras` 與 `traffic-sync`，用真實資料驗證軌道整合、量全台查詢時間與記憶體；確認 `Positions` 實際格式；確認台鐵 ODFare 的 TicketType 字串對應車種。
- **P0**：手機實機測試（雙指、3D 效能、GPS、語音、背景）。
- **P1**：OSM 稽核出的 48 處斷開端點、247 處疑似漏接路口、7,243 個 undershoot 人工確認並回報 OSM；渡輪航線的行人／車輛通行權。
- **P1**：公車 OD 票價（GIS BusODFare）、多縣市公車；大眾運輸方案的導航（目前導航只支援道路）；`*:conditional` 通行權依時間判斷（目前只有轉向限制）；國定假日日曆。
- **P2**：3D 建築的效能（合併路徑、Canvas／WebGL）；交流道放大視圖；即時路況（TDX 路況 API）接 ETA；替代路線比較（事件改道時列出原路線與新路線）。
- **P3**：Contraction Hierarchies、OSM 增量更新、標準 MVT 圖磚、PostGIS（多人寫入或空間查詢需求出現時再評估）。

## 11. 最終完成度

| 項目 | 狀態 |
|---|---|
| OSM 路網稽核工具與全台報告 | 已完成〔真〕 |
| 時段轉向限制 | 已完成〔真〕〔整〕（97.7% 可判斷） |
| 通行權四態 | 已完成 |
| 高度層（location） | 已完成（全台影響很小） |
| 道路事件整合 | 部分完成（程式與模擬測試完成；**沒有真實資料**） |
| 台鐵、高鐵、捷運、輕軌資料轉換 | 部分完成（依 OAS 實作、模擬資料測試；**真實資料未驗證**） |
| 多運具 RAPTOR、轉乘、票價、線型、前端 | 已完成〔模〕〔整〕；真實資料未驗證 |
| 地圖縮放 z5～z21、平滑、慣性、旋轉、3D | 已完成〔真〕（手機未驗證） |
| 建築 2D／2.5D | 已完成〔真〕（87% 高度為推估並標示） |
| HMM Map Matching | 已完成〔模〕 |
| ETA、重新導航、語音、自動鏡頭 | 既有功能沿用；ETA 未接即時路況 |
| 資料庫遷移 | 不適用（沒有資料庫） |

**必答問題：**
1. **全台 OSM 路網是否正確？** 大致正確但有已知缺陷：最大連通區汽車 98.9%（含渡輪）、0 孤立頂點；有 48 處端點重疊未合併、247 處疑似漏接路口、7,243 個疑似 undershoot（多為人行道）、767 條重複邊——都列在報告中待人工確認。
2. **各運具是否使用正確通行權限？** 是，依 OSM 標籤鏈與台灣法規推定，推定與標籤分開，未知不當允許；全台各運具的分布見 2.5。
3. **單行道與轉向限制是否有效？** 是：2,885 個 relation 套用、以有向邊做路由；時段條件依出發時間判斷（測試圖中平日 08:00 會繞路）。
4. **台鐵、高鐵、捷運、輕軌是否能實際參與路線規劃？** 程式上能，並已在搜尋、輸出、地圖繪製端對端運作；**但只用模擬資料驗證**，真實 TDX 資料尚未跑過。
5. **是否能產生多模式轉乘路線？** 能（模擬：台鐵→高鐵→捷運→輕軌 3 次轉乘，含步行與共站轉乘）。
6. **地圖是否可以進一步放大？** 是，從約 z12 提高到 z21。
7. **高縮放時是否仍有足夠細節？** 道路（真實寬度、單行箭頭、路名）與建築外框有；路面標線、車道、號誌位置沒有資料，不顯示。
8. **GPS 是否能穩定匹配道路？** 在路線上：模擬中 HMM 消除了路線靠近自己時的誤配；在整張路網上的平行道路與高架下方仍是已知限制（偏航後才會遇到）。實機未測。
9. **ETA 是否根據剩餘路段計算？** 是（沿路線剩餘距離×各路段預估速度＋路口延遲＋平滑），不是直線或瞬間速度。未含即時路況。
10. **是否能自動重新導航？** 是（既有，含防抖與冷卻）；本版加上避開封閉道路與時段限制。
11. **導航鏡頭是否能依速度與路口調整？** 是（既有），本版改為絕對縮放上下限並可顯示 3D 建築。
12. **是否具備正式部署條件？** **否。** 需要：真實 TDX 資料驗證（P0）、手機實機測試（P0）、把本分支整理 commit。道路導航部分（OSM、地圖、HMM）技術上可部署，但大眾運輸與道路事件在沒有真實資料驗證前不應宣稱可用。

## 人工確認清單
- [ ] 提供 TDX 金鑰，執行 `node tools/transit-sync.mjs --city Taipei --operators TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT --rail TRA,THSR --extras`，貼回輸出
- [ ] 執行 `npm run traffic:sync`，確認 `Positions`／`Geometry` 實際格式
- [ ] 台鐵 ODFare 的票種名稱要如何對應車種
- [ ] 手機（iOS／Android）實機：雙指、3D、導航
- [ ] `data/osm/graph/_backup-20261117-v1.10/`（約 470 MB）確認後可刪除
- [ ] 檢查並 commit `feature/v1.11-map-transit-nav` 分支
