const claude = require('../claude');
const db     = require('../db');
const { calculateTDEE } = require('../utils/tdee');
const { WORKOUT_PREVIEW_KB } = require('../utils/keyboards');
const { getOffsetMs, requireTimezone } = require('../utils/time');

// exerciseHistory: Map<normalizedName, {exercise, date, workoutName}>
function buildWorkoutComparisonBlock(current, exerciseHistory) {
  const norm = s => String(s || '').trim().toLowerCase();
  const fmtSet = ex => {
    if (ex.sets_detail?.length) {
      return ex.sets_detail.map(d => {
        const w = d.weight_kg != null ? `${d.weight_kg}kg` : 'bw';
        return `${d.sets}×${d.reps}@${w}`;
      }).join('+');
    }
    const w = ex.weight_kg != null ? `${ex.weight_kg}kg` : 'bw';
    if (ex.sets && ex.reps) return `${ex.sets}×${ex.reps}@${w}`;
    if (ex.distance_m) return `${ex.sets ?? 1}×${ex.distance_m}m`;
    if (ex.duration_sec) return `${ex.sets ?? 1}×${ex.duration_sec}s`;
    return w;
  };
  const topWeight = ex => {
    if (ex.sets_detail?.length) return Math.max(...ex.sets_detail.map(d => d.weight_kg ?? 0));
    return ex.weight_kg ?? 0;
  };
  const totalReps = ex => {
    if (ex.sets_detail?.length) return ex.sets_detail.reduce((s, d) => s + (d.sets ?? 1) * (d.reps ?? 0), 0);
    return (ex.sets ?? 1) * (ex.reps ?? 0);
  };

  // Aggregate current exercises by name (handles same exercise logged multiple times)
  const currByName = new Map();
  for (const ex of current.exercises ?? []) {
    const key = norm(ex.name);
    if (!currByName.has(key)) currByName.set(key, { name: ex.name, allSets: [] });
    currByName.get(key).allSets.push(ex);
  }

  const lines = [];
  let upCount = 0, downCount = 0, flatCount = 0, newCount = 0;

  for (const [key, { name, allSets }] of currByName.entries()) {
    const hist = exerciseHistory.get(key);
    const currFmt = allSets.length === 1 ? fmtSet(allSets[0]) : allSets.map(fmtSet).join(' + ');
    const currTopW = Math.max(...allSets.map(topWeight));
    const currTotalReps = allSets.reduce((s, e) => s + totalReps(e), 0);

    if (!hist) {
      lines.push(`- ${name}: —  →  ${currFmt}  [NEW]`);
      newCount++;
      continue;
    }

    const prevTopW = topWeight(hist.exercise);
    const prevTotalReps = totalReps(hist.exercise);
    const prevFmt = fmtSet(hist.exercise);

    // Volume load: sets × reps × weight (use 1 for bodyweight so reps still count)
    const currVol = allSets.reduce((s, e) => s + totalReps(e) * (topWeight(e) || 1), 0);
    const prevVol = prevTotalReps * (prevTopW || 1);
    const volDelta = prevVol > 0 ? (currVol - prevVol) / prevVol : 0;

    let tag;
    if (currTopW > prevTopW) {
      tag = `[UP +${(currTopW - prevTopW).toFixed(1)}kg top set]`; upCount++;
    } else if (volDelta >= 0.02) {
      // Volume up even if weight same or lower — progress
      tag = currTopW < prevTopW
        ? `[UP +${Math.round(volDelta * 100)}% volume, lighter weight]`
        : `[UP +${currTotalReps - prevTotalReps} reps]`;
      upCount++;
    } else if (currTopW < prevTopW && volDelta < -0.05) {
      tag = `[DOWN -${(prevTopW - currTopW).toFixed(1)}kg, -${Math.round(-volDelta * 100)}% volume]`; downCount++;
    } else if (currTopW === prevTopW && currTotalReps < prevTotalReps) {
      tag = `[DOWN -${prevTotalReps - currTotalReps} reps]`; downCount++;
    } else {
      tag = `[FLAT]`; flatCount++;
    }

    lines.push(`- ${name}: ${prevFmt} (${hist.date}, ${hist.workoutName})  →  ${currFmt}  ${tag}`);
  }

  const verdict = `Verdict: ${upCount} up, ${flatCount} flat, ${downCount} down, ${newCount} new.`;
  return [`Per-exercise comparison (each vs most recent previous occurrence):`, ...lines, '', verdict].join('\n');
}

