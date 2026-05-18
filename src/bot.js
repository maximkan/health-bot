const TelegramBot = require('node-telegram-bot-api');
const config  = require('./config');
const db      = require('./db');
const cronSvc = require('./cron');
const claude  = require('./claude');
const day     = require('./handlers/day');
const { showMealPreview, logMeal, applyCorrection, formatPreview } = require('./handlers/meal');
const { showWorkoutPreview, logWorkout, formatWorkoutPreview, computeWorkoutCalories, formatExerciseLine } = require('./handlers/workout');
const { handleRecovery }    = require('./handlers/recovery');
const { closeChain }        = require('./handlers/ask');
const { handleSleep }       = require('./handlers/sleep');
const { handleBody }        = require('./handlers/body');
const { handleAsk, handleCoachReply, handlePhotoQuestion } = require('./handlers/ask');
const { handlePlan, handlePlanDone, handlePlanSkip, processBedPlans } = require('./handlers/plans');
const { handleOnboarding } = require('./handlers/onboarding');
const { handleCorrection }  = require('./handlers/correction');
const { getCurrentWeekType, setWeekType } = require('./utils/weekTracker');
const { nowContextTz, extractTimeMs, detectRetroDate, getOffsetMs, getDateStrTz, requireTimezone } = require('./utils/time');

const pendingStates = new Map();
const mediaGroups   = new Map();

const STATE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const STATE_MAX_ATTEMPTS    = 2;

const CANCEL_WORDS_RE = /^(cancel|nevermind|never mind|skip this|forget it|stop|\/cancel|отмена|забудь|отменить|неважно)$/i;

function setPendingState(chatId, state) {
  pendingStates.set(chatId, { ...state, _createdAt: Date.now(), _attempts: 0 });
}

function isPendingStateExpired(state) {
  return state?._createdAt && (Date.now() - state._createdAt > STATE_IDLE_TIMEOUT_MS);
}

function bumpAttempts(chatId) {
  const s = pendingStates.get(chatId);
  if (!s) return 0;
  s._attempts = (s._attempts ?? 0) + 1;
  return s._attempts;
}

function isCancelMessage(text) {
  return typeof text === 'string' && CANCEL_WORDS_RE.test(text.trim());
}

// ── Helpers ───────────────────────────────────────────────────────────────────

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

async function handleRename(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  const recentLogs = db.getRecentLogs(chatId, 7);
  const parsed = await claude.parseRenameIntent(msg.text || '', recentLogs).catch(() => null);
  if (!parsed?.new_name) { await bot.sendMessage(chatId, "couldn't figure out what to rename. try: \"rename my kettlebell workout to golf workout\""); return; }
  const entry = parsed.entry_id
    ? (recentLogs.find(e => e.id === parsed.entry_id) || null)
    : db.getLastLogEntry(chatId, db.getState(chatId).current_day_start);
  if (entry) { db.renameLog(entry.type, entry.id, parsed.new_name); await bot.sendMessage(chatId, `✅ "${entry.name}" renamed to "${parsed.new_name}"`); }
  else await bot.sendMessage(chatId, "couldn't find that entry in your recent logs.");
}

