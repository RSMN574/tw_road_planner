# 智慧公車路線規劃系統（bus-planner）

以**道路圖論**為基礎，結合**車種規則與速限、道路寬度／型態、YouBike、台中公車與捷運、TDX 即時資料**，在瀏覽器裡完成路線搜尋、公車路線建議與地圖分析。**零依賴、純前端**，沒有後端也沒有 npm 套件。

## 能做什麼

- **交通方式**：汽車、重型機車、一般機車、腳踏車、步行、大眾運輸（公車＋捷運）。各有通行規則、速限上限與行駛時間；顯示道路速限（路段 tooltip、導航步驟、路線分析、點擊查詢）。
- **目標**：道路模式＝比較（最短／最快／依偏好）、替代路線（Yen K 條，以時間為成本）、多目標 Pareto（時間×距離×風險）；大眾運輸＝最快抵達、少轉乘、少步行、Pareto 最優。
- **避開國道**：只有國道收費，勾選後汽車不走國道；路線會標示含國道的長度（**費率沒有資料，未計算費用**）。
- **營運規劃**（進階設定，公車業者／站點設計用，一般使用者不需要）：道路適宜性／YouBike／站牌的多目標候選與建議站點。
- **動態權重成本**：Cost(e) = α·T + β·D + γ·W + δ·R（時間／距離／候車／風險），可選預設偏好或自訂；A\* 的啟發值只用成本下界，不高估。
- **道路搜尋**：Dijkstra、A\*（含 ALT 地標）、雙向、多層級（近似）；Yen K 條不重複路線；Label Setting 多目標 Pareto。
- **公車＋捷運方案**：直達、換乘、不同路線組合；**多目標 A\***（總時間 × 步行距離 × 轉乘次數 × 候車時間）找 Pareto 最優方案。
- **捷運**：讀 `metro.json`，依站號推出站序，與 150 m 內公車站牌建立步行轉乘（班距與行駛時間為假設值，介面標示「系統推估」）。
- **TDX 即時整合**：ETA 優先，預定時刻其次；快取、重試、逾時、請求合併；錯誤分階段說明（token／資料／內容）；連線測試與 Proxy。
- **時刻表搜尋**：RAPTOR（轉乘次數 × 抵達時間 Pareto）與 CSA；另列較晚出發的選項。
- **地圖**：平移縮放、點擊選點／查詢道路、道路寬度圖層、YouBike／公車／捷運圖層、逐步導航。

## 快速開始

```bash
npm start            # 打包網頁並啟動伺服器 → 開 http://localhost:8080
```

伺服器（`server/`，零依賴）同時提供網頁、路網資料、API 與 TDX 代理；部署到正式主機見下方〈伺服器與部署〉。只想看網頁也可以 `npm run build` 後雙擊 `dist/index.html`。

> ES Modules 在多數瀏覽器**不能用 `file://` 直接開**，需要本機靜態伺服器；想雙擊就開，請用單檔版：`npm run build` → `dist/index.html`。

資料放在 `data/`（見 `data/README.md`），或在頁面左側選擇檔案載入。

## 車種通行規則（依需求；速限上限為假設值）

| 道路類別 | 公車（營運規劃） | 汽車 | 重型機車 | 一般機車 | 腳踏車 | 步行 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 一般道路／巷弄 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 國道（收費） | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| 快速道路 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 自行車專用道 | ✗ | ✗ | ✗ | ✗ | ✓（優先） | ✓ |
| 步行專用道 | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |

- 速限取自道路屬性表的 `速限`；缺資料時依道路類別**推估**並明確標示。
- 一般機車上限假設 50 km/h、腳踏車平均 18 km/h、步行固定 1.2 m/s（4.3 km/h）；**壅塞與收費路段沒有資料，未納入**。
- 國道／快速道路由「道路型態分類」或**路名**辨識（名稱清單屬啟發式，未必完整）。

## TDX 連線與 Proxy

瀏覽器直接呼叫 token 端點或 TDX，常因 **CORS** 被擋（「Failed to fetch」）。現在錯誤會指出是哪一步：

| 訊息 | 意義 |
|---|---|
| 連不到 token 端點 | 瀏覽器被擋（CORS／網址／離線） |
| token 端點回應 HTTP xxx | 端點有回應但失敗 |
| token 端點回傳的內容不像 token | 端點程式自己出錯（例如回傳 `req is not defined`），不是網路問題 |
| 連不到 TDX 資料網址 | token 正常，資料網址被擋 |

