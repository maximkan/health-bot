const claude = require('../claude');
const notion = require('../notion');

async function handleRecovery(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseRecovery(msg.text || msg.caption || '');
    if (data.temperature_c == null) {
      await bot.sendMessage(chatId, 'What was the temperature? (e.g. "85°C" for sauna, "14°C" for cold plunge)');
      return;
    }
    if (msg._retroDate?.dateStr) data.date = msg._retroDate.dateStr;
    await notion.createRecoveryEntry(data);
    const retro = msg._retroDate?.dateStr ? ` (${msg._retroDate.dateStr})` : '';
    await bot.sendMessage(chatId, `✅ ${data.type} — ${data.duration_min} min @ ${data.temperature_c}°C${retro}`);
  } catch (err) {
    console.error('Recovery error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to log. Try: "sauna 15min 85°C"');
  }
}

module.exports = { handleRecovery };