async function handleDeletion(bot, msg, chatId, userState) {
  await bot.sendChatAction(chatId, 'typing');
  const dayStart = userState?.current_day_start;
  try {
    const entries = db.getTodayEntriesFromSQLite(chatId, dayStart);
    if (!entries.length) { await bot.sendMessage(chatId, 'Nothing logged today to delete.'); return; }

    // "Last meal/entry/log" — don't rely on Haiku; entries are ASC so last meal = last in array
    let match = null;
    if (/\b(last|latest|most recent)\b/i.test(msg.text)) {
      match = [...entries].reverse().find(e => e.label === 'Meal' || e.label === 'Drink') || null;
    }
    if (!match) match = await claude.matchEntryToDelete(msg.text, entries);
    if (!match) {
      const lines = ["Which entry to delete?\n", ...entries.map((e, i) => `${i+1}. [${e.label}] ${e.title}${e.extra ? ' — ' + e.extra : ''}`)];
      lines.push('\nReply "delete N" to remove.');
      setPendingState(chatId, { type: 'today_list', entries });
      await bot.sendMessage(chatId, lines.join('\n'));
      return;
    }

    db.deleteTodayEntry(match);
    await bot.sendMessage(chatId, `🗑 deleted: ${match.title}${match.extra ? ' — ' + match.extra : ''}`);
  } catch (err) {
    console.error('Delete error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function maybeTriggerCatchup(bot, chatId, wakeData) {
  const tz = requireTimezone(db.getState(chatId));
  const offsetMs = getOffsetMs(tz);
  // Always offer the calendar day before today in the user's timezone — not prevDayStart,
  // which would be wrong if they skipped a day entirely.
  const todayStr = new Date(Date.now() + offsetMs).toISOString().split('T')[0];
  const [ty, tm, td] = todayStr.split('-').map(Number);
  const retroDate = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().split('T')[0];
  // dayStartMs: use prevDayStart if it falls on the retro date, else synthesise midnight of retro date
  let dayStartMs = wakeData?.prevDayStart ?? null;
  if (dayStartMs) {
    const prevStr = new Date(dayStartMs + offsetMs).toISOString().split('T')[0];
    if (prevStr !== retroDate) dayStartMs = null;
  }
  if (!dayStartMs) {
    const [ry, rm, rd] = retroDate.split('-').map(Number);
    dayStartMs = Date.UTC(ry, rm - 1, rd) - offsetMs;
  }
  await bot.sendMessage(chatId, 'anything to catch up from yesterday?');
  setPendingState(chatId, { type: 'catchup_log', retroDate, dayStartMs });
}

// ── Intent dispatcher ─────────────────────────────────────────────────────────

const LOG_CLOSE_INTENTS = new Set(['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG','BED']);

async function dispatchIntents(bot, msg, chatId, userState, intents) {
  // Close any open coach chain when a log or bed intent arrives
  if (intents.some(i => LOG_CLOSE_INTENTS.has(i))) {
    const prevChainId = userState?.current_chain_id || userState?.last_coach_message_id;
    if (prevChainId) {
      const exchanges = db.countExchanges(chatId, prevChainId);
      if (exchanges >= 1) closeChain(chatId, prevChainId).catch(() => {});
    }
  }

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
    setPendingState(chatId, { type: 'bed_plans', pushback_sent: false });
    return;
  }

  if (intents.includes('RENAME')) {
    await handleRename(bot, msg, chatId);
    return;
  }

  if (intents.includes('DELETE')) {
    await handleDeletion(bot, msg, chatId, userState);
    return;
  }

  const MEAL_SET = new Set(['MEAL_LOG','DRINK_LOG']);

  // Only treat as CORRECTION if no meal intent — "had pizza at 1pm" is a meal, not a correction
  if (intents.includes('CORRECTION') && !intents.some(i => MEAL_SET.has(i))) {
    const result = await handleCorrection(bot, msg, chatId, userState);
    if (result?.lines) {
      setPendingState(chatId, { type: 'time_correction_select', entries: result.entries, newISO: result.newISO });
      await bot.sendMessage(chatId, result.lines);
    }
    return;
  }
  const nonMeal  = intents.filter(i => !MEAL_SET.has(i));
  const hasMeal  = intents.some(i => MEAL_SET.has(i));

  let workoutQueued = false; // track if we have a pending workout confirm

  for (const intent of nonMeal) {
    switch (intent) {
      case 'WORKOUT_START': {
        setPendingState(chatId, { type: 'live_workout', exercises: [], startTime: Date.now() });
        await bot.sendMessage(chatId, 'got it — send me your exercises one by one as you finish them. say "done" when you\'re finished.');
        return;
      }
      case 'WORKOUT_LOG': {
        const wData = await showWorkoutPreview(bot, msg);
        if (wData) {
          setPendingState(chatId, { type: 'workout_confirm', workoutData: wData, catchupRetro: msg._catchupRetro });
          workoutQueued = true;
        }
        break;
      }
      case 'RECOVERY_LOG':  await handleRecovery(bot, msg);   break;
      case 'SLEEP_LOG':     await handleSleep(bot, msg);      break;
      case 'WEIGHT_LOG':    await handleBody(bot, msg);        break;
      case 'PLAN':           await handlePlan(bot, msg);                          break;
      case 'PLAN_DONE':      await handlePlanDone(bot, msg);                       break;
      case 'PLAN_SKIP':      await handlePlanSkip(bot, msg);                       break;
      case 'CANCEL_REMINDER': await handleCancelReminder(bot, msg, chatId);        break;
      case 'UPDATE_TIMEZONE': await handleTimezoneChange(bot, msg, chatId);        break;
      case 'UPDATE_TARGETS': await handleUpdateTargets(bot, msg, chatId);          break;
      case 'WAKE':
        if (userState.status === 'sleeping') break; // handled by wake flow
        // deliberate fall-through
      case 'FULL_ANALYSIS':
      case 'COACH_QUESTION':
      case 'GENERAL':       await handleAsk(bot, msg, '', intents);  break;
    }
  }

  if (hasMeal) {
    const retroDate = msg._retroDate;
    const dayStart = retroDate?.dayStartMs ?? userState?.current_day_start;
    if (workoutQueued) {
      // Queue the meal to be shown after workout is confirmed/cancelled
      const cur = pendingStates.get(chatId);
      setPendingState(chatId, { ...cur, queuedMealMsg: msg, queuedMealDayStart: dayStart });
    } else {
      const data = await showMealPreview(bot, msg, null);
      if (!data) {
        setPendingState(chatId, { type: 'meal_text_clarification', originalText: msg.text, dayStart, retroDate: retroDate?.dateStr, catchupRetro: msg._catchupRetro });
      } else {
        setPendingState(chatId, { type: 'meal_confirm', mealData: data, needsClarification: !!data._needsClarification, dayStart, retroDate: retroDate?.dateStr, catchupRetro: msg._catchupRetro });
      }
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
        const capIntents = cap ? await claude.classify(cap, []).catch(() => []) : [];
        const isQuestion = capIntents.includes('COACH_QUESTION') && !capIntents.some(i => i === 'MEAL_LOG' || i === 'DRINK_LOG');
        if (isQuestion) { await handlePhotoQuestion(bot, group.firstMsg, group.photos[0]); return; }
        const data = await showMealPreview(bot, group.firstMsg, group.photos);
        if (data) setPendingState(group.chatId, { type: 'meal_confirm', mealData: data, dayStart: group.dayStart });
        else setPendingState(group.chatId, { type: 'meal_photo_clarification', caption: group.firstMsg.caption || '', photo: group.photos[0], dayStart: group.dayStart });
      }, 1500);
      return;
    }

    const cap = msg.caption || '';
    if (cap) {
      const capIntents = await claude.classify(cap, []).catch(() => []);
      const isQuestion = capIntents.includes('COACH_QUESTION') && !capIntents.some(i => i === 'MEAL_LOG' || i === 'DRINK_LOG');
      if (isQuestion) {
        await handlePhotoQuestion(bot, msg, await downloadPhoto(bot, msg));
        return;
      }
    }
    const photo = await downloadPhoto(bot, msg);
    const data = await showMealPreview(bot, msg, photo);
    if (data) setPendingState(chatId, { type: 'meal_confirm', mealData: data, needsClarification: !!data._needsClarification, dayStart });
    else setPendingState(chatId, { type: 'meal_photo_clarification', caption: msg.caption || '', photo, dayStart });
    return;
  }

  if (!msg.text) return;

  // ── Slash commands ────────────────────────────────────────────────────────
  if (msg.text.startsWith('/')) {
    if (msg.text === '/start')             await sendHelp(bot, chatId);
    else if (msg.text === '/today')        await handleToday(bot, chatId, dayStart);
    else if (msg.text === '/setweek odd')  { setWeekType('odd',  requireTimezone(userState)); await bot.sendMessage(chatId, '✅ Odd week set.'); }
    else if (msg.text === '/setweek even') { setWeekType('even', requireTimezone(userState)); await bot.sendMessage(chatId, '✅ Even week set.'); }
    else if (msg.text === '/week')         { const t = getCurrentWeekType(requireTimezone(userState)); await bot.sendMessage(chatId, t ? `Current week: ${t.toUpperCase()}` : 'Not set.'); }
    return;
  }

  // ── "delete N" for /today list ────────────────────────────────────────────
  if (pendingStates.get(chatId)?.type === 'today_list' && isCancelMessage(msg.text)) {
    pendingStates.delete(chatId);
    await bot.sendMessage(chatId, 'cancelled.');
    return;
  }
  const delMatch = msg.text.match(/^delete\s+(\d+)$/i);
  if (delMatch && pendingStates.get(chatId)?.type === 'today_list') {
    const state = pendingStates.get(chatId);
    const idx = parseInt(delMatch[1]) - 1;
    if (idx >= 0 && idx < state.entries.length) {
      db.deleteTodayEntry(state.entries[idx]);
      pendingStates.delete(chatId);
      await bot.sendMessage(chatId, `🗑 deleted: ${state.entries[idx].title}`);
    } else {
      await bot.sendMessage(chatId, `Pick 1–${state.entries.length}.`);
    }
    return;
  }

  // ── Classify + dispatch ───────────────────────────────────────────────────
  const intents = preIntents?.length ? preIntents : await claude.classify(msg.text, db.getHistory(chatId, 10));
  db.logMessage(chatId, msg.text, intents.join(','), msg.message_id);
  if (!msg._retroDate) {
    const retro = detectRetroDate(msg.text, requireTimezone(userState));
    if (retro) msg._retroDate = retro;
  }
  await dispatchIntents(bot, msg, chatId, userState, intents);
}

