const claude = require('../claude');
const notion = require('../notion');
const db     = require('../db');

async function handleBody(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseBody(msg.text || msg.caption || '');
    const state = db.getState(chatId);

    const lastEntry = db.getLastBodyMeasurement(chatId);
    const weight_change = lastEntry?.weight_kg != null ? +(data.weight_kg - lastEntry.weight_kg).toFixed(1) : null;

    // Height from targets for BMI calc
    const targets = db.getTargetsFromDb(chatId);
    const heightCm = targets?.height_cm ?? 176;
    const bmi = data.weight_kg ? +(data.weight_kg / ((heightCm / 100) ** 2)).toFixed(1) : null;

    db.saveBodyLog(chatId, { ...data, bmi, height_cm: heightCm });
    // Keep targets.weight_kg current so TDEE and calorie burns stay accurate
    if (data.weight_kg) db.setTargetsInDb(chatId, { weight_kg: data.weight_kg });
    if (state.notion_enabled) {
      notion.createBodyEntry(chatId, { ...data, weight_change }).catch(err => console.error('Notion body sync error:', err.message));
    }

    const lines = [`✅ ${data.weight_kg} kg${bmi ? `  ·  BMI ${bmi}` : ''}`];
    if (data.body_fat_pct != null) lines.push(`Body fat: ${data.body_fat_pct}%`);
    if (data.muscle_mass_kg != null) lines.push(`Muscle mass: ${data.muscle_mass_kg} kg`);
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
