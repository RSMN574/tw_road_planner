# data/ — 資料目錄（本專案不附資料，請自行放入）

| 路徑 | 內容 | 必要？ |
|---|---|---|
| `graph/nodes.json`、`graph/edges.json`、`graph/roads.json` | 道路圖（節點座標為 TWD97；roads.json 以路名為鍵，含 `edgeIds`） | 必要 |
| `road-attrs.json` | 道路屬性表（陣列；欄位 `路名`、`巷`、`弄`、`速限`、`路寬`、`長度`、`道路型態分類`…），依「路名＋巷＋弄」對應到 roads.json | 選填 |
| `ubike.json` | YouBike 站點（TDX 格式：`StationUID`、`StationPosition`、`BikesCapacity`…） | 選填 |
| `bus/graph.json` | 公車站牌與路線圖（`nodes`：站牌含經緯度；`adjacency`：邊含路線與 `travel_times`） | 選填 |

| `metro.json` | 捷運站點（TDX Metro Station：`StationID`、`StationName`、`StationPosition`）；站序由 StationID 推得 | 選填 |

也可以不放檔案，直接在頁面左側用「選擇檔案／拖曳」載入。
