const TelegramBot = require('node-telegram-bot-api');
const config  = require('./config');
const db      = require('./db');
const cronSvc = require('./cron');
const claude  = require('./claude');
const notion  = require('./notion');
const day     = require('./handlers/day');
const { showMealPreview, logMeal, applyCorrection, formatPreview } = require('./handlers/meal');
const { handleWorkout }     = require('./handlers/workout');
const { handleRecovery }    = require('./handlers/recovery');
const { handleSleep }       = require('./handlers/sleep');
const { handleBody }        = require('./handlers/body');
const { handleAsk, handleCoachReply, handlePhotoQuestion } = require('./handlers/ask');
const { handlePlan, handlePlanDone, handlePlanSkip, processBedPlans } = require('./handlers/plans');
const { handleWorkoutDetails, hasPendingWorkout } = require('./handlers/workout');
const { handleCorrection }  = require('./handlers/correction');
const { getCurrentWeekType, setWeekType } = require('./utils/weekTracker');
const { buildTimeISO, nowContext, getMalaysiaDateStr, extractTimeMs } = require('./utils/time');

const CONFIRM_WORDS = ['ok','okay','yes','log','log it','✅','yep','yup','looks good','good','sure','go'];
const CANCEL_WORDS  = ['cancel','no','nope','skip','stop','abort'];

const pendingStates = new Map();
const mediaGroups   = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

const isConfirmation = (t) => { const lc = (t||'').toLowerCase().trim(); return CONFIRM_WORDS.some(w => lc === w || lc.startsWith(w + ' ')); };
const isCancellation = (t) => { const lc = (t||'').toLowerCase().trim(); return CANCEL_WORDS.some(w => lc === w || lc.startsWith(w + ' ')); };
const parseQuality   = (t) => { const m = (t||'').match(/\b([1-5])\b/); return m ? parseInt(m[1]) : null; };

function isWakeTrigger(msg) {
  if (!msg?.text) return false;
  const lc = msg.text.toLowerCase().trim();
  return lc.split(/\s+/).length <= 3 && ['gm','morning','good morning','up','woke','hey','hi','awake','rise','wakey'].some(w => lc === w || lc.startsWith(w));
}

function isPhotoQuestion(caption) {
  if (!caption) return false;
  const lc = caption.toLowerCase().trim();
  if (lc.includes('?')) return true;
  return ['what ','is this','how many','how much','are these','can i','should i','good for','bad for','is it'].some(s => lc.startsWith(s));
}

