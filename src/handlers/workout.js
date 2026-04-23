const claude  = require('../claude');
const notion  = require('../notion');

// pendingWorkouts: chatId -> { pageId, workoutName }
const pendingWorkouts = new Map();

function formatWorkoutConfirm(data) {
  const dur = data.duration_min ? `${data.duration_min} min` : null;
  const cal = data.calories_burned ? `~${data.calories_burned} kcal` : null;
  const header = [data.workout_name, dur, cal].filter(Boolean).join(' — ');
  const exStr = (data.exercises || []).slice(0, 4).map(e => {
    let s = e.name;
    if (e.sets && e.reps) s += ` ${e.sets}×${e.reps}`;
    if (e.weight_kg) s += `@${e.weight_kg}kg`;
    return s;
  }).join(', ');
  return { header, exStr };
}

async function handleWorkout(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const data = await claude.parseWorkout(msg.text || msg.caption || '');
    const page = await notion.createWorkoutEntry(data);
    const { header, exStr } = formatWorkoutConfirm(data);

    const isSparse = !data.duration_min && (!data.exercises || data.exercises.length === 0);

    if (isSparse) {
      pendingWorkouts.set(chatId, { pageId: page?.id, workoutName: data.workout_name });
      await bot.sendMessage(chatId, `✅ ${header} logged.\n${exStr || ''}\nHow long and what exercises? (or skip)`);
    } else {
      pendingWorkouts.delete(chatId);
      await bot.sendMessage(chatId, `✅ ${header}\n${exStr || data.exercises_summary || ''}`);
    }
  } catch (err) {
    console.error('Workout error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to log workout. Try again.');
  }
}

async function handleWorkoutDetails(bot, chatId, text) {
  const pending = pendingWorkouts.get(chatId);
  if (!pending) return false;

  const skip = /^(skip|no|nah|done|nothing|nope)$/i.test(text.trim());
  if (skip) {
    pendingWorkouts.delete(chatId);
    return true;
  }

  try {
    // Re-parse details from follow-up message
    const data = await claude.parseWorkout(`${pending.workoutName}: ${text}`);
    if (pending.pageId) {
      await notion.updateWorkoutEntry(pending.pageId, data);
    }
    pendingWorkouts.delete(chatId);
    const { header, exStr } = formatWorkoutConfirm(data);
    await bot.sendMessage(chatId, `✅ updated: ${header}\n${exStr || data.exercises_summary || ''}`);
    return true;
  } catch (err) {
    console.error('Workout details error:', err.message);
    pendingWorkouts.delete(chatId);
    return true;
  }
}

function hasPendingWorkout(chatId) {
  return pendingWorkouts.has(chatId);
}

module.exports = { handleWorkout, handleWorkoutDetails, hasPendingWorkout };
