# 台灣通（bus-planner）——全台地圖、路線、大眾運輸與導航

以**全台 OpenStreetMap 道路圖**與**交通部 TDX 資料**為基礎的地圖系統：汽機車／腳踏車／步行路線、全台多運具大眾運輸、即時路況、店家與停車／充電地點、手機 GPS 導航。伺服器零依賴（只需要 Node.js），網頁由伺服器提供。

> **v1.18.0 起只剩全台 OSM 道路圖**：舊的台中本機路網（瀏覽器載入 `data/graph/*.json`、前端路線演算法、本機公車／捷運／YouBike 檔、營運規劃、前端 TDX 設定）已全部移除，詳見文末〈v1.18.0〉。文件中 v1.17 以前的章節是當時的開發紀錄，提到的本機路網功能已不存在。

## 能做什麼

- **道路路線**（伺服器計算）：汽車、重型機車（不走國道）、一般機車（不走國道、快速道路）、腳踏車（優先自行車道）、步行。最快／最短兩條、途經點、轉向限制（含時段條件）、通行權四態（有標／依類別推定／未標註／禁止）、渡輪。
- **時間模型**：速限（缺資料依道路類別推估並標示）× 車流係數＋號誌與轉彎延遲；**TDX 即時路況**（每 5 分鐘更新）的壅塞路段依即時速度修正，封閉路段大幅加權；**TDX 道路事件**（施工、事故、管制）避開或加權。
- **大眾運輸**：台鐵、高鐵、捷運、輕軌、**全台 22 縣市公車、公路客運、台灣好行**（RAPTOR，TDX 時刻表與票價；當日班表、停駛、誤點），含步行轉乘。
- **地點搜尋**：OSM 店家（類別、營業時間、附近）、**TDX 停車場**（剩餘車位）與**充電站**（空槍），即時資料在查看時才向 TDX 取得。
- **地圖**：可放大到 z21 的 2D／3D 向量地圖（伺服器圖磚）、建築、即時路況圖層（紅黃綠）、深色模式、手機／平板／桌機／車機版面。
- **GPS 導航**：路線吸附（HMM）、偏航防抖後由伺服器重新規劃、分段 ETA（與伺服器同一套參數）、語音、自動鏡頭；PWA 可加入主畫面。

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

**網頁一定要由伺服器提供**（路線、大眾運輸、地點搜尋都在伺服器計算）；直接雙擊 `dist/index.html` 只會看到「需要由台灣通伺服器提供」的說明。全台 OSM 道路圖由 `npm run osm:download`、`npm run osm:build` 產生在 `data/osm/graph/`（見 `data/README.md`）。

## 資料來源與授權

- 道路、建築、店家：© OpenStreetMap contributors，ODbL 授權（地圖上有標示）。
- 大眾運輸、即時路況、道路事件、停車、充電樁：交通部 TDX 運輸資料流通服務，依 TDX 的使用條款使用；**金鑰只放在伺服器的 `.env`**（`TDX_TOKEN_URL`、`TDX_API_KEY`），網頁拿不到。
- 圖示全部自繪，沒有使用其他地圖服務的商標或素材。
- 路況、時間與剩餘車位都是推估或第三方資料，介面會標示；請以現場標誌與實際狀況為準。

## 目錄結構

```
index.html   css/app.css   js/*.js（網頁，ES Modules；build.mjs 打包成 dist/index.html 單檔）
server/      server.mjs（HTTP）、backend.mjs＋route-worker.mjs（背景執行緒）、osm-engine.mjs（路線、圖磚、搜尋、地點、路況）
             osm/（PBF 讀取、拓樸、通行規則、轉向限制、路線搜尋、ALT、建築、POI）、transit/（TDX 大眾運輸、RAPTOR）
             traffic/（道路事件、即時路況）、places/（停車場、充電站）、static.mjs、tdx-proxy.mjs、express-mount.mjs
tools/       setup、osm/（下載、建圖、地標、建築、POI、稽核）、transit-sync、traffic-sync、traffic-flow-sync、places-sync、tdx-audit
test/        Node 內建功能＋DOM 替身的測試（npm test）；browser-osm.cjs 需要 Playwright
data/        osm/（原始 PBF 與建好的道路圖）；TDX 快取在 CACHE_DIR（預設 .cache/）
```

