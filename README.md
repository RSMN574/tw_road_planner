# 智慧公車路線規劃系統（bus-planner）

以**道路圖論**為基礎（v1.11.0：全台 OSM 路網＋台鐵／高鐵／捷運／輕軌／公車多運具規劃＋z21 2D／3D 地圖；v1.13.0：店家地點搜尋；v1.14.0：途經點、一鍵安裝，見文末），結合**車種規則與速限、道路寬度／型態、YouBike、台中公車與捷運、TDX 即時資料**，在瀏覽器裡完成路線搜尋、公車路線建議與地圖分析。**零依賴、純前端**，沒有後端也沒有 npm 套件。

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

**一鍵安裝**（v1.14）：Windows 雙擊 `install.cmd`；macOS／Linux 執行 `sh install.sh`；已經有 Node.js 也可以 `npm run setup`。
會依序：檢查 Node.js（沒有時 Windows 詢問後用 winget 安裝 LTS、macOS 有 Homebrew 時詢問後安裝；Linux 列出安裝方式）→ `npm install` → 沒有 `.env` 就從 `.env.example` 建立（已有的不覆蓋）→ 打包網頁 →（詢問）下載台灣 OSM 並建道路圖、地標表、建築、店家地點 →（有 TDX 金鑰時詢問）同步大眾運輸與道路事件 →（詢問）跑測試。

| 選項 | 作用 |
|---|---|
| `--yes` | 全部用預設答案（含下載與建立地圖資料；TDX 同步與測試預設不做） |
| `--no-data` ／ `--data` | 不要／要 下載並建立地圖資料 |
| `--transit` | 同步 TDX 大眾運輸與道路事件（需要 .env 的金鑰） |
| `--test` ／ `--start` | 裝好後跑 `npm test` ／ 啟動伺服器 |
| `--force` | 已有的地圖資料也重新下載、重建 |

已完成的步驟（例如已有道路圖）會略過；任何一步失敗都會停下並印出可以單獨重跑的指令。不是互動式終端機（例如排程）又沒指定選項時，選用步驟一律略過。

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
npm test        # 20 組測試，只用 Node 內建功能與 DOM 替身（瀏覽器測試見下方各節：test/browser*.cjs）
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

## 修復：大眾運輸結果沒有捷運（v1.7.1）

### 原因（都已修正）
1. **時刻表搜尋（RAPTOR／CSA）完全排除捷運**（`js/timetable.js` 原本寫明「捷運沒有時刻資料，不納入」）：只要用時刻表搜尋，就不可能出現捷運。→ 捷運改以班距加入：RAPTOR 在上車站以「平均候車＝班距的一半」上車；CSA 在搜尋時段內以班距產生等間隔的推估班次。metro.json 有 TDX `Frequency`、`FirstLastTimetable` 時，依時段取班距、收班後不能搭、首班前會等首班。沒有這些資料時標示「班距推估」與「營運時間未知」。
2. **公車資料的座標修正被套到捷運站**（`js/bus-core.js`）：公車檔需要「經緯度對調」或「TWD67 偏移」時，系統自動採用的修正連捷運站也一起套用，捷運站被搬走（對調時偏了 8,500 公里），之後所有方案都沒有捷運，也沒有任何錯誤訊息。→ 修正只套用在公車站。
3. **捷運站常被「最近 6 站」排除**：公車站很密時，起終點附近的候選全是公車站。測試城市裡，離捷運站 200～480 m 的起點有 93% 選不到捷運站，捷運只能透過「先搭公車再轉」才用得到。→ 範圍內最近的 2 個捷運站一定保留為候選。
4. **捷運跨線沒有轉乘**：以前只連「捷運 ↔ 公車」，跨線只能經由公車。→ 不同路線、相距 300 m 內的車站建立轉乘連結；有 TDX `LineTransfer` 就用它的轉乘時間。不依站名判斷。
5. **轉乘時間是固定的 90 秒**（把捷運站併進公車站群），而且只併進一個站群。→ 改為逐一連結。每條連結的距離取道路圖上的步行距離，時間＝步行距離 ÷ 步速＋進出站 90 秒（跨線為換月台 120 秒），兩者都是推估值。起點走進捷運站、在捷運站下車走到終點，也都加上進出站時間。
6. **捷運檔載入失敗被吞掉**：伺服器上 `loadMetro` 失敗時沒有往外丟錯誤，健康檢查仍顯示「捷運已載入」。→ 現在會丟出錯誤，`data.metro` 顯示 false，`warnings` 列出原因。網頁上也會顯示原因。
7. **狀態列停在「載入道路圖後生效」**：道路圖比捷運資料晚載入時，捷運狀態不會更新。→ 道路圖載入後重新整理狀態。

### API 新增（原有欄位不變）
`/api/v1/transit` 的每個方案多了 `legs`，依序是 `WALK`、`BUS_RIDE`、`METRO_RIDE`、`TRANSFER`。乘車段有 `route`、`lineId`、上下車站、站數、`rideS`、`waitS` 和資料來源；轉乘與步行段有步行距離、時間和來源。`rides[]` 的捷運段多了 `lineId`，站點多了 `line`。
`/api/v1/health` 的 `data.transit` 列出捷運站數、捷運邊數、捷運↔公車轉乘數、跨線轉乘數、孤立捷運站、沒有轉乘的捷運站，以及捷運資料來源。

### metro.json 可以是 TDX 原始物件
`{ "Stations": [...], "StationOfLine": [...], "S2STravelTime": [...], "LineTransfer": [...], "Frequency": [...], "FirstLastTimetable": [...] }`
只有 `Stations` 是必要的。有 `StationOfLine` 用真正的站序，有 `S2STravelTime` 用真正的站間時間，其餘欄位見上文；缺少的部分一律標示為推估。

測試：`test/metro-transit.mjs`（含六種情境），瀏覽器測試 `NODE_PATH=$(npm root -g) node test/browser-metro.cjs`。

## v1.8.0：導航 ETA／剩餘距離／自動鏡頭、背景執行緒、捷運真實資料、YouBike 接駁

### 導航：剩餘距離與 ETA
**以前的算法（問題所在）**
- ETA＝路線每段長度 ÷ 速限，全程自由車流；沒有轉彎、號誌、路口等待 → 系統性**估得太早**（模擬中平均偏早 2.5 分鐘）。
- 出發 60 秒／200 m 後才乘上「實際÷預估」係數，而且沒有平滑 → 一筆定位就能讓 ETA 跳 3～7 分鐘。
- 進度只要投影到路線前方就接受：GPS 往前跳一次，剩餘距離就永久少掉那一段；精度很差的定位也能推進度。
- 定位中斷時沒有任何標示；ETA 時刻以最後一筆定位時間為準。

**現在的算法**
- 剩餘距離：GPS 投影到路線 Polyline（mapmatch.js 的視窗投影、累積距離），**沿路線**算到終點；不使用直線距離。
  進度防護：大幅前進要連續 2 筆一致才接受、倒退超過 max(25 m, 精度) 要連續 3 筆、精度不足或離路線太遠的定位不推進度；重新規劃後進度歸零重算。
