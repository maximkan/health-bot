const claude = require('../claude');
const notion = require('../notion');

async function handleBody(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseBody(msg.text || msg.caption || '');
    const lastEntry = await notion.getLastBodyMeasurement().catch(() => null);
    const weight_change = lastEntry?.weight_kg != null ? +(data.weight_kg - lastEntry.weight_kg).toFixed(1) : null;
    await notion.createBodyEntry({ ...data, weight_change });
    const bmi = +(data.weight_kg / (1.76 * 1.76)).toFixed(1);
    const lines = [`✅ ${data.weight_kg} kg  ·  BMI ${bmi}`];
    if (data.body_fat_pct != null) lines.push(`Body fat: ${data.body_fat_pct}%`);
    if (weight_change !== null) {
      lines.push(`Change: ${weight_change >= 0 ? '+' : ''}${weight_change} kg from last entry`);
    }
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    console.error('Body error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to log. Try: "104.2 kg, 28% body fat"');
  }
}

module.exports = { handleBody };
