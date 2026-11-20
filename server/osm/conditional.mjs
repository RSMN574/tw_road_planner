// conditional.mjs — OSM 條件式（restriction:conditional、xxx:conditional 的 @ 後半段、舊式 day_on/hour_on）判斷
//
// 支援的時間語法（opening_hours 的常用子集）：
//   07:00-09:00            Mo-Fr 07:00-09:00,16:00-19:00          Mo,We,Fr 08:00-10:00          Sa-Su
//   Mo-Fr 07:00-09:00; Sa 08:00-12:00（多條規則）               22:00-06:00（跨午夜）          24/7
//   AND 連接的多個條件：全部成立才成立；其中有無法判斷的（例如 wet、weight>7.5、只在國定假日 PH、sunrise）→ 回傳 null
//   「, PH off」（國定假日不適用）：沒有可靠的國定假日日曆 → 忽略這個例外、照平日判斷（對禁止類限制是保守的：寧可多繞，不違規）；fn.info 會記下
//   OSM 實際資料常見的寫法也接受：逗號後有空白、括號不成對（舊版建圖用 ; 切開造成）、hour_on=7:00~9:00,17:00~19:00
// 判斷結果：true＝現在適用、false＝現在不適用、null＝無法判斷（由呼叫端決定政策並回報，這裡不猜）
// 時間一律用 Asia/Taipei（UTC+8，沒有日光節約時間）
const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_NAME = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const TZ_MS = 8 * 3600e3;

