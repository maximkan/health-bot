const claude  = require('../claude');
const gcal    = require('../gcal');
const db      = require('../db');
const { tsToTimeStr, getActivityTomorrowStr, extractTimeMs, getOffsetMs, getDateStrTz, getTomorrowStrTz, requireTimezone } = require('../utils/time');
const { stripMarkdown } = require('./ask');
const { scheduleTimedPlanReminders } = require('./plans');
const { calculateTDEE, sumWorkoutCalories, ageFromBirthday } = require('../utils/tdee');

// ── Data summary builder ──────────────────────────────────────────────────────

function buildDataSummary(totals, targets, sleep, workouts, recovery, caffeine, timedPlans, userReminders, tdeeCtx, tz) {
  const sections = [];

  // Macros
  const cal  = Math.round(totals?.calories ?? 0);
  const pro  = Math.round(totals?.protein  ?? 0);
  const carb = Math.round(totals?.carbs    ?? 0);
  const fat  = Math.round(totals?.fat      ?? 0);
  const tCal = targets.calories;
  const tPro = targets.protein;
  const tCarb = targets.carbs;
  const tFat  = targets.fat;

  const macroLines = [
    `- calories: ${cal} / ${tCal} → ${cal > tCal ? `OVER by ${cal - tCal} (flag)` : 'under target'}`,
    `- protein: ${pro} / ${tPro} → ${pro < tPro ? `UNDER by ${tPro - pro} (flag)` : 'at or over target'}`,
    `- carbs: ${carb} / ${tCarb} → ${carb > tCarb ? `OVER by ${carb - tCarb} (flag)` : 'under target'}`,
    `- fat: ${fat} / ${tFat} → ${fat > tFat ? `OVER by ${fat - tFat} (flag)` : 'under target'}`,
  ];
  sections.push('Macros today:\n' + macroLines.join('\n'));

  // Sleep
  if (sleep && sleep.hours_slept != null) {
    sections.push(`Sleep last night: ${fmtHours(sleep.hours_slept)} at quality ${sleep.quality}/5`);
  } else {
    sections.push('Sleep last night: not logged');
  }

  // Workouts
  if (workouts && workouts.length) {
    const wLines = workouts.map(w => {
      const parts = [w.duration_min ? `${w.duration_min}min` : null, w.calories_burned ? `${w.calories_burned} kcal burned` : null].filter(Boolean).join(', ');
      return `- ${w.workout_name}${parts ? ', ' + parts : ''}`;
    });
    sections.push('Workouts today:\n' + wLines.join('\n'));
  } else {
    sections.push('Workouts today: none');
  }

  // Recovery (omit if empty)
  if (recovery && recovery.length) {
    sections.push('Recovery: ' + claude.formatRecoveryRows(recovery).join(', '));
  }

  // Energy balance (omit if null)
  if (tdeeCtx) {
    const { tdee, targetIntake, workoutKcal, eaten, netIntake, tdeeDeficit, targetDeficit, weight_kg, goal_weight } = tdeeCtx;
    const balLines = [
      `- TDEE (maintenance): ${tdee} kcal`,
      `- Target intake: ${targetIntake} kcal (planned deficit ${targetDeficit} kcal)`,
      `- Eaten today: ${eaten} kcal`,
      `- Workout burned: ${workoutKcal} kcal`,
      `- Net intake: ${netIntake} kcal`,
      `- Actual deficit vs maintenance: ${tdeeDeficit} kcal`,
    ];
    if (weight_kg) balLines.push(`- Current weight: ${weight_kg}kg → goal: ${goal_weight}kg`);
    sections.push('Energy balance:\n' + balLines.join('\n'));
  }

  // Caffeine (omit if absent/zero)
  if (caffeine && caffeine.total_mg) {
    let lastHour = -1;
    let lastStr = '';
    if (caffeine.last_time) {
      try {
        const lastMs = new Date(caffeine.last_time).getTime();
        lastHour = new Date(lastMs + getOffsetMs(tz)).getUTCHours();
        lastStr = ` (last at ${tsToTimeStr(lastMs, tz)})`;
      } catch {}
    }
    const flag = caffeine.total_mg > 400 || lastHour >= 17;
    sections.push(`Caffeine: ${caffeine.total_mg}mg today${lastStr}${flag ? ' [flag]' : ''}`);
  }

  // Upcoming plans (omit if empty)
  if (timedPlans && timedPlans.length) {
    sections.push('Upcoming plans:\n' + timedPlans.map(p => `- ${p}`).join('\n'));
  }

  // User reminders (omit if empty)
  if (userReminders && userReminders.length) {
    sections.push('User reminders:\n' + userReminders.map(r => `- ${r}`).join('\n'));
  }

  return sections.join('\n\n');
}

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
    prevTotals = db.getDailyMealTotalsFromSQLite(chatId, state.current_day_start);
  }

  db.setState(chatId, { status: 'awake', current_day_start: wakeMs, bed_time: null });
  db.resetCaffeine(chatId);

  const sleepLine = sleepStr ? `${sleepStr} sleep. ` : '';
  await bot.sendMessage(chatId, `☀️ morning. ${sleepLine}quality? (1-5)`);
  const tz = requireTimezone(state);
  return { sleepH, sleepStr, bedMs: bedMs ?? (wakeMs - getOffsetMs(tz)), prevTotals, newDayStart: wakeMs, hasBed, prevDayStart: state.current_day_start, tz };
}

