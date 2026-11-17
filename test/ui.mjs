// 事件綁定測試：拖曳、縮放、雙擊、點擊選點（這些是原本的「頂層副作用語句」，拆成 init() 後最容易出問題）
const els={},H={};
const el=id=>els[id]||(els[id]={appendChild(){},removeChild(){},id,innerHTML:'',textContent:'',value:'',checked:false,children:[],style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},H:{},addEventListener(n,f){this.H[n]=f}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){},contains:()=>false},addEventListener(n,f){(H[n]=H[n]||[]).push(f)},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){},getAttribute(){}}),createElement:()=>el('x')};
globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();globalThis.fetch=()=>Promise.reject(new Error('offline'));
await import('../js/main.js');
const { State:S }=await import('../js/state.js');const { buildGraph }=await import('../js/loader.js');const { worldToScreen, screenToWorld }=await import('../js/render-core.js');
const fire=(n,e)=>(H[n]||[]).forEach(f=>f(e)),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const nodes=[];for(let i=0;i<60;i++){const x=21103490+i*100,y=267921562+(i%7)*80;nodes.push({id:`xy:${x},${y}`,x,y});}
buildGraph({nodes,edges:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id,w:10,edgeId:'e'+i})),roads:[]});S.loaded=true;
const [sx,sy]=worldToScreen(21103490+1000,267921562+160),[bx,by]=screenToWorld(sx,sy);
console.log('roundtrip err',Math.abs(bx-21103490-1000).toFixed(6),Math.abs(by-267921562-160).toFixed(6));
fire('mousedown',{button:0,clientX:100,clientY:100});fire('mousemove',{clientX:150,clientY:120});fire('mouseup',{clientX:150,clientY:120});await sleep(300);
console.log('drag → tx,ty',S.view.tx,S.view.ty,'| picked?',!!S.fromPoint);
const w0=screenToWorld(400,300);fire('wheel',{deltaY:-500,clientX:400,clientY:300,preventDefault(){}});const w1=screenToWorld(400,300);
console.log('zoom scale',S.view.scale.toFixed(3),'cursor-world drift',Math.hypot(w1[0]-w0[0],w1[1]-w0[1]).toFixed(6));
for(let i=0;i<30;i++)fire('wheel',{deltaY:-1000,clientX:400,clientY:300,preventDefault(){}});console.log('clamp max',S.view.scale);
fire('mousedown',{button:0,clientX:300,clientY:300});fire('mouseup',{clientX:300,clientY:300});fire('mousedown',{button:0,clientX:300,clientY:300});fire('mouseup',{clientX:300,clientY:300});fire('dblclick');await sleep(300);
console.log('dblclick view',JSON.stringify(S.view),'| picked?',!!S.fromPoint);
for(const [x,y] of [[200,300],[600,300],[400,300]]){fire('mousedown',{button:0,clientX:x,clientY:y});fire('mouseup',{clientX:x,clientY:y});await sleep(300);}
console.log('from',S.nodeIds[S.fromPoint.idx],'| to',S.nodeIds[S.toPoint.idx]);
process.exit(0);
