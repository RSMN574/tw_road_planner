// 語音：模板、提示時機、佇列去重／優先序、SpeechSynthesis 引擎（含初始化手勢、優先打斷、無中文語音）、與導航事件串接
import { ok, done } from './helpers.mjs';
const { VoiceTemplates: T, ManeuverDetector, VoiceQueue, VoiceEngine, AnnouncementManager, PROMPT_PROFILE } = await import('../js/voice.js');
const right = { index: 3, turnType: 'turn', dir: 'right', roadName: '中港路', turnAngle: -90 }, left = { index: 4, turnType: 'slight', dir: 'left', roadName: '', turnAngle: 40 }, arrive = { index: 9, turnType: 'arrive', roadName: '' };
console.log('① 語音模板');
ok('前方 500 公尺右轉進入中港路', T.ahead(right, 500) === '前方500公尺，右轉，進入中港路', T.ahead(right, 500));
ok('沒有路名就不念「進入」', T.ahead(left, 200) === '前方200公尺，稍微向左轉', T.ahead(left, 200));
ok('現在右轉', T.now(right) === '現在右轉，進入中港路');
ok('距離念法：90→90公尺／1200→1.2公里／230→250公尺', T.dist(90) === '90公尺' && T.dist(1200) === '1.2公里' && T.dist(230) === '250公尺', [T.dist(90), T.dist(1200), T.dist(230)].join('、'));
ok('抵達與迴轉', T.ahead(arrive, 80) === '前方80公尺，即將抵達目的地' && T.action({ turnType: 'uturn' }) === '迴轉');
ok('開始導航：含全程距離與時間', T.start(5400, 900, '台灣大道') === '開始導航，沿台灣大道行駛，全程約5.4公里，預計15分鐘', T.start(5400, 900, '台灣大道'));
console.log('② ManeuverDetector（何時播）');
{ const d = new ManeuverDetector(), says = []; for (let m = 700; m >= 0; m -= 10) { const r = d.detect({ status: 'navigating', next: right, distToNext: m }, PROMPT_PROFILE.car); if (r) says.push([m, r.priority, r.text]); }
  ok('接近路口依序提示：500 → 200 → 現在，各一次', says.length === 3 && says[0][0] <= 500 && says[0][0] > 490 && says[1][0] <= 200 && says[2][2].startsWith('現在') && says[2][1] === 2, says.map(s => s[0] + 'm').join(' / '));
  ok('同一路口不重複播', (() => { const r = []; for (let i = 0; i < 20; i++) { const x = d.detect({ status: 'navigating', next: right, distToNext: 30 }, PROMPT_PROFILE.car); if (x) r.push(x); } return r.length === 0; })()); }
{ const d = new ManeuverDetector(), r = d.detect({ status: 'navigating', next: right, distToNext: 150 }, PROMPT_PROFILE.car), r2 = d.detect({ status: 'navigating', next: right, distToNext: 140 }, PROMPT_PROFILE.car);
  ok('一開始就在 150 m：只播一則（用實際距離），不補播 500／200', r && r.text.includes('150公尺') || r.text.includes('150') , r && r.text); ok('之後不補播更遠的提示', r2 === null); }
{ const d = new ManeuverDetector(); ok('偏航／重新規劃中不播轉彎提示', d.detect({ status: 'offroute', next: right, distToNext: 100 }, PROMPT_PROFILE.car) === null && d.detect({ status: 'rerouting', next: right, distToNext: 100 }, PROMPT_PROFILE.car) === null);
  const w = new ManeuverDetector(), a = w.detect({ status: 'navigating', next: right, distToNext: 70 }, PROMPT_PROFILE.walk); ok('步行用較短的提示距離（70 m 就提示、車用 500 m）', a && a.priority === 1); const c = new ManeuverDetector(); ok('同樣 70 m，汽車已進入「更近一級」', c.detect({ status: 'navigating', next: right, distToNext: 70 }, PROMPT_PROFILE.car).priority === 1);
  const s = new ManeuverDetector(); ok('提示距離倍率（遠 ×1.5）：汽車 700 m 就會提示', s.detect({ status: 'navigating', next: right, distToNext: 700 }, PROMPT_PROFILE.car, 1.5) !== null); }
