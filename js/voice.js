// voice.js — 語音導航：VoiceTemplates（文字）、ManeuverDetector（何時播）、VoiceQueue（優先序／去重）、VoiceEngine（SpeechSynthesis）、AnnouncementManager（串接導航事件）
// 瀏覽器限制：必須在使用者操作（按「開始導航」）內呼叫 VoiceEngine.init()，iOS Safari／Android Chrome 才允許之後的語音。
// 不同裝置的中文語音不一定存在；沒有中文語音時會明確回報 voiceFound=false。

// ---------- VoiceTemplates ----------
export const VoiceTemplates = {
  dist(m) { if (m >= 950) { const k = Math.round(m / 100) / 10; return `${k}公里`; } return `${m >= 100 ? Math.round(m / 50) * 50 : Math.max(10, Math.round(m / 10) * 10)}公尺`; },
  minutes(s) { const m = Math.max(1, Math.round(s / 60)); return m >= 60 ? `${Math.floor(m / 60)}小時${m % 60 ? (m % 60) + '分鐘' : ''}` : `${m}分鐘`; },
  action(st) {
    if (st.turnType === 'arrive') return '抵達目的地';
    if (st.turnType === 'ferry') return '搭乘渡輪';
    const d = st.dir === 'left' ? '左' : st.dir === 'right' ? '右' : '';
    switch (st.turnType) { case 'uturn': return '迴轉'; case 'sharp': return `向${d || '右'}後方轉彎`; case 'slight': return `稍微向${d || '右'}轉`; case 'turn': return `${d || '右'}轉`; default: return '直行'; }
  },
  road(st) { return st.roadName ? `進入${st.roadName}` : ''; },
  ahead(st, d) { return st.turnType === 'arrive' ? `前方${this.dist(d)}，即將抵達目的地` : `前方${this.dist(d)}，${this.action(st)}${st.roadName ? '，' + this.road(st) : ''}`; },
  now(st) { return st.turnType === 'arrive' ? '即將抵達目的地' : `現在${this.action(st)}${st.roadName ? '，' + this.road(st) : ''}`; },
  start(total, remS, firstRoad) { return `開始導航，${firstRoad ? '沿' + firstRoad + '行駛，' : ''}全程約${this.dist(total)}，預計${this.minutes(remS)}`; },
  offroute: () => '您已偏離路線', rerouting: () => '正在重新規劃路線', rerouted: () => '已重新規劃路線', arrived: () => '您已抵達目的地',
  rerouteFailed: () => '重新規劃失敗，請確認網路或手動調整', gpsLost: () => 'GPS 訊號中斷', gpsBack: () => 'GPS 訊號恢復', backOnRoute: () => '已回到路線上'
};

// ---------- ManeuverDetector ----------
// 提示距離（公尺）依交通方式：遠提示、近提示、「現在」。使用者可改成 near/far 倍率。
export const PROMPT_PROFILE = { car: { far: [500, 200], now: 40 }, heavy: { far: [500, 200], now: 40 }, moto: { far: [400, 150], now: 35 }, bike: { far: [200, 80], now: 25 }, walk: { far: [80, 30], now: 12 } };
export const LEAD_S = { far: [30, 12], now: 5 };
export class ManeuverDetector {
  constructor() { this.announced = new Set(); }
  reset() { this.announced.clear(); }
  // state：NavigationEngine 的狀態；回傳「這次該播的提示」（最多一則，避免一口氣講好幾個）
  // 提示距離會隨車速放大：確保遠提示至少提前約 30 秒／12 秒、「現在」至少提前約 5 秒（念一句話要 2～3 秒）
  detect(state, profile, scale = 1) {
    const st = state.next; if (!st || state.status !== 'navigating') return null;
    const v = Math.max(0, Math.min(45, state.speed || 0)), lead = LEAD_S;
    const id = st.index, d = state.distToNext, far = profile.far.map((x, i) => Math.max(x * scale, v * (lead.far[i] ?? lead.far[lead.far.length - 1]))).sort((a, b) => b - a), nowD = Math.max(profile.now * scale, v * lead.now);
    if (d <= nowD) { const k = `${id}:now`; if (this.announced.has(k)) return null; this._markAll(id, far); this.announced.add(k); return { key: k, text: VoiceTemplates.now(st), priority: 2 }; }
    // 找出「已進入」的最遠一級提示；若一次跳過多級（例如剛起步就在 150 m），只播最近的一級並把更遠的標記為已播
    const hit = far.filter(t => d <= t); if (!hit.length) return null;
    const t = hit[hit.length - 1], k = `${id}:${t}`; if (this.announced.has(k)) return null;
    for (const x of hit) this.announced.add(`${id}:${x}`);
    return { key: k, text: VoiceTemplates.ahead(st, d), priority: 1 };
  }
  _markAll(id, far) { for (const x of far) this.announced.add(`${id}:${x}`); }
}

