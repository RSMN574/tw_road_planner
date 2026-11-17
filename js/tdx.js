// tdx.js
import { State } from './state.js';
import { routeKindOf } from './bus-core.js';
import { BOARD_WAIT_S, GROUP_WALK_S, KIND_ETA, KIND_TT, METRO_HEADWAY_S, METRO_WAIT_S, STOP_TEXT, WALK_MPS, tdxCache, tdxInflight } from './constants.js';
import { esc, hhmm, sleep, todayStr } from './util.js';

// ============================================================
// 階段 6：TDX 即時到站（EstimatedTimeOfArrival）＋ 每日時刻表（DailyStopTimeTable）
// 三種時間來源一律分開標示：即時 ETA／預定時刻／系統推估
// ============================================================

export const TDX = { tokenUrl: 'https://rsmn574.com/tokens', apiKey: '', ts: '', base: 'https://tdx.transportdata.tw/api/basic/v2/Bus', city: 'Taichung',
  proxy: '', etaTtl: 30e3, ttTtl: 6 * 3600e3, negTtl: 15e3, staleS: 180, timeoutMs: 8000, retries: 2, backoffMs: 300 };

export class TdxError extends Error { constructor(kind, status, detail) { super(kind + (status ? ':' + status : '') + (detail ? ' — ' + detail : '')); this.kind = kind; this.status = status; this.detail = detail; } }

// 把錯誤翻成「哪一步、可能原因」：token 端點、資料網址、token 內容不對，三者處理方式完全不同
export function describeTdxError(e) {
  const d = e.detail ? `（${e.detail}）` : '';
  switch (e.kind) {
    case 'token-network': return `連不到 token 端點${d}。瀏覽器直接呼叫對方被擋下，多半是 CORS（對方沒允許本頁網域或自訂標頭 Authorization／X-Timestamp）、網址錯誤或離線；建議改用 Proxy（proxy.mjs）`;
    case 'data-network': return `連不到 TDX 資料網址${d}。多半是 CORS、離線或被擴充套件擋下；建議改用 Proxy`;
    case 'token-http': return `token 端點回應 HTTP ${e.status}${d}`;
    case 'token-format': return `token 端點回傳的內容不像 token${d}。這不是網路問題，請檢查端點本身的程式`;
    case 'proxy-http': return `Proxy 回應 HTTP ${e.status}${d}`;
    case 'auth': return '金鑰或 token 被 TDX 拒絕（HTTP 401）';
    case 'http': return `TDX 回應 HTTP ${e.status}`;
    case 'timeout': return `逾時（超過 ${TDX.timeoutMs / 1000} 秒）`;
    default: return e.message;
  }
}

export async function fetchT(url, opt = {}) { const ac = new AbortController(), t = setTimeout(() => ac.abort(), TDX.timeoutMs); try { return await fetch(url, { ...opt, signal: ac.signal }); } finally { clearTimeout(t); } }

const looksLikeToken = v => typeof v === 'string' && /^[^\s<>{}"'`]{6,}$/.test(v);       // 不含空白與 <>{}"' 等字元、至少 6 字元：只用來擋掉「把錯誤訊息當成 token」，不限制 token 的長度或格式（端點可能回傳短的不透明字串）
export function tdxGetToken(force) {
  if (!force && State.tdxToken.value && State.tdxNow() < State.tdxToken.exp) return Promise.resolve(State.tdxToken.value);
  if (State.tokenInflight) return State.tokenInflight;                                    // token 請求也合併
  State.tokenInflight = (async () => {
    let r;
    try { r = await fetchT(TDX.tokenUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + TDX.apiKey, 'X-Timestamp': TDX.ts || new Date(State.tdxNow()).toISOString() } }); }
    catch (e) { throw e.name === 'AbortError' ? new TdxError('timeout') : new TdxError('token-network', null, e.message); }
    const txt = await r.text().catch(() => '');
    if (!r.ok) throw new TdxError('token-http', r.status, txt.trim().slice(0, 120));
    let j; try { j = JSON.parse(txt); } catch (e) { j = txt.trim(); }
    const tok = typeof j === 'string' ? j : (j.access_token ?? j.token ?? j.data?.access_token ?? j.data?.token ?? (typeof j.data === 'string' ? j.data : null));
    if (!looksLikeToken(tok)) throw new TdxError('token-format', null, '收到：「' + txt.trim().slice(0, 120) + '」');   // 例如端點程式噴出的錯誤文字，不可當成 token 往下送
    const ttl = Number(j.expires_in ?? j.data?.expires_in) || 3000;           // 回應沒有 expires_in 時，保守假設 50 分鐘
    State.tdxToken = { value: tok, exp: State.tdxNow() + ttl * 900 };
    return tok;
  })().finally(() => { State.tokenInflight = null; });
  return State.tokenInflight;
}

