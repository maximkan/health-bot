const cron = require('node-cron');
const db   = require('./db');
const { getOffsetMs, getDateAt, getDateStrTz, requireTimezone } = require('./utils/time');

function buildProactiveDataBlock(recentData) {
  const { today, targets, recentWeek, recentAlerts, todayAlert, caffeine_mg, last_caffeine_time, hasWorkout, last_sleep, noMealsYet, minutesAwake } = recentData;
  const lines = [];

  if (today && targets) {
    const macroLine = (name, actual, target, dir) => {
      if (actual == null || target == null) return `- ${name}: not logged`;
      const diff = Math.round(actual - target);
      if (dir === 'over'  && diff > 0)  return `- ${name}: ${Math.round(actual)} / ${target} target  [OVER ${diff}] [FLAG]`;
      if (dir === 'under' && diff < 0)  return `- ${name}: ${Math.round(actual)} / ${target} target  [UNDER ${-diff}] [FLAG]`;
      return `- ${name}: ${Math.round(actual)} / ${target} target  [OK]`;
    };
    lines.push('Today\'s macros:');
    lines.push(macroLine('calories', today.calories, targets.calories, 'over'));
    lines.push(macroLine('protein',  today.protein,  targets.protein,  'under'));
    lines.push(macroLine('carbs',    today.carbs,    targets.carbs,    'over'));
    lines.push(macroLine('fat',      today.fat,      targets.fat,      'over'));
    lines.push('');
  }

  // Hide meals section entirely when <4h awake AND nothing logged — Claude cannot see it
  const hideMeals = (minutesAwake < 240) && (!today?.meals || today.meals.length === 0);
  if (!hideMeals) {
    if (today?.meals && today.meals.length > 0) {
      lines.push(`Today's meals (${today.meals.length}): ${today.meals.join(', ')}`);
    } else if (noMealsYet) {
      lines.push('Today\'s meals: NONE LOGGED in 4+ hours awake  [FLAG]');
    }
    lines.push('');
  }

  lines.push(`Today's workout: ${hasWorkout ? 'logged' : 'none'}`);
  lines.push('');

  const caffeineFlag = (caffeine_mg ?? 0) > 400;
  lines.push(`Caffeine today: ${caffeine_mg ?? 0}mg${caffeineFlag ? '  [OVER 400 — FLAG]' : ''}${last_caffeine_time ? ` (last at ${last_caffeine_time})` : ''}`);
  lines.push('');

  if (last_sleep) {
    lines.push(`Last sleep: ${last_sleep.hours}h quality ${last_sleep.quality}/5`);
    lines.push('');
  }

  if (recentWeek) {
    lines.push('This week so far:');
    lines.push(`- Training days: ${recentWeek.trainDays ?? 0}`);
    lines.push(`- Avg sleep: ${recentWeek.avgSleep ?? '?'}h, quality ${recentWeek.avgSleepQuality ?? '?'}/5`);
    if (Array.isArray(recentWeek.dailyTotals)) {
      const lowProteinDays = recentWeek.dailyTotals.filter(d => d.protein != null && targets?.protein && d.protein < targets.protein * 0.8).length;
      const overCalDays    = recentWeek.dailyTotals.filter(d => d.calories != null && targets?.calories && d.calories > targets.calories * 1.1).length;
      if (lowProteinDays >= 2) lines.push(`- Days under 80% protein target: ${lowProteinDays}  [FLAG]`);
      if (overCalDays    >= 2) lines.push(`- Days over 110% calorie target: ${overCalDays}  [FLAG]`);
    }
    lines.push('');
  }

  if (todayAlert) {
    lines.push(`Today's nudge already sent (HARD BLOCK on same category): "${todayAlert.slice(0, 120)}"`);
    lines.push('');
  }

  if (recentAlerts?.length) {
    lines.push('Recent assistant messages (for escalation calibration only):');
    for (const m of recentAlerts.slice(-3)) lines.push(`- ${m.slice(0, 120)}`);
  }

  return lines.join('\n');
}

let _bot = null;
const _onceTimers = new Map(); // key → timeout

const getBotRef = () => _bot;

