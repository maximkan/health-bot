const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '../credentials.json'))).installed;

const oauth2Client = new google.auth.OAuth2(
  creds.client_id,
  creds.client_secret,
  'http://localhost:3123'
);

oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// Create a calendar event from a plan object { title, date, time, duration_min, location, guests }
async function createEvent(plan) {
  const { title, date, time, duration_min = 60, location, guests = [] } = plan;
  const startISO = `${date}T${time}:00+08:00`;
  const [h, m] = time.split(':').map(Number);
  const totalMin = h * 60 + m + duration_min;
  const endH = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const endM = String(totalMin % 60).padStart(2, '0');
  const endISO = `${date}T${endH}:${endM}:00+08:00`;

  const event = {
    summary: title,
    start: { dateTime: startISO, timeZone: 'Asia/Kuala_Lumpur' },
    end:   { dateTime: endISO,   timeZone: 'Asia/Kuala_Lumpur' },
  };
  if (location) event.location = location;
  if (guests.length) event.attendees = guests.map(e => ({ email: e }));

  const res = await calendar.events.insert({ calendarId: 'primary', resource: event });
  return res.data;
}

// Get events for a date string "YYYY-MM-DD" (MYT)
async function getEventsForDate(dateStr) {
  const timeMin = `${dateStr}T00:00:00+08:00`;
  const timeMax = `${dateStr}T23:59:59+08:00`;
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (res.data.items || []).map(e => ({
    title: e.summary || '(no title)',
    time:  e.start?.dateTime ? e.start.dateTime.slice(11, 16) : null,
    allDay: !!e.start?.date,
    id: e.id,
  }));
}

module.exports = { createEvent, getEventsForDate };
