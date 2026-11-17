// 車種規則 / 速限 / 動態權重成本 / ALT / 快取
const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:true,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){}}),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();globalThis.fetch=()=>Promise.reject(new Error('offline'));
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadRoadTable, ensureRA }=await import('../js/road-attrs.js');const { VEHICLES, ensureVeh, makeCost, routeTimeS, speedText, getPref }=await import('../js/vehicle.js');
const { planAll }=await import('../js/planners.js');const { spSearch, dijkstra, makeHeuristic, buildLandmarks }=await import('../js/router.js');
const { CLS, CLS_LABEL }=await import('../js/constants.js');
const log=(...a)=>console.log(...a);
el('opsMode').checked=false;el('avoidToll').checked=false;el('mode').value='car';el('goal').value='compare';el('pref').value='balanced';el('prefA').value='1';el('prefB').value='0.5';el('prefD').value='0.5';el('ubR').value='300';el('kPaths').value='5';
for(const [k,v] of Object.entries({w_suit:35,w_ub:20,w_dist:20,w_turn:10,w_bus:15}))el(k).value=String(v);
const LON=120.67,LAT=24.12,m2lon=m=>m/(111320*Math.cos(LAT*Math.PI/180)),m2lat=m=>m/110574;
const P=(xm,ym)=>{const [e,n]=tw(LON+m2lon(xm),LAT+m2lat(ym));return{x:Math.round(e*100),y:Math.round(n*100)}};
// ===== ① 規則矩陣：每種道路 × 每種車種 =====
{const names=['潭雅神自行車道','市民步道','國道一號','台74線快速道路','一般路','小巷'];const nodes=[],edges=[],roads={};
 names.forEach((nm,i)=>{nodes.push({id:'a'+i,...P(i*3000,0)},{id:'b'+i,...P(i*3000+1000,0)});edges.push({from:'a'+i,to:'b'+i,w:1000,edgeId:i});roads[nm]={segments:1,totalLength:1000,edgeIds:[i]};});
 buildGraph({nodes,edges,roads});
 loadRoadTable([{路名:'潭雅神自行車道',路寬:5,道路型態分類:'自行車專用道',長度:1000,巷:'',弄:''},{路名:'市民步道',路寬:3,道路型態分類:'步行專用道',長度:1000,巷:'',弄:''},{路名:'國道一號',路寬:30,速限:100,道路型態分類:'平面路段',長度:1000,巷:'',弄:''},{路名:'台74線快速道路',路寬:20,速限:80,道路型態分類:'平面路段',長度:1000,巷:'',弄:''},{路名:'一般路',路寬:10,速限:50,道路型態分類:'平面路段',長度:1000,巷:'',弄:''},{路名:'小巷',路寬:4,道路型態分類:'平面路段',長度:1000,巷:'1巷',弄:''}]);
 const ra=ensureRA();log('① 道路歸類：',names.map((nm,i)=>nm+'→'+CLS_LABEL[ra.cls[S.adjEid.indexOf(String(i))]]).join('｜'));
 log('   通行矩陣（✓可行 ✗禁止）　　'+names.map(n=>n.slice(0,5)).join('  '));
 for(const key of Object.keys(VEHICLES)){const V=ensureVeh(key);log('   '+VEHICLES[key].label.padEnd(6,'　')+names.map((nm,i)=>V.forb[S.adjEid.indexOf(String(i))]?'  ✗   ':'  ✓   ').join('   '));}
 log('   速限顯示：',names.slice(2).map((nm,i)=>nm+' '+speedText(S.adjEid.indexOf(String(i+2)))).join('｜'));
 const k74=S.adjEid.indexOf('3'),kGen=S.adjEid.indexOf('4'),kBike=S.adjEid.indexOf('0');
 log('   1000 m 路段的行駛時間（秒）：快速道路(限80) 汽車',(1000/(ensureVeh('car').spd[k74]/3.6)).toFixed(0),'重機',(1000/(ensureVeh('heavy').spd[k74]/3.6)).toFixed(0),'｜一般路(限50) 汽車',(1000/(ensureVeh('car').spd[kGen]/3.6)).toFixed(0),'一般機車(上限50)',(1000/(ensureVeh('moto').spd[kGen]/3.6)).toFixed(0),'腳踏車(上限18)',(1000/(ensureVeh('bike').spd[kGen]/3.6)).toFixed(0),'｜腳踏車走自行車道',(1000/(ensureVeh('bike').spd[kBike]/3.6)).toFixed(0));}