用伺服器部署時，把金鑰設在 `.env`（`TDX_TOKEN_URL`、`TDX_API_KEY`）即可，網頁會自動改用內建代理 `/tdx`。只想單獨跑代理時，可用 `proxy.mjs`（零依賴 Node），金鑰同樣留在伺服器：

```bash
TOKEN_URL=https://你的token端點 API_KEY=你的金鑰 node proxy.mjs     # 預設只聽 127.0.0.1:8787
```

頁面「Proxy 網址」填 `http://localhost:8787`，再按「TDX 連線測試」。**金鑰只存在目前分頁（sessionStorage），請勿寫進程式碼。**

## 目錄結構與分層

```
index.html   css/app.css   js/*.js   test/   build.mjs   proxy.mjs   data/
```

模組分成 27 層，**只允許「高層 import 低層」**（已用腳本驗證沒有循環）。低層需要呼叫高層函式時走 `Hooks.xxx` 登記表，由 `main.js` 啟動時填入；可變狀態集中在 `State`。

| 層 | 檔案 | 行數 | 職責 |
|---:|---|---:|---|
| 0 | `js/state.js` | 70 | 共用可變狀態 State、跨層呼叫登記表 Hooks |
| 1 | `js/constants.js` | 78 | 常數（走路速度、道路類別、捷運假設值、調色盤…） |
| 2 | `js/dom.js` | 17 | 頁面固定元素的參照 |
| 3 | `js/util.js` | 15 | 小工具（HTML 跳脫、距離與時間格式化） |
| 4 | `js/geo.js` | 48 | 座標：經緯度→TWD97、距離、單位判斷 |
| 5 | `js/heap.js` | 35 | 型別陣列二元堆（所有最短路搜尋共用） |
| 6 | `js/graph-core.js` | 114 | 座標型別偵測、空間索引、最近節點、點到線段投影 |
| 7 | `js/road-attrs.js` | 104 | 道路屬性：路寬／型態／速限、國道與快速道路辨識、適宜性分數 |
| 8 | `js/vehicle.js` | 76 | 車種通行規則、速限與時間、動態權重成本 α·T+β·D+δ·R |
| 9 | `js/ubike.js` | 61 | YouBike：載入、投影、空間查詢 |
| 10 | `js/bus-core.js` | 191 | 公車圖解析、站牌投影／吸附、偏差診斷、公車＋捷運合併 |
| 11 | `js/transit.js` | 74 | 公車與捷運載入、站序推導、捷運↔公車步行轉乘 |
| 12 | `js/analysis.js` | 230 | 路線指標與評分、站點建議、轉彎指令、覆蓋分析 |
| 13 | `js/router.js` | 233 | Dijkstra／A*／雙向／轉彎狀態搜尋、ALT 地標 |
| 14 | `js/router-multi.js` | 89 | Yen K 條、多層級 Dijkstra、Label Setting、solve |
| 15 | `js/planners.js` | 113 | 候選路線規劃（交通方式×目標：比較／K 條／Pareto／營運規劃）＋查詢快取 |
| 16 | `js/bus-plan.js` | 141 | 公車＋捷運多方案、多目標 A*（Pareto） |
| 17 | `js/tdx.js` | 226 | TDX：token、快取、重試、分階段錯誤說明、連線測試、時刻整合 |
| 18 | `js/timetable.js` | 128 | RAPTOR／CSA 時刻表搜尋 |
| 19 | `js/render-core.js` | 132 | 視圖轉換、重繪排程、網格、路名標註 |
| 20 | `js/render-layers.js` | 212 | 地圖圖層（周邊道路、寬度、YouBike、公車與捷運、站點、高亮…） |
| 21 | `js/render-route.js` | 127 | 路線繪製 |
| 22 | `js/ui-panels.js` | 229 | 左側面板與狀態列（路線清單、分析、公車方案、時刻整合…） |
| 23 | `js/ui-search.js` | 147 | 起終點搜尋與設定 |
| 24 | `js/loader.js` | 608 | 資料載入與建圖（buildGraph） |
| 25 | `js/ui-events.js` | 182 | 事件綁定：平移縮放、點擊、tooltip、按鈕、輸入 |
| 26 | `js/main.js` | 36 | 啟動 |

