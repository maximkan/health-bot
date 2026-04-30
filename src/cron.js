const cron = require('node-cron');
const db   = require('./db');
const { getMalaysiaHour, getMalaysiaDateStr, nowContext, getTodayStr, getTomorrowStr } = require('./utils/time');

let _bot = null;
const _onceTimers = new Map(); // key → timeout

const getBotRef = () => _bot;

function init(bot) {
  _bot = bot;
  const tz = { timezone: 'Asia/Kuala_Lumpur' };

  cron.schedule('30 19 * * *', runEveningCheck,        tz); // 7:30 PM
  cron.schedule('30 0  * * *', () => runBedNudge(1),   tz); // 12:30 AM
  cron.schedule('0  2  * * *', () => runBedNudge(2),   tz); // 2:00 AM
  // Weekly review triggered on Monday morning wake instead of fixed 8am cron
  cron.schedule('0  8  * * *', scheduleProactiveForDay, tz); // reschedule daily at 8am
  cron.schedule('0  */2 * * *', runUntimedReminders,   tz); // every 2 hrs
  cron.schedule('*/30 * * * *', runGCalSync,            tz); // every 30 min

  scheduleProactiveForDay();
  rescheduleAll();
  console.log('✅ Cron jobs scheduled');
}

// ── Randomised proactive checks ───────────────────────────────────────────────

function scheduleProactiveForDay() {
  const { getDateAt, getMalaysiaDateStr } = require('./utils/time');
  const todayStr = getMalaysiaDateStr();
  const windows = [[10, 13], [14, 17], [19, 21]];
  for (const [start, end] of windows) {
    const h = start + Math.floor(Math.random() * (end - start));
    const m = Math.floor(Math.random() * 60);
    const fireMs = getDateAt(todayStr, h, m);
    const delay = fireMs - Date.now();
    if (delay > 0) {
      const label = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      setTimeout(() => runProactive(label), delay);
      console.log(`Proactive check scheduled at ${label}`);
    }
  }
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function runEveningCheck() {
  const day = require('./handlers/day');
  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;
    try { await day.sendEveningCheck(_bot, chatId, state.current_day_start); }
    catch (e) { console.error('Evening check error:', e.message); }
  }
}

// ── Bed nudges ────────────────────────────────────────────────────────────────

async function runBedNudge(nudgeNum) {
  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;
    if (nudgeNum === 2 && !state.bed_nudge_sent) continue; // only send 2nd if 1st was sent
    const msg = nudgeNum === 1 ? 'heading to bed soon?' : 'still up? you should sleep.';
    try {
      await _bot.sendMessage(chatId, msg);
      if (nudgeNum === 1) db.setState(chatId, { bed_nudge_sent: 1 });
    } catch (e) { console.error('Bed nudge error:', e.message); }
  }
}

// ── Weekly review ─────────────────────────────────────────────────────────────

async function runWeeklyReview() {
  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') {
      db.setState(chatId, { weekly_waiting_weight: 1 });
      continue;
    }
    try {
      await _bot.sendMessage(chatId, 'weekly check-in — what\'s the scale saying? weight and body fat if you have it.');
      db.setState(chatId, { weekly_waiting_weight: 1 });
    } catch (e) { console.error('Weekly review error:', e.message); }
  }
}

// ── Proactive pattern detection ───────────────────────────────────────────────