export async function tdxGet(kind, route) {
  const useProxy = !!TDX.proxy, base = useProxy ? TDX.proxy.replace(/\/+$/, '') + '/api/Bus' : TDX.base;      // Proxy：token 由伺服器端處理，瀏覽器不需要金鑰
  const url = `${base}/${kind}/City/${TDX.city}/${encodeURIComponent(route)}?%24format=JSON`; let last;
  for (let i = 0; i <= TDX.retries; i++) {
    try {
      const tok = useProxy ? '' : await tdxGetToken(false); let r;
      try { r = await fetchT(url, { headers: useProxy ? { Accept: 'application/json' } : { Authorization: 'Bearer ' + tok, Accept: 'application/json' } }); }
      catch (e) { throw e.name === 'AbortError' ? new TdxError('timeout') : new TdxError('data-network', null, e.message); }
      if (r.status === 401 && !useProxy) { State.tdxToken = { value: null, exp: 0 }; last = new TdxError('auth', 401); continue; }   // token 失效 → 重新取得再試
      if (r.status === 404) return [];
      if (r.status === 429 || r.status >= 500) { last = new TdxError(useProxy ? 'proxy-http' : 'http', r.status, useProxy ? (await r.text().catch(() => '')).slice(0, 120) : ''); if (i < TDX.retries) await sleep(TDX.backoffMs * 2 ** i); continue; }
      if (!r.ok) throw new TdxError(useProxy ? 'proxy-http' : 'http', r.status, useProxy ? (await r.text().catch(() => '')).slice(0, 120) : '');
      const j = await r.json(); return Array.isArray(j) ? j : (j.data || j.Data || []);
    } catch (e) {
      last = e instanceof TdxError ? e : e.name === 'AbortError' ? new TdxError('timeout') : new TdxError('network', null, e.message);
      const fatal = last.kind === 'token-format' || ((last.kind === 'http' || last.kind === 'token-http' || last.kind === 'proxy-http') && last.status < 500 && last.status !== 429);
      if (fatal) throw last;                                                       // 確定性的錯誤（內容不對、4xx）不必重試
      if (i < TDX.retries) await sleep(TDX.backoffMs * 2 ** i);
    }
  }
  throw last;
}

// 連線測試：逐步檢查，告訴你卡在哪一步
export async function tdxDiagnose(route = '307') {
  const out = [], saved = TDX.retries; TDX.retries = 0;
  const step = async (name, f) => { const t0 = Date.now(); try { out.push({ name, ok: true, detail: await f(), ms: Date.now() - t0 }); return true; } catch (e) { out.push({ name, ok: false, detail: e instanceof TdxError ? describeTdxError(e) : e.message, ms: Date.now() - t0 }); return false; } };
  try {
    if (!TDX.proxy) {
      if (!TDX.apiKey || !TDX.tokenUrl) { out.push({ name: '設定', ok: false, detail: '尚未填入 token 端點與金鑰（或 Proxy 網址）' }); return out; }
      if (!await step('① 取得 token', async () => `成功（長度 ${(await tdxGetToken(true)).length}）`)) return out;
    }
    await step(`${TDX.proxy ? '①' : '②'} 查詢路線 ${route} 的即時到站（ETA）`, async () => `成功：${(await tdxGet(KIND_ETA, route)).length} 筆`);
  } finally { TDX.retries = saved; }
  return out;
}

export function tdxCached(kind, route, force) {            // 即時 ETA 與每日時刻表用不同快取期限；相同路線的請求合併；失敗時回傳舊資料並標 stale
  const key = kind + '|' + route, c = tdxCache.get(key), now = State.tdxNow(), ttl = kind === KIND_ETA ? TDX.etaTtl : TDX.ttTtl;
  if (c && !force && now - c.at < (c.error ? TDX.negTtl : ttl)) return Promise.resolve(c);
  if (tdxInflight.has(key)) return tdxInflight.get(key);
  const p = tdxGet(kind, route).then(data => { const rec = { data, at: State.tdxNow() }; tdxCache.set(key, rec); return rec; })
    .catch(err => { const rec = c && c.data ? { data: c.data, at: c.at, stale: true, error: err, tried: State.tdxNow() } : { data: null, at: State.tdxNow(), error: err }; tdxCache.set(key, rec); return rec; })
    .finally(() => tdxInflight.delete(key));
  tdxInflight.set(key, p); return p;
}