合計 JS 3706 行（另有 `index.html` 131 行、`css/app.css` 117 行）。

## 效能優化現況

| 項目 | 狀態 |
|---|---|
| 雙向搜尋 | ✓（已有） |
| 搜尋空間剪枝 | ✓ A\* 下界、Pareto 的 ε-支配與標籤上限、距離上界 |
| ALT 地標預處理 | ✓ 依「車種＋偏好」的成本建立並快取；合成測試：展開節點約少 10 倍、單次查詢約快 4 倍 |
| 空間索引 | ✓ 格網索引（未做 KD-tree／R-tree） |
| 快取 | ✓ 查詢結果 LRU 30 筆，鍵含資料版本（`graphVersion`），資料一變就失效 |
| Range RAPTOR | △ 以「較晚出發的選項」近似 |
| 增量更新、圖分區、Contraction Hierarchies、時間相依路由 | ✗ 未做 |

## 建置與測試

```bash
npm run build   # 產生 dist/index.html（單檔、可離線雙擊開啟）
npm test        # 8 組測試，只用 Node 內建功能與 DOM 替身
```

## 已知限制與假設

- 捷運只有站點資料：**站序由 StationID 推得**（用路徑總長驗證過合理）；班距 8 分鐘、速度與停站時間皆為假設；時刻表搜尋**不含捷運**。
- `js/loader.js` 超過 300 行：`buildGraph` 單一函式 463 行，沒有安全的機械式切法。
- 多層級 Dijkstra 在我的合成測試**沒有比 Dijkstra 快**，標示為實驗性。
- TDX 與真實資料沒有在真實環境測過（開發環境無法連線）；測試用的是照真實 JSON 結構做的模擬資料與本機 HTTP 伺服器。

---

## 手機網頁 PWA ＋ GPS 導航（階段 3–7）

**使用方式**：用 **HTTPS**（或 `localhost`）開啟 → 規劃一條道路路線 → 按「▶ 開始導航」（這個點擊同時啟用語音與定位權限）。起點也可按「📍 使用目前位置當起點」。大眾運輸不提供逐步 GPS 導航。

| 模組 | 內容 |
|---|---|
| `js/gps-filter.js` | 精度判斷（>50 m 標記訊號弱、>150 m 丟棄）、節流（<0.8 s）、跳點排除（連續 3 筆一致才視為真的移動）、卡爾曼平滑、行進方向估算 |
| `js/gps.js` | `watchPosition` 包裝；權限被拒／不支援／非 HTTPS／訊號中斷（10 s）狀態；只用裝置定位，不用 IP 定位 |
| `js/mapmatch.js` | `RouteTrack`：GPS 吸附到已規劃路線（視窗搜尋＋方向懲罰，單調進度）；`matchToRoad`：整張圖的邊匹配（距離＋方向＋連通性加成） |
| `js/navigation.js` | `NavigationEngine`：進度、下一步與距離、剩餘距離／時間／ETA、偏航（精確定位＋連續 3 筆＋6 秒＋移動 15 m＋15 秒冷卻）、抵達 |
| `js/voice.js` | `VoiceTemplates`、`ManeuverDetector`、`VoiceQueue`（優先序、去重、過期丟棄）、`VoiceEngine`（SpeechSynthesis、zh-TW、手勢內初始化、可被高優先級打斷）、`AnnouncementManager` |
| `js/nav-ui.js` | 導航介面、GPS 箭頭／精度圈／下一個導航點、偏航後重新規劃（`rerouteFromFix`）、語音設定、Wake Lock |
| `js/pwa.js`、`sw.js`、`manifest.webmanifest`、`icons/` | 加入主畫面、離線快取、離線提示、深色／淺色主題、手機抽屜版面 |
| `js/ui-touch.js` | 單指平移、雙指縮放 |

### 前景定位、PWA 背景、原生背景 —— 三件事不一樣
| | 狀況 |
|---|---|
| **前景網頁定位**（本專案做的） | 頁面開著、螢幕亮著時可用；導航中會要求螢幕常亮（Wake Lock，部分瀏覽器不支援） |
| **PWA 背景執行** | **不保證**。鎖定螢幕或切到別的 App 後，瀏覽器（尤其 iOS）可能暫停定位與語音；Service Worker 不能取得 GPS。本專案不宣稱 PWA 能持續背景導航 |
| **原生背景定位** | 需要 Capacitor 包成 Android／iOS App，使用背景定位外掛（前景服務＋「一律允許」定位權限）。限制：Android 需前景通知與電池最佳化白名單、iOS 需 Background Modes 與使用說明、上架審核；**持續 GPS 很耗電**。這一步尚未實作 |

