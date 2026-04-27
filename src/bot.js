const TelegramBot = require('node-telegram-bot-api');
const config  = require('./config');
const db      = require('./db');
const cronSvc = require('./cron');
const claude  = require('./claude');
const notion  = require('./notion');
const day     = require('./handlers/day');
const { showMealPreview, logMeal, applyCorrection, formatPreview } = require('./handlers/meal');
const { showWorkoutPreview, logWorkout, formatWorkoutPreview } = require('./handlers/workout');
const { handleRecovery }    = require('./handlers/recovery');
const { handleSleep }       = require('./handlers/sleep');
const { handleBody }        = require('./handlers/body');
const { handleAsk, handleCoachReply, handlePhotoQuestion } = require('./handlers/ask');
const { handlePlan, handlePlanDone, handlePlanSkip, processBedPlans } = require('./handlers/plans');
const { handleCorrection }  = require('./handlers/correction');
const { getCurrentWeekType, setWeekType } = require('./utils/weekTracker');
const { buildTimeISO, nowContext, getMalaysiaDateStr, extractTimeMs, detectRetroDate } = require('./utils/time');

const CONFIRM_WORDS = ['ok','okay','yes','log','log it','✅','yep','yup','looks good','good','sure','go'];
const CANCEL_WORDS  = ['cancel','no','nope','skip','stop','abort'];

const pendingStates = new Map();
const mediaGroups   = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

const isConfirmation = (t) => { const lc = (t||'').toLowerCase().trim(); return CONFIRM_WORDS.some(w => lc === w || lc.startsWith(w + ' ')); };
const isCancellation = (t) => { const lc = (t||'').toLowerCase().trim(); return CANCEL_WORDS.some(w => lc === w || /^(no|nope|cancel|skip|stop|abort)[^a-z]/i.test(lc) || lc.startsWith(w + ' ')); };
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

async function handleDeletion(bot, msg, chatId, userState) {
  await bot.sendChatAction(chatId, 'typing');
  const dayStart = userState?.current_day_start;
  try {
    const entries = await notion.getTodayEntries(dayStart);
    if (!entries.length) { await bot.sendMessage(chatId, 'Nothing logged today to delete.'); return; }

    const match = await claude.matchEntryToDelete(msg.text, entries);
    if (!match) {
      // Can't determine — show list
      const lines = ["Which entry to delete?\n", ...entries.map((e, i) => `${i+1}. [${e.label}] ${e.title}${e.extra ? ' — ' + e.extra : ''}`)];
      lines.push('\nReply "delete N" to remove.');
      pendingStates.set(chatId, { type: 'today_list', entries });
      await bot.sendMessage(chatId, lines.join('\n'));
      return;
    }

    await notion.deleteEntry(match.pageId);
    await bot.sendMessage(chatId, `🗑 deleted: ${match.title}${match.extra ? ' — ' + match.extra : ''}`);
  } catch (err) {
    console.error('Delete error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to delete. Try /today to see entries.');
  }
}

async function maybeTriggerCatchup(bot, chatId, wakeData) {
  if (!wakeData?.prevDayStart) return;
  const { getMalaysiaDate } = require('./utils/time');
  const OFFSET_MS = 8 * 60 * 60 * 1000;
  const prevDate = new Date(wakeData.prevDayStart + OFFSET_MS);
  const retroDate = prevDate.toISOString().split('T')[0];
  await bot.sendMessage(chatId, 'anything to catch up from yesterday?');
  pendingStates.set(chatId, { type: 'catchup_log', retroDate, dayStartMs: wakeData.prevDayStart });
}

// ── Intent dispatcher ─────────────────────────────────────────────────────────