// ===== ② 三條平行路線：快速道路 / 一般道路 / 自行車道 =====
{const nodes=[{id:'S',...P(0,0)},{id:'T',...P(3000,0)}],edges=[],roads={};let eid=0;const add=(a,b,w,nm)=>{edges.push({from:a,to:b,w,edgeId:eid});(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(eid++);};
 const path=(pre,nm,y,len,n)=>{let prev='S';for(let i=1;i<n;i++){const id=pre+i;nodes.push({id,...P(3000*i/n,y)});add(prev,id,len,nm);prev=id;}add(prev,'T',len,nm);};
 path('X','台74線快速道路',300,1000,3);path('L','一般路',-300,1000,4);path('B','潭雅神自行車道',600,1100,3);
 buildGraph({nodes,edges,roads});loadRoadTable([{路名:'台74線快速道路',路寬:20,速限:80,道路型態分類:'平面路段',長度:3000,巷:'',弄:''},{路名:'一般路',路寬:10,速限:40,道路型態分類:'平面路段',長度:4000,巷:'',弄:''},{路名:'潭雅神自行車道',路寬:5,道路型態分類:'自行車專用道',長度:3300,巷:'',弄:''}]);
 const sIdx=S.nodeIds.indexOf('S'),tIdx=S.nodeIds.indexOf('T');
 log('② 起終點 3 公里，三條路：快速道路 3 km（限80）／一般路 4 km（限40）／自行車道 3.3 km');
 for(const [key,pref] of [['car','fast'],['heavy','fast'],['moto','fast'],['bike','fast'],['bike','safe'],['car','short']]){el('mode').value=key;el('pref').value=pref;S.planCache.clear();
   const rs=planAll(sIdx,tIdx,'');const it=rs.find(x=>x.key==='pref')||rs[0];const best=rs.find(x=>x.key==='fastest');
   log(`   ${VEHICLES[key].label.padEnd(5,'　')} 偏好=${pref.padEnd(5)} → 「依偏好」走 ${it.route?it.seq.join('+'):it.msg}｜「最快」走 ${best.route?best.seq.join('+'):best.msg}（${best.route?best.min.toFixed(1):'-'} 分）`);}}
// ===== ③ 廣義成本下 A*／ALT 是否仍然最優（300×300 格網，隨機速限）=====
{let seed=3;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;const n=300,id=(i,j)=>`g${i}_${j}`,nodes=[],edges=[],roads={};let eid=0;const lim=[30,40,50,60,70];
 for(let i=0;i<n;i++)for(let j=0;j<n;j++)nodes.push({id:id(i,j),...P(i*100,j*100)});
 const add=(a,b)=>{const L=lim[Math.floor(rnd()*5)],nm='R'+L;edges.push({from:a,to:b,w:100*(1+rnd()*0.3),edgeId:eid});(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(eid++);};
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){if(i<n-1)add(id(i,j),id(i+1,j));if(j<n-1)add(id(i,j),id(i,j+1));}
 buildGraph({nodes,edges,roads});loadRoadTable(lim.map(L=>({路名:'R'+L,路寬:10,速限:L,道路型態分類:'平面路段',長度:100,巷:'',弄:''})));
 const ix=(i,j)=>S.nodeIds.indexOf(id(i,j));const pairs=[];for(let q=0;q<25;q++)pairs.push([ix(Math.floor(rnd()*80),Math.floor(rnd()*80)),ix(220+Math.floor(rnd()*80),220+Math.floor(rnd()*80))]);
 log('③ 廣義成本（車種=汽車，α=1 β=0.5 δ=0.5）：',S.N.toLocaleString(),'節點，25 組長距離');
 for(const [key,pref] of [['car',{a:1,b:0,d:0}],['car',{a:1,b:0.5,d:0.5}],['bike',{a:1,b:0.3,d:2}],['moto',{a:0.5,b:1,d:1}]]){
   const {fn,mper}=makeCost(key,pref);let bad=0,exD=0,exE=0,exA=0,tD=0,tE=0,tA=0;
   const alt=buildLandmarks(key+JSON.stringify(pref),fn);
   for(const [s,t] of pairs){let t0=performance.now();const r0=spSearch(s,t,fn,()=>0);tD+=performance.now()-t0;exD+=S.lastExpanded;
     const hE=makeHeuristic(t,mper,null);t0=performance.now();const r1=spSearch(s,t,fn,hE);tE+=performance.now()-t0;exE+=S.lastExpanded;
     const hA=makeHeuristic(t,mper,alt);t0=performance.now();const r2=spSearch(s,t,fn,hA);tA+=performance.now()-t0;exA+=S.lastExpanded;
     const rd=dijkstra(s,t,fn);
     if(!r0||!r1||!r2||!rd||Math.abs(r1.cost-r0.cost)>1e-6*r0.cost||Math.abs(r2.cost-r0.cost)>1e-6*r0.cost||Math.abs(rd.cost-r0.cost)>1e-6*r0.cost)bad++;}
   const q=pairs.length;log(`   ${VEHICLES[key].label} α${pref.a} β${pref.b} δ${pref.d}：成本不一致 ${bad} 組｜平均展開節點 Dijkstra ${Math.round(exD/q).toLocaleString()} → 歐氏 A* ${Math.round(exE/q).toLocaleString()} → ALT A* ${Math.round(exA/q).toLocaleString()}｜平均 ms ${(tD/q).toFixed(0)} / ${(tE/q).toFixed(0)} / ${(tA/q).toFixed(0)}`);}
 log('   ALT 預處理（每組成本函式各一次）：',S.alt.lm.length,'個地標，',Math.round(S.alt.ms),'ms');
 // ===== ④ 快取 =====
 el('mode').value='car';el('pref').value='balanced';S.planCache.clear();const s0=pairs[0][0],t0=pairs[0][1];
 let a=performance.now();const r1=planAll(s0,t0,'');const t1=performance.now()-a;r1[0].visible=false;a=performance.now();const r2=planAll(s0,t0,'');const t2=performance.now()-a;
 log(`④ 快取：第一次 ${t1.toFixed(0)} ms → 第二次 ${t2.toFixed(2)} ms｜同一份結果=${r1===r2}｜被隱藏的路線已恢復顯示=${r2[0].visible}`);
 el('mode').value='bike';const r3=planAll(s0,t0,'');log('   換車種 → 重新計算（不是同一份）=',r3!==r2);
 el('mode').value='car';const v0=S.graphVersion;loadRoadTable(lim.map(L=>({路名:'R'+L,路寬:10,速限:L+5,道路型態分類:'平面路段',長度:100,巷:'',弄:''})));const r4=planAll(s0,t0,'');
 log('   屬性表更新 → 資料版本',v0,'→',S.graphVersion,'｜不會用到過期結果（不是同一份）=',r4!==r2);}
process.exit(0);