- ETA（`js/eta-engine.js`）：`剩餘時間 = Σ(路段長度 ÷ 路段預估速度) + 轉向延遲 + 路口等待 + 交通延遲`
  - 路段預估速度＝min(速限, 車種上限) × 道路類別的車流係數（依車種），有本機歷史紀錄時與歷史速度加權（`js/trip-log.js`，尖峰／離峰分開，只存在這支手機）。
  - 轉向延遲（左／右／迴轉，依車種）、路口等待（依路口岔數），機車左轉兩段式較久、步行不加轉向延遲。
  - **交通延遲＝0**：目前沒有即時路況來源，不捏造；畫面註明「未含即時路況」。
  - 近程修正：用平滑後的實際速度修正前方 1 km（±50%，有上下限）；本趟修正：走過 500 m 以上後，以「實際耗時÷模型耗時」加權（權重 ≤ 0.5）。**不會**只用 GPS 速度除剩餘距離。
  - 停等中：已經等過的時間先抵掉模型裡的路口等待，不會停多久 ETA 就延後多久。
  - 不確定範圍（約 80%）與可信度（高／中／低，依速限資料覆蓋率、歷史資料、距離）。
- 穩定性：平滑器（小變動死區、持續同方向的大變動快速跟上）、異常定位不更新、定位失效時保留最後估算並顯示「⚠ 定位異常」、顯示最後更新時間。

**模擬量測**（`node test/nav-eta.mjs`；地面真值含號誌、轉彎延遲、壅塞，GPS 雜訊 σ=4 m，固定種子可重現；數字只代表這套模擬）

| 情境 | 舊 MAE／MAPE | 新 MAE／MAPE | 剩餘距離平均誤差 舊→新 | 每筆 ETA 跳動最大 舊→新 |
|---|---|---|---|---|
| 一般市區（5.75 km） | 153 秒／22.3% | 67 秒／11.6% | 5.6 → 4.1 m | 212 → 25 秒 |
| GPS 跳點（未過濾） | 129 秒／19.4% | 35 秒／7.6% | 46.0 → 4.8 m（最大 445 → 19 m） | 214 → 8 秒 |
| 連續 12 個轉彎 | 144 秒／18.5% | 43 秒／9.5% | 5.7 → 4.0 m | 222 → 26 秒 |
| 長距離 14 km | 261 秒／18.2% | 114 秒／8.5% | 10.6 → 4.4 m | 442 → 28 秒 |
| 中段壅塞（模型不知道） | 217 秒／24.0% | 134 秒／19.7% | 6.6 → 4.5 m | 212 → 25 秒 |
| 機車／腳踏車／步行 MAPE | 24.1%／16.2%／4.3% | 17.1%／11.4%／2.9% | — | — |

真實道路上的誤差請用實際紀錄量：導航畫面「⬇ 下載行程紀錄」→ `node tools/eta-eval.mjs 紀錄.json`（以實際抵達時間為真值，算 MAE／MAPE、各可信度的誤差）。

### 導航：自動鏡頭（`js/camera.js`）
- 方向：北朝上／車頭朝上（導航畫面 🧭 切換）；GPS 行進方向為主，低速時鎖定、停止時用手機指南針（`js/compass.js`，iOS 需在點「開始導航」時授權），精度 > 30 m 暫停更新；方向低通平滑，旋轉每秒最多 60°。
- 縮放：依車速決定前方要看多遠；接近轉彎時放大到路口（複雜路口再放大一點），通過 2.5 秒後恢復；目標縮放有 15% 遲滯、2 秒冷卻，同一個路口只放大一次。
- 傾斜：車頭朝上、跟隨中、時速 ≥ 4 m/s 時 25° 透視（CSS 3D，自動放大到蓋滿畫面）；低於 1.5 m/s 持續 3 秒才放平。設定裡可關閉。
- 手動拖曳或縮放：立即放平、停止跟隨，按「◎ 回到定位」恢復。
- 效能：旋轉 ≥ 2°、縮放 ≥ 1.5% 才更新地圖（小變化 0.6 秒後一次補上）；縮放累積超過 35% 才完整重畫；ETA 文字每秒更新但不重畫地圖。

**地圖效能**（`test/bench-browser.cjs`，90,000 節點路網、Chromium 手機視窗、CPU×4 模擬手機、導航 40 筆定位；前後各量 2 次取平均）

| 項目 | v1.7.1 | v1.8.0（車頭朝上＋傾斜，預設） | v1.8.0（北朝上、不傾斜） |
|---|---|---|---|
| 畫面更新率 | 60 fps | 60 fps | 60 fps |
| 第 99 百分位每幀時間 | 16.8 ms | 16.8 ms | 16.8 ms |
| 超過 50 ms 的幀（40 秒內） | 1 | 1 | 1 |
| 每筆定位主執行緒耗時 | 119 ms | 123 ms | 110 ms |
| 　其中排版＋樣式 | 14 ms | 23 ms | 16 ms |
| JS heap（導航中，GC 後） | 26.2 MB | 25.7 MB | 25.7 MB |
| 偏航到重新規劃完成的主執行緒耗時 | 908 ms | 1,209 ms | 829 ms |

車頭朝上時，轉彎要逐幀旋轉地圖，排版成本較高；直線行駛時的方向小抖動不會觸發更新。

### 伺服器：路線計算改在背景執行緒
- `WORKERS`（獨立伺服器）／`BUS_PLANNER_WORKERS`（掛在 server_2）：預設 1 個 worker_threads 執行緒，路網只載入在背景執行緒，主執行緒只處理網頁、TDX 代理、快取與排隊 → 一次很久的搜尋不會卡住同一個 Node 程序裡的其他請求（server_2 的其他 API）。
- 設 N 個執行緒時依忙碌程度分配，每個執行緒各有一份路網（記憶體約 N 倍）。`WORKERS=0` 回到主執行緒同步計算。
- 單次計算超過 `WORKER_TIMEOUT_MS`（預設 60 秒）回 504 並重開該執行緒；執行緒當掉會自動重開並重新載入路網。錯誤碼（400／404／422…）跨執行緒照舊。
- `/api/v1/health` 多了 `compute`（模式、執行緒數、忙碌數、工作數、重開次數、平均耗時）。
- 測試（`test/server-workers.mjs`，19,600 節點）：6 個同時的長路線，主執行緒最長卡住 177～244 ms（同步）→ 7～12 ms（背景執行緒）；計算中 health 1 ms 回應；結果與同步計算逐字相同。