console.log('③ VoiceQueue');
{ const q = new VoiceQueue(), t0 = 1000; q.push({ key: 'a', text: 'A', priority: 1 }, t0); q.push({ key: 'b', text: 'B', priority: 3 }, t0); q.push({ key: 'c', text: 'C', priority: 2 }, t0);
  ok('依優先級輸出（3 → 2 → 1）', ['B', 'C', 'A'].every(x => q.next(t0).text === x));
  ok('相同 key 在去重時間內不重複排入', q.push({ key: 'a', text: 'A', priority: 1 }, t0 + 1000) === false);
  ok('相同文字（不同 key）也不重複', q.push({ key: 'z', text: 'A', priority: 1 }, t0 + 1000) === false);
  ok('超過去重時間後可再排入', q.push({ key: 'a', text: 'A', priority: 1 }, t0 + 9000) === true);
  const q2 = new VoiceQueue(); q2.push({ key: 'o', text: 'old', priority: 1 }, 0); ok('過期的提示（已錯過的路口）直接丟掉', q2.next(20000) === null);
  const q3 = new VoiceQueue({ max: 3 }); for (let i = 0; i < 6; i++) q3.push({ key: 'k' + i, text: 't' + i, priority: i % 3 }, 0); ok('佇列滿了先丟最低優先級', q3.items.length === 3 && q3.items.every(x => x.priority >= 1)); }
console.log('④ VoiceEngine（假的 SpeechSynthesis）');
function fakeSynth(voices = [{ name: 'Mei-Jia', lang: 'zh_TW' }, { name: 'Alex', lang: 'en-US' }]) {
  const s = { spoken: [], cancels: 0, cur: null, voices, paused: false, listeners: {}, getVoices() { return this.voices; }, addEventListener(n, f) { this.listeners[n] = f; }, resume() {},
    speak(u) { this.spoken.push(u); this.cur = u; }, cancel() { this.cancels++; const u = this.cur; this.cur = null; if (u && u.onerror) u.onerror({ error: 'interrupted' }); }, end() { const u = this.cur; this.cur = null; if (u && u.onend) u.onend(); } };
  return s;
}
class Utt { constructor(t) { this.text = t; } }
{ const sy = fakeSynth(), st = []; let now = 0; const e = new VoiceEngine({ synth: sy, Utterance: Utt, now: () => now, onState: s => st.push(s) });
  ok('init 之前不能播（必須先由使用者操作初始化）', e.speak({ key: 'x', text: 'hi', priority: 1 }) === false && sy.spoken.length === 0);
  e.init(); ok('init：送出一則靜音語音解鎖，並選到 zh-TW 語音', sy.spoken.length === 1 && sy.spoken[0].volume === 0 && e.voice && e.voice.name === 'Mei-Jia' && st[0].ready);
  sy.end(); e.speak({ key: 'a', text: '前方200公尺，右轉', priority: 1 }); ok('開始播放，使用 zh-TW、語速與音量', sy.cur.text === '前方200公尺，右轉' && sy.cur.lang === 'zh-TW' && sy.cur.rate === 1 && sy.cur.voice.name === 'Mei-Jia');
  e.speak({ key: 'b', text: '現在右轉', priority: 2 }); ok('高優先級打斷正在播的低優先級', sy.cancels >= 1 && sy.cur.text === '現在右轉');
  e.speak({ key: 'c', text: '前方500公尺', priority: 1 }); ok('低優先級排隊，不打斷高優先級', sy.cur.text === '現在右轉'); sy.end(); ok('播完自動接下一則', sy.cur && sy.cur.text === '前方500公尺');
  const n = sy.spoken.length; e.speak({ key: 'c', text: '前方500公尺', priority: 1 }); ok('重複的提示不會再播', sy.spoken.length === n);
  sy.end(); e.setRate(5); e.setVolume(-1); ok('語速／音量限制在合理範圍', e.rate === 2 && e.volume === 0); e.setRate(1); e.setVolume(1);
  e.repeat(); ok('重複提示：重新念最後一則', sy.cur && sy.cur.text === '前方500公尺'); sy.end();
  e.speak({ key: 'q1', text: 'Q1', priority: 1 }); e.speak({ key: 'q2', text: 'Q2', priority: 1 }); e.setEnabled(false); ok('關閉語音：立即停止並清空佇列', e.queue.items.length === 0 && sy.cur === null); ok('關閉後不會再播', e.speak({ key: 'q3', text: 'Q3', priority: 3 }) === false);
  e.setEnabled(true); sy.end(); e.speak({ key: 'hang', text: 'H', priority: 1 }); now += 16000; e.speak({ key: 'next', text: 'N', priority: 1 }); ok('看門狗：卡住超過 15 秒會放掉，下一則照播', sy.cur && sy.cur.text === 'N'); }
{ const sy = fakeSynth([{ name: 'Alex', lang: 'en-US' }]), st = []; const e = new VoiceEngine({ synth: sy, Utterance: Utt, onState: s => st.push(s) }); e.init(); ok('沒有中文語音：voiceFound=false（介面會提示）', st[0].ready && st[0].voiceFound === false);
  const sy2 = fakeSynth([]); const e2 = new VoiceEngine({ synth: sy2, Utterance: Utt }); e2.init(); sy2.voices = [{ name: 'Sin-ji', lang: 'zh-HK' }]; sy2.listeners.voiceschanged(); ok('語音清單晚載入（voiceschanged）也能選到（zh-HK 備援）', e2.voice && e2.voice.name === 'Sin-ji');
  const e3 = new VoiceEngine({ synth: null, Utterance: null, onState: s => st.push(s) }); ok('瀏覽器不支援語音：init 回報失敗，不丟例外', e3.init() === false && e3.speak({ text: 'x', priority: 1 }) === false); }
