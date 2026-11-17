// 階段 1：交通方式／目標／步行／避開國道／時間成本 Yen 與 Pareto／大眾運輸目標
const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:false,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){}}),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();globalThis.fetch=()=>Promise.reject(new Error('offline'));
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadRoadTable }=await import('../js/road-attrs.js');const { ensureVeh, makeCost, getMode, getVehicleKey, tollLength, routeTimeS }=await import('../js/vehicle.js');
const { planAll }=await import('../js/planners.js');const { yenK, labelSetting }=await import('../js/router-multi.js');const { makeHeuristic, spSearch }=await import('../js/router.js');
const { syncControls }=await import('../js/ui-events.js');const { pickRecommended }=await import('../js/bus-plan.js');const { PREFS }=await import('../js/vehicle.js');
let fails=0;const ok=(name,c,extra='')=>{console.log((c?'  ✓ ':'  ✗ ')+name+(extra?'｜'+extra:''));if(!c)fails++;};
const set=(m,g='compare',o={})=>{el('mode').value=m;el('goal').value=g;el('opsMode').checked=!!o.ops;el('avoidToll').checked=!!o.toll;el('pref').value='balanced';el('prefA').value='1';el('prefB').value='0.5';el('prefD').value='0.5';el('ubR').value='300';el('kPaths').value=String(o.k||5);el('avoid').value='';S.planCache.clear();};
for(const [k,v] of Object.entries({w_suit:35,w_ub:20,w_dist:20,w_turn:10,w_bus:15}))el(k).value=String(v);
const LON=120.67,LAT=24.12,m2lon=m=>m/(111320*Math.cos(LAT*Math.PI/180)),m2lat=m=>m/110574;
const P=(xm,ym)=>{const [e,n]=tw(LON+m2lon(xm),LAT+m2lat(ym));return{x:Math.round(e*100),y:Math.round(n*100)}};