// ---------- VoiceQueue ----------
export class VoiceQueue {
  constructor(o = {}) { this.items = []; this.max = o.max ?? 5; this.dedupeMs = o.dedupeMs ?? 8000; this.recent = new Map(); }
  clear() { this.items.length = 0; }
  // 去重：相同 key 或相同文字在 dedupeMs 內不重複排入；高優先級排前面；佇列滿了先丟最低優先級
  push(it, now = Date.now()) {
    for (const [k, t] of this.recent) if (now - t > this.dedupeMs * 4) this.recent.delete(k);
    const sig = it.key || it.text;
    if (!it.force && this.recent.has(sig) && now - this.recent.get(sig) < this.dedupeMs) return false;
    if (!it.force && this.recent.has('t:' + it.text) && now - this.recent.get('t:' + it.text) < this.dedupeMs) return false;
    this.recent.set(sig, now); this.recent.set('t:' + it.text, now);
    const item = { ttl: it.priority >= 3 ? 20000 : it.priority === 2 ? 12000 : 7000, ...it, ts: now };
    const i = this.items.findIndex(x => x.priority < item.priority); if (i < 0) this.items.push(item); else this.items.splice(i, 0, item);
    while (this.items.length > this.max) this.items.pop();
    return true;
  }
  next(now = Date.now()) { while (this.items.length) { const it = this.items.shift(); if (now - it.ts <= it.ttl) return it; } return null; }   // 過期的提示（例如已經開過路口）直接丟掉
}

