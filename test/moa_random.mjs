const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',checked:false,style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){}}),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();globalThis.fetch=()=>Promise.reject(new Error('offline'));
const origInfo=console.info;console.info=()=>{};
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { lonLatToTWD97:tw }=await import('../js/geo.js');
const { loadBus }=await import('../js/transit.js');const { moaStar, critOf }=await import('../js/bus-plan.js');const { nearbyStops }=await import('../js/bus-core.js');
const { WALK_MPS, GROUP_WALK_S, BOARD_WAIT_S }=await import('../js/constants.js');
let seed=11;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
const LON=120.67,LAT=24.12,m2lon=m=>m/(111320*Math.cos(LAT*Math.PI/180));
const dm=(a,c)=>a.every((x,i)=>x<=c[i]+1e-9)&&a.some((x,i)=>x<c[i]-1e-9);
let same=0,diff=0,fronts=0,subsetOnly=0,total=0;const origLog=console.log;
for(let trial=0;trial<40;trial++){
  const nS=9+Math.floor(rnd()*4),P=[];for(let i=0;i<nS;i++)P.push([rnd()*5000,rnd()*3000]);
  const bn={},adj={};P.forEach((p,i)=>bn['S'+i]={stop_id:'S'+i,node_name:'S'+i,latitude:LAT+p[1]/110574,longitude:LON+m2lon(p[0]),...(rnd()<0.3?{station_group_id:'g'+Math.floor(i/2)}:{})});
  const nR=4+Math.floor(rnd()*3);let edges=0;
  for(let r=0;r<nR;r++){const len=3+Math.floor(rnd()*3),seq=[];while(seq.length<len){const s=Math.floor(rnd()*nS);if(!seq.includes(s))seq.push(s);}
    const speed=3+rnd()*8;for(let i=0;i<len-1;i++){const a=P[seq[i]],c=P[seq[i+1]],d=Math.hypot(a[0]-c[0],a[1]-c[1])*1.2;(adj['S'+seq[i]]=adj['S'+seq[i]]||[]).push({to:'S'+seq[i+1],distance_meters:d,route_name:'R'+r,route_uid:'u'+r,travel_times:[{run_time:Math.round(d/speed)}]});edges++;}}
  const o=P[Math.floor(rnd()*nS)],d=P[Math.floor(rnd()*nS)];const nd=x=>{const [e,n]=tw(LON+m2lon(x[0]+20),LAT+(x[1]+20)/110574);return{x:Math.round(e*100),y:Math.round(n*100)}};
  buildGraph({nodes:[{id:'o',...nd(o)},{id:'d',...nd(d)}],edges:[{from:'o',to:'d',w:9000,edgeId:'e'}],roads:{}});
  try{loadBus({nodes:bn,adjacency:adj});}catch(e){continue;}
  const b=S.bus;if(!b)continue;const fx=S.nodeXY[2],fy=S.nodeXY[3],tx=S.nodeXY[5+2],ty=S.nodeXY[5+3];
  const Sx=nearbyStops(fx,fy,6,500,'out'),Tx=nearbyStops(tx,ty,6,500,'in');if(!Sx.length||!Tx.length)continue;
  const twm=new Map(Tx.map(t=>[t.i,t.dm])),all=[],GW=GROUP_WALK_S*WALK_MPS;
  const dfs=(e,c,used)=>{const v=b.eTo[e];if(twm.has(v)){const wd=twm.get(v);all.push([c[0]+wd/WALK_MPS,c[1]+wd,c[2],c[3]]);}
    if(used>6)return;for(const u of b.group[v]>=0?b.members[b.group[v]]:[v])for(let e2=b.off[u];e2<b.off[u+1];e2++){const sm=u===v&&b.eRoute[e2]===b.eRoute[e],w2=sm?0:BOARD_WAIT_S;dfs(e2,[c[0]+(u===v?0:GROUP_WALK_S)+w2+b.eTime[e2],c[1]+(u===v?0:GW),c[2]+(sm?0:1),c[3]+w2],used+1);}};
  for(const s of Sx)for(let e=b.off[s.i];e<b.off[s.i+1];e++)dfs(e,[s.dm/WALK_MPS+BOARD_WAIT_S+b.eTime[e],s.dm,0,BOARD_WAIT_S],0);
  if(!all.length)continue;total++;
  const tmin=Math.min(...all.map(x=>x[0])),lim=tmin*1.8+600,pool=all.filter(x=>x[0]<=lim);          // MOA* 設計上不輸出比最快慢 1.8 倍以上的行程
  const front=pool.filter(c=>!pool.some(x=>dm(x,c)));const fk=new Set(front.map(c=>c.map(Math.round).join(',')));
  const ex=moaStar(fx,fy,tx,ty,{eps:0,cap:2000,maxPops:200000});const gk=new Set(ex.map(x=>{const c=critOf(x);return [c.time,c.walk,c.transfers,c.wait].map(Math.round).join(',');}));
  fronts+=fk.size;const eq=fk.size===gk.size&&[...fk].every(k=>gk.has(k));if(eq)same++;else{diff++;if(diff<=3)origLog('   不一致 trial',trial,'暴力',[...fk].join(' | '),'｜MOA*',[...gk].join(' | '));}
}
console.log(`隨機路網 ${total} 組（每組 9～12 站、4～6 條路線、含站群）：MOA*(eps=0) 與暴力枚舉的 Pareto 前沿完全相同 ${same} 組，不同 ${diff} 組｜前沿點數合計 ${fronts}`);
process.exit(0);