### 捷運真實資料（TDX）
- `transit-sync` 遇到 **HTTP 429（API rate limit exceeded）** 會依 `Retry-After`（沒有就 2、4、8、16 秒）重試最多 4 次，請求之間至少間隔 1.2 秒。
- 台中捷運不再請求 `LineTransfer`（TDX 回 400：只接受 TRTC、KRTC、TYMC、NTMC），也不再列為「缺少」。
- 新增同步 `ODFare`（票價，每週）。
- **產生 data/metro.json**：`node tools/transit-sync.mjs --metro-json`，或 `node tools/metro-json.mjs`（`--check` 只檢查；`--s2s 檔案.json` 等可改用手動下載的 TDX JSON）。內容是 TDX 原始欄位（Stations、StationOfLine、S2STravelTime、Frequency、FirstLastTimetable、StationExit、ODFare），舊檔備份成 `.bak`。
- 站間時間＝`RunTime＋StopTime`；全部站間都有 TDX 資料時，畫面與 API 的來源改為「TDX S2STravelTime」。
- 票價：只取 TDX 的成人票（`TicketType` 1＝單程票、3＝電子票證；`FareClass` 1＝成人），捷運段顯示票價；API 的 `METRO_RIDE` 多 `fare: { adultSingle, adultCard, currency, source }`。公車沒有票價資料，不顯示。

### 大眾運輸：YouBike 接駁
- 有 YouBike 站點資料（`data/ubike.json`）時，大眾運輸方案會考慮：起點走到借車站 → 騎 → 還車站 → 上車站；下車站 → 借車 → 騎 → 還車站 → 終點；或兩頭都騎。
- 騎乘時間在道路網上計算（腳踏車禁行路段除外），與導航的腳踏車模型相同；借、還車各加 60 秒。都是推估，**沒有即時可借車輛／空位**資料。
- 起點或終點走路 500 m 內沒有任何站時，騎車是唯一的方案來源；其他情況只在騎車方案沒有被其他方案全面勝過（Pareto）時列出。
- 畫面：方案列表顯示「🚲 YouBike 距離（借車站 → 還車站，約 N 分）」，地圖以橘色畫出騎乘路線；方案區有「🚲 YouBike 接駁」開關。
- API：`/api/v1/transit` 預設考慮（`ubike=0` 關閉）；方案多 `access`／`egress`（`walk` 或 `ubike`），分段多 `BIKE`（借還車站、距離、時間、路線幾何）。
- 目前只做第一／最後一哩；行程中間「下公車改騎 YouBike 再轉捷運」尚未加入。

### 新增與修改的檔案
- 新增：`js/eta-engine.js`、`js/trip-log.js`、`js/camera.js`、`js/compass.js`、`server/backend.mjs`、`server/route-worker.mjs`、`server/transit/metro-json.mjs`、`tools/metro-json.mjs`、`tools/eta-eval.mjs`
- 測試：`test/nav-eta.mjs`、`test/eta-sim.mjs`、`test/fixtures/legacy-navigation.mjs`、`test/server-workers.mjs`、`test/metro-json.mjs`、`test/ubike-transit.mjs`、`test/browser-ubike.cjs`
- 修改：`js/navigation.js`、`js/nav-ui.js`、`js/render-core.js`、`js/render-layers.js`、`js/ui-touch.js`、`js/ui-events.js`、`js/ui-panels.js`、`js/bus-plan.js`、`js/transit.js`、`js/tdx.js`、`js/constants.js`、`js/vehicle.js`、`server/server.mjs`、`server/config.mjs`、`server/engine.mjs`、`server/express-mount.mjs`、`server/transit/snapshot.mjs`、`server/transit/metro-provider.mjs`、`tools/transit-sync.mjs`、`index.html`、`css/app.css`、`.env.example`、`package.json`

## v1.9.0：用 OpenStreetMap 建立全台灣道路圖（第一階段：資料、拓樸、通行規則、轉向限制）

這一階段建立「可以做路徑搜尋的 OSM 道路圖」與驗證工具；網頁、API、地圖與 GPS 導航在 v1.10.0 接上（見下一節）。

### 步驟（在伺服器上執行）
```bash
sudo apt install osmium-tool          # 建議：先篩選道路，建圖快很多（沒有也可以，結果相同）
npm run osm:download                  # 下載 Geofabrik taiwan-latest.osm.pbf，驗證 MD5，存成 data/osm/raw/taiwan-YYYYMMDD.osm.pbf
npm run osm:build                     # 建圖 → data/osm/graph/YYYYMMDD/（osm-graph.twosm、manifest.json、report.json、report.md）
npm run osm:route -- --from 24.1477,120.6736 --to 24.1631,120.6476 --profile car,moto,bike,foot
OSM_REAL_PBF=data/osm/raw/taiwan-YYYYMMDD.osm.pbf npm run test:osm-real   # 讀取器與 libosmium 逐筆比對（需 pip install osmium）
```
- 用瀏覽器手動下載的 `taiwan-*.osm.pbf`：放進 `data/osm/raw/` 直接執行 `npm run osm:build`（會自動找到最新的檔並補記錄），或 `npm run osm:build -- --pbf "檔案路徑"`；加 `--md5 <Geofabrik 網頁上的值>`（或把 `.md5` 檔放在旁邊）會先驗證完整性；已經登記過的檔案之後再加 `--md5` 也可以，驗證結果會記進下載紀錄（`md5Verified`）。
- Windows PowerShell：`npm run osm:route -- --from 25.0478,121.5170 …` 這種寫法也可以用（PowerShell 會吃掉 `--`、把逗號拆開，工具會依內容認回座標、運具、`.pbf` 路徑、MD5）。想避開這個問題可以直接用 node，值加引號：`node tools/osm/osm-route.mjs --from "25.0478,121.5170" --to "25.0340,121.5645" --profile "car,moto,foot"`。座標寫成「經度,緯度」會自動對調並提醒。
- 原始 PBF 一律保留（檔名用 PBF 表頭的資料時間，不覆蓋舊檔）；`data/osm/raw/manifest.json` 記錄來源網址、下載時間、Last-Modified、ETag、大小、MD5（Geofabrik 提供的與實際計算的）、PBF 資料時間與序號。MD5 不符會刪掉下載的檔案。
- 建圖前會再驗證一次原始檔 MD5；每次建置放在自己的日期資料夾，最後才更新 `data/osm/graph/current.json`。
- 不會把 PBF 轉成大型 GeoJSON；整條流程都是串流讀檔＋型別陣列。

### 道路拓樸（`server/osm/topology.mjs`）
- 頂點只來自 OSM node id（不用座標四捨五入合併）：道路端點、兩條以上道路共用的 node、障礙物、缺資料處、封閉道路的中點。
- way 在頂點切成邊；每條邊保留原始 way id、沿線每個 node id、座標與累積距離（大圓距離）。
- 只有共用 node 才是路口：高架橋跨過平面道路（幾何交叉、沒共用 node）不相連。不同高度層（layer／橋／隧道）在兩條路的中間點共用 node 視為資料錯誤，拆成不同頂點、不相連，報告列出；道路端點接到別的高度層（橋的引道）是正常相接。
- 不進路網：施工中、計畫中、廢棄、月台、area=yes 的廣場等（報告列出數量）。