網頁模組只允許「高層 import 低層」；低層需要呼叫高層時走 `Hooks.xxx` 登記表（`main.js` 啟動時填入），可變狀態集中在 `State`。v1.18 後網頁 JS 共 40 個模組、約 3,500 行。

## 建置與測試

```bash
npm run build   # 產生 dist/index.html（單檔）
npm test        # 打包後跑 18 組測試（只用 Node 內建功能與 DOM 替身；不需要 TDX 金鑰）
```

---

## 手機網頁 PWA ＋ GPS 導航

**使用方式**：用 **HTTPS**（或 `localhost`）開啟 → 規劃一條道路路線 → 按「開始導航」（這個點擊同時啟用語音與定位權限）。起點也可按「使用目前位置」。大眾運輸不提供逐步 GPS 導航。

| 模組 | 內容 |
|---|---|
| `js/gps-filter.js` | 精度判斷（>50 m 標記訊號弱、>150 m 丟棄）、節流（<0.8 s）、跳點排除（連續 3 筆一致才視為真的移動）、卡爾曼平滑、行進方向估算 |
| `js/gps.js` | `watchPosition` 包裝；權限被拒／不支援／非 HTTPS／訊號中斷（10 s）狀態；只用裝置定位，不用 IP 定位 |
| `js/mapmatch.js`、`js/hmm-match.js` | `RouteTrack`：GPS 吸附到已規劃路線（視窗搜尋＋方向懲罰，單調進度）；HMM 路線匹配 |
| `js/navigation.js` | `NavigationEngine`：進度、下一步與距離、剩餘距離／時間／ETA、偏航（精確定位＋連續 3 筆＋6 秒＋移動 15 m＋15 秒冷卻）、抵達 |
| `js/eta-engine.js`、`js/eta-params.js` | 分段 ETA 模型（伺服器算好的每段時間與路口延遲＋本機歷史速度＋本趟修正）、平滑器；參數表與伺服器共用 |
| `js/voice.js` | `VoiceTemplates`、`ManeuverDetector`、`VoiceQueue`（優先序、去重、過期丟棄）、`VoiceEngine`（SpeechSynthesis、zh-TW）、`AnnouncementManager` |
| `js/nav-ui.js` | 導航介面、GPS 箭頭／精度圈／下一個導航點、偏航後向伺服器重新規劃（`osmReroute`，只帶還沒經過的途經點）、語音設定、Wake Lock |
| `js/pwa.js`、`sw.js`、`manifest.webmanifest`、`icons/` | 加入主畫面、離線快取（頁面與看過的地圖圖磚）、離線提示、深色／淺色主題 |
| `js/ui-touch.js` | 單指平移、雙指縮放與旋轉 |

### 前景定位、PWA 背景、原生背景 —— 三件事不一樣
| | 狀況 |
|---|---|
| **前景網頁定位**（本專案做的） | 頁面開著、螢幕亮著時可用；導航中會要求螢幕常亮（Wake Lock，部分瀏覽器不支援） |
| **PWA 背景執行** | **不保證**。鎖定螢幕或切到別的 App 後，瀏覽器（尤其 iOS）可能暫停定位與語音；Service Worker 不能取得 GPS。本專案不宣稱 PWA 能持續背景導航 |
| **原生背景定位** | 需要 Capacitor 包成 Android／iOS App，使用背景定位外掛。這一步尚未實作 |

### 已知限制
- **需要網路**：路線與重新規劃都在伺服器計算；離線時只能看已快取的頁面與看過的圖磚（v1.18 移除本機路網後，不再有離線規劃）。
- **語音**：不同裝置的中文語音不一定存在；沒有時介面會提示。iOS／Android 的實機行為必須手動驗證。
- **即時路況**：只涵蓋 TDX 有發布的路段（主要是國道、省道與部分縣市道路）；其他路段時間依速限推估並標示。

