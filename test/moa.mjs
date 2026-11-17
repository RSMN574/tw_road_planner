// 多目標 A*（Pareto）：與暴力枚舉對照
const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:false,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){}}),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();globalThis.fetch=()=>Promise.reject(new Error('offline'));
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadBus }=await import('../js/transit.js');const { moaStar, suggestBusMulti, critOf, dominates }=await import('../js/bus-plan.js');
const { WALK_MPS, GROUP_WALK_S, BOARD_WAIT_S }=await import('../js/constants.js');
const log=(...a)=>console.log(...a);
const LON=120.67,LAT=24.12,m2lon=m=>m/(111320*Math.cos(LAT*Math.PI/180));
const pos={O1:[0,0],O2:[300,0],X:[2500,300],Y:[2500,-300],D1:[5000,0],D2:[4700,0],Yg:[2530,-300]};   // 公尺（x 向東）
const nd=(x)=>{const [e,n]=tw(LON+m2lon(x[0]),LAT+x[1]/110574);return{x:Math.round(e*100),y:Math.round(n*100)}};
buildGraph({nodes:[{id:'o',...nd(pos.O1)},{id:'d',...nd(pos.D1)}],edges:[{from:'o',to:'d',w:6000,edgeId:'e'}],roads:{}});S.fromPoint={idx:0};S.toPoint={idx:1};
const bn={};for(const k in pos)bn[k]={stop_id:k,node_name:k,latitude:LAT+pos[k][1]/110574,longitude:LON+m2lon(pos[k][0]),...(k==='Y'||k==='Yg'?{station_group_id:'G'}:{})};
const adj={};const L=(f,t,r,sec)=>(adj[f]=adj[f]||[]).push({to:t,distance_meters:2600,route_name:r,route_uid:'u'+r,travel_times:[{run_time:sec}]});
L('O1','X','R1',700);L('X','D1','R1',700);          // R1：直達（慢），1400 s，無轉乘
L('O1','Y','R2',400);L('Yg','D1','R3',400);          // R2 + R3：快，但要在 Y 轉乘（同站群步行）
L('O2','D2','R4',650);                               // R4：最快，但起終點都要多走 300 m
loadBus({nodes:bn,adjacency:adj});
const b=S.bus;const fx=S.nodeXY[0*5+2],fy=S.nodeXY[0*5+3],tx=S.nodeXY[1*5+2],ty=S.nodeXY[1*5+3];
// ===== 暴力枚舉：依同一套規則走遍所有行程，算出真正的 Pareto 前沿 =====
const { nearbyStops }=await import('../js/bus-core.js');
const Sx=nearbyStops(fx,fy,6,500,'out'),Tx=nearbyStops(tx,ty,6,500,'in'),twm=new Map(Tx.map(t=>[t.i,t.dm])),all=[];
const waitOf=r=>b.routeKind[r]==='metro'?240:BOARD_WAIT_S,GW=GROUP_WALK_S*WALK_MPS;
const dfs=(e,c,used)=>{const v=b.eTo[e];if(twm.has(v)){const wd=twm.get(v);all.push([c[0]+wd/WALK_MPS,c[1]+wd,c[2],c[3]]);}
  if(used>5)return;for(const u of b.group[v]>=0?b.members[b.group[v]]:[v]){for(let e2=b.off[u];e2<b.off[u+1];e2++){const same=u===v&&b.eRoute[e2]===b.eRoute[e],w2=same?0:waitOf(b.eRoute[e2]);
    dfs(e2,[c[0]+(u===v?0:GROUP_WALK_S)+w2+b.eTime[e2],c[1]+(u===v?0:GW),c[2]+(same?0:1),c[3]+w2],used+1);}}};
for(const s of Sx)for(let e=b.off[s.i];e<b.off[s.i+1];e++){const w=waitOf(b.eRoute[e]);dfs(e,[s.dm/WALK_MPS+w+b.eTime[e],s.dm,0,w],0);}
const dm=(a,c)=>a.every((x,i)=>x<=c[i]+1e-9)&&a.some((x,i)=>x<c[i]-1e-9);
const front=all.filter(c=>!all.some(o=>dm(o,c)));const uniq=new Map();front.forEach(c=>uniq.set(c.map(x=>Math.round(x)).join(','),c));
log(`暴力枚舉：共 ${all.length} 種行程，真實 Pareto 前沿 ${uniq.size} 種 [時間s,步行m,轉乘,候車s]`);for(const k of uniq.keys())log('   真實前沿',k);
// ===== MOA*（eps=0，不限標籤數 → 應與暴力結果相同）=====
const ex=moaStar(fx,fy,tx,ty,{eps:0,cap:1000});const key=o=>[o.sec,o.crit?.walk??0].map(Math.round);
const got=new Map();ex.forEach(o=>{const c=critOf(o);got.set([c.time,c.walk,c.transfers,c.wait].map(Math.round).join(','),o);});
log(`MOA*(eps=0)：${ex.length} 種，pops=${ex.pops}`);for(const [k,o] of got)log('   MOA*      ',k,'→',o.rides.map(r=>r.label).join('+'));
log('① 與暴力前沿完全相同 =',got.size===uniq.size&&[...uniq.keys()].every(k=>got.has(k)));
// ===== 實際使用（eps=0.02，cap=6）+ 方案清單 =====
const opts=suggestBusMulti(fx,fy,tx,ty);log('② 方案清單：');opts.forEach((o,i)=>{const c=o.crit;log(`   ${i+1}. ${o.rides.map(r=>r.label).join('+').padEnd(8)} 時間 ${Math.round(c.time/60)} 分｜步行 ${Math.round(c.walk)} m｜轉乘 ${c.transfers}｜候車 ${Math.round(c.wait/60)} 分｜${o.pareto?'Pareto':'被支配'}`);});
log('   每個 Pareto 方案都不被任何方案支配 =',opts.filter(o=>o.pareto).every(o=>!opts.some(x=>x!==o&&dominates(x.crit,o.crit))),'｜被標為被支配者都確實有人支配它 =',opts.filter(o=>!o.pareto).every(o=>opts.some(x=>dominates(x.crit,o.crit))));
process.exit(0);