### 五種運具的通行規則（`server/osm/access.mjs`）
- 標籤優先順序：汽車 motorcar > motor_vehicle > vehicle > access；機車／大型重機 motorcycle > …；自行車 bicycle > vehicle > access；步行 foot > access；同一個鍵先看 `:forward`／`:backward`。
- 每條邊、每種運具、每個方向一個狀態：**允許（標籤）／推定允許（未標註，依道路類別）／未知（未標註、無可靠預設）／有條件（destination、private…）／禁止（標籤）／推定禁止（依法規或道路類別）／單行反向**，另有「依時段」旗標（`:conditional`）。未標註的不會直接當成允許或禁止：推定的與標籤的分開記錄，未知的交給路徑規劃政策（預設可走但成本 ×3 並警告；可改成禁止）。
- 台灣規則（推定）：國道禁止機車（含大型重機）、自行車、行人；快速公路、市區快速道路（motorroad=yes、台61～88、名稱含「快速公路／快速道路／高架道路」）禁止普通機車、自行車、行人；人行道、步道禁止汽機車；自行車走人行道為「未知」；產業道路（track）汽機車為「未知」；名稱含「匝道」但沒標註的連絡道，機車、自行車、行人為「未知」（可能是快速道路出入口）。
- 通用標籤（`access`、`vehicle`）不能放寬依法規或道路型態不能走的路：`highway=steps`＋`access=yes` 不代表汽車能開，國道標 `access=yes` 也不代表行人能走；只有該運具自己的標籤（`motorcar`、`motorcycle`、`motor_vehicle`、`bicycle`、`foot`）能放寬。通用標籤仍然可以更嚴格（`access=no`、`private`）。階梯汽機車一律不能走，`bicycle=yes` 只算「有條件」（牽車）。
- 排氣量條件直接套用（不是時段，不標「依時段」）：`motorcycle:conditional=yes @ (displacement >= 250 cc)`（快速公路開放大型重機，全台約 570 條）、`no @ <=250 cc`（市民大道高架等禁行普通機車）。機車以 125 cc、大型重機以 550 cc 判斷。
- 單行：oneway、圓環與國道隱含單行、`oneway:bicycle=no`、cycleway=opposite*；行人只受 `oneway:foot`（或步道本身的單向）。
- 障礙物（barrier）：車阻擋汽車、重機，機車未知，自行車、行人可過；閘門汽機車未知；node 上的 access 標籤優先。
- 號誌、停車再開、平交道、收費站記在頂點旗標（ETA 用）。

### 轉向限制（`server/osm/restrictions.mjs`）
- 解析 relation `type=restriction`：no_／only_ 的左轉、右轉、直行、迴轉、no_entry、no_exit；via 是 node 或 way（中央分隔島迴轉道）。
- `type=restriction:<運具>`、`restriction:<運具>=…`、`except=bicycle;psv…`：只套用到對應運具；行人不受轉向限制。
- `restriction:conditional`、`day_on/hour_on`：記錄為「依時段」，預設不套用，路線結果回報有幾條沒套用。
- from／to 道路沒有在 via 點斷開（不合 OSM 規範但常見）：用轉彎角度判斷方向。對不上的（道路不在範圍內、via 不相接…）不套用，報告列出原因與 relation id。
- 路徑搜尋（`server/osm/router.mjs`）以「有向邊」為狀態做 A*，才能正確處理轉向限制；迴轉只在死路允許。

### 起終點吸附（v1.9.2）
- 吸附到最近的**路段**（點到線段的投影），不是最近的路口；第一段、最後一段只算實際走到的部分（距離、時間、座標都從投影點開始、到投影點結束）。同一條邊上的起訖點會判斷方向（單行道往回走要繞一圈）。
- 避開走不出去／走不進來的小區塊：最近的路段若和另一端不互通（地下停車場出口、只出不進的車道、沒接上路網的室內步道、車阻後面的巷子），改用附近（最近距離＋500 m 內）能互通的路段，結果的 `snap.fromNearestM`／`toNearestM` 註明原本最近的距離。互通的判斷：各運具的強連通分量、每個島嶼最大的分量當主幹（起點開得到主幹、主幹開得到終點），小區塊內實際找一次。
- 不同島嶼（澎湖、金門…）沒有渡輪連接：回傳 `NO_ROUTE`；10 km 內沒有可用道路：`NO_NEARBY_ROAD`。

### 量測（本機，Node 22，2 核心）
- 讀取器與 libosmium 逐筆比對（Helsinki 真實資料：24,260 node、5,130 way、620 relation）：座標、標籤、node 序列、relation 成員完全相同。
- 有無 osmium tags-filter 預先篩選，建出的圖逐欄相同。
- 合成大路網（169 萬頂點、338 萬邊、675 萬幾何點、3,000 條轉向限制）：建圖 17.6 秒、記憶體峰值約 1.0～1.2 GB、圖檔 258 MB；載入 0.2 秒；汽車 5 km 路線 4 ms、20 km 約 90 ms、100 km 中位數 0.4 秒（最慢 2.1 秒）。
- **真實台灣（Geofabrik taiwan-20261117.osm.pbf，313 MB，資料時間 2026-11-17 21:24 UTC）**：道路 way 823,658 條、道路 node 623 萬 → 1,407,311 頂點、1,824,955 邊、847 萬幾何點、道路 190,082 km；轉向限制 3,170 筆，套用 2,885 筆（via way 430；依時段 353 筆預設不套用）。建圖：沒有 osmium 44 秒、有 osmium 26 秒，記憶體峰值約 0.95 GB，圖檔 285 MB，兩種方式建出的圖逐欄相同。汽車最大連通區占 97.7%（其餘主要是澎湖、金門、馬祖、離島與停車場等小區塊）；有標速限的道路只占 5.7%（其餘依道路類別推估，結果中標示）。
- 真實路線抽查（第一次查詢另需約 1～2 秒建索引）：台北車站→台北 101 汽車 7.0 km／15 分（走市民大道高架），機車 6.1 km／25 分（不上高架），大型重機與汽車同路；台中車站→高鐵台中站 8.8 km；花蓮→台東 171 km／3.5 小時；市區路線 10～100 ms；台北→高雄汽車 352 km／3 小時 34 分（國道），但要 2～3 秒（A* 幾乎搜遍全台，下一階段用 CH 加速）；馬公→台中、金城→台北：不同島嶼，`NO_ROUTE`。

## v1.10.0：網頁、API、地圖與 GPS 導航改用全台 OSM 道路圖

伺服器有 OSM 道路圖（`data/osm/graph/current.json`）時網頁自動改用它；本機的台中路網（`data/graph`）變成選用（台中公車營運規劃、站點建議、道路寬度圖層仍需要它）。介面上的「🗺 使用全台 OSM 道路圖」可以關掉改回本機路網（會記住）。大眾運輸（公車＋捷運）照舊。