### 測試
`npm test` 含 `test/gps.mjs`（過濾、服務）、`test/nav.mjs`（引擎、偏航、換路線）、`test/nav-eta.mjs`、`test/nav-perf.mjs`（ETA 模擬、轉錯路口、語音距離）、`test/nav-hmm.mjs`、`test/voice.mjs`、`test/via.mjs`（真的伺服器＋測試路網：途經點、偏航重新規劃）。導航測試用 `test/osm-route-fixture.mjs` 產生與伺服器相同格式的合成路線（數字只代表模擬）。
`test/browser-osm.cjs` 用 Playwright＋真實 Chromium 做端對端（需另外安裝 Playwright，不在 `npm test` 內）。
**以下只能在實機手動驗證**：iOS Safari 語音、Android Chrome 語音、鎖定螢幕／切換 App 後的行為、真實 GPS 的訊號弱與跳點、手機旋轉、不同螢幕尺寸。

---

## 伺服器與部署

`server/server.mjs` 一支程式提供：

| 路徑 | 內容 |
|---|---|
| `/` | 網頁（`dist/`，PWA、可加入主畫面） |
| `/api/v1/...` | API（下表） |
| `/tdx/api/...` | TDX 代理（金鑰只在伺服器） |

`data/` **不會**被當成靜態檔提供（v1.18 起）。

### 本機
```bash
cp .env.example .env     # 填 TDX 金鑰等（可省略：沒有金鑰時大眾運輸、路況、即時車位不可用，道路路線照常）
npm start                # http://localhost:8080
```

### 部署到伺服器（建議：Docker＋Caddy 自動 HTTPS）
**手機 GPS 一定要 HTTPS**，所以要有一個網域指到伺服器（DNS A 記錄），並開放 80、443 埠。
```bash
git clone <你的 repo> taiwantong && cd taiwantong
cp .env.example .env && nano .env              # 填 TDX 金鑰、ADMIN_TOKEN
# 全台 OSM 道路圖放到 data/osm/graph/（npm run osm:download && npm run osm:build）
DOMAIN=maps.example.com docker compose -f deploy/docker-compose.yml up -d --build
```
Caddy 會自動申請憑證，完成後開 `https://maps.example.com`。**不用 Docker**：裝 Node 18+ → `deploy/taiwantong.service`（systemd）→ 前面放 Caddy 或 Nginx（`deploy/`）。放在反向代理後面時要設 `TRUST_PROXY=1`。

### API（回應格式一致）
成功：`{ "ok": true, "data": …, "meta": { "requestId", "ms", "cached", "osmVersion" } }`
失敗：`{ "ok": false, "error": { "code", "message", "details" }, "meta": { "requestId" } }`，HTTP 狀態碼對應錯誤類型。

| API | 說明 |
|---|---|
| `GET /api/v1/health` | 狀態、版本、OSM 道路圖資訊、TDX 是否設定（不含金鑰）、計算執行緒與快取統計 |
| `GET\|POST /api/v1/osm/route?from=緯,經&to=緯,經&mode=car` | 道路路線（`mode`：car／heavy／moto／bike／walk；`via`、`depart`、`heading`、`alternatives`、`events=0`、`traffic=0`、`conditional`） |
| `GET /api/v1/osm/nearest`、`GET /api/v1/osm/search?q=` | 最近道路、路名搜尋 |
| `GET /api/v1/osm/tiles/{z}/{x}/{y}.json`、`/api/v1/osm/buildings/{z}/{x}/{y}.json` | 地圖圖磚、建築 |
| `GET /api/v1/transit/plan?from=&to=&depart=`、`GET /api/v1/transit/status` | 全台大眾運輸規劃、資料狀態 |
| `GET /api/v1/poi/search｜nearby｜detail｜categories`、`GET /api/v1/poi/live?ids=` | 店家與停車／充電地點；即時剩餘車位、空槍 |
| `GET /api/v1/traffic/flow`、`GET /api/v1/traffic/events` | 即時路況（圖層／統計）、道路事件 |
| `POST /api/v1/admin/reload` | 重新載入 OSM 道路圖（`Authorization: Bearer <ADMIN_TOKEN>`） |
| `GET /tdx/api/<TDX 路徑>` | TDX 代理（token 快取、401 自動換新、相同請求合併、15 秒快取） |