### 已知限制（誠實清單）
- **高程／立體交叉**：資料沒有高程，Map Matching 無法排除高架與平面道路的錯誤連接。
- **單行道**：取決於圖的邊方向；沒有方向資料就無法判斷逆向。
- **即時交通／壅塞**：沒有資料來源，ETA 只依速限推估（畫面標示「系統推估」）。
- **語音**：不同裝置的中文語音不一定存在；沒有時介面會提示。iOS／Android 的實機行為必須手動驗證（見下）。
- **路線幾何簡化**：尚未實作（目前直接畫完整折線）。
- **網頁仍會下載完整路網**：路線在手機上計算（可離線）；伺服器 API 給其他程式或之後的輕量版前端使用。
- **離線**：頁面與已載入過的 `data/*.json` 會被快取（儲存空間不足時快取會失敗但不影響使用）；TDX 即時資料與重新規劃以外的功能不需網路。

### 測試
`npm test` 含 `test/gps.mjs`（過濾、服務）、`test/nav.mjs`（引擎、偏航、重新規劃、Map Matching）、`test/voice.mjs`（語音）。
`test/browser.cjs` 用 Playwright＋真實 Chromium 做端對端（需另外安裝 Playwright）：PWA／Service Worker 離線重開、手機與橫向版面、深淺色、模擬 GPS 全程導航與語音、偏航重新規劃、權限被拒。
**以下只能在實機手動驗證**：iOS Safari 語音（需第一次點擊後才能出聲、靜音開關）、Android Chrome 語音、鎖定螢幕／切換 App 後的行為、真實 GPS 的訊號弱與跳點、手機旋轉、不同螢幕尺寸。


---

## 伺服器與部署（階段 2）

`server/server.mjs` 一支程式提供四件事，部署後**打開網址就能用**：

| 路徑 | 內容 |
|---|---|
| `/` | 網頁（`dist/`，PWA、可加入主畫面） |
| `/data/...` | 路網與選用資料（gzip／br 壓縮、ETag；沒變就回 304） |
| `/api/v1/...` | 路線 API（下表） |
| `/tdx/api/...` | TDX 代理：金鑰只在伺服器，網頁自動使用 |

### 本機
```bash
cp .env.example .env     # 選用：填 TDX 金鑰等
npm start                # http://localhost:8080
```
資料放在 `data/`：`data/graph/{nodes,edges,roads}.json`（必要），`data/road-attrs.json`、`data/bus/graph.json`、`data/metro.json`、`data/ubike.json`（選用，存在就載入）。

### 部署到伺服器（建議：Docker＋Caddy 自動 HTTPS）
**手機 GPS 一定要 HTTPS**，所以要有一個網域指到伺服器（DNS A 記錄），並開放 80、443 埠。
```bash
git clone <你的 repo> taiwantong && cd taiwantong
cp .env.example .env && nano .env              # 填 TDX 金鑰、ADMIN_TOKEN
# 把路網放到 data/graph/
DOMAIN=maps.example.com docker compose -f deploy/docker-compose.yml up -d --build
```
Caddy 會自動申請憑證，完成後開 `https://maps.example.com`。

**不用 Docker**：裝 Node 18+ → 專案放 `/opt/taiwantong` → `deploy/taiwantong.service`（systemd，開機自動啟動、當掉自動重啟）→ 前面放 Caddy（`deploy/Caddyfile`，把 `app:8080` 改成 `127.0.0.1:8080`）或 Nginx（`deploy/nginx.conf`＋certbot）。放在反向代理後面時要設 `TRUST_PROXY=1`。

### API（回應格式一致）
成功：`{ "ok": true, "data": …, "meta": { "requestId", "ms", "cached", "graphVersion" } }`
失敗：`{ "ok": false, "error": { "code", "message", "details" }, "meta": { "requestId" } }`，HTTP 狀態碼對應錯誤類型。

