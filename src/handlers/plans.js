const claude  = require('../claude');
const notion  = require('../notion');
const gcal    = require('../gcal');
const db      = require('../db');
const cronSvc = require('../cron');
const { nowContext, getTodayStr, getTomorrowStr, getActivityTomorrowStr, getDateAt } = require('../utils/time');

async function handlePlan(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const userState = db.getState(chatId);
    const isSleeping = userState.status === 'sleeping';
    const activityTomorrow = userState.current_day_start
      ? getActivityTomorrowStr(userState.current_day_start)
      : getTomorrowStr();
    const fallbackDate = isSleeping
      ? (userState.bed_plans_tomorrow || getTomorrowStr())
      : activityTomorrow;

    const activityCtx = (!isSleeping && activityTomorrow !== getTomorrowStr())
      ? `\nNote: user is still awake from their current activity day. 'Tomorrow' means ${activityTomorrow}, not ${getTomorrowStr()}.`
      : '';
    const plans = await claude.parsePlans(msg.text || '', nowContext() + activityCtx);
    if (!plans.length) {
      await handleAskFallback(bot, msg);
      return;
    }

    const confirmations = [];
    for (const plan of plans) {
      const calTomorrow = getTomorrowStr();
      const planDate = (!plan.date || (isSleeping && plan.date === getTodayStr()))
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

      // Write to Notion
      try {
        const notionPage = await notion.createPlanEntry(planWithDate);
        if (notionPage?.id) db.setPlanNotionId(planId, notionPage.id);
      } catch (err) {
        console.error('Plan Notion write error:', err.message);
      }

      // Schedule reminders
      if (plan.time && planDate) {
        scheduleTimedPlanReminders(chatId, planId, planWithDate);
      }

      // Google Calendar
      if (plan.time && planDate) {
        let calStatus = '';
        try {
          const gcalEvent = await gcal.createEvent({ title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
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
    console.error('Plan handler error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not save plan. Try: "gym tomorrow at 10am"');
  }
}

function scheduleTimedPlanReminders(chatId, planId, plan) {
  const { getDateAt } = require('../utils/time');
  const [h, m] = (plan.time || '00:00').split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return;
  const eventMs = getDateAt(plan.date, h, m);

  function persist(fireMs, text, fn) {
    if (fireMs <= Date.now()) return;
    const remId = db.saveReminder(chatId, fireMs, text);
    cronSvc.scheduleOnce(chatId, fireMs, async () => {
      db.markReminderFired(remId);
      await fn();
    });
  }

  // 30 min before
  persist(eventMs - 30 * 60 * 1000, `${plan.title} in 30 min`, () =>
    cronSvc.getBotRef()?.sendMessage(chatId, `${plan.title} in 30 min`).catch(() => {})
  );

  // Night before at 9 PM
  const [yr, mo, dy] = plan.date.split('-').map(Number);
  const prevDayStr = new Date(Date.UTC(yr, mo - 1, dy - 1)).toISOString().split('T')[0];
  persist(getDateAt(prevDayStr, 21, 0), `tomorrow: ${plan.title} at ${plan.time}`, () =>
    cronSvc.getBotRef()?.sendMessage(chatId, `tomorrow: ${plan.title} at ${plan.time}`).catch(() => {})
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
    if (plan.notion_page_id) await notion.updatePlanStatusNotion(plan.notion_page_id, 'Done').catch(() => {});
    await bot.sendMessage(chatId, `✅ Done: ${plan.plan_text}. Off your list.`);
  } catch (err) {
    console.error('Plan done error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not update plan.');
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
    if (plan.notion_page_id) await notion.updatePlanStatusNotion(plan.notion_page_id, 'Cancelled').catch(() => {});
    if (plan.gcal_event_id) {
      await gcal.deleteEvent(plan.gcal_event_id).catch(() => {});
    } else if (plan.calendar_event_created && plan.plan_date && plan.plan_time) {
      const events = await gcal.getEventsForDate(plan.plan_date).catch(() => []);
      const match = events.find(e => e.title?.toLowerCase() === plan.plan_text?.toLowerCase() && e.time === plan.plan_time);
      if (match?.id) await gcal.deleteEvent(match.id).catch(() => {});
    }
    await bot.sendMessage(chatId, `Cancelled: ${plan.plan_text}.`);
  } catch (err) {
    console.error('Plan skip error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not cancel plan.');
  }
}

// Process plans given at bedtime (can return a confirmation string)
// activityTomorrowStr: the "tomorrow" relative to the user's activity day (not real calendar)
async function processBedPlans(chatId, text, activityTomorrowStr) {
  const defaultTomorrow = activityTomorrowStr || getTomorrowStr(); // activityTomorrowStr is real calendar tomorrow set at bed time
  const todayStr = getTodayStr();
  try {
    // Tell Haiku explicitly what "tomorrow" means in this context
    const ctx = `${nowContext()}\nContext: user is setting plans for tomorrow. Tomorrow = ${defaultTomorrow}. Default all unspecified dates to ${defaultTomorrow}.`;
    const plans = await claude.parsePlans(text, ctx);
    if (!plans.length) return null;

    const lines = [];
    for (const plan of plans) {
      // If Haiku assigned today's date, override to activity tomorrow
      const planDate = (!plan.date || plan.date === todayStr) ? defaultTomorrow : plan.date;
      const planId = db.savePlan(chatId, { text: plan.title, date: planDate, time: plan.time || null, recurring: plan.recurring || 'one-time', guests: plan.guests || [], location: plan.location || null });

      const planWithDate = { ...plan, date: planDate };

      try {
        const notionPage = await notion.createPlanEntry(planWithDate);
        if (notionPage?.id) db.setPlanNotionId(planId, notionPage.id);
      } catch {}

      if (plan.time) {
        scheduleTimedPlanReminders(chatId, planId, planWithDate);
        try {
          const gcalEvent = await gcal.createEvent({ title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
          db.setPlanCalendar(planId);
          if (gcalEvent?.id) db.setPlanGCalId(planId, gcalEvent.id);
        } catch {}
        lines.push(`${plan.title} @ ${plan.time}`);
      } else {
        lines.push(plan.title);
      }
    }
    return lines.join(', ');
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