**已移除（v1.18，回 `410 GONE`，訊息指出替代的 API）**：`/api/v1/route`、`/api/v1/transit`、`/api/v1/multimodal`、`/api/v1/geocode`、`/api/v1/reverse`、`/api/v1/nearby-roads`、`/api/v1/traffic`。

常見錯誤碼：`BAD_COORD`(400)、`BAD_MODE`(400)、`BAD_JSON`(400)、`BODY_TOO_LARGE`(413)、`NO_ROUTE`(404)、`GONE`(410)、`RATE_LIMITED`(429，附 `Retry-After`)、`OSM_NOT_LOADED`(503)、`TDX_NOT_CONFIGURED`(503)、`COMPUTE_TIMEOUT`(504)。

### 安全
金鑰只在 `.env`（伺服器端）；靜態檔白名單（不會送出 `server/`、`.env`、`package.json`、`data/`）；擋 `../` 路徑穿越；每 IP 限流；請求大小上限；安全標頭（nosniff、Permissions-Policy 只允許本站使用定位、HTTPS 時送 HSTS）；預設不開放跨網域（`CORS_ORIGINS` 才開）。

### 測試
`test/server.mjs`（`npm test` 內）：靜態檔壓縮／ETag／白名單、`data/` 不公開、舊 API 回 410、錯誤碼、限流、TDX 代理（假的上游：token 快取、請求合併、401 重試、金鑰不外流）、管理用重新載入。OSM 路線 API 在 `test/server-osm.mjs`、`test/osm-v111.mjs`、`test/via.mjs`（用 `test/fixtures/osm/tw-mini.osm.pbf` 建的測試路網）。**Docker 映像在這個環境沒有實際建置過。**

---

## 掛進 server_2（rsmn574.com）

server_2 的程式**完全不動**，只在 `app.js` 加兩行，bus-planner 就會出現在 `https://你的網域/bus-planner/`：

```js
import { busPlanner } from './bus-planner/server/express-mount.mjs';   // 檔案開頭的 import 區
app.use('/bus-planner', busPlanner());                                 // 緊接在 app.set('trust proxy', 1) 後面
```

- 一定要放在 `cors`、`rateLimit`、`express.json()` **之前**：bus-planner 有自己的限流與錯誤處理，也要自己讀 POST 內容。
- **TDX**：直接讀 server_2 由 cron 更新的 `token.txt`（`TOKEN_FILE`），不另外取 token；網頁看不到 token。
- **道路圖**：放在 `bus-planner/data/osm/graph/`，在背景執行緒載入，不擋住原本 API。記憶體會加在同一個 Node 程序上，PM2 的記憶體上限要一起調。
- **dist**：沒有 dist 時會自動改用原始碼（ES Modules）提供網頁；想用打包版就在伺服器上跑 `node bus-planner/build.mjs`。
- **設定**（都加 `BUS_PLANNER_` 前綴，全部可省略）：`BUS_PLANNER_DATA_DIR`、`BUS_PLANNER_RATE_LIMIT_PER_MIN`（預設 120）、`BUS_PLANNER_WORKERS`（預設 1）、`BUS_PLANNER_OSM_WARM`、`BUS_PLANNER_LOG`（預設 0）、`BUS_PLANNER_ADMIN_TOKEN`。
- **測試**：在 server_2 根目錄執行 `node bus-planner/test/server2-mount.mjs`（不在 server_2 裡時會略過）。

---

# 開發紀錄（v1.17 以前）

以下各節是當時的紀錄，保留作為歷史；提到的本機路網、`data/graph`、前端路線演算法、`/api/v1/route` 等功能已在 v1.18 移除。

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

## v1.15.0：TDX 即時路況（紅黃綠、路線時間依即時速度修正）

