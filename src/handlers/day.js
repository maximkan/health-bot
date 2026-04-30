const claude  = require('../claude');
const notion  = require('../notion');
const gcal    = require('../gcal');
const db      = require('../db');
const { getMalaysiaDateStr, tsToTimeStr, nowContext, getTomorrowStr, getTodayStr, getActivityTomorrowStr, extractTimeMs } = require('../utils/time');
const { stripMarkdown } = require('./ask');
const { scheduleTimedPlanReminders, syncNotionPlansToDb } = require('./plans');
const { calculateTDEE, sumWorkoutCalories } = require('../utils/tdee');

// ── Morning wake flow ─────────────────────────────────────────────────────────

// wakeOverrideMs: if user said "woke up at 9am", pass the parsed timestamp
function fmtHours(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return hh > 0 ? (mm > 0 ? `${hh}h ${mm}m` : `${hh}h`) : `${mm}m`;
}

async function handleMorningWake(bot, chatId, state, wakeOverrideMs = null) {
  const wakeMs   = wakeOverrideMs || Date.now();
  const hasBed   = state.bed_time != null;
  const bedMs    = hasBed ? state.bed_time : null;
  const sleepH   = hasBed ? Math.round(Math.max(0, wakeMs - bedMs - 20 * 60 * 1000) / 3600000 * 10) / 10 : null;
  const sleepStr = sleepH != null ? fmtHours(sleepH) : null;

  let prevTotals = null;
  if (state.current_day_start) {
    prevTotals = await notion.getDailyMealTotals(chatId, state.current_day_start).catch(() => null);
  }

  db.setState(chatId, { status: 'awake', current_day_start: wakeMs, bed_time: null });
  db.resetCaffeine(chatId);

  const sleepLine = sleepStr ? `${sleepStr} sleep. ` : '';
  await bot.sendMessage(chatId, `☀️ morning. ${sleepLine}quality? (1-5)`);
  return { sleepH, sleepStr, bedMs: bedMs ?? (wakeMs - 8 * 3600 * 1000), prevTotals, newDayStart: wakeMs, hasBed, prevDayStart: state.current_day_start };
}

async function processQuality(bot, chatId, quality, wakeData) {
  const { sleepH, bedMs, newDayStart, hasBed, prevDayStart } = wakeData;

  // Only log sleep if we actually know the bed time
  if (hasBed && sleepH != null) {
    try {
      const OFFSET_MS = 8 * 60 * 60 * 1000;
      // Use activity day start date as the label ("Night of April 24" not the calendar bed date)
      const activityDayStart = prevDayStart || bedMs;
      const bedDateStr = new Date(activityDayStart + OFFSET_MS).toISOString().split('T')[0];
      db.saveSleepLog(chatId, { bed_time: bedMs, wake_time: newDayStart, hours_slept: sleepH, quality, notes: '' });
      await notion.createSleepEntry(chatId, {
        bed_time:    tsToTimeStr(bedMs),
        wake_time:   tsToTimeStr(newDayStart),
        hours_slept: sleepH,
        quality,
        notes: '',
        bed_date: bedDateStr,
      });
    } catch (err) {
      console.error('Sleep log error:', err.message);
    }
  }

  // Sync today's plans from Notion into DB before displaying
  const todayStr  = getMalaysiaDateStr();
  await syncNotionPlansToDb(chatId, todayStr).catch(() => {});
  const timedToday = db.getPendingTimed(chatId, todayStr);
  const tasks      = db.getPendingUntimed(chatId);
  const gcalToday  = await gcal.getEventsForDate(chatId, todayStr).catch(() => []);

  const dbTitles = new Set(timedToday.map(p => p.plan_text.toLowerCase()));
  const gcalExtra = gcalToday.filter(e => !dbTitles.has(e.title.toLowerCase()) && !e.allDay);

  // Save GCal events to SQLite and schedule reminders via same path as manual plans
  for (const event of gcalExtra) {
    if (!event.time) continue;
    const planId = db.savePlan(chatId, { text: event.title, date: todayStr, time: event.time });
    scheduleTimedPlanReminders(chatId, planId, { title: event.title, date: todayStr, time: event.time });
  }

  const allTimed = [
    ...timedToday.map(p => ({ time: p.plan_time, title: p.plan_text })),
    ...gcalExtra.map(e => ({ time: e.time, title: e.title })),
  ].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const dateHeader = `📅 ${days[now.getUTCDay()]}, ${months[now.getUTCMonth()]} ${now.getUTCDate()}`;

  const lines = [];
  if (allTimed.length) {
    const items = allTimed.map(e => `• ${e.time} — ${e.title}`).join('\n');
    lines.push(`${dateHeader}\n${items}`);
  }
  if (tasks.length) lines.push(`📋 tasks:\n${tasks.map(p => `• ${p.plan_text}`).join('\n')}`);

  if (lines.length) {
    const sleepNote = (hasBed && sleepH != null) ? `${fmtHours(sleepH)} sleep. ` : '';
    await bot.sendMessage(chatId, `${sleepNote}here's your day:\n\n${lines.join('\n\n')}`);
  } else {
    const sleepNote = (hasBed && sleepH != null) ? `${fmtHours(sleepH)} sleep. ` : '';
    await bot.sendMessage(chatId, `${sleepNote}no plans today. free day.`);
  }
}