### 第一次使用（Windows PowerShell 一樣）
```bash
npm run osm:build        # 建圖＋地標表：約 1～2 分鐘，記憶體峰值約 1.1 GB；輸出 data/osm/graph/YYYYMMDD/
npm start                # 或 npm run server：啟動時在背景載入 OSM 圖（約 3～5 秒），網頁會自動等它
```
- 機器較慢或記憶體較小：分兩步 `npm run osm:build -- --no-alt`，再 `npm run osm:alt`（只建地標表；時間模型參數改了也用它重建）。
- 重建圖之後伺服器自動換新（監看 `data/`），或 `POST /api/v1/admin/reload`。
- 修正：v1.9.2 的 `js/eta-engine.js` 用了 `export … from`，單檔打包（`node build.mjs`，`npm start` 會先執行）會失敗；已改掉，`npm test` 第一步改成打包檢查。

### 網頁
- **地圖**：伺服器依畫面範圍送圖磚（XYZ 編號，當 512 像素用），只放這個縮放看得到的道路等級；同一條 way 的相鄰邊、低縮放時同類道路首尾相接的都合併成一條線（全台畫面一張圖磚約 6～16 KB br）。z15 以上顯示路名（雙向分隔的同名道路只標一次）。圖磚網址帶圖檔版本：瀏覽器與 Service Worker 可以長期快取，離線時看過的地圖仍可顯示（最多 3,000 張）；其他 API 不再經過 Service Worker 快取。右下角有 OSM 版權標示。
- **選點**：點地圖（點哪裡就用哪裡，規劃時伺服器吸附到最近的可用路段，並顯示最近道路與距離）、搜尋路名（全台；同名道路依離地圖中心的距離排序）、輸入「緯度,經度」（含澎湖、金門、馬祖、蘭嶼）、使用目前位置。
- **規劃**：最快；直線距離 60 km 內另附「最短距離」（長距離的最短路線多半繞山路、小路，時間多很多，也要多算 1 秒以上）。避開國道、避開指定道路、K 條替代、Pareto、營運規劃目前只在本機路網提供（OSM 模式下隱藏）。
- **結果標示**：速限來源（OSM 有標／只有區域代碼如 `TW:urban`／依道路類別推估）與覆蓋比例、OSM 未標註的通行權（依道路類別推定）、有限制（限住戶等）、時段／條件限制（未判斷時段）、渡輪（不含候船；OSM duration 或平均航速推估）、推估的碼頭連接、起終點離道路多遠；時間分成「行駛」與「路口與轉彎」。
- **道路資訊**（點擊模式選「查看道路資訊」）：路名、編號、OSM 類別、速限與來源、五種運具的通行狀態。

### GPS 導航
- 導航步驟、每段行駛時間（`timing.segS`）、路口與轉彎延遲（`timing.delays`）由伺服器用同一套參數（`js/eta-params.js`）算好；網頁的 ETA 模型只補上真實長度（大圓距離）、不確定範圍（依道路類別的變異）、本機歷史速度（以 OSM way id 為鍵）、近程與本趟修正、停等扣除——和本機路網的 ETA 規則相同。**沒有用 GPS 速度直接除剩餘距離**；剩餘距離是沿路線的距離，不是直線。
- 偏航確認（與原本相同的防抖：連續多筆精確定位、持續時間、有移動、冷卻）後，從目前定位＋行進方向向伺服器重新規劃（車頭反向要先迴轉的時間會算進去），只問一次；失敗時回到偏航狀態、冷卻後再試，網路斷線會明確提示。
- 渡輪段：步驟顯示「⛴ 搭乘渡輪」，語音「搭乘渡輪」。

### API（新增；原有 API 不變）
| 方法 | 路徑 | 說明 |
|---|---|---|
| GET／POST | `/api/v1/osm/route` | `from`、`to`（「緯度,經度」或 `{lat,lon}`）、`mode`（car／heavy／moto／bike／walk）、`alternatives`（預設 1：最快＋60 km 內的最短；0：只要最快；all：一定附最短）、`heading`（偏航重新規劃用，度）、`steps`（0＝不回逐步）。回傳 `routes[]`：`distanceM`、`durationS`（＝`driveS`＋`delayS`）、`geometry`（[經度, 緯度]）、`roads`、`ways`（每條 way 的長度、速限與來源）、`steps`（type：start／straight／slight／turn／sharp／uturn／ferry／arrive；`index` 指向 geometry）、`timing`（`segS`、`segCls`、`segKnown`、`segWay`、`delays`）、`ferries`、`warnings`、`snap`；`notes` |
| GET | `/api/v1/osm/nearest` | `lat`、`lon`、`mode`、`radius`：最近道路的路名、類別、速限與來源、各運具通行狀態 |
| GET | `/api/v1/osm/search` | `q`、`near`（緯度,經度）、`limit`：全台路名搜尋 |
| GET | `/api/v1/osm/tiles/{z}/{x}/{y}.json` | 地圖圖磚：`v:2`、`bbox`、`extent`（4096）、`hw`、`names`、`roads`（[類別序號, 路名序號, 單行, 差值座標]）；Cache-Control 1 天、ETag、br／gzip；限流是一般 API 的 20 倍 |
| GET | `/api/v1/osm/info` | 頂點、邊、資料時間、版本、地標表 |
- 沒有 OSM 圖或 `OSM=0` 時這些 API 回 503 `OSM_NOT_LOADED`（其他功能照常）；`/api/v1/health` 多一個 `osm` 欄位（載入中為 `loading: true`）。錯誤碼：`BAD_COORD`、`BAD_MODE`、`BAD_PARAM`、`NO_NEARBY_ROAD`（422）、`NO_ROUTE`（404）、`NO_ROAD_NEARBY`（404）。回應的 `meta.osmVersion` 是圖檔版本；路線快取的鍵包含它，重建圖後不會拿到舊結果。
- 環境變數：`OSM`（預設 1）、`OSM_GRAPH_DIR`（預設 `data/osm/graph`）、`OSM_WARM`（預設 car：啟動時先建好汽車的索引與地標）。掛進 server_2 用 `BUS_PLANNER_OSM`、`BUS_PLANNER_OSM_GRAPH_DIR`、`BUS_PLANNER_OSM_WARM`；台中路網載入後在背景載入 OSM 圖。
- 記憶體：每個背景計算執行緒各載入一份（全台圖約 300 MB＋用到的運具的地標表各約 34 MB）。`WORKERS=1` 時長距離路線（1～3 秒）計算期間，其他 OSM 請求（包括還沒快取的圖磚）會排隊；記憶體夠的話可以設 `WORKERS=2`。