整體擴充計畫（全台公車、停車與充電、廢除舊路網…）：[`docs/design/TDX_EXPANSION_PLAN.md`](docs/design/TDX_EXPANSION_PLAN.md)；這一版是 A 期「即時路況」。

- **資料**：TDX 路況資訊 v2（`docs/oas/tdx-traffic-v2.json`）。高公局（國道）、公路局（省道）與 OAS 列出的 11 個縣市（台北、基隆、桃園、台中、台南、高雄、宜蘭、苗栗、彰化、雲林、屏東）的「發布路段」：路段、線形、壅塞水準表（每 7 天）＋即時速度與壅塞級別（每 5 分鐘）。
  - `npm run traffic:flow`（手動）；伺服器有 TDX 金鑰時自動每 `TRAFFIC_POLL_MIN` 分鐘（預設 5）更新：每次 13 次呼叫，約 3,700 次／天 ≈ 2.5 點／天。
  - 2026-11-24 實測：12 個機關有靜態資料、9,078 個路段有即時資料；高雄即時 HTTP 400、彰化與雲林即時 0 筆、彰化靜態失敗——介面寫「其他縣市未提供」，不假裝有。
- **實際回應與 OAS 的差異（已處理）**：陣列欄位是 `Sections`／`SectionShapes`／`LiveTraffics`／`CongestionLevels`（OAS 寫 `Items`）；**線形字串最多 500 字被截斷**（國道 465 條有 445 條、公路局 2,576 條），最後一點的數字不完整；宜蘭的路段代碼多了 `ILA:Section:` 前綴；雲林把一般道路標成國道；台北市的級別數字和壅塞水準表對不上（資料用 1～6、表 0～5，級別 0 其實是速度 0）。
- **對應到 OSM 路網**：沿線形取樣吸附到有向邊（方向 ±40°、依道路分類限制 highway 類別，國道不會對到底下的平面道路），截斷的線形從最後一個有效點規劃到終點補齊（終點：SectionEnd，或同路同向里程接續的下一段起點）。實測 9,673 個路段中 9,338 個對到、68,291 段有向邊；國道 2,183 km 對到 2,022 km、台北市 366 km 對到 369 km。約 17～22 秒，結果存在 `.cache/traffic/flow-match.json`，路網或路段資料變了才重算。
- **壅塞分類**：照各機關公布的級別與它們的壅塞水準表（名稱或 A～F 服務水準）；表裡沒有的級別才依速度落在表的哪個區間；速度 0 視為沒有資料。
- **路線**：汽車、大型車、機車在出發時間 30 分鐘內、資料 20 分鐘內時，**只對機關判定車多／壅塞的路段**依「模型速度 ÷ 即時速度」加權（1～5 倍；順暢路段不加權，避免與路口延遲重複計算），封閉 20 倍（盡量避開，不直接禁行）；導航 ETA 跟著變。`traffic=0` 可關閉。回應每條路線多了 `flow`：順暢／車多／壅塞／封閉公尺數與分段。
- **地圖**：圖層選單「即時路況（TDX）」，預設開；順暢綠、車多黃、壅塞紅、封閉深灰虛線，往行進方向右側平移（雙向分開）；縮小時只畫國道與快速道路；路線上的車多／壅塞路段疊色；路線卡的路況條改成真的比例與「涵蓋 N%」（沒有資料時仍寫「無即時路況資料」）。
- **API**：`GET /api/v1/traffic/flow`（狀態與統計）、`GET /api/v1/traffic/flow?bbox=西,南,東,北`（地圖圖層，最多 4,000 個路段）；`/api/v1/osm/info` 的 `flow`。
- **測試**：`npm run test:flow`（已加入 `npm test`）：WKT 與截斷、里程、分類（名稱、字母、機關表、表外級別、速度 0）、路段整理（前綴、雲林、里程接續）、對應（方向、截斷補齊）、加權（過期、封閉、與道路事件合併）、路線路況、同步（假的 TDX、失敗的機關）、伺服器 API（狀態、圖層、路線避開壅塞、步行不套用、3 小時後出發不套用、即時檔更新自動重讀）。
- 新增：`server/traffic/flow.mjs`、`server/traffic/flow-sync.mjs`、`tools/traffic-flow-sync.mjs`、`js/traffic-layer.js`、`test/traffic-flow.mjs`、`docs/design/TDX_EXPANSION_PLAN.md`；修改：`server/osm-engine.mjs`、`server/osm/router.mjs`（每一小段對應的有向邊）、`server/server.mjs`（定時更新、API）、`server/backend.mjs`、`server/route-worker.mjs`、`server/config.mjs`、`.env.example`、`js/ui-shell.js`、`js/main.js`、`css/app.css`、`package.json`。