async function downloadPhoto(bot, msg) {
  const largest = msg.photo[msg.photo.length - 1];
  const link = await bot.getFileLink(largest.file_id);
  const res = await fetch(link);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

// ── Intent dispatcher ─────────────────────────────────────────────────────────

async function dispatchIntents(bot, msg, chatId, userState, intents) {
  // BED: highest priority
  if (intents.includes('BED')) {
    pendingStates.delete(chatId);
    await day.handleBedTime(bot, chatId, userState);
    pendingStates.set(chatId, { type: 'bed_plans', pushback_sent: false });
    return;
  }

  if (intents.includes('CORRECTION')) {
    const result = await handleCorrection(bot, msg, chatId, userState);
    if (result?.lines) {
      pendingStates.set(chatId, { type: 'time_correction_select', entries: result.entries, newISO: result.newISO });
      await bot.sendMessage(chatId, result.lines);
    }
    return;
  }

  const MEAL_SET = new Set(['MEAL_LOG','DRINK_LOG']);
  const nonMeal  = intents.filter(i => !MEAL_SET.has(i));
  const hasMeal  = intents.some(i => MEAL_SET.has(i));

  for (const intent of nonMeal) {
    switch (intent) {
      case 'WORKOUT_LOG':   await handleWorkout(bot, msg);    break;
      case 'RECOVERY_LOG':  await handleRecovery(bot, msg);   break;
      case 'SLEEP_LOG':     await handleSleep(bot, msg);      break;
      case 'WEIGHT_LOG':    await handleBody(bot, msg);        break;
      case 'PLAN':          await handlePlan(bot, msg);        break;
      case 'PLAN_DONE':     await handlePlanDone(bot, msg);    break;
      case 'PLAN_SKIP':     await handlePlanSkip(bot, msg);    break;
      case 'WAKE':
        if (userState.status === 'sleeping') break; // handled by wake flow
        // deliberate fall-through
      case 'COACH_QUESTION':
      case 'GENERAL':       await handleAsk(bot, msg);         break;
    }
  }

  if (hasMeal) {
    const data = await showMealPreview(bot, msg, null);
    if (!data) {
      pendingStates.set(chatId, { type: 'meal_text_clarification', originalText: msg.text, dayStart: userState?.current_day_start });
    } else {
      pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: userState?.current_day_start });
    }
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

async function routeMessage(bot, msg, chatId, userState, preIntents = null) {
  const dayStart = userState?.current_day_start;

  // ── Photos ────────────────────────────────────────────────────────────────
  if (msg.photo) {
    if (msg.media_group_id) {
      const gid = msg.media_group_id;
      if (!mediaGroups.has(gid)) mediaGroups.set(gid, { photos: [], firstMsg: msg, chatId, dayStart });
      const group = mediaGroups.get(gid);
      try { group.photos.push(await downloadPhoto(bot, msg)); } catch {}
      if (group.timer) clearTimeout(group.timer);
      group.timer = setTimeout(async () => {
        mediaGroups.delete(gid);
        const cap = group.firstMsg.caption || '';
        if (isPhotoQuestion(cap)) { await handlePhotoQuestion(bot, group.firstMsg, group.photos[0]); return; }
        const data = await showMealPreview(bot, group.firstMsg, group.photos);
        if (data) pendingStates.set(group.chatId, { type: 'meal_confirm', mealData: data, dayStart: group.dayStart });
      }, 1500);
      return;
    }

    const cap = msg.caption || '';
    if (isPhotoQuestion(cap)) {
      await handlePhotoQuestion(bot, msg, await downloadPhoto(bot, msg));
      return;
    }
    if (cap.length > 40) {
      pendingStates.set(chatId, { type: 'photo_clarification', originalMsg: msg, photos: [await downloadPhoto(bot, msg)], dayStart });
      await bot.sendMessage(chatId, 'Log this as a meal, or are you asking a question? Reply "log" or "question".');
      return;
    }
    const data = await showMealPreview(bot, msg, await downloadPhoto(bot, msg));
    if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart });
    return;
  }

  if (!msg.text) return;

  // ── Slash commands ────────────────────────────────────────────────────────
  if (msg.text.startsWith('/')) {
    if (msg.text === '/start')             await sendHelp(bot, chatId);
    else if (msg.text === '/today')        await handleToday(bot, chatId, dayStart);
    else if (msg.text === '/setweek odd')  { setWeekType('odd');  await bot.sendMessage(chatId, '✅ Odd week set.'); }
    else if (msg.text === '/setweek even') { setWeekType('even'); await bot.sendMessage(chatId, '✅ Even week set.'); }
    else if (msg.text === '/week')         { const t = getCurrentWeekType(); await bot.sendMessage(chatId, t ? `Current week: ${t.toUpperCase()}` : 'Not set.'); }
    return;
  }

  // ── "delete N" for /today list ────────────────────────────────────────────
  const delMatch = msg.text.match(/^delete\s+(\d+)$/i);
  if (delMatch && pendingStates.get(chatId)?.type === 'today_list') {
    const state = pendingStates.get(chatId);
    const idx = parseInt(delMatch[1]) - 1;
    if (idx >= 0 && idx < state.entries.length) {
      try {
        await notion.deleteEntry(state.entries[idx].pageId);
        pendingStates.delete(chatId);
        await bot.sendMessage(chatId, `🗑 Deleted: ${state.entries[idx].title}`);
      } catch { await bot.sendMessage(chatId, '❌ Failed to delete.'); }
    } else {
      await bot.sendMessage(chatId, `Pick 1–${state.entries.length}.`);
    }
    return;
  }

  // ── Classify + dispatch ───────────────────────────────────────────────────
  const intents = preIntents?.length ? preIntents : await claude.classify(msg.text);
  db.logMessage(chatId, msg.text, intents.join(','), msg.message_id);
  await dispatchIntents(bot, msg, chatId, userState, intents);
}

