// main.js — 啟動：把「上層函式」登記到 Hooks，依序執行各模組的事件綁定，最後畫出空白畫面並自動載入資料
import { Hooks } from './state.js';
import { rescore, routeMetrics } from './analysis.js';
import { scheduleRender } from './render-core.js';
import { drawBus, drawInspect, drawUbike, drawWidthLayer } from './render-layers.js';
import { drawRoute } from './render-route.js';
import { renderAnalysis, renderRouteList, stepColor, updateBusSuggestion } from './ui-panels.js';
import { init as init_loader } from './loader.js';
import { init as init_router } from './router.js';
import { init as init_ui_search } from './ui-search.js';
import { init as init_ui_events } from './ui-events.js';
import { init as init_bus_core } from './bus-core.js';
import { init as init_ubike } from './ubike.js';
import { init as init_analysis } from './analysis.js';
import { init as init_road_attrs } from './road-attrs.js';
import { init as init_tdx } from './tdx.js';
import { init as init_transit } from './transit.js';
import { drawGrid } from './render-core.js';
import { drawNav, init as init_nav_ui } from './nav-ui.js';
import { init as init_ui_touch } from './ui-touch.js';
import { init as init_pwa } from './pwa.js';
import { init as init_server_link } from './server-link.js';
import { tryFetchAll } from './loader.js';
import { init as init_osm } from './osm.js';
import { init as init_map_view, syncMapUi } from './map-view.js';
import { init as init_transit_plan } from './transit-plan.js';
import { init as init_ui_shell } from './ui-shell.js';
import { init as init_poi } from './poi.js';
import { init as init_via } from './via.js';
import { syncControls } from './ui-events.js';

// 低層模組需要呼叫高層函式時，透過 Hooks.xxx（避免循環 import）
Object.assign(Hooks, { syncMapUi, syncControls, drawNav, drawBus, drawInspect, drawRoute, drawUbike, drawWidthLayer, renderAnalysis, renderRouteList, rescore, routeMetrics, scheduleRender, stepColor, updateBusSuggestion });

init_loader();
init_router();
init_ui_search();
init_ui_events();
init_nav_ui();
init_ui_touch();
init_pwa();
init_bus_core();
init_transit();
init_ubike();
init_analysis();
init_road_attrs();
init_tdx();
init_osm();
init_map_view();
init_transit_plan();
init_ui_shell();             // v1.12：UI 外殼（搜尋列、浮動按鈕、底部面板、路線卡）——搬動既有元素，最後執行
init_via();                  // v1.14：途經點（規劃區的途經點列、地圖標記）
init_poi();                  // v1.13：店家地點搜尋（下拉「地點」區、類別快捷、清單、標記、詳細卡）——要在外殼之後

drawGrid();
tryFetchAll();
init_server_link();          // 由台灣通伺服器提供時：自動設定 TDX 代理、載入伺服器上的公車／捷運／道路屬性表