function init(bot) {
  _bot = bot;

  // Per-user daily crons — each fires in the user's own timezone
  for (const chatId of db.getAllChatIds()) {
    scheduleUserDailyCrons(chatId);
    scheduleProactiveForDay(chatId); // schedule today's proactive windows on startup
  }

  // Global crons (timezone-independent)
  cron.schedule('*/30 * * * *', runGCalSync);

  // Schedule untimed reminders for already-awake users (e.g. after server restart)
  for (const chatId of db.getAllChatIds()) {
    const s = db.getState(chatId);
    if (s.status === 'awake' && s.current_day_start) {
      scheduleUntimedRemindersForUser(chatId, s.current_day_start);
    }
  }

  scheduleAllBedNudges();
  rescheduleAll();
  console.log('✅ Cron jobs scheduled');
}

function scheduleUserDailyCrons(chatId) {
  const state = db.getState(chatId);
  const tz = requireTimezone(state);
  const opts = { timezone: tz };
  // Evening check at 19:30 in user's local time
  cron.schedule('30 19 * * *', () => runEveningCheckForUser(chatId), opts);
  // Morning setup at 8:00 in user's local time
  cron.schedule('0 8 * * *', () => {
    scheduleProactiveForDay(chatId);
    scheduleBedNudgesForDay(chatId);
  }, opts);
}

// ── Randomised proactive checks ───────────────────────────────────────────────

