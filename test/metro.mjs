// 捷運整合測試：使用真實的 metro.json（TDX Metro Station，臺中捷運綠線 18 站）
import { readFileSync } from 'node:fs';
const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const drawn=[];const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){drawn.length=0},insertAdjacentHTML(){},appendChild(e){drawn.push(e)}};
const mk=t=>({t,a:{},setAttribute(k,v){this.a[k]=v},getAttribute(k){return this.a[k]},appendChild(){}});
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:(_,t)=>mk(t),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();
let fetchCalls=[];globalThis.fetch=(u)=>{fetchCalls.push(String(u));return Promise.reject(new Error('offline'));};
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadBus, loadMetro, metroToGraph }=await import('../js/transit.js');const { legCoordsOf, routeKindOf }=await import('../js/bus-core.js');
const { suggestBusMulti }=await import('../js/bus-plan.js');const { annotateJourney, TDX }=await import('../js/tdx.js');const { ttSearch }=await import('../js/timetable.js');
const { drawBusDots }=await import('../js/render-layers.js');
const log=(...a)=>console.log(...a);
const metro=JSON.parse(readFileSync(new URL('./fixtures/metro.json',import.meta.url)));
// ① 站序：由 StationID 排序。驗證方式：依站號排的路徑總長，應明顯短於依緯度／經度排的（站序若錯，路徑會來回折返），且相鄰兩站不超過 3 km
const g=metroToGraph(metro),L=g.lines[0];const { worldHaversine }=await import('../js/geo.js');
const pos=Object.fromEntries(Object.values(g.nodes).map(n=>[n.node_name,[n.longitude,n.latitude]]));
const plen=names=>names.reduce((a,n,i)=>i?a+worldHaversine(...pos[names[i-1]],...pos[n]):0,0),segs=L.stations.slice(1).map((n,i)=>worldHaversine(...pos[L.stations[i]],...pos[n]));
const byLat=[...L.stations].sort((a,b)=>pos[b][1]-pos[a][1]),byLon=[...L.stations].sort((a,b)=>pos[b][0]-pos[a][0]);
log('① 線：',L.line,L.stations.length,'站｜',L.stations.slice(0,4).join('→'),'…',L.stations.slice(-2).join('→'));
log('   依站號排序的路徑總長 =',(plen(L.stations)/1000).toFixed(1),'km｜依緯度排 =',(plen(byLat)/1000).toFixed(1),'km｜依經度排 =',(plen(byLon)/1000).toFixed(1),'km｜站號排序最短 =',plen(L.stations)<=Math.min(plen(byLat),plen(byLon)),'｜相鄰最遠 =',Math.round(Math.max(...segs)),'m');
const nEdges=Object.values(g.adjacency).reduce((a,x)=>a+x.length,0);log('   邊數 =',nEdges,'（17 段 × 雙向 = 34）｜G8→G8a→G9 的順序：',L.stations.slice(L.stations.indexOf('文華高中'),L.stations.indexOf('文華高中')+3).join('→'));
// ② 道路圖（3 個節點：靠近 G6、G9、G17），公車（B1：G6 附近 → G9 附近）
const P={G6:[120.68486,24.17219],G9:[120.64903,24.16199],G17:[120.61405,24.11011],G0:[120.70864,24.18913]};const m2=(m,lat)=>m/(111320*Math.cos(lat*Math.PI/180));
const nd=(lon,lat)=>{const [e,n]=tw(lon,lat);return{x:Math.round(e*100),y:Math.round(n*100)}};
const oLon=P.G6[0]+m2(60,24.17),oLat=P.G6[1];                    // 起點：G6（文心崇德）旁 60 m
buildGraph({nodes:[{id:'o',...nd(oLon,oLat)},{id:'d',...nd(P.G17[0]+m2(80,24.11),P.G17[1])}],edges:[{from:'o',to:'d',w:9000,edgeId:'e'}],roads:{}});
S.fromPoint={idx:0};S.toPoint={idx:1};
const bn={BA:{node_name:'公車起點',latitude:oLat,longitude:oLon+m2(40,24.17)},BB:{node_name:'公車終點(近市政府站)',latitude:P.G9[1],longitude:P.G9[0]+m2(70,24.16)}};
loadBus({nodes:bn,adjacency:{BA:[{to:'BB',distance_meters:4200,route_name:'B1',route_uid:'uB1',travel_times:[{run_time:900}]}]}});
loadMetro(metro);
const b=S.bus;log('② 合併後：',b.n,'站（公車 2 + 捷運 18）｜路線：',b.routeLabels.map((l,i)=>l+'['+b.routeKind[i]+']').join('、'));
log('   狀態列：',els.metroStat.innerHTML.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,150));
const iG9=b.names.indexOf('市政府'),iBB=b.names.indexOf('公車終點(近市政府站)');log('   市政府站與公車站同站群（可步行轉乘）=',b.group[iG9]>=0&&b.group[iG9]===b.group[iBB],'｜捷運站未被吸附到道路（sx==x）=',b.sx[iG9]===b.x[iG9]);
// ③ 多方案
const o=suggestBusMulti(S.nodeXY[0*5+2],S.nodeXY[0*5+3],S.nodeXY[1*5+2],S.nodeXY[1*5+3]);
const flow=x=>x.rides.map(r=>(routeKindOf(r)==='metro'?'🚇':'🚌')+r.label+'('+(r.stops.length-1)+'站)').join(' → ');
log('③ 方案數',o.length);o.forEach((x,i)=>log(`   ${i+1}. ${x.transfers===0?'直達':'轉乘'+x.transfers} ${flow(x)} 推估 ${Math.round(x.sec/60)} 分｜步行入 ${Math.round(x.walkIn)}m 出 ${Math.round(x.walkOut)}m`));
const mo=o.find(x=>x.rides.length===1&&routeKindOf(x.rides[0])==='metro');
if(mo){const exp=(()=>{let s=240;const st=mo.rides[0].stops;for(let i=0;i<st.length-1;i++){}return s;})();log('   捷運直達：乘車 =',Math.round(mo.rides[0].sec/60),'分（17 站距離×1.15÷9.7 m/s＋每站 30 秒），候車以假設班距 8 分的一半(4 分)');}
// ④ 畫線：捷運走直線（站數＝折線點數），公車段沿道路
if(mo)log('④ 捷運段折線點數 =',legCoordsOf(mo.rides[0]).length,'= 經過站數',mo.rides[0].stops.length,'（直接連站，不沿道路）');
// ⑤ TDX：捷運不呼叫公車 API
fetchCalls=[];Object.assign(TDX,{apiKey:'K',backoffMs:1});
const mixed=o.find(x=>x.rides.some(r=>routeKindOf(r)==='metro')&&x.rides.length>1)||mo;const a=await annotateJourney(mixed,Date.now());
const apiCalls=fetchCalls.filter(u=>u.includes('Taichung')||u.includes('tokens'));
log('⑤ annotate 含捷運的方案：TDX 呼叫',apiCalls.length,'次，其中捷運路線',apiCalls.filter(u=>u.includes(encodeURIComponent('捷運綠線'))).length,'次（應為 0）｜捷運段候車來源 =',a.legs.find(l=>l.metro)?.waitSrc,'｜備註 =',a.legs.find(l=>l.metro)?.notes[0]);
// ⑥ 時刻表搜尋不納入捷運
fetchCalls=[];const net=await ttSearch('raptor',true);log('⑥ 時刻表搜尋納入的路線：',net.net.labels.join(',')||'(無)','｜是否含捷運 =',net.net.labels.includes('捷運綠線'));
// ⑦ 繪圖：捷運站與線一直顯示
S.view={tx:0,ty:0,scale:1};drawn.length=0;drawBusDots();const col=drawn.filter(d=>d.t==='path').map(d=>d.a.stroke);log('⑦ scale=1 繪製：捷運站(#15803d)',col.includes('#15803d'),'｜捷運線(#16a34a)',col.includes('#16a34a'),'｜公車站點(#a78bfa，放大後才顯示)',col.includes('#a78bfa'));
process.exit(0);
