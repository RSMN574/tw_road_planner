// main.js — 啟動：把「上層函式」登記到 Hooks，依序執行各模組的事件綁定，最後畫出空白畫面並連上伺服器
// v1.18：只有伺服器的全台 OSM 道路圖（舊的本機路網、前端路線演算法、公車／捷運／YouBike 本機資料已移除）
import { Hooks } from './state.js';
import { scheduleRender } from './render-core.js';
import { drawRoute } from './render-route.js';
import { renderAnalysis, renderRouteList, stepColor } from './ui-panels.js';
import { init as init_ui_search } from './ui-search.js';
import { init as init_ui_events } from './ui-events.js';
import { drawGrid } from './render-core.js';
import { drawNav, init as init_nav_ui } from './nav-ui.js';
import { init as init_ui_touch } from './ui-touch.js';
import { init as init_pwa } from './pwa.js';
import { init as init_server_link } from './server-link.js';
import { init as init_osm } from './osm.js';
import { init as init_map_view, syncMapUi } from './map-view.js';
import { init as init_transit_plan } from './transit-plan.js';
import { init as init_ui_shell } from './ui-shell.js';
import { init as init_poi } from './poi.js';
import { init as init_via } from './via.js';
import { init as init_traffic_layer } from './traffic-layer.js';
import { syncControls } from './ui-events.js';

// 低層模組需要呼叫高層函式時，透過 Hooks.xxx（避免循環 import）
Object.assign(Hooks, { syncMapUi, syncControls, drawNav, drawRoute, renderAnalysis, renderRouteList, scheduleRender, stepColor });

init_ui_search();
init_ui_events();
init_nav_ui();
init_ui_touch();
init_pwa();
init_osm();
init_map_view();
init_transit_plan();
init_ui_shell();             // v1.12：UI 外殼（搜尋列、浮動按鈕、底部面板、路線卡）——搬動既有元素，最後執行
init_traffic_layer();        // v1.15：即時路況圖層（TDX 路況資訊 v2）
init_via();                  // v1.14：途經點（規劃區的途經點列、地圖標記）
init_poi();                  // v1.13：店家地點搜尋（下拉「地點」區、類別快捷、清單、標記、詳細卡）——要在外殼之後

drawGrid();
init_server_link();          // 連上伺服器：全台 OSM 道路圖好了就啟用