### 上一階段「尚未完成」的四項（本版一併完成）
- **長距離加速（ALT 地標）**：每種運具 6 個地標（台灣外圍 16 個方向最外側、彼此 ≥10 km），下界＝時間×（只影響選路的係數）＋號誌等待＋上船成本，保證不高估——路線與不用地標時完全相同，只是快很多。全台：建表約 20 秒、`osm-alt.bin` 約 160 MB；台北→高雄汽車 0.13 秒（原本 2～3 秒）、機車 0.9 秒、新竹→台東約 2 秒、台中→馬公（含渡輪）約 2.5 秒。時間模型參數改了（`MODEL_KEY` 不同）或查詢政策比預設寬鬆時自動不用地標表。
- **渡輪**：`route=ferry` 納入路網（時間用 OSM `duration`，沒有就以平均航速推估並標示；換算的航速不合理時視為標錯）；碼頭端點沒接上道路的補一段推估的「碼頭連接」（≤300 m）；起終點不會吸附到航線；上船有 30 分鐘的選路成本（不算進時間），有陸路時優先走陸路；只載人的航線汽車不能搭。
- **轉彎與道路等級成本**：轉向延遲（左轉、右轉、微轉、急轉、迴轉；機車兩段式左轉）、號誌與路口等待（小路接大路、轉彎才算）與導航 ETA 用同一套參數；選路時巷弄、服務道路、產業道路等加權（只影響選哪條，不影響顯示的時間），不再為了少幾個號誌鑽小巷。
- **區域速限代碼**：`TW:urban`、`TW:rural` 等以法定 50 km/h 與道路類別預設取較小值，結果標示「只有區域代碼」（例如台北車站→台北 101 的最快路線約 15% 的長度是這種）。

### 測試
- `node test/server-osm.mjs`（已加入 `npm test`）：OSM API（主執行緒與背景執行緒）、503、快取與版本、重建後自動換新、圖磚格式與合併、`osm:alt`。
- `NODE_PATH=$(npm root -g) node test/browser-osm.cjs`（需要 Playwright）：沒有本機路網時自動使用 OSM、底圖、規劃、步驟與分析、路名搜尋、道路資訊、渡輪、GPS 導航與偏航重新規劃、關閉 OSM。
- 用真實全台圖截圖：`OSM_GRAPH_DIR=data/osm/graph SHOT_DIR=. node test/browser-osm.cjs real`。

### 仍未完成
- OSM 模式還不能避開國道／指定道路，也沒有 K 條替代路線、Pareto。
- 沒有即時路況（不假造）；收費、紅綠燈時相都沒有資料。
- 渡輪沒有班表：時間只含航行，不含候船。
- 高架與平面道路只靠 OSM 的連接關係區分；GPS 在高架下方時，偏航判斷仍可能誤判（與本機路網相同）。

## v1.11.0：OSM 路網稽核、全台多運具大眾運輸（台鐵／高鐵／捷運／輕軌／公車）、可放大到 z21 的 2D／3D 地圖、HMM 導航、道路事件

完整稽核與測試結果見 [`docs/reports/TAIWAN_MAP_NAVIGATION_V2_AUDIT.md`](docs/reports/TAIWAN_MAP_NAVIGATION_V2_AUDIT.md)；全台 OSM 稽核數字見 `docs/reports/osm-audit-20261117.md`。使用者提供的 OAS 文件放在 `docs/oas/`（軌道 v2、GIS 圖資 v3、道路事件 v1、公車、路況、自行車）。

### 新的指令
```bash
npm run osm:audit        # RoadGraphValidator：拓樸、幾何、立體交叉 vs 疑似漏接路口、各運具有向／無向連通、跨縣市實際路由（全台約 1 分鐘）
npm run osm:buildings    # 從 OSM PBF 擷取建築外框與高度 → data/osm/graph/<日期>/osm-buildings.twbld（約 40 秒）
node tools/transit-sync.mjs --city Taipei --operators TRTC,NTMC,TYMC,KRTC,TMRT,KLRT,NTDLRT,NTALRT --rail TRA,THSR --extras   # 需要 TDX 金鑰
npm run traffic:sync     # TDX 道路事件 → .cache/traffic/events.json（需要 TDX 金鑰；建議排程每 1～5 分鐘）
npm run test:v111        # 這一版新增的測試（也已加入 npm test）
```

### 地圖（網頁）
- **縮放上限的真正原因**：舊版的上限寫死成「相對起始畫面的倍率」（滾輪 ×20、雙指 ×60），起始畫面是全台灣時只到約 z12（約 25 m／像素），看不到街道；底圖圖磚也只抓到 z16。
- 現在以「每像素公尺數」換算成一般網頁地圖的縮放層級：**z5～z21**（z19 約 0.27 m／像素、z21 約 0.07 m／像素）。伺服器圖磚最高抓 z18（512 像素，＝z19），再放大是向量 overzoom（圖磚座標量化約 3.4 cm），不會模糊；畫面會提示已超過原生層級。
- 滾輪平滑縮放（以游標為中心）、雙擊放大（Shift＋雙擊縮小）、拖曳放開有慣性、雙指縮放＋旋轉（超過 8° 才轉）、右鍵（或 Ctrl）拖曳＝旋轉／俯仰、＋／－ 鍵；右上角控制列：縮放、目前層級、指北針（回北朝上）、左右旋轉、2D／3D、顯示全圖；左下比例尺。
- z17 以上道路依實際寬度畫（OSM `width`／`lanes`，沒有就依類別典型寬度）、z17.5 以上畫單行道箭頭、z18 以上路名較大較密。
- **3D**：地圖平面用 CSS 透視傾斜（GPU 合成），滑鼠／手指座標經反投影換回地面座標，傾斜時點選、拖曳、縮放都正確（瀏覽器實測誤差 0.0008 m，不反投影時 234 m）。
- **建築**：z16 以上畫建築外框，3D 時畫 2.5D 立體，z18 以上標名稱。台灣 OSM 60.4 萬棟中，只有 1.8% 有 `height`、11.1% 有 `building:levels`，**其餘 87.1% 的高度是推估**，畫成半透明虛線，不當真實資料。

### 路網
- 時段條件的轉向限制（`restriction:conditional`、`day_on/hour_on`）依出發時間判斷：全台 352 筆中 344 筆可判斷；無法判斷的（只在國定假日、依重量）不套用並在結果中回報。API：`/api/v1/osm/route?depart=…`（沒給＝現在；`conditional=0` 回到舊行為）。
- 通行權對外四態：`allowed／restricted／prohibited／unknown`＋來源（`tag`、`default` 依道路類別與法規推定、`oneway`）；`/api/v1/osm/nearest` 的 `accessProfile` 兩個方向分開。未標註且沒有可靠預設的是 `unknown`，不當成可通行。
- 高度層加上 `location=underground／overground`；`covered` 不改變高度。
- 道路事件（TDX 道路事件 v1）：完全阻斷的路段封閉、部分阻斷／施工／壅塞加權；只阻斷單向時依方向；沒有座標的事件只列出、不猜位置。路線結果有 `traffic`（使用的事件與原因）與每條路線經過的事件；`GET /api/v1/traffic/events` 列出事件與對應結果；`events=0` 關閉。

