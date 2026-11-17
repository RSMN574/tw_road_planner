// 端對端測試（Node，無任何依賴）：以 DOM stub 載入真正的模組，驗證拆分後的行為
const els={};
const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:false,children:[],style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},H:{},addEventListener(n,f){this.H[n]=f}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){},contains:()=>false},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){},getAttribute(){}}),createElement:()=>el('x')};
globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();
let FETCH=()=>Promise.reject(new Error('offline'));globalThis.fetch=(...a)=>FETCH(...a);
const log=(...a)=>console.log(...a);
const M=await import('../js/main.js');                                  // 啟動流程本身也要能跑（init、R 登記、tryFetchAll 失敗不致崩潰）
const { State:S, Hooks:R }=await import('../js/state.js');
const { buildGraph }=await import('../js/loader.js');
const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadBus }=await import('../js/transit.js');
const { suggestBusMulti, suggestBus }=await import('../js/bus-plan.js');
const { updateBusSuggestion }=await import('../js/ui-panels.js');
const { TDX, annotateJourney }=await import('../js/tdx.js');
const { tdxCache }=await import('../js/constants.js');
const { ttSearch }=await import('../js/timetable.js');
const { runTT }=await import('../js/ui-panels.js');
const { yenK }=await import('../js/router-multi.js');
const { planAll }=await import('../js/planners.js');
const { loadRoadTable, ensureRA }=await import('../js/road-attrs.js');
const R_ok=['drawRoute','scheduleRender','renderRouteList','rescore','routeMetrics','updateBusSuggestion','stepColor','renderAnalysis','drawBus','drawUbike','drawInspect','drawWidthLayer'].every(k=>typeof R[k]==='function');
log('啟動：main.js 載入成功｜R 登記表完整 =',R_ok);
const LON=120.67,LAT=24.12,m2lon=m=>m/(111320*Math.cos(LAT*Math.PI/180));
// ================= t18：公車多方案 =================
{const P={A:[0,0],A2:[250,0],B:[4000,0],Bg:[4030,0],C:[8000,0]},pos=k=>[LON+m2lon(P[k][0]),LAT],nd=k=>{const [e,n]=tw(...pos(k));return{x:Math.round(e*100),y:Math.round(n*100)}};
 buildGraph({nodes:[{id:'o',...nd('A')},{id:'d',...nd('C')}],edges:[{from:'o',to:'d',w:8000,edgeId:'e'}],roads:{}});
 const bn={};for(const k in P)bn[k]={stop_id:k,node_name:'站'+k,latitude:pos(k)[1],longitude:pos(k)[0],...(k==='B'||k==='Bg'?{station_group_id:'G1'}:{})};
 const adj={};const L=(f,t,r,sec)=>(adj[f]=adj[f]||[]).push({to:t,distance_meters:1000,route_name:r,route_uid:'u'+r,travel_times:[{service_tag:'x',start_time:'06:00',end_time:'22:00',run_time:sec}]});
 L('A','B','R1',600);L('Bg','C','R2',600);L('A','C','R3',1300);L('A','C','R4',1600);L('A2','C','R5',1400);L('A2','B','R6',700);
 loadBus({nodes:bn,adjacency:adj});S.fromPoint={idx:0};S.toPoint={idx:1};
 const flow=o=>o.rides.map(r=>r.label).join('+');updateBusSuggestion();const o=S.busOpts;
 log('T18 方案數 =',o.length);o.forEach((x,i)=>log(`T18  ${i+1}. ${x.transfers===0?'直達':'轉乘'+x.transfers} ${flow(x)}  推估 ${Math.round(x.sec/60)} 分 步行入 ${Math.round(x.walkIn)}m`));}