## v1.16.0：全台公車（22 縣市＋公路客運＋台灣好行）

[`docs/design/TDX_EXPANSION_PLAN.md`](docs/design/TDX_EXPANSION_PLAN.md) 的 B 期。

- **資料**：`TRANSIT_CITY=all`（或 `npm run transit:sync -- --city all …`）＝公車 v2 OAS 的 22 個縣市市區公車＋公路客運（`/Bus/…/InterCity`）＋台灣好行（觀光資訊 v2：`/Tourism/Bus/…/TaiwanTrip`）。也可以只填幾個：`Taipei,NewTaipei,InterCity`；只填一個縣市時沿用舊的檔名。
  - 依 OAS 與實測只問存在的端點：`DailyTimeTable` 只有 17 個縣市（台北、新北、台南、金門、連江回 400）；市區與公路客運的 `S2STravelTime` 回 404（只問台灣好行的 `S2TravelTime`）→ 全台 68 個資料集。
  - 2026-11-25 實測：155,312 個公車站牌、8,723 個路線型態、161,505 班；壓縮後 29 MB；同步約 2.5 分鐘；建資料約 4～15 秒。1,847 個型態沒有班次或班距資料，標示「時刻資訊不足」，不代表停駛。
  - **台灣好行**的路線就是各縣市公車的路線（RouteUID 相同，例如 KEE0472）：不重複加入，只把那條路線標示「台灣好行」並帶上名稱（例如「台灣好行 北投竹子湖線 小9」）；188 條合併。台灣好行沒有 RouteName，用 TaiwanTripName。
  - 伺服器每 `TRANSIT_SYNC_HOURS`（預設 6）小時用子行程同步到期的資料（當日班表 6 小時、其他 1～30 天；每次約 25 次呼叫），各執行緒發現資料變了會自己重新讀取。
- **轉乘**：全台站點多（450 m 內平均 66 個鄰站、1,027 萬條），公車站之間只留步行最近的 24 個（連到軌道／捷運站、TDX 轉乘資料的一律保留）→ 288 萬條；結果存在 `.cache/transit/transfers.json.gz`（13 MB），站點或路網沒變時啟動只要讀檔約 1～2.5 秒（第一次計算約 45～60 秒）。
  - OSM 常缺車站內通道：兩個軌道／捷運站直線 450 m 內、步行路網走不到時，用直線推估並標示（全台 4 對，例如高鐵台中站↔台鐵新烏日站；TDX 的 `/v3/Rail/TRA/StationTransfer` 實測沒有軌道轉乘資料）。不因站名相同就合併。
- **規劃結果**：路線名稱標示「公路客運 7322」「台灣好行 …」。實測（本機、全台資料，查詢已暖機）：嘉義車站→阿里山 公路客運 7322 147 分、高雄車站→墾丁 公路客運 9188 139 分、花蓮車站→太魯閣 自強＋公車 302 53 分；單次查詢約 0.04～0.6 秒（伺服器啟動後第一次較慢，啟動時會先展開今天的班表）。記憶體：大眾運輸資料約 1.3 GB（含 OSM 圖的執行緒合計約 1.6～1.9 GB）。
- **沒有的**：公車沒有接票價（OD 票價）與線型（站與站之間畫直線，照實標示）；DRTS 需求反應式公車（公車 v3）沒有接。
- **測試**：`npm run test:transit-all`（已加入 `npm test`）：來源與資料清單（OAS 列舉、舊檔名）、多來源同步與合併（台灣好行重複、公路客運標示）、跨縣市規劃用到公路客運、轉乘（鄰站上限、軌道站直線推估、存檔與失效）。
- 修改：`server/transit/snapshot.mjs`、`server/transit/bus-provider.mjs`、`server/transit/transfer-engine.mjs`、`server/transit/raptor.mjs`、`server/transit-engine.mjs`、`server/server.mjs`、`server/config.mjs`、`tools/transit-sync.mjs`、`tools/setup.mjs`、`.env.example`、`package.json`；新增 `test/transit-all.mjs`。你的 `.env` 的 `TRANSIT_CITY` 已改成 `all`。

