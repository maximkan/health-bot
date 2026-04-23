const OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8 Malaysia

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

// UTC timestamp → ISO 8601 with +08:00
function tsToISO(ms) {
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 19) + '+08:00';
}

// UTC timestamp → "HH:MM" MYT
function tsToTimeStr(ms) {
  const d = new Date(ms + OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

// "14:00" → ISO for today at that time in MYT
function buildTimeISO(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const d = getMalaysiaDate();
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2,'0');
  const dy = String(d.getUTCDate()).padStart(2,'0');
  return `${yr}-${mo}-${dy}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+08:00`;
}

// Build ISO for a specific YYYY-MM-DD date + "HH:MM" time in MYT
function buildDateTimeISO(dateStr, timeStr) {
  if (!timeStr) return `${dateStr}T09:00:00+08:00`;
  const [h, m] = timeStr.split(':').map(Number);
  return `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+08:00`;
}

// UTC ms for tomorrow at HH:MM MYT
function getTomorrowAt(hourMYT, minMYT = 0) {
  const nowMYT = getMalaysiaDate();
  const midnightUTC = Date.UTC(nowMYT.getUTCFullYear(), nowMYT.getUTCMonth(), nowMYT.getUTCDate() + 1) - OFFSET_MS;
  return midnightUTC + (hourMYT * 60 + minMYT) * 60000;
}

// UTC ms for a specific date at HH:MM MYT
function getDateAt(dateStr, hourMYT, minMYT = 0) {
  const [yr, mo, dy] = dateStr.split('-').map(Number);
  const midnightUTC = Date.UTC(yr, mo - 1, dy) - OFFSET_MS;
  return midnightUTC + (hourMYT * 60 + minMYT) * 60000;
}

// Today and tomorrow as YYYY-MM-DD strings
function getTodayStr()    { return getMalaysiaDateStr(); }
function getTomorrowStr() {
  const d = getMalaysiaDate();
  const tom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return tom.toISOString().split('T')[0];
}

// "Tomorrow" relative to an activity day start timestamp (not real calendar day)
// e.g. if user woke up April 23, activityTomorrow = April 24 even if it's now 1am April 24
function getActivityTomorrowStr(dayStartMs) {
  const activityDate = new Date(dayStartMs + OFFSET_MS).toISOString().split('T')[0];
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
function extractTimeMs(text) {
  if (!text) return null;
  // "HH:MM" 24h
  let m = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (m) {
    const h = parseInt(m[1]), min = parseInt(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      const OFFSET = 8 * 60 * 60 * 1000;
      const d = new Date(Date.now() + OFFSET);
      const dateStr = d.toISOString().split('T')[0];
      return new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00+08:00`).getTime();
    }
  }
  // "Xam" / "X pm" / "X:XXam"
  m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1]);
    const min = parseInt(m[2] || '0');
    const ampm = m[3].toLowerCase();
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    if (h < 0 || h > 23) return null;
    const OFFSET = 8 * 60 * 60 * 1000;
    const d = new Date(Date.now() + OFFSET);
    const dateStr = d.toISOString().split('T')[0];
    return new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00+08:00`).getTime();
  }
  return null;
}

module.exports = {
  getMalaysiaISO, getMalaysiaDateStr, getMalaysiaHour, getDayOfWeek, getTodayRange,
  tsToISO, tsToTimeStr, buildTimeISO, buildDateTimeISO,
  getTomorrowAt, getDateAt, getTodayStr, getTomorrowStr, getActivityTomorrowStr, nowContext, extractTimeMs,
};