async function runProactive(timeLabel) {
  const claude = require('./claude');
  const notion = require('./notion');
  const todayStr = getMalaysiaDateStr();

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;
    if (db.wasRecentlyActive(chatId, 15)) continue; // skip if user was active in last 15 min

    try {
      const dayStart = state.current_day_start;
      const dayData  = await notion.getDayData(chatId, dayStart).catch(() => null);
      if (!dayData) continue;

      const hoursAwake = dayStart ? (Date.now() - dayStart) / 3600000 : 0;
      const noMeals  = dayData.meals.length === 0 && hoursAwake >= 4;
      const lastLog  = noMeals ? null : 'recent';

      const targetsCtx = notion.getTargetsText(chatId);
      const targets = notion.getTargets(chatId);

      // Fetch last 7 days for weekly pattern detection
      const weekData = db.getWeekDataFromSQLite(chatId, Date.now() - 7 * 24 * 3600 * 1000);
      const recentWeek = weekData?.dailyTotals ?? null;

      // Include recent bot messages so Claude knows what it already flagged
      const recentAlerts = db.getHistory(chatId, 30)
        .filter(m => m.role === 'assistant')
        .slice(-6)
        .map(m => m.text.slice(0, 200));

      const todayAlert = (state.last_proactive_date === todayStr && state.last_proactive_msg)
        ? state.last_proactive_msg : null;

      const recentData = {
        time: timeLabel,
        today: { ...dayData.totals, meals: dayData.meals.map(m => m.name) },
        targets,
        noMealsYet: noMeals,
        caffeine_mg: state.caffeine_today_mg ?? 0,
        last_caffeine_time: state.last_caffeine_time,
        hasWorkout: dayData.workouts.length > 0,
        recentWeek,
        recentAlerts,
        todayAlert,
      };

      const rawAlert = await claude.checkProactivePatterns(recentData, targetsCtx, state);
      const alert = rawAlert ? require('./handlers/ask').stripMarkdown(rawAlert) : null;
      if (alert) {
        const sent = await _bot.sendMessage(chatId, alert);
        db.saveCoachMessage(chatId, 'assistant', alert, sent.message_id);
        db.setState(chatId, { last_proactive_date: todayStr, last_proactive_msg: alert.slice(0, 200) });
      }
    } catch (e) { console.error('Proactive check error:', e.message); }
  }
}

// ── Untimed task reminders (every 2 hours) ────────────────────────────────────

async function runUntimedReminders() {
  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;

    const tasks = db.getPendingUntimed(chatId);
    if (!tasks.length) continue;

    try {
      const msg = tasks.length === 1
        ? `reminder: ${tasks[0].plan_text}`
        : `don't forget today: ${tasks.map(t => t.plan_text).join(', ')}`;
      await _bot.sendMessage(chatId, msg);
      for (const task of tasks) db.markPlanReminded(task.id);
    } catch (e) { console.error('Untimed reminder error:', e.message); }
  }
}

// ── GCal mid-day sync ─────────────────────────────────────────────────────────

