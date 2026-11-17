// util.js

export const esc = t => String(t).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

export const fmtDist = m => m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const hhmm = (busDate, t) => { const m = /^(\d+):(\d+)/.exec(t || ''); return m ? Date.parse(busDate) + (m[1] * 3600 + m[2] * 60) * 1000 : NaN; };

// 允許 24:10 這類跨日時間

export const todayStr = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);

export const fmtClock = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 16), fmtClockS = ms => new Date(ms + 8 * 3600e3).toISOString().slice(11, 19);
