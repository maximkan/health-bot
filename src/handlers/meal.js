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
// Strip internal [bracket] tags (day/week/source markers) from a known-food name for user-facing display.
const cleanFoodName = (s) => String(s || '').replace(/\s*\[[^\]]*\]/g, '').replace(/\s{2,}/g, ' ').trim();

function matchKnownMeal(caption, foods) {
  const lc = (caption || '').toLowerCase().trim();
  if (!lc || _MODIFIER_RE.test(lc)) return null; // quantity / partial / exclusion → AI recomputes
  const msg = _words(lc);
  if (!msg.length) return null;
  const msgSet = new Set(msg);
  // candidates: foods whose distinctive words contain all the message words (exact, or a ≥2-word subset)
  const cand = [];
  for (const f of foods) {
    if (f.place) continue; // #3 — venue-specific variant: a plain mention must offer the place picker, not silently pick one venue
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

const _placeLabel = (p) => (p && !/^home$/i.test(p)) ? `  📍 ${p}` : (/^home$/i.test(p || '') ? '  🏠 Home' : '');
function formatPreview(data) {
  const header = data._hasPhoto ? '📷 looks like:' : '🍽 my estimate:';
  const lines = [`${header} ${data.meal_name}\n`];

  for (const item of (data.items || [])) {
    const g = item.weight_g ? ` (${item.weight_g}g)` : '';
    // defensive: drop a weight the model may have baked into the name so it isn't shown twice ("(200g) (200g)")
    const nm = item.weight_g ? String(item.name || '').replace(/\s*\(\s*\d+\s*g\s*\)\s*$/i, '').trim() : item.name;
    lines.push(`  ${nm}${g} — ${item.calories} kcal · ${item.protein}g P · ${item.carbs}g C · ${item.fat}g F${_placeLabel(item.place)}`);
  }

  lines.push('');
  lines.push(`📊 ${Math.round(data.totals.calories)} kcal · ${Math.round(data.totals.protein)}g P · ${Math.round(data.totals.carbs)}g C · ${Math.round(data.totals.fat)}g F`);
  if ((data.caffeine_mg ?? 0) > 0) lines.push(`☕ ${data.caffeine_mg}mg caffeine`);
  lines.push('');
  lines.push('ok to log, or tell me what to fix');
  return lines.join('\n');
}

const _MEAL_ACTION_ROW = [
  { text: '✅ Log', callback_data: 'mc:log' }, { text: '✏️ Edit', callback_data: 'mc:edit' }, { text: '❌ Cancel', callback_data: 'mc:cancel' },
];
// #3 resolver — an item still needs placing if the AI flagged it needs_place and it isn't resolved yet.
// NS/institution & generic items are place_state:'n/a' → never asked (this structurally kills the
// NS-Caesar picker bug). 'resolved' (has a venue/Home) and 'estimated' (user tapped 🤖 Estimate) are done.
function unplacedItems(data) {
  const items = data.items || [];
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.place_state === 'needs_place' && !it.place) out.push(i);
  }
  return out;
}
function firstAskableItem(data) {
  const u = unplacedItems(data);
  return u.length ? u[0] : -1;
}
function placeKeyboardForItem(chatId, data, i) {
  const it = data.items[i];
  let vs = []; try { vs = db.getPlaceVariants(chatId, it.name); } catch {}
  it._placeVariants = vs;
  const rows = [];
  const vb = vs.slice(0, 4).map((v, vi) => ({ text: `📍 ${v.place}`, callback_data: `pl:item:${i}:pick:${vi}` }));
  for (let k = 0; k < vb.length; k += 2) rows.push(vb.slice(k, k + 2));
  rows.push([
    { text: '🏠 Home',      callback_data: `pl:item:${i}:home` },
    { text: '🆕 New place', callback_data: `pl:item:${i}:new` },
    { text: '🤖 Estimate',  callback_data: `pl:item:${i}:est` },
  ]);
  rows.push(_MEAL_ACTION_ROW);
  return { reply_markup: { inline_keyboard: rows } };
}
// Phase 3 — batch shortcut: when ≥2 dishes still need a place, offer "all from the same place?" first,
// surfacing venues where the user has had ALL of them (combo). 'Set each' drops to the per-item resolver.
function renderBatchStep(chatId, data, unplaced) {
  const names = unplaced.map(i => data.items[i].name);
  let shared = []; try { shared = db.getComboVenues(chatId, names); } catch {}
  data._batchVenues = shared;
  const rows = [];
  const vb = shared.slice(0, 4).map((p, vi) => ({ text: `📍 ${p}`, callback_data: `pl:all:pick:${vi}` }));
  for (let k = 0; k < vb.length; k += 2) rows.push(vb.slice(k, k + 2));
  rows.push([
    { text: '🏠 Home',      callback_data: 'pl:all:home' },
    { text: '🆕 New place', callback_data: 'pl:all:new' },
    { text: '✳️ Set each',  callback_data: 'pl:all:each' },
  ]);
  rows.push(_MEAL_ACTION_ROW);
  const list = names.map(n => n.toLowerCase()).join(' + ');
  return { text: `${formatPreview(data)}\n📍 ${list} — all from the same place?`, keyboard: { reply_markup: { inline_keyboard: rows } } };
}
// One resolver step: batch prompt for ≥2 unplaced dishes, else ask the first unplaced one, else show the
// normal Log/Edit/Cancel preview. ✅ Log at any time estimates the rest.
function renderMealStep(chatId, data) {
  const unplaced = unplacedItems(data);
  if (unplaced.length === 0) return { text: formatPreview(data), keyboard: { reply_markup: { inline_keyboard: [_MEAL_ACTION_ROW] } } };
  if (unplaced.length >= 2 && !data._setEach) return renderBatchStep(chatId, data, unplaced);
  const i = unplaced[0];
  const it = data.items[i];
  return { text: `${formatPreview(data)}\n📍 where's the ${it.name.toLowerCase()} from?`, keyboard: placeKeyboardForItem(chatId, data, i) };
}
// Assign a venue to one item — swapping in that venue's saved macros if we have them, else just tagging.
function applyVenueToItem(chatId, data, i, venue) {
  const it = (data.items || [])[i];
  if (!it) return;
  let v = null;
  try { v = db.getPlaceVariants(chatId, it.name).find(x => x.place?.toLowerCase() === venue.toLowerCase()); } catch {}
  if (v) applyItemVariant(data, i, v);
  else { it.place = venue; it.place_state = 'resolved'; resumTotals(data); }
}