async function processQuality(bot, chatId, quality, wakeData) {
  const { sleepH, bedMs, newDayStart, hasBed, prevDayStart, tz: wakeTz } = wakeData;
  const tz = wakeTz || requireTimezone(db.getState(chatId));
  const offsetMs = getOffsetMs(tz);

  // Only log sleep if we actually know the bed time
  if (hasBed && sleepH != null) {
    try {
      db.saveSleepLog(chatId, { bed_time: bedMs, wake_time: newDayStart, hours_slept: sleepH, quality, notes: '' });
    } catch (err) {
      console.error('Sleep log error:', err.message);
    }
  }

  const todayStr  = getDateStrTz(tz);
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
  const now = new Date(Date.now() + offsetMs);
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

  // Schedule tonight's bed nudge based on user's bed_time_pref
  try { require('../cron').scheduleBedNudgesForDay(chatId); } catch {}
}

// ── Bed flow ──────────────────────────────────────────────────────────────────

async function handleBedTime(bot, chatId, state) {
  const now      = Date.now();
  const dayStart = state.current_day_start ?? (now - 16 * 3600 * 1000);
  const tz = requireTimezone(state);

  try {
    const dateStr     = getDateStrTz(tz);
    const dayData     = db.getDayDataFromSQLite(chatId, dayStart);
    const targetsCtx  = db.getTargetsText(chatId);
    const targets     = db.getTargets(chatId);
    const userProfile = db.getState(chatId);

    // TDEE / deficit calculation
    const t = targets;
    let tdeeCtx = null;
    try {
      const weekData = db.getWeekDataFromSQLite(chatId, Date.now() - 7 * 24 * 3600 * 1000);
      const weeklyWorkouts = weekData?.trainDays ?? 3;
      const latestBody = db.getLastBodyMeasurement(chatId);
      const currentWeight = latestBody?.weight_kg ?? t?.weight_kg;
      const age = ageFromBirthday(t?.birthday) ?? t?.age;
      const height = t?.height_cm;
      const activityLevel = userProfile.activity_level;
      const gender = userProfile.gender;
      const missing = [];
      if (!currentWeight) missing.push('weight_kg');
      if (!age) missing.push('age (or birthday)');
      if (!height) missing.push('height_cm');
      if (!activityLevel) missing.push('activity_level');
      if (!gender) missing.push('gender');
      if (missing.length) throw new Error(`Cannot compute TDEE — missing: ${missing.join(', ')}. Complete onboarding to fix.`);
      const tdee = calculateTDEE(currentWeight, height, age, weeklyWorkouts, activityLevel, gender);
      const workoutKcal = sumWorkoutCalories(dayData.workouts);
      const eaten = Math.round(dayData.totals?.calories ?? 0);
      const netIntake = eaten - workoutKcal;
      const tdeeDeficit = tdee - eaten;
      const targetIntake = t.calories;
      const targetDeficit = tdee - targetIntake;
      tdeeCtx = { tdee, targetIntake, workoutKcal, eaten, netIntake, tdeeDeficit, targetDeficit, weight_kg: currentWeight, goal_weight: t.goal_weight };
    } catch {}

    const lastSleepBed = db.getLastSleepLog(chatId);
    const userReminders = (() => { try { return JSON.parse(userProfile.user_reminders || '[]'); } catch { return []; } })();
    const dataSummary = buildDataSummary(dayData.totals, t, lastSleepBed, dayData.workouts, dayData.recovery, null, [], userReminders, tdeeCtx, tz);
    const summaryStyle = userProfile.coaching_style || 2;
    const exampleForStyle = claude.DAY_SUMMARY_EXAMPLES[summaryStyle] || claude.DAY_SUMMARY_EXAMPLES[2];
    const summaryText = stripMarkdown(await claude.generateDaySummary({ dataSummary, exampleForStyle }, userProfile));

    db.setState(chatId, { status: 'sleeping', bed_time: now });

    // Mention pending untimed tasks before sleep
    const pendingTasks = db.getPendingUntimed(chatId);
    const taskNote = pendingTasks.length
      ? `\n\nstill pending: ${pendingTasks.map(t => t.plan_text).join(', ')} — carrying over to tomorrow.`
      : '';
    await bot.sendMessage(chatId, summaryText + taskNote);
  } catch (err) {
    console.error('Bed time error:', err.message, err.stack);
    db.setState(chatId, { status: 'sleeping', bed_time: now });
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }

  const tomorrow = state.current_day_start
    ? getActivityTomorrowStr(state.current_day_start, tz)
    : getTomorrowStrTz(tz);
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
    const targets = db.getTargets(chatId);
    const dayData = db.getDayDataFromSQLite(chatId, dayStartMs);
    const drinkEntries = dayData.meals.filter(m => (m.caffeine ?? 0) > 0 || /drink|coffee|tea|shake|smoothie|juice/i.test(m.type || ''));

    const targetsCtx = db.getTargetsText(chatId);
    const stateNow = db.getState(chatId);
    const tz = requireTimezone(stateNow);

    // Today's pending plans
    const todayStr  = getDateStrTz(tz);
    const timedPlans = db.getPendingTimed(chatId, todayStr);
    const tasks      = db.getPendingUntimed(chatId);

    const caffeineTotal = stateNow.caffeine_today_mg ?? 0;
    const lastCaffeine  = stateNow.last_caffeine_time;

    // TDEE partial-day tracking for evening check
    let tdeeCtx = null;
    try {
      const weekDataEv = db.getWeekDataFromSQLite(chatId, Date.now() - 7 * 24 * 3600 * 1000);
      const weeklyWorkoutsEv = weekDataEv?.trainDays ?? 3;
      const t2 = targets;
      const latestBodyEv = db.getLastBodyMeasurement(chatId);
      const currentWeightEv = latestBodyEv?.weight_kg ?? t2?.weight_kg;
      const ageEv = ageFromBirthday(t2?.birthday) ?? t2?.age;
      const heightEv = t2?.height_cm;
      const activityLevelEv = stateNow.activity_level;
      const genderEv = stateNow.gender;
      const missingEv = [];
      if (!currentWeightEv) missingEv.push('weight_kg');
      if (!ageEv) missingEv.push('age (or birthday)');
      if (!heightEv) missingEv.push('height_cm');
      if (!activityLevelEv) missingEv.push('activity_level');
      if (!genderEv) missingEv.push('gender');
      if (missingEv.length) throw new Error(`Cannot compute TDEE for evening check — missing: ${missingEv.join(', ')}. Complete onboarding to fix.`);
      const tdee = calculateTDEE(currentWeightEv, heightEv, ageEv, weeklyWorkoutsEv, activityLevelEv, genderEv);
      const workoutKcal = sumWorkoutCalories(dayData.workouts);
      const eaten = Math.round(dayData.totals?.calories ?? 0);
      const netIntake = eaten - workoutKcal;
      const tdeeDeficit = tdee - eaten;
      const targetIntake = t2.calories;
      const targetDeficit = tdee - targetIntake;
      tdeeCtx = { tdee, targetIntake, workoutKcal, eaten, netIntake, tdeeDeficit, targetDeficit, goal_weight: t2.goal_weight };
    } catch {}

    const lastSleep = db.getLastSleepLog(chatId);
    const userReminders = (() => { try { return JSON.parse(stateNow.user_reminders || '[]'); } catch { return []; } })();
    const dataSummary = buildDataSummary(
      dayData.totals, targets, lastSleep,
      dayData.workouts, dayData.recovery,
      { total_mg: caffeineTotal, last_time: lastCaffeine },
      timedPlans.map(p => `${p.plan_text} at ${p.plan_time}`),
      userReminders, tdeeCtx, tz
    );

    const eveningStyle = stateNow.coaching_style || 2;
    const eveningExample = claude.EVENING_CHECK_EXAMPLES[eveningStyle] || claude.EVENING_CHECK_EXAMPLES[2];
    const msg = stripMarkdown(await claude.generateEveningCheck({ dataSummary, exampleForStyle: eveningExample }, stateNow));
    const sent = await bot.sendMessage(chatId, msg);

    db.setState(chatId, {
      last_coach_message_id: sent.message_id,
      last_coach_context: JSON.stringify({ message: msg, context: JSON.stringify(checkData), timestamp: Date.now() }),
    });
    db.saveCoachMessage(chatId, 'assistant', msg, sent.message_id);

  } catch (err) {
    console.error('Evening check error:', err.message, err.stack);
  }
}

module.exports = { handleMorningWake, processQuality, handleBedTime, sendEveningCheck };