// ── Main bot setup ────────────────────────────────────────────────────────────

function startBot() {
  if (!config.telegram.healthToken) throw new Error('TELEGRAM_HEALTH_BOT_TOKEN not set');

  const bot = new TelegramBot(config.telegram.healthToken, { polling: true });
  console.log('✅ Health bot polling started');

  cronSvc.init(bot);

  bot.on('message', async (msg) => {
    const chatId    = msg.chat.id;
    const userState = db.getState(chatId);

    // ── COACH_REPLY: user swiped-replied to a coach message ──────────────────
    if (msg.reply_to_message?.message_id) {
      const repState = db.getState(chatId);
      if (repState.last_coach_message_id && msg.reply_to_message.message_id === repState.last_coach_message_id) {
        await handleCoachReply(bot, msg, repState.last_coach_message_id);
        return;
      }
    }

    // ── Workout details follow-up ─────────────────────────────────────────────
    if (msg.text && hasPendingWorkout(chatId)) {
      const handled = await handleWorkoutDetails(bot, chatId, msg.text);
      if (handled) return;
    }

    // ── Classify early — used for wake/bed detection before state routing ─────
    let earlyIntents = [];
    if (msg.text) {
      await bot.sendChatAction(chatId, 'typing');
      try { earlyIntents = await claude.classify(msg.text); } catch {}
    }
    const isWake = earlyIntents.includes('WAKE');
    const isBed  = earlyIntents.includes('BED');

    // ── bed_plans state ───────────────────────────────────────────────────────
    if (pendingStates.has(chatId)) {
      const state = pendingStates.get(chatId);

      if (state.type === 'bed_plans') {
        // If Haiku says WAKE, break out of bed_plans and start wake flow
        if (isWake) {
          pendingStates.delete(chatId);
          // fall through to wake detection below
        } else {
          // If it's a past log (workout/meal/recovery/sleep/weight), route to handlers — not a plan
          const LOG_INTENTS = ['WORKOUT_LOG','MEAL_LOG','DRINK_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG'];
          if (earlyIntents.some(i => LOG_INTENTS.includes(i))) {
            pendingStates.delete(chatId);
            await routeMessage(bot, msg, chatId, db.getState(chatId), earlyIntents);
            pendingStates.set(chatId, { type: 'bed_plans', pushback_sent: true });
            return;
          }

          const isDone = earlyIntents.includes('GENERAL') && !earlyIntents.some(i => ['PLAN','MEAL_LOG','WORKOUT_LOG','RECOVERY_LOG'].includes(i))
            && /^(no|nah|nope|skip|none|that'?s? it|done|nothing|all good|that's all)$/i.test((msg.text||'').trim());

          if (isDone && !state.pushback_sent) {
            state.pushback_sent = true;
            await bot.sendMessage(chatId, "really? no gym? no tasks? think about it.");
            return;
          }

          if (isDone && state.pushback_sent) {
            pendingStates.delete(chatId);
            await bot.sendMessage(chatId, 'good night.');
            return;
          }

          pendingStates.delete(chatId);
          const dbState = db.getState(chatId);
          const saved = await processBedPlans(chatId, msg.text || '', dbState.bed_plans_tomorrow);
          if (saved) {
            await bot.sendMessage(chatId, `set: ${saved}. anything else?`);
            pendingStates.set(chatId, { type: 'bed_plans', pushback_sent: true });
          } else {
            await bot.sendMessage(chatId, 'good night.');
          }
          return;
        }
      }
    }

    // ── Wake detection ────────────────────────────────────────────────────────
    if (userState.status === 'sleeping' && isWake) {
      pendingStates.delete(chatId);
      db.setState(chatId, { bed_nudge_sent: 0, weekly_waiting_weight: 0 });
      const wakeOverride = extractTimeMs(msg.text);
      const wakeData = await day.handleMorningWake(bot, chatId, userState, wakeOverride);
      pendingStates.set(chatId, { type: 'morning_quality', wakeData, pendingMsg: msg, pendingIntents: earlyIntents });
      return;
    }

    // ── Weekly weight waiting ─────────────────────────────────────────────────
    if (userState.weekly_waiting_weight && msg.text) {
      const weightMatch = msg.text.match(/(\d+\.?\d*)\s*kg?/i);
      if (weightMatch) {
        db.setState(chatId, { weekly_waiting_weight: 0 });
        await handleWeeklyReviewFlow(bot, msg, chatId);
        return;
      }
    }

    // ── Pending state handler ─────────────────────────────────────────────────
    if (pendingStates.has(chatId)) {
      const state = pendingStates.get(chatId);

      if (state.type === 'morning_quality') {
        const quality = parseQuality(msg.text || '');
        if (!quality) { await bot.sendMessage(chatId, 'quality? (1-5)'); return; }
        pendingStates.delete(chatId);
        if (!state.wakeData.hasBed) {
          // No bed time recorded — ask before logging sleep
          await bot.sendMessage(chatId, 'what time did you fall asleep? (e.g. 1am, or skip)');
          pendingStates.set(chatId, { type: 'morning_bed_time', quality, wakeData: state.wakeData, pendingMsg: state.pendingMsg, pendingIntents: state.pendingIntents });
          return;
        }
        await day.processQuality(bot, chatId, quality, state.wakeData);
        const LOG_TYPES = ['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG','PLAN'];
        const hasLogs = state.pendingIntents?.some(i => LOG_TYPES.includes(i));
        if (state.pendingMsg && hasLogs) {
          await routeMessage(bot, state.pendingMsg, chatId, db.getState(chatId), state.pendingIntents);
        }
        return;
      }

      if (state.type === 'morning_bed_time') {
        const text = (msg.text || '').toLowerCase().trim();
        const skip = /^(skip|no|idk|dunno|don't know|not sure|-)$/.test(text);
        let wakeData = state.wakeData;
        if (!skip) {
          const bedMs = extractTimeMs(msg.text);
          if (bedMs) {
            wakeData = { ...wakeData, hasBed: true, bedMs };
            const sleepMs = Math.max(0, wakeData.newDayStart - bedMs - 20 * 60 * 1000);
            wakeData.sleepH = Math.round(sleepMs / 3600000 * 10) / 10;
          }
        }
        pendingStates.delete(chatId);
        await day.processQuality(bot, chatId, state.quality, wakeData);
        const LOG_TYPES = ['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG','PLAN'];
        const hasLogs = state.pendingIntents?.some(i => LOG_TYPES.includes(i));
        if (state.pendingMsg && hasLogs) {
          await routeMessage(bot, state.pendingMsg, chatId, db.getState(chatId), state.pendingIntents);
        }
        return;
      }

      if (state.type === 'time_correction_select') {
        const num = parseInt((msg.text || '').trim());
        if (!isNaN(num) && num >= 1 && num <= state.entries.length) {
          pendingStates.delete(chatId);
          await notion.correctEntryTime(state.entries[num - 1].pageId, state.newISO);
          await bot.sendMessage(chatId, `✅ updated: ${state.entries[num - 1].title}`);
        } else {
          await bot.sendMessage(chatId, `Pick 1–${state.entries.length}.`);
        }
        return;
      }

      if (state.type === 'photo_clarification') {
        pendingStates.delete(chatId);
        const reply = (msg.text || '').toLowerCase();
        if (reply.includes('log') || reply.includes('meal') || reply.includes('yes')) {
          const data = await showMealPreview(bot, state.originalMsg, state.photos);
          if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart });
        } else {
          await handlePhotoQuestion(bot, state.originalMsg, state.photos[0]);
        }
        return;
      }

      if (state.type === 'meal_text_clarification') {
        pendingStates.delete(chatId);
        const fakeMsg = { ...msg, text: `${state.originalText}. ${msg.text || ''}`, caption: undefined };
        const data = await showMealPreview(bot, fakeMsg, null);
        if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart });
        return;
      }

      if (state.type === 'meal_confirm') {
        const text = msg.text || '';
        if (isCancellation(text)) {
          pendingStates.delete(chatId);
          await bot.sendMessage(chatId, '❌ Cancelled. Nothing logged.');
          return;
        }
        if (isConfirmation(text)) {
          pendingStates.delete(chatId);
          await logMeal(bot, chatId, state.mealData, state.dayStart);
          return;
        }
        // Inline correction
        pendingStates.delete(chatId);
        const updated = await applyCorrection(bot, chatId, state.mealData, text);
        if (!updated) return;
        await bot.sendMessage(chatId, formatPreview(updated).replace('Reply "ok" to log, or tell me what to fix.', 'Updated. Logging...'));
        await logMeal(bot, chatId, updated, state.dayStart);
        return;
      }

      // today_list: fall through
    }

    await routeMessage(bot, msg, chatId, userState, earlyIntents);
  });

  bot.on('polling_error', (err) => console.error('Polling error:', err.code, err.message));

  return bot;
}

