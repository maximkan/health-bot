const { google } = require('googleapis');
const { getOffsetMs } = require('./utils/time');

function tzSuffix(offsetMs) {
  const t = Math.round(offsetMs / 60000); const sign = t >= 0 ? '+' : '-'; const a = Math.abs(t);
  return `${sign}${String(Math.floor(a / 60)).padStart(2,'0')}:${String(a % 60).padStart(2,'0')}`;
}

const CALLBACK_URL = process.env.GCAL_CALLBACK_URL || 'http://204.168.220.82:3000/auth/gcal/callback';

function getOAuthClient(chatId) {
  const db = require('./db');
  const state = db.getState(chatId);
  const refreshToken = state?.gcal_refresh_token || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) return null;
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL,
  );
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function getAuthUrl(chatId) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL,
  );
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: String(chatId),
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    CALLBACK_URL,
  );
  const { tokens } = await client.getToken(code);
  return tokens.refresh_token;
}

async function createEvent(chatId, plan) {
  const client = getOAuthClient(chatId);
  if (!client) return null;
  const cal = google.calendar({ version: 'v3', auth: client });
  const { title, date, time, duration_min = 60, location, guests = [] } = plan;
  const db = require('./db');
  const tz = db.getState(chatId).timezone || 'Asia/Kuala_Lumpur';
  const suf = tzSuffix(getOffsetMs(tz));
  const startISO = `${date}T${time}:00${suf}`;
  const [h, m] = time.split(':').map(Number);
  const totalMin = h * 60 + m + duration_min;
  const endH = String(Math.floor(totalMin / 60) % 24).padStart(2, '00');
  const endM = String(totalMin % 60).padStart(2, '0');
  const endISO = `${date}T${endH}:${endM}:00${suf}`;
  const event = {
    summary: title,
    start: { dateTime: startISO, timeZone: tz },
    end:   { dateTime: endISO,   timeZone: tz },
  };
  if (location) event.location = location;
  const validGuests = (guests || []).filter(e => typeof e === 'string' && e.includes('@'));
  if (validGuests.length) event.attendees = validGuests.map(e => ({ email: e }));
  const res = await cal.events.insert({ calendarId: 'primary', resource: event });
  return res.data;
}

async function getEventsForDate(chatId, dateStr) {
  const client = getOAuthClient(chatId);
  if (!client) return [];
  const db = require('./db');
  const tz = db.getState(chatId).timezone || 'Asia/Kuala_Lumpur';
  const offsetMs = getOffsetMs(tz);
  const suf = tzSuffix(offsetMs);
  const cal = google.calendar({ version: 'v3', auth: client });
  const timeMin = `${dateStr}T00:00:00${suf}`;
  const timeMax = `${dateStr}T23:59:59${suf}`;
  try {
    const res = await cal.events.list({
      calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime',
    });
    return (res.data.items || []).map(e => {
      let time = null;
      if (e.start?.dateTime) {
        const utcMs = new Date(e.start.dateTime).getTime();
        const local = new Date(utcMs + offsetMs);
        time = `${String(local.getUTCHours()).padStart(2,'0')}:${String(local.getUTCMinutes()).padStart(2,'0')}`;
      }
      return { title: e.summary || '(no title)', time, allDay: !!e.start?.date, id: e.id };
    });
  } catch { return []; }
}

async function deleteEvent(chatId, eventId) {
  const client = getOAuthClient(chatId);
  if (!client) return;
  const cal = google.calendar({ version: 'v3', auth: client });
  await cal.events.delete({ calendarId: 'primary', eventId }).catch(() => {});
}

module.exports = { createEvent, getEventsForDate, deleteEvent, getAuthUrl, exchangeCode };
