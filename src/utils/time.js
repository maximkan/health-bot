const OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8 Malaysia

// ── Per-user timezone helpers ─────────────────────────────────────────────────

function getOffsetMs(timezone) {
  if (!timezone || timezone === 'Asia/Kuala_Lumpur') return OFFSET_MS;
  try {
    const now = new Date();
    const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const utc   = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
    return Math.round((local - utc) / 60000) * 60000;
  } catch { return OFFSET_MS; }
}

function getDateStrTz(timezone) {
  const off = getOffsetMs(timezone);
  return new Date(Date.now() + off).toISOString().split('T')[0];
}

function getHourTz(timezone) {
  return new Date(Date.now() + getOffsetMs(timezone)).getUTCHours();
}

function nowContextTz(timezone) {
  const off  = getOffsetMs(timezone);
  const d    = new Date(Date.now() + off);
  let tzLabel = timezone;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' }).formatToParts(new Date());
    tzLabel = parts.find(p => p.type === 'timeZoneName')?.value || tzLabel;
  } catch {}
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = new Date(Date.now() + off).toISOString().split('T')[0];
  const h = String(d.getUTCHours()).padStart(2,'0');
  const m = String(d.getUTCMinutes()).padStart(2,'0');
  return `Current time: ${dateStr} ${h}:${m} (${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${tzLabel})`;
}

function getMalaysiaDate() { return new Date(Date.now() + OFFSET_MS); }
function getMalaysiaISO()  { return getMalaysiaDate().toISOString().replace('Z', '+08:00'); }
function getMalaysiaDateStr() { return getMalaysiaDate().toISOString().split('T')[0]; }
function getMalaysiaHour()    { return getMalaysiaDate().getUTCHours(); }

function getDayOfWeek() {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][getMalaysiaDate().getUTCDay()];
}

function getTodayRange() {
  const d = getMalaysiaDateStr();
  return { start: `${d}T00:00:00+08:00`, end: `${d}T23:59:59+08:00` };
}

// Build ISO offset suffix from offsetMs (e.g. +05:30, -08:00)
function buildTzSuffix(offsetMs) {
  const totalMin = Math.round(offsetMs / 60000);
  const sign = totalMin >= 0 ? '+' : '-';
  const absMin = Math.abs(totalMin);
  return `${sign}${String(Math.floor(absMin / 60)).padStart(2,'0')}:${String(absMin % 60).padStart(2,'0')}`;
}

// UTC timestamp → ISO 8601 with tz offset
function tsToISO(ms, tz = 'Asia/Kuala_Lumpur') {
  const offsetMs = getOffsetMs(tz);
  return new Date(ms + offsetMs).toISOString().slice(0, 19) + buildTzSuffix(offsetMs);
}

// UTC timestamp → "HH:MM" in user's timezone
function tsToTimeStr(ms, tz = 'Asia/Kuala_Lumpur') {
  const d = new Date(ms + getOffsetMs(tz));
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

// Parse a time string in any reasonable format → { h, m } or null
function parseHM(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  if (s.includes(':')) {
    const [h, m] = s.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m)) return { h, m };
  }
  const n = parseInt(s);
  if (!isNaN(n) && n >= 0 && n <= 23) return { h: n, m: 0 };
  return null;
}

// "14:00" or "14" → ISO for today at that time in user's timezone
function buildTimeISO(timeStr, tz = 'Asia/Kuala_Lumpur') {
  const offsetMs = getOffsetMs(tz);
  const hm = parseHM(timeStr);
  const d = new Date(Date.now() + offsetMs);
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2,'0');
  const dy = String(d.getUTCDate()).padStart(2,'0');
  const h = hm ? hm.h : d.getUTCHours();
  const m = hm ? hm.m : d.getUTCMinutes();
  return `${yr}-${mo}-${dy}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00${buildTzSuffix(offsetMs)}`;
}