// thisWeekIds + reviewedWeekStartMs make "this week" identical to the main weekly review
// (same workout set), so the two messages can never disagree on the count. Falls back to a
// rolling window if those aren't provided.
function buildStrengthSummaryBlock(workouts, thisWeekIds = null, reviewedWeekStartMs = null) {
  if (!workouts?.length) return 'No workouts logged in the period.';

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  const aligned = thisWeekIds instanceof Set && reviewedWeekStartMs != null;
  const bucketOf = w => {
    if (aligned) {
      if (thisWeekIds.has(w.id)) return 'thisWeek';
      const ds = w.day_start ?? w.logged_at;
      if (ds >= reviewedWeekStartMs - 7 * DAY)  return 'lastWeek';
      if (ds >= reviewedWeekStartMs - 14 * DAY) return '2weeksAgo';
      return 'older';
    }
    const daysAgo = Math.floor((now - w.logged_at) / DAY);
    if (daysAgo < 7)  return 'thisWeek';
    if (daysAgo < 14) return 'lastWeek';
    if (daysAgo < 21) return '2weeksAgo';
    return 'older';
  };

  const sessions = { thisWeek: 0, lastWeek: 0, '2weeksAgo': 0, older: 0 };
  const durSum   = { thisWeek: 0, lastWeek: 0, '2weeksAgo': 0, older: 0 };
  const exTracker = new Map();

  for (const w of workouts) {
    const b = bucketOf(w);
    sessions[b]++;
    durSum[b] += (w.duration_min ?? 0);

    const exercises = Array.isArray(w.exercises) ? w.exercises
      : (typeof w.exercises === 'string' ? JSON.parse(w.exercises || '[]') : []);
    for (const ex of exercises) {
      const name = String(ex.name || '').trim();
      if (!name) continue;
      const top = ex.sets_detail?.length
        ? Math.max(...ex.sets_detail.map(d => d.weight_kg ?? 0))
        : (ex.weight_kg ?? 0);
      if (!exTracker.has(name)) exTracker.set(name, { thisWeek: 0, lastWeek: 0, '2weeksAgo': 0, older: 0, totalSessions: 0 });
      const rec = exTracker.get(name);
      rec[b] = Math.max(rec[b], top);
      rec.totalSessions++;
    }
  }

  const avgDur = b => sessions[b] ? Math.round(durSum[b] / sessions[b]) : 0;

  const topExercises = [...exTracker.entries()]
    .sort((a, b) => b[1].totalSessions - a[1].totalSessions)
    .slice(0, 5);

  const exLines = topExercises.map(([name, rec]) => {
    const thisMax  = rec.thisWeek || rec.lastWeek;
    const priorMax = rec.lastWeek || rec['2weeksAgo'] || rec.older;
    let trend = '[FLAT]';
    if (thisMax > priorMax && priorMax > 0) trend = `[UP +${(thisMax - priorMax).toFixed(1)}kg vs prior]`;
    else if (thisMax < priorMax)            trend = `[DOWN -${(priorMax - thisMax).toFixed(1)}kg vs prior]`;
    else if (thisMax === 0)                 trend = '[bodyweight only]';
    return `- ${name}: ${rec.totalSessions} sessions, max ${thisMax || priorMax || 0}kg  ${trend}`;
  });

  return [
    'Session counts:',
    `- This week: ${sessions.thisWeek}`,
    `- Last week: ${sessions.lastWeek}`,
    `- 2 weeks ago: ${sessions['2weeksAgo']}`,
    `- Older (in period): ${sessions.older}`,
    '',
    'Avg session duration:',
    `- This week: ${avgDur('thisWeek')}min`,
    `- Last week: ${avgDur('lastWeek')}min`,
    '',
    'Top exercises (by frequency in period):',
    ...exLines,
  ].join('\n');
}

