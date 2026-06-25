const claude = require('../claude');
const db     = require('../db');
const { MEAL_PREVIEW_KB } = require('../utils/keyboards');

// B5: instant logging for any food the user repeats verbatim — matches the message against their
// known foods for today (which already scopes day-specific menus and includes day-agnostic repeats
// like a yogurt or smoothie). Returns a known_foods row ONLY on a confident, unambiguous, modifier-free
// match; otherwise null (→ the AI handles it, exactly as today). The preview+confirm is the final check.
// Safety: any ambiguity / modifier / caffeinated drink / novelty → null → no risk of a wrong log.
const _FILLER = new Set(['had','ate','eat','eaten','just','i','a','an','the','for','today','also','and','my','with','of','got','having','have','at','some','ns','lunch','dinner','meal','plate','plates','breakfast','snack','drink','please','log','ok','one']);
const _MODIFIER_RE = /\d|%|\b(half|quarter|without|no|skip|only|less|more|light|didn'?t|instead|minus|extra|plus|bit|grams?|ml|kg)\b/;
const _CAFFEINE_RE = /\b(coffee|espresso|latte|cappuccino|americano|mocha|macchiato|flat white|tea|matcha|chai|energy|red ?bull|cola|coke|monster)\b/;
// distinctive words of a food name: drop [bracket tags] (week/source noise) but KEEP (paren) base words.
const _words = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !_FILLER.has(w));
const _identity = (set) => [...set].sort().join(' ');

function matchKnownMeal(caption, foods) {
  const lc = (caption || '').toLowerCase().trim();
  if (!lc || _MODIFIER_RE.test(lc)) return null; // quantity / partial / exclusion → AI recomputes
  const msg = _words(lc);
  if (!msg.length) return null;
  const msgSet = new Set(msg);
  // candidates: foods whose distinctive words contain all the message words (exact, or a ≥2-word subset)
  const cand = [];
  for (const f of foods) {
    if (_CAFFEINE_RE.test((f.name || '').toLowerCase())) continue; // caffeine isn't stored → let the AI handle it
    const fw = new Set(_words(f.name));
    if (!fw.size || !msg.every(w => fw.has(w))) continue;
    if (fw.size === msgSet.size || msg.length >= 2) cand.push({ f, id: _identity(fw) });
  }
  if (!cand.length) return null;
  // Scope to TODAY'S menu when this is a menu reference: getKnownFoodsForDay already filtered day-tagged
  // items to today, so day-tagged candidates ARE today's menu. Auto-saved copies (day-agnostic, possibly
  // stale from another day) must not create false ambiguity against today's menu — drop them when a
  // today-menu candidate exists. Pure repeat foods (no menu tag, e.g. a yogurt) are unaffected.
  const isMenu = c => /lunch|dinner|week/i.test(c.f.notes || '');
  const eff = cand.some(isMenu) ? cand.filter(isMenu) : cand;
  // One dish identity = unambiguous → win. Multiple = a genuine fork (Soba vs Sweet Potato, Regular vs
  // Double, or two different dishes on today's menu) → defer to the AI.
  if (new Set(eff.map(c => c.id)).size !== 1) return null;
  return (eff.find(isMenu) || eff[0]).f;
}
const { getDayOfWeekTz, nowContextTz, requireTimezone } = require('../utils/time');
const { getCurrentWeekType } = require('../utils/weekTracker');

