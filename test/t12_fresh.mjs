// 端對端測試（Node，無任何依賴）：以 DOM stub 載入真正的模組，驗證拆分後的行為
const els={};
const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:false,children:[],style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},H:{},addEventListener(n,f){this.H[n]=f}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){},contains:()=>false},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){},getAttribute(){}}),createElement:()=>el('x')};
globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();
let FETCH=()=>Promise.reject(new Error('offline'));globalThis.fetch=(...a)=>FETCH(...a);
const log=(...a)=>console.log(...a);
const M=await import('../js/main.js');
const { State:S }=await import('../js/state.js');
const { buildGraph }=await import('../js/loader.js');
const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { planAll }=await import('../js/planners.js');
const { loadRoadTable }=await import('../js/road-attrs.js');
const LON=120.67,LAT=24.12;
// ================= t12：候選路線（公車模式）=================
{const n=12,id=(i,j)=>`r${i}_${j}`,nodes=[],edges=[];let eid=0;for(let i=0;i<n;i++)for(let j=0;j<n;j++){const [e,nn]=tw(LON+i*0.001,LAT+j*0.001);nodes.push({id:id(i,j),x:Math.round(e*100),y:Math.round(nn*100)});}
 const nameOf=j=>j===3?'潭雅神自行車道':j===2?'小巷':j===5?'中港路':'一般路'+j,roads={};const add=(nm,e)=>{(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(e);};
 for(let i=0;i<n;i++)for(let j=0;j<n;j++){if(i<n-1){const e=eid++;edges.push({from:id(i,j),to:id(i+1,j),w:100,edgeId:e});add(nameOf(j),e);}if(j<n-1){const e=eid++;edges.push({from:id(i,j),to:id(i,j+1),w:100,edgeId:e});add('縱路',e);}}
 buildGraph({nodes,edges,roads});const rows=[{路名:'小巷',路寬:4,道路型態分類:'平面路段',長度:1100,巷:'',弄:''},{路名:'中港路',路寬:30,道路型態分類:'平面路段',長度:1100,巷:'',弄:''},{路名:'縱路',路寬:10,道路型態分類:'平面路段',長度:100,巷:'',弄:''},{路名:'潭雅神自行車道',路寬:5,道路型態分類:'自行車專用道',長度:1100,巷:'',弄:''}];
 for(let j=0;j<n;j++)if(![2,3,5].includes(j))rows.push({路名:'一般路'+j,路寬:10,道路型態分類:'平面路段',長度:1100,巷:'',弄:''});loadRoadTable(rows);
 el('opsMode').checked=true;el('avoidToll').checked=false;el('mode').value='car';el('goal').value='compare';for(const [k,v] of Object.entries({w_suit:35,w_ub:20,w_dist:20,w_turn:10,w_bus:15}))el(k).value=String(v);
 const ix=(i,j)=>S.nodeIds.indexOf(id(i,j)),rs=planAll(ix(0,2),ix(11,2),'');
 for(const it of rs)log('T12',it.label,it.route?`${Math.round(it.route.distance)}m 轉彎${it.turns} 適宜${Math.round(it.met.suit)} 總分${Math.round(it.score.total)}${it.score.best?' ⭐':''}`:it.msg);}
process.exit(0);
