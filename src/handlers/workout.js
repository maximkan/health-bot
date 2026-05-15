const claude = require('../claude');
const db     = require('../db');
const { calculateTDEE } = require('../utils/tdee');

// Server-side calorie calculation — overrides Claude's estimate so LLM math errors can't slip through
function computeWorkoutCalories(chatId, data) {
  const lastBody = db.getLastBodyMeasurement(chatId);
  const targets  = db.getTargetsFromDb(chatId);
  const weight   = lastBody?.weight_kg ?? targets.weight_kg ?? 105;
  let dur = data.duration_min ?? 0;
  if (!dur) {
    // Estimate duration from set count when not logged
    const exercises = data.exercises ?? [];
    const totalSets = exercises.reduce((s, e) => {
      if (e.sets_detail?.length) return s + e.sets_detail.reduce((a, d) => a + (d.sets ?? 1), 0);
      return s + (e.sets ?? 1);
    }, 0);
    const actType = (data.activity_type ?? '').toLowerCase();
    const minPerSet = (actType.includes('hiit') || actType.includes('circuit')) ? 1.5 : 3;
    dur = totalSets > 0 ? Math.round(totalSets * minPerSet) : 0;
    if (!dur) return data.calories_burned ?? 0;
  }

  const actType = (data.activity_type ?? '').toLowerCase();

  // Cardio: fixed MET per type
  if (actType.includes('run') || actType.includes('jog'))    return Math.round(8.0 * weight * (dur / 60));
  if (actType.includes('cycl') || actType.includes('bike'))  return Math.round(6.8 * weight * (dur / 60));
  if (actType.includes('row'))                                return Math.round(7.0 * weight * (dur / 60));
  if (actType.includes('swim'))                               return Math.round(6.0 * weight * (dur / 60));
  if (actType.includes('hiit') || actType.includes('circuit')) return Math.round(8.0 * weight * (dur / 60));
  if (actType.includes('walk'))                               return Math.round(3.5 * weight * (dur / 60));

  // Strength / default: density-based MET
  const exercises = data.exercises ?? [];
  const totalSets = exercises.reduce((s, e) => {
    if (e.sets_detail?.length) return s + e.sets_detail.reduce((a, d) => a + (d.sets ?? 1), 0);
    return s + (e.sets ?? 1);
  }, 0);
  const density   = dur > 0 ? totalSets / dur : 0;
  const met       = density > 0.4 ? 5.5 : density >= 0.25 ? 4.5 : 3.5;
  return Math.round(met * weight * (dur / 60));
}

function formatExerciseLine(e) {
  let s = `  ${e.name}`;
  if (e.sets_detail?.length) {
    if (e.sets_detail.length === 1) {
      const d = e.sets_detail[0];
      if (d.sets && d.reps) s += ` ${d.sets}×${d.reps}`;
      if (d.weight_kg) s += ` @${d.weight_kg}kg`;
    } else {
      s += ' ' + e.sets_detail.map(d => `${d.sets}×${d.reps}${d.weight_kg ? '@' + d.weight_kg + 'kg' : ''}`).join(' + ');
    }
  } else {
    if (e.sets && e.reps) s += ` ${e.sets}×${e.reps}`;
    if (e.weight_kg) s += ` @${e.weight_kg}kg`;
  }
  return s;
}

function formatWorkoutPreview(data) {
  const dur = data.duration_min ? `${data.duration_min} min` : null;
  const cal = data.calories_burned ? `~${data.calories_burned} kcal burned` : null;
  const retro = data.date ? ` (${data.date})` : '';
  const timeLabel = data.time ? ` @ ${data.time}` : '';
  const header = `💪 ${[data.workout_name + retro, dur, cal].filter(Boolean).join(' — ')}${timeLabel}`;
  const exLines = (data.exercises || []).map(formatExerciseLine);
  const lines = [header, ...(exLines.length ? exLines : (data.exercises_summary ? [`  ${data.exercises_summary}`] : []))];
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

async function showWorkoutPreview(bot, msg) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    const knownExs = db.getKnownExercises(chatId);
    const knownCtx = knownExs.map(e => {
      let s = `- ${e.name}`;
      if (e.sets && e.reps) s += ` (typical: ${e.sets}×${e.reps}`;
      if (e.weight_kg) s += `${(e.sets && e.reps) ? ', ' : ' ('}@${e.weight_kg}kg`;
      if (e.sets && e.reps || e.weight_kg) s += ')';
      return s;
    }).join('\n');
    const body = db.getLastBodyMeasurement(chatId);
    const tgts = db.getTargetsFromDb(chatId);
    const userWeight = body?.weight_kg ?? tgts.weight_kg ?? 80;
    const data = await claude.parseWorkout(msg.text || msg.caption || '', knownCtx, userWeight);
    if (msg._retroDate?.dateStr) data.date = msg._retroDate.dateStr;
    data.calories_burned = computeWorkoutCalories(chatId, data);
    await bot.sendMessage(chatId, formatWorkoutPreview(data));
    return data;
  } catch (err) {
    console.error('Workout preview error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to parse workout. Try again.');
    return null;
  }
}

async function logWorkout(bot, chatId, data, dayStart) {
  try {
    const workoutId = db.saveWorkoutLog(chatId, data, dayStart);
    const dur = data.duration_min ? `${data.duration_min} min` : null;
    const cal = data.calories_burned ? `~${data.calories_burned} kcal` : null;
    const retro = data.date ? ` (${data.date})` : '';
    const sent = await bot.sendMessage(chatId, `✅ ${[data.workout_name + retro, dur, cal].filter(Boolean).join(' — ')}`);
    db.setLogBotMessageId('workout_log', workoutId, sent.message_id);
    // Auto-save exercises to known_exercises (fire-and-forget)
    for (const ex of (data.exercises || [])) {
      if (!ex.name) continue;
      const flatSets = ex.sets_detail?.[0]?.sets ?? ex.sets;
      const flatReps = ex.sets_detail?.[0]?.reps ?? ex.reps;
      const flatWeight = ex.sets_detail ? Math.max(...ex.sets_detail.map(d => d.weight_kg ?? 0)) || null : ex.weight_kg;
      try { db.upsertKnownExercise(chatId, { name: ex.name, sets: flatSets, reps: flatReps, weight_kg: flatWeight }); } catch {}
    }
    // Workout comparison (fire-and-forget)
    checkWorkoutProgression(bot, chatId, data).catch(() => {});
  } catch (err) {
    console.error('Workout log error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to write to Notion. Try again.');
  }
}

async function checkWorkoutProgression(bot, chatId, currentWorkout) {
  const exercises = currentWorkout.exercises ?? [];
  if (exercises.length < 2) return;

  const recent = db.getRecentWorkouts(chatId, 60); // last 60 days
  // Skip the just-logged workout (first entry)
  const previousWorkouts = recent.slice(1);

  const currentNames = new Set(exercises.map(e => e.name?.toLowerCase()));

  // Find the most recent past workout with at least 2 matching exercises
  const prev = previousWorkouts.find(w =>
    (w.exercises ?? []).filter(e => currentNames.has(e.name?.toLowerCase())).length >= 2
  );
  if (!prev) return;

  const state = db.getState(chatId);
  const comparison = await claude.generateWorkoutComparison(currentWorkout, prev, state);
  if (comparison) await bot.sendMessage(chatId, comparison);
}

module.exports = { showWorkoutPreview, logWorkout, formatWorkoutPreview, computeWorkoutCalories, formatExerciseLine };
