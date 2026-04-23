const claude = require('../claude');
const notion = require('../notion');
const db     = require('../db');
const { buildTimeISO, nowContext } = require('../utils/time');

const DB_TIME_MAP = {
  meal:     { key: 'mealLog',          titleProp: 'Meal'     },
  workout:  { key: 'workoutLog',       titleProp: 'Workout'  },
  sleep:    { key: 'sleepLog',         titleProp: 'Sleep'    },
  recovery: { key: 'recoveryLog',      titleProp: 'Session'  },
  body:     { key: 'bodyMeasurements', titleProp: 'Check-in' },
};

async function handleCorrection(bot, msg, chatId, userState) {
  await bot.sendChatAction(chatId, 'typing');
  const text = msg.text || '';

  // First try time correction (fast, Haiku)
  const timeCorrection = await claude.parseTimeCorrection(text).catch(() => null);

  if (timeCorrection?.entry_type && timeCorrection?.new_time) {
    await applyTimeCorrection(bot, chatId, userState, timeCorrection);
    return;
  }

  // Fall back to general correction (Sonnet)
  try {
    const correction = await claude.parseCorrection(text, `${nowContext()}\nUser status: ${userState.status}`);
    if (!correction) { await bot.sendMessage(chatId, '❌ Could not understand the correction. Try: "change time of my lunch to 2pm"'); return; }

    if (correction.action === 'update_time' && correction.new_time) {
      await applyTimeCorrection(bot, chatId, userState, { entry_type: correction.entry_type, description: correction.description, new_time: correction.new_time });
    } else {
      await bot.sendMessage(chatId, `❌ I can update log times for now. Try: "change time of my lunch to 2pm"`);
    }
  } catch (err) {
    console.error('Correction error:', err.message);
    await bot.sendMessage(chatId, '❌ Could not process correction. Try: "change time of my lunch to 2pm"');
  }
}

async function applyTimeCorrection(bot, chatId, userState, correction) {
  const { entry_type, description, new_time } = correction;
  const conf = DB_TIME_MAP[entry_type];
  if (!conf) { await bot.sendMessage(chatId, `❌ Unknown entry type: ${entry_type}`); return; }

  const entries = await notion.getEntriesForDay(conf.key, conf.titleProp, userState.current_day_start).catch(() => []);
  if (!entries.length) { await bot.sendMessage(chatId, `No ${entry_type} entries found today.`); return; }

  const newISO = buildTimeISO(new_time);

  if (entries.length === 1) {
    await notion.correctEntryTime(entries[0].pageId, newISO);
    await bot.sendMessage(chatId, `✅ Updated: ${entries[0].title} → ${new_time}`);
    return;
  }

  // Multiple entries — need to pick
  const lines = [`Which ${entry_type}?\n`, ...entries.map((e, i) => `${i + 1}. ${e.title}`)];
  return { entries, newISO, lines: lines.join('\n') };
}

module.exports = { handleCorrection, applyTimeCorrection };
