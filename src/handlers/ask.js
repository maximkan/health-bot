const claude = require('../claude');
const notion = require('../notion');
const gcal   = require('../gcal');
const db     = require('../db');
const { nowContext, getMalaysiaDateStr, getTomorrowStr, getMalaysiaHour } = require('../utils/time');

const FULL_ANALYSIS_TRIGGERS = ['full analysis','progress report','how am i doing overall','summary since beginning','how\'s my progress','how is my progress','overall progress'];

async function buildDayContext(chatId) {
  const state    = db.getState(chatId);
  const todayStr = getMalaysiaDateStr();
  const lines    = [nowContext()];

  // Today's pending plans
  const timedToday  = db.getPendingTimed(chatId, todayStr);
  const timedTomorrow = db.getPendingTimed(chatId, getTomorrowStr());
  const tasks       = db.getPendingUntimed(chatId);

  // Merge SQLite plans with GCal events
  const gcalToday = await gcal.getEventsForDate(todayStr).catch(() => []);
  const dbTodayTitles = new Set(timedToday.map(p => p.plan_text.toLowerCase()));
  const gcalTodayExtra = gcalToday.filter(e => !e.allDay && e.time && !dbTodayTitles.has(e.title.toLowerCase()));

  const allToday = [
    ...timedToday.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalTodayExtra.map(e => `${e.title} at ${e.time}`),
  ];
  if (allToday.length)      lines.push(`Today's plans: ${allToday.join(', ')}`);
  if (timedTomorrow.length && getMalaysiaHour() >= 19) lines.push(`Tomorrow's plans: ${timedTomorrow.map(p => `${p.plan_text} at ${p.plan_time}`).join(', ')}`);
  if (tasks.length)         lines.push(`Pending tasks: ${tasks.map(p => p.plan_text).join(', ')}`);

  // Today's totals from Notion
  try {
    const dayData = await notion.getDayData(state.current_day_start);
    const t = dayData.totals;
    if (t.calories > 0 || t.protein > 0) {
      lines.push(`Today so far: ${Math.round(t.calories)} kcal, ${Math.round(t.protein)}g protein, ${Math.round(t.carbs)}g carbs, ${Math.round(t.fat)}g fat`);
    }
    if (dayData.workouts.length) lines.push(`Workouts today: ${dayData.workouts.map(w => w.name).join(', ')}`);
    if (dayData.meals.length)    lines.push(`Meals logged: ${dayData.meals.map(m => m.name).join(', ')}`);
  } catch {}

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

  const isFullAnalysis = FULL_ANALYSIS_TRIGGERS.some(t => text.toLowerCase().includes(t));

  try {
    let targetsCtx = '';
    try { targetsCtx = await notion.getTargetsText(); } catch {}

    const dayCtx = await buildDayContext(chatId);
    const notionCtx = context ? `${dayCtx}\n${context}` : dayCtx;

    if (isFullAnalysis) {
      await bot.sendMessage(chatId, 'pulling all your data...');
      try {
        const bodyMeasurements = await notion.getAllBodyMeasurements().catch(() => []);
        const fullCtx = `${notionCtx}\nBody measurements:\n${JSON.stringify(bodyMeasurements, null, 2)}`;
        const answer = stripMarkdown(await claude.generateFullAnalysis({ context: fullCtx }, targetsCtx));
        await bot.sendMessage(chatId, answer);
      } catch (err) {
        console.error('Full analysis error:', err.message);
        await bot.sendMessage(chatId, '❌ Could not pull full analysis. Try again.');
      }
      return;
    }

    const answer = stripMarkdown(await claude.askCoach(text, notionCtx, targetsCtx));
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
    try { targetsCtx = await notion.getTargetsText(); } catch {}

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
    try { targetsCtx = await notion.getTargetsText(); } catch {}
    const answer = stripMarkdown(await claude.askWithPhoto(photoBase64, msg.caption || 'What can you tell me about this?', targetsCtx));
    await bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error('Photo question error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Please try again.');
  }
}

module.exports = { handleAsk, handleCoachReply, handlePhotoQuestion, stripMarkdown };