| API | 說明 |
|---|---|
| `GET /api/v1/health` | 狀態、路網規模、已載入的資料、TDX 是否設定（不含金鑰）、快取統計 |
| `GET /api/v1/geocode?q=24.137,120.686` | 地理編碼：經緯度、投影座標、路名（子字串）。**地址／地標尚未支援** |
| `GET /api/v1/reverse?lat=&lon=` | 逆地理編碼：最近的道路、距離、吸附點 |
| `GET /api/v1/nearby-roads?lat=&lon=&radius=300` | 附近道路（依距離排序） |
| `GET\|POST /api/v1/route?from=緯,經&to=緯,經&mode=car` | 道路路線。`mode`：car／heavy／moto／bike／walk／transit；`goal`：compare／alt／pareto；`avoidToll=1`；`avoid=路名`；`k`；`algo`；`steps=0`；`simplify=公尺` |
| `GET\|POST /api/v1/transit?from=&to=&goal=fastest` | 公車＋捷運（`goal`：fastest／fewer／lesswalk／pareto），標示系統推估 |
| `GET\|POST /api/v1/multimodal?from=&to=&modes=car,bike,walk,transit` | 多運具比較：每種方式最快一條，依時間排序 |
| `GET /api/v1/traffic` | 回 `501 NO_DATA_SOURCE`：目前沒有即時交通資料來源（不提供假資料） |
| `POST /api/v1/admin/reload` | 重新載入資料（`Authorization: Bearer <ADMIN_TOKEN>`） |
| `GET /tdx/api/<TDX 路徑>` | TDX 代理（token 快取、401 自動換新、相同請求合併、15 秒快取） |

常見錯誤碼：`BAD_COORD`(400)、`BAD_MODE`(400)、`BAD_JSON`(400)、`BODY_TOO_LARGE`(413)、`OUT_OF_COVERAGE`(422)、`SAME_POINT`(422)、`NO_ROUTE`(404)、`NO_TRANSIT_DATA`(503)、`RATE_LIMITED`(429，附 `Retry-After`)、`TDX_NOT_CONFIGURED`(503)、`GRAPH_NOT_LOADED`(503)。

### 效能與快取
- **Graph Cache**：啟動時建圖一次，CSR 陣列常駐記憶體；資料檔更新可用 `admin/reload` 或 `WATCH_DATA=1` 熱重載。
- **A\* 地標（ALT）多組快取＋啟動預熱**：修正前「比較」模式每次查詢都會重建地標（單一快取被三種成本互相覆蓋），網頁版也受影響。
- **查詢快取＋請求去重**：相同參數、相同路網版本直接回快取；同時進來的相同請求共用一次計算／一次上游呼叫。
- **路線幾何簡化**：Douglas–Peucker（預設 2 m，`simplify=0` 關閉）。
- **實測**（合成格子路網 90,000 節點、358,800 邊，雲端容器，非正式主機）：建圖約 1.9 秒，預熱約 5 秒，記憶體約 460 MB；長途路線（約 60 km）A\* 約 50 ms、Dijkstra 約 120 ms，短途約 2 ms。**140 萬節點的真實台中路網沒有實測**：記憶體預估需要數 GB，請用 `NODE_OPTIONS=--max-old-space-size=…`，並在正式主機上量測。
- 路線搜尋是同步計算：同一時間只算一個請求（其他請求排隊）。流量大時可再加 worker threads 或多個實例。

### 安全
金鑰只在 `.env`（伺服器端）；靜態檔白名單（不會送出 `server/`、`.env`、`package.json`）；擋 `../` 路徑穿越；每 IP 限流；請求大小上限；安全標頭（nosniff、Permissions-Policy 只允許本站使用定位、HTTPS 時送 HSTS）；預設不開放跨網域（`CORS_ORIGINS` 才開）。

### 測試
`test/server.mjs`（`npm test` 內）：靜態檔壓縮／ETag／白名單、所有 API 與錯誤碼、限流、TDX 代理（假的上游：token 快取、請求合併、401 重試、金鑰不外流）、熱重載、公車＋捷運、多運具、地標快取。`test/browser.cjs` 也改成用真正的伺服器跑，並驗證網頁自動連線伺服器、TDX 改用內建代理、網頁內容沒有金鑰。**Docker 映像在這個環境沒有 Docker daemon，沒有實際建置過**；已用相同的檔案清單模擬映像內容啟動驗證。


---

## 掛進 server_2（rsmn574.com）