function scheduleProactiveForDay(chatId) {
  const state = db.getState(chatId);
  const tz = requireTimezone(state);
  const offsetMs = getOffsetMs(tz);
  const todayStr = getDateStrTz(tz);
  const windows = [[10, 13], [14, 17], [19, 21]];
  for (const [start, end] of windows) {
    const h = start + Math.floor(Math.random() * (end - start));
    const m = Math.floor(Math.random() * 60);
    const fireMs = getDateAt(todayStr, h, m, offsetMs);
    const delay = fireMs - Date.now();
    if (delay > 0) {
      const label = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      setTimeout(() => runProactiveForUser(chatId, label), delay);
      console.log(`Proactive check for ${chatId} scheduled at ${label} (${tz})`);
    }
  }
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function runEveningCheckForUser(chatId) {
  const day = require('./handlers/day');
  const state = db.getState(chatId);
  if (state.status !== 'awake') return;
  try { await day.sendEveningCheck(_bot, chatId, state.current_day_start); }
  catch (e) { console.error('Evening check error:', e.message); }
}

// ── Bed nudges — per user, based on bed_time_pref ────────────────────────────

function scheduleBedNudgesForDay(chatId) {
  const state = db.getState(chatId);
  if (state.status !== 'awake') return;

  const tz = requireTimezone(state);
  const offsetMs = getOffsetMs(tz);

  let bedH = 0, bedM = 30; // default 00:30 user-local time
  if (state.bed_time_pref) {
    const parts = state.bed_time_pref.split(':').map(Number);
    if (!isNaN(parts[0])) { bedH = parts[0]; bedM = parts[1] ?? 0; }
  }

  const todayStr    = getDateStrTz(tz);
  const tomorrowStr = new Date(Date.now() + offsetMs + 86400000).toISOString().split('T')[0];
  let nudge1Ms = getDateAt(todayStr, bedH, bedM, offsetMs);
  // If already past (or within 5 min), schedule for tomorrow
  if (nudge1Ms <= Date.now() + 5 * 60 * 1000) {
    nudge1Ms = getDateAt(tomorrowStr, bedH, bedM, offsetMs);
  }
  const nudge2Ms = nudge1Ms + 90 * 60 * 1000;

  scheduleOnce(chatId, nudge1Ms, async () => {
    const s = db.getState(chatId);
    if (s.status !== 'awake') return;
    await _bot?.sendMessage(chatId, 'heading to bed soon?').catch(() => {});
    db.setState(chatId, { bed_nudge_sent: 1 });
  });

  scheduleOnce(chatId, nudge2Ms, async () => {
    const s = db.getState(chatId);
    if (s.status !== 'awake' || !s.bed_nudge_sent) return;
    await _bot?.sendMessage(chatId, 'still up? you should sleep.').catch(() => {});
  });
}

function scheduleAllBedNudges() {
  for (const chatId of db.getAllChatIds()) {
    scheduleBedNudgesForDay(chatId);
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

function alertCategory(text) {
  if (!text) return null;
  const lc = text.toLowerCase();
  if (/protein/.test(lc)) return 'protein';
  if (/caffeine|coffee/.test(lc)) return 'caffeine';
  if (/calorie|calori|\bkcal\b/.test(lc)) return 'calories';
  if (/workout|gym|train|exercise/.test(lc)) return 'workout';
  if (/meal|eating|food|logged|log/.test(lc)) return 'meals';
  if (/sleep/.test(lc)) return 'sleep';
  return 'other';
}

function isSameAlertCategory(a, b) {
  const ca = alertCategory(a);
  const cb = alertCategory(b);
  return ca !== null && ca === cb;
}

async function runProactiveForUser(chatId, timeLabel) {
  const claude = require('./claude');
  const state = db.getState(chatId);
  if (state.status !== 'awake') return;
  if (db.wasRecentlyActive(chatId, 15)) return;

  const tz = requireTimezone(state);
  const todayStr = getDateStrTz(tz);

  try {
    const dayStart = state.current_day_start;
    const dayData = db.getDayDataFromSQLite(chatId, dayStart);

    const minutesAwake = dayStart ? Math.floor((Date.now() - dayStart) / 60000) : 0;
    const noMeals = dayData.meals.length === 0 && minutesAwake >= 240;

    const targetsCtx = db.getTargetsText(chatId);
    const targets = db.getTargets(chatId);

    const todayParts = todayStr.split('-').map(Number);
    const todayUTC = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2]));
    const dow = todayUTC.getUTCDay();
    const mondayUTC = new Date(todayUTC);
    mondayUTC.setUTCDate(todayUTC.getUTCDate() - (dow === 0 ? 6 : dow - 1));
    const mondayStr = mondayUTC.toISOString().split('T')[0];
    const weekStartMs = getDateAt(mondayStr, 0, 0, getOffsetMs(tz));
    const weekData = db.getWeekDataFromSQLite(chatId, weekStartMs);
    const recentWeek = weekData ? {
      dailyTotals:    weekData.dailyTotals,
      trainDays:      weekData.trainDays,
      avgSleep:       weekData.avgSleep,
      avgSleepQuality: weekData.avgSleepQuality,
    } : null;

    const recentAlerts = db.getHistory(chatId, 30)
      .filter(m => m.role === 'assistant')
      .slice(-6)
      .map(m => m.text.slice(0, 200));

    const todayAlert = (state.last_proactive_date === todayStr && state.last_proactive_msg)
      ? state.last_proactive_msg : null;

    const lastSleep = db.getLastSleepLog(chatId);
    const recentData = {
      minutesAwake,
      today: { ...dayData.totals, meals: dayData.meals.map(m => m.name), recovery: dayData.recovery },
      targets,
      noMealsYet: noMeals,
      caffeine_mg: state.caffeine_today_mg ?? 0,
      last_caffeine_time: state.last_caffeine_time,
      hasWorkout: dayData.workouts.length > 0,
      last_sleep: lastSleep ? { hours: lastSleep.hours_slept, quality: lastSleep.quality } : null,
      recentWeek,
      recentAlerts,
      todayAlert,
    };

    const dataBlock = buildProactiveDataBlock(recentData);
    const rawAlert = await claude.checkProactivePatterns(dataBlock, state);
    const alert = rawAlert ? require('./handlers/ask').stripMarkdown(rawAlert) : null;
    if (alert) {
      // Server-side same-category block — Claude's reasoning cannot override this
      if (todayAlert && isSameAlertCategory(todayAlert, alert)) return;
      const sent = await _bot.sendMessage(chatId, alert);
      db.saveCoachMessage(chatId, 'assistant', alert, sent.message_id);
      db.setState(chatId, { last_proactive_date: todayStr, last_proactive_msg: alert.slice(0, 200) });
    }
  } catch (e) { console.error('Proactive check error:', e.message); }
}

// ── Untimed task reminders (per-user, wake + 2h intervals) ───────────────────

async function runUntimedReminderForUser(chatId) {
  const state = db.getState(chatId);
  if (state.status !== 'awake') return;
  const tasks = db.getPendingUntimed(chatId);
  if (!tasks.length) return;
  try {
    const msg = tasks.length === 1
      ? `reminder: ${tasks[0].plan_text}`
      : `don't forget: ${tasks.map(t => t.plan_text).join(', ')}`;
    await _bot.sendMessage(chatId, msg);
    // Intentionally NOT marking reminded — untimed tasks stay pending until user says done
  } catch (e) { console.error('Untimed reminder error:', e.message); }
}

