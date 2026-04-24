const claude = require('../claude');
const notion = require('../notion');

function formatWorkoutPreview(data) {
  const dur = data.duration_min ? `${data.duration_min} min` : null;
  const cal = data.calories_burned ? `~${data.calories_burned} kcal burned` : null;
  const retro = data.date ? ` (${data.date})` : '';
  const header = `💪 ${[data.workout_name + retro, dur, cal].filter(Boolean).join(' — ')}`;
  const exLines = (data.exercises || []).slice(0, 6).map(e => {
    let s = `  ${e.name}`;
    if (e.sets && e.reps) s += ` ${e.sets}×${e.reps}`;
    if (e.weight_kg) s += ` @${e.weight_kg}kg`;
    return s;
  });
  const lines = [header, ...(exLines.length ? exLines : (data.exercises_summary ? [`  ${data.exercises_summary}`] : []))];
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

async function showWorkoutPreview(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseWorkout(msg.text || msg.caption || '');
    if (msg._retroDate?.dateStr) data.date = msg._retroDate.dateStr;
    await bot.sendMessage(chatId, formatWorkoutPreview(data));
    return data;
  } catch (err) {
    console.error('Workout preview error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to parse workout. Try again.');
    return null;
  }
}

async function logWorkout(bot, chatId, data) {
  try {
    await notion.createWorkoutEntry(data);
    const dur = data.duration_min ? `${data.duration_min} min` : null;
    const cal = data.calories_burned ? `~${data.calories_burned} kcal` : null;
    const retro = data.date ? ` (${data.date})` : '';
    await bot.sendMessage(chatId, `✅ ${[data.workout_name + retro, dur, cal].filter(Boolean).join(' — ')}`);
  } catch (err) {
    console.error('Workout log error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to write to Notion. Try again.');
  }
}

module.exports = { showWorkoutPreview, logWorkout, formatWorkoutPreview };
