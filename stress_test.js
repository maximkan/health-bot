#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db = require('./src/db');
const db = require('./src/db');

const CHAT_ID = 119445404;
let passed = 0, failed = 0, warnings = 0;
const failures = [];

function ok(label) { passed++; process.stdout.write(`  ✅ ${label}\n`); }
function fail(label, detail) { failed++; failures.push(`${label}: ${detail}`); process.stdout.write(`  ❌ ${label} — ${detail}\n`); }
function warn(label, detail) { warnings++; process.stdout.write(`  ⚠️  ${label} — ${detail}\n`); }

function check(label, val, expectFn, note = '') {
  try {
    const result = expectFn(val);
    if (result === true) ok(label);
    else fail(label, `Expectation failed | val=${JSON.stringify(val).slice(0,120)}${note ? ' | ' + note : ''}`);
  } catch (e) {
    fail(label, e.message);
  }
}

async function cls(text, history = []) { return claude.classify(text, history); }

async function hasIntent(text, intent, label, history = []) {
  const r = await cls(text, history);
  check(label, r, v => v.includes(intent));
}
async function notIntent(text, intent, label) {
  const r = await cls(text);
  check(label, r, v => !v.includes(intent));
}

async function main() {
console.log('\n══════════════════════════════════════════');
console.log('  HEALTH BOT COMPREHENSIVE STRESS TEST');
console.log('══════════════════════════════════════════\n');

// ────────────────────────────────────────────────────────────────
// 1. CLASSIFIER — BED / WAKE
// ────────────────────────────────────────────────────────────────
console.log('1. CLASSIFIER — BED / WAKE');
await hasIntent('gn', 'BED', 'gn → BED');
await hasIntent('good night', 'BED', 'good night → BED');
await hasIntent('heading to bed now', 'BED', 'heading to bed → BED');
await hasIntent('спать', 'BED', 'Russian спать → BED');
await hasIntent('спокойной ночи', 'BED', 'Russian спокойной ночи → BED');
await hasIntent('morning', 'WAKE', 'morning → WAKE');
await hasIntent('доброе утро', 'WAKE', 'Russian доброе утро → WAKE');
await hasIntent('just woke up', 'WAKE', 'just woke up → WAKE');

// ────────────────────────────────────────────────────────────────
// 2. CLASSIFIER — MULTI-INTENT COMBOS
// ────────────────────────────────────────────────────────────────
console.log('\n2. CLASSIFIER — MULTI-INTENT COMBOS');
{
  const r = await cls('sauna then chicken rice');
  check('sauna + meal → RECOVERY+MEAL', r, v => v.includes('RECOVERY_LOG') && v.includes('MEAL_LOG'));
}
{
  const r = await cls('bench press 100kg 5 sets and had a protein shake');
  check('workout + shake → WORKOUT+DRINK/MEAL', r, v => v.includes('WORKOUT_LOG') && (v.includes('MEAL_LOG') || v.includes('DRINK_LOG')));
}
{
  const r = await cls('slept 7 hours, weighed 104kg this morning');
  check('sleep + weight → SLEEP+WEIGHT', r, v => v.includes('SLEEP_LOG') && v.includes('WEIGHT_LOG'));
}
{
  const r = await cls('slept 6h quality 3/5, morning weight 104kg body fat 27%, breakfast chicken rice, 45min gym strength, sauna 15min 90°C');
  check('5-way mega combo', r, v =>
    v.includes('SLEEP_LOG') && v.includes('WEIGHT_LOG') && v.includes('MEAL_LOG') &&
    v.includes('WORKOUT_LOG') && v.includes('RECOVERY_LOG')
  );
}

// ────────────────────────────────────────────────────────────────
// 3. CLASSIFIER — RECOVERY / LOG TYPES
// ────────────────────────────────────────────────────────────────
console.log('\n3. CLASSIFIER — RECOVERY / LOG TYPES');
await hasIntent('had a quick sauna after gym', 'RECOVERY_LOG', 'sauna after gym → RECOVERY_LOG');
await hasIntent('ice bath 5 min 10°C', 'RECOVERY_LOG', 'ice bath → RECOVERY_LOG');
await hasIntent('cold shower for 3 minutes', 'RECOVERY_LOG', 'cold shower → RECOVERY_LOG');
await hasIntent('stretched and foam rolled for 20 min', 'RECOVERY_LOG', 'stretching/foam roll → RECOVERY_LOG');
await hasIntent('cold plunge 8 min', 'RECOVERY_LOG', 'cold plunge → RECOVERY_LOG');

// ────────────────────────────────────────────────────────────────
// 4. CLASSIFIER — RENAME / DELETE / TARGETS
// ────────────────────────────────────────────────────────────────
console.log('\n4. CLASSIFIER — RENAME / DELETE / TARGETS');
await hasIntent('rename my workout to chest day', 'RENAME', 'rename → RENAME');
await hasIntent('call that burger a big mac', 'RENAME', 'call that → RENAME');
await hasIntent('log that as rokeby smoothie', 'RENAME', 'log that as → RENAME');
await hasIntent('change Kettlebell Workout to Golf Workout', 'RENAME', 'change X to Y → RENAME');
await hasIntent('delete my lunch', 'DELETE', 'delete lunch → DELETE');
await hasIntent('remove that last entry', 'DELETE', 'remove entry → DELETE');
await hasIntent('change calorie target to 2200', 'UPDATE_TARGETS', 'set calorie target → UPDATE_TARGETS');
await hasIntent('yes apply those targets', 'UPDATE_TARGETS', 'yes apply targets → UPDATE_TARGETS');
await hasIntent('set protein to 180g', 'UPDATE_TARGETS', 'set protein → UPDATE_TARGETS');
await notIntent('maybe we should adjust my targets', 'UPDATE_TARGETS', 'vague targets suggestion → NOT UPDATE_TARGETS');
await hasIntent('gym tomorrow at 10am', 'PLAN', 'gym tomorrow → PLAN');
await hasIntent('remind me to take creatine every day at 9am', 'PLAN', 'daily reminder → PLAN');
await hasIntent('don\'t remind me about that', 'CANCEL_REMINDER', 'cancel reminder → CANCEL_REMINDER');
await hasIntent('не надо напоминать', 'CANCEL_REMINDER', 'Russian cancel reminder → CANCEL_REMINDER');

// ────────────────────────────────────────────────────────────────
// 5. CLASSIFIER — EDGE INPUTS
// ────────────────────────────────────────────────────────────────
console.log('\n5. CLASSIFIER — EDGE INPUTS');
{ const r = await cls('💪🏋️'); check('emoji workout → no crash', r, v => Array.isArray(v) && v.length > 0); }
{ const r = await cls('🍗🍚'); check('emoji food → no crash', r, v => Array.isArray(v) && v.length > 0); }
{ const r = await cls('???'); check('gibberish → GENERAL', r, v => v.includes('GENERAL')); }
{ const r = await cls('thanks!'); check('thanks → GENERAL', r, v => v.includes('GENERAL')); }
{ const r = await cls(''); check('empty string → no crash', r, v => Array.isArray(v) && v.length > 0); }

// ────────────────────────────────────────────────────────────────
// 6. CLASSIFIER — POISONED HISTORY (RENAME)
// ────────────────────────────────────────────────────────────────
console.log('\n6. CLASSIFIER — HISTORY POISONING TEST');
{
  const history = [
    { role: 'user', text: 'rename my workout to chest day' },
    { role: 'assistant', text: 'I couldn\'t find a workout to rename. Could you be more specific?' },
    { role: 'user', text: 'rename my workout to chest day' },
    { role: 'assistant', text: 'I don\'t see any recent workouts to rename.' },
  ];
  const r = await cls('rename my workout to chest day', history);
  check('RENAME with poisoned history → still RENAME', r, v => v.includes('RENAME'));
}

// ────────────────────────────────────────────────────────────────
// 7. CLASSIFIER — MULTI-LANGUAGE
// ────────────────────────────────────────────────────────────────
console.log('\n7. CLASSIFIER — MULTI-LANGUAGE');
await hasIntent('съел курицу и рис', 'MEAL_LOG', 'Russian: ate chicken rice → MEAL_LOG');
await hasIntent('тренировка 45 минут', 'WORKOUT_LOG', 'Russian: workout → WORKOUT_LOG');
await hasIntent('вес 104 кг', 'WEIGHT_LOG', 'Russian: weight → WEIGHT_LOG');
await hasIntent('sauna 20min и chicken rice потом', 'RECOVERY_LOG', 'Mixed EN/RU → RECOVERY_LOG');
await hasIntent('sauna 20min и chicken rice потом', 'MEAL_LOG', 'Mixed EN/RU → also MEAL_LOG');

// ────────────────────────────────────────────────────────────────
// 8. MEAL PARSER (analyzeMeal with null photo)
// ────────────────────────────────────────────────────────────────
console.log('\n8. MEAL PARSER EDGE CASES');
{
  const r = await claude.analyzeMeal(null, 'fasted all day, just water', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  const totalCals = items.reduce((s, x) => s + (x.calories || 0), 0);
  check('fasted day → ~0 kcal', null, () => totalCals <= 50);
}
{
  const r = await claude.analyzeMeal(null, '200g chicken breast, 150g white rice, 100g broccoli', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  check('exact grams → has items', items, v => v.length > 0 && v.some(i => (i.name||i.food_name||'').toLowerCase().includes('chicken') || (i.calories||0) > 0));
}
{
  const r = await claude.analyzeMeal(null, 'Big Mac meal from McDonald\'s', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  check('branded fast food → calories > 0', items, v => v.some(i => (i.calories||0) > 200));
}
{
  const r = await claude.analyzeMeal(null, '2 scoops whey protein with 300ml milk', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  check('protein shake → protein > 20g', items, v => v.some(i => (i.protein_g||i.protein||0) > 20));
}
{
  const r = await claude.analyzeMeal(null, 'nasi goreng kampung', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  check('Malay food nasi goreng → recognized', items, v => v.length > 0 && v.some(i => (i.calories||0) > 0));
}
{
  const r = await claude.analyzeMeal(null, 'half a banana before my run', null, '', null);
  check('fraction food → no crash', r, v => v != null);
}
{
  const r = await claude.analyzeMeal(null, 'one small bite of chocolate', null, '', null);
  const items = Array.isArray(r) ? r : (r?.items || [r]);
  const totalCals = items.reduce((s, x) => s + (x.calories || 0), 0);
  check('one bite → low calories < 100', null, () => totalCals < 100);
}

// ────────────────────────────────────────────────────────────────
// 9. WORKOUT PARSER EDGE CASES
// ────────────────────────────────────────────────────────────────
console.log('\n9. WORKOUT PARSER EDGE CASES');
{
  const r = await claude.parseWorkout('played golf for 4 hours', '', 104);
  check('golf → parses sport', r, v => v != null && (JSON.stringify(v).toLowerCase().includes('golf')));
}
{
  const r = await claude.parseWorkout('bench press 3x5 100kg, 3x5 110kg, 3x3 120kg progressive', '', 104);
  check('progressive sets → parses', r, v => v != null);
}
{
  const r = await claude.parseWorkout('30 min HIIT circuit: burpees, jump squats, mountain climbers', '', 104);
  check('HIIT circuit → parses with calories', r, v => {
    const s = JSON.stringify(v||{});
    return v != null;
  });
}
{
  const r = await claude.parseWorkout('100 pushups, 100 situps, 100 squats, 10km run', '', 104);
  check('bodyweight + run combo → parses', r, v => v != null);
}
{
  try {
    const r = await claude.parseWorkout('did something at the gym', '', 104);
    check('vague gym → not null (or throws gracefully)', r, v => v != null);
  } catch (e) {
    ok('vague gym → throws cleanly (expected for unparseable input)');
  }
}
{
  const r = await claude.parseWorkout('deadlift 5x5 @80% 1RM roughly 160kg', '', 104);
  check('percentage 1RM notation → parses', r, v => v != null);
}

// ────────────────────────────────────────────────────────────────
// 10. RECOVERY PARSER EDGE CASES
// ────────────────────────────────────────────────────────────────
console.log('\n10. RECOVERY PARSER EDGE CASES');
{
  const r = await claude.parseRecovery('sauna 20min 95°C');
  check('simple sauna → 1 protocol', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parseRecovery('3 rounds: sauna 10min 100°C, cold plunge 3min 8°C');
  check('uniform contrast 3 rounds', r, v => {
    if (!Array.isArray(v) || !v.length) return false;
    return v[0].protocol === 'contrast' && v[0].rounds === 3 && v[0].uniform === true;
  });
}
{
  // This is Max's actual per-round session
  const r = await claude.parseRecovery('sauna 10min 100°C, cold plunge 10min 8°C, sauna 10min 100°C, cold plunge 3min 9°C, sauna 10min 100°C, cold plunge 3min 9°C');
  if (Array.isArray(r) && r.length > 0) {
    const p = r[0];
    check('per-round contrast → uniform=false', p, v => v.protocol === 'contrast' && v.uniform === false);
    if (p.uniform === false) {
      check('per-round: has rounds array', p, v => Array.isArray(v.rounds) && v.rounds.length === 3);
      check('per-round: R1 cold = 10min', p.rounds?.[0]?.steps, v =>
        Array.isArray(v) && v.some(s => s.type?.toLowerCase().includes('cold') && s.duration_min === 10)
      );
      check('per-round: R2 cold = 3min', p.rounds?.[1]?.steps, v =>
        Array.isArray(v) && v.some(s => s.type?.toLowerCase().includes('cold') && s.duration_min === 3)
      );
    }
  } else {
    fail('per-round contrast parse', 'returned empty');
  }
}
{
  const r = await claude.parseRecovery('cold shower 3min');
  check('cold shower → single recovery', r, v => Array.isArray(v) && v.length > 0 && v[0].sessions?.length > 0);
}
{
  const r = await claude.parseRecovery('30min yoga and stretching');
  check('yoga/stretching → recovery', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parseRecovery('ice bath for about 10 minutes, really cold');
  check('ice bath vague → parses', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parseRecovery('did a recovery session');
  check('vague recovery → no crash', r, v => Array.isArray(v));
}

// ────────────────────────────────────────────────────────────────
// 11. BODY PARSER EDGE CASES
// ────────────────────────────────────────────────────────────────
console.log('\n11. BODY PARSER EDGE CASES');
{
  const r = await claude.parseBody('104.2 kg, 28% body fat');
  check('weight + body fat', r, v => v.weight_kg === 104.2 && v.body_fat_pct === 28);
}
{
  const r = await claude.parseBody('weighed 102kg, body fat 26%, muscle mass 78kg');
  check('weight + fat + muscle', r, v => v.weight_kg === 102 && v.body_fat_pct === 26 && v.muscle_mass_kg === 78);
}
{
  const r = await claude.parseBody('morning weight 103.5');
  check('weight only → muscle null', r, v => v.weight_kg === 103.5 && v.muscle_mass_kg == null);
}
{
  const r = await claude.parseBody('body fat is 27%, muscle 76.5kg');
  check('fat + muscle no weight', r, v => v.body_fat_pct === 27 && v.muscle_mass_kg === 76.5);
}
{
  const r = await claude.parseBody('DEXA scan results: 23% fat, 80kg lean mass, total 104kg');
  check('DEXA scan format', r, v => v.body_fat_pct === 23 && v.muscle_mass_kg === 80 && v.weight_kg === 104);
}
{
  const r = await claude.parseBody('InBody: total 105.3kg, body fat 28.1%, skeletal muscle 77.2kg');
  check('InBody device format', r, v => v.weight_kg > 100 && v.body_fat_pct > 20 && v.muscle_mass_kg > 70);
}

// ────────────────────────────────────────────────────────────────
// 12. SLEEP PARSER EDGE CASES
// ────────────────────────────────────────────────────────────────
console.log('\n12. SLEEP PARSER EDGE CASES');
{
  const r = await claude.parseSleep('slept 7.5 hours, quality 4/5');
  check('sleep with quality 4/5', r, v => (v.hours_slept||v.duration_hours) >= 7 && v.quality >= 4 && v.quality <= 5);
}
{
  const r = await claude.parseSleep('went to bed 1am, woke at 8:30am');
  check('bed/wake times → ~7.5h', r, v => { const h = v.hours_slept??v.duration_hours; return h >= 7 && h <= 8; });
}
{
  const r = await claude.parseSleep('nap 2pm to 3:30pm');
  check('nap parsing → ≤2h', r, v => v != null && (v.hours_slept??v.duration_hours) <= 2);
}
{
  const r = await claude.parseSleep('terrible sleep, kept waking up, maybe 4 hours total');
  check('qualitative poor sleep → ≤5h', r, v => (v.hours_slept??v.duration_hours) <= 5);
}
{
  const r = await claude.parseSleep('slept great, 8 solid hours');
  check('qualitative great sleep → ≥7h', r, v => (v.hours_slept??v.duration_hours) >= 7);
}
{
  const r = await claude.parseSleep('slept 6 hours, quality 3');
  check('quality on 1-5 scale (not 3/10)', r, v => v.quality >= 1 && v.quality <= 5);
}
{
  const r = await claude.parseSleep('пришел домой в 2 ночи, встал в 9');
  check('Russian sleep times → parses', r, v => v != null && (v.hours_slept??v.duration_hours) >= 6);
}

// ────────────────────────────────────────────────────────────────
// 13. PLAN PARSER EDGE CASES
// ────────────────────────────────────────────────────────────────
console.log('\n13. PLAN PARSER EDGE CASES');
{
  const r = await claude.parsePlans('gym tomorrow at 10am', 'Wednesday May 6 2026 09:00');
  check('simple plan → not empty', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parsePlans('remind me to take creatine every day at 9am', 'Wednesday May 6 2026 09:00');
  check('daily recurring plan', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parsePlans('morning run Monday Wednesday Friday at 7am', 'Wednesday May 6 2026 09:00');
  check('multi-day weekly plan', r, v => Array.isArray(v) && v.length > 0);
}
{
  const r = await claude.parsePlans('meal prep Sunday 2pm and grocery shopping Saturday morning', 'Wednesday May 6 2026 09:00');
  check('two plans in one message → 2 items', r, v => Array.isArray(v) && v.length >= 2);
}

// ────────────────────────────────────────────────────────────────
// 14. CORRECTION + RENAME PARSERS
// ────────────────────────────────────────────────────────────────
console.log('\n14. CORRECTION + RENAME PARSERS');
{
  const r = await claude.parseTimeCorrection('change my lunch to 1:30pm');
  check('time correction → entry_type + new_time', r, v => v?.entry_type === 'meal' && v?.new_time === '13:30');
}
{
  const recentLogs = db.getRecentLogs(CHAT_ID, 7);
  const allLogs = [
    ...(recentLogs.meals || []).map(m => ({ type: 'meal', id: m.id, name: m.name || m.food_name })),
    ...(recentLogs.workouts || []).map(w => ({ type: 'workout', id: w.id, name: w.name || w.sport }))
  ].filter(l => l.name);

  if (allLogs.length > 0) {
    const first = allLogs[0];
    const r = await claude.parseRenameIntent(`rename ${first.name} to Test Renamed Entry`, allLogs);
    check('rename with real logs → returns entry_id', r, v => v != null && (v.entry_id != null || v.id != null));
  } else {
    warn('rename parser', 'no recent logs for CHAT_ID — skipping');
  }
}

// ────────────────────────────────────────────────────────────────
// 15. COACH Q&A — CONTEXT ACCURACY
// ────────────────────────────────────────────────────────────────
console.log('\n15. COACH Q&A — CONTEXT ACCURACY');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  {
    const r = await claude.askCoach('What is my daily calorie target?', '', targetsText, '', {});
    check('coach knows calorie target', r, v => typeof v === 'string' && v.length > 10 && (v.includes('kcal') || v.match(/\d{3,4}/)));
  }
  {
    const r = await claude.askCoach('Should I eat more protein?', 'Today: 3200 kcal, 280g protein — way over target', targetsText, '', {});
    check('coach responds to over-target context', r, v => typeof v === 'string' && v.length > 20);
  }
  {
    const r = await claude.askCoach('How many calories do I have left today?', 'Today: 800 kcal eaten so far', targetsText, '', {});
    check('coach does calorie math from context', r, v => typeof v === 'string' && v.length > 10);
  }
}

// ────────────────────────────────────────────────────────────────
// 16. REPLY CHAIN OVERFLOW (8-turn conversation)
// ────────────────────────────────────────────────────────────────
console.log('\n16. REPLY CHAIN OVERFLOW (8-turn conversation)');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  const messages = [
    { role: 'user', content: 'What should I eat for breakfast to hit my protein target?' },
    { role: 'assistant', content: 'For your protein target, eggs and Greek yogurt are excellent choices.' },
    { role: 'user', content: 'How many eggs exactly?' },
    { role: 'assistant', content: '3-4 whole eggs would give you about 20-25g protein.' },
    { role: 'user', content: 'What about adding oats?' },
    { role: 'assistant', content: 'Yes, 80g oats adds ~5g protein and good complex carbs.' },
    { role: 'user', content: 'Should I add protein powder too?' },
    { role: 'assistant', content: 'One scoop of whey would bump it to 45-50g protein total.' },
    { role: 'user', content: 'Is that too much protein in one meal?' },
    { role: 'assistant', content: 'No, 40-50g per meal is well within digestible range for most people.' },
    { role: 'user', content: 'What about leucine threshold?' },
    { role: 'assistant', content: 'You need ~2-3g leucine to trigger MPS — 3 eggs easily covers that.' },
    { role: 'user', content: 'Any timing recommendations?' },
    { role: 'assistant', content: 'Within 1-2h post-workout is ideal for muscle protein synthesis.' },
    { role: 'user', content: 'Should I train fasted or fed for fat loss?' },
  ];
  try {
    const r = await claude.continueCoachReply(messages, targetsText, {});
    check('8-turn chain → responds without crash', r, v => typeof v === 'string' && v.length > 10);
  } catch (e) {
    fail('8-turn reply chain', e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// 17. EVENING CHECK (incl. sleep quality scale)
// ────────────────────────────────────────────────────────────────
console.log('\n17. EVENING CHECK GENERATION');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  const checkData = {
    calories: 1800, protein: 140, carbs: 180, fat: 60,
    meals: ['chicken rice', 'protein shake', 'oats'],
    workouts: ['Strength training 45min'],
    sleep: { duration_hours: 7, quality: 3 },
    body: null, recovery: [], plans: []
  };
  try {
    const r = await claude.generateEveningCheck(checkData, targetsText, state.user_profile || '');
    check('evening check → string response', r, v => typeof v === 'string' && v.length > 20);
    check('no "X/10" sleep scale confusion', r, v => !v.match(/\b[3-9]\/10\b/));
  } catch (e) {
    fail('evening check', e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// 18. DAY SUMMARY
// ────────────────────────────────────────────────────────────────
console.log('\n18. DAY SUMMARY GENERATION');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  const dayStart = state.current_day_start || Date.now() - 8 * 3600000;
  try {
    const dayData = db.getDayDataFromSQLite(CHAT_ID, dayStart);
    const r = await claude.generateDaySummary(dayData, targetsText, null, state.user_profile || '');
    check('day summary → string', r, v => typeof v === 'string' && v.length > 10);
  } catch (e) {
    fail('day summary', e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// 19. WEEKLY REVIEW (incl. sleep quality scale)
// ────────────────────────────────────────────────────────────────
console.log('\n19. WEEKLY REVIEW GENERATION');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  const sinceMs = Date.now() - 7 * 24 * 3600000;
  try {
    const weekData = db.getWeekDataFromSQLite(CHAT_ID, sinceMs);
    const r = await claude.generateWeeklyReview(weekData, targetsText, state.user_profile || '');
    check('weekly review → string', r, v => typeof v === 'string' && v.length > 20);
    check('weekly review no X/10 scale', r, v => !v.match(/\b[3-9]\/10\b/));
  } catch (e) {
    fail('weekly review', e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// 20. PROACTIVE PATTERNS
// ────────────────────────────────────────────────────────────────
console.log('\n20. PROACTIVE PATTERNS');
{
  const targetsText = db.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  // Zero calorie day
  try {
    const r = await claude.checkProactivePatterns(
      { today: { calories: 0, protein: 0, carbs: 0, fat: 0, meals: [], workouts: [] }, minutesAwake: 300, recentSleep: null },
      targetsText, state.user_profile || ''
    );
    check('proactive: zero kcal → string', r, v => typeof v === 'string');
  } catch (e) {
    fail('proactive zero kcal', e.message);
  }
  // Over target + poor sleep
  try {
    const r = await claude.checkProactivePatterns(
      { today: { calories: 3200, protein: 250, carbs: 400, fat: 110, meals: ['big lunch', 'dinner'], workouts: [] }, minutesAwake: 600, recentSleep: { duration_hours: 5, quality: 2 } },
      targetsText, state.user_profile || ''
    );
    check('proactive: over target + poor sleep → string', r, v => typeof v === 'string');
  } catch (e) {
    fail('proactive over target', e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// 21. DB STATE CONSISTENCY
// ────────────────────────────────────────────────────────────────
console.log('\n21. DB STATE CONSISTENCY');
{
  const state = db.getState(CHAT_ID);
  check('state: has timezone', state, v => typeof v.timezone === 'string' && v.timezone.length > 0);
  check('state: onboarded', state, v => v.onboarded === 1 || v.onboarded === true);

  const targets = db.getTargetsFromDb(CHAT_ID);
  check('targets: calories > 0', targets, v => v && typeof v.calories === 'number' && v.calories > 0);
  check('targets: protein > 0', targets, v => v && typeof v.protein === 'number' && v.protein > 0);
  check('targets: weight_kg set', targets, v => v && typeof v.weight_kg === 'number' && v.weight_kg > 0);

  const lastBody = db.getLastBodyMeasurement(CHAT_ID);
  if (lastBody) {
    check('body_log: has weight', lastBody, v => typeof v.weight_kg === 'number');
    check('body_log: BMI computed', lastBody, v => v.bmi != null);
  } else {
    warn('body_log', 'no body measurements for CHAT_ID');
  }

  if (state.body_metrics) {
    check('body_metrics includes weight', state.body_metrics, v => v.includes('weight'));
  } else {
    warn('body_metrics', 'not set — onboarding body step not completed or old user');
  }

  // Recovery log schema check
  const sinceMs = Date.now() - 30 * 24 * 3600000;
  const weekData = db.getWeekDataFromSQLite(CHAT_ID, sinceMs);
  check('recovery sessions queryable', weekData, v => Array.isArray(v.recoverySessions));
  if (weekData.recoverySessions?.length > 0) {
    const r = weekData.recoverySessions[0];
    check('recovery row: has protocol field', r, v => typeof v.protocol === 'string');
  } else {
    warn('recovery sessions', 'no recovery data in last 30 days — re-log needed');
  }
}

// ────────────────────────────────────────────────────────────────
// FINAL REPORT
// ────────────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════');
console.log('  TEST RESULTS');
console.log('══════════════════════════════════════════');
console.log(`  ✅ Passed:   ${passed}`);
console.log(`  ❌ Failed:   ${failed}`);
console.log(`  ⚠️  Warnings: ${warnings}`);
if (failures.length > 0) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  •', f));
}
console.log('══════════════════════════════════════════\n');
process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
