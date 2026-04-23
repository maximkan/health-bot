const claude = require('../claude');
const notion = require('../notion');

async function handleSleep(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseSleep(msg.text || msg.caption || '');
    await notion.createSleepEntry(data);
    await bot.sendMessage(chatId, `✅ Sleep — ${data.bed_time} → ${data.wake_time}  (${data.hours_slept}h)  quality ${data.quality}/5`);
  } catch (err) {
    console.error('Sleep error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to log. Try: "slept at 1am, woke 8:30, quality 4"');
  }
}

module.exports = { handleSleep };
