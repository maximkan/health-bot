const claude = require('../claude');
const db     = require('../db');
const { nowContextTz } = require('../utils/time');

async function handleCorrection(bot, msg, chatId, userState) {
  await bot.sendChatAction(chatId, 'typing');
  const text = msg.text || '';

  const timeCorrection = await claude.parseTimeCorrection(text).catch(() => null);
  if (timeCorrection?.entry_type && timeCorrection?.new_time) {
    await applyTimeCorrection(bot, chatId, userState, timeCorrection);
    return;
  }

  try {
    const correction = await claude.parseCorrection(text, `${nowContextTz(userState.timezone)}\nUser status: ${userState.status}`);
    if (!correction) { await bot.sendMessage(chatId, '❌ Could not understand the correction. Try: "change time of my lunch to 2pm"'); return; }

    if (correction.action === 'update_time' && correction.new_time) {
      await applyTimeCorrection(bot, chatId, userState, { entry_type: correction.entry_type, description: correction.description, new_time: correction.new_time });
    } else {
      await bot.sendMessage(chatId, `❌ I can update log times for now. Try: "change time of my lunch to 2pm"`);
    }
  } catch (err) {
    console.error('Correction error:', err.message);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function applyTimeCorrection(bot, chatId, userState, correction) {
  const { entry_type, description, new_time } = correction;
  const dayStart = userState.current_day_start;

  // sleep correction: update bed_time or wake_time in sleep_log
  if (entry_type === 'sleep') {
    await bot.sendMessage(chatId, `❌ Sleep time correction isn't supported yet.`);
    return;
  }

  if (entry_type !== 'meal' && entry_type !== 'workout') {
    await bot.sendMessage(chatId, `❌ Can only correct meal or workout times.`);
    return;
  }

  const entries = db.getEntriesForDay(chatId, entry_type, dayStart);
  if (!entries.length) { await bot.sendMessage(chatId, `No ${entry_type} entries found today.`); return; }

  let target = entries.length === 1 ? entries[0] : null;
  if (!target && description) {
    const lc = description.toLowerCase();
    target = entries.find(e => String(e.title).toLowerCase().includes(lc)) ?? null;
  }
  if (!target && entries.length > 1) {
    const lines = [`Which ${entry_type}?\n`, ...entries.map((e, i) => `${i + 1}. ${e.title}`)];
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }
  if (!target) { await bot.sendMessage(chatId, `couldn't find that ${entry_type}.`); return; }

  db.updateLogTime(entry_type, target.id, new_time);
  await bot.sendMessage(chatId, `✅ ${target.title} → ${new_time}`);
}

module.exports = { handleCorrection, applyTimeCorrection };