// ===== ① 步行規則 + 避開國道 =====
console.log('① 步行規則、避開國道（收費）');
{const nodes=[{id:'S',...P(0,0)},{id:'T',...P(3000,0)}],edges=[],roads={};let eid=0;const add=(a,b,w,nm)=>{edges.push({from:a,to:b,w,edgeId:eid});(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(eid++);};
 const path=(pre,nm,y,len,n)=>{let prev='S';for(let i=1;i<n;i++){const id=pre+i;nodes.push({id,...P(3000*i/n,y)});add(prev,id,len,nm);prev=id;}add(prev,'T',len,nm);};
 path('X','國道一號',300,1000,3);path('L','一般路',-300,1000,4);path('B','潭雅神自行車道',600,1100,3);
 buildGraph({nodes,edges,roads});loadRoadTable([{路名:'國道一號',路寬:20,速限:100,道路型態分類:'平面路段',長度:3000,巷:'',弄:''},{路名:'一般路',路寬:10,速限:40,道路型態分類:'平面路段',長度:4000,巷:'',弄:''},{路名:'潭雅神自行車道',路寬:5,道路型態分類:'自行車專用道',長度:3300,巷:'',弄:''}]);
 const s=S.nodeIds.indexOf('S'),t=S.nodeIds.indexOf('T'),kOf=n=>S.adjEid.findIndex((e,k)=>roads[n].edgeIds.map(String).includes(String(e)));
 const kFw=kOf('國道一號'),kBk=kOf('潭雅神自行車道'),kGn=kOf('一般路');
 const W=ensureVeh('walk'),C=ensureVeh('car');
 ok('步行：禁走國道，可走自行車道、一般路',W.forb[kFw]===1&&W.forb[kBk]===0&&W.forb[kGn]===0);
 ok('汽車：禁走自行車道，可走國道',C.forb[kBk]===1&&C.forb[kFw]===0);
 ok('步行速度固定 ≤ 4.4 km/h（不受速限影響）',Math.max(...[kFw,kBk,kGn].map(k=>W.spd[k]))<=4.33);
 set('walk');let rs=planAll(s,t,'');let f=rs.find(x=>x.key==='fastest');
 ok('步行最快：走自行車道（3.3 km）且不含國道',f.route&&Math.abs(f.route.distance-3300)<1&&f.toll===0,`${(f.route.distance/1000).toFixed(1)} km，${f.min.toFixed(1)} 分`);
 ok('步行時間 = 距離 ÷ 1.2 m/s',Math.abs(f.min-3300/1.2/60)<0.5);
 ok('一般導航的候選全部標為 plain（不顯示 YouBike／適宜性）',rs.every(x=>x.plain)&&rs.every(x=>!x.route||x.route._plain));
 set('car');rs=planAll(s,t,'');f=rs.find(x=>x.key==='fastest');
 ok('汽車最快：走國道（3 km）並標示收費長度',f.route.distance===3000&&Math.abs(f.toll-3000)<1,`toll ${f.toll} m`);
 set('car','compare',{toll:true});rs=planAll(s,t,'');f=rs.find(x=>x.key==='fastest');
 ok('勾選「避開國道」：改走一般路（4 km）、收費長度 0',f.route.distance===4000&&f.toll===0&&tollLength(f.route)===0);
 const cached=planAll(s,t,'');set('car','compare',{toll:false});const rs2=planAll(s,t,'');
 ok('避開國道會進快取鍵（切換後不會拿到舊結果）',rs2!==cached&&rs2.find(x=>x.key==='fastest').route.distance===3000);
 set('heavy','compare',{toll:true});ok('重機：本來就禁走國道，避開國道選項不影響（getVehicleKey=heavy）',getVehicleKey()==='heavy'&&planAll(s,t,'').find(x=>x.key==='fastest').route.distance===4000);
 // 只有國道可走時，避開國道要誠實回報找不到
 const nodes2=[{id:'S',...P(0,0)},{id:'T',...P(2000,0)}];buildGraph({nodes:nodes2,edges:[{from:'S',to:'T',w:2000,edgeId:0}],roads:{'國道一號':{segments:1,totalLength:2000,edgeIds:[0]}}});
 loadRoadTable([{路名:'國道一號',路寬:20,速限:100,道路型態分類:'平面路段',長度:2000,巷:'',弄:''}]);
 set('car','compare',{toll:true});rs=planAll(S.nodeIds.indexOf('S'),S.nodeIds.indexOf('T'),'');f=rs.find(x=>x.key==='fastest');
 ok('唯一道路是國道時：避開國道 → 回報找不到路線，不偷走國道',!f.route&&/國道/.test(f.msg),f.msg);
}

// ===== ② 隨機路網：時間成本的 Yen K 與 Pareto 對照暴力枚舉 =====
console.log('② 隨機路網（時間成本）Yen 與 Pareto 對照暴力枚舉');
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;};}
function enumerate(s,t,fnTime,crit){const out=[];const vis=new Uint8Array(S.N);const rec=(u,cs,ep)=>{if(u===t){out.push({c:cs,ep:ep.slice()});return;}vis[u]=1;for(let k=S.adjOffset[u];k<S.adjOffset[u+1];k++){const v=S.adjTo[k];if(vis[v])continue;if(fnTime(S.adjEid[k],S.adjW[k],k)===Infinity)continue;const ci=crit(k);ep.push(k);rec(v,[cs[0]+ci[0],cs[1]+ci[1],cs[2]+ci[2]],ep);ep.pop();}vis[u]=0;};rec(s,[0,0,0],[]);return out;}
let yenBad=0,yenN=0,parBad=0,parN=0;
for(const vkey of ['car','bike']){for(let seed=1;seed<=12;seed++){
  const R=rng(seed*7919+(vkey==='bike'?1:0)),n=9,pts=[...Array(n)].map(()=>[R()*2000,R()*2000]),nodes=pts.map((p,i)=>({id:'n'+i,...P(p[0],p[1])})),edges=[],roads={};let eid=0;const lims=[30,50,70],names=['A','B','C'];
  for(const nm of names)roads[nm]={segments:0,totalLength:0,edgeIds:[]};
  const addE=(a,b)=>{const d=Math.hypot(pts[a][0]-pts[b][0],pts[a][1]-pts[b][1]),w=Math.round(d*(1+0.5*R())+1),nm=names[Math.floor(R()*3)];for(const [x,y] of [[a,b],[b,a]]){edges.push({from:'n'+x,to:'n'+y,w,edgeId:eid});roads[nm].edgeIds.push(eid++);}};
  for(let i=1;i<n;i++)addE(i,Math.floor(R()*i));for(let q=0;q<7;q++){const a=Math.floor(R()*n),b=Math.floor(R()*n);if(a!==b)addE(a,b);}
  buildGraph({nodes,edges,roads});loadRoadTable(names.map((nm,i)=>({路名:nm,路寬:10,速限:lims[i],道路型態分類:'平面路段',長度:1000,巷:'',弄:''})));
  set(vkey);const V=ensureVeh(vkey),{fn,mper}=makeCost(vkey,PREFS.fast,false,false),s=0,t=n-1,tm=k=>S.adjW[k]/(V.spd[k]/3.6),crit=k=>[tm(k),S.adjW[k],S.adjW[k]*V.risk[k]];
  const all=enumerate(s,t,fn,crit);if(!all.length)continue;
  // Yen（關閉重疊過濾，才能和「第 K 小的簡單路徑」比較）
  const K=Math.min(5,all.length),want=all.map(x=>x.c[0]).sort((a,b)=>a-b).slice(0,K),hf=makeHeuristic(t,mper,null),got=yenK(s,t,fn,K,1000,2,hf).map(r=>r.cost);
  yenN++;if(got.length!==want.length||got.some((c,i)=>Math.abs(c-want[i])>1e-6*(1+want[i])))yenBad++;
  // Pareto：回傳的每條都必須在暴力前沿上，且三個準則的最小值都要找到
  const dom=(a,b)=>a[0]<=b[0]+1e-9&&a[1]<=b[1]+1e-9&&a[2]<=b[2]+1e-9&&(a[0]<b[0]-1e-9||a[1]<b[1]-1e-9||a[2]<b[2]-1e-9);
  const front=all.filter(x=>!all.some(y=>dom(y.c,x.c))),rs=labelSetting(s,t,fn,{eps:0,maxLab:1000,bound:100,crit,hf,h0:hf});parN++;
  const onFront=rs.every(r=>front.some(x=>x.c.every((v,i)=>Math.abs(v-r.crit[i])<1e-6*(1+v)))),mins=[0,1,2].every(d=>Math.abs(Math.min(...rs.map(r=>r.crit[d]))-Math.min(...all.map(x=>x.c[d])))<1e-6*(1+Math.min(...all.map(x=>x.c[d]))));
  if(!(onFront&&mins&&rs.length))parBad++;
}}
ok(`Yen K（時間成本）與暴力枚舉的前 K 小簡單路徑成本一致`,yenBad===0,`${yenN} 組，不同 ${yenBad}`);
ok(`Pareto 結果都在暴力前沿上，且三項準則極值都找到`,parBad===0,`${parN} 組，不同 ${parBad}`);