function scheduleUntimedRemindersForUser(chatId, wakeMs) {
  // Fire at wakeMs+2h, +4h, +6h, +8h, +10h — skip slots already in the past
  for (let i = 1; i <= 5; i++) {
    const fireMs = wakeMs + i * 2 * 3600 * 1000;
    if (fireMs <= Date.now()) continue;
    scheduleOnce(chatId, fireMs, () => runUntimedReminderForUser(chatId));
  }
}

// ── GCal mid-day sync ─────────────────────────────────────────────────────────

async function runGCalSync() {
  const gcal   = require('./gcal');
  const { scheduleTimedPlanReminders } = require('./handlers/plans');

  for (const chatId of db.getAllChatIds()) {
    const state = db.getState(chatId);
    const tz = requireTimezone(state);
    const { getDateStrTz, getTomorrowStrTz } = require('./utils/time');
    const todayStr    = getDateStrTz(tz);
    const tomorrowStr = getTomorrowStrTz(tz);
    const dayAfterStr = (() => {
      const [y, m, d] = tomorrowStr.split('-').map(Number);
      return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().split('T')[0];
    })();
    const datesToSync = [todayStr, tomorrowStr, dayAfterStr];

    // GCal → DB: import GCal events missing from DB (today + next 2 days)
    for (const dateStr of datesToSync) {
      try {
        const events = await gcal.getEventsForDate(chatId, dateStr).catch(() => []);
        const existing = new Set(db.getPendingTimed(chatId, dateStr).map(p => p.plan_text.toLowerCase()));
        const userOffsetMs = getOffsetMs(db.getState(chatId).timezone);
        for (const event of events) {
          if (!event.time || event.allDay) continue;
          if (existing.has(event.title.toLowerCase())) continue;

          const planId = db.savePlan(chatId, { text: event.title, date: dateStr, time: event.time });
          db.setPlanGCalId(planId, event.id);
          const [h, m] = event.time.split(':').map(Number);
          const eventMs = getDateAt(dateStr, h, m, userOffsetMs);
          const minsUntil = (eventMs - Date.now()) / 60000;
          const reminderMs = eventMs - 30 * 60 * 1000;

          if (reminderMs > Date.now()) {
            scheduleTimedPlanReminders(chatId, planId, { title: event.title, date: dateStr, time: event.time });
          } else if (dateStr === todayStr && minsUntil > 0 && minsUntil <= 60) {
            _bot?.sendMessage(chatId, `heads up: ${event.title} at ${event.time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
          }

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

function cancelOnce(chatId, atMs) {
  const key = `${chatId}_${atMs}`;
  const handle = _onceTimers.get(key);
  if (handle) { clearTimeout(handle); _onceTimers.delete(key); }
}

function cancelAllForChat(chatId) {
  for (const [key, handle] of _onceTimers.entries()) {
    if (key.startsWith(`${chatId}_`)) { clearTimeout(handle); _onceTimers.delete(key); }
  }
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
  for (const chatId of db.getAllChatIds()) {
    const userOffsetMs = getOffsetMs(db.getState(chatId).timezone);
    const today = new Date(Date.now() + userOffsetMs).toISOString().split('T')[0];
    const timedPlans = db.getPendingTimed(chatId, today);
    for (const plan of timedPlans) {
      const [h, m] = (plan.plan_time || '00:00').split(':').map(Number);
      if (isNaN(h) || isNaN(m)) continue;
      const eventMs = getDateAt(plan.plan_date, h, m, userOffsetMs);
      const reminderMs = eventMs - 30 * 60 * 1000;
      const minsUntil = (eventMs - Date.now()) / 60000;

      if (reminderMs > Date.now() && !scheduledKeys.has(`${chatId}_${reminderMs}`)) {
        scheduleTimedPlanReminders(chatId, plan.id, { title: plan.plan_text, date: plan.plan_date, time: plan.plan_time });
      } else if (minsUntil > 0 && minsUntil <= 60 && !scheduledKeys.has(`${chatId}_${reminderMs}`)) {
        _bot?.sendMessage(chatId, `heads up: ${plan.plan_text} at ${plan.plan_time} (in ${Math.round(minsUntil)} min)`).catch(() => {});
      }
    }
  }
}

module.exports = { init, scheduleOnce, cancelOnce, cancelAllForChat, rescheduleAll, getBotRef, scheduleBedNudgesForDay, scheduleUserDailyCrons, scheduleUntimedRemindersForUser, buildProactiveDataBlock };