## v1.17.0：停車場與充電站（TDX，含即時剩餘車位、空槍）

[`docs/design/TDX_EXPANSION_PLAN.md`](docs/design/TDX_EXPANSION_PLAN.md) 的 C 期。

- **資料**（`docs/oas/tdx-parking-v1.json`、`tdx-ev-v1.json`）：`npm run places:sync`（約 45 次呼叫、1 分鐘；伺服器每 7 天自己更新）→ `.cache/places/places-static.json.gz`。2026-11-25 實測：路外停車場 3,089 個（20 縣市＋國道服務區）、充電站 3,286 個（21 縣市＋國道服務區）。
  - **台北市的停車場基本資料（CarPark）TDX 回 0 筆**，剩餘車位清單有 1,196 個但沒有座標 → 只有名稱與台北範圍內的 OSM 停車場正規化後完全相同、而且只有一個時才放上地圖（標示「位置依名稱對應 OpenStreetMap」）：86 個；其餘不猜位置。新北市沒有停車場資料（OAS 沒列）。
  - 同名、20 m 內的重複充電站（多半是交流／直流分開登錄）合併成一筆，即時狀態加總。
- **併入地點搜尋**：類別「停車場」「充電站」以 TDX 為準，同類的 OSM 地點在 60 m 內同名或 40 m 內沒有名稱的不重複列（全台 915 筆）；其他 OSM 停車場、充電站照常列出。
- **即時**：查看時才由伺服器向 TDX 取（停車場剩餘車位 12 縣市＋國道服務區、充電槍狀態 21 縣市＋國道服務區），每個縣市一次呼叫、快取 3 分鐘（`PLACES_LIVE_TTL_S`）；不輪詢全台。
  - 清單與詳細卡顯示「剩 N 位／總數」「機車 N」（機車停車場只顯示機車）、「空槍 N／總數」「故障 N」與資料時間；超過 30 分鐘的資料照實寫「最後一筆即時資料 N 天前，可能已不準」（實測台中有停車場停在 18 天前）；沒有提供的縣市寫「這個縣市沒有提供即時剩餘車位」。剩餘車位是負數（未知）時不顯示數字。
  - 詳細卡另有充電槍規格（CCS2 DC×2…）、充電費率、停車費率、開放時間、使用限制、來源（交通部 TDX）。
- **API**：`GET /api/v1/poi/live?ids=p:縣市:代碼,e:縣市:代碼`；`/api/v1/poi/search` 的結果多了 `source: 'TDX'`、`liveIds`；`/api/v1/poi/detail` 多了 `tdx`。
- **測試**：`npm run test:places`（已加入 `npm test`）。
- 新增：`server/places/tdx-places.mjs`、`tools/places-sync.mjs`、`test/places.mjs`；修改：`server/osm/poi.mjs`、`server/osm-engine.mjs`、`server/server.mjs`、`server/config.mjs`、`js/poi.js`、`css/app.css`、`tools/setup.mjs`、`package.json`。

## v1.18.0：廢除舊的本機路網，整個系統只用全台 OSM

依需求「廢除舊的路網」：舊的台中本機路網與建立在它上面的功能**全部移除**，地圖、路線、導航、搜尋只用伺服器的全台 OSM 道路圖與 TDX 資料。