### 大眾運輸（全台 OSM 模式）
- 交通方式選「大眾運輸」時改用伺服器的 `GET /api/v1/transit/plan`（`from`、`to`、`depart`、`modes=bus,metro,lrt,tra,thsr`、`maxWalk`、`maxTransfers`）：RAPTOR，有時刻表的依班次（時間相依），捷運／輕軌有站別時刻表用實際發車時刻、只有班距的用班距推估並標示；起終點與轉乘的步行在 OSM 步行路網上實際走（不是直線）；TDX 的站內轉乘時間與共站優先；**不依站名合併車站**。
- 輸出最快、最少轉乘、最少步行、最便宜（每段都有票價時）、建議；每段有運具、上下車站、方向、車次、發車／抵達、等候、轉乘、步行距離、票價（台鐵票種依原始資料，不猜哪一種是全票）、軌道線型（GIS 圖資 v3 的 WKT）。台鐵即時誤點（LiveTrainDelay）會計入。
- 網頁：方案清單、每段明細、地圖依運具上色（步行虛線）。
- **真實資料驗證（2026-11-24）**：台鐵 245 站 1,859 班、高鐵 369 班、8 個捷運輕軌系統、台北公車 28,823 站牌；台中車站→淡水（自強 110 次轉淡水信義線，NT$550）、台北→左營（高鐵 0117 次）等實際規劃 15～150 ms。實際回應與 OAS 不一致的地方（道路事件的陣列鍵、MULTIPOLYGON、台鐵票種）已修正，見報告第 12 節。
- 金鑰：`.env` 設 `TDX_TOKEN_URL`＋`TDX_API_KEY`（＋`TDX_TS`），或 `TDX_CLIENT_ID`＋`TDX_CLIENT_SECRET`（直接向 TDX 官方取 token）；`--operators TRA,THSR` 這種逗號清單在 PowerShell 不用加引號。
- 伺服器啟動時預先建立轉乘（全台約 16 秒、記憶體含 OSM 圖約 1.6 GB）；`.env` 的 `TRANSIT_CITY`、`TRANSIT_METRO`、`TRANSIT_RAIL` 要和同步時的參數一致。

### 導航
- 路線上的位置改用 HMM（`js/hmm-match.js`）：路線靠近自己（分隔道路去回、繞圈）時，低速沒有 GPS 方向的情況下，舊方法有 8～9% 的定位對到另一側，HMM 是 0%；導航引擎中低速情境的進度最大誤差 45 → 22 m（模擬資料，`test/nav-hmm.mjs`）。HMM 找不到候選時退回舊方法，偏航判斷不變。

### 新增與修改的檔案
- 新增：`server/osm/audit.mjs`、`server/osm/conditional.mjs`、`server/osm/buildings.mjs`、`server/traffic/events.mjs`、`server/transit/rail-provider.mjs`、`server/transit/transfer-engine.mjs`、`server/transit/raptor.mjs`、`server/transit-engine.mjs`、`js/map-view.js`、`js/osm-buildings.js`、`js/transit-plan.js`、`js/hmm-match.js`、`tools/osm/osm-audit.mjs`、`tools/osm/osm-buildings.mjs`、`tools/traffic-sync.mjs`、`docs/oas/*`、`docs/reports/*`
- 測試：`test/osm-v111.mjs`、`test/transit-rail.mjs`、`test/nav-hmm.mjs`、`test/map-view.mjs`、`test/fixtures/rail-fixture.mjs`、`test/make-transit-cache.mjs`
- 修改：`server/osm/router.mjs`（依時間的轉向限制、道路事件 overlay、步行可達範圍）、`server/osm/restrictions.mjs`、`server/osm/access.mjs`、`server/osm/tags.mjs`、`server/osm-engine.mjs`、`server/server.mjs`、`server/backend.mjs`、`server/route-worker.mjs`、`server/config.mjs`、`server/transit/snapshot.mjs`、`server/transit/timetable-store.mjs`、`tools/osm/osm-build.mjs`、`tools/transit-sync.mjs`、`js/osm.js`、`js/ui-events.js`、`js/ui-touch.js`、`js/nav-ui.js`、`js/navigation.js`、`js/render-core.js`、`js/main.js`、`index.html`、`css/app.css`、`package.json`、`.env.example`

## v1.12.0：UI v2（地圖為背景的導航介面、深色模式、手機／平板／桌機／車機）

設計規格與驗收清單：[`docs/design/UI_V2_DESIGN.md`](docs/design/UI_V2_DESIGN.md)。規劃、導航、大眾運輸的邏輯沒有改；既有元素（同一個 id、同一組事件）由 `js/ui-shell.js` 搬到新的外殼裡。

- **主介面**：全螢幕地圖；頂部搜尋列（目的地，含語音輸入，瀏覽器支援時才顯示）；右上浮動按鈕（圖層、道路事件、2D／3D、指北）、右下（定位、縮放）；底部可拖拽面板（收合／半展開／全展開三段，手機），平板與桌機是左側浮動卡片；常用地址（家、公司、最近，存在這支手機）。
- **路線規劃**：起訖點都有時自動規劃；路線方案卡片（推薦／備選、時間、距離、到達時刻、紅綠燈數、行經國道公里數、經過的道路事件），選中高亮；主按鈕「開始導航」。**沒有即時壅塞資料**，路況條顯示「無即時路況資料」，不畫假的紅黃綠。
- **導航中**：主色轉向卡（自繪轉向圖示、距離、路名、接著）；接近轉彎（汽車 200 m、機車 150、自行車 80、步行 50）時放大；剩餘時間／距離／到達時刻；「結束」獨立，暫停、重複、語音收進「更多」。
- **深色模式**：選單可選自動（跟隨系統；導航中依日出日落）、淺色、深色；地圖、建築、卡片都有各自的深色配色（不再反相）。
- **車機模式**：橫向大螢幕觸控自動放大字與觸控區（56 px），也可在選單手動開啟。
- **效能與無障礙**：毛玻璃只用在搜尋列、浮動按鈕、導航卡；「省電樣式」、`prefers-reduced-transparency`、不支援時改不透明；`prefers-reduced-motion` 關閉動畫；按鈕都有 `aria-label`，觸控區 ≥ 44 px。
- **道路事件圖層**：TDX 道路事件（施工、事故、管制）畫在地圖上，點選看詳情；`/api/v1/traffic/events?bbox=西,南,東,北`。
- **路線 API** 新增 `signals`（經過的號誌路口數；分隔道路兩個方向的號誌點 40 m 內只算一次）。
- **版權**：圖示全部自繪（`js/ui-icons.js`）、系統字體、OSM 與 TDX 署名；沒有使用任何第三方導航 App 的商標、圖標或素材。
- 新增：`js/ui-shell.js`、`js/ui-icons.js`、`docs/design/UI_V2_DESIGN.md`；修改：`css/app.css`、`index.html`、`js/pwa.js`、`js/osm.js`、`js/osm-buildings.js`、`js/nav-ui.js`、`js/render-core.js`、`js/main.js`、`server/osm/router.mjs`、`server/osm-engine.mjs`。

## v1.13.0：店家地點搜尋（OpenStreetMap POI）

規劃與實作差異：[`docs/design/POI_SEARCH_PLAN.md`](docs/design/POI_SEARCH_PLAN.md)。這一版是第一階段；**途經點**（第二階段）還沒做。