// ===== ③ 目標分派 =====
console.log('③ 目標分派');
{const nodes=[{id:'S',...P(0,0)},{id:'T',...P(3000,0)}],edges=[],roads={};let eid=0;const add=(a,b,w,nm)=>{edges.push({from:a,to:b,w,edgeId:eid});(roads[nm]=roads[nm]||{segments:0,totalLength:0,edgeIds:[]}).edgeIds.push(eid++);};
 const path=(pre,nm,y,len,n)=>{let prev='S';for(let i=1;i<n;i++){const id=pre+i;nodes.push({id,...P(3000*i/n,y)});add(prev,id,len,nm);prev=id;}add(prev,'T',len,nm);};
 path('X','台74線快速道路',300,1000,3);path('L','一般路',-300,1000,4);path('M','中港路',0,1100,4);
 buildGraph({nodes,edges,roads});loadRoadTable([{路名:'台74線快速道路',路寬:20,速限:80,道路型態分類:'平面路段',長度:3000,巷:'',弄:''},{路名:'一般路',路寬:10,速限:40,道路型態分類:'平面路段',長度:4000,巷:'',弄:''},{路名:'中港路',路寬:12,速限:50,道路型態分類:'平面路段',長度:4400,巷:'',弄:''}]);
 const s=S.nodeIds.indexOf('S'),t=S.nodeIds.indexOf('T');
 set('car','compare');let rs=planAll(s,t,'');ok('compare：最短／最快／依偏好（沒輸入避開道路 → 不出現「避開」）',['shortest','fastest','pref'].every(k=>rs.some(x=>x.key===k))&&!rs.some(x=>x.key==='avoid'));
 el('avoid').value='一般路';S.planCache.clear();rs=planAll(s,t,'一般路');ok('輸入避開道路 → 出現「避開」且不經過該路',rs.some(x=>x.key==='avoid'&&x.route&&x.seq&&!x.seq.includes('一般路')));
 set('car','alt');rs=planAll(s,t,'');ok('alt：Yen 多條替代路線，第 1 條是最快，全部 plain',rs.length>=2&&rs[0].label.includes('最快')&&rs.every(x=>x.plain)&&rs.slice(1).every(x=>x.min>=rs[0].min-1e-6),rs.map(x=>x.min.toFixed(1)).join('/')+' 分');
 set('car','pareto');rs=planAll(s,t,'');ok('pareto：時間最短排第 1，且每條都有備註',rs[0].label==='時間最短'&&rs.every(x=>!x.route||x.note));
 set('car','compare',{ops:true});rs=planAll(s,t,'');ok('營運規劃（opsMode）：改走公車多目標候選',rs.some(x=>x.key==='b_short')&&getVehicleKey()==='bus');
 set('transit');ok('大眾運輸：不產生道路候選',planAll(s,t,'').length===0&&getMode()==='transit');
}

