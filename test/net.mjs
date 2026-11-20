// 以本機 HTTP 伺服器測試 TDX 連線層（不是 stub）：token 驗證、錯誤分階段、Proxy、CORS 預檢、token 過期重試
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
const els={};const el=id=>els[id]||(els[id]={id,innerHTML:'',textContent:'',value:'',style:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},appendChild(){}});
const svgS={clientWidth:800,clientHeight:600,classList:{add(){},remove(){}},addEventListener(){},getBoundingClientRect:()=>({left:0,top:0}),set innerHTML(v){},insertAdjacentHTML(){},appendChild(){}};
globalThis.document={addEventListener(){},querySelector:()=>null,documentElement:{dataset:{}},body:{classList:{add(){},remove(){}}},getElementById:id=>id==='routeSvg'?svgS:el(id),createElementNS:()=>({setAttribute(){}}),createElement:()=>el('x')};globalThis.window={addEventListener(){}};globalThis.requestAnimationFrame=f=>f();
const realFetch=globalThis.fetch;globalThis.fetch=(u,o)=>String(u).startsWith('http://127.0.0.1')?realFetch(u,o):Promise.reject(new Error('offline'));
await import('../js/main.js');
const { State }=await import('../js/state.js');const { TDX, tdxGet, tdxDiagnose, describeTdxError, tdxGetToken }=await import('../js/tdx.js');
const JWT='eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl';
let mode='ok',short=false,tokenCalls=0,apiCalls=0,expired=false;
const mock=http.createServer((req,res)=>{
  if(req.url==='/tokens'){tokenCalls++;if(mode==='tokenbug'){res.writeHead(200);return res.end('ReferenceError: req is not defined');}   // 使用者遇到的情況
    if(mode==='token500'){res.writeHead(500);return res.end('boom');}
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({access_token:short?'abc123':JWT+tokenCalls,expires_in:3600}));}
  if(req.url.startsWith('/v2/Bus/')){apiCalls++;
    if(mode==='expire'&&!expired){expired=true;res.writeHead(401);return res.end();}
    if(!req.headers.authorization){res.writeHead(401);return res.end();}
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify([{StopUID:'TXG1',RouteName:{Zh_tw:'307'}}]));}
  res.writeHead(404);res.end();});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));const MP=mock.address().port,M=`http://127.0.0.1:${MP}`;
const log=(...a)=>console.log(...a);
Object.assign(TDX,{tokenUrl:M+'/tokens',apiKey:'K',base:M+'/v2/Bus',retries:0,backoffMs:1,proxy:''});
// 1) 正常
let r=await tdxGet('EstimatedTimeOfArrival','307');log('① 正常：',r.length,'筆｜token 請求',tokenCalls,'次');
// 2) 使用者的情況：token 端點回「req is not defined」
State.tdxToken={value:null,exp:0};mode='tokenbug';
try{await tdxGet('EstimatedTimeOfArrival','307');log('✗ 應該要失敗');}catch(e){log('② token 端點噴錯誤文字 →',e.kind,'｜',describeTdxError(e).slice(0,90));}
// 3) token 端點 500
mode='token500';State.tdxToken={value:null,exp:0};try{await tdxGet('EstimatedTimeOfArrival','307');}catch(e){log('③ token 端點 HTTP 500 →',e.kind,e.status,'｜',describeTdxError(e));}
// 4) 連不上（關掉的埠）→ 分階段
Object.assign(TDX,{tokenUrl:'http://127.0.0.1:1/tokens'});State.tdxToken={value:null,exp:0};try{await tdxGet('EstimatedTimeOfArrival','307');}catch(e){log('④ token 端點連不上 →',e.kind,'｜',describeTdxError(e).slice(0,70));}
Object.assign(TDX,{tokenUrl:M+'/tokens',base:'http://127.0.0.1:1/v2/Bus'});mode='ok';State.tdxToken={value:null,exp:0};try{await tdxGet('EstimatedTimeOfArrival','307');}catch(e){log('⑤ 資料網址連不上（token 正常）→',e.kind,'｜',describeTdxError(e).slice(0,70));}
Object.assign(TDX,{base:M+'/v2/Bus'});
// 5b) 較短的不透明 token（端點格式未知）也必須可用
short=true;State.tdxToken={value:null,exp:0};r=await tdxGet('EstimatedTimeOfArrival','307');log('⑤b 短 token（6 字元，非 JWT）仍可使用：',r.length,'筆');short=false;
// 6) token 過期（401）→ 換新再試
mode='expire';expired=false;TDX.retries=2;State.tdxToken={value:null,exp:0};tokenCalls=0;r=await tdxGet('EstimatedTimeOfArrival','307');log('⑥ 401 後自動換新 token 並成功：',r.length,'筆｜token 請求',tokenCalls,'次');TDX.retries=0;mode='ok';
// 7) 連線測試
State.tdxToken={value:null,exp:0};let d=await tdxDiagnose();log('⑦ 連線測試（正常）：',d.map(x=>(x.ok?'✅':'❌')+x.name+' '+x.detail).join(' ｜ '));
mode='tokenbug';State.tdxToken={value:null,exp:0};d=await tdxDiagnose();log('   連線測試（token 端點出錯）：',d.map(x=>(x.ok?'✅':'❌')+x.name+' '+x.detail.slice(0,60)).join(' ｜ '));mode='ok';
// 8) Proxy：真的啟動 proxy.mjs，指向 mock
const px=spawn('node',['proxy.mjs'],{env:{...process.env,TOKEN_URL:M+'/tokens',API_KEY:'K',PORT:'0',UPSTREAM:M+'/v2'},cwd:fileURLToPath(new URL('..',import.meta.url))});
const PP=await new Promise((ok,bad)=>{px.stdout.on('data',d=>{const m=/:(\d+)\s+→/.exec(String(d));if(m)ok(+m[1]);});px.stderr.on('data',d=>bad(new Error(String(d))));setTimeout(()=>bad(new Error('proxy 沒有啟動')),4000);});
const PX=`http://127.0.0.1:${PP}`;
const pre=await realFetch(PX+'/api/Bus/EstimatedTimeOfArrival/City/Taichung/307',{method:'OPTIONS'});log('⑧ Proxy CORS 預檢：',pre.status,'｜Access-Control-Allow-Origin =',pre.headers.get('access-control-allow-origin'));
Object.assign(TDX,{proxy:PX,apiKey:''});apiCalls=0;tokenCalls=0;r=await tdxGet('EstimatedTimeOfArrival','307');log('   透過 Proxy（頁面不需金鑰）：',r.length,'筆｜token 由 proxy 取得',tokenCalls,'次，且瀏覽器端沒有送出 Authorization');
mode='tokenbug';px.kill();const px2=spawn('node',['proxy.mjs'],{env:{...process.env,TOKEN_URL:M+'/tokens',API_KEY:'K',PORT:'0',UPSTREAM:M+'/v2'},cwd:fileURLToPath(new URL('..',import.meta.url))});
const PP2=await new Promise(ok=>px2.stdout.on('data',d=>{const m=/:(\d+)\s+→/.exec(String(d));if(m)ok(+m[1]);}));Object.assign(TDX,{proxy:`http://127.0.0.1:${PP2}`});
try{await tdxGet('EstimatedTimeOfArrival','307');}catch(e){log('⑨ Proxy 遇到 token 端點出錯 →',e.kind,e.status,'｜',describeTdxError(e).slice(0,110));}
px2.kill();mock.close();process.exit(0);