console.log('⑤ AnnouncementManager（串接導航事件）');
{ const sy = fakeSynth(), e = new VoiceEngine({ synth: sy, Utterance: Utt }); e.init(); sy.end(); const a = new AnnouncementManager(e, { profileKey: 'car' }); const said = () => e.log.slice();
  const base = { status: 'navigating', next: right, distToNext: 600, totalM: 5400, remainingS: 900, firstRoad: '台灣大道' };
  a.onNav('started', base); ok('開始導航：播報全程資訊', said()[0] === '開始導航，沿台灣大道行駛，全程約5.4公里，預計15分鐘', said()[0]); sy.end();
  a.onNav('update', { ...base, distToNext: 450 }); sy.end(); a.onNav('update', { ...base, distToNext: 440 }); ok('前方路口提示只播一次', said().filter(t => t.startsWith('前方450')).length === 1);
  a.onNav('offroute', { ...base, status: 'offroute' }); ok('偏航提示（優先級 3）打斷其他語音', sy.cur.text === '您已偏離路線'); sy.end();
  a.onNav('reroute-request', base); ok('重新規劃提示', sy.cur.text === '正在重新規劃路線'); sy.end(); a.onNav('rerouted', base); sy.end(); ok('重新規劃完成：提示並重設已播報記錄', said().includes('已重新規劃路線') && a.detector.announced.size === 0);
  a.onNav('arrived', { ...base, status: 'arrived' }); ok('抵達目的地', e.log[e.log.length - 1] === '您已抵達目的地'); sy.end();
  a.onGps('lost'); a.onGps('lost'); ok('GPS 中斷只提示一次', e.log.filter(t => t === 'GPS 訊號中斷').length === 1); }
done();
