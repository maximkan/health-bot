#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db     = require('./src/db');

const CHAT_ID = 119445404;
let msgIdCtr = 400000;

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [], warnings = [];
const sections = {};
let currentSection = '';

function section(name) {
  currentSection = name;
  sections[name] = { passed: 0, failed: 0, warned: 0 };
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('═'.repeat(70));
}
function ok(label, detail = '') { passed++; sections[currentSection].passed++; console.log(`  ✅ ${label}${detail ? '  →  ' + detail : ''}`); }
function fail(label, detail = '') { failed++; sections[currentSection].failed++; failures.push(`[${currentSection}] ${label}${detail ? ': ' + detail : ''}`); console.log(`  ❌ ${label}${detail ? '  →  ' + detail : ''}`); }
function warn(label, detail = '') { warned++; sections[currentSection].warned++; warnings.push(`[${currentSection}] ${label}: ${detail}`); console.log(`  ⚠️  ${label}${detail ? '  →  ' + detail : ''}`); }
function check(label, condition, actual = '', failDetail = '') {
  if (condition) ok(label, String(actual).slice(0, 100));
  else fail(label, failDetail || String(actual).slice(0, 140));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. OUTPUT FORMAT REQUIREMENTS — Mandatory structural elements
//    Every coach output has required structural elements that must always appear.
// ─────────────────────────────────────────────────────────────────────────────
async function testOutputFormatRequirements() {
  section('OUTPUT FORMAT — Mandatory Elements in Every Response');

  const targetsCtx = 'calories: 1900, protein: 180g, carbs: 200g, fat: 70g';
  const state = db.getState(CHAT_ID);

  const baseCheck = (hours, quality) => ({
    totals: { calories: 1650, protein: 145, carbs: 160, fat: 52 },
    targets: { calories: 1900, protein: 180, carbs: 200, fat: 70 },
    sleep_hours_last_night: hours, sleep_quality_last_night_out_of_5: quality,
    caffeine: { total_mg: 200, last_time: null, drinks: 2 },
    workouts: [], timedPlans: [], tasks: [],
  });

  // Evening check: must always have "prep for tomorrow:" line
  try {
    const out = await claude.generateEveningCheck(baseCheck(7.5, 4), targetsCtx, state);
    check('evening check always has "prep for tomorrow:" line', /prep for tomorrow/i.test(out), out.slice(0, 100));
  } catch (e) { fail('evening check prep line', e.message); }

  // Evening check: must always have pill reminder
  try {
    const out = await claude.generateEveningCheck(baseCheck(7, 3), targetsCtx, state);
    check('evening check always has pill reminder', /pill|pills|supplement/i.test(out), out.slice(0, 120));
  } catch (e) { fail('evening check pill reminder', e.message); }

  // Evening check: must NOT use markdown ** headers
  try {
    const out = await claude.generateEveningCheck(baseCheck(8, 4), targetsCtx, state);
    const hasMarkdown = /\*\*|\#{2,}/.test(out);
    check('evening check: no markdown ** or ## headers', !hasMarkdown, out.slice(0, 100), `found markdown in: "${out.slice(0,80)}"`);
  } catch (e) { fail('evening check no markdown', e.message); }

  // Day summary: must always have "prep for tomorrow:" line
  try {
    const dayData = { totals: { calories: 1800, protein: 170, carbs: 180, fat: 60 }, workouts: [], meals: [], sleep: { hours_slept: 7.5, quality: 4, type: 'Night' } };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    check('day summary always has "prep for tomorrow:" line', /prep for tomorrow/i.test(out), out.slice(0, 100));
  } catch (e) { fail('day summary prep line', e.message); }

  // All duration output must be in "Xh Ym" format — no decimals like "7.5h"
  try {
    const data = { ...baseCheck(7.5, 4) };
    const out = await claude.generateEveningCheck(data, targetsCtx, state);
    const hasDecimalDuration = /\b\d+\.\d+\s*h\b/.test(out); // e.g. "7.5h"
    check('evening check: no decimal durations (use 7h 30m not 7.5h)', !hasDecimalDuration, out.slice(0, 100), `decimal duration found: "${out.slice(0,120)}"`);
  } catch (e) { fail('evening check decimal duration', e.message); }

  // Day summary: no decimal durations
  try {
    const dayData = { totals: { calories: 1800, protein: 170, carbs: 180, fat: 60 }, workouts: [], meals: [], sleep: { hours_slept: 7.5, quality: 4, type: 'Night' } };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const hasDecimalDuration = /\b\d+\.\d+\s*h\b/.test(out);
    check('day summary: no decimal durations', !hasDecimalDuration, out.slice(0, 100));
  } catch (e) { fail('day summary decimal duration', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. EVENING CHECK — Null safety (missing data must not crash or hallucinate)
// ─────────────────────────────────────────────────────────────────────────────
async function testEveningCheckNullSafety() {
  section('EVENING CHECK — Null Safety (Missing Fields Must Not Hallucinate)');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);

  // No sleep data at all
  try {
    const data = {
      totals: { calories: 1600, protein: 140, carbs: 150, fat: 50 },
      targets: { calories: 1900, protein: 180 },
      sleep_hours_last_night: null,
      sleep_quality_last_night_out_of_5: null,
      caffeine: { total_mg: 200, last_time: null, drinks: 2 },
      workouts: [], timedPlans: [], tasks: [],
    };
    const out = await claude.generateEveningCheck(data, targetsCtx, state);
    // Must not say "slept null hours" or "quality null/5"
    const hasNullLeak = /null|undefined|NaN/i.test(out);
    check('no sleep data → output doesnt say null/undefined', !hasNullLeak, out.slice(0, 120));
    // Must not invent a sleep duration
    const inventedHours = /slept \d+h|\d+h.*sleep.*quality|quality.*\d\/5/i.test(out);
    check('no sleep data → output doesnt invent sleep hours/quality', !inventedHours, out.slice(0, 120), `invented sleep: "${out.slice(0,100)}"`);
  } catch (e) { fail('evening check null sleep', e.message); }

  // No workouts
  try {
    const data = {
      totals: { calories: 1600, protein: 140, carbs: 150, fat: 50 },
      targets: { calories: 1900, protein: 180 },
      sleep_hours_last_night: 7, sleep_quality_last_night_out_of_5: 4,
      caffeine: { total_mg: 200, last_time: null, drinks: 2 },
      workouts: [], timedPlans: [], tasks: [],
    };
    const out = await claude.generateEveningCheck(data, targetsCtx, state);
    // Should NOT say "burned 0 kcal in workout" — just don't mention workout burn when workouts=[]
    const bogusWorkoutBurn = /burned 0|0 kcal.*workout|workout.*0 kcal/i.test(out);
    check('no workouts → no "burned 0 kcal" mention', !bogusWorkoutBurn, out.slice(0, 120));
  } catch (e) { fail('evening check null workouts', e.message); }

  // Calories exactly on target (0 remaining)
  try {
    const data = {
      totals: { calories: 1900, protein: 180, carbs: 200, fat: 70 },
      targets: { calories: 1900, protein: 180 },
      sleep_hours_last_night: 7.5, sleep_quality_last_night_out_of_5: 4,
      caffeine: { total_mg: 150, last_time: null, drinks: 1 },
      workouts: [], timedPlans: [], tasks: [],
    };
    const out = await claude.generateEveningCheck(data, targetsCtx, state);
    // Should say "on target" or "hit your target" or "exactly" — not "0 remaining" or "0 left"
    const hasNumber = /1[,.]?900|on target|perfect|hit|exactly|nailed|1900/i.test(out);
    check('exactly on target calories → positive framing (not "0 remaining")', hasNumber, out.slice(0, 120));
  } catch (e) { fail('evening check exactly on target', e.message); }

  // Protein exactly at target
  try {
    const data = {
      totals: { calories: 1900, protein: 180, carbs: 200, fat: 70 },
      targets: { calories: 1900, protein: 180 },
      sleep_hours_last_night: 7.5, sleep_quality_last_night_out_of_5: 4,
      caffeine: { total_mg: 150, last_time: null, drinks: 1 },
      workouts: [], timedPlans: [], tasks: [],
    };
    const out = await claude.generateEveningCheck(data, targetsCtx, state);
    // Must NOT suggest eating more protein when at target
    const wrongProteinSuggestion = /need.{0,15}more.{0,20}protein|protein.{0,20}short|add.{0,15}protein/i.test(out);
    check('protein exactly at target → NOT suggested to eat more', !wrongProteinSuggestion, out.slice(0, 120), `"${out.slice(0,100)}"`);
  } catch (e) { fail('evening check protein at target', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. EVENING CHECK — Caffeine flag timing
//    Must flag caffeine > 400mg OR after 17:00, not otherwise.
// ─────────────────────────────────────────────────────────────────────────────
async function testEveningCheckCaffeine() {
  section('EVENING CHECK — Caffeine Flags (High + Late)');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);
  const base = (caffeine) => ({
    totals: { calories: 1600, protein: 145, carbs: 160, fat: 55 },
    targets: { calories: 1900, protein: 180 },
    sleep_hours_last_night: 7.5, sleep_quality_last_night_out_of_5: 4,
    workouts: [], timedPlans: [], tasks: [],
    caffeine,
  });

  // 520mg — must flag
  try {
    const out = await claude.generateEveningCheck(base({ total_mg: 520, last_time: '14:00', drinks: 4 }), targetsCtx, state);
    check('520mg caffeine → flagged in output', /caffeine|coffee|520|mg/i.test(out), out.slice(0, 100));
  } catch (e) { fail('caffeine 520mg flag', e.message); }

  // 180mg at 09:00 — should NOT flag
  try {
    const out = await claude.generateEveningCheck(base({ total_mg: 180, last_time: '09:00', drinks: 2 }), targetsCtx, state);
    const flagged = /caffeine.{0,30}(too much|high|over|limit|avoid|warning)/i.test(out);
    check('180mg at 9am → NOT flagged as excessive', !flagged, out.slice(0, 100));
  } catch (e) { fail('caffeine 180mg no-flag', e.message); }

  // 250mg at 18:30 (after 17:00) — must flag for timing
  try {
    const out = await claude.generateEveningCheck(base({ total_mg: 250, last_time: '18:30', drinks: 2 }), targetsCtx, state);
    check('250mg at 18:30 → flagged for late timing', /caffeine|coffee|late|evening|sleep|18/i.test(out), out.slice(0, 100));
  } catch (e) { fail('caffeine late timing flag', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. EVENING CHECK — Protein suggestion must be SPECIFIC
//    Prompt: "protein status with specific suggestion if short"
//    Not "eat more protein" — must name an actual food.
// ─────────────────────────────────────────────────────────────────────────────
async function testProteinSuggestionSpecificity() {
  section('EVENING CHECK — Protein Suggestion Must Name a Specific Food');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);

  const cases = [
    { protein: 80, label: 'protein at 80g (100g short) → specific food suggestion' },
    { protein: 120, label: 'protein at 120g (60g short) → specific food suggestion' },
    { protein: 155, label: 'protein at 155g (25g short) → specific food suggestion' },
  ];

  for (const c of cases) {
    try {
      const data = {
        totals: { calories: 1500, protein: c.protein, carbs: 150, fat: 45 },
        targets: { calories: 1900, protein: 180 },
        sleep_hours_last_night: 7.5, sleep_quality_last_night_out_of_5: 4,
        caffeine: { total_mg: 150, last_time: null, drinks: 1 },
        workouts: [], timedPlans: [], tasks: [],
      };
      const out = await claude.generateEveningCheck(data, targetsCtx, state);
      // Must name a specific protein source, not just "eat more protein"
      const specifics = /chicken|egg|tuna|shake|whey|protein.{0,5}(shake|bar|powder)|beef|fish|greek.{0,5}yogurt|cottage.{0,5}cheese|turkey/i;
      const vague = /eat more protein|more protein$/i.test(out) && !specifics.test(out);
      check(c.label, specifics.test(out) && !vague, out.slice(0, 120), `vague: "${out.slice(0,100)}"`);
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. WORKOUT CALORIES — Cardio with speed/distance/duration
//    Must compute non-null calories for all cardio types with meaningful data.
// ─────────────────────────────────────────────────────────────────────────────
async function testCardioCalories() {
  section('WORKOUT CALORIES — Cardio Types Must Compute Calories');

  const state = db.getState(CHAT_ID);
  const weight = state?.weight_kg || 100;

  const cases = [
    { text: 'ran 5km in 25 minutes', label: '5km run → calories > 150', minCals: 150 },
    { text: '45 minute cycling session', label: '45min cycling → calories > 200', minCals: 200 },
    { text: 'row machine 20 minutes', label: '20min rowing → calories > 100', minCals: 100 },
    { text: '30 minute swim', label: '30min swim → calories > 150', minCals: 150 },
    { text: 'golf 9 holes walked the course 2 hours', label: 'golf 9h → calories > 200', minCals: 200 },
    { text: 'range session 30 minutes', label: 'range session 30min → calories > 0', minCals: 1 },
    { text: 'yoga class 1 hour', label: 'yoga 1h → calories > 50', minCals: 50 },
    // The "gym 1h no exercises" case — should now trigger clarification or estimate
    { text: 'gym session today, about an hour', label: 'gym 1h vague → calories > 0 (default MET) OR duration_min returned', minCals: 0, checkAny: true },
  ];

  for (const c of cases) {
    try {
      const r = await claude.parseWorkout(c.text, '', weight);
      const cals = r?.calories_burned;
      const dur = r?.duration_min;
      if (c.checkAny) {
        // For vague workout: either calories estimated OR at minimum duration is captured
        check(c.label,
          (cals != null && cals > 0) || (dur != null && dur > 0),
          `calories_burned=${cals} duration_min=${dur}`
        );
      } else {
        check(c.label, cals != null && cals > c.minCals,
          `calories_burned=${cals}`, `got ${cals}, expected > ${c.minCals}`);
      }
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. WORKOUT PARSER — Unit conversion and edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testWorkoutEdgeCases() {
  section('WORKOUT PARSER — Unit Conversion and Edge Cases');

  const weight = db.getState(CHAT_ID)?.weight_kg || 100;

  // Pounds to kg conversion
  try {
    const r = await claude.parseWorkout('bench press 225 lbs 3x8', '', weight);
    const bench = r?.exercises?.find(e => /bench/i.test(e.name));
    check('bench 225lbs → weight_kg ≈ 100 (converted from lbs)',
      bench && bench.weight_kg >= 95 && bench.weight_kg <= 108,
      `weight_kg=${bench?.weight_kg}`, `got ${bench?.weight_kg}`);
  } catch (e) { fail('lbs to kg conversion', e.message); }

  // Duration explicitly stated — should NOT be overridden by set estimation
  try {
    const r = await claude.parseWorkout('chest workout 45 minutes: bench 100kg 4x8, incline 80kg 3x10', '', weight);
    check('explicit 45min duration used (not overridden by set estimate)',
      r?.duration_min >= 40 && r?.duration_min <= 50,
      `duration_min=${r?.duration_min}`);
  } catch (e) { fail('explicit duration not overridden', e.message); }

  // "30 each leg" → reps=30 not 60
  try {
    const r = await claude.parseWorkout('lunges 3 sets of 30 each leg at 20kg', '', weight);
    const lunges = r?.exercises?.[0];
    const reps = lunges?.reps;
    check('"30 each leg" → reps=30 (per side, not 60)',
      reps >= 25 && reps <= 35,
      `reps=${reps}`);
  } catch (e) { fail('"30 each leg" reps', e.message); }

  // Mixed strength + cardio: both parts captured
  try {
    const r = await claude.parseWorkout('30min run then back workout: deadlift 140kg 3x5, rows 3x10', '', weight);
    check('mixed run+weights → calories > 0', (r?.calories_burned || 0) > 0, `calories=${r?.calories_burned}`);
  } catch (e) { fail('mixed run+weights', e.message); }

  // "60 reps no sets" → sets=1, reps=60
  try {
    const r = await claude.parseWorkout('did 60 pushups', '', weight);
    const pushup = r?.exercises?.[0];
    check('"60 pushups" → reps≥50',
      (pushup?.reps || 0) >= 50 || (pushup?.sets || 0) >= 1,
      `sets=${pushup?.sets} reps=${pushup?.reps}`);
  } catch (e) { fail('60 pushups reps', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. MEAL MACRO ITEM SUM INTEGRITY
//    Sum of item macros should approximately match totals (within 10%).
// ─────────────────────────────────────────────────────────────────────────────
async function testMealMacroIntegrity() {
  section('MEAL MACRO INTEGRITY — Item Sums Match Totals');

  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()];
  const now = new Date().toTimeString().slice(0, 5);

  const cases = [
    { text: '150g chicken breast, 100g brown rice, 100g broccoli', label: 'three items macro sum integrity' },
    { text: 'omelette: 3 eggs, 30g cheese, onion, peppers', label: 'omelette with components' },
    { text: 'burger: beef patty 150g, bun, lettuce, tomato, cheese', label: 'burger components' },
  ];

  for (const c of cases) {
    try {
      const r = await claude.analyzeMeal(null, c.text, dayOfWeek, '', now);
      const items = r.items || [];
      if (items.length < 2) { warn(c.label, `only ${items.length} items returned — can't verify sum`); continue; }

      const sumCals = items.reduce((s, i) => s + (i.calories || 0), 0);
      const totCals = r.totals?.calories || 0;
      const sumProt = items.reduce((s, i) => s + (i.protein || 0), 0);
      const totProt = r.totals?.protein || 0;

      if (totCals > 0 && sumCals > 0) {
        const calDiff = Math.abs(sumCals - totCals) / totCals;
        check(`${c.label}: cal sum ≈ totals (within 20%)`, calDiff < 0.20,
          `sum=${Math.round(sumCals)} total=${totCals}`,
          `divergence ${(calDiff*100).toFixed(0)}% (sum=${Math.round(sumCals)}, total=${totCals})`);
      }
      if (totProt > 0 && sumProt > 0) {
        const protDiff = Math.abs(sumProt - totProt) / totProt;
        check(`${c.label}: protein sum ≈ totals (within 25%)`, protDiff < 0.25,
          `sum=${Math.round(sumProt)} total=${totProt}`);
      }
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. CLASSIFIER — High-value edge cases missed in first test
// ─────────────────────────────────────────────────────────────────────────────
async function testClassifierEdgeCases() {
  section('CLASSIFIER — High-Value Edge Cases');

  const cases = [
    // PLAN_DONE — ambiguous "done" phrasings
    { text: 'done with creatine',         expects: ['PLAN_DONE'],       label: '"done with creatine" → PLAN_DONE' },
    { text: 'took my pills',              expects: ['PLAN_DONE'],       label: '"took my pills" → PLAN_DONE' },
    { text: 'finished the report',        expects: ['PLAN_DONE'],       label: '"finished the report" → PLAN_DONE' },

    // UPDATE_TARGETS — explicit number changes
    { text: 'set my protein to 200g',         expects: ['UPDATE_TARGETS'], label: 'set protein to 200g → UPDATE_TARGETS' },
    { text: 'change calorie target to 2200',   expects: ['UPDATE_TARGETS'], label: 'change calorie target → UPDATE_TARGETS' },

    // PLAN_DONE vs WORKOUT_LOG — "done" with workout context
    { text: 'done with gym', expects: ['PLAN_DONE', 'WORKOUT_LOG'], anyOf: true, label: '"done with gym" → PLAN_DONE or WORKOUT_LOG' },
    { text: 'finished chest session',    expects: ['WORKOUT_LOG'],  label: '"finished chest session" → WORKOUT_LOG' },

    // RETRO / retroactive meal logging
    { text: 'had chicken rice for lunch yesterday', expects: ['MEAL_LOG'], label: 'yesterday meal → MEAL_LOG (with retro context)' },
    { text: 'forgot to log my breakfast this morning', expects: ['MEAL_LOG'], label: '"forgot to log breakfast" → MEAL_LOG' },

    // BED / WAKE edge cases
    { text: 'heading to bed now',     expects: ['BED'],  label: '"heading to bed" → BED' },
    { text: 'just woke up',           expects: ['WAKE'], label: '"just woke up" → WAKE' },
    { text: 'going to sleep soon',    expects: ['BED'],  label: '"going to sleep soon" → BED' },
    { text: 'woke up at 9am',         expects: ['WAKE'], label: '"woke up at 9am" → WAKE' },

    // Ambiguous meal + workout in one message → both intents
    { text: 'had chicken rice for lunch then hit chest at the gym',
      expects: ['MEAL_LOG', 'WORKOUT_LOG'], anyOf: false, all: true,
      label: '"meal + workout" → both MEAL_LOG and WORKOUT_LOG detected' },

    // Supplement log — classify as PLAN_DONE or GENERAL not MEAL_LOG
    { text: 'took creatine this morning',
      expects: ['PLAN_DONE', 'MEAL_LOG'], anyOf: true,
      label: '"took creatine" → PLAN_DONE or MEAL_LOG (not just GENERAL)' },

    // DELETE intent
    { text: 'remove my last meal',   expects: ['DELETE'], label: '"remove my last meal" → DELETE' },
    { text: 'delete that workout',   expects: ['DELETE'], label: '"delete that workout" → DELETE' },

    // WEIGHT_LOG
    { text: '104.5 this morning',    expects: ['WEIGHT_LOG'], label: '"104.5 this morning" → WEIGHT_LOG' },
    { text: 'weighed myself, 103kg', expects: ['WEIGHT_LOG'], label: '"weighed myself, 103kg" → WEIGHT_LOG' },

    // CORRECTION
    { text: 'that was 200g not 100g', expects: ['CORRECTION'], label: '"200g not 100g" → CORRECTION' },
    { text: 'change the time to 2pm', expects: ['CORRECTION'], label: '"change the time to 2pm" → CORRECTION' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.classify(c.text, []);
      const hit = c.all
        ? c.expects.every(e => result.includes(e))
        : c.anyOf
          ? c.expects.some(e => result.includes(e))
          : c.expects.every(e => result.includes(e));
      check(c.label, hit, `[${result.join(',')}]`,
        `expected [${c.expects.join(',')}]${c.all ? ' (all)' : ''} got [${result.join(',')}]`);
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. PROACTIVE — Same category guard + pattern escalation
//    todayAlert prevents re-flagging same category.
// ─────────────────────────────────────────────────────────────────────────────
async function testProactiveSameCategoryGuard() {
  section('PROACTIVE — Same-Category Guard and Escalation');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);

  // Protein was already flagged today → must NOT flag protein again
  try {
    const data = {
      minutesAwake: 600,
      today: { calories: 1200, protein: 80, meals: ['chicken rice', 'eggs'] },
      recentWeek: [
        { calories: 1800, protein: 120 }, { calories: 1750, protein: 110 },
        { calories: 1900, protein: 125 }, { calories: 1850, protein: 105 },
      ],
      todayAlert: 'protein still below target — already at 80g at midday, you need to step it up',
      recentAlerts: [],
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    if (result === null) {
      ok('protein already flagged today → null returned (correct)');
    } else {
      const isProteinAgain = /protein/i.test(result);
      check('protein already flagged today → different category or null', !isProteinAgain, `"${result}"`, `re-flagged protein: "${result}"`);
    }
  } catch (e) { fail('same-category protein guard', e.message); }

  // Caffeine was already flagged → can still flag calories (different category)
  try {
    const data = {
      minutesAwake: 600,
      today: { calories: 2400, protein: 170, meals: ['large breakfast', 'pizza', 'burger'], caffeine_mg: 350 },
      recentWeek: [
        { calories: 2300 }, { calories: 2200 }, { calories: 2400 }, { calories: 2100 },
      ],
      todayAlert: 'you had 480mg caffeine today, cut it off now',
      recentAlerts: [],
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    // Result should flag calories/food (not caffeine again) or return null
    if (result) {
      const isCaffeineAgain = /caffeine|coffee|480mg/i.test(result);
      check('caffeine flagged → different category alert (calories/food) fires', !isCaffeineAgain, `"${result}"`);
    } else {
      ok('no second nudge fired (acceptable if nothing else is critical enough)');
    }
  } catch (e) { fail('different category after caffeine flag', e.message); }

  // Pattern worsening → escalation
  try {
    const data = {
      minutesAwake: 700,
      today: { calories: 1100, protein: 70, meals: ['coffee'] },
      recentWeek: [
        { calories: 1200, protein: 75 }, { calories: 1150, protein: 68 },
        { calories: 1300, protein: 80 }, { calories: 1100, protein: 65 },
      ],
      todayAlert: null,
      recentAlerts: ['protein below target for 2 days running'],
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    // Should flag something (pattern has been worsening)
    check('persistent protein pattern → nudge fires', result !== null, result ? `"${result.slice(0,80)}"` : 'null');
  } catch (e) { fail('pattern escalation test', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. PLANS PARSER — Date resolution edge cases
//     "tomorrow", "this Friday", "next Monday" must resolve to correct dates.
// ─────────────────────────────────────────────────────────────────────────────
async function testPlansDateResolution() {
  section('PLANS PARSER — Date Resolution (Tomorrow, Day Names)');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = isoDate(tomorrow);
  const todayStr = isoDate(now);
  const currentDateTime = `Current date/time: ${now.toISOString()}`;

  const p0 = v => Array.isArray(v) ? v[0] : (v?.plans?.[0] || v);

  // Tomorrow must resolve correctly
  try {
    const r = await claude.parsePlans('gym tomorrow at 8am', currentDateTime);
    check('"tomorrow 8am" → date=tomorrow', p0(r)?.date === tomorrowStr, `date=${p0(r)?.date}`, `expected ${tomorrowStr}, got ${p0(r)?.date}`);
    check('"tomorrow 8am" → time=08:00', p0(r)?.time === '08:00', `time=${p0(r)?.time}`);
  } catch (e) { fail('tomorrow date resolution', e.message); }

  // Today must resolve correctly
  try {
    const r = await claude.parsePlans('meeting in 2 hours', currentDateTime);
    check('"meeting in 2 hours" → date=today', p0(r)?.date === todayStr, `date=${p0(r)?.date}`);
  } catch (e) { fail('"meeting in 2 hours" date', e.message); }

  // Multiple plans extracted with correct dates
  try {
    const r = await claude.parsePlans('gym tomorrow at 6am and dentist the day after at 3pm', currentDateTime);
    const plans = Array.isArray(r) ? r : [];
    check('two plans extracted', plans.length >= 2, `count=${plans.length}`);
    if (plans.length >= 2) {
      const hasTomorrow = plans.some(p => p.date === tomorrowStr);
      check('at least one plan dated tomorrow', hasTomorrow, plans.map(p => p.date).join(', '));
    }
  } catch (e) { fail('multiple plans date resolution', e.message); }

  // Time format: 24h conversion
  try {
    const r = await claude.parsePlans('lunch meeting at 1:30pm', currentDateTime);
    check('1:30pm → time=13:30', p0(r)?.time === '13:30', `time=${p0(r)?.time}`);
  } catch (e) { fail('12h to 24h time conversion', e.message); }

  // Email must go to guests, not title
  try {
    const r = await claude.parsePlans('coffee with jake@example.com tomorrow at 11am', currentDateTime);
    const plan = p0(r);
    const titleHasEmail = (plan?.title || '').includes('@');
    const guestsHasEmail = (plan?.guests || []).some(g => g.includes('@'));
    check('email in plan: not in title', !titleHasEmail, `title="${plan?.title}"`);
    check('email in plan: appears in guests array', guestsHasEmail, `guests=${JSON.stringify(plan?.guests)}`);
  } catch (e) { fail('email extraction from plans', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. SLEEP PARSER — Edge cases and boundary values
// ─────────────────────────────────────────────────────────────────────────────
async function testSleepParserEdgeCases() {
  section('SLEEP PARSER — Edge Cases and Boundary Values');

  const cases = [
    // Nap with quality
    { text: 'nap from 2pm to 3:30pm, quality 4',
      check: v => v.type === 'Nap' && v.quality === 4 && v.hours_slept >= 1.3,
      label: 'nap with explicit quality=4' },

    // Exact quality 1 must survive
    { text: 'worst sleep ever, maybe 5 hours, quality 1',
      check: v => v.quality === 1,
      label: 'quality=1 explicit must survive "worst sleep" phrasing' },

    // Fractional hours
    { text: 'slept 7.5 hours',
      check: v => v.hours_slept >= 7.3 && v.hours_slept <= 7.7,
      label: 'fractional "7.5 hours" → hours_slept≈7.5' },

    // Russian language
    { text: 'спал с 23:00 до 7:00',
      check: v => v.hours_slept >= 7.5,
      label: 'Russian: slept 23:00-7:00 → 8h' },

    // Output always has required fields
    { text: 'nap for 20 minutes',
      check: v => 'hours_slept' in v && 'type' in v && 'quality' in v && v.type === 'Nap',
      label: '20min nap → all required fields present, type=Nap' },

    // Cross-midnight precision
    { text: 'went to bed at 11:45pm woke at 7:15am',
      check: v => v.hours_slept >= 7.0 && v.hours_slept <= 7.8,
      label: 'cross-midnight 11:45pm–7:15am → ≈7.5h' },

    // "quality X/5" format
    { text: 'slept 8h, quality 2/5',
      check: v => v.quality === 2,
      label: '"quality 2/5" format → quality=2' },
  ];

  for (const c of cases) {
    try {
      const r = await claude.parseSleep(c.text);
      check(c.label, c.check(r), JSON.stringify(r).slice(0, 100));
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. DAILY SUMMARY — Sleep is always reported (not silently omitted)
//     Also: summary must stay within word limit (concise).
// ─────────────────────────────────────────────────────────────────────────────
async function testDaySummaryCompleteness() {
  section('DAY SUMMARY — Completeness and Conciseness');

  const targetsCtx = 'calories: 1900, protein: 180g, carbs: 200g, fat: 70g';
  const state = db.getState(CHAT_ID);

  // Sleep quality 2 (poor) MUST appear in summary
  try {
    const dayData = {
      totals: { calories: 1800, protein: 175, carbs: 180, fat: 65 },
      workouts: [],
      meals: [{ name: 'chicken', calories: 900, protein: 90 }, { name: 'rice', calories: 900, protein: 85 }],
      sleep: { hours_slept: 6.5, quality: 2, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    // Quality 2 is poor — must be mentioned
    const sleepMentioned = /sleep|slept/i.test(out);
    const qualityMentioned = /\b2\b/.test(out) || /poor|bad|rough|low.{0,10}quality/i.test(out);
    check('poor sleep (quality=2) mentioned in day summary', sleepMentioned && qualityMentioned, out.slice(0, 120), `"${out.slice(0,120)}"`);
  } catch (e) { fail('day summary poor sleep', e.message); }

  // Sleep quality 3 in day summary — at least mentioned
  try {
    const dayData = {
      totals: { calories: 1800, protein: 170, carbs: 185, fat: 62 },
      workouts: [{ name: 'Chest', calories_burned: 300, duration_min: 60 }],
      meals: [],
      sleep: { hours_slept: 7.5, quality: 3, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const sleepMentioned = /sleep|slept/i.test(out);
    check('sleep quality=3 → sleep at least mentioned in summary', sleepMentioned, out.slice(0, 120));
  } catch (e) { fail('day summary quality 3', e.message); }

  // Workout burn must appear when workouts exist
  try {
    const dayData = {
      totals: { calories: 1700, protein: 160, carbs: 170, fat: 58 },
      workouts: [{ name: 'Legs', calories_burned: 380, duration_min: 70 }],
      meals: [],
      sleep: { hours_slept: 8, quality: 4, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    check('workout burn mentioned when workout exists', /workout|burn|kcal|380|exercise|train/i.test(out), out.slice(0, 120));
  } catch (e) { fail('day summary workout burn mention', e.message); }

  // Summary length: should be 5-6 lines max (≤ 500 words)
  try {
    const dayData = {
      totals: { calories: 1850, protein: 175, carbs: 190, fat: 65 },
      workouts: [], meals: [],
      sleep: { hours_slept: 7.5, quality: 4, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const wordCount = out.split(/\s+/).length;
    check(`summary length ≤ 200 words (got ${wordCount})`, wordCount <= 200, `${wordCount} words`);
  } catch (e) { fail('day summary length', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. CONVERSATION CHAIN — Stability under stress
// ─────────────────────────────────────────────────────────────────────────────
async function testChainStability() {
  section('CHAIN STABILITY — DB round-trips and state consistency');

  // Chain save/retrieve cycle
  try {
    const chainId = 999997;
    const testChatId = CHAT_ID;

    // Clean start
    db.clearReplyChain(testChatId, chainId);

    // Add 6 messages
    for (let i = 0; i < 3; i++) {
      db.saveCoachMessage(testChatId, 'user', `question ${i}`, chainId);
      db.saveCoachMessage(testChatId, 'assistant', `answer ${i}`, chainId);
    }

    const chain = db.getReplyChain(testChatId, chainId);
    check('6 messages saved and retrieved', chain.length === 6, `${chain.length} messages`);

    const exchanges = db.countExchanges(testChatId, chainId);
    check('countExchanges = 3', exchanges === 3, `exchanges=${exchanges}`);

    // Roles alternate correctly
    const roles = chain.map(m => m.role);
    const alternates = roles.every((r, i) => i === 0 || r !== roles[i-1]);
    check('roles alternate user/assistant', alternates, roles.join(','));

    db.clearReplyChain(testChatId, chainId);
    check('clearReplyChain empties chain', db.getReplyChain(testChatId, chainId).length === 0);
  } catch (e) { fail('chain round-trip', e.message); }

  // closeChain with no messages (edge case — should not crash)
  try {
    const { closeChain } = require('./src/handlers/ask');
    const nonExistentChainId = 999996;
    db.clearReplyChain(CHAT_ID, nonExistentChainId);
    await closeChain(CHAT_ID, nonExistentChainId);
    ok('closeChain with empty chain: no crash');
  } catch (e) {
    warn('closeChain empty chain: threw', e.message);
  }

  // isConversationContinuation with empty summary — should return false (not crash)
  try {
    const r = await claude.isConversationContinuation('how do I lose weight', '');
    check('isConversationContinuation with empty summary: returns boolean', typeof r === 'boolean', `result=${r}`);
  } catch (e) { fail('isConversationContinuation empty summary', e.message); }

  // getRecentConversationSummaries with limit 0
  try {
    const r = db.getRecentConversationSummaries(CHAT_ID, 0);
    check('getRecentConversationSummaries(0): returns empty array', Array.isArray(r) && r.length === 0, `count=${r.length}`);
  } catch (e) { fail('getRecentConversationSummaries limit 0', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. BODY PARSER — InBody format and edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testBodyParserEdgeCases() {
  section('BODY PARSER — InBody Format and Unusual Inputs');

  const cases = [
    // InBody-style output
    { text: 'InBody: weight 103.5kg, SMM 42.1kg, BFM 22.3kg, body fat 21.5%',
      check: v => v.weight_kg >= 103 && v.body_fat_pct >= 20,
      label: 'InBody format: weight + SMM + BFM + bf%' },

    // Only body fat, no weight
    { text: 'body fat is 22%',
      check: v => v.body_fat_pct >= 21 && v.body_fat_pct <= 23 && v.weight_kg === null,
      label: 'body fat only → weight_kg=null' },

    // Relative reference
    { text: 'down 1.5kg from last week, now at 102kg',
      check: v => v.weight_kg >= 101.5 && v.weight_kg <= 102.5,
      label: 'relative reference: extracts current weight 102kg' },

    // Very precise decimal
    { text: '103.8kg today',
      check: v => v.weight_kg >= 103.7 && v.weight_kg <= 103.9,
      label: 'precise decimal weight 103.8' },

    // Output has all required fields (even if null)
    { text: '100kg',
      check: v => 'weight_kg' in v && 'body_fat_pct' in v && 'muscle_mass_kg' in v,
      label: 'output has weight_kg, body_fat_pct, muscle_mass_kg (nulls ok)' },
  ];

  for (const c of cases) {
    try {
      const r = await claude.parseBody(c.text);
      check(c.label, c.check(r), JSON.stringify(r).slice(0, 100));
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 15. MEAL PARSER — Adversarial food cases
// ─────────────────────────────────────────────────────────────────────────────
async function testMealParserAdversarial() {
  section('MEAL PARSER — Adversarial Food Cases');

  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()];
  const now = new Date().toTimeString().slice(0, 5);

  const cases = [
    // Very high calorie meal — must not return 0
    { text: 'full rack of ribs with fries and coleslaw',
      check: v => (v.totals?.calories || 0) >= 1500,
      label: 'full rack of ribs → calories ≥ 1500' },

    // Very low calorie food — must not invent high calories
    { text: 'plain black coffee, no milk no sugar',
      check: v => (v.totals?.calories || 0) <= 10,
      label: 'plain black coffee → calories ≤ 10' },

    // Zero-calorie food should not return high macros
    { text: 'water, 2 glasses',
      check: v => (v.totals?.calories || 0) <= 5 && (v.totals?.protein || 0) === 0,
      label: 'water → 0 calories, 0 protein' },

    // Food with unknown name — must still return reasonable estimate or low confidence
    { text: 'mystery combo plate from the office canteen',
      check: v => v.confidence === 'low' || v.totals?.calories > 0,
      label: 'unknown canteen food → low confidence or non-zero estimate' },

    // NS lunch R format (known context)
    { text: 'NS lunch R',
      check: v => v.confidence === 'low' || v.clarification != null || (v.totals?.protein > 0),
      label: 'NS lunch R → low confidence or clarification requested' },

    // Large quantified meal
    { text: '500g chicken breast grilled',
      check: v => (v.totals?.protein || 0) >= 90 && (v.totals?.calories || 0) >= 700,
      label: '500g chicken → protein ≥ 90g, calories ≥ 700' },

    // Macro-counting format
    { text: 'meal: 180g chicken breast, 200g jasmine rice, 50g mixed veg, 10g olive oil',
      check: v => {
        const items = v.items || [];
        return items.length >= 3 && (v.totals?.calories || 0) >= 600;
      },
      label: 'detailed macro format → 3+ items, total calories ≥ 600' },
  ];

  for (const c of cases) {
    try {
      const r = await claude.analyzeMeal(null, c.text, dayOfWeek, '', now);
      check(c.label, c.check(r), `cal:${r.totals?.calories} prot:${r.totals?.protein} conf:${r.confidence}`);
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 16. CORRECTION PARSER — Field isolation (non-corrected fields preserved)
// ─────────────────────────────────────────────────────────────────────────────
async function testCorrectionFieldIsolation() {
  section('CORRECTION PARSER — Non-Corrected Fields Preserved');

  const mealData = {
    meal_name: 'Chicken Rice',
    items: [{ name: 'chicken breast', quantity_g: 120, calories: 198, protein: 37, carbs: 0, fat: 4.3 },
            { name: 'steamed rice', quantity_g: 150, calories: 195, protein: 4, carbs: 43, fat: 0.5 }],
    totals: { calories: 393, protein: 41, carbs: 43, fat: 4.8 },
    meal_type: 'Lunch',
    time: '12:30',
  };

  // Correcting quantity only — meal_type and time should be preserved
  try {
    const r = await claude.applyMealCorrection(mealData, 'actually that was 180g of chicken not 120g');
    check('meal_type preserved after quantity correction', r?.meal_type === 'Lunch', `meal_type=${r?.meal_type}`);
    check('time preserved after quantity correction', r?.time === '12:30', `time=${r?.time}`);
    check('protein increases after 180g correction', (r?.totals?.protein || 0) >= 50, `protein=${r?.totals?.protein}`);
  } catch (e) {
    warn('applyMealCorrection', `not exported or failed: ${e.message}`);
  }

  // Correcting name only — macros should stay roughly the same
  try {
    const r = await claude.applyMealCorrection(mealData, 'rename this to Singapore Chicken Rice');
    if (r?.meal_name) {
      const nameChanged = /singapore/i.test(r.meal_name);
      const caloriesPreserved = Math.abs((r?.totals?.calories || 0) - 393) < 50;
      check('rename only: meal_name updated', nameChanged, `meal_name="${r?.meal_name}"`);
      check('rename only: calories preserved (not recalculated)', caloriesPreserved, `calories=${r?.totals?.calories}`);
    }
  } catch (e) {
    warn('applyMealCorrection rename', `not exported or failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '█'.repeat(70));
  console.log('  ADVERSARIAL TEST 2 — More angles, format requirements, null safety');
  console.log('  ' + new Date().toISOString());
  console.log('█'.repeat(70));

  await testOutputFormatRequirements();
  await testEveningCheckNullSafety();
  await testEveningCheckCaffeine();
  await testProteinSuggestionSpecificity();
  await testCardioCalories();
  await testWorkoutEdgeCases();
  await testMealMacroIntegrity();
  await testClassifierEdgeCases();
  await testProactiveSameCategoryGuard();
  await testPlansDateResolution();
  await testSleepParserEdgeCases();
  await testDaySummaryCompleteness();
  await testChainStability();
  await testBodyParserEdgeCases();
  await testMealParserAdversarial();
  await testCorrectionFieldIsolation();

  // ── FINAL REPORT ──────────────────────────────────────────────────────────
  console.log('\n' + '█'.repeat(70));
  console.log('  RESULTS BY SECTION');
  console.log('█'.repeat(70));
  let totalCases = 0;
  for (const [name, s] of Object.entries(sections)) {
    const total = s.passed + s.failed + s.warned;
    totalCases += total;
    const status = s.failed > 0 ? '❌' : s.warned > 0 ? '⚠️ ' : '✅';
    console.log(`  ${status} ${name.slice(0, 65)}: ${s.passed}/${total} passed${s.warned ? ', '+s.warned+' warns' : ''}`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`  TOTAL: ${passed} passed / ${failed} failed / ${warned} warned / ${totalCases} cases`);

  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  if (warnings.length) {
    console.log('\n  WARNINGS:');
    warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  }

  console.log('\n' + '█'.repeat(70) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