// Server-side calorie calculation — overrides Claude's estimate so LLM math errors can't slip through
function computeWorkoutCalories(chatId, data) {
  const lastBody = db.getLastBodyMeasurement(chatId);
  const targets  = db.getTargetsFromDb(chatId);
  const weight   = lastBody?.weight_kg ?? targets?.weight_kg;
  if (!weight) throw new Error('weight_kg missing — cannot estimate workout calories. Log a body weight or complete onboarding.');
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

  // Catalog MET for cardio/sports (tennis, golf, hiking, yoga, …) — the source of truth. Resolves the
  // workout to its activity and uses the Compendium MET, instead of letting sports fall through to the
  // strength default (which wrongly computed every sport at MET ~3.5).
  try {
    const m = db.catalogWorkoutMet(chatId, data.workout_name, data.activity_type);
    if (m && m.met != null) return Math.round(m.met * weight * (dur / 60));
  } catch {}

  // Cardio: fixed MET per type (fallback if not in catalog)
  if (actType.includes('run') || actType.includes('jog'))    return Math.round(8.5 * weight * (dur / 60));
  if (actType.includes('cycl') || actType.includes('bike'))  return Math.round(6.8 * weight * (dur / 60));
  if (actType.includes('row'))                                return Math.round(7.5 * weight * (dur / 60));
  if (actType.includes('swim'))                               return Math.round(6.0 * weight * (dur / 60));
  if (actType.includes('hiit'))                               return Math.round(10.0 * weight * (dur / 60));
  if (actType.includes('circuit'))                            return Math.round(8.0 * weight * (dur / 60));
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
      s += ' ' + e.sets_detail.map(d => `${d.sets ?? 1}×${d.reps}${d.weight_kg ? '@' + d.weight_kg + 'kg' : ''}`).join(' + ');
    }
  } else if (e.duration_sec) {
    s += ` ${e.sets ?? 1}×${e.duration_sec}s`;
    if (e.weight_kg) s += ` @${e.weight_kg}kg`;
  } else if (e.distance_m) {
    const sets = e.sets ?? 1;
    s += sets > 1 ? ` ${sets}×${e.distance_m}m` : ` ${e.distance_m}m`;
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

  const exercises = data.exercises || [];
  const hasRounds = exercises.some(e => e.round != null);
  let exLines;
  if (hasRounds) {
    const byRound = new Map();
    for (const e of exercises) {
      const r = e.round ?? 1;
      if (!byRound.has(r)) byRound.set(r, []);
      byRound.get(r).push(e);
    }
    exLines = [];
    for (const [round, exs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
      exLines.push(`Round ${round}:`);
      exLines.push(...exs.map(formatExerciseLine));
    }
  } else {
    exLines = exercises.map(formatExerciseLine);
  }

  const lines = [header, ...(exLines.length ? exLines : (data.exercises_summary ? [`  ${data.exercises_summary}`] : []))];
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

// Map each logged exercise to its canonical catalog name (so "jumping squats"/"Jump Squats" → one
// identity), and tag unilateral exercises. Unknown exercises are left as-is.
function canonicalizeWorkoutExercises(chatId, data) {
  if (!Array.isArray(data?.exercises)) return data;
  for (const e of data.exercises) {
    if (!e?.name) continue;
    const c = db.canonicalizeExercise(chatId, e.name);
    e.name = c.name;
    if (c.unilateral) e.unilateral = true;
  }
  return data;
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
    const userWeight = body?.weight_kg ?? tgts?.weight_kg;
    if (!userWeight) throw new Error('weight_kg missing — cannot parse workout. Log a body weight or complete onboarding.');
    const data = await claude.parseWorkout(msg.text || msg.caption || '', knownCtx, userWeight);
    if (msg._retroDate?.dateStr) data.date = msg._retroDate.dateStr;
    canonicalizeWorkoutExercises(chatId, data);
    // Golf goes through the button wizard (gathers type/variant/holes/balls/duration) — flag it and let
    // the router start the wizard instead of showing a preview now. Keep the raw text for parsing.
    if (/golf/i.test((data.workout_name || '') + ' ' + (data.activity_type || ''))) {
      data._golfWizard = true;
      data._rawText = msg.text || msg.caption || '';
      return data;
    }
    data.calories_burned = computeWorkoutCalories(chatId, data);
    await bot.sendMessage(chatId, formatWorkoutPreview(data), WORKOUT_PREVIEW_KB);
    return data;
  } catch (err) {
    console.error('Workout preview error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
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
    console.error('Workout log error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function checkWorkoutProgression(bot, chatId, currentWorkout) {
  const exercises = currentWorkout.exercises ?? [];
  if (exercises.length < 2) return;

  const norm = s => String(s || '').trim().toLowerCase();
  const exerciseNames = [...new Set(exercises.map(e => norm(e.name)).filter(Boolean))];

  const recent = db.getRecentWorkouts(chatId, 90);
  const previousWorkouts = recent.slice(1); // skip just-logged

  const state = db.getState(chatId);
  const tz = requireTimezone(state);

  // For each unique exercise, find most recent previous occurrence across any workout
  const exerciseHistory = new Map();
  for (const name of exerciseNames) {
    for (const w of previousWorkouts) {
      const match = (w.exercises ?? []).find(e => norm(e.name) === name);
      if (match) {
        const date = new Date(w.logged_at + getOffsetMs(tz)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
        exerciseHistory.set(name, { exercise: match, date, workoutName: w.workout_name ?? 'Workout' });
        break;
      }
    }
  }

  if (exerciseNames.filter(n => exerciseHistory.has(n)).length < 2) return;

  const comparisonBlock = buildWorkoutComparisonBlock(currentWorkout, exerciseHistory);
  const comparison = await claude.generateWorkoutComparison(comparisonBlock, state);
  if (comparison) await bot.sendMessage(chatId, comparison);
}

module.exports = { showWorkoutPreview, logWorkout, formatWorkoutPreview, computeWorkoutCalories, formatExerciseLine, buildWorkoutComparisonBlock, buildStrengthSummaryBlock };