async function dispatchIntents(bot, msg, chatId, userState, intents) {
  // BED: highest priority
  if (intents.includes('BED')) {
    const text = (msg.text || '').toLowerCase();
    const isFutureIntent = /\b(soon|gonna|in a bit|later|not yet|finishing|still|few minutes|few mins|almost)\b/.test(text);
    if (isFutureIntent) {
      await bot.sendMessage(chatId, 'ok, message me when you actually head to bed.');
      return;
    }
    pendingStates.delete(chatId);
    await day.handleBedTime(bot, chatId, userState);
    pendingStates.set(chatId, { type: 'bed_plans', pushback_sent: false });
    return;
  }

  if (intents.includes('DELETE')) {
    await handleDeletion(bot, msg, chatId, userState);
    return;
  }

  // Only treat as CORRECTION if no meal intent — "had pizza at 1pm" is a meal, not a correction
  if (intents.includes('CORRECTION') && !intents.some(i => MEAL_SET.has(i))) {
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
      case 'WORKOUT_LOG': {
        const wData = await showWorkoutPreview(bot, msg);
        if (wData) pendingStates.set(chatId, { type: 'workout_confirm', workoutData: wData, catchupRetro: msg._catchupRetro });
        break;
      }
      case 'RECOVERY_LOG':  await handleRecovery(bot, msg);   break;
      case 'SLEEP_LOG':     await handleSleep(bot, msg);      break;
      case 'WEIGHT_LOG':    await handleBody(bot, msg);        break;
      case 'PLAN':          await handlePlan(bot, msg);        break;
      case 'PLAN_DONE':     await handlePlanDone(bot, msg);    break;
      case 'PLAN_SKIP':     await handlePlanSkip(bot, msg);    break;
      case 'UPDATE_TARGETS': await handleUpdateTargets(bot, msg, chatId); break;
      case 'WAKE':
        if (userState.status === 'sleeping') break; // handled by wake flow
        // deliberate fall-through
      case 'COACH_QUESTION':
      case 'GENERAL':       await handleAsk(bot, msg);         break;
    }
  }

  if (hasMeal) {
    const retroDate = msg._retroDate;
    const data = await showMealPreview(bot, msg, null);
    if (!data) {
      pendingStates.set(chatId, { type: 'meal_text_clarification', originalText: msg.text, dayStart: retroDate?.dayStartMs ?? userState?.current_day_start, retroDate: retroDate?.dateStr, catchupRetro: msg._catchupRetro });
    } else {
      pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: retroDate?.dayStartMs ?? userState?.current_day_start, retroDate: retroDate?.dateStr, catchupRetro: msg._catchupRetro });
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
        else pendingStates.set(group.chatId, { type: 'meal_photo_clarification', caption: group.firstMsg.caption || '', photo: group.photos[0], dayStart: group.dayStart });
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
    const photo = await downloadPhoto(bot, msg);
    const data = await showMealPreview(bot, msg, photo);
    if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart });
    else pendingStates.set(chatId, { type: 'meal_photo_clarification', caption: msg.caption || '', photo, dayStart });
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
  const intents = preIntents?.length ? preIntents : await claude.classify(msg.text, db.getHistory(chatId, 10));
  db.logMessage(chatId, msg.text, intents.join(','), msg.message_id);
  if (!msg._retroDate) {
    const retro = detectRetroDate(msg.text);
    if (retro) msg._retroDate = retro;
  }
  await dispatchIntents(bot, msg, chatId, userState, intents);
}

// ── Main bot setup ────────────────────────────────────────────────────────────