**移除的功能（不再提供）**
- 網頁載入本機路網（`data/graph/*.json`、`graph.bin`、拖曳選檔）、前端路線演算法（Dijkstra／A*／雙向／多層級、Yen K 條、Pareto）、避開路名、成本偏好 α／β／δ、演算法選擇。
- 本機公車／捷運／YouBike 檔案（`data/bus/graph.json`、`data/metro.json`、`data/ubike.json`）與用它們的公車建議、時刻表搜尋（前端 RAPTOR／CSA）、YouBike 接駁。全台大眾運輸改由伺服器的 `/api/v1/transit/plan` 提供（v1.11 起已是如此）。
- 營運規劃（道路適宜性、站點建議、評分權重）、道路寬度圖層、周邊道路、道路屬性表（`road-attrs.json`）。
- 網頁的 TDX 金鑰／Proxy 設定與前端 TDX 呼叫（金鑰只在伺服器；`/tdx` 代理與 `proxy.mjs` 保留）。
- 「關閉 OSM 改用本機路網」開關。
- **離線規劃**：以前雙擊 `dist/index.html` 可以用本機路網離線規劃；現在網頁一定要由伺服器提供。
- 伺服器：`server/engine.mjs`、`/api/v1/route｜transit｜multimodal｜geocode｜reverse｜nearby-roads｜traffic`（改回 `410 GONE`，訊息指出替代 API）、`data/` 靜態檔、啟動時建舊路網與 A* 預熱；設定 `ROUTER`、`ALT_CACHE`、`WARMUP`、`MAX_SNAP_M`、`ROAD_TABLE`、`BUS_GRAPH`、`METRO`、`YOUBIKE`（留在 `.env` 也不會出錯，只是不再使用）。
- 工具：`tools/pack-graph.mjs`（`npm run pack`）、`tools/metro-json.mjs`（`npm run metro:json`）、`transit-sync` 的 `--metro-json`／`--ubike-json`。
- 網頁模組：`graph-build`、`graph-core`、`graph-pack`、`router`、`router-multi`、`planners`、`loader`、`road-attrs`、`bus-core`、`bus-plan`、`timetable`、`tdx`、`transit`、`ubike`（14 個，約 2,600 行）。

**改寫成只用 OSM 的模組**：`analysis.js`、`render-layers.js`、`render-route.js`、`vehicle.js`、`eta-engine.js`、`mapmatch.js`、`nav-ui.js`、`ui-panels.js`、`ui-events.js`、`ui-search.js`、`server-link.js`、`osm.js`、`geo.js`、`dom.js`、`main.js`；`index.html` 移除舊控制項並加上資料來源與授權說明；`sw.js` 版本更新（瀏覽器會清掉舊的快取）。

**伺服器**：`backend.mjs`、`route-worker.mjs`、`express-mount.mjs` 只剩 OSM；`/api/v1/health` 改為 `status`（OSM 載入狀態）、`osm`、`tdx`、`traffic.pollMin`、`compute`、`cache`（不再有 `graph`、`files`、`data`）；API 的 `meta` 一律帶 `osmVersion`。Dockerfile 一併複製 `tools/`（即時路況、停車即時資料、大眾運輸同步在執行時會用到；v1.15–v1.17 漏了這一項）。

**測試**：刪除只測舊路網的測試（e2e、ui、t12_fresh、net、metro、vehicle、moa、moa_random、mode、server-workers、metro-transit、metro-json、ubike-transit、bench-transit、browser、browser-ubike、browser-metro、bench-browser）。`nav`、`nav-eta`、`nav-perf` 改用 `test/osm-route-fixture.mjs`：產生與伺服器 `describe()` 相同格式的合成路線（每段時間與路口延遲照伺服器公式、參數表共用），再交給網頁真正的 `osmRouteObj()`；偏航後的伺服器重新規劃在 `nav-eta` 用模擬回應、在 `via.mjs` 用真的伺服器。`server.mjs` 改測舊 API 回 410、`data/` 不公開、新的 health。`npm test` 現在是 18 組，全部通過；`browser-osm.cjs` 已更新但這個環境沒有 Playwright，**沒有實際跑過**。
