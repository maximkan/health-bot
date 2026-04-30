const claude = require('../claude');
const notion = require('../notion');
const gcal   = require('../gcal');
const db     = require('../db');
const { nowContext, getMalaysiaDateStr, getTomorrowStr, getMalaysiaHour, getDayOfWeek } = require('../utils/time');
const { getCurrentWeekType } = require('../utils/weekTracker');

const FULL_ANALYSIS_TRIGGERS = [
  'full analysis','progress report','how am i doing overall','summary since beginning',
  'how\'s my progress','how is my progress','overall progress','how am i doing since',
  'since the start','since i started','progress so far','how have i been doing',
  'trend analysis','show me my progress','give me a full breakdown',
];

async function buildDayContext(chatId) {
  const state    = db.getState(chatId);
  const todayStr = getMalaysiaDateStr();
  const lines    = [nowContext()];

  // Wake time from DB
  if (state.current_day_start) {
    const wakeMYT = new Date(state.current_day_start + 8 * 3600 * 1000).toISOString().slice(11, 16);
    lines.push(`Woke up at: ${wakeMYT} MYT`);
  }

  // Today's totals — always from SQLite (source of truth)
  const dayData = db.getDayDataFromSQLite(chatId, state.current_day_start);
  const t = dayData.totals;
  if (t.calories > 0 || t.protein > 0) {
    lines.push(`Today so far: ${Math.round(t.calories)} kcal, ${Math.round(t.protein)}g protein, ${Math.round(t.carbs)}g carbs, ${Math.round(t.fat)}g fat`);
  }
  if (dayData.workouts.length) lines.push(`Workouts today: ${dayData.workouts.map(w => w.name).join(', ')}`);
  if (dayData.meals.length)    lines.push(`Meals logged: ${dayData.meals.map(m => m.name).join(', ')}`);

  // Plans
  const timedToday    = db.getPendingTimed(chatId, todayStr);
  const timedTomorrow = db.getPendingTimed(chatId, getTomorrowStr());
  const tasks         = db.getPendingUntimed(chatId);
  const gcalToday     = await gcal.getEventsForDate(chatId, todayStr).catch(() => []);
  const dbTodayTitles = new Set(timedToday.map(p => p.plan_text.toLowerCase()));
  const gcalTodayExtra = gcalToday.filter(e => !e.allDay && e.time && !dbTodayTitles.has(e.title.toLowerCase()));

  const allToday = [
    ...timedToday.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalTodayExtra.map(e => `${e.title} at ${e.time}`),
  ];
  if (allToday.length)      lines.push(`Today's plans: ${allToday.join(', ')}`);
  if (timedTomorrow.length && getMalaysiaHour() >= 19) lines.push(`Tomorrow's plans: ${timedTomorrow.map(p => `${p.plan_text} at ${p.plan_time}`).join(', ')}`);
  if (tasks.length)         lines.push(`Pending tasks: ${tasks.map(p => p.plan_text).join(', ')}`);

  return lines.join('\n');
}

// Strip markdown that Claude still generates despite instructions
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → plain
    .replace(/\*(.+?)\*/g, '$1')        // *italic* → plain
    .replace(/^#{1,3}\s+/gm, '')        // ## headers → plain
    .replace(/^[-•]\s+/gm, '  ')        // - bullets → indented
    .trim();
}