// Build ISO for a specific YYYY-MM-DD date + time string in user's timezone
function buildDateTimeISO(dateStr, timeStr, tz = 'Asia/Kuala_Lumpur') {
  const hm = parseHM(timeStr);
  const h = hm ? hm.h : 9;
  const m = hm ? hm.m : 0;
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00${buildTzSuffix(getOffsetMs(tz))}`;
}

// UTC ms for tomorrow at HH:MM MYT
function getTomorrowAt(hourMYT, minMYT = 0) {
  const nowMYT = getMalaysiaDate();
  const midnightUTC = Date.UTC(nowMYT.getUTCFullYear(), nowMYT.getUTCMonth(), nowMYT.getUTCDate() + 1) - OFFSET_MS;
  return midnightUTC + (hourMYT * 60 + minMYT) * 60000;
}

// UTC ms for a specific date at HH:MM in given offset (defaults to MYT/UTC+8)
function getDateAt(dateStr, hourLocal, minLocal = 0, offsetMs = OFFSET_MS) {
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  const midnightUTC = Date.UTC(yr, mo - 1, dy) - offsetMs;
  return midnightUTC + (hourLocal * 60 + minLocal) * 60000;
}

// Today and tomorrow as YYYY-MM-DD strings
function getTodayStr()    { return getMalaysiaDateStr(); }
function getTomorrowStr() {
  const d = getMalaysiaDate();
  const tom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return tom.toISOString().split('T')[0];
}

// Tomorrow's date string in user's timezone
function getTomorrowStrTz(tz = 'Asia/Kuala_Lumpur') {
  const offsetMs = getOffsetMs(tz);
  const d = new Date(Date.now() + offsetMs);
  const tom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return tom.toISOString().split('T')[0];
}

// Current datetime as ISO 8601 string with tz offset
function nowISOTz(tz = 'Asia/Kuala_Lumpur') {
  const offsetMs = getOffsetMs(tz);
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19) + buildTzSuffix(offsetMs);
}

// "Tomorrow" relative to an activity day start timestamp (not real calendar day)
// e.g. if user woke up April 23, activityTomorrow = April 24 even if it's now 1am April 24
function getActivityTomorrowStr(dayStartMs, tz = 'Asia/Kuala_Lumpur') {
  const offsetMs = getOffsetMs(tz);
  const activityDate = new Date(dayStartMs + offsetMs).toISOString().split('T')[0];
  const [y, mo, d] = activityDate.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().split('T')[0];
}

// Current MYT date/time as human-readable string for prompts
function nowContext() {
  const d = getMalaysiaDate();
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayName  = days[d.getUTCDay()];
  const monthStr = months[d.getUTCMonth()];
  const dayNum   = d.getUTCDate();
  const dateStr  = getMalaysiaDateStr();
  const h = String(d.getUTCHours()).padStart(2,'0');
  const m = String(d.getUTCMinutes()).padStart(2,'0');
  return `Current time: ${dateStr} ${h}:${m} (${dayName} ${monthStr} ${dayNum}, Malaysia time MYT)`;
}

// Extract a time reference like "9am", "9:30am", "09:30" from text, return UTC ms for today at that time MYT
// Returns null if no time found
function extractTimeMs(text, tz = 'Asia/Kuala_Lumpur') {
  if (!text) return null;
  const offsetMs = getOffsetMs(tz);
  const offsetH  = Math.round(offsetMs / 3600000);
  const sign     = offsetH >= 0 ? '+' : '-';
  const absH     = Math.abs(offsetH);
  const tzSuffix = `${sign}${String(absH).padStart(2,'0')}:00`;
  const dateStr  = new Date(Date.now() + offsetMs).toISOString().split('T')[0];

  const toMs = (h, min) => new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00${tzSuffix}`).getTime();

  // "HH:MM" 24h
  let m = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return toMs(h, min);
  }
  // "Xam" / "Xpm" / "X:XXam"
  m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1]);
    const min = parseInt(m[2] || '0');
    const ampm = m[3].toLowerCase();
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    return toMs(h, min);
  }
  return null;
}

// Detect relative date references. Returns { dateStr, dayStartMs } or null.
function detectRetroDate(text, tz = 'Asia/Kuala_Lumpur') {
  if (!text) return null;
  const lc = text.toLowerCase();
  const offsetMs = getOffsetMs(tz);
  const todayUtc = new Date(Date.now() + offsetMs);
  const y = todayUtc.getUTCFullYear(), m = todayUtc.getUTCMonth(), d = todayUtc.getUTCDate();

  const isYesterday = /\b(yesterday|last night|yesterday night|yesterday evening|yesterday morning)\b/.test(lc);
  if (isYesterday) {
    const past = new Date(Date.UTC(y, m, d - 1));
    return { dateStr: past.toISOString().split('T')[0], dayStartMs: past.getTime() - offsetMs };
  }

  const daysAgo = lc.match(/\b([2-7])\s+days?\s+ago\b/);
  if (daysAgo) {
    const n = parseInt(daysAgo[1]);
    const past = new Date(Date.UTC(y, m, d - n));
    return { dateStr: past.toISOString().split('T')[0], dayStartMs: past.getTime() - offsetMs };
  }

  return null;
}

function requireTimezone(state) {
  if (!state?.timezone) {
    throw new Error('timezone missing — complete onboarding to fix.');
  }
  return state.timezone;
}

module.exports = {
  getMalaysiaISO, getMalaysiaDateStr, getMalaysiaHour, getDayOfWeek, getTodayRange,
  tsToISO, tsToTimeStr, buildTimeISO, buildDateTimeISO,
  getTomorrowAt, getDateAt, getTodayStr, getTomorrowStr, getActivityTomorrowStr, nowContext, extractTimeMs,
  detectRetroDate,
  getOffsetMs, getDateStrTz, getHourTz, nowContextTz, getTomorrowStrTz, nowISOTz,
  requireTimezone,
};