server_2 的程式**完全不動**，只在 `app.js` 加兩行，bus-planner 就會出現在 `https://你的網域/bus-planner/`：

```js
import { busPlanner } from './bus-planner/server/express-mount.mjs';   // 檔案開頭的 import 區
app.use('/bus-planner', busPlanner());                                 // 緊接在 app.set('trust proxy', 1) 後面
```

- 一定要放在 `cors`、`rateLimit`、`express.json()` **之前**：bus-planner 有自己的限流與錯誤處理，也要自己讀 POST 內容。這樣它的請求不會吃掉原本 100 次／15 分鐘的額度。
- **TDX**：直接讀 server_2 由 cron 更新的 `token.txt`（`TOKEN_FILE`），不另外取 token；網頁看不到 token。
- **路網**：放在 `bus-planner/data/graph/`。伺服器開始接受連線後才載入，不擋住原本 API 啟動（大路網載入那幾秒，其他請求會稍慢）。記憶體會加在同一個 Node 程序上，PM2 的記憶體上限要一起調。
- **dist**：server_2 的 `.gitignore` 有排除 `dist`，用 git 部署時 dist 不會跟著上去，這時會自動改用原始碼（ES Modules）提供網頁，一樣能用；想用打包版就在伺服器上跑 `node bus-planner/build.mjs`。
- **設定**（都加 `BUS_PLANNER_` 前綴，不會跟 server_2 的 `.env` 衝突，全部可省略）：`BUS_PLANNER_DATA_DIR`、`BUS_PLANNER_RATE_LIMIT_PER_MIN`（預設 120）、`BUS_PLANNER_ROUTER`（預設 astar）、`BUS_PLANNER_WARMUP`（預設 0）、`BUS_PLANNER_LOG`（預設 0）、`BUS_PLANNER_ADMIN_TOKEN`。
- **測試**：在 server_2 根目錄執行 `node bus-planner/test/server2-mount.mjs`。會檢查原本的路由、`/tokens`、錯誤處理與 CORS 照舊，`/bus-planner/` 底下的網頁、資料、API、TDX 代理都正常，而且兩邊互不干擾。

## 大眾運輸引擎重構（進行中）

目標：把公車搜尋從「靜態圖＋固定候車」改成依實際班次的多運具行程規劃（公車＋捷運，RAPTOR）。分階段進行，舊的搜尋在新引擎上線前完全不動。

### 階段 0＋1（已完成）：資料稽核、效能基準、資料層

新增檔案（沒有修改任何既有檔案，伺服器行為不變）：

| 檔案 | 用途 |
|---|---|
| `server/transit/time.mjs` | Asia/Taipei 時間、營運日（24:xx 班次）、星期幾遮罩 |
| `server/transit/bus-provider.mjs` | TDX 公車 → 站牌／路線型態（SubRouteUID＋Direction）／班次／班距／站間時間 |
| `server/transit/metro-provider.mjs` | TDX 捷運 → 車站／方向型態／班距／首末班車／站內轉乘／出入口 |
| `server/transit/timetable-store.mjs` | 統一資料庫：班次預排序、二分搜尋、資料版本 |
| `server/transit/eta-store.mjs` | 即時到站：與時刻表分開存放，含過期判定 |
| `server/transit/snapshot.mjs` | 向 TDX 同步、磁碟快取、只更新有變動的資料 |
| `tools/tdx-audit.mjs` | 稽核你的 TDX 帳號實際拿得到哪些端點與欄位 |
| `tools/transit-sync.mjs` | 把資料抓到 `.cache/transit/` 並印出品質報告 |
| `test/transit-data.mjs`、`test/transit-fixture.mjs` | 資料層測試 |
| `test/bench-transit.mjs`、`test/transit-city.mjs`、`test/bench-baseline.json` | 現有搜尋的效能基準（合成城市、固定種子） |

在伺服器上執行（在 `bus-planner/` 目錄；token 會自動讀上一層的 `token.txt`，也可用 `TOKEN_FILE` 指定）：

```bash
node tools/tdx-audit.mjs --out audit.json     # 哪些資料可用、缺哪些欄位
node tools/transit-sync.mjs                   # 抓資料並印出統計與警告
```

