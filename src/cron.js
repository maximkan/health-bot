const cron = require('node-cron');
const db   = require('./db');
const { getMalaysiaHour, getMalaysiaDateStr, nowContext, getTodayStr } = require('./utils/time');

let _bot = null;
const _onceTimers = new Map(); // key → timeout

const getBotRef = () => _bot;

function init(bot) {
  _bot = bot;
  const tz = { timezone: 'Asia/Kuala_Lumpur' };

  cron.schedule('30 19 * * *', runEveningCheck,        tz); // 7:30 PM
  cron.schedule('30 0  * * *', () => runBedNudge(1),   tz); // 12:30 AM
  cron.schedule('0  2  * * *', () => runBedNudge(2),   tz); // 2:00 AM
  cron.schedule('0  3  * * *', runAutoBed,             tz); // 3:00 AM
  cron.schedule('0  8  * * 1', runWeeklyReview,        tz); // Monday 8 AM
  cron.schedule('0  11 * * *', () => runProactive('11:00'), tz);
  cron.schedule('0  15 * * *', () => runProactive('15:00'), tz);
  cron.schedule('0  19 * * *', () => runProactive('19:00'), tz);
  cron.schedule('0  */2 * * *', runUntimedReminders,   tz); // every 2 hrs
  cron.schedule('*/30 * * * *', runGCalSync,            tz); // every 30 min

  rescheduleAll();
  console.log('✅ Cron jobs scheduled');
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

// ── Auto-bed at 3 AM ──────────────────────────────────────────────────────────

async function runAutoBed() {
  const day = require('./handlers/day');
  const claude = require('./claude');
  const notion = require('./notion');

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake' || !state.bed_nudge_sent) continue;
    try {
      const dayData     = await notion.getDayData(state.current_day_start).catch(() => null);
      let targetsCtx = '';
      try { targetsCtx = await notion.getTargetsText(); } catch {}
      const summaryText = dayData ? await claude.generateDaySummary(dayData, targetsCtx) : 'No data for today.';
      const targets     = await notion.getTargets().catch(() => null);
      if (dayData) await notion.createDailySummaryPage(dayData, summaryText, getMalaysiaDateStr(), targets).catch(() => {});
      db.setState(chatId, { status: 'sleeping', bed_nudge_sent: 0 });
      await _bot.sendMessage(chatId, summaryText + '\n\n(auto-closed — you clearly fell asleep 😴)');
    } catch (e) { console.error('Auto-bed error:', e.message); }
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

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;
    if (db.wasRecentlyActive(chatId, 15)) continue; // skip if user was active in last 15 min

    try {
      const dayStart = state.current_day_start;
      const dayData  = await notion.getDayData(dayStart).catch(() => null);
      if (!dayData) continue;

      const hourMYT  = getMalaysiaHour();
      const noMeals  = dayData.meals.length === 0 && hourMYT >= 14;
      const lastLog  = noMeals ? null : 'recent';

      let targetsCtx = '';
      try { targetsCtx = await notion.getTargetsText(); } catch {}
      const targets = await notion.getTargets().catch(() => ({ calories: 1600, protein: 220, carbs: 80, fat: 53 }));

      const recentData = {
        time: timeLabel,
        today: dayData.totals,
        targets,
        noMealsYet: noMeals,
        caffeine_mg: state.caffeine_today_mg ?? 0,
        last_caffeine_time: state.last_caffeine_time,
        hasWorkout: dayData.workouts.length > 0,
      };

      const rawAlert = await claude.checkProactivePatterns(recentData, targetsCtx);
      const alert = rawAlert ? require('./handlers/ask').stripMarkdown(rawAlert) : null;
      if (alert) {
        const sent = await _bot.sendMessage(chatId, alert);
        db.saveCoachMessage(chatId, 'assistant', alert, sent.message_id);
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
  const gcal  = require('./gcal');
  const { scheduleTimedPlanReminders } = require('./handlers/plans');
  const { getDateAt } = require('./utils/time');
  const todayStr = getMalaysiaDateStr();

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    if (state.status !== 'awake') continue;
    try {
      const events = await gcal.getEventsForDate(todayStr).catch(() => []);
      const existing = new Set(db.getPendingTimed(chatId, todayStr).map(p => p.plan_text.toLowerCase()));
      for (const event of events) {
        if (!event.time || event.allDay) continue;
        if (existing.has(event.title.toLowerCase())) continue;

        const planId = db.savePlan(chatId, { text: event.title, date: todayStr, time: event.time });
        const [h, m] = event.time.split(':').map(Number);
        const eventMs = getDateAt(todayStr, h, m);
        const minsUntil = (eventMs - Date.now()) / 60000;
        const reminderMs = eventMs - 30 * 60 * 1000;

        if (reminderMs > Date.now()) {
          // Normal: reminder window still in future
          scheduleTimedPlanReminders(chatId, planId, { title: event.title, date: todayStr, time: event.time });
        } else if (minsUntil > 0 && minsUntil <= 60) {
          // Reminder window just passed but event still upcoming — fire immediately
          _bot?.sendMessage(chatId, `heads up: ${event.title} at ${event.time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
        }
        console.log(`GCal sync: picked up "${event.title}" at ${event.time}`);
      }
    } catch (e) {
      console.error('GCal sync error:', e.message);
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

  // Also schedule any pending timed plans that have no reminder entry yet
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

      if (reminderMs > Date.now()) {
        // Normal: schedule via full reminder chain
        scheduleTimedPlanReminders(chatId, plan.id, { title: plan.plan_text, date: plan.plan_date, time: plan.plan_time });
      } else if (minsUntil > 0 && minsUntil <= 60) {
        // Reminder window passed but event still upcoming — fire immediately
        _bot?.sendMessage(chatId, `heads up: ${plan.plan_text} at ${plan.plan_time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
      }
    }
  }
}

module.exports = { init, scheduleOnce, rescheduleAll, getBotRef };