function startBot() {
  if (!config.telegram.healthToken) throw new Error('TELEGRAM_HEALTH_BOT_TOKEN not set');

  const bot = new TelegramBot(config.telegram.healthToken, { polling: true });
  console.log('✅ Health bot polling started');

  // Save bot text replies to chat history for classifier context
  const _origSend = bot.sendMessage.bind(bot);
  bot.sendMessage = async (chatId, text, opts) => {
    const result = await _origSend(chatId, text, opts);
    if (typeof text === 'string') db.saveHistory(chatId, 'assistant', text);
    return result;
  };

  cronSvc.init(bot);

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    try {
    const userState = db.getState(chatId);

    // ── COACH_REPLY: user swiped-replied to a coach message ──────────────────
    if (msg.reply_to_message?.message_id) {
      const repState = db.getState(chatId);
      if (repState.last_coach_message_id && msg.reply_to_message.message_id === repState.last_coach_message_id) {
        await handleCoachReply(bot, msg, repState.last_coach_message_id);
        return;
      }
    }

    // ── Log every user message immediately so wasRecentlyActive works ──────────
    if (msg.text) {
      db.saveHistory(chatId, 'user', msg.text);
      db.logMessage(chatId, msg.text, 'incoming', msg.message_id);
    }

    // ── Classify early — used for wake/bed detection before state routing ─────
    let earlyIntents = [];
    if (msg.text) {
      await bot.sendChatAction(chatId, 'typing');
      const history = db.getHistory(chatId, 10);
      try { earlyIntents = await claude.classify(msg.text, history); } catch {}
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

          if (earlyIntents.includes('COACH_QUESTION') && !earlyIntents.some(i => ['PLAN','MEAL_LOG','WORKOUT_LOG','RECOVERY_LOG'].includes(i))) {
            await handleAsk(bot, msg);
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
      const isMonday = new Date(Date.now() + 8 * 3600 * 1000).getUTCDay() === 1;
      db.setState(chatId, { bed_nudge_sent: 0, weekly_waiting_weight: isMonday ? 1 : 0 });
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
        const curStateAfter = db.getState(chatId);
        if (curStateAfter.weekly_waiting_weight) {
          await bot.sendMessage(chatId, '📋 it\'s monday — log your weight + body fat for the weekly review.');
          scheduleWeeklyReminders(bot, chatId);
        }
        const LOG_TYPES = ['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG','PLAN'];
        const hasLogs = state.pendingIntents?.some(i => LOG_TYPES.includes(i));
        if (state.pendingMsg && hasLogs) {
          await routeMessage(bot, state.pendingMsg, chatId, db.getState(chatId), state.pendingIntents);
        } else {
          await maybeTriggerCatchup(bot, chatId, state.wakeData);
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
        const curStateAfter = db.getState(chatId);
        if (curStateAfter.weekly_waiting_weight) {
          await bot.sendMessage(chatId, '📋 it\'s monday — log your weight + body fat for the weekly review.');
          scheduleWeeklyReminders(bot, chatId);
        }
        const LOG_TYPES = ['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG','PLAN'];
        const hasLogs = state.pendingIntents?.some(i => LOG_TYPES.includes(i));
        if (state.pendingMsg && hasLogs) {
          await routeMessage(bot, state.pendingMsg, chatId, db.getState(chatId), state.pendingIntents);
        } else {
          await maybeTriggerCatchup(bot, chatId, wakeData);
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

      if (state.type === 'workout_confirm') {
        const text = msg.text || '';
        const isWorkoutCancel = earlyIntents.length === 1 && earlyIntents[0] === 'GENERAL'
          && text.trim().split(/\s+/).length <= 3
          && /^(no|nope|cancel|skip|stop|abort|nevermind|never mind)$/i.test(text.trim());
        if (isWorkoutCancel) {
          pendingStates.delete(chatId);
          await bot.sendMessage(chatId, '❌ Cancelled.');
          return;
        }
        const isWCorrection = earlyIntents.some(i => ['WORKOUT_LOG','CORRECTION'].includes(i));

        if (isConfirmation(text) && !isWCorrection) {
          pendingStates.delete(chatId);
          await logWorkout(bot, chatId, state.workoutData);
          if (state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            pendingStates.set(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
          return;
        }

        if (isWCorrection) {
          pendingStates.delete(chatId);
          await bot.sendChatAction(chatId, 'typing');
          try {
            const updated = await claude.applyWorkoutCorrection(state.workoutData, text);
            await bot.sendMessage(chatId, formatWorkoutPreview(updated));
            pendingStates.set(chatId, { type: 'workout_confirm', workoutData: updated, catchupRetro: state.catchupRetro });
          } catch {
            await bot.sendMessage(chatId, '❌ Could not apply correction.');
          }
          return;
        }

        if (earlyIntents.includes('COACH_QUESTION')) {
          pendingStates.delete(chatId);
          await handleAsk(bot, msg);
          return;
        }

        pendingStates.delete(chatId);
        await logWorkout(bot, chatId, state.workoutData);
        if (state.catchupRetro) {
          await bot.sendMessage(chatId, 'anything else? (or done)');
          pendingStates.set(chatId, { type: 'catchup_log', ...state.catchupRetro });
        }
        return;
      }

      if (state.type === 'meal_photo_clarification') {
        pendingStates.delete(chatId);
        const fakeMsg = { ...msg, caption: `${state.caption}. ${msg.text || ''}`, text: undefined };
        const data = await showMealPreview(bot, fakeMsg, state.photo);
        if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart });
        else pendingStates.set(chatId, { type: 'meal_photo_clarification', caption: fakeMsg.caption, photo: state.photo, dayStart: state.dayStart });
        return;
      }

      if (state.type === 'meal_text_clarification') {
        pendingStates.delete(chatId);
        const combinedText = `${state.originalText}. ${msg.text || ''}`;
        const fakeMsg = { ...msg, text: combinedText, caption: undefined };
        const data = await showMealPreview(bot, fakeMsg, null);
        if (data) pendingStates.set(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
        else pendingStates.set(chatId, { type: 'meal_text_clarification', originalText: combinedText, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
        return;
      }

      if (state.type === 'meal_confirm') {
        const text = msg.text || '';
        const mealData = state.retroDate ? { ...state.mealData, date: state.retroDate } : state.mealData;

        // Cancel only on standalone short cancel messages — never on sentences that start with "no"
        const isExplicitCancel = earlyIntents.length === 1 && earlyIntents[0] === 'GENERAL'
          && text.trim().split(/\s+/).length <= 3
          && /^(no|nope|cancel|skip|stop|abort|nevermind|never mind)$/i.test(text.trim());
        if (isExplicitCancel) {
          pendingStates.delete(chatId);
          await bot.sendMessage(chatId, '❌ Cancelled. Nothing logged.');
          if (state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            pendingStates.set(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
          return;
        }

        const isCorrectionIntent = earlyIntents.some(i => ['MEAL_LOG','DRINK_LOG','CORRECTION'].includes(i));

        // Explicit confirmation → log immediately, never reroute
        if (isConfirmation(text) && !isCorrectionIntent) {
          pendingStates.delete(chatId);
          await logMeal(bot, chatId, mealData, state.dayStart);
          if (state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            pendingStates.set(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
          return;
        }

        // Correction → apply and loop
        if (isCorrectionIntent) {
          pendingStates.delete(chatId);
          const updated = await applyCorrection(bot, chatId, mealData, text);
          if (!updated) return;
          await bot.sendMessage(chatId, formatPreview(updated));
          pendingStates.set(chatId, { type: 'meal_confirm', mealData: updated, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
          return;
        }

        // Question → answer it, drop the pending meal
        if (earlyIntents.includes('COACH_QUESTION')) {
          pendingStates.delete(chatId);
          await handleAsk(bot, msg);
          return;
        }

        // Anything else (ambiguous reply) → log
        pendingStates.delete(chatId);
        await logMeal(bot, chatId, mealData, state.dayStart);
        if (state.catchupRetro) {
          await bot.sendMessage(chatId, 'anything else? (or done)');
          pendingStates.set(chatId, { type: 'catchup_log', ...state.catchupRetro });
        }
        return;
      }

      if (state.type === 'catchup_log') {
        const isDone = /^(no|nah|nope|skip|none|done|nothing|all good|that'?s?\s*(it|all))$/i.test((msg.text||'').trim());
        if (isDone) {
          pendingStates.delete(chatId);
          return;
        }
        const catchupRetro = { retroDate: state.retroDate, dayStartMs: state.dayStartMs };
        const fakeMsg = { ...msg, _retroDate: { dateStr: state.retroDate, dayStartMs: state.dayStartMs }, _catchupRetro: catchupRetro };
        pendingStates.delete(chatId);
        await routeMessage(bot, fakeMsg, chatId, db.getState(chatId), earlyIntents);
        // If routeMessage set a meal_confirm state, inject catchupRetro into it
        const curState = pendingStates.get(chatId);
        if (curState?.type === 'meal_confirm' || curState?.type === 'meal_text_clarification') {
          pendingStates.set(chatId, { ...curState, catchupRetro });
        } else if (!pendingStates.has(chatId)) {
          // Immediate log (workout/recovery/sleep), ask for more
          await bot.sendMessage(chatId, 'anything else? (or done)');
          pendingStates.set(chatId, { type: 'catchup_log', ...catchupRetro });
        }
        return;
      }

      // today_list: fall through
    }

    await routeMessage(bot, msg, chatId, userState, earlyIntents);
    } catch (err) {
      console.error('Unhandled message error:', err.message, err.stack);
      try { await bot.sendMessage(chatId, `❌ ${err.message || 'unknown error'}`); } catch {}
    }
  });

  bot.on('polling_error', (err) => console.error('Polling error:', err.code, err.message));

  return bot;
}

// ── Weekly weight reminders ───────────────────────────────────────────────────

function scheduleWeeklyReminders(bot, chatId) {
  let attempt = 0;
  const maxAttempts = 8; // 4 hours max (8 × 30 min)
  function scheduleNext() {
    if (attempt >= maxAttempts) return;
    attempt++;
    setTimeout(async () => {
      const state = db.getState(chatId);
      if (!state.weekly_waiting_weight) return; // already logged
      await bot.sendMessage(chatId, '⚖️ still need your weekly weight. log it when ready.').catch(() => {});
      scheduleNext();
    }, 30 * 60 * 1000);
  }
  scheduleNext();
}

// ── Update targets ────────────────────────────────────────────────────────────

async function handleUpdateTargets(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    const updates = await claude.parseTargetUpdate(msg.text || '');
    if (!updates) { await bot.sendMessage(chatId, "couldn't parse that. try: 'set calorie target to 1800'"); return; }
    const changed = Object.entries(updates).filter(([, v]) => v != null);
    if (!changed.length) { await bot.sendMessage(chatId, "no targets found. try: 'set protein to 200g'"); return; }
    await notion.updateTargets(updates);
    const lines = changed.map(([k, v]) => `${k}: ${v}${k === 'calories' ? ' kcal' : 'g'}`);
    await bot.sendMessage(chatId, `✅ targets updated:\n${lines.join('\n')}`);
  } catch (err) {
    console.error('Update targets error:', err.message);
    await bot.sendMessage(chatId, '❌ Failed to update targets. Try again.');
  }
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
