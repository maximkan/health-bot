const claude = require('../claude');
const gcal   = require('../gcal');
const db     = require('../db');
const { nowContextTz, getDateStrTz, getTomorrowStrTz, getHourTz, getOffsetMs, weekdayForDateStr, getWeekStartMs, requireTimezone } = require('../utils/time');
const { getCurrentWeekType } = require('../utils/weekTracker');
const { calculateTDEE, ageFromBirthday } = require('../utils/tdee');

function buildFullAnalysisBlock({ bodyMeasurements = [], historical = {}, targets = {} }) {
  const DAY  = 24 * 3600 * 1000;
  const WEEK = 7 * DAY;
  const lines = [];

  if (bodyMeasurements.length) {
    // getAllBodyMeasurements returns `.date` (YYYY-MM-DD), not `.logged_at` — using the latter
    // gave new Date(undefined) → "Invalid time value" crash on the whole full-analysis path.
    const sorted = [...bodyMeasurements].sort((a, b) => new Date(a.date) - new Date(b.date));
    const first = sorted[0];
    const last  = sorted[sorted.length - 1];
    const weeks = Math.max(1, (new Date(last.date) - new Date(first.date)) / WEEK);
    const periodStart = first.date;
    const periodEnd   = last.date;

    lines.push(`Period: ${periodStart} to ${periodEnd} (${weeks.toFixed(1)} weeks)`);
    lines.push('');
    lines.push('Body composition:');
    if (first.weight_kg != null && last.weight_kg != null) {
      const delta = last.weight_kg - first.weight_kg;
      const rate  = delta / weeks;
      const dir   = delta < 0 ? 'DOWN' : delta > 0 ? 'UP' : 'FLAT';
      lines.push(`- Weight: ${first.weight_kg}kg → ${last.weight_kg}kg  [${dir} ${Math.abs(delta).toFixed(1)}kg, ${rate >= 0 ? '+' : ''}${rate.toFixed(2)}kg/week]`);
    }
    if (first.body_fat_pct != null && last.body_fat_pct != null) {
      const delta = last.body_fat_pct - first.body_fat_pct;
      const dir   = delta < 0 ? 'DOWN' : delta > 0 ? 'UP' : 'FLAT';
      lines.push(`- Body fat: ${first.body_fat_pct}% → ${last.body_fat_pct}%  [${dir} ${Math.abs(delta).toFixed(1)}pp]`);
    }
    if (first.bmi != null && last.bmi != null) {
      const delta = last.bmi - first.bmi;
      const dir   = delta < 0 ? 'DOWN' : delta > 0 ? 'UP' : 'FLAT';
      lines.push(`- BMI: ${first.bmi} → ${last.bmi}  [${dir} ${Math.abs(delta).toFixed(1)}]`);
    }
    lines.push('');

    if (targets.goal_weight && last.weight_kg != null && first.weight_kg != null) {
      const remaining = last.weight_kg - targets.goal_weight;
      const rate = (last.weight_kg - first.weight_kg) / weeks;
      lines.push('Goal projection:');
      lines.push(`- Goal weight: ${targets.goal_weight}kg`);
      lines.push(`- Remaining: ${remaining > 0 ? `${remaining.toFixed(1)}kg to lose` : `${(-remaining).toFixed(1)}kg to gain`}`);
      if (Math.abs(rate) > 0.05 && Math.sign(rate) === -Math.sign(remaining)) {
        const weeksToGoal = Math.abs(remaining / rate);
        const projectedDate = new Date(Date.now() + weeksToGoal * WEEK).toISOString().split('T')[0];
        lines.push(`- Weekly rate: ${rate >= 0 ? '+' : ''}${rate.toFixed(2)}kg/week`);
        lines.push(`- Projected goal date: ${projectedDate} (${weeksToGoal.toFixed(0)} weeks from now)`);
      } else {
        lines.push(`- Current rate (${rate >= 0 ? '+' : ''}${rate.toFixed(2)}kg/week) is not progressing toward goal`);
      }
      lines.push('');
    }
  }

  const dailyTotals = historical.dailyTotals ?? [];
  if (dailyTotals.length && targets.calories && targets.protein) {
    const calHit  = dailyTotals.filter(d => d.calories != null && Math.abs(d.calories - targets.calories) <= targets.calories * 0.1).length;
    const protHit = dailyTotals.filter(d => d.protein  != null && d.protein >= targets.protein * 0.9).length;
    const total = dailyTotals.length;
    lines.push('Nutrition adherence:');
    lines.push(`- Calorie target hit (±10%): ${calHit} / ${total} days (${Math.round(calHit * 100 / total)}%)`);
    lines.push(`- Protein target hit (≥90%): ${protHit} / ${total} days (${Math.round(protHit * 100 / total)}%)`);
    lines.push('');
  }

  const workouts = historical.workouts ?? [];
  if (workouts.length) {
    const firstW = Math.min(...workouts.map(w => new Date(w.logged_at).getTime()));
    const lastW  = Math.max(...workouts.map(w => new Date(w.logged_at).getTime()));
    const weeks  = Math.max(1, (lastW - firstW) / WEEK);
    const typeCounts = {};
    for (const w of workouts) {
      const t = (w.activity_type || 'other').toLowerCase();
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const topTypes = Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).slice(0, 3);
    lines.push('Training:');
    lines.push(`- Total sessions: ${workouts.length} (${(workouts.length / weeks).toFixed(1)} sessions/week avg)`);
    lines.push(`- Most common: ${topTypes.map(([t, n]) => `${t} (${n})`).join(', ')}`);
    lines.push('');
  }

  const sleep = historical.sleep ?? [];
  if (sleep.length) {
    const validH = sleep.filter(s => s.hours_slept != null).map(s => s.hours_slept);
    const validQ = sleep.filter(s => s.quality     != null).map(s => s.quality);
    if (validH.length) {
      const avgH = (validH.reduce((s, h) => s + h, 0) / validH.length).toFixed(1);
      lines.push('Sleep:');
      lines.push(`- Avg hours: ${avgH}`);
      if (validQ.length) {
        const avgQ = (validQ.reduce((s, q) => s + q, 0) / validQ.length).toFixed(1);
        lines.push(`- Avg quality: ${avgQ}/5`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}


// Extract how many days back the question needs — data extraction only, not intent detection
function parseDaysFromQuery(text) {
  const lc = text.toLowerCase();
  const m = lc.match(/(?:last|past)\s+(\d+)\s+(day|week|month)s?/);
  if (m) {
    const n = parseInt(m[1]);
    if (m[2].startsWith('week'))  return n * 7;
    if (m[2].startsWith('month')) return n * 30;
    return n;
  }
  if (/last\s+month|this\s+month/.test(lc)) return 30;
  if (/last\s+week/.test(lc))  return 14;
  return 30; // default window — always include recent history
}

function fmtSleep(h) {
  const totalMin = Math.round((h || 0) * 60);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

function formatRecoveryRows(rows) {
  const contrastGroups = {};
  const singles = [];
  for (const r of rows) {
    if (r.protocol === 'contrast' && r.protocol_id) {
      if (!contrastGroups[r.protocol_id]) contrastGroups[r.protocol_id] = [];
      contrastGroups[r.protocol_id].push(r);
    } else {
      singles.push(r);
    }
  }
  const parts = [];
  for (const group of Object.values(contrastGroups)) {
    const isPerRound = group.some(r => r.round_number != null);
    if (isPerRound) {
      const roundMap = {};
      for (const r of group) {
        if (!roundMap[r.round_number]) roundMap[r.round_number] = [];
        roundMap[r.round_number].push(r);
      }
      const totalRounds = Object.keys(roundMap).length;
      const roundStrs = Object.entries(roundMap)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([rn, steps]) => {
          const sorted = steps.sort((a, b) => a.sequence_order - b.sequence_order);
          return `R${rn}: ${sorted.map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_per_round_min}min`).join('→')}`;
        });
      parts.push(`Contrast therapy ${totalRounds} rounds (variable): ${roundStrs.join(', ')}`);
    } else {
      const sorted = group.sort((a, b) => a.sequence_order - b.sequence_order);
      const totalRounds = sorted[0].rounds;
      const steps = sorted.map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_per_round_min}min`).join('→');
      parts.push(`Contrast therapy ${totalRounds} rounds (${steps})`);
    }
  }
  for (const r of singles) {
    parts.push(`${r.type}${r.rounds > 1 ? ` ${r.rounds}×${r.duration_per_round_min}min` : ` ${r.total_duration_min}min`}${r.temperature_c ? ` @${r.temperature_c}°C` : ''}`);
  }
  return parts;
}

function buildWorkoutContext(workouts) {
  if (!workouts.length) return '';
  const now = Date.now();

  // Session log (newest first, cap at 10)
  const sessionLines = workouts.slice(0, 10).map(w => {
    const date = w.retro_date || new Date(w.logged_at).toISOString().slice(0, 10);
    const exs = (w.exercises || []).map(e => {
      if (e.sets_detail?.length) return `${e.name} ${e.sets_detail.map(d => `${d.sets ?? 1}×${d.reps}${d.weight_kg ? '@' + d.weight_kg + 'kg' : ''}`).join('+')}`;
      return `${e.name}${e.sets ? ` ${e.sets}×${e.reps}` : ''}${e.weight_kg ? '@' + e.weight_kg + 'kg' : ''}`;
    }).join(', ');
    const meta = [w.duration_min ? `${w.duration_min}min` : null, w.calories_burned ? `${w.calories_burned}kcal` : null].filter(Boolean).join(', ');
    return `  ${date}: ${w.workout_name}${meta ? ` (${meta})` : ''}${exs ? ' — ' + exs : ''}`;
  });

  // Per-exercise timelines grouped by name
  const byExercise = {};
  for (const w of workouts) {
    const date = w.retro_date || new Date(w.logged_at).toISOString().slice(0, 10);
    for (const e of (w.exercises || [])) {
      if (!e.name) continue;
      const key = e.name.trim();
      const topWeight = e.sets_detail?.length
        ? Math.max(...e.sets_detail.map(d => d.weight_kg || 0))
        : (e.weight_kg || 0);
      const sets = e.sets || e.sets_detail?.length || 1;
      const reps = e.reps || e.sets_detail?.[0]?.reps || 0;
      if (!byExercise[key]) byExercise[key] = [];
      byExercise[key].push({ date, ts: w.logged_at, label: `${sets}×${reps}${topWeight ? '@' + topWeight + 'kg' : ''}`, weight: topWeight });
    }
  }

  const exerciseLines = Object.entries(byExercise).map(([name, entries]) => {
    entries.sort((a, b) => a.ts - b.ts);
    const recent = entries.slice(-5);
    const timeline = recent.map(e => `${e.date} ${e.label}`).join(' | ');
    const last = entries[entries.length - 1];
    const daysSince = Math.floor((now - last.ts) / 86400000);
    let tag = '';
    if (recent.length >= 2 && last.weight > 0) {
      const weights = recent.map(e => e.weight);
      const flatCount = entries.filter(e => e.weight === last.weight).length;
      const isFlat = weights.slice(-2).every(w => w === last.weight);
      const isUp   = last.weight > weights[0];
      const isDown = last.weight < weights[0];
      if (isFlat && flatCount >= 2) tag = ` → FLAT ${flatCount} sessions`;
      else if (isUp)   tag = ` → PROGRESSING`;
      else if (isDown) tag = ` → REGRESSED`;
    }
    if (daysSince > 10) tag += ` (last: ${daysSince}d ago)`;
    return `  ${name}: ${timeline}${tag}`;
  }).sort().join('\n');

  const parts = [`Workout sessions (newest first):\n${sessionLines.join('\n')}`];
  if (exerciseLines) parts.push(`Exercise timelines (oldest→newest):\n${exerciseLines}`);
  return parts.join('\n\n');
}

async function buildDayContext(chatId) {
  const state    = db.getState(chatId);
  const tz = requireTimezone(state);
  const todayStr = getDateStrTz(tz);
  const lines    = [nowContextTz(tz)];

  // Sleep data from sleep_log
  const offsetMs = getOffsetMs(tz);
  if (state.current_day_start) {
    const wakeLocal = new Date(state.current_day_start + offsetMs).toISOString().slice(11, 16);
    lines.push(`Woke up at: ${wakeLocal} (${tz})`);
  }
  const lastSleep = db.getLastSleepLog(chatId);
  if (lastSleep) {
    const bedLocal  = new Date(lastSleep.bed_time  + offsetMs).toISOString().slice(11, 16);
    const wakeLocal = new Date(lastSleep.wake_time + offsetMs).toISOString().slice(11, 16);
    const totalMin  = Math.round((lastSleep.hours_slept || 0) * 60);
    const sleepFmt  = `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
    lines.push(`Last sleep: bed ${bedLocal}, wake ${wakeLocal}, ${sleepFmt}, quality ${lastSleep.quality}/5`);
  }

  // Latest body measurements
  const latestBody = db.getLastBodyMeasurement(chatId);
  if (latestBody) {
    const bodyParts = [`Current weight: ${latestBody.weight_kg}kg`];
    if (latestBody.body_fat_pct != null) bodyParts.push(`body fat ${latestBody.body_fat_pct}%`);
    if (latestBody.muscle_mass_kg != null) bodyParts.push(`muscle mass ${latestBody.muscle_mass_kg}kg`);
    if (latestBody.bmi != null) bodyParts.push(`BMI ${latestBody.bmi}`);
    lines.push(bodyParts.join(', '));
  }

  // Today's totals — always from SQLite (source of truth)
  const dayData = db.getDayDataFromSQLite(chatId, state.current_day_start);
  const t = dayData.totals;
  lines.push(`Today so far (from database): ${Math.round(t.calories)} kcal, ${Math.round(t.protein)}g protein, ${Math.round(t.carbs)}g carbs, ${Math.round(t.fat)}g fat`);
  if (dayData.workouts.length) lines.push(`Workouts today: ${dayData.workouts.map(w => w.name).join(', ')}`);
  if (dayData.meals.length)    lines.push(`Meals logged: ${dayData.meals.map(m => m.name).join(', ')}`);
  if (dayData.recovery?.length) {
    lines.push(`Recovery today: ${formatRecoveryRows(dayData.recovery).join(', ')}`);
  }

  // Plans
  const timedToday    = db.getPendingTimed(chatId, todayStr);
  const timedTomorrow = db.getPendingTimed(chatId, getTomorrowStrTz(tz));
  const tasks         = db.getPendingUntimed(chatId);
  const gcalToday     = await gcal.getEventsForDate(chatId, todayStr).catch(() => []);
  const dbTodayTitles = new Set(timedToday.map(p => p.plan_text.toLowerCase()));
  const gcalTodayExtra = gcalToday.filter(e => !e.allDay && e.time && !dbTodayTitles.has(e.title.toLowerCase()));

  const allToday = [
    ...timedToday.map(p => `${p.plan_text} at ${p.plan_time}`),
    ...gcalTodayExtra.map(e => `${e.title} at ${e.time}`),
  ];
  if (allToday.length)      lines.push(`Today's plans: ${allToday.join(', ')}`);
  if (timedTomorrow.length && getHourTz(tz) >= 19) lines.push(`Tomorrow's plans: ${timedTomorrow.map(p => `${p.plan_text} at ${p.plan_time}`).join(', ')}`);
  if (tasks.length)         lines.push(`Pending tasks: ${tasks.map(p => p.plan_text).join(', ')}`);

  // TDEE / maintenance — computed in code, injected as fact for the model to use as-is
  try {
    const targets = db.getTargets(chatId);
    const weight = latestBody?.weight_kg ?? targets?.weight_kg;
    const height = targets?.height_cm;
    const age = ageFromBirthday(targets?.birthday) ?? targets?.age;
    if (weight && height && age && state.activity_level && state.gender) {
      const tdee = calculateTDEE(weight, height, age, state.gym_days ?? 0, state.activity_level, state.gender);
      const deficit = targets?.calories ? tdee - targets.calories : null;
      const paceKg = deficit ? +(deficit / 1100).toFixed(2) : null;
      lines.push(`Maintenance (TDEE): ${tdee} kcal/day [DO NOT RECALCULATE — use this number]`);
      if (deficit != null) lines.push(`Daily deficit: ${deficit} kcal (target ${targets.calories} kcal vs maintenance ${tdee} kcal) → ~${paceKg} kg/week loss at full adherence`);
    }
  } catch {}

  return lines.join('\n');
}

// Strip markdown that Claude still generates despite instructions
function stripMarkdown(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → plain
    .replace(/\*(.+?)\*/g, '$1')        // *italic* → plain
    .replace(/^#{1,3}\s+/gm, '')        // ## headers → plain
    .replace(/^[-•]\s+/gm, '  ')        // - bullets → indented
    .trim();
}

async function handleAsk(bot, msg, context = '', intents = []) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  const text = msg.text || msg.caption || '';

  const isFullAnalysis = intents.includes('FULL_ANALYSIS');

  try {
    const tz = requireTimezone(db.getState(chatId));

    let targetsCtx = '';
    try { targetsCtx = db.getTargetsText(chatId); } catch {}

    let knownFoodsCtx = '';
    const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.now() + getOffsetMs(tz)).getUTCDay()];
    try { knownFoodsCtx = db.getKnownFoodsContext(chatId, dayOfWeek, getCurrentWeekType(tz)); } catch {}

    const dayCtx = await buildDayContext(chatId);

    // Always include historical data — window based on what the question implies
    let histCtx = '';
    try {
      // "this week" = real calendar week starting Monday-wake (user's tz); otherwise a rolling N-day window
      const isThisWeek = /\bthis\s+week\b/i.test(text);
      const daysBack = parseDaysFromQuery(text);
      const sinceMs = isThisWeek ? getWeekStartMs(tz) : (Date.now() - daysBack * 24 * 3600 * 1000);
      const histData = db.getWeekDataFromSQLite(chatId, sinceMs);
      if (histData && Object.keys(histData.dailyTotals || {}).length > 0) {
        const days = Object.entries(histData.dailyTotals).sort(([a],[b]) => a.localeCompare(b));
        // Weekday is computed here (never left for the model to infer) so dates are always labeled correctly
        const lines = days.map(([date, d]) => `  ${weekdayForDateStr(date)} ${date}: ${d.calories} kcal / ${Math.round(d.protein)}g P / ${Math.round(d.carbs)}g C / ${Math.round(d.fat)}g F`);
        const histLabel = isThisWeek ? 'Nutrition this week (week starts Monday)' : `Nutrition history (last ${daysBack} days)`;
        histCtx = `\n${histLabel}:\n${lines.join('\n')}`;

        // Precompute aggregates in code so the coach never does (and botches) the arithmetic.
        // Average over days with food logged only — empty days shouldn't drag the mean down.
        const logged = days.filter(([, d]) => (d.calories || 0) > 0);
        const nd = logged.length;
        if (nd > 0) {
          let tgt = null; try { tgt = db.getTargets(chatId); } catch {}
          const sum = k => logged.reduce((s, [, d]) => s + (d[k] || 0), 0);
          const avgCal = Math.round(sum('calories') / nd);
          const totalCal = Math.round(sum('calories'));
          const agg = [
            `\nPeriod aggregates (PRECOMPUTED — use these EXACT numbers, never recalculate or re-sum):`,
            `- Days with food logged: ${nd}`,
            `- Average/day: ${avgCal} kcal, ${Math.round(sum('protein') / nd)}g protein, ${Math.round(sum('carbs') / nd)}g carbs, ${Math.round(sum('fat') / nd)}g fat`,
            `- Total logged: ${totalCal} kcal`,
          ];
          if (tgt?.calories) {
            const budget = tgt.calories * nd;
            const diff = budget - totalCal;
            const overDays = logged.filter(([, d]) => d.calories > tgt.calories).length;
            agg.push(`- Avg vs target: ${avgCal} vs ${tgt.calories}/day → ${avgCal <= tgt.calories ? (tgt.calories - avgCal) + ' kcal UNDER target' : (avgCal - tgt.calories) + ' kcal OVER target'}`);
            agg.push(`- Running total vs ${nd}-day budget (${budget} kcal): ${diff >= 0 ? diff + ' kcal UNDER budget — room to spare' : (-diff) + ' kcal OVER budget'}`);
            agg.push(`- Days over calorie target: ${overDays} of ${nd}`);
          }
          if (tgt?.protein) {
            agg.push(`- Days protein target hit (>=${tgt.protein}g): ${logged.filter(([, d]) => d.protein >= tgt.protein).length} of ${nd}`);
          }
          const bl = histData.bodyLogs || [];
          if (bl.length >= 2 && bl[0].weight_kg != null && bl[bl.length - 1].weight_kg != null) {
            const dw = +(bl[bl.length - 1].weight_kg - bl[0].weight_kg).toFixed(1);
            agg.push(`- Weight trend in period: ${bl[0].weight_kg}kg → ${bl[bl.length - 1].weight_kg}kg (${dw > 0 ? '+' : ''}${dw}kg)`);
          }
          histCtx += '\n' + agg.join('\n');
        }
        if (histData.trainDays) histCtx += `\nWorkout days in period: ${histData.trainDays}`;
        // Workout history with per-exercise timelines and progression tags
        const recentWorkouts = db.getRecentWorkouts(chatId, daysBack);
        if (recentWorkouts.length) {
          histCtx += '\n' + buildWorkoutContext(recentWorkouts);
        }
        if (histData.avgSleep)  histCtx += `\nAvg sleep in period: ${fmtSleep(histData.avgSleep)}${histData.avgSleepQuality ? ` (avg quality ${histData.avgSleepQuality}/5)` : ''}`;
        if (histData.recoverySessions?.length) {
          // Group by date, then format contrast groups properly
          const byDate = {};
          for (const r of histData.recoverySessions) {
            if (!byDate[r.date]) byDate[r.date] = [];
            byDate[r.date].push(r);
          }
          const recLines = Object.entries(byDate).sort(([a],[b]) => a.localeCompare(b)).map(([date, rows]) => {
            return `  ${date}: ${formatRecoveryRows(rows).join(', ')}`;
          });
          histCtx += `\nRecovery sessions:\n${recLines.join('\n')}`;
        }
        if (histData.latestBody) {
          const b = histData.latestBody;
          histCtx += `\nLatest body: ${b.weight_kg}kg${b.body_fat_pct != null ? `, ${b.body_fat_pct}% BF` : ''}${b.muscle_mass_kg != null ? `, ${b.muscle_mass_kg}kg muscle` : ''}`;
        }
      }
    } catch {}

    // Live chain context: inject recent exchanges from the current open chain
    // Falls back to closed chain summary if no active chain
    let recentChainCtx = '';
    try {
      const freshState = db.getState(chatId);
      const chainId = freshState.current_chain_id;
      if (chainId) {
        const chain = db.getReplyChain(chatId, chainId);
        if (chain.length >= 2) {
          const lines = chain.slice(-6).map(m => `${m.role === 'user' ? 'User' : 'Coach'}: ${m.content}`);
          recentChainCtx = `\nRecent conversation:\n${lines.join('\n')}`;
        }
      } else {
        const summaries = db.getRecentConversationSummaries(chatId, 1);
        if (summaries.length) {
          const isContinuation = await claude.isConversationContinuation(text, summaries[0].summary);
          if (isContinuation) recentChainCtx = `\nPrevious conversation context:\n${summaries[0].summary}`;
        }
      }
    } catch {}

    const coachCtx = [dayCtx, context, histCtx, recentChainCtx].filter(Boolean).join('\n');

    if (isFullAnalysis) {
      await bot.sendMessage(chatId, 'pulling all your data...');
      try {
        const bodyMeasurements = db.getAllBodyMeasurements(chatId);
        const historical = db.getHistoricalDataFromSQLite(chatId);
        const targets = db.getTargets(chatId);
        const analysisBlock = buildFullAnalysisBlock({ bodyMeasurements, historical, targets });
        const answer = stripMarkdown(await claude.generateFullAnalysis(analysisBlock, targetsCtx, db.getState(chatId)));
        await bot.sendMessage(chatId, answer);
      } catch (err) {
        console.error('Full analysis error:', err.message, err.stack);
        await bot.sendMessage(chatId, `❌ ${err.message}`);
      }
      return;
    }

    // Determine stable chain ID for this conversation thread
    const freshState = db.getState(chatId);
    const chainId = freshState.current_chain_id || msg.message_id;

    // Save user message to chain before generating answer
    db.saveCoachMessage(chatId, 'user', text, chainId);

    const userProfile = freshState;
    const answer = stripMarkdown(await claude.askCoach(text, coachCtx, targetsCtx, knownFoodsCtx, userProfile));
    const sent = await bot.sendMessage(chatId, answer);

    // Save assistant message and update chain state
    db.saveCoachMessage(chatId, 'assistant', answer, chainId);
    const exchanges = db.countExchanges(chatId, chainId);
    if (exchanges >= 8) {
      await closeChain(chatId, chainId);
      db.setState(chatId, { last_coach_message_id: sent.message_id, current_chain_id: null });
    } else {
      db.setState(chatId, {
        last_coach_message_id: sent.message_id,
        current_chain_id: chainId,
        last_coach_context: JSON.stringify({ message: answer, context: coachCtx, timestamp: Date.now() }),
      });
    }
  } catch (err) {
    console.error('Ask handler error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function closeChain(chatId, coachMessageId) {
  try {
    const chain = db.getReplyChain(chatId, coachMessageId);
    if (chain.length >= 2) {
      const messages = chain.map(m => ({ role: m.role, content: m.content }));
      const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
      const [summary, updatedProfile] = await Promise.all([
        claude.summarizeConversation(messages),
        claude.updateUserProfile(convText, db.getUserProfile(chatId)),
      ]);
      db.saveCoachConversation(chatId, messages, summary);
      db.setUserProfile(chatId, updatedProfile);
    }
  } catch (err) {
    console.error('closeChain error:', err.message);
  } finally {
    db.clearReplyChain(chatId, coachMessageId);
    db.setState(chatId, { current_chain_id: null });
  }
}

async function handleCoachReply(bot, msg, coachMessageId) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const state = db.getState(chatId);
    // Use stable current_chain_id so the chain accumulates correctly regardless of which message user replies to
    const chainId = state.current_chain_id || coachMessageId;
    const exchanges = db.countExchanges(chatId, chainId);

    if (exchanges >= 8) {
      await closeChain(chatId, chainId);
      await handleAsk(bot, msg);
      return;
    }

    const dayCtx = await buildDayContext(chatId);

    const chain = db.getReplyChain(chatId, chainId);
    const messages = chain.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: `${dayCtx}\n\n${msg.text || ''}` });
    db.saveCoachMessage(chatId, 'user', msg.text || '', chainId);

    let targetsCtx = '';
    try { targetsCtx = db.getTargetsText(chatId); } catch {}

    const answer = stripMarkdown(await claude.continueCoachReply(messages, targetsCtx, state));
    const sent = await bot.sendMessage(chatId, answer);
    db.saveCoachMessage(chatId, 'assistant', answer, chainId);
    db.setState(chatId, { last_coach_message_id: sent.message_id, current_chain_id: chainId });
  } catch (err) {
    console.error('Coach reply error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function handlePhotoQuestion(bot, msg, photoBase64) {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  try {
    let targetsCtx = '';
    try { targetsCtx = db.getTargetsText(chatId); } catch {}
    const caption = msg.caption || 'What can you tell me about this?';
    const answer = stripMarkdown(await claude.askWithPhoto(photoBase64, caption, targetsCtx));
    const sent = await bot.sendMessage(chatId, answer);
    const freshState = db.getState(chatId);
    const chainId = freshState.current_chain_id || msg.message_id;
    db.saveCoachMessage(chatId, 'user', `[Photo] ${caption}`, chainId);
    db.saveCoachMessage(chatId, 'assistant', answer, chainId);
    db.setState(chatId, { last_coach_message_id: sent.message_id, current_chain_id: chainId });
  } catch (err) {
    console.error('Photo question error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

module.exports = { handleAsk, handleCoachReply, handlePhotoQuestion, stripMarkdown, closeChain, buildFullAnalysisBlock };
