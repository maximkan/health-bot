const claude = require('../claude');
const gcal   = require('../gcal');
const db     = require('../db');
const { nowContextTz, getDateStrTz, getTomorrowStrTz, getHourTz, getOffsetMs } = require('../utils/time');
const { getCurrentWeekType } = require('../utils/weekTracker');

const FULL_ANALYSIS_TRIGGERS = [
  'full analysis','progress report','how am i doing overall','summary since beginning',
  'how\'s my progress','how is my progress','overall progress','how am i doing since',
  'since the start','since i started','progress so far','how have i been doing',
  'trend analysis','show me my progress','give me a full breakdown',
];

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

async function buildDayContext(chatId) {
  const state    = db.getState(chatId);
  const tz       = state.timezone || 'Asia/Kuala_Lumpur';
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

async function handleAsk(bot, msg, context = '') {
  const chatId = msg.chat.id;
  await bot.sendChatAction(chatId, 'typing');
  const text = msg.text || msg.caption || '';

  const lc = text.toLowerCase();
  const isFullAnalysis = FULL_ANALYSIS_TRIGGERS.some(t => lc.includes(t));

  try {
    const tz = db.getState(chatId).timezone || 'Asia/Kuala_Lumpur';

    let targetsCtx = '';
    try { targetsCtx = db.getTargetsText(chatId); } catch {}

    let knownFoodsCtx = '';
    const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(Date.now() + getOffsetMs(tz)).getUTCDay()];
    try { knownFoodsCtx = db.getKnownFoodsContext(chatId, dayOfWeek, getCurrentWeekType(tz)); } catch {}

    const dayCtx = await buildDayContext(chatId);

    // Always include historical data — window based on what the question implies
    let histCtx = '';
    try {
      const daysBack = parseDaysFromQuery(text);
      const sinceMs = Date.now() - daysBack * 24 * 3600 * 1000;
      const histData = db.getWeekDataFromSQLite(chatId, sinceMs);
      if (histData && Object.keys(histData.dailyTotals || {}).length > 0) {
        const days = Object.entries(histData.dailyTotals).sort(([a],[b]) => a.localeCompare(b));
        const lines = days.map(([date, d]) => `  ${date}: ${d.calories} kcal / ${Math.round(d.protein)}g P / ${Math.round(d.carbs)}g C / ${Math.round(d.fat)}g F`);
        histCtx = `\nNutrition history (last ${daysBack} days):\n${lines.join('\n')}`;
        if (histData.trainDays) histCtx += `\nWorkout days in period: ${histData.trainDays}`;
        // Full workout log for the period (no artificial limit — user can ask about any workout)
        const recentWorkouts = db.getRecentWorkouts(chatId, daysBack);
        if (recentWorkouts.length) {
          const wLines = recentWorkouts.map(w => {
            const exs = (w.exercises || []).map(e => {
              if (e.sets_detail?.length) return `${e.name} ${e.sets_detail.map(d => `${d.sets}×${d.reps}${d.weight_kg ? '@' + d.weight_kg + 'kg' : ''}`).join('+')}`;
              return `${e.name}${e.sets ? ` ${e.sets}×${e.reps}` : ''}${e.weight_kg ? '@' + e.weight_kg + 'kg' : ''}`;
            }).join(', ');
            const meta = [w.duration_min ? `${w.duration_min}min` : null, w.calories_burned ? `${w.calories_burned}kcal` : null].filter(Boolean).join(', ');
            const dateStr = w.retro_date || new Date(w.logged_at).toISOString().split('T')[0];
            return `  ${dateStr}: ${w.workout_name}${meta ? ` (${meta})` : ''}${exs ? ' — ' + exs : ''}`;
          });
          histCtx += `\nWorkout history (last ${daysBack} days):\n${wLines.join('\n')}`;
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

    const notionCtx = [dayCtx, context, histCtx, recentChainCtx].filter(Boolean).join('\n');

    if (isFullAnalysis) {
      await bot.sendMessage(chatId, 'pulling all your data...');
      try {
        const bodyMeasurements = db.getAllBodyMeasurements(chatId);
        const historical = db.getHistoricalDataFromSQLite(chatId);
        const fullCtx = [
          dayCtx,
          `\nBody measurements:\n${JSON.stringify(bodyMeasurements, null, 2)}`,
          historical ? `\nAll-time daily nutrition:\n${JSON.stringify(historical.dailyTotals, null, 2)}` : '',
          historical?.workouts?.length ? `\nWorkout history:\n${JSON.stringify(historical.workouts, null, 2)}` : '',
          historical?.sleep?.length    ? `\nSleep history:\n${JSON.stringify(historical.sleep, null, 2)}`    : '',
        ].join('');
        const answer = stripMarkdown(await claude.generateFullAnalysis({ context: fullCtx }, targetsCtx, db.getState(chatId)));
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
    const answer = stripMarkdown(await claude.askCoach(text, notionCtx, targetsCtx, knownFoodsCtx, userProfile));
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
        last_coach_context: JSON.stringify({ message: answer, context: notionCtx, timestamp: Date.now() }),
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

module.exports = { handleAsk, handleCoachReply, handlePhotoQuestion, stripMarkdown, closeChain };