// ---- 站牌對應：bus graph 的 uid／stop_id 對 TDX 的 StopUID／StopID（找不到才退到站名）----

export function candUids(i, m) {                          // 回傳 {uids, by}：by='id' 是用 StopUID/StopID 配對；by='name' 只是同名站牌（可能是對向，不可靠）
  const ks = [State.bus.uids[i], State.bus.stopIds[i], State.bus.stopIds[i] ? 'TXG' + State.bus.stopIds[i] : ''].filter(Boolean), out = [];
  for (const [uid, o] of m) if (ks.includes(uid) || ks.includes(o.id)) out.push(uid);
  if (out.length) return { uids: out, by: 'id' };
  for (const [uid, o] of m) if (o.name && o.name === State.bus.names[i]) out.push(uid);
  return { uids: out, by: out.length ? 'name' : 'none' };
}

export async function resolveRide(ride, force) {
  if (routeKindOf(ride) === 'metro') { const at = State.tdxNow(); return { route: ride.label, metro: true, etaRec: { data: [], at }, ttRec: { data: [], at }, errors: [], dir: null, etaA: null, trips: [], busDate: null, matched: true, by: 'id' }; }   // 捷運：沒有 TDX 公車 API 可查
  const route = ride.label, [e, t] = await Promise.all([tdxCached(KIND_ETA, route, force), tdxCached(KIND_TT, route, force)]);
  const pickSub = arr => { const sub = arr.filter(x => x.SubRouteName?.Zh_tw === route); return sub.length ? sub : arr; };
  const eta = pickSub(e.data || []), tt = pickSub(t.data || []), A = ride.stops[0], B = ride.stops[ride.stops.length - 1];
  const out = { route, etaRec: e, ttRec: t, errors: [...new Set([e.error, t.error].filter(Boolean).map(describeTdxError))], dir: null, etaA: null, trips: [], busDate: tt[0]?.BusDate ?? null };
  const m = new Map();
  for (const it of eta) m.set(it.StopUID, { id: it.StopID, name: it.StopName?.Zh_tw });
  for (const p of tt) for (const s of p.Stops || []) if (!m.has(s.StopUID)) m.set(s.StopUID, { id: s.StopID, name: s.StopName?.Zh_tw });
  const CA = candUids(A, m), CB = candUids(B, m), ca = CA.uids, cb = CB.uids;
  out.by = CA.by === 'name' || CB.by === 'name' ? 'name' : 'id';
  // 方向與上下車順序：ETA 的 Direction + StopSequence
  let best = null;
  for (const d of new Set(eta.map(x => x.Direction))) {
    const byUid = new Map(eta.filter(x => x.Direction === d).map(x => [x.StopUID, x]));
    for (const ua of ca) for (const ub of cb) { const a = byUid.get(ua), b = byUid.get(ub); if (a && b && a.StopSequence < b.StopSequence && (!best || b.StopSequence - a.StopSequence < best.gap)) best = { d, a, gap: b.StopSequence - a.StopSequence, ua, ub }; }
  }
  if (best) { out.dir = best.d; out.etaA = best.a; }
  // 時刻表：Stops 陣列順序即行駛順序 → 上車站必須在下車站之前；若有 Direction 欄位則需一致
  for (const p of tt) {
    if (p.Direction != null && out.dir != null && p.Direction !== out.dir) continue;
    const st = p.Stops || [], ia = st.findIndex(s => ca.includes(s.StopUID)), ib = st.findIndex((s, k) => k > ia && ia >= 0 && cb.includes(s.StopUID));
    if (ia < 0 || ib < 0) continue;
    const bySeq = new Map(st[ib].TimeTables.map(x => [x.Sequence, x]));
    for (const x of st[ia].TimeTables) {
      const dep = hhmm(p.BusDate, x.DepartureTime || x.ArrivalTime), y = bySeq.get(x.Sequence), arr = y ? hhmm(p.BusDate, y.ArrivalTime || y.DepartureTime) : NaN;
      if (isFinite(dep)) out.trips.push({ depMs: dep, arrMs: isFinite(arr) && arr > dep ? arr : null, seq: x.Sequence, dest: p.DestinationStopName?.Zh_tw || '' });
    }
    if (out.dir == null && p.Direction != null) out.dir = p.Direction;
  }
  out.trips.sort((a, b) => a.depMs - b.depMs);
  out.matched = !!(best || out.trips.length);
  return out;
}