// ================= t17：RAPTOR／CSA／ETA 配對 =================
{let NOW=Date.parse('2026-11-04T18:02:00+08:00'),CLOCK=NOW,DATA={};S.tdxNow=()=>CLOCK;Object.assign(TDX,{apiKey:'K',backoffMs:1});el('ubR').value='300';
 FETCH=async(url)=>{if(url.includes('/tokens'))return{ok:true,status:200,text:async()=>JSON.stringify({access_token:'tok_abcdef123456',expires_in:3600})};
  const m=/\/(EstimatedTimeOfArrival|DailyStopTimeTable)\/City\/Taichung\/([^?]+)/.exec(url),d=DATA[decodeURIComponent(m[2])];if(!d)return{ok:false,status:404,json:async()=>[]};return{ok:true,status:200,json:async()=>m[1]==='EstimatedTimeOfArrival'?d.eta:d.tt};};
 const E=(uid,id,name,seq,dir,est,status=0,route='X',upd='2026-11-04T18:01:30+08:00')=>({StopUID:uid,StopID:id,StopName:{Zh_tw:name},RouteUID:'TXG'+route,RouteID:route,RouteName:{Zh_tw:route},SubRouteName:{Zh_tw:route},Direction:dir,...(est==null?{}:{EstimateTime:est,Estimates:[{PlateNumb:'P1',EstimateTime:est,IsLastBus:false}]}),StopSequence:seq,StopStatus:status,DestinationStop:'終點',UpdateTime:upd});
 const TT=(route,stops,date='2026-11-04T00:00:00+08:00')=>({BusDate:date,RouteName:{Zh_tw:route},SubRouteName:{Zh_tw:route},DestinationStopName:{Zh_tw:'終點'},Stops:stops.map(([uid,id,name,times])=>({StopUID:uid,StopID:id,StopName:{Zh_tw:name},TimeTables:times.map(([a,d],i)=>({Sequence:i+1,ArrivalTime:a,DepartureTime:d,TimeType:0}))}))});
 const P={A:[LON,LAT],B:[LON+0.008,LAT],B2:[LON+0.008+m2lon(80),LAT],C:[LON+0.02,LAT]},SID={A:'1001',B:'1002',B2:'1003',C:'1004'};
 const nd=k=>{const [e,n]=tw(...P[k]);return{x:Math.round(e*100),y:Math.round(n*100)}};
 buildGraph({nodes:[{id:'o',...nd('A')},{id:'d',...nd('C')}],edges:[{from:'o',to:'d',w:2000,edgeId:'e'}],roads:{}});
 const bn={};for(const k in P)bn[k]={stop_id:SID[k],node_name:'站'+k,latitude:P[k][1],longitude:P[k][0]};
 const ln=(f,t,r)=>({to:t,distance_meters:900,route_name:r,route_uid:'u'+r});loadBus({nodes:bn,adjacency:{A:[ln('A','B','R1'),ln('A','C','R3')],B2:[ln('B2','C','R2')]}});S.fromPoint={idx:0};S.toPoint={idx:1};
 const stp=(k,times)=>['TXG'+SID[k],SID[k],'站'+k,times],hm=ms=>new Date(ms+8*36e5).toISOString().slice(11,16);
 const fx=(a='18:20')=>{DATA={R1:{eta:[],tt:[TT('R1',[stp('A',[['18:10','18:10'],['18:40','18:40']]),stp('B',[[a,a],['18:50','18:50']])])]},R2:{eta:[],tt:[TT('R2',[stp('B2',[['18:25','18:25'],['18:55','18:55']]),stp('C',[['18:45','18:45'],['19:15','19:15']])])]},R3:{eta:[],tt:[TT('R3',[stp('A',[['18:15','18:15']]),stp('C',[['19:00','19:00']])])]}};};
 const desc=j=>`轉乘${j.legs.filter(l=>l.type==='ride').length-1}次 抵達${hm(j.arriveMs)} [${j.legs.map(l=>l.type==='ride'?l.label:'步行').join('→')}]`;
 fx();el('depTime').value='';let r=await ttSearch('raptor',true);const c=await ttSearch('csa',false);
 log('T17 RAPTOR',r.net.labels.join(','),r.js.map(desc).join(' | '));log('T17 CSA',c.js.map(desc).join(' | '),'| 一致:',r.js.at(-1).arriveMs===c.js[0].arriveMs);
 fx('18:26');tdxCache.clear();r=await ttSearch('raptor',true);const c2=await ttSearch('csa',false);log('T17 趕不上轉乘 RAPTOR',r.js.map(desc).join(' | '),'CSA',c2.js.map(desc).join(' | '));
 fx();tdxCache.clear();await runTT(true);log('T17 面板',els.ttBox.innerHTML.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200));
 const mk=(label,a,b)=>({rides:[{label,stops:[a,b],sec:600}],walkIn:0,walkOut:0});
 CLOCK=Date.parse('2026-11-05T00:22:30+08:00');tdxCache.clear();
 DATA={R1:{eta:[E('TXG1001','1001','站A',1,0,null,1,'R1','2026-11-05T00:22:30+08:00'),E('TXG1002','1002','站B',5,0,null,1,'R1','2026-11-05T00:22:30+08:00')],tt:[TT('R1',[stp('A',[['05:50','05:50']]),stp('B',[['06:05','06:05']])],'2026-11-05T00:00:00+08:00')]}};
 let a=await annotateJourney(mk('R1',0,1),CLOCK),g=a.legs[0];log('T17 凌晨 ETA 尚未發車',a.ok?'可搭乘':'不可搭乘','|',g.status||'(無)','| 上車',hm(g.boardAt),g.waitSrc,'|',g.notes.join('；'));
 tdxCache.clear();DATA={R1:{eta:[],tt:[TT('R1',[stp('A',[['24:30','24:30'],['25:10','25:10']]),stp('B',[['24:45','24:45'],['25:25','25:25']])],'2026-11-04T00:00:00+08:00')]}};
 a=await annotateJourney(mk('R1',0,1),CLOCK);g=a.legs[0];log('T17 凌晨 24:30 班次',a.ok?'可搭乘':'不可搭乘','| 上車',hm(g.boardAt),g.waitSrc);
 tdxCache.clear();CLOCK=NOW;DATA={R1:{eta:[E('TXGZZZ1','9991','站A',1,0,600,0,'R1'),E('TXGZZZ2','9992','站B',9,0,1500,0,'R1')],tt:[TT('R1',[['TXGZZZ1','9991','站A',[['18:10','18:10']]],['TXGZZZ2','9992','站B',[['18:30','18:30']]]])]}};
 a=await annotateJourney(mk('R1',0,1),NOW);g=a.legs[0];log('T17 只靠站名配對',g.eta.kind,g.waitSrc);
 tdxCache.clear();DATA={R1:{eta:[E('TXG1001','1001','站A',1,0,null,4),E('TXG1002','1002','站B',5,0,null,4)],tt:[]}};a=await annotateJourney(mk('R1',0,1),NOW);log('T17 StopStatus=4',a.legs[0].status);
 FETCH=()=>Promise.reject(new Error('offline'));}
