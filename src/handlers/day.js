const claude  = require('../claude');
const notion  = require('../notion');
const gcal    = require('../gcal');
const db      = require('../db');
const { getMalaysiaDateStr, tsToTimeStr, nowContext, getTomorrowStr, getTodayStr, getActivityTomorrowStr, extractTimeMs } = require('../utils/time');
const { stripMarkdown } = require('./ask');

// ── Morning wake flow ─────────────────────────────────────────────────────────

// wakeOverrideMs: if user said "woke up at 9am", pass the parsed timestamp
async function handleMorningWake(bot, chatId, state, wakeOverrideMs = null) {
  const wakeMs  = wakeOverrideMs || Date.now();
  const bedMs   = state.bed_time ?? (wakeMs - 8 * 3600 * 1000);
  const sleepMs = Math.max(0, wakeMs - bedMs - 20 * 60 * 1000);
  const totalMin = Math.round(sleepMs / 60000);
  const sleepH   = Math.round(sleepMs / 3600000 * 10) / 10;
  const sh = Math.floor(totalMin / 60);
  const sm = totalMin % 60;
  const sleepStr = sh > 0 ? (sm > 0 ? `${sh}h ${sm}m` : `${sh}h`) : `${sm}m`;

  let prevTotals = null;
  if (state.current_day_start) {
    prevTotals = await notion.getDailyMealTotals(state.current_day_start).catch(() => null);
  }

  db.setState(chatId, { status: 'awake', current_day_start: wakeMs });
  db.resetCaffeine(chatId);

  await bot.sendMessage(chatId, `☀️ morning. ${sleepStr} sleep. quality? (1-5)`);
  return { sleepH, sleepStr, bedMs, prevTotals, newDayStart: wakeMs };
}

async function processQuality(bot, chatId, quality, wakeData) {
  const { sleepH, bedMs, newDayStart } = wakeData;

  // Log sleep entry silently
  try {
    const OFFSET_MS = 8 * 60 * 60 * 1000;
    const bedDateStr = new Date(bedMs + OFFSET_MS).toISOString().split('T')[0];
    await notion.createSleepEntry({
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

  // Show today's plans only (bot + Google Calendar)
  const todayStr  = getMalaysiaDateStr();
  const timedToday = db.getPendingTimed(chatId, todayStr);
  const tasks      = db.getPendingUntimed(chatId);
  const gcalToday  = await gcal.getEventsForDate(todayStr).catch(() => []);

  const dbTitles = new Set(timedToday.map(p => p.plan_text.toLowerCase()));
  const gcalExtra = gcalToday.filter(e => !dbTitles.has(e.title.toLowerCase()) && !e.allDay);

  // Save GCal events to SQLite so reminders fire
  const { scheduleOnce } = require('../cron');
  const { getDateAt } = require('../utils/time');
  for (const event of gcalExtra) {
    if (!event.time) continue;
    const planId = db.savePlan(chatId, { text: event.title, date: todayStr, time: event.time });
    const [h, m] = event.time.split(':').map(Number);
    const fireMs = getDateAt(todayStr, h, m) - 15 * 60 * 1000; // 15 min before
    const botRef = bot;
    scheduleOnce(chatId, fireMs, async () => {
      await botRef.sendMessage(chatId, `reminder: ${event.title} at ${event.time}`);
    });
  }

  const allTimed = [
    ...timedToday.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalExtra.map(e => `${e.title} at ${e.time}`),
  ];

  const lines = [];
  if (allTimed.length) lines.push(`today:\n${allTimed.map(t => `• ${t}`).join('\n')}`);
  if (tasks.length)    lines.push(`tasks:\n${tasks.map(p => `• ${p.plan_text}`).join('\n')}`);

  if (lines.length) await bot.sendMessage(chatId, lines.join('\n\n'));
}

// ── Bed flow ──────────────────────────────────────────────────────────────────

async function handleBedTime(bot, chatId, state) {
  const now      = Date.now();
  const dayStart = state.current_day_start ?? (now - 16 * 3600 * 1000);

  try {
    const dateStr     = getMalaysiaDateStr();
    const dayData     = await notion.getDayData(dayStart);
    let targetsCtx = '';
    try { targetsCtx = await notion.getTargetsText(); } catch {}
    const targets     = await notion.getTargets().catch(() => null);
    const summaryText = stripMarkdown(await claude.generateDaySummary(dayData, targetsCtx));

    await notion.createDailySummaryPage(dayData, summaryText, dateStr, targets).catch(err => console.error('Summary page error:', err.message));
    db.setState(chatId, { status: 'sleeping', bed_time: now });
    await bot.sendMessage(chatId, summaryText);
  } catch (err) {
    console.error('Bed time error:', err.message);
    db.setState(chatId, { status: 'sleeping', bed_time: now });
    await bot.sendMessage(chatId, 'logged. good work today.');
  }

  const tomorrow = getTomorrowStr();
  const timedTomorrow = db.getPendingTimed(chatId, tomorrow);
  const gcalTomorrow  = await gcal.getEventsForDate(tomorrow).catch(() => []);
  const dbTitles = new Set(timedTomorrow.map(p => p.plan_text.toLowerCase()));
  const gcalExtra = gcalTomorrow.filter(e => !dbTitles.has(e.title.toLowerCase()) && !e.allDay);
  const allTomorrow = [
    ...timedTomorrow.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalExtra.map(e => e.time ? `${e.title} at ${e.time}` : e.title),
  ];
  if (allTomorrow.length) {
    await bot.sendMessage(chatId, `btw, tomorrow:\n${allTomorrow.map(t => `• ${t}`).join('\n')}`);
  }

  db.setState(chatId, { bed_plans_tomorrow: tomorrow }); // real calendar tomorrow
  await bot.sendMessage(chatId, 'any more plans for tomorrow?');
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function sendEveningCheck(bot, chatId, dayStartMs) {
  try {
    const [dayData, targets, drinkEntries] = await Promise.all([
      notion.getDayData(dayStartMs).catch(() => ({ totals: { calories: 0, protein: 0, carbs: 0, fat: 0, caffeine: 0 }, meals: [], workouts: [], recovery: [] })),
      notion.getTargets().catch(() => ({ calories: 1600, protein: 220, carbs: 80, fat: 53 })),
      notion.getDrinkEntries(dayStartMs).catch(() => []),
    ]);

    let targetsCtx = '';
    try { targetsCtx = await notion.getTargetsText(); } catch {}

    // Today's pending plans
    const todayStr  = getMalaysiaDateStr();
    const timedPlans = db.getPendingTimed(chatId, todayStr);
    const tasks      = db.getPendingUntimed(chatId);

    const stateNow = db.getState(chatId);
    const caffeineTotal = stateNow.caffeine_today_mg ?? 0;
    const lastCaffeine  = stateNow.last_caffeine_time;

    const checkData = {
      totals:   dayData.totals,
      targets,
      caffeine: { total_mg: caffeineTotal, last_time: lastCaffeine, drinks: drinkEntries.length },
      workouts: dayData.workouts,
      timedPlans: timedPlans.map(p => `${p.plan_text} at ${p.plan_time}`),
      tasks: tasks.map(p => p.plan_text),
    };

    const msg = stripMarkdown(await claude.generateEveningCheck(checkData, targetsCtx));
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