// TDX StopStatus（0=正常）；樣本資料只看到 0，其餘依官方文件定義

export function etaState(it, now) {
  if (!it) return { kind: 'none', text: '無 ETA 資料' };
  const upd = Date.parse(it.UpdateTime || it.DataTime || it.SrcUpdateTime), age = isFinite(upd) ? (now - upd) / 1000 : Infinity, st = it.StopStatus ?? 0;
  const base = { updMs: upd, seq: it.StopSequence, uid: it.StopUID, name: it.StopName?.Zh_tw, dir: it.Direction, dest: it.DestinationStop || '', countdown: it.StopCountDown, current: it.CurrentStop || '' };
  if (st !== 0) return { kind: 'status' + st, text: STOP_TEXT[st] || ('狀態碼 ' + st), ...base };
  const ests = (it.Estimates && it.Estimates.length ? it.Estimates : (typeof it.EstimateTime === 'number' ? [{ EstimateTime: it.EstimateTime, PlateNumb: it.PlateNumb, IsLastBus: it.IsLastBus }] : []))
    .filter(x => typeof x.EstimateTime === 'number');
  if (!ests.length) return { kind: 'nodata', text: 'ETA 無預估時間', ...base };
  if (age > TDX.staleS) return { kind: 'stale', text: `ETA 資料過期（${Math.round(age)} 秒前）`, ...base };
  return { kind: 'live', text: '即時預估', ...base, arrivals: ests.map(x => ({ ms: upd + Math.max(0, x.EstimateTime) * 1000, plate: x.PlateNumb, last: !!x.IsLastBus })) };
}

// 沿方案逐段計算：候車（即時 ETA／預定時刻／系統推估）、乘車、轉乘、總旅行時間