- **資料**：從同一份台灣 OSM PBF 擷取店家與地點（`npm run osm:poi`，約 30～60 秒）→ 圖資料夾裡的 `osm-poi.json.gz`。2026-11-17 的台灣檔：200,168 個地點（點 138,875、面 61,293，其中 21,129 個沒有名稱但保留，例如加油站、廁所、ATM），約 5.4 MB。停車格、長椅、垃圾桶、飲水機、置物櫃等不收。
- **沒有的東西（不假裝有）**：OSM 沒有評分與評論，介面不顯示；營業時間只有約 14% 的地點有，沒有的寫「營業時間未提供」，國定假日等無法判斷的規則顯示原文；新開或已關的店要重新下載 PBF 並重跑 `osm:poi` 才會更新。
- **搜尋**：名稱、品牌、英文名、別名都能搜；「臺／台」、全形半形、大小寫視為相同；同義詞（小七／7-11／統一超商、全家／FamilyMart、麥當勞／McDonald's、星巴克／Starbucks、中油、全聯、好市多…）；類別詞（加油站、便利商店、咖啡、藥局、ATM、停車場、廁所…）直接找附近這一類；「店名 地標」（例如「麥當勞 台北車站」）以地標為中心找 5 km 內；同名連鎖店只列最相關的 3 家，並註明「附近還有 N 家」（5 km 內）。排序＝文字相符程度＋類別加權－距離（對數）。
- **API**（快取、限流、錯誤格式與其他 OSM API 相同）：
  - `GET /api/v1/poi/search?q=&near=緯度,經度&category=&openNow=1&limit=&bbox=西,南,東,北`
  - `GET /api/v1/poi/nearby?lat=&lon=&radius=公尺（≤5000）&category=&openNow=1`
  - `GET /api/v1/poi/detail?id=n123`（電話、網站、營業時間原文與判斷、樓層、OSM 連結）
  - `GET /api/v1/poi/categories`（類別、圖示名稱、全台數量）
  - 沒有門牌的地點補「附近道路」（最近的有名稱道路，標示是推得的）；`/api/v1/osm/info` 的 `poi` 標示資料是否可用；沒有資料檔時回 404 `NO_POI`。
- **介面**（接在 UI v2 上，`js/poi.js`）：頂部搜尋下拉分「地點」與「道路」兩區；搜尋列下方的類別快捷鈕（加油站、便利商店、餐廳、咖啡、停車場、ATM、醫院、診所、藥局、廁所、充電站、住宿）；按 Enter 或「查看全部」打開結果清單（底部面板／左側卡片），可篩選「營業中」；地圖上編號標記，縮小時重疊的合併成數字圈；點清單或標記開啟詳細卡（營業狀態、時段、地址、電話可直接撥打、網站、OSM 連結與署名），「設為目的地」「設為起點」後照原本流程自動規劃路線。
- **實測**（本機、全台資料）：載入＋建索引約 2.2 秒、堆積增加約 114 MB（每個背景執行緒一份）；15 種常見查詢各跑 3 次，單次查詢中位數 2.3 ms、最慢 27 ms；伺服器回應（含補附近道路）約 11 ms。
- **測試**：`npm run test:poi`（已加入 `npm test`）：正規化、類別對照、營業時間（跨午夜、即將打烊、看不懂的寫法）、用測試內產生的小型 PBF 跑擷取→檔案→載入→搜尋（同義詞、英文前綴、類別詞、店名＋地標、連鎖店合併、營業中篩選、地圖範圍、附近、詳細資料、面狀地點中心點），以及伺服器 API（主執行緒與背景執行緒、資料檔出現後自動重新載入、錯誤碼、快取）。
- 修正：地圖 SVG 裡的標記收不到點擊（舊規則讓 `#routeSvg` 的 path／circle 不接收滑鼠）——店家標記與 v1.12 的道路事件標記都受影響，已一併修正。
- 新增：`server/osm/poi.mjs`、`server/osm/poi-categories.mjs`、`tools/osm/osm-poi.mjs`、`js/poi.js`、`test/poi.mjs`、`docs/design/POI_SEARCH_PLAN.md`；修改：`server/osm-engine.mjs`、`server/backend.mjs`、`server/route-worker.mjs`、`server/server.mjs`、`js/ui-search.js`、`js/ui-shell.js`（搜尋框提示文字）、`js/ui-icons.js`（類別圖示，自繪）、`js/main.js`、`css/app.css`、`package.json`。

## v1.14.0：途經點、一鍵安裝

- **途經點**（`docs/design/POI_SEARCH_PLAN.md` 第二階段）：起點與終點之間最多 5 個。
  - 新增：規劃區的「＋新增途經點」後搜尋（店家或路名）或點地圖；店家詳細卡有「加入途經點」。可以上下移動、刪除，改了就自動重新規劃；地圖上以紫色編號標記。
  - 伺服器：`GET /api/v1/osm/route?…&via=緯度,經度;緯度,經度`（POST 也可以用陣列）。分段規劃 A→V1→…→B 再接成一條：座標、逐步指示（中間的「抵達」改成「途經點」步驟）、分段時間、道路、渡輪、道路事件依序接起來；每段的出發時間依前面各段累計（時段轉向限制、道路事件照那個時間判斷）。回應多了 `legs`（每段距離、時間、終點位置）與 `via`。最快／最短各自分段規劃。超過 5 個回 400 `TOO_MANY_VIA`；某一段找不到路時，錯誤訊息會指出是第幾段。
  - 導航：接近途經點時語音「即將抵達途經點，○○」，通過時「已抵達途經點，繼續前往下一站」，轉向卡顯示途經點名稱；通過途經點不算抵達。偏航重新規劃只帶**還沒經過**的途經點，編號與名稱接續原本的。
  - 沒有做的：不含在途經點停留的時間；不會自動調整途經點順序（不做最佳化排序）；**大眾運輸模式不支援途經點**（介面會註明，規劃時直接從起點到終點）。
- **一鍵安裝**：`install.cmd`／`install.ps1`（Windows）、`install.sh`（macOS／Linux）、`tools/setup.mjs`（`npm run setup`），用法見〈快速開始〉。`.gitattributes` 讓 `install.sh` 在 Windows 取出時也保持 LF。
- **測試**：`npm run test:via`（已加入 `npm test`）：分段合併（座標接點、分段時間、步驟編號、延遲位移、加總）、路線 API 的 via（測試路網：分段、位置、POST 陣列、錯誤碼、指出哪一段失敗）、網頁的規劃與導航（途經點步驟與名稱、依序通過、只抵達一次、偏航重新規劃只帶剩下的、全部經過後不帶）、語音與文字。
- 新增：`js/via.js`、`tools/setup.mjs`、`install.cmd`、`install.ps1`、`install.sh`、`.gitattributes`、`test/via.mjs`；修改：`server/osm-engine.mjs`、`js/osm.js`、`js/ui-search.js`、`js/poi.js`、導航呈現（`js/nav-ui.js`、`js/voice.js`、`js/camera.js`、`js/eta-engine.js`、`js/render-layers.js`、`js/ui-panels.js`）、`js/ui-icons.js`、`js/state.js`、`js/main.js`、`css/app.css`、`package.json`。