資料原則：路線型態一律用 UID＋方向當鍵；站序只看 StopSequence；班次只取資料裡有的時刻，缺的站只有在有站間行駛時間時才推算並標示為推估；沒有班次資料標示「資訊不足」而不是停駛；ETA 過期（預設 180 秒）就不當成即時資料。

## 導航與載入速度優化（v1.7.0）

### 載入速度
- **路網封包 `graph.bin`**：伺服器第一次從 `nodes/edges/roads.json` 建圖時，順便產生二進位封包，存在 `.cache/graph-*.bin`，並以 br／gzip 壓縮提供在 `data/graph/graph.bin`。網頁優先下載封包：不必解析 JSON、也不必在手機上建圖。封包內容與 JSON 建圖結果逐欄相同（`test/nav-perf.mjs` 驗證）。
- 伺服器重啟時直接讀封包；JSON 有任何變動（大小或修改時間）就自動重建，舊封包會被刪掉。
- 沒有封包時，三個 JSON 改成**同時下載**，載入畫面顯示已下載的大小。
- JSON 建圖本身也加快了：ID 查找走快速路徑、邊用預先配置的型別陣列，不再為每個 edgeId 建一個 Set。
- **一般靜態主機**（沒有跑伺服器）：執行 `node tools/pack-graph.mjs`（或 `npm run pack`），在 `data/graph/` 產生 `graph.bin`。**JSON 更新後要重跑**，否則網頁會載入舊封包。

### 導航
- **轉錯路口更快重新規劃**：行進方向與路線方向差超過 60°、時速超過約 11 km/h 時，門檻降到 20 m、2 筆定位且 2.5 秒就確認偏航。與路線平行的偏移（例如旁邊的平行道路）仍照原本規則，不會誤判。
- **修正 GPS 速度與方向**：手機不知道速度時會回報 `null`，而 `isFinite(null)` 是 true，以前因此把速度當成 null，方向判斷與卡爾曼濾波都沒有用到推算的速度。現在一律用 `Number.isFinite`。
- **ETA 依實際行駛速度修正**：取最近 3 分鐘、至少 60 秒且 200 m 的「實際耗時 ÷ 預估耗時」，平滑後乘到剩餘時間。權重隨走過的距離增加，最多 70%，係數限制在 0.5～2.5。狀態裡同時保留 `remainingPlanS`（原本的估計）與 `etaFactor`。
- **語音提示距離隨車速放大**：遠提示至少提前 30 秒和 12 秒，「現在轉彎」至少提前 5 秒。停車或低速時照原本距離。
- **重新規劃只算一條路線**：沿用出發時選的種類（最快／最短／依偏好），不重算整組候選。
- **地圖跟隨不再整張重畫**：只把已畫好的場景平移。路網多畫畫面外 40%，平移時邊緣不會露白；縮放改變、平移超過畫面 35%、路線或圖層有變動時才完整重畫。拖曳與雙指縮放也用同一個機制，手勢結束後完整重畫一次。
- **箭頭平滑移動**：箭頭在獨立的一層（`#navOverlay`）上以約 15 fps 在兩筆定位之間補間移動；地圖仍是每筆定位平移一次。停著不動、或一次跳超過 150 m 時不跑動畫。語音設定裡可以關掉「箭頭平滑移動」來省電。

### 量測（`test/bench-browser.cjs`，結果存在 `test/bench-nav-load.json`）
合成路網 90,000 節點、358,800 邊；Chromium、手機視窗。「CPU×4」是把 CPU 模擬成慢 4 倍，近似手機。

| 項目 | 優化前 | 優化後 |
|---|---|---|
| 首次載入（桌機） | 3.3 秒 | 0.5 秒 |
| 首次載入（CPU×4） | 11.0 秒 | 1.7 秒 |
| 再次開啟（CPU×4） | 8.9 秒 | 1.7 秒 |
| 路網下載量 | 22 MB | 0.77 MB（br） |
| 轉錯路口到重新規劃 | 135 m（9 筆定位） | 75 m（5 筆定位） |
| 導航中最長一幀（桌機） | 66.7 ms | 16.8 ms |
| 導航中每秒主執行緒耗時（CPU×4） | 82 ms | 127 ms（箭頭動畫；關掉動畫約 72 ms） |

執行方式：`NODE_PATH=$(npm root -g) node test/bench-browser.cjs <路網資料夾>`。加 `CPU=4` 模擬手機，加 `DIST=<資料夾>` 量測其他版本的網頁。