function formatPreview(data) {
  const header = data._hasPhoto ? '📷 looks like:' : '🍽 my estimate:';
  const lines = [`${header} ${data.meal_name}\n`];

  for (const item of (data.items || [])) {
    const g = item.weight_g ? ` (${item.weight_g}g)` : '';
    lines.push(`  ${item.name}${g} — ${item.calories} kcal · ${item.protein}g P · ${item.carbs}g C · ${item.fat}g F`);
  }

  lines.push('');
  lines.push(`📊 ${Math.round(data.totals.calories)} kcal · ${Math.round(data.totals.protein)}g P · ${Math.round(data.totals.carbs)}g C · ${Math.round(data.totals.fat)}g F`);
  if ((data.caffeine_mg ?? 0) > 0) lines.push(`☕ ${data.caffeine_mg}mg caffeine`);
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

function progressBar(actual, target, width = 6) {
  const fill = Math.min(width, Math.max(0, Math.round((actual / target) * width)));
  return '█'.repeat(fill) + '░'.repeat(width - fill);
}

function remainLabel(left, unit, warn = true) {
  return left >= 0 ? `${left}${unit} left` : `${Math.abs(left)}${unit} over${warn ? ' ⚠️' : ''}`;
}

function formatConfirmation(data, totals, targets) {
  const T = targets;
  const m = data.totals;

  const retroLabel = data.date ? ` (${data.date})` : '';
  const mealMacros = `${Math.round(m.calories)} kcal · ${Math.round(m.protein)}g P · ${Math.round(m.carbs ?? 0)}g C · ${Math.round(m.fat ?? 0)}g F`;
  const lines = [`✅ ${data.meal_name}${retroLabel} — ${mealMacros}`];
  if ((data.caffeine_mg ?? 0) > 0) lines[0] += ` · ☕ ${data.caffeine_mg}mg`;

  if (totals && !data.date) {
    const cal  = Math.round(totals.calories ?? 0);
    const prot = Math.round(totals.protein  ?? 0);
    const carb = Math.round(totals.carbs    ?? 0);
    const fat  = Math.round(totals.fat      ?? 0);
    lines.push('');
    lines.push(`kcal ${progressBar(cal,  T.calories)} ${cal} / ${T.calories}   ${remainLabel(T.calories - cal,  '')}`);
    lines.push(`P    ${progressBar(prot, T.protein)}  ${prot} / ${T.protein}g  ${remainLabel(T.protein - prot, 'g', false)}`);
    lines.push(`C    ${progressBar(carb, T.carbs)}  ${carb} / ${T.carbs}g  ${remainLabel(T.carbs - carb, 'g')}`);
    lines.push(`F    ${progressBar(fat,  T.fat)}  ${fat} / ${T.fat}g  ${remainLabel(T.fat - fat, 'g')}`);
  }
  return lines.join('\n');
}

async function showMealPreview(bot, msg, photos) {
  const chatId    = msg.chat.id;
  const photoList = Array.isArray(photos) ? photos : (photos ? [photos] : []);
  const hasPhoto  = photoList.length > 0;
  await bot.sendChatAction(chatId, 'typing');

  try {
    const caption = msg.caption || msg.text || '';
    const userState = db.getState(chatId);
    const tz        = requireTimezone(userState);
    const dayOfWeek = getDayOfWeekTz(tz);
    const weekType  = getCurrentWeekType(tz);
    let knownFoodsCtx = '';
    try { knownFoodsCtx = db.getKnownFoodsContext(chatId, dayOfWeek, weekType); } catch {}

    const institutionKeywords = userState?.institution_keywords || null;

    // B5: skip the AI when the message resolves to exactly one of the user's known foods (text-only).
    if (!hasPhoto && caption) {
      try {
        const m = matchKnownMeal(caption, db.getKnownFoodsForDay(chatId, dayOfWeek, weekType));
        if (m) {
          const t = { calories: Math.round(m.calories), protein: Math.round(m.protein), carbs: Math.round(m.carbs), fat: Math.round(m.fat) };
          const data = { meal_name: m.name, _hasPhoto: false, items: [{ name: m.name, ...t }], totals: t, caffeine_mg: 0, confidence: 'high', _fromKnownFood: true };
          await bot.sendMessage(chatId, formatPreview(data), MEAL_PREVIEW_KB);
          return data;
        }
      } catch (e) { console.error('Known-meal match error:', e.message); /* fall through to AI */ }
    }

    let captionWithCtx = caption;
    if (userState?.current_chain_id) {
      const chain = db.getReplyChain(chatId, userState.current_chain_id);
      const lastBot = chain.filter(m => m.role === 'assistant').slice(-1)[0];
      if (lastBot) captionWithCtx = `${caption}\n\n[Recent coach context: ${lastBot.content.slice(0, 300)}]`;
    }

    let data;
    try {
      data = await claude.analyzeMeal(photoList, captionWithCtx, dayOfWeek, knownFoodsCtx, nowContextTz(tz), institutionKeywords);
    } catch (err) {
      if (err.status === 529 || err.message?.startsWith('529')) {
        await new Promise(r => setTimeout(r, 8000));
        await bot.sendChatAction(chatId, 'typing');
        data = await claude.analyzeMeal(photoList, captionWithCtx, dayOfWeek, knownFoodsCtx, nowContextTz(tz), institutionKeywords);
      } else {
        throw err;
      }
    }

    if (data.confidence === 'low' && data.clarification) {
      await bot.sendMessage(chatId, `🤔 ${data.clarification}`);
      data._needsClarification = true;
      return data;
    }

    await bot.sendMessage(chatId, formatPreview(data), MEAL_PREVIEW_KB);
    return data;
  } catch (err) {
    console.error('Meal preview error:', err.message, err.stack);
    const msg529 = err.status === 529 || err.message?.startsWith('529');
    await bot.sendMessage(chatId, msg529 ? "API is overloaded right now, try again in a moment." : `❌ ${err.message}`);
    return null;
  }
}

async function logMeal(bot, chatId, data, dayStart) {
  try {
    // Always write to SQLite first — this is the source of truth
    const mealId = db.saveMealLog(chatId, data, dayStart);

    const caffeineMg = data.caffeine_mg ?? 0;
    if (caffeineMg > 0) db.addCaffeine(chatId, caffeineMg);
    if (!data.date) { try { db.addKnownFood(chatId, data); } catch {} }

    let totals  = null;
    let targets = null;
    try { totals  = db.getDailyMealTotalsFromSQLite(chatId, dayStart); } catch {}
    try { targets = db.getTargets(chatId); } catch {}

    const sent = await bot.sendMessage(chatId, formatConfirmation(data, totals, targets));
    db.setLogBotMessageId('meal_log', mealId, sent.message_id);
  } catch (err) {
    console.error('Meal log error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }
}

async function applyCorrection(bot, chatId, existingData, correctionText) {
  await bot.sendChatAction(chatId, 'typing');
  try {
    return await claude.applyMealCorrection(existingData, correctionText);
  } catch (err) {
    console.error('Correction error:', err.message, err.stack);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
    return null;
  }
}

module.exports = { showMealPreview, logMeal, applyCorrection, formatPreview, formatConfirmation, matchKnownMeal };