// ---------- VoiceEngine ----------
export class VoiceEngine {
  constructor(o = {}) {
    this.synth = o.synth ?? (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null); this.Utt = o.Utterance ?? (typeof SpeechSynthesisUtterance !== 'undefined' ? SpeechSynthesisUtterance : null);
    this.lang = o.lang ?? 'zh-TW'; this.rate = o.rate ?? 1; this.volume = o.volume ?? 1; this.enabled = o.enabled ?? true; this.now = o.now ?? (() => Date.now());
    this.queue = new VoiceQueue(o.queue); this.ready = false; this.voice = null; this.voiceFound = false; this.cur = null; this.lastItem = null; this.log = []; this.onState = o.onState || (() => {});
  }
  get supported() { return !!(this.synth && this.Utt); }
  // 必須在使用者手勢（click／touch）處理函式內呼叫
  init() {
    if (!this.supported) { this.onState({ ready: false, reason: '此瀏覽器不支援語音合成' }); return false; }
    try { const u = new this.Utt(' '); u.volume = 0; u.lang = this.lang; this.synth.speak(u); } catch (e) { this.onState({ ready: false, reason: String(e.message || e) }); return false; }   // 在手勢內送一則靜音語音「解鎖」
    this._pickVoice(); if (this.synth.addEventListener) this.synth.addEventListener('voiceschanged', () => this._pickVoice());       // iOS／Chrome 常常稍後才載入語音清單
    this.ready = true; this.onState({ ready: true, voiceFound: this.voiceFound, voice: this.voice && this.voice.name }); return true;
  }
  _pickVoice() {
    const vs = (this.synth.getVoices && this.synth.getVoices()) || [], norm = v => String(v.lang || '').replace('_', '-').toLowerCase();
    this.voice = vs.find(v => norm(v) === 'zh-tw') || vs.find(v => norm(v) === 'zh-hk') || vs.find(v => norm(v).startsWith('zh')) || null; this.voiceFound = !!this.voice;
  }
  setEnabled(on) { this.enabled = !!on; if (!on) { this.queue.clear(); this._cancel(); } }
  setRate(r) { this.rate = Math.min(2, Math.max(0.5, +r || 1)); }
  setVolume(v) { this.volume = Math.min(1, Math.max(0, isFinite(+v) ? +v : 1)); }
  // 高優先級可以打斷正在播的低優先級語音（例如「偏航」不能被「前方 500 公尺」擋住）
  speak(it) {
    if (!this.enabled || !this.ready) return false;
    const ok = this.queue.push(it, this.now()); if (!ok) return false;
    if (this.cur && it.priority > this.cur.priority) this._cancel();
    this._pump(); return true;
  }
  repeat() { if (this.lastItem) return this.speak({ ...this.lastItem, key: 'repeat:' + this.now(), force: true, priority: Math.max(2, this.lastItem.priority) }); return false; }
  _cancel() { this.cur = null; try { this.synth.cancel(); } catch {} }      // 先清掉 cur 再 cancel：被取消那句的 onerror 不會誤動到下一句
  _pump() {
    if (this.cur) { if (this.now() - this.cur.t0 > 15000) this._cancel(); else return; }       // 看門狗：部分 iOS 版本 onend 不會觸發，卡住超過 15 秒就強制放掉
    const it = this.queue.next(this.now()); if (!it) return;
    const u = new this.Utt(it.text); u.lang = this.lang; u.rate = this.rate; u.volume = this.volume; if (this.voice) u.voice = this.voice;
    const done = () => { if (this.cur && this.cur.u === u) { this.cur = null; this._pump(); } };
    u.onend = done; u.onerror = done;
    this.cur = { u, priority: it.priority, t0: this.now() }; this.lastItem = it; this.log.push(it.text);
    try { if (this.synth.paused && this.synth.resume) this.synth.resume(); this.synth.speak(u); } catch (e) { this.cur = null; }
  }
}

// ---------- AnnouncementManager ----------
export class AnnouncementManager {
  constructor(engine, o = {}) { this.engine = engine; this.detector = new ManeuverDetector(); this.profileKey = o.profileKey ?? 'car'; this.scale = o.scale ?? 1; this.started = false; this.gpsLostSaid = false; }
  setProfile(k, scale = 1) { this.profileKey = PROMPT_PROFILE[k] ? k : 'car'; this.scale = scale; }
  reset() { this.detector.reset(); this.started = false; this.gpsLostSaid = false; }
  // type：NavigationEngine 的事件名；state：當時的導航狀態
  onNav(type, state) {
    const say = (text, priority, key) => this.engine.speak({ text, priority, key });
    switch (type) {
      case 'started': this.detector.reset(); say(VoiceTemplates.start(state.totalM, state.remainingS, state.firstRoad), 3, 'start'); break;
      case 'offroute': say(VoiceTemplates.offroute(), 3, 'offroute'); break;
      case 'reroute-request': say(VoiceTemplates.rerouting(), 3, 'rerouting'); break;
      case 'rerouted': this.detector.reset(); say(VoiceTemplates.rerouted(), 3, 'rerouted'); break;
      case 'reroute-failed': say(VoiceTemplates.rerouteFailed(), 3, 'rr-fail'); break;
      case 'back-on-route': say(VoiceTemplates.backOnRoute(), 2, 'back'); break;
      case 'arrived': this.engine.queue.clear(); say(VoiceTemplates.arrived(), 3, 'arrived'); break;
      case 'update': { const a = this.detector.detect(state, PROMPT_PROFILE[this.profileKey], this.scale); if (a) this.engine.speak(a); break; }
    }
  }
  onGps(status) {
    if (status === 'lost' && !this.gpsLostSaid) { this.gpsLostSaid = true; this.engine.speak({ text: VoiceTemplates.gpsLost(), priority: 2, key: 'gps-lost' }); }
    else if ((status === 'active' || status === 'weak') && this.gpsLostSaid) { this.gpsLostSaid = false; this.engine.speak({ text: VoiceTemplates.gpsBack(), priority: 1, key: 'gps-back:' + Date.now() }); }
  }
}
