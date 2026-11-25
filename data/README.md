# data/ — 資料目錄（本專案不附資料）

| 路徑 | 內容 | 怎麼產生 |
|---|---|---|
| `osm/raw/` | 台灣 OSM 原始資料（`.osm.pbf`） | `npm run osm:download` |
| `osm/graph/` | 全台 OSM 道路圖（拓樸、通行規則、轉向限制、地標表、建築、店家地點；`current.json` 指向目前版本） | `npm run osm:build`、`osm:alt`、`osm:buildings`、`osm:poi`（或 `npm run setup`） |

TDX 資料（大眾運輸、路況、道路事件、停車、充電樁）不放這裡，而是快取在 `CACHE_DIR`（預設 `.cache/`）。

v1.18 起，舊的本機路網檔案（`graph/*.json`、`road-attrs.json`、`bus/graph.json`、`metro.json`、`ubike.json`）**不再使用**；資料夾裡已有的舊檔不會被刪除，可以自行移除。伺服器也不再把 `data/` 當成靜態檔提供。