async function handleAsk(bot, msg, context = '') {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  const text = msg.text || msg.caption || '';

  const lc = text.toLowerCase();
  const isFullAnalysis  = FULL_ANALYSIS_TRIGGERS.some(t => lc.includes(t));
  const isTrendQuestion = !isFullAnalysis && ['this week','last week','past few days','recently','pattern','trend','lately','past week','last few days','3 days','few days'].some(t => lc.includes(t));

  try {
    let targetsCtx = '';
    try { targetsCtx = notion.getTargetsText(chatId); } catch {}

    let knownFoodsCtx = '';
    try { knownFoodsCtx = notion.getKnownFoodsContext(chatId, getDayOfWeek(), getCurrentWeekType()); } catch {}

    const dayCtx = await buildDayContext(chatId);

    // Only add multi-day trend data when the question is trend-related (not for daily questions)
    let trendCtx = '';
    if (isTrendQuestion) {
      try {
        const weekStartMs = Date.now() - 7 * 24 * 3600 * 1000;
        const weekData = db.getWeekDataFromSQLite(chatId, weekStartMs);
        if (weekData && Object.keys(weekData.dailyTotals || {}).length > 1) {
          const days = Object.entries(weekData.dailyTotals).sort(([a],[b]) => a.localeCompare(b));
          const trendLines = days.map(([date, d]) => `  ${date}: ${Math.round(d.calories)} kcal / ${Math.round(d.protein)}g P`);
          trendCtx = `\nLast 7 days (kcal / protein):\n${trendLines.join('\n')}`;
          if (weekData.trainDays) trendCtx += `\nWorkouts this week: ${weekData.trainDays}`;
          if (weekData.avgSleep)  trendCtx += `\nAvg sleep this week: ${weekData.avgSleep}h`;
        }
      } catch {}
    }

    const notionCtx = [context || dayCtx, trendCtx].filter(Boolean).join('\n');

    if (isFullAnalysis) {
      await bot.sendMessage(chatId, 'pulling all your data...');
      try {
        const [bodyMeasurements, historical] = await Promise.all([
          notion.getAllBodyMeasurements().catch(() => []),
          notion.getHistoricalData().catch(() => null),
        ]);
        const fullCtx = [
          dayCtx,
          `\nBody measurements:\n${JSON.stringify(bodyMeasurements, null, 2)}`,
          historical ? `\nAll-time daily nutrition:\n${JSON.stringify(historical.dailyTotals, null, 2)}` : '',
          historical?.workouts?.length ? `\nWorkout history:\n${JSON.stringify(historical.workouts, null, 2)}` : '',
          historical?.sleep?.length    ? `\nSleep history:\n${JSON.stringify(historical.sleep, null, 2)}`    : '',
        ].join('');
        const answer = stripMarkdown(await claude.generateFullAnalysis({ context: fullCtx }, targetsCtx));
        await bot.sendMessage(chatId, answer);
      } catch (err) {
        console.error('Full analysis error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not pull full analysis. Try again.');
      }
      return;
    }

    const userProfile = db.getState(chatId);
    const answer = stripMarkdown(await claude.askCoach(text, notionCtx, targetsCtx, knownFoodsCtx, userProfile));
    const sent = await bot.sendMessage(chatId, answer);
    db.setState(chatId, {
      last_coach_message_id: sent.message_id,
      last_coach_context: JSON.stringify({ message: answer, context: notionCtx, timestamp: Date.now() }),
    });
    db.saveCoachMessage(chatId, 'assistant', answer, sent.message_id);
  } catch (err) {
    console.error('Ask handler error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

async function handleCoachReply(bot, msg, coachMessageId) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const state = db.getState(chatId);
    const exchanges = db.countExchanges(chatId, coachMessageId);

    if (exchanges >= 5) {
      db.clearReplyChain(chatId, coachMessageId);
      await handleAsk(bot, msg);
      return;
    }

    const dayCtx = await buildDayContext(chatId);

    const chain = db.getReplyChain(chatId, coachMessageId);
    const messages = chain.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: `${dayCtx}\n\n${msg.text || ''}` });
    db.saveCoachMessage(chatId, 'user', msg.text || '', coachMessageId);

    let targetsCtx = '';
    try { targetsCtx = notion.getTargetsText(); } catch {}

    const answer = stripMarkdown(await claude.continueCoachReply(messages, targetsCtx));
    const sent = await bot.sendMessage(chatId, answer);
    db.saveCoachMessage(chatId, 'assistant', answer, coachMessageId);
    db.setState(chatId, { last_coach_message_id: sent.message_id });
  } catch (err) {
    console.error('Coach reply error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

async function handlePhotoQuestion(bot, msg, photoBase64) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    let targetsCtx = '';
    try { targetsCtx = notion.getTargetsText(); } catch {}
    const answer = stripMarkdown(await claude.askWithPhoto(photoBase64, msg.caption || 'What can you tell me about this?', targetsCtx));
    await bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error('Photo question error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

module.exports = { handleAsk, handleCoachReply, handlePhotoQuestion, stripMarkdown };
