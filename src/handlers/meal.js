const claude = require('../claude');
const notion = require('../notion');
const db     = require('../db');
const { getDayOfWeek } = require('../utils/time');
const { getCurrentWeekType } = require('../utils/weekTracker');

function formatPreview(data) {
  const header = data._hasPhoto ? '📷 looks like:' : '🍽 my estimate:';
  const lines = [`${header} ${data.meal_name}\n`];

  for (const item of (data.items || [])) {
    const g = item.weight_g ? ` (${item.weight_g}g)` : '';
    lines.push(`  ${item.name}${g} — ${item.calories} kcal · ${item.protein}g P · ${item.carbs}g C · ${item.fat}g F`);
  }

  lines.push('');
  lines.push(`📊 ${Math.round(data.totals.calories)} kcal · ${Math.round(data.totals.protein)}g P · ${Math.round(data.totals.carbs)}g C · ${Math.round(data.totals.fat)}g F`);
  if ((data.caffeine_mg ?? 0) > 0) lines.push(`☕ ${data.caffeine_mg}mg caffeine`);
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

function formatConfirmation(data, totals, targets) {
  const T = targets || { calories: 1600, protein: 220 };
  const cal  = Math.round(totals?.calories ?? 0);
  const prot = Math.round(totals?.protein  ?? 0);
  const calLeft  = T.calories - cal;

  const lines = [
    `✅ ${data.meal_name} — ${Math.round(data.totals.calories)} kcal · ${Math.round(data.totals.protein)}g P`,
  ];
  if ((data.caffeine_mg ?? 0) > 0) lines[0] += ` · ☕ ${data.caffeine_mg}mg`;
  if (totals) {
    lines.push(`📊 today: ${cal} / ${T.calories} kcal · ${prot} / ${T.protein}g P`);
    if (calLeft > 0)  lines.push(`${calLeft} kcal left 💪`);
    else              lines.push(`⚠️ ${Math.abs(calLeft)} kcal over target`);
  }
  return lines.join('\n');
}

async function showMealPreview(bot, msg, photos) {
  const chatId    = msg.chat.id;
  const photoList = Array.isArray(photos) ? photos : (photos ? [photos] : []);
  const hasPhoto  = photoList.length > 0;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const caption = msg.caption || msg.text || '';
    const dayOfWeek = getDayOfWeek();
    const weekType  = getCurrentWeekType();
    let knownFoodsCtx = '';
    try { knownFoodsCtx = await notion.getKnownFoodsContext(dayOfWeek, weekType); } catch {}

    const { nowContext } = require('../utils/time');
    const data = await claude.analyzeMeal(photoList, caption, dayOfWeek, knownFoodsCtx, nowContext());

    if (data.confidence === 'low' && data.clarification) {
      await bot.sendMessage(chatId, `🤔 ${data.clarification}`);
      return null;
    }

    await bot.sendMessage(chatId, formatPreview(data));
    return data;
  } catch (err) {
    console.error('Meal preview error:', err.message);
    await bot.sendMessage(chatId, hasPhoto
      ? '❌ Failed to analyze photo. Try again or describe the food in text.'
      : '❌ Could not estimate that meal. Add more detail.');
    return null;
  }
}

async function logMeal(bot, chatId, data, dayStart) {
  try {
    await notion.createMealEntry(data);
    const caffeineMg = data.caffeine_mg ?? 0;
    if (caffeineMg > 0) db.addCaffeine(chatId, caffeineMg);

    let totals  = null;
    let targets = null;
    try { totals  = await notion.getDailyMealTotals(dayStart); } catch {}
    try { targets = await notion.getTargets(); } catch {}

    await bot.sendMessage(chatId, formatConfirmation(data, totals, targets));
  } catch (err) {
    console.error('Meal log error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to write to Notion. Try again.');
  }
}

async function applyCorrection(bot, chatId, existingData, correctionText) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    return await claude.applyMealCorrection(existingData, correctionText);
  } catch (err) {
    console.error('Correction error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not apply correction. Try rephrasing.');
    return null;
  }
}

module.exports = { showMealPreview, logMeal, applyCorrection, formatPreview, formatConfirmation };
