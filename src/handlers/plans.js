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
    const fallbackDate = isSleeping
      ? (userState.bed_plans_tomorrow || getTomorrowStr())
      : getTomorrowStr();

    const plans = await claude.parsePlans(msg.text || '', nowContext());
    if (!plans.length) {
      await handleAskFallback(bot, msg);
      return;
    }

    const confirmations = [];
    for (const plan of plans) {
      const planDate = (!plan.date || (isSleeping && plan.date === getTodayStr())) ? fallbackDate : plan.date;
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
          await gcal.createEvent({ title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
          db.setPlanCalendar(planId);
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

    await bot.sendMessage(chatId, confirmations.join('\n'));
  } catch (err) {
    console.error('Plan handler error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not save plan. Try: "gym tomorrow at 10am"');
  }
}

function scheduleTimedPlanReminders(chatId, planId, plan) {
  const { getDateAt, getTodayStr } = require('../utils/time');
  const [h, m] = plan.time.split(':').map(Number);
  const eventMs = getDateAt(plan.date, h, m);

  // 30 min before
  const reminderMs = eventMs - 30 * 60 * 1000;
  if (reminderMs > Date.now()) {
    cronSvc.scheduleOnce(chatId, reminderMs, () =>
      cronSvc.getBotRef()?.sendMessage(chatId, `${plan.title} in 30 min`).catch(() => {})
    );
  }

  // 1 hour after to check if done
  const checkMs = eventMs + 60 * 60 * 1000;
  if (checkMs > Date.now()) {
    cronSvc.scheduleOnce(chatId, checkMs, async () => {
      const dbPlan = db.getAllPending(chatId).find(p => p.id === planId);
      if (dbPlan && dbPlan.status !== 'done') {
        try { await cronSvc.getBotRef()?.sendMessage(chatId, `did you do ${plan.title}?`); } catch {}
        // Auto-skip after 2 more hours with no reply
        cronSvc.scheduleOnce(chatId, Date.now() + 2 * 3600 * 1000, () => {
          db.updatePlanStatus(planId, 'skipped');
        });
      }
    });
  }

  // Night before at 9 PM
  const { getDateAt: gda } = require('../utils/time');
  const [yr, mo, dy] = plan.date.split('-').map(Number);
  const prevDay = new Date(Date.UTC(yr, mo - 1, dy - 1));
  const prevDayStr = prevDay.toISOString().split('T')[0];
  const nightBeforeMs = gda(prevDayStr, 21, 0);
  if (nightBeforeMs > Date.now()) {
    cronSvc.scheduleOnce(chatId, nightBeforeMs, () =>
      cronSvc.getBotRef()?.sendMessage(chatId, `tomorrow: ${plan.title} at ${plan.time}`).catch(() => {})
    );
  }
}

async function handlePlanDone(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const pending = db.getAllPending(chatId);
    if (!pending.length) { await bot.sendMessage(chatId, 'No pending plans to mark done.'); return; }
    const last = pending[pending.length - 1];
    db.updatePlanStatus(last.id, 'done');
    if (last.notion_page_id) await notion.updatePlanStatusNotion(last.notion_page_id, 'Done').catch(() => {});
    await bot.sendMessage(chatId, `✅ Done: ${last.plan_text}. Off your list.`);
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
    const last = pending[pending.length - 1];
    const tomorrow = getTomorrowStr();
    db.updatePlanStatus(last.id, 'skipped');
    db.savePlan(chatId, { text: last.plan_text, date: tomorrow, time: null, recurring: 'one-time' });
    await bot.sendMessage(chatId, `Moved to tomorrow: ${last.plan_text}.`);
  } catch (err) {
    console.error('Plan skip error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not update plan.');
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
          await gcal.createEvent({ title: plan.title, date: planDate, time: plan.time, duration_min: plan.duration_min, location: plan.location, guests: plan.guests || [] });
          db.setPlanCalendar(planId);
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