async function runGCalSync() {
  const gcal   = require('./gcal');
  const notion = require('./notion');
  const { scheduleTimedPlanReminders } = require('./handlers/plans');
  const { getDateAt } = require('./utils/time');
  const todayStr    = getMalaysiaDateStr();
  const tomorrowStr = getTomorrowStr();
  const dayAfterStr = (() => {
    const [y, m, d] = tomorrowStr.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split('T')[0];
  })();
  const datesToSync = [todayStr, tomorrowStr, dayAfterStr];

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);

    // GCal → DB: import GCal events missing from DB (today + next 2 days)
    for (const dateStr of datesToSync) {
      try {
        const events = await gcal.getEventsForDate(chatId, dateStr).catch(() => []);
        const existing = new Set(db.getPendingTimed(chatId, dateStr).map(p => p.plan_text.toLowerCase()));
        for (const event of events) {
          if (!event.time || event.allDay) continue;
          if (existing.has(event.title.toLowerCase())) continue;

          const planId = db.savePlan(chatId, { text: event.title, date: dateStr, time: event.time });
          db.setPlanGCalId(planId, event.id);
          const [h, m] = event.time.split(':').map(Number);
          const eventMs = getDateAt(dateStr, h, m);
          const minsUntil = (eventMs - Date.now()) / 60000;
          const reminderMs = eventMs - 30 * 60 * 1000;

          if (reminderMs > Date.now()) {
            scheduleTimedPlanReminders(chatId, planId, { title: event.title, date: dateStr, time: event.time });
          } else if (dateStr === todayStr && minsUntil > 0 && minsUntil <= 60) {
            _bot?.sendMessage(chatId, `heads up: ${event.title} at ${event.time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
          }

          try {
            const notionPage = await notion.createPlanEntry({ title: event.title, date: dateStr, time: event.time });
            if (notionPage?.id) db.setPlanNotionId(planId, notionPage.id);
          } catch (err) { console.error('GCal→Notion sync error:', err.message); }

          console.log(`GCal sync: picked up "${event.title}" at ${event.time} on ${dateStr}`);
        }
      } catch (e) {
        console.error(`GCal sync error for ${dateStr}:`, e.message);
      }
    }

    // DB → GCal: create GCal events for DB plans missing from GCal (today + next 2 days)
    if (state.status === 'awake') {
      for (const dateStr of datesToSync) {
        try {
          const plans = db.getPendingTimed(chatId, dateStr).filter(p => !p.calendar_event_created && !p.gcal_event_id);
          for (const plan of plans) {
            try {
              const ev = await gcal.createEvent(chatId, { title: plan.plan_text, date: dateStr, time: plan.plan_time, guests: [] });
              db.setPlanCalendar(plan.id);
              if (ev?.id) db.setPlanGCalId(plan.id, ev.id);
              console.log(`DB→GCal: created event "${plan.plan_text}" on ${dateStr}`);
            } catch (err) { console.error(`DB→GCal error for "${plan.plan_text}":`, err.message); }
          }
        } catch (e) {
          console.error(`DB→GCal sync error for ${dateStr}:`, e.message);
        }
      }
    }
  }
}

// ── One-shot timers ───────────────────────────────────────────────────────────

function scheduleOnce(chatId, atMs, fn) {
  const delay = atMs - Date.now();
  if (delay <= 0) { fn(); return; }
  const key = `${chatId}_${atMs}`;
  if (_onceTimers.has(key)) return;
  const handle = setTimeout(async () => {
    _onceTimers.delete(key);
    try { await fn(); } catch (e) { console.error('Scheduled task error:', e.message); }
  }, delay);
  _onceTimers.set(key, handle);
}

function rescheduleAll() {
  db.cleanOldReminders();

  // Re-fire persisted reminders
  const pending = db.getPendingReminders();
  for (const r of pending) {
    scheduleOnce(r.chat_id, r.fire_ms, async () => {
      db.markReminderFired(r.id);
      try { await _bot.sendMessage(r.chat_id, r.text); } catch (e) { console.error('Reminder send error:', e.message); }
    });
  }
  if (pending.length) console.log(`✅ Rescheduled ${pending.length} persisted reminder(s)`);

  // Schedule plans that have no reminder in DB yet (avoid duplicates)
  const scheduledKeys = new Set(pending.map(r => `${r.chat_id}_${r.fire_ms}`));
  const { scheduleTimedPlanReminders } = require('./handlers/plans');
  const { getDateAt } = require('./utils/time');
  for (const chatId of db.getAllChatIds()) {
    const today = getMalaysiaDateStr();
    const timedPlans = db.getPendingTimed(chatId, today);
    for (const plan of timedPlans) {
      const [h, m] = (plan.plan_time || '00:00').split(':').map(Number);
      if (isNaN(h) || isNaN(m)) continue;
      const eventMs = getDateAt(plan.plan_date, h, m);
      const reminderMs = eventMs - 30 * 60 * 1000;
      const minsUntil = (eventMs - Date.now()) / 60000;

      if (reminderMs > Date.now() && !scheduledKeys.has(`${chatId}_${reminderMs}`)) {
        // No existing reminder in DB — create one
        scheduleTimedPlanReminders(chatId, plan.id, { title: plan.plan_text, date: plan.plan_date, time: plan.plan_time });
      } else if (minsUntil > 0 && minsUntil <= 60 && !scheduledKeys.has(`${chatId}_${reminderMs}`)) {
        // Reminder window passed but event still upcoming and no DB entry — fire immediately
        _bot?.sendMessage(chatId, `heads up: ${plan.plan_text} at ${plan.plan_time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
      }
    }
  }
}

module.exports = { init, scheduleOnce, rescheduleAll, getBotRef };
