const claude = require('../claude');

async function handleSleep(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseSleep(msg.text || msg.caption || '');
    const isNap = data.type === 'Nap';
    const fmtH = (h) => { if (h == null) return '?'; const m = Math.round(h * 60); return `${Math.floor(m/60)}h ${m%60}m`; };
    const label = isNap
      ? `😪 Nap — ${data.bed_time} → ${data.wake_time} (${fmtH(data.hours_slept)})`
      : `✅ Sleep — ${data.bed_time} → ${data.wake_time} (${fmtH(data.hours_slept)}) quality ${data.quality}/5`;
    await bot.sendMessage(chatId, label);
  } catch (err) {
    console.error('Sleep error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to log. Try: "slept at 1am, woke 8:30, quality 4"');
  }
}

module.exports = { handleSleep };