// ── Bed flow ──────────────────────────────────────────────────────────────────

async function handleBedTime(bot, chatId, state) {
  const now      = Date.now();
  const dayStart = state.current_day_start ?? (now - 16 * 3600 * 1000);

  try {
    const dateStr     = getMalaysiaDateStr();
    const dayData     = await notion.getDayData(chatId, dayStart);
    const targetsCtx  = notion.getTargetsText(chatId);
    const targets     = notion.getTargets(chatId);

    // TDEE / deficit calculation
    const t = targets;
    let tdeeCtx = null;
    try {
      const weekData = await notion.getWeekData(Date.now() - 7 * 24 * 3600 * 1000).catch(() => null);
      const weeklyWorkouts = weekData?.trainDays ?? 3;
      const tdee = calculateTDEE(t.weight_kg ?? 105, t.height_cm ?? 176, t.age ?? 26, weeklyWorkouts);
      const workoutKcal = sumWorkoutCalories(dayData.workouts);
      const eaten = Math.round(dayData.totals?.calories ?? 0);
      const netIntake = eaten - workoutKcal; // calories net of exercise
      const deficit = tdee - eaten;          // how much below TDEE (positive = deficit)
      const weeklyDeficitNeeded = ((t.weight_kg ?? 105) - (t.goal_weight ?? 80)) > 5 ? 500 : 250;
      tdeeCtx = { tdee, workoutKcal, eaten, netIntake, deficit, weeklyDeficitNeeded, weight_kg: t.weight_kg, goal_weight: t.goal_weight };
    } catch {}

    const userProfile = db.getState(chatId);
    const summaryText = stripMarkdown(await claude.generateDaySummary(dayData, targetsCtx, tdeeCtx, userProfile));

    await notion.createDailySummaryPage(dayData, summaryText, dateStr, targets).catch(err => console.error('Summary page error:', err.message));
    db.setState(chatId, { status: 'sleeping', bed_time: now });
    await bot.sendMessage(chatId, summaryText);
  } catch (err) {
    console.error('Bed time error:', err.message);
    db.setState(chatId, { status: 'sleeping', bed_time: now });
    await bot.sendMessage(chatId, 'logged. good work today.');
  }

  const tomorrow = state.current_day_start
    ? getActivityTomorrowStr(state.current_day_start)
    : getTomorrowStr();
  await syncNotionPlansToDb(chatId, tomorrow).catch(() => {});
  const timedTomorrow = db.getPendingTimed(chatId, tomorrow);
  const gcalTomorrow  = await gcal.getEventsForDate(chatId, tomorrow).catch(() => []);
  const dbTitles = new Set(timedTomorrow.map(p => p.plan_text.toLowerCase()));
  const gcalExtra = gcalTomorrow.filter(e => !dbTitles.has(e.title.toLowerCase()) && !e.allDay);
  const allTomorrow = [
    ...timedTomorrow.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalExtra.map(e => e.time ? `${e.title} at ${e.time}` : e.title),
  ];
  if (allTomorrow.length) {
    const tomorrowSorted = [
      ...timedTomorrow.map(p => ({ time: p.plan_time, title: p.plan_text })),
      ...gcalExtra.map(e => ({ time: e.time, title: e.title })),
    ].sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const days2 = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const months2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const [ty, tm, td] = tomorrow.split('-').map(Number);
    const tom = new Date(Date.UTC(ty, tm - 1, td));
    const tomHeader = `📅 ${days2[tom.getUTCDay()]}, ${months2[tom.getUTCMonth()]} ${tom.getUTCDate()}`;
    await bot.sendMessage(chatId, `tomorrow:\n${tomHeader}\n${tomorrowSorted.map(e => `• ${e.time} — ${e.title}`).join('\n')}`);
  }

  db.setState(chatId, { bed_plans_tomorrow: tomorrow });
  await bot.sendMessage(chatId, 'any more plans for tomorrow?');
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function sendEveningCheck(bot, chatId, dayStartMs) {
  try {
    const targets = notion.getTargets(chatId) ?? { calories: 1600, protein: 220, carbs: 80, fat: 53 };
    const [dayData, drinkEntries] = await Promise.all([
      notion.getDayData(chatId, dayStartMs).catch(() => ({ totals: { calories: 0, protein: 0, carbs: 0, fat: 0, caffeine: 0 }, meals: [], workouts: [], recovery: [] })),
      notion.getDrinkEntries(chatId, dayStartMs).catch(() => []),
    ]);

    const targetsCtx = notion.getTargetsText(chatId);

    // Today's pending plans
    const todayStr  = getMalaysiaDateStr();
    const timedPlans = db.getPendingTimed(chatId, todayStr);
    const tasks      = db.getPendingUntimed(chatId);

    const stateNow = db.getState(chatId);
    const caffeineTotal = stateNow.caffeine_today_mg ?? 0;
    const lastCaffeine  = stateNow.last_caffeine_time;

    // TDEE partial-day tracking for evening check
    let tdeeCtx = null;
    try {
      const weekDataEv = await notion.getWeekData(Date.now() - 7 * 24 * 3600 * 1000).catch(() => null);
      const weeklyWorkoutsEv = weekDataEv?.trainDays ?? 3;
      const t2 = targets;
      const tdee = calculateTDEE(t2.weight_kg ?? 105, t2.height_cm ?? 176, t2.age ?? 26, weeklyWorkoutsEv);
      const workoutKcal = sumWorkoutCalories(dayData.workouts);
      const eaten = Math.round(dayData.totals?.calories ?? 0);
      const deficit = tdee - eaten;
      tdeeCtx = { tdee, workoutKcal, eaten, deficit, goal_weight: t2.goal_weight };
    } catch {}

    const checkData = {
      totals:   dayData.totals,
      targets,
      caffeine: { total_mg: caffeineTotal, last_time: lastCaffeine, drinks: drinkEntries.length },
      workouts: dayData.workouts,
      timedPlans: timedPlans.map(p => `${p.plan_text} at ${p.plan_time}`),
      tasks: tasks.map(p => p.plan_text),
      tdee: tdeeCtx,
    };

    const msg = stripMarkdown(await claude.generateEveningCheck(checkData, targetsCtx, stateNow));
    const sent = await bot.sendMessage(chatId, msg);

    db.setState(chatId, {
      last_coach_message_id: sent.message_id,
      last_coach_context: JSON.stringify({ message: msg, context: JSON.stringify(checkData), timestamp: Date.now() }),
    });
    db.saveCoachMessage(chatId, 'assistant', msg, sent.message_id);

    await notion.createCoachNote(`Evening Check — ${todayStr}`, msg, 'Daily Evening Check').catch(() => {});
  } catch (err) {
    console.error('Evening check error:', err.message);
  }
}

module.exports = { handleMorningWake, processQuality, handleBedTime, sendEveningCheck };