// Carry resolved per-item places across a correction (match by normalized name) so a portion fix
// doesn't wipe a venue the user already chose.
function carryPlaces(oldData, newData) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map((oldData?.items || []).filter(i => i.place || i.place_state).map(i => [norm(i.name), i]));
  for (const it of (newData?.items || [])) {
    const o = byName.get(norm(it.name));
    if (o) { if (o.place) it.place = o.place; if (o.place_state) it.place_state = o.place_state; }
  }
  return newData;
}

// Re-sum the meal totals from its items (after a per-item macro swap).
function resumTotals(data) {
  const t = { calories: 0, protein: 0, carbs: 0, fat: 0 };
  for (const it of (data.items || [])) { t.calories += it.calories || 0; t.protein += it.protein || 0; t.carbs += it.carbs || 0; t.fat += it.fat || 0; }
  data.totals = { calories: Math.round(t.calories), protein: Math.round(t.protein), carbs: Math.round(t.carbs), fat: Math.round(t.fat) };
}
// Swap ONE item's macros to a saved place-variant (replaces the old whole-meal-collapsing applyPlaceVariant).
function applyItemVariant(data, itemIdx, v) {
  const it = (data.items || [])[itemIdx];
  if (!it) return;
  it.calories = Math.round(v.calories); it.protein = Math.round(v.protein); it.carbs = Math.round(v.carbs); it.fat = Math.round(v.fat);
  it.place = v.place; it.place_state = 'resolved';
  resumTotals(data);
}
// For items the user already placed (stated a venue), use that venue's saved macros if we have them.
function applyResolvedPlaces(chatId, data) {
  for (const it of (data.items || [])) {
    if (it.place_state !== 'resolved' || !it.place || /^home$/i.test(it.place)) continue;
    try {
      const v = db.getPlaceVariants(chatId, it.name).find(x => x.place?.toLowerCase() === it.place.toLowerCase());
      if (v) { it.calories = Math.round(v.calories); it.protein = Math.round(v.protein); it.carbs = Math.round(v.carbs); it.fat = Math.round(v.fat); }
    } catch {}
  }
  resumTotals(data);
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
          const name = cleanFoodName(m.name); // hide internal [Odd Week]/[Dinner Tue] day markers from the user
          // B5 match = a known repeat food (generic / institution) → no place question (items lack needs_place).
          const data = { meal_name: name, _hasPhoto: false, items: [{ name, ...t }], totals: t, caffeine_mg: 0, confidence: 'high', _fromKnownFood: true };
          const step = renderMealStep(chatId, data);
          await bot.sendMessage(chatId, step.text, step.keyboard);
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

    // A low-confidence meal only BLOCKS with a question when it's genuinely unloggable (no usable
    // estimate). If the meal already has a real estimate, never block — show the preview + Log/Edit/
    // Cancel and demote the clarification to a one-line hint, so the user just taps (Edit if off).
    const loggable = (data.items || []).length > 0 && (data.totals?.calories ?? 0) > 0;
    if (data.confidence === 'low' && data.clarification && !loggable) {
      await bot.sendMessage(chatId, `🤔 ${data.clarification}`);
      data._needsClarification = true;
      return data;
    }
    const hint = (data.confidence === 'low' && data.clarification) ? `ⓘ ${data.clarification}\n\n` : '';

    // #3 — for items the user already named a venue for, use that venue's saved macros if we have them.
    applyResolvedPlaces(chatId, data);
    const step = renderMealStep(chatId, data);
    await bot.sendMessage(chatId, hint + step.text, step.keyboard);
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
    // #3 — per item: remember each placed dish's macros for its venue, and tag the meal's place
    // (one venue → that venue; multiple → "mixed"). Only real, user-confirmed venues are saved.
    try {
      for (const it of (data.items || [])) {
        if (it.place && !/^home$/i.test(it.place)) db.savePlaceVariant(chatId, it.name, it.place, it);
      }
      const places = [...new Set((data.items || []).map(it => it.place).filter(Boolean))];
      data.place = places.length === 1 ? places[0] : places.length > 1 ? 'mixed' : null;
    } catch {}

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

module.exports = { showMealPreview, logMeal, applyCorrection, formatPreview, formatConfirmation, matchKnownMeal, renderMealStep, placeKeyboardForItem, applyItemVariant, applyVenueToItem, resumTotals, firstAskableItem, unplacedItems, carryPlaces };
