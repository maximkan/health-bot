// ── Time helpers (all timezone-aware) ────────────────────────────────────────

function getOffsetMs(timezone) {
  if (!timezone) throw new Error('getOffsetMs called without timezone');
  const now = new Date();
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
  const utc   = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((local - utc) / 60000) * 60000;
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

function getDayOfWeekTz(tz) {
  if (!tz) throw new Error('getDayOfWeekTz called without tz');
  const offsetMs = getOffsetMs(tz);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.now() + offsetMs).getUTCDay()];
}

// Weekday name (Mon/Tue/...) for a YYYY-MM-DD date string — computed, never guessed by an LLM.
function weekdayForDateStr(dateStr) {
  if (!dateStr) return '';
  // noon UTC avoids any tz/DST edge flipping the day
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

// UTC ms for 00:00 (local) of the current week's Monday, in the user's timezone.
// This is the "this week starts at Monday" anchor. Because activity days are keyed by
// day_start (wake time), filtering day_start >= this value includes Monday's wake onward
// and excludes Sunday's activity day (whose day_start is the previous wake) — i.e. it
// matches "Monday wake → Sunday bed".
function getWeekStartMs(tz) {
  if (!tz) throw new Error('getWeekStartMs called without tz');
  const offsetMs = getOffsetMs(tz);
  const local = new Date(Date.now() + offsetMs);
  const dow = local.getUTCDay();                 // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;          // Mon=0, Sun=6
  const mondayUTCmidnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysSinceMonday);
  return mondayUTCmidnight - offsetMs;            // convert local-midnight back to real UTC ms
}

// Build ISO offset suffix from offsetMs (e.g. +05:30, -08:00)
function buildTzSuffix(offsetMs) {
  const totalMin = Math.round(offsetMs / 60000);
  const sign = totalMin >= 0 ? '+' : '-';
  const absMin = Math.abs(totalMin);
  return `${sign}${String(Math.floor(absMin / 60)).padStart(2,'0')}:${String(absMin % 60).padStart(2,'0')}`;
}

// UTC timestamp → ISO 8601 with tz offset
function tsToISO(ms, tz) {
  if (!tz) throw new Error('tsToISO called without tz');
  const offsetMs = getOffsetMs(tz);
  return new Date(ms + offsetMs).toISOString().slice(0, 19) + buildTzSuffix(offsetMs);
}

// UTC timestamp → "HH:MM" in user's timezone
function tsToTimeStr(ms, tz) {
  if (!tz) throw new Error('tsToTimeStr called without tz');
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
function buildTimeISO(timeStr, tz) {
  if (!tz) throw new Error('buildTimeISO called without tz');
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
function buildDateTimeISO(dateStr, timeStr, tz) {
  if (!tz) throw new Error('buildDateTimeISO called without tz');
  const hm = parseHM(timeStr);
  const h = hm ? hm.h : 9;
  const m = hm ? hm.m : 0;
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00${buildTzSuffix(getOffsetMs(tz))}`;
}

// UTC ms for a specific date at HH:MM in given offset
function getDateAt(dateStr, hourLocal, minLocal = 0, offsetMs) {
  if (offsetMs == null) throw new Error('getDateAt called without offsetMs');
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  const midnightUTC = Date.UTC(yr, mo - 1, dy) - offsetMs;
  return midnightUTC + (hourLocal * 60 + minLocal) * 60000;
}

// Tomorrow's date string in user's timezone
function getTomorrowStrTz(tz) {
  if (!tz) throw new Error('getTomorrowStrTz called without tz');
  const offsetMs = getOffsetMs(tz);
  const d = new Date(Date.now() + offsetMs);
  const tom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return tom.toISOString().split('T')[0];
}

// Current datetime as ISO 8601 string with tz offset
function nowISOTz(tz) {
  if (!tz) throw new Error('nowISOTz called without tz');
  const offsetMs = getOffsetMs(tz);
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19) + buildTzSuffix(offsetMs);
}

// "Tomorrow" relative to an activity day start timestamp (not real calendar day)
// e.g. if user woke up April 23, activityTomorrow = April 24 even if it's now 1am April 24
function getActivityTomorrowStr(dayStartMs, tz) {
  if (!tz) throw new Error('getActivityTomorrowStr called without tz');
  const offsetMs = getOffsetMs(tz);
  const activityDate = new Date(dayStartMs + offsetMs).toISOString().split('T')[0];
  const [y, mo, d] = activityDate.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d + 1)).toISOString().split('T')[0];
}

// Extract a time reference like "9am", "9:30am", "09:30" from text, return UTC ms for today at that time
// Returns null if no time found
function extractTimeMs(text, tz, opts = {}) {
  if (!tz) throw new Error('extractTimeMs called without tz');
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
  // Bare hour ("woke up 9") — only when caller opts in (wake/bed context), since a lone number
  // is ambiguous elsewhere. Taken as a 24h hour: "9" → 09:00. Caller guards future times.
  if (opts.allowBareHour) {
    const mb = text.match(/\b(\d{1,2})\b/);
    if (mb) {
      const h = parseInt(mb[1]);
      if (h >= 0 && h <= 23) return toMs(h, 0);
    }
  }
  return null;
}

// Detect relative date references. Returns { dateStr, dayStartMs } or null.
function detectRetroDate(text, tz) {
  if (!tz) throw new Error('detectRetroDate called without tz');
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
  tsToISO, tsToTimeStr, buildTimeISO, buildDateTimeISO,
  getDateAt, getActivityTomorrowStr, extractTimeMs, detectRetroDate,
  getOffsetMs, getDateStrTz, getHourTz, nowContextTz, getTomorrowStrTz, nowISOTz,
  getDayOfWeekTz, weekdayForDateStr, getWeekStartMs, requireTimezone,
};
