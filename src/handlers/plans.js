const claude  = require('../claude');
const gcal    = require('../gcal');
const db      = require('../db');
const cronSvc = require('../cron');
const { nowContextTz, getActivityTomorrowStr, getDateAt, getOffsetMs, getDateStrTz, getTomorrowStrTz, tsToISO } = require('../utils/time');

async function handlePlan(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const userState = db.getState(chatId);
    const tz = userState.timezone || 'Asia/Kuala_Lumpur';
    const isSleeping = userState.status === 'sleeping';
    const activityTomorrow = userState.current_day_start
      ? getActivityTomorrowStr(userState.current_day_start, tz)
      : getTomorrowStrTz(tz);
    const fallbackDate = isSleeping
      ? (userState.bed_plans_tomorrow || getTomorrowStrTz(tz))
      : activityTomorrow;

    const todayStr   = getDateStrTz(tz);
    const calTomorrow = getTomorrowStrTz(tz);
    const activityDate = userState.current_day_start
      ? tsToISO(userState.current_day_start, tz).split('T')[0]
      : todayStr;
    const activityCtx = (!isSleeping && activityTomorrow !== calTomorrow)
      ? `\nIMPORTANT: The user's activity day is ${activityDate} (they woke up then and have not slept yet). For scheduling: today = ${activityDate}, tomorrow = ${activityTomorrow}.`
      : '';
    const plans = await claude.parsePlans(msg.text || '', nowContextTz(userState.timezone) + activityCtx);
    if (!plans.length) {
      await handleAskFallback(bot, msg);
      return;
    }

    const confirmations = [];
    for (const plan of plans) {
      const planDate = (!plan.date || (isSleeping && plan.date === todayStr))
        ? fallbackDate
        : (!isSleeping && plan.date === calTomorrow && activityTomorrow !== calTomorrow)
          ? activityTomorrow  // remap calendar-tomorrow → activity-tomorrow when past midnight
          : plan.date;
      const planId = db.savePlan(chatId, {
        text:      plan.title,
        date:      planDate,
        time:      plan.time || null,
        recurring: plan.recurring || 'one-time',
        guests:    plan.guests || [],
        location:  plan.location || null,
      });

      const planWithDate = { ...plan, date: planDate };

      // Schedule reminders
      if (plan.time && planDate) {
        scheduleTimedPlanReminders(chatId, planId, planWithDate);
      }

      // Google Calendar
      if (plan.time && planDate) {
        let calStatus = '';
        try {
          const gcalEvent = await gcal.createEvent(chatId, { title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
          db.setPlanCalendar(planId);
          if (gcalEvent?.id) db.setPlanGCalId(planId, gcalEvent.id);
          calStatus = ' 📅 Added to Google Calendar.';
        } catch (err) {
          console.error('Calendar error:', err.message);
          calStatus = '';
        }
        confirmations.push(`✅ ${plan.title} — ${planDate} at ${plan.time}${plan.location ? `, ${plan.location}` : ''}.${calStatus}`);
      } else if (plan.is_task) {
        confirmations.push(`✅ Task: ${plan.title} — on your list. I'll remind you every 2 hours until done.`);
      } else {
        const noTimeNote = planDate ? ' No time set — what time? (resend with time to add to calendar)' : '';
        confirmations.push(`✅ ${plan.title} — ${planDate}.${noTimeNote}`);
      }
    }

    await bot.sendMessage(chatId, confirmations.join('\n\n'));
  } catch (err) {
    console.error('Plan handler error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

function scheduleTimedPlanReminders(chatId, planId, plan) {
  const offsetMs = getOffsetMs(db.getState(chatId).timezone);
  const [h, m] = (plan.time || '00:00').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return;
  const eventMs = getDateAt(plan.date, h, m, offsetMs);

  function persist(fireMs, text, fn) {
    if (fireMs <= Date.now()) return;
    if (db.getReminderByTime(chatId, fireMs)) return; // dedup: skip if already scheduled
    const remId = db.saveReminder(chatId, fireMs, text, planId);
    cronSvc.scheduleOnce(chatId, fireMs, async () => {
      db.markReminderFired(remId);
      await fn();
    });
  }

  // 30 min before
  persist(eventMs - 30 * 60 * 1000, `${plan.title} in 30 min`, () =>
    cronSvc.getBotRef()?.sendMessage(chatId, `${plan.title} in 30 min — time to head out`).catch(() => {})
  );

  // Night before at 9 PM
  const [yr, mo, dy] = plan.date.split('-').map(Number);
  const prevDayStr = new Date(Date.UTC(yr, mo - 1, dy - 1)).toISOString().split('T')[0];
  persist(getDateAt(prevDayStr, 21, 0), `tomorrow: ${plan.title} at ${plan.time}`, () =>
    cronSvc.getBotRef()?.sendMessage(chatId, `heads up — ${plan.title} tomorrow at ${plan.time}`).catch(() => {})
  );
}

async function handlePlanDone(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const pending = db.getAllPending(chatId);
    if (!pending.length) { await bot.sendMessage(chatId, 'No pending plans to mark done.'); return; }
    const plan = await claude.matchPlanToModify(msg.text, pending);
    db.updatePlanStatus(plan.id, 'done');
    await bot.sendMessage(chatId, `✅ Done: ${plan.plan_text}. Off your list.`);
  } catch (err) {
    console.error('Plan done error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function handlePlanSkip(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const pending = db.getAllPending(chatId);
    if (!pending.length) { await bot.sendMessage(chatId, 'No pending plans.'); return; }
    const plan = await claude.matchPlanToModify(msg.text, pending);
    db.updatePlanStatus(plan.id, 'skipped');
    if (plan.gcal_event_id) {
      await gcal.deleteEvent(chatId, plan.gcal_event_id).catch(() => {});
    } else if (plan.calendar_event_created && plan.plan_date && plan.plan_time) {
      const events = await gcal.getEventsForDate(chatId, plan.plan_date).catch(() => []);
      const match = events.find(e => e.title?.toLowerCase() === plan.plan_text?.toLowerCase() && e.time === plan.plan_time);
      if (match?.id) await gcal.deleteEvent(chatId, match.id).catch(() => {});
    }
    await bot.sendMessage(chatId, `Cancelled: ${plan.plan_text}.`);
  } catch (err) {
    console.error('Plan skip error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

// Process plans given at bedtime (can return a confirmation string)
// activityTomorrowStr: the "tomorrow" relative to the user's activity day (not real calendar)
async function processBedPlans(chatId, text, activityTomorrowStr) {
  const state = db.getState(chatId);
  const tz = state.timezone || 'Asia/Kuala_Lumpur';
  const defaultTomorrow = activityTomorrowStr || getTomorrowStrTz(tz);
  const todayStr = getDateStrTz(tz);
  try {
    // Tell Haiku explicitly what "tomorrow" means in this context
    const ctx = `${nowContextTz(state.timezone)}\nContext: user is setting plans for tomorrow. Tomorrow = ${defaultTomorrow}. Default all unspecified dates to ${defaultTomorrow}.`;
    let plans = await claude.parsePlans(text, ctx);

    if (!plans.length) {
      // Haiku failed to parse — check if user actually means "no plans" vs named something
      const noPlans = await claude.isNoPlanResponse(text).catch(() => true);
      if (noPlans) return null;
      // Has content but Haiku missed it — save raw text as a task
      plans = [{ title: text.trim(), date: defaultTomorrow, time: null, recurring: 'one-time', guests: [], location: null, is_task: true }];
      console.log(`[bedPlans] fallback: saving raw text as task: "${text.trim()}"`);
    }

    const lines = [];
    for (const plan of plans) {
      // If Haiku assigned today's date, override to activity tomorrow
      const planDate = (!plan.date || plan.date === todayStr) ? defaultTomorrow : plan.date;
      const planId = db.savePlan(chatId, { text: plan.title, date: planDate, time: plan.time || null, recurring: plan.recurring || 'one-time', guests: plan.guests || [], location: plan.location || null });

      const planWithDate = { ...plan, date: planDate };

      if (plan.time) {
        scheduleTimedPlanReminders(chatId, planId, planWithDate);
        try {
          const gcalEvent = await gcal.createEvent(chatId, { title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
          db.setPlanCalendar(planId);
          if (gcalEvent?.id) db.setPlanGCalId(planId, gcalEvent.id);
        } catch (err) { console.error('Bed plans GCal error:', err.message); }
        lines.push(`${plan.title} @ ${plan.time}`);
      } else {
        lines.push(plan.title);
      }
    }
    return lines.map(l => `- ${l}`).join('\n');
  } catch (err) {
    console.error('Bed plans parse error:', err.message);
    return null;
  }
}

async function handleAskFallback(bot, msg) {
  const { handleAsk } = require('./ask');
  await handleAsk(bot, msg);
}

module.exports = { handlePlan, handlePlanDone, handlePlanSkip, processBedPlans, scheduleTimedPlanReminders };