// ===== ④ 大眾運輸目標推薦 =====
console.log('④ 大眾運輸目標');
{const o=[{sec:1000,transfers:1,crit:{walk:100},pareto:true},{sec:1200,transfers:0,crit:{walk:300},pareto:true},{sec:1500,transfers:2,crit:{walk:10},pareto:true},{sec:2000,transfers:2,crit:{walk:500},pareto:false}];
 ok('fastest → 總時間最短（#0）',pickRecommended(o,'fastest')===0);ok('fewer → 轉乘最少（#1）',pickRecommended(o,'fewer')===1);ok('lesswalk → 步行最短（#2）',pickRecommended(o,'lesswalk')===2);
 ok('pareto → 只在 Pareto 最優中取最快（#0）',pickRecommended(o,'pareto')===0);
 ok('同分比較：轉乘一樣多取較快者',pickRecommended([{sec:900,transfers:1,crit:{walk:5}},{sec:800,transfers:1,crit:{walk:5}}],'fewer')===1);
 ok('沒有方案／錯誤 → -1',pickRecommended([],'fastest')===-1&&pickRecommended([{error:'x'}],'fastest')===-1);
}

// ===== ⑤ 控制項同步 =====
console.log('⑤ 控制項同步');
{set('car');el('goal').dataset.kind='';syncControls();const n1=(el('goal').innerHTML.match(/<option/g)||[]).length;
 ok('汽車：3 個道路目標，顯示「避開國道」與「避開道路」，隱藏大眾運輸區',n1===3&&el('tollRow').style.display===''&&el('roadOnly').style.display===''&&el('transitOnly').style.display==='none');
 set('heavy');syncControls();ok('重機：隱藏「避開國道」（本來就不能走國道）',el('tollRow').style.display==='none');
 set('transit');syncControls();const n2=(el('goal').innerHTML.match(/<option/g)||[]).length;
 ok('大眾運輸：4 個目標，隱藏避開道路、顯示出發時間與時刻表',n2===4&&el('roadOnly').style.display==='none'&&el('transitOnly').style.display===''&&el('goal').value==='fastest');
 set('walk');syncControls();ok('步行：回到道路目標，提示文字含「步行」',el('goal').dataset.kind==='road'&&/4\.3/.test(el('modeHint').textContent));
}
console.log(fails?`\n✗ ${fails} 項失敗`:'\n全部通過');process.exit(fails?1:0);