// ── Main bot setup ────────────────────────────────────────────────────────────

function startBot() {
  if (!config.telegram.healthToken) throw new Error('TELEGRAM_HEALTH_BOT_TOKEN not set');

  const bot = new TelegramBot(config.telegram.healthToken, { polling: true });
  console.log('✅ Health bot polling started');

  // Auto-translate hardcoded English messages for non-English users, save to history
  const _origSend = bot.sendMessage.bind(bot);
  const _tlCache  = new Map();
  bot.sendMessage = async (chatId, text, opts) => {
    let finalText = text;
    if (typeof text === 'string') {
      const lang = db.getState(chatId)?.language;
      const needsTranslation = lang && !/^en(glish)?$/i.test(lang.trim());
      // Skip translation only if non-Latin chars outnumber Latin chars (already mostly translated)
      const latinCount    = (text.match(/[a-zA-Z]/g) || []).length;
      const nonLatinCount = (text.match(/[а-яА-ЯёЁ\u4e00-\u9fff\u0600-\u06ff\u0e00-\u0e7f\u3040-\u30ff]/g) || []).length;
      const alreadyTranslated = nonLatinCount > 0 && nonLatinCount > latinCount;
      if (needsTranslation && !alreadyTranslated) {
        const key = `${lang}|${text}`;
        if (_tlCache.has(key)) {
          finalText = _tlCache.get(key);
        } else {
          try {
            finalText = await claude.translateText(text, lang);
            _tlCache.set(key, finalText);
          } catch { finalText = text; }
        }
      }
      db.saveHistory(chatId, 'assistant', finalText);
    }
    return await _origSend(chatId, finalText, opts);
  };

  cronSvc.init(bot);
  require('./auth-server').start(() => bot);

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    try {
    const userState = db.getState(chatId);

    // ── Onboarding gate ───────────────────────────────────────────────────────
    if (!userState.onboarded) {
      await handleOnboarding(bot, msg);
      return;
    }

    // ── REPLY: rename log or coach reply ─────────────────────────────────────
    if (msg.reply_to_message?.message_id) {
      const repState = db.getState(chatId);
      const repliedMsgId = msg.reply_to_message.message_id;
      const text = msg.text || '';

      // Rename via reply — let Claude extract the new name
      if (/rename|call it|log.*as|name it|переименуй|назови/i.test(text)) {
        const parsed = await claude.parseRenameIntent(text).catch(() => null);
        if (parsed?.new_name) {
          const entry = db.getLogByBotMessageId(chatId, repliedMsgId);
          if (entry) {
            db.renameLog(entry.type, entry.id, parsed.new_name);
            await bot.sendMessage(chatId, `✅ renamed to "${parsed.new_name}"`);
          } else {
            await bot.sendMessage(chatId, "couldn't find that log entry.");
          }
          return;
        }
      }

      if (repState.last_coach_message_id && repliedMsgId === repState.last_coach_message_id) {
        await handleCoachReply(bot, msg, repState.last_coach_message_id);
        return;
      }
    }


    // ── Log every user message immediately so wasRecentlyActive works ──────────
    if (msg.text) {
      db.saveHistory(chatId, 'user', msg.text);
      db.logMessage(chatId, msg.text, 'incoming', msg.message_id);
    }

    // ── Translate non-English messages to English before processing ───────────
    if (msg.text && userState.language && !/^en(glish)?$/i.test(userState.language.trim())) {
      const hasForeignChars = /[а-яА-ЯёЁ\u4e00-\u9fff\u0600-\u06ff\u0e00-\u0e7f\u3040-\u30ff]/.test(msg.text);
      if (hasForeignChars) {
        try {
          const translated = await claude.translateToEnglish(msg.text);
          if (translated) msg = { ...msg, text: translated };
        } catch {}
      }
    }

    // ── Classify early — used for wake/bed detection before state routing ─────
    let earlyIntents = [];
    if (msg.text) {
      await bot.sendChatAction(chatId, 'typing');
      // RENAME is classified without history — history can get poisoned by past failed attempts
      const renameCheck = await claude.classify(msg.text, []).catch(() => []);
      if (renameCheck.includes('RENAME')) {
        await handleRename(bot, msg, chatId);
        return;
      }
      const history = db.getHistory(chatId, 10);
      try { earlyIntents = await claude.classify(msg.text, history); } catch {}
      if (earlyIntents.includes('RENAME')) {
        await handleRename(bot, msg, chatId);
        return;
      }
    }
    // BED: explicit phrases are unambiguous — don't let history poison them
    // Allow short ack prefix (yeah/ok/alright) before the bed phrase, e.g. "Yeah gn"
    const BED_SUFFIX = /(gn|g\.n\.|good\s+night|goodnight|going\s+to\s+bed|heading\s+to\s+bed|off\s+to\s+bed|going\s+to\s+sleep|time\s+to\s+sleep|bed\s*time)[\s!.,]*$/i;
    if (msg.text && msg.text.trim().split(/\s+/).length <= 4 && BED_SUFFIX.test(msg.text.trim()) && !earlyIntents.includes('BED')) {
      earlyIntents = [...earlyIntents, 'BED'];
    }
    if (isWakeTrigger(msg) && !earlyIntents.includes('WAKE')) {
      earlyIntents = [...earlyIntents, 'WAKE'];
    }
    const isWake = earlyIntents.includes('WAKE');
    const isBed  = earlyIntents.includes('BED');

    // ── bed_plans state ───────────────────────────────────────────────────────
    if (pendingStates.has(chatId)) {
      const state = pendingStates.get(chatId);

      if (isPendingStateExpired(state)) {
        pendingStates.delete(chatId);
        // fall through to wake detection / normal routing
      } else if (isCancelMessage(msg.text)) {
        pendingStates.delete(chatId);
        await bot.sendMessage(chatId, 'cancelled.');
        return;
      } else if (state.type === 'bed_plans') {
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
            setPendingState(chatId, { type: 'bed_plans', pushback_sent: true });
            return;
          }

          if (earlyIntents.includes('COACH_QUESTION') && !earlyIntents.some(i => ['PLAN','MEAL_LOG','WORKOUT_LOG','RECOVERY_LOG'].includes(i))) {
            await handleAsk(bot, msg, '', earlyIntents);
            return;
          }

          const isDone = earlyIntents.includes('GENERAL') && !earlyIntents.some(i => ['PLAN','MEAL_LOG','WORKOUT_LOG','RECOVERY_LOG'].includes(i))
            && await claude.isDoneIntent(msg.text);

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
            setPendingState(chatId, { type: 'bed_plans', pushback_sent: true });
          } else {
            await bot.sendMessage(chatId, 'good night.');
          }
          return;
        }
      }
    }

    // ── Wake detection ────────────────────────────────────────────────────────
    if (isWake && (userState.status === 'sleeping' || userState.status === 'awake')) {
      pendingStates.delete(chatId);
      const isMonday = new Date(Date.now() + getOffsetMs(userState.timezone)).getUTCDay() === 1;
      db.setState(chatId, { bed_nudge_sent: 0, weekly_waiting_weight: isMonday ? 1 : 0 });
      const rawWakeOverride = extractTimeMs(msg.text, userState.timezone);
      const wakeOverride = (rawWakeOverride && rawWakeOverride <= Date.now()) ? rawWakeOverride : null;
      const wakeData = await day.handleMorningWake(bot, chatId, userState, wakeOverride);
      setPendingState(chatId, { type: 'morning_quality', wakeData, pendingMsg: msg, pendingIntents: earlyIntents });
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

      if (isPendingStateExpired(state)) {
        pendingStates.delete(chatId);
        // fall through to routeMessage
      } else if (isCancelMessage(msg.text)) {
        pendingStates.delete(chatId);
        await bot.sendMessage(chatId, 'cancelled.');
        return;
      } else {

      if (state.type === 'morning_quality') {
        const quality = parseQuality(msg.text || '');
        if (!quality) {
          const attempts = bumpAttempts(chatId);
          if (attempts >= STATE_MAX_ATTEMPTS) {
            pendingStates.delete(chatId);
            await bot.sendMessage(chatId, 'skipping sleep quality. you can log it later.');
            await routeMessage(bot, msg, chatId, db.getState(chatId), earlyIntents);
            return;
          }
          await bot.sendMessage(chatId, "quality? (1-5, or 'cancel' to skip)");
          return;
        }
        pendingStates.delete(chatId);
        if (!state.wakeData.hasBed) {
          // No bed time recorded — ask before logging sleep
          await bot.sendMessage(chatId, 'what time did you fall asleep?');
          setPendingState(chatId, { type: 'morning_bed_time', quality, wakeData: state.wakeData, pendingMsg: state.pendingMsg, pendingIntents: state.pendingIntents });
          return;
        }
        await day.processQuality(bot, chatId, quality, state.wakeData);
        cronSvc.scheduleUntimedRemindersForUser(chatId, state.wakeData.newDayStart);
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
          let bedMs = extractTimeMs(msg.text, db.getState(chatId).timezone);
          if (bedMs) {
            // If parsed bed time is after wake time, it's from the previous day
            if (bedMs > wakeData.newDayStart) bedMs -= 24 * 3600 * 1000;
            wakeData = { ...wakeData, hasBed: true, bedMs };
            const sleepMs = Math.max(0, wakeData.newDayStart - bedMs - 20 * 60 * 1000);
            wakeData.sleepH = Math.round(sleepMs / 3600000 * 10) / 10;
          }
        }
        pendingStates.delete(chatId);
        await day.processQuality(bot, chatId, state.quality, wakeData);
        cronSvc.scheduleUntimedRemindersForUser(chatId, wakeData.newDayStart);
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

      if (state.type === 'photo_clarification') {
        pendingStates.delete(chatId);
        const reply = (msg.text || '').toLowerCase();
        if (reply.includes('log') || reply.includes('meal') || reply.includes('yes')) {
          const data = await showMealPreview(bot, state.originalMsg, state.photos);
          if (data) setPendingState(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart });
        } else {
          await handlePhotoQuestion(bot, state.originalMsg, state.photos[0]);
        }
        return;
      }

      if (state.type === 'live_workout') {
        const text = (msg.text || '').trim();
        const isDone = await claude.isDoneIntent(text);

        if (isDone && state.exercises.length === 0) {
          pendingStates.delete(chatId);
          await bot.sendMessage(chatId, 'no exercises logged. cancelled.');
          return;
        }

        if (isDone) {
          pendingStates.delete(chatId);
          const durationMin = Math.round((Date.now() - state.startTime) / 60000);
          const workoutData = {
            workout_name: 'Gym',
            activity_type: 'weights',
            duration_min: durationMin || null,
            exercises: state.exercises,
          };
          workoutData.calories_burned = computeWorkoutCalories(chatId, workoutData);
          const preview = formatWorkoutPreview(workoutData);
          await bot.sendMessage(chatId, preview);
          setPendingState(chatId, { type: 'workout_confirm', workoutData });
          return;
        }

        // Try to parse as exercise
        try {
          await bot.sendChatAction(chatId, 'typing');
          const parsed = await claude.parseLiveExercise(text);
          if (parsed?.name) {
            state.exercises.push(parsed);
            const line = formatExerciseLine(parsed).trim();
            await bot.sendMessage(chatId, `${line} ✅\nnext exercise, or 'finished' to wrap up`);
          } else {
            await bot.sendMessage(chatId, "didn't catch that — try: 'bench press 3x10 100kg'");
          }
        } catch {
          await bot.sendMessage(chatId, "didn't catch that — try: 'bench press 3x10 100kg'");
        }
        return;
      }

      if (state.type === 'workout_confirm') {
        const text = msg.text || '';
        const isWorkoutCancel = await claude.isDeclineIntent(text);

        const finishWorkout = async (log) => {
          pendingStates.delete(chatId);
          if (log) await logWorkout(bot, chatId, state.workoutData, userState.current_day_start);
          else     await bot.sendMessage(chatId, '❌ Cancelled.');
          // Process queued meal if any
          if (state.queuedMealMsg) {
            const retroDate = state.queuedMealMsg._retroDate;
            const data = await showMealPreview(bot, state.queuedMealMsg, null);
            if (!data) {
              setPendingState(chatId, { type: 'meal_text_clarification', originalText: state.queuedMealMsg.text, dayStart: state.queuedMealDayStart, retroDate: retroDate?.dateStr });
            } else {
              setPendingState(chatId, { type: 'meal_confirm', mealData: data, needsClarification: !!data._needsClarification, dayStart: state.queuedMealDayStart, retroDate: retroDate?.dateStr });
            }
            return;
          }
          if (log && state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            setPendingState(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
        };

        if (isWorkoutCancel) { await finishWorkout(false); return; }

        const isWCorrection = earlyIntents.some(i => ['WORKOUT_LOG','CORRECTION'].includes(i));

        if (!isWCorrection && await claude.isConfirmIntent(text)) { await finishWorkout(true); return; }

        if (isWCorrection) {
          pendingStates.delete(chatId);
          await bot.sendChatAction(chatId, 'typing');
          try {
            const updated = await claude.applyWorkoutCorrection(state.workoutData, text);
            updated.calories_burned = computeWorkoutCalories(chatId, updated);
            await bot.sendMessage(chatId, formatWorkoutPreview(updated));
            setPendingState(chatId, { ...state, type: 'workout_confirm', workoutData: updated });
          } catch {
            await bot.sendMessage(chatId, '❌ Could not apply correction.');
          }
          return;
        }

        if (earlyIntents.includes('COACH_QUESTION')) {
          await handleAsk(bot, msg, `Workout being reviewed:\n${formatWorkoutPreview(state.workoutData)}`, earlyIntents);
          return;
        }

        // New log item arrived while workout pending → queue it, don't auto-log
        const LOG_INTENTS_Q = new Set(['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','WEIGHT_LOG','PLAN']);
        if (earlyIntents.some(i => LOG_INTENTS_Q.has(i))) {
          if (!state.queuedMealMsg && earlyIntents.some(i => MEAL_SET.has(i))) {
            setPendingState(chatId, { ...state, queuedMealMsg: msg, queuedMealDayStart: userState.current_day_start });
          }
          await bot.sendMessage(chatId, formatWorkoutPreview(state.workoutData));
          return;
        }

        // Unrecognised — show preview again
        await bot.sendMessage(chatId, formatWorkoutPreview(state.workoutData));
        return;
      }

      if (state.type === 'meal_photo_clarification') {
        // COACH_QUESTION escape — user is asking about the stored photo, not describing food
        const isPhotoQuestion = earlyIntents.includes('COACH_QUESTION') && !earlyIntents.some(i => i === 'MEAL_LOG' || i === 'DRINK_LOG');
        if (isPhotoQuestion) {
          pendingStates.delete(chatId);
          await handlePhotoQuestion(bot, { ...msg, caption: msg.text }, state.photo);
          return;
        }
        pendingStates.delete(chatId);
        const fakeMsg = { ...msg, caption: `${state.caption}. ${msg.text || ''}`, text: undefined };
        const data = await showMealPreview(bot, fakeMsg, state.photo);
        if (data) setPendingState(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart });
        else setPendingState(chatId, { type: 'meal_photo_clarification', caption: fakeMsg.caption, photo: state.photo, dayStart: state.dayStart });
        return;
      }

      if (state.type === 'meal_text_clarification') {
        pendingStates.delete(chatId);
        const combinedText = `${state.originalText}. ${msg.text || ''}`;
        const fakeMsg = { ...msg, text: combinedText, caption: undefined };
        const data = await showMealPreview(bot, fakeMsg, null);
        if (data) setPendingState(chatId, { type: 'meal_confirm', mealData: data, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
        else setPendingState(chatId, { type: 'meal_text_clarification', originalText: combinedText, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
        return;
      }

      if (state.type === 'meal_confirm') {
        const text = msg.text || '';
        const mealData = state.retroDate ? { ...state.mealData, date: state.retroDate } : state.mealData;

        const isExplicitCancel = await claude.isDeclineIntent(text);
        if (isExplicitCancel) {
          pendingStates.delete(chatId);
          await bot.sendMessage(chatId, '❌ Cancelled. Nothing logged.');
          if (state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            setPendingState(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
          return;
        }

        const isCorrectionIntent = earlyIntents.some(i => ['MEAL_LOG','DRINK_LOG','CORRECTION'].includes(i));

        const isConfirmed = await claude.isConfirmIntent(text);
        if (isConfirmed && !isCorrectionIntent) {
          if (state.needsClarification) {
            // Show the preview so user sees what's being logged, then await final confirm
            setPendingState(chatId, { ...state, needsClarification: false });
            await bot.sendMessage(chatId, formatPreview(mealData));
            return;
          }
          pendingStates.delete(chatId);
          await logMeal(bot, chatId, mealData, state.dayStart);
          if (state.catchupRetro) {
            await bot.sendMessage(chatId, 'anything else? (or done)');
            setPendingState(chatId, { type: 'catchup_log', ...state.catchupRetro });
          }
          return;
        }

        // Correction → apply and loop
        if (isCorrectionIntent) {
          pendingStates.delete(chatId);
          const updated = await applyCorrection(bot, chatId, mealData, text);
          if (!updated) return;
          await bot.sendMessage(chatId, formatPreview(updated));
          setPendingState(chatId, { type: 'meal_confirm', mealData: updated, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
          return;
        }

        // Question → answer with meal context, keep pending state so next reply still confirms/cancels
        if (earlyIntents.includes('COACH_QUESTION')) {
          await handleAsk(bot, msg, `Meal being reviewed:\n${formatPreview(mealData)}`, earlyIntents);
          return;
        }

        // Anything else while reviewing a meal → treat as correction, not silent log
        {
          const updated = await applyCorrection(bot, chatId, mealData, text);
          if (!updated) return;
          await bot.sendMessage(chatId, formatPreview(updated));
          setPendingState(chatId, { type: 'meal_confirm', mealData: updated, dayStart: state.dayStart, retroDate: state.retroDate, catchupRetro: state.catchupRetro });
        }
        return;
      }

      if (state.type === 'catchup_log') {
        const isDone = await claude.isDoneIntent(msg.text || '');
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
          setPendingState(chatId, { ...curState, catchupRetro });
        } else if (!pendingStates.has(chatId)) {
          // Immediate log (workout/recovery/sleep), ask for more
          await bot.sendMessage(chatId, 'anything else? (or done)');
          setPendingState(chatId, { type: 'catchup_log', ...catchupRetro });
        }
        return;
      }

      if (state.type === 'weekly_target_suggest') {
        const isPositive = await claude.isPositiveResponse(msg.text || '').catch(() => false);
        if (isPositive) {
          pendingStates.delete(chatId);
          await handleUpdateTargets(bot, msg, chatId);
        } else {
          pendingStates.delete(chatId);
          await routeMessage(bot, msg, chatId, userState, earlyIntents);
        }
        return;
      }

      // today_list: fall through
      } // end cancel/timeout else

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
    const current = db.getTargets(chatId);
    // Include the last coach message as context so "yes" can resolve to the numbers just suggested
    const state = db.getState(chatId);
    let lastCoachMsg = '';
    try {
      const ctx = state.last_coach_context ? JSON.parse(state.last_coach_context) : null;
      if (ctx?.message) lastCoachMsg = `\n\nPrevious coach message (may contain suggested values):\n${ctx.message}`;
    } catch {}
    const instruction = (msg.text || '') + lastCoachMsg;
    const newTargets = await claude.recalculateTargets(current, instruction);
    if (!newTargets || !newTargets.calories) {
      // No specific numbers — let the coach handle it
      const { handleAsk } = require('./handlers/ask');
      await handleAsk(bot, msg);
      return;
    }
    await db.updateTargets(chatId, newTargets);
    await bot.sendMessage(chatId,
      `✅ targets updated:\n${newTargets.calories} kcal · ${newTargets.protein}g P · ${newTargets.carbs}g C · ${newTargets.fat}g F`
    );
  } catch (err) {
    console.error('Update targets error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ── Cancel reminder (keep plan) ───────────────────────────────────────────────

async function handleCancelReminder(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    const pending = db.getAllPending(chatId);
    if (!pending.length) { await bot.sendMessage(chatId, 'No upcoming plans found.'); return; }
    const plan = await claude.matchPlanToModify(msg.text, pending);
    db.cancelPlanReminders(chatId, plan.id);
    await bot.sendMessage(chatId, `Got it — reminder cancelled for ${plan.plan_text}. Plan is still on your list.`);
  } catch (err) {
    console.error('Cancel reminder error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

// ── Timezone change ────────────────────────────────────────────────────────────

const TIMEZONE_MAP = {
  'kuala lumpur': 'Asia/Kuala_Lumpur', 'kl': 'Asia/Kuala_Lumpur', 'malaysia': 'Asia/Kuala_Lumpur',
  'singapore': 'Asia/Singapore', 'jakarta': 'Asia/Jakarta', 'bangkok': 'Asia/Bangkok',
  'moscow': 'Europe/Moscow', 'москва': 'Europe/Moscow', 'russia': 'Europe/Moscow',
  'london': 'Europe/London', 'paris': 'Europe/Paris', 'berlin': 'Europe/Berlin',
  'new york': 'America/New_York', 'los angeles': 'America/Los_Angeles',
  'dubai': 'Asia/Dubai', 'hong kong': 'Asia/Hong_Kong', 'tokyo': 'Asia/Tokyo',
  'seoul': 'Asia/Seoul', 'sydney': 'Australia/Sydney',
};

function parseTzFromText(text) {
  const lc = text.toLowerCase();
  // Try named city
  const named = TIMEZONE_MAP[lc] || TIMEZONE_MAP[Object.keys(TIMEZONE_MAP).find(k => lc.includes(k))];
  if (named) return named;
  // Try UTC±N
  const utcMatch = lc.match(/utc\s*([+-])\s*(\d{1,2})(?::(\d{2}))?/);
  if (utcMatch) {
    const sign = utcMatch[1] === '+' ? 1 : -1;
    const h = parseInt(utcMatch[2]);
    const m = parseInt(utcMatch[3] || '0');
    const offsetMin = sign * (h * 60 + m);
    // Map common offsets to IANA zones
    const offsetMap = { '-480': 'America/Los_Angeles', '-300': 'America/New_York', 0: 'Europe/London', 60: 'Europe/Paris', 180: 'Europe/Moscow', 300: 'Asia/Dubai', 330: 'Asia/Kolkata', 420: 'Asia/Bangkok', 480: 'Asia/Kuala_Lumpur', 540: 'Asia/Tokyo', 600: 'Australia/Sydney' };
    return offsetMap[String(offsetMin)] || `Etc/GMT${sign > 0 ? '-' : '+'}${h}`; // Etc/GMT sign is inverted
  }
  return null;
}

async function handleTimezoneChange(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  const tz = parseTzFromText(msg.text || '');
  if (!tz) { await bot.sendMessage(chatId, "Couldn't identify the timezone. Try: \"set timezone to Moscow\" or \"UTC+3\"."); return; }
  db.setState(chatId, { timezone: tz });
  // Wipe and reschedule reminders with new offset
  db.deleteUnfiredReminders(chatId);
  const { scheduleTimedPlanReminders } = require('./handlers/plans');
  const offsetMs = getOffsetMs(tz);
  const today = getDateStrTz(tz);
  const tomorrow = new Date(Date.now() + offsetMs + 86400000).toISOString().split('T')[0];
  for (const dateStr of [today, tomorrow]) {
    for (const plan of db.getPendingTimed(chatId, dateStr)) {
      scheduleTimedPlanReminders(chatId, plan.id, { title: plan.plan_text, date: plan.plan_date, time: plan.plan_time });
    }
  }
  const sign = offsetMs >= 0 ? '+' : '-';
  const hrs = Math.abs(Math.round(offsetMs / 3600000));
  await bot.sendMessage(chatId, `Timezone set to ${tz} (UTC${sign}${hrs}). Reminders rescheduled.`);
}

// ── Weekly review flow ────────────────────────────────────────────────────────

async function handleWeeklyReviewFlow(bot, msg, chatId) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    await handleBody(bot, msg);

    const state = db.getState(chatId);
    const weekData = db.getWeeklyReviewData(chatId, state.current_day_start);
    const targetsCtx = db.getTargetsText(chatId);
    const targets    = db.getTargets(chatId);

    const review = await claude.generateWeeklyReview(weekData, targetsCtx, state, targets);
    const sent = await bot.sendMessage(chatId, review);

    db.setState(chatId, {
      last_coach_message_id: sent.message_id,
      last_coach_context: JSON.stringify({ message: review, context: '', timestamp: Date.now() }),
    });
    db.saveCoachMessage(chatId, 'assistant', review, sent.message_id);
    // If review suggested target changes, flag so next reply can apply them
    if (/want me to update|apply.*target|update.*target/i.test(review)) {
      setPendingState(chatId, { type: 'weekly_target_suggest' });
    }

    // Weekly strength summary (fire-and-forget)
    try {
      const recentWorkouts = db.getRecentWorkouts(chatId, 28);
      if (recentWorkouts.length >= 2) {
        const state = db.getState(chatId);
        const { buildStrengthSummaryBlock } = require('./handlers/workout');
        const strengthBlock = buildStrengthSummaryBlock(recentWorkouts);
        const strengthSummary = await claude.generateWeeklyStrengthSummary(strengthBlock, state);
        if (strengthSummary) await bot.sendMessage(chatId, strengthSummary);
      }
    } catch (err) { console.error('Weekly strength summary error:', err.message); }
  } catch (err) {
    console.error('Weekly review flow error:', err.message);
  }
}

// ── /today ────────────────────────────────────────────────────────────────────

async function handleToday(bot, chatId, dayStart) {
  const entries = db.getTodayEntriesFromSQLite(chatId, dayStart);
  if (!entries.length) { await bot.sendMessage(chatId, 'Nothing logged today yet.'); return; }
  const lines = ["Today's logs:\n", ...entries.map((e, i) => `${i+1}. [${e.label}] ${e.title}${e.extra ? ` — ${e.extra}` : ''}`)];
  lines.push('\nReply "delete N" to remove an entry.');
  setPendingState(chatId, { type: 'today_list', entries });
  await bot.sendMessage(chatId, lines.join('\n'));
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