// ================= t16 ①：Yen 對照暴力枚舉 =================
{let seed=5;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const n=4,id=(i,j)=>`g${i}_${j}`,nodes=[],edges=[];let eid=0;
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){const [e,nn]=tw(LON+i*0.001,LAT+j*0.0009);nodes.push({id:id(i,j),x:Math.round(e*100),y:Math.round(nn*100)});}
 const roads={'路':{segments:0,totalLength:0,edgeIds:[]}};for(let i=0;i<n;i++)for(let j=0;j<n;j++){if(i<n-1){edges.push({from:id(i,j),to:id(i+1,j),w:100*(1+rnd()*0.5),edgeId:eid});roads['路'].edgeIds.push(eid++);}if(j<n-1){edges.push({from:id(i,j),to:id(i,j+1),w:100*(1+rnd()*0.5),edgeId:eid});roads['路'].edgeIds.push(eid++);}}
 buildGraph({nodes,edges,roads});loadRoadTable([{路名:'路',路寬:10,道路型態分類:'平面路段',長度:100,巷:'',弄:''}]);
 const ix=(i,j)=>S.nodeIds.indexOf(id(i,j)),s=ix(0,0),t=ix(3,3),ra=ensureRA(),fn=(e,w,k)=>ra.forb[k]?Infinity:w,all=[];
 const dfs=(u,vis,c)=>{if(u===t){all.push(c);return;}for(let k=S.adjOffset[u];k<S.adjOffset[u+1];k++){const v=S.adjTo[k];if(vis.has(v))continue;vis.add(v);dfs(v,vis,c+S.adjW[k]);vis.delete(v);}};dfs(s,new Set([s]),0);all.sort((a,b)=>a-b);
 const ys=yenK(s,t,fn,8,1000,1);log('T16 暴力前8',all.slice(0,8).map(x=>x.toFixed(1)).join(' '));log('T16 Yen前8 ',ys.map(r=>r.cost.toFixed(1)).join(' '));}
// ================= t12：候選路線（公車模式）=================
S.bus=null;S.UB=null;   // 清掉前一個場景遺留的資料，才不會影響評分項目
{const n=12,id=(i,j)=>`r${i}_${j}`,nodes=[],edges=[];let eid=0;for(let i=0;i<n;i++)for(let j=0;j<n;j++){const [e,nn]=tw(LON+i*0.001,LAT+j*0.001);nodes.push({id:id(i,j),x:Math.round(e*100),y:Math.round(nn*100)});}
 const nameOf=j=>j===3?'潭雅神自行車道':j===2?'小巷':j===5?'中港路':'一般路'+j,roads={};const add=(nm,e)=>{(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(e);};
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){if(i<n-1){const e=eid++;edges.push({from:id(i,j),to:id(i+1,j),w:100,edgeId:e});add(nameOf(j),e);}if(j<n-1){const e=eid++;edges.push({from:id(i,j),to:id(i,j+1),w:100,edgeId:e});add('縱路',e);}}
 buildGraph({nodes,edges,roads});const rows=[{路名:'小巷',路寬:4,道路型態分類:'平面路段',長度:1100,巷:'',弄:''},{路名:'中港路',路寬:30,道路型態分類:'平面路段',長度:1100,巷:'',弄:''},{路名:'縱路',路寬:10,道路型態分類:'平面路段',長度:100,巷:'',弄:''},{路名:'潭雅神自行車道',路寬:5,道路型態分類:'自行車專用道',長度:1100,巷:'',弄:''}];
 for(let j=0;j<n;j++)if(![2,3,5].includes(j))rows.push({路名:'一般路'+j,路寬:10,道路型態分類:'平面路段',長度:1100,巷:'',弄:''});loadRoadTable(rows);
 el('opsMode').checked=true;el('avoidToll').checked=false;el('mode').value='car';el('goal').value='compare';for(const [k,v] of Object.entries({w_suit:35,w_ub:20,w_dist:20,w_turn:10,w_bus:15}))el(k).value=String(v);
 const ix=(i,j)=>S.nodeIds.indexOf(id(i,j)),rs=planAll(ix(0,2),ix(11,2),'');
 for(const it of rs)log('T12',it.label,it.route?`${Math.round(it.route.distance)}m 轉彎${it.turns} 適宜${Math.round(it.met.suit)} 總分${Math.round(it.score.total)}${it.score.best?' ⭐':''}`:it.msg);}
process.exit(0);