// ── Weekly review flow ────────────────────────────────────────────────────────

async function handleWeeklyReviewFlow(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    await handleBody(bot, msg);

    const now = Date.now();
    const weekStartMs = now - 7 * 24 * 3600 * 1000;
    const weekData = await notion.getWeekData(weekStartMs).catch(() => ({}));
    let targetsCtx = '';
    try { targetsCtx = await notion.getTargetsText(); } catch {}

    const review = await claude.generateWeeklyReview(weekData, targetsCtx);
    const sent = await bot.sendMessage(chatId, review);

    await notion.createCoachNote(`Weekly Review — ${getMalaysiaDateStr()}`, review, 'Weekly Review').catch(() => {});
    db.setState(chatId, { last_coach_message_id: sent.message_id });
    db.saveCoachMessage(chatId, 'assistant', review, sent.message_id);
  } catch (err) {
    console.error('Weekly review flow error:', err.message);
  }
}

// ── /today ────────────────────────────────────────────────────────────────────

async function handleToday(bot, chatId, dayStart) {
  try {
    const entries = await notion.getTodayEntries(dayStart);
    if (!entries.length) { await bot.sendMessage(chatId, 'Nothing logged today yet.'); return; }
    const lines = ["Today's logs:\n", ...entries.map((e, i) => `${i+1}. [${e.label}] ${e.title}${e.extra ? ` — ${e.extra}` : ''}`)];
    lines.push('\nReply "delete N" to remove an entry.');
    pendingStates.set(chatId, { type: 'today_list', entries });
    await bot.sendMessage(chatId, lines.join('\n'));
  } catch (err) {
    console.error('Today error:', err.message);
    await bot.sendMessage(chatId, "❌ Failed to fetch today's logs.");
  }
}

async function sendHelp(bot, chatId) {
  await bot.sendMessage(chatId,
    'Health Logger\n\n' +
    '📷 Photo → meal log\n\n' +
    'Just say what you mean:\n' +
    '• Food/drinks → meal/drink log\n' +
    '• Workout description → workout log\n' +
    '• "sauna 15min 85°C" → recovery\n' +
    '• "slept 1am-8:30" → sleep log\n' +
    '• "104.2kg" → body check\n' +
    '• "gn" → day summary + bed\n' +
    '• "gym tomorrow 10am" → plan\n' +
    '• "change lunch time to 2pm" → correction\n' +
    '• Any question → coach\n\n' +
    '/today — today\'s logs\n' +
    '/week — current week type\n' +
    '/setweek odd|even'
  );
}

module.exports = { startBot };