// 依括號深度切開（OSM 的 "a @ (x; y); b @ (z)" 不能直接用 ; 切）
export function splitTop(s, sep = ';') {
  const out = []; let d = 0, cur = '';
  for (const ch of String(s)) { if (ch === '(') d++; else if (ch === ')') d = Math.max(0, d - 1); if (ch === sep && d === 0) { out.push(cur); cur = ''; } else cur += ch; }
  if (cur.trim()) out.push(cur); return out.map(x => x.trim()).filter(Boolean);
}
// "no_left_turn @ (Mo-Fr 07:00-09:00); no_right_turn @ (22:00-06:00)" → [{ value, cond }]
export function parseConditionalValue(s) {
  return splitTop(s).map(part => { const i = part.indexOf('@'); return i < 0 ? null : { value: part.slice(0, i).trim(), cond: part.slice(i + 1).trim() }; }).filter(Boolean);
}
const hm = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m && +m[1] <= 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
function parseDays(sel) {                                                        // "Mo-Fr,Su" → 7 位元遮罩；看不懂回傳 null
  let mask = 0;
  for (const p of sel.split(',')) {
    const r = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(p.trim()); if (!r) return null;
    const a = DAYS.indexOf(r[1]), b = r[2] ? DAYS.indexOf(r[2]) : a;
    for (let d = a, n = 0; n < 7; d = (d + 1) % 7, n++) { mask |= 1 << d; if (d === b) break; }
  }
  return mask;
}
function parseTimes(sel) {                                                       // "07:00-09:00,16:00-19:00" → [[分, 分]]
  const out = [];
  for (const p of sel.split(',')) {
    const m = /^(\d{1,2}:\d{2})[-~](\d{1,2}:\d{2})$/.exec(p.trim()); if (!m) return null;
    const a = hm(m[1]), b = hm(m[2]); if (a == null || b == null) return null; out.push([a, b]);
  }
  return out;
}
// 一條 opening_hours 規則 → { days, times, off }；看不懂回傳 null
function parseRule(r) {
  r = r.trim(); if (!r) return null; if (r === '24/7') return { days: 127, times: [[0, 1440]], off: false };
  let off = false; if (/\s(off|closed)$/i.test(r)) { off = true; r = r.replace(/\s(off|closed)$/i, '').trim(); }
  const toks = r.split(/\s+/); let days = 127, times = [[0, 1440]];
  if (toks.length > 2) return null;
  for (const t of toks) {
    if (/^\d/.test(t)) { const x = parseTimes(t); if (!x) return null; times = x; }
    else if (/^!?(PH|SH)$/.test(t)) return { holidayOnly: true };                 // 只在國定假日／學校假期：沒有可靠的日曆資料（由呼叫端決定）
    else {
      const all = t.split(','), sel = all.filter(x => x !== 'PH'), d = parseDays(sel.join(','));
      if (d == null || (sel.length < all.length && d !== 127)) return null;        // Mo-Su,PH＝每天；其他含 PH 的無法判斷
      days = d;
    }
  }
  return { days, times, off };
}
// 舊式 day_on=Monday day_off=Friday hour_on=07:00 hour_off=09:00 → opening_hours 字串
function legacyToOh(s) {
  const kv = Object.fromEntries([...s.matchAll(/(day_on|day_off|hour_on|hour_off)=(\S+)/g)].map(m => [m[1], m[2]]));
  let hour = null;
  if (kv.hour_on && /[-~]/.test(kv.hour_on) && !kv.hour_off) hour = kv.hour_on.replace(/~/g, '-');   // hour_on=7:00~9:00,17:00~19:00（常見的錯誤寫法）
  else if (kv.hour_on && kv.hour_off && kv.hour_on.includes(';')) { const a = kv.hour_on.split(';'), b = kv.hour_off.split(';'); if (a.length === b.length) hour = a.map((x, i) => `${x}-${b[i]}`).join(','); }
  const d0 = DAY_NAME[String(kv.day_on || '').toLowerCase()], d1 = DAY_NAME[String(kv.day_off || '').toLowerCase()];
  if ((kv.day_on && d0 == null) || (kv.day_off && d1 == null)) return null;
  const days = d0 != null ? DAYS[d0] + (d1 != null ? '-' + DAYS[d1] : '') : '', time = hour || (kv.hour_on && kv.hour_off ? `${kv.hour_on}-${kv.hour_off}` : '');
  return [days, time].filter(Boolean).join(' ') || null;
}
// 條件字串 → fn(ms) → true／false／null；fn.info.ignoredHolidayException：忽略了「, PH off」
export function compileCondition(cond) {
  const info = { ignoredHolidayException: false };
  if (cond == null) return Object.assign(() => true, { info });
  let s = String(cond).trim();
  if (/^(day_on|day_off|hour_on|hour_off)=/.test(s)) { s = legacyToOh(s); if (!s) return Object.assign(() => null, { info }); }
  s = s.replace(/^\(+/, '').replace(/\)+$/, '').trim();                            // 括號不成對也接受
  s = s.replace(/(^|[\s,=])(\d{1,2})-(\d{1,2})(?=$|[\s,;])/g, (m, p, a, b) => `${p}${a.padStart(2, '0')}:00-${b.padStart(2, '0')}:00`);   // 7-9 → 07:00-09:00
  s = s.replace(/\s*,\s*/g, ',').replace(/(\d)\s*[-~]\s*(\d)/g, '$1-$2');
  s = s.replace(/[,;]\s*PH off(?=[,;]|$)/gi, () => { info.ignoredHolidayException = true; return ''; });
  const parts = s.split(/\s+AND\s+/i).map(x => x.trim().replace(/^\(|\)$/g, '').trim());
  const tests = parts.map(part => {
    let rules = splitTop(part).map(parseRule); if (!rules.length || rules.some(r => r == null)) return () => null;
    // 只在國定假日的規則：沒有國定假日日曆 → 有其他規則時忽略它（照平日判斷、記在 info），全部都是假日規則時無法判斷
    if (rules.some(r => r.holidayOnly)) { if (rules.every(r => r.holidayOnly)) return () => null; rules = rules.filter(r => !r.holidayOnly); info.ignoredHolidayException = true; }
    return ms => {
      const d = new Date(ms + TZ_MS), wd = d.getUTCDay(), min = d.getUTCHours() * 60 + d.getUTCMinutes(), prevWd = (wd + 6) % 7;
      let on = false;
      for (const r of rules) {                                                      // 後面的規則覆蓋前面的（opening_hours 的語意）
        let hit = false;
        for (const [a, b] of r.times) {
          if (a <= b) { if ((r.days >> wd) & 1 && min >= a && min < b) hit = true; }
          else if (((r.days >> wd) & 1 && min >= a) || ((r.days >> prevWd) & 1 && min < b)) hit = true;   // 跨午夜：前一天開始的時段延續到今天
        }
        if (hit) on = !r.off;
      }
      return on;
    };
  });
  return Object.assign(ms => { let unknown = false; for (const t of tests) { const v = t(ms); if (v === false) return false; if (v == null) unknown = true; } return unknown ? null : true; }, { info });
}
const cache = new Map();
export function conditionActive(cond, ms) { let f = cache.get(cond); if (!f) { f = compileCondition(cond); if (cache.size > 5000) cache.clear(); cache.set(cond, f); } return f(ms); }
