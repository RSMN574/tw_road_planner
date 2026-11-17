// tdx-proxy.mjs — TDX 代理：token 由伺服器取得與快取，金鑰永遠不會送到瀏覽器
// 網頁送 GET /tdx/api/<路徑>  →  伺服器轉送到 TDX_UPSTREAM/<路徑>（帶 Bearer token）
// ・token：快取到過期前；同時多個請求只取一次（in-flight 去重）；401 時換新 token 重試一次
// ・資料：相同網址同時進來只打一次上游；成功結果短暫快取（預設 15 秒，ETA 本來就是 30 秒級更新）
export const looksLikeToken = v => typeof v === 'string' && /^[^\s<>{}"'`]{6,}$/.test(v);

// getToken(force)：外部提供 token（例如掛在 server_2 裡時，讀 server_2 由 cron 更新的 token.txt）；沒給就用 tokenUrl＋apiKey 向遠端 token 端點要
export function createTdxProxy({ tokenUrl, apiKey, ts = '', upstream, cacheMs = 15000, timeoutMs = 10000, fetchImpl = globalThis.fetch, getToken = null }) {
  const configured = !!getToken || !!(tokenUrl && apiKey);
  let tok = { v: null, exp: 0 }, tokInflight = null;
  const inflight = new Map(), cache = new Map(), stats = { upstream: 0, shared: 0, cached: 0, tokens: 0 };
  async function timed(url, opt) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...opt, signal: ac.signal }); }
    catch (e) { throw Object.assign(new Error(e.name === 'AbortError' ? `逾時（${timeoutMs} ms）` : `連線失敗：${e.message}`), { code: e.name === 'AbortError' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_NETWORK' }); }
    finally { clearTimeout(t); }
  }
  function token(force) {
    if (getToken) { stats.tokens++; return Promise.resolve(getToken(force)).then(v => String(v).trim().replace(/^Bearer\s+/i, '')); }
    if (!force && tok.v && Date.now() < tok.exp) return Promise.resolve(tok.v);
    return tokInflight ??= (async () => {
      const r = await timed(tokenUrl, { method: 'POST', headers: { Authorization: 'Bearer ' + apiKey, 'X-Timestamp': ts || new Date().toISOString() } });
      const txt = await r.text(); stats.tokens++;
      if (!r.ok) throw Object.assign(new Error(`token 端點 HTTP ${r.status}：${txt.slice(0, 120)}`), { code: 'TOKEN_HTTP' });
      let j; try { j = JSON.parse(txt); } catch { j = txt.trim(); }
      const v = typeof j === 'string' ? j : (j.access_token ?? j.token ?? j.data?.access_token ?? j.data?.token ?? (typeof j.data === 'string' ? j.data : null));
      if (!looksLikeToken(v)) throw Object.assign(new Error('token 端點回傳的內容不像 token：' + txt.slice(0, 120)), { code: 'TOKEN_FORMAT' });
      tok = { v, exp: Date.now() + (Number(j.expires_in ?? j.data?.expires_in) || 3000) * 900 }; return v;
    })().finally(() => { tokInflight = null; });
  }
  async function fetchUp(pathAndQuery) {
    const target = upstream.replace(/\/+$/, '') + pathAndQuery;
    stats.upstream++;
    let r = await timed(target, { headers: { Authorization: 'Bearer ' + await token(false), Accept: 'application/json' } });
    if (r.status === 401) r = await timed(target, { headers: { Authorization: 'Bearer ' + await token(true), Accept: 'application/json' } });
    return { status: r.status, type: r.headers.get('content-type') || 'application/json', body: Buffer.from(await r.arrayBuffer()) };
  }
  // pathAndQuery 例：/Bus/EstimatedTimeOfArrival/City/Taichung/307?$format=JSON
  async function handle(pathAndQuery) {
    if (!configured) throw Object.assign(new Error('伺服器沒有設定 TDX（TDX_TOKEN_URL、TDX_API_KEY，或由 server_2 的 token.txt 提供）'), { code: 'TDX_NOT_CONFIGURED', status: 503 });
    if (!/^\/[\w\-\/.$%=&?,:()'+ ]*$/.test(pathAndQuery) || pathAndQuery.includes('..')) throw Object.assign(new Error('不合法的路徑'), { code: 'BAD_PATH', status: 400 });
    const c = cache.get(pathAndQuery); if (c && Date.now() - c.t < cacheMs) { stats.cached++; return { ...c.r, cached: true }; }
    let p = inflight.get(pathAndQuery);
    if (p) stats.shared++;
    else { p = fetchUp(pathAndQuery).finally(() => inflight.delete(pathAndQuery)); inflight.set(pathAndQuery, p); }
    const r = await p;
    if (r.status === 200) { cache.set(pathAndQuery, { r, t: Date.now() }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
    return r;
  }
  return { configured, handle, stats, _token: token };
}