export async function annotateJourney(sug, depMs, force) {
  const now = State.tdxNow(), legs = [], upds = [], near = Math.abs(depMs - now) < 120e3; let t = depMs + sug.walkIn / WALK_MPS * 1000, ok = true;
  const infos = await Promise.all(sug.rides.map(r => resolveRide(r, force)));      // 只取方案用到的路線；相同路線的請求自動合併
  for (let q = 0; q < sug.rides.length; q++) {
    const ride = sug.rides[q], inf = infos[q];
    const es = inf.by === 'name' ? { kind: 'lowconf', text: '僅以站名配對（可能是對向或同名站牌），不用於候車時間' } : etaState(inf.etaA, now);
    const leg = { route: ride.label, from: State.bus.names[ride.stops[0]], to: State.bus.names[ride.stops[ride.stops.length - 1]], nStops: ride.stops.length - 1, dir: inf.dir, errors: inf.errors, eta: es, notes: [], deps: [] };
    if (inf.metro) {                                                              // 捷運：候車與行駛時間都是「系統推估」（資料沒有時刻表）
      const board = t + METRO_WAIT_S * 1000, alight = board + ride.sec * 1000;
      Object.assign(leg, { eta: { kind: 'metro', text: '捷運：沒有即時／時刻資料' }, boardAt: board, alightAt: alight, waitS: METRO_WAIT_S, waitSrc: '系統推估', rideS: ride.sec, rideSrc: '系統推估', metro: true, dest: '' });
      leg.notes.push(`捷運：以假設班距 ${METRO_HEADWAY_S / 60} 分鐘計算候車，行駛時間為估計`);
      legs.push(leg); t = alight + (q < sug.rides.length - 1 ? GROUP_WALK_S * 1000 : sug.walkOut / WALK_MPS * 1000); continue;
    }
    if (inf.errors.length) leg.notes.push('TDX 連線失敗：' + inf.errors.join('、') + (inf.etaRec.stale || inf.ttRec.stale ? '（改用較舊的快取）' : ''));
    if (!inf.errors.length && !(inf.etaRec.data || []).length && !(inf.ttRec.data || []).length) leg.notes.push('TDX 沒有這條路線的 ETA 與時刻表（可能今日未營運，或路線名稱與 TDX 不符）');
    else if (!inf.matched && !inf.errors.length) leg.notes.push('無法在 TDX 資料中對應上下車站牌或行駛方向');
    if (q > 0 && es.kind === 'live') leg.notes.push('轉乘後的路段：尚未到站，採預定時刻（ETA 僅供參考）');
    // 1) ETA 優先：只有 ETA 明確回報（StopStatus）才下「未營運／交管／末班」的結論
    let stop = null;
    if (es.kind === 'status4') stop = '今日未營運（ETA StopStatus=4）';
    else if (q === 0 && near && (es.kind === 'status2' || es.kind === 'status3')) stop = `${es.text}（ETA）`;
    if (stop) { leg.status = stop; ok = false; legs.push(leg); break; }
    let board = null, waitSrc = null, trip = null;
    if (q === 0 && near && es.kind === 'live') {                                    // 即時 ETA 只對「現在出發」的第一段有意義
      const a = es.arrivals.find(x => x.ms >= t);
      if (a) { board = a.ms; waitSrc = '即時 ETA'; leg.plate = a.plate; if (a.last) leg.notes.push('這一班是末班車'); } else leg.notes.push('即時班次趕不上，改看預定時刻');
    }
    // 2) 預定時刻（班次時間是絕對時間，所以凌晨仍可使用前一營運日 24:xx 的班次）
    if (inf.trips.length) {
      leg.deps = inf.trips.filter(x => x.depMs >= t).slice(0, 3).map(x => x.depMs);
      if (board == null) {
        trip = inf.trips.find(x => x.depMs >= t);
        if (trip) { board = trip.depMs; waitSrc = '預定時刻'; }
        else { leg.status = '末班車已過（時刻表）'; if (inf.busDate && todayStr(Date.parse(inf.busDate)) !== todayStr(now)) leg.notes.push('時刻表日期為 ' + todayStr(Date.parse(inf.busDate))); ok = false; legs.push(leg); break; }
      }
    }
    if (es.kind === 'status1') leg.notes.push('ETA：尚未發車（這不等於今日未營運）');
    if (board == null) { board = t + BOARD_WAIT_S * 1000; waitSrc = '系統推估'; leg.notes.push('沒有可用的 ETA 或時刻表，候車以預設 ' + BOARD_WAIT_S / 60 + ' 分估算'); }
    let alight, rideSrc;
    const sch = inf.trips.filter(x => x.arrMs).map(x => x.arrMs - x.depMs).sort((a, b) => a - b);
    if (trip && trip.arrMs) { alight = trip.arrMs; rideSrc = '預定時刻'; }
    else if (sch.length) { alight = board + sch[sch.length >> 1]; rideSrc = '預定行駛時間（時刻表中位數）'; }
    else { alight = board + ride.sec * 1000; rideSrc = '系統推估'; }
    Object.assign(leg, { boardAt: board, alightAt: alight, waitS: (board - t) / 1000, waitSrc, rideS: (alight - board) / 1000, rideSrc, dest: trip?.dest || inf.trips[0]?.dest || '' });
    legs.push(leg); upds.push(es.updMs, inf.etaRec.at, inf.ttRec.at);
    t = alight + (q < sug.rides.length - 1 ? GROUP_WALK_S * 1000 : sug.walkOut / WALK_MPS * 1000);
  }
  return { legs, ok, arriveMs: ok ? t : null, totalS: ok ? (t - depMs) / 1000 : null, transfers: sug.rides.length - 1, updatedAt: Math.min(...upds.filter(isFinite)), depMs };
}

// 載入時要執行的綁定（原本是頂層語句），由 main.js 依序呼叫
export function init() {
  try { Object.assign(TDX, JSON.parse(localStorage.getItem('tdxcfg') || '{}')); TDX.apiKey = sessionStorage.getItem('tdxkey') || ''; } catch (e) {}
  // 金鑰只放 sessionStorage，不寫進程式碼

  for (const [id, k] of [['tdxTokenUrl', 'tokenUrl'], ['tdxKey', 'apiKey'], ['tdxTs', 'ts'], ['tdxProxy', 'proxy']]) {
    const inp = document.getElementById(id); inp.value = TDX[k] || '';
    inp.addEventListener('change', () => { TDX[k] = inp.value.trim(); try { if (k === 'apiKey') sessionStorage.setItem('tdxkey', TDX.apiKey); else localStorage.setItem('tdxcfg', JSON.stringify({ tokenUrl: TDX.tokenUrl, ts: TDX.ts, proxy: TDX.proxy })); } catch (e) {} State.tdxToken = { value: null, exp: 0 }; });
  }
  document.getElementById('tdxTest').addEventListener('click', async () => {
    const box = document.getElementById('tdxTestBox'); box.textContent = '測試中…';
    const res = await tdxDiagnose(); box.innerHTML = res.map(x => `${x.ok ? '✅' : '❌'} ${esc(x.name)} — ${esc(x.detail)}${x.ms != null ? '（' + x.ms + ' ms）' : ''}`).join('<br>');
  });
}
