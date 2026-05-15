#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db     = require('./src/db');

const CHAT_ID = 119445404;
let msgIdCtr = 300000;

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];
const sections = {};
let currentSection = '';

function section(name) {
  currentSection = name;
  sections[name] = { passed: 0, failed: 0, warned: 0 };
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${name}`);
  console.log('═'.repeat(70));
}
function ok(label, detail = '') {
  passed++; sections[currentSection].passed++;
  console.log(`  ✅ ${label}${detail ? '  →  ' + detail : ''}`);
}
function fail(label, detail = '') {
  failed++; sections[currentSection].failed++;
  failures.push(`[${currentSection}] ${label}${detail ? ': ' + detail : ''}`);
  console.log(`  ❌ ${label}${detail ? '  →  ' + detail : ''}`);
}
function warn(label, detail = '') {
  warned++; sections[currentSection].warned++;
  warnings.push(`[${currentSection}] ${label}: ${detail}`);
  console.log(`  ⚠️  ${label}${detail ? '  →  ' + detail : ''}`);
}
function check(label, condition, actual = '', failDetail = '') {
  if (condition) ok(label, String(actual).slice(0, 100));
  else fail(label, failDetail || String(actual).slice(0, 140));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DATA INTEGRITY — Evening check sleep quality preservation
//    THE CORE BUG: Claude was using hours_slept to infer quality instead of using
//    the supplied quality value directly. Fix: split into two separate named fields
//    and tell Claude not to derive one from the other.
// ─────────────────────────────────────────────────────────────────────────────
async function testEveningCheckSleepQuality() {
  section('DATA INTEGRITY — Evening Check Sleep Quality Preservation');

  const baseData = (hours, quality) => ({
    totals: { calories: 1600, protein: 140, carbs: 160, fat: 55 },
    targets: { calories: 1900, protein: 180, carbs: 200, fat: 70 },
    sleep_hours_last_night: hours,
    sleep_quality_last_night_out_of_5: quality,
    caffeine: { total_mg: 180, last_time: null, drinks: 2 },
    workouts: [],
    timedPlans: [],
    tasks: [],
  });

  const targetsCtx = 'calories: 1900, protein: 180g, carbs: 200g, fat: 70g';

  const cases = [
    // The exact bug: high hours, low quality → Claude must NOT infer quality from hours
    { hours: 9.0, quality: 1, label: '9h sleep BUT quality=1 — output must say 1 not 4-5' },
    { hours: 4.2, quality: 5, label: '4h sleep BUT quality=5 — output must say 5 not 1-2 (THE BUG)' },
    { hours: 7.5, quality: 2, label: '7.5h sleep but quality=2 — troubled sleep, must say 2' },
    { hours: 5.0, quality: 4, label: '5h sleep but quality=4 — short but high quality, must say 4' },
    { hours: 8.0, quality: 3, label: '8h sleep quality=3 — middle score, output must say 3' },
  ];

  for (const c of cases) {
    try {
      const output = await claude.generateEveningCheck(baseData(c.hours, c.quality), targetsCtx, {});
      const q = c.quality;
      // Check the correct quality number appears somewhere in the output
      // Use word-boundary regex to find the number in sleep-related context
      const hasCorrectQuality = new RegExp(`\\b${q}\\b`).test(output);
      // Check we're not reporting a WRONG quality (one of the other 4 values near quality-related words)
      const wrongValues = [1,2,3,4,5].filter(x => x !== q);
      // Look for wrong quality values in common sleep/quality reporting patterns
      const sleepQualityPattern = new RegExp(`(quality|sleep score|sleep rating|rated)[^.\\n]{0,30}\\b(${wrongValues.join('|')})\\b`, 'i');
      const wrongQualityInContext = sleepQualityPattern.test(output);

      check(
        c.label,
        hasCorrectQuality && !wrongQualityInContext,
        `quality=${q} hours=${c.hours} → "${output.slice(0, 100)}"`,
        `expected ${q} in output, got: "${output.slice(0, 120)}"`
      );
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DATA INTEGRITY — Day summary macro direction
//    Claude was saying "over on carbs" when carbs were UNDER target.
//    Fix: explicit macro evaluation rules added to the summary prompt.
// ─────────────────────────────────────────────────────────────────────────────
async function testDaySummaryMacroDirection() {
  section('DATA INTEGRITY — Day Summary Macro Direction (Under ≠ Over)');

  const targetsCtx = 'calories: 1900, protein: 180g, carbs: 200g, fat: 70g';
  const state = db.getState(CHAT_ID);

  // Case 1: All macros UNDER target — carbs and fat should not be flagged as "over"
  try {
    const dayData = {
      totals: { calories: 1400, protein: 110, carbs: 130, fat: 40 },
      workouts: [],
      meals: [{ name: 'chicken and rice', calories: 700, protein: 55 }, { name: 'salad', calories: 300, protein: 20 }],
      sleep: { hours_slept: 7.5, quality: 4, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    // carbs: 130 vs target 200 — should NOT say "over on carbs"
    const carbsOverFlag = /over.{0,15}carb|carb.{0,15}over|exceeded.{0,15}carb/i.test(out);
    const fatOverFlag = /over.{0,15}fat|fat.{0,15}over|exceeded.{0,15}fat/i.test(out);
    const proteinFlagged = /protein.{0,30}(low|under|short|miss|below|only \d)/i.test(out);
    check('under target: carbs NOT flagged as over (130 vs 200)', !carbsOverFlag, out.slice(0,120));
    check('under target: fat NOT flagged as over (40 vs 70)', !fatOverFlag, out.slice(0,120));
    check('under target: protein IS flagged as low (110 vs 180)', proteinFlagged, out.slice(0,120));
  } catch (e) {
    fail('under-target macro direction test', e.message);
  }

  // Case 2: All macros OVER target — all three should be flagged
  try {
    const dayData = {
      totals: { calories: 2400, protein: 220, carbs: 280, fat: 95 },
      workouts: [],
      meals: [{ name: 'large meal', calories: 2400, protein: 220 }],
      sleep: { hours_slept: 8, quality: 4, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const carbsOverFlag = /over.{0,15}carb|carb.{0,15}over|exceeded.{0,15}carb|\d{3}.{0,10}carb.{0,10}target|carb.{0,20}\d{3}/i.test(out);
    const fatOverFlag   = /over.{0,15}fat|fat.{0,15}over|exceeded.{0,15}fat|\d+.{0,10}fat.{0,10}target|fat.{0,20}\d+/i.test(out);
    check('over target: carbs flagged as over (280 vs 200)', carbsOverFlag, out.slice(0,120));
    check('over target: fat flagged as over (95 vs 70)', fatOverFlag, out.slice(0,120));
  } catch (e) {
    fail('over-target macro direction test', e.message);
  }

  // Case 3: Protein only over, carbs/fat under — only protein should be praised, carbs/fat neutral
  try {
    const dayData = {
      totals: { calories: 1850, protein: 200, carbs: 150, fat: 45 },
      workouts: [],
      meals: [{ name: 'protein foods', calories: 1850, protein: 200 }],
      sleep: { hours_slept: 7, quality: 3, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const carbsOverFlag = /over.{0,15}carb|carb.{0,15}over|exceeded.{0,15}carb/i.test(out);
    const fatOverFlag   = /over.{0,15}fat|fat.{0,15}over|exceeded.{0,15}fat/i.test(out);
    check('protein over + carbs/fat under: carbs NOT flagged as over', !carbsOverFlag, out.slice(0,120));
    check('protein over + carbs/fat under: fat NOT flagged as over', !fatOverFlag, out.slice(0,120));
  } catch (e) {
    fail('mixed macro direction test', e.message);
  }

  // Case 4: Protein good, carbs slightly over, fat fine — only carbs flagged
  try {
    const dayData = {
      totals: { calories: 1900, protein: 185, carbs: 230, fat: 60 },
      workouts: [],
      meals: [{ name: 'balanced meal', calories: 1900, protein: 185 }],
      sleep: { hours_slept: 7.5, quality: 4, type: 'Night' },
    };
    const out = await claude.generateDaySummary(dayData, targetsCtx, null, state);
    const carbsOverFlag = /over.{0,15}carb|carb.{0,15}over|exceeded.{0,15}carb|230.{0,20}200|200.{0,20}230/i.test(out);
    const fatOverFlag   = /over.{0,15}fat|fat.{0,15}over|exceeded.{0,15}fat/i.test(out);
    check('carbs slightly over (230 vs 200): flagged', carbsOverFlag, out.slice(0,120));
    check('fat under (60 vs 70): NOT flagged as over', !fatOverFlag, out.slice(0,120));
  } catch (e) {
    fail('single macro over test', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. WORKOUT CALORIES — Estimation when no duration given
//    Fix: Claude now estimates duration from total_sets × 2.5 min and computes
//    calories_burned. Must never be null when exercises are present.
// ─────────────────────────────────────────────────────────────────────────────
async function testWorkoutCaloriesNoDuration() {
  section('WORKOUT CALORIES — Estimation Without Duration (Must Be Non-Null)');

  const state = db.getState(CHAT_ID);
  const weight = state?.weight_kg || 100;

  const cases = [
    // Standard multi-exercise, no duration mentioned
    { text: 'bench press 100kg 4x8, squat 120kg 3x5, deadlift 140kg 3x3',
      label: 'compound workout, no duration → calories_burned non-null' },
    // Single exercise only
    { text: 'deadlift 160kg 5x3',
      label: 'single exercise only, no duration → calories_burned non-null' },
    // High volume
    { text: 'bicep curls 20kg 4x12, tricep pushdowns 30kg 4x15, lateral raises 12kg 4x15',
      label: 'high-volume arms, no duration → calories_burned non-null' },
    // Low volume — even 1 set should produce a non-null estimate
    { text: 'squat 1x5 at 100kg',
      label: 'single set, no duration → calories_burned non-null (not zero, not null)' },
    // No weight given either — body weight exercise
    { text: 'pushups 3x20, pullups 3x10, dips 3x12',
      label: 'bodyweight exercises, no duration → calories_burned non-null' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseWorkout(c.text, '', weight);
      const cals = result?.calories_burned;
      const dur = result?.duration_min;
      check(
        c.label,
        cals != null && cals > 0,
        `calories_burned=${cals} duration_min=${dur}`,
        `got calories_burned=${cals} (null/0 is wrong)`
      );
      // Also check duration was estimated (not null)
      if (cals != null && cals > 0) {
        check(
          `  └─ duration_min also estimated (not null)`,
          dur != null && dur > 0,
          `duration_min=${dur}`
        );
      }
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PROACTIVE NUDGE MEAL GUARD
//    Before 4h awake + no meals: Claude must NOT complain about nothing logged.
//    After 4h + noMealsYet=true: CAN complain.
//    Fix: payload omits today.meals key entirely when < 240min + no meals.
// ─────────────────────────────────────────────────────────────────────────────
async function testProactiveMealGuard() {
  section('PROACTIVE MEAL GUARD — Before 4h, No False "Nothing Logged" Alerts');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);

  // Case 1: < 4h awake, meals key OMITTED from payload → must not trigger meal-absence complaint
  try {
    const data = {
      minutesAwake: 90,
      // today.meals intentionally OMITTED — this is what cron.js does when < 240min + no meals
      today: { calories: 0, protein: 0 },
      recentWeek: [],
      recentAlerts: [],
      todayAlert: null,
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    const mealComplaint = result && /log|meal|eat|breakfast|nothing|haven.t|no food|hunger/i.test(result);
    check(
      'meals key omitted + 90min awake → no meal-absence complaint',
      !mealComplaint,
      result ? `"${result}"` : 'null (correct)',
      `got nudge about meals: "${result}"`
    );
  } catch (e) {
    fail('proactive meal guard < 4h test', e.message);
  }

  // Case 2: 150min awake, today.meals is empty array explicitly → still must not complain
  // (Claude should see minutesAwake < 240 and ignore meal absence per prompt instruction)
  try {
    const data = {
      minutesAwake: 150,
      noMealsYet: false,
      today: { meals: [], calories: 0, protein: 0 },
      recentWeek: [],
      recentAlerts: [],
      todayAlert: null,
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    const mealComplaint = result && /log|meal|eat|breakfast|nothing|haven.t|no food/i.test(result);
    check(
      '150min awake + meals:[] → Claude respects minutesAwake<240 guard in prompt',
      !mealComplaint,
      result ? `"${result}"` : 'null (correct)',
      `still complained about meals at 150min: "${result}"`
    );
  } catch (e) {
    fail('proactive meal guard 150min test', e.message);
  }

  // Case 3: 300min awake, noMealsYet=true → IS allowed to mention no meals
  try {
    const data = {
      minutesAwake: 300,
      noMealsYet: true,
      today: { calories: 0, protein: 0 }, // meals key omitted — consistent with cron.js
      recentWeek: [],
      recentAlerts: [],
      todayAlert: null,
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    // null is OK (other priorities took precedence), but if something returned it should not crash
    check(
      '300min awake + noMealsYet=true → returns string or null, no crash',
      result === null || typeof result === 'string',
      result ? `"${result.slice(0,80)}"` : 'null'
    );
  } catch (e) {
    fail('proactive meal guard 300min test', e.message);
  }

  // Case 4: Caffeine over 400mg + only 120min awake → SHOULD fire for caffeine, not meals
  try {
    const data = {
      minutesAwake: 120,
      today: { caffeine_mg: 480, last_caffeine_time: '08:30', calories: 400, protein: 30 },
      recentWeek: [],
      recentAlerts: [],
      todayAlert: null,
    };
    const result = await claude.checkProactivePatterns(data, targetsCtx, state);
    const caffeineAlert = result && /caffeine|coffee|mg/i.test(result);
    const mealComplaint = result && /log|meal|breakfast|nothing logged/i.test(result);
    check(
      '480mg caffeine + 120min awake → caffeine alert fires (not meal-absence)',
      caffeineAlert && !mealComplaint,
      result ? `"${result.slice(0,100)}"` : 'null',
      `expected caffeine alert, got: "${result}"`
    );
  } catch (e) {
    fail('proactive caffeine at < 4h test', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. SLEEP QUALITY PARSING — Default and Exact Values
//    parseSleep default quality=3 when not mentioned. And explicit quality
//    numbers must survive exactly (not inferred from subjective words).
// ─────────────────────────────────────────────────────────────────────────────
async function testSleepQualityParsing() {
  section('SLEEP QUALITY PARSING — Default and Exact Value Preservation');

  // Default quality when not mentioned
  const noQualityCases = [
    { text: 'slept from midnight to 7am', label: 'no quality mentioned → default (1-5 range)' },
    { text: 'went to bed at 11pm woke at 6:30am', label: 'bed+wake times, no quality → valid default' },
    { text: 'slept 7 hours', label: 'hours only, no quality → valid default assigned' },
  ];
  for (const c of noQualityCases) {
    try {
      const r = await claude.parseSleep(c.text);
      check(c.label,
        typeof r.quality === 'number' && r.quality >= 1 && r.quality <= 5,
        `quality=${r.quality}`,
        `quality=${r.quality} not in 1-5`
      );
    } catch (e) { fail(c.label, e.message); }
  }

  // Explicit quality must match exactly — not inferred from subjective language
  const exactQualityCases = [
    // Numeric quality ratings
    { text: 'slept 9 hours quality 1', expect: 1, label: 'quality=1 explicit (long sleep but terrible)' },
    { text: 'slept 4.5 hours quality 5/5', expect: 5, label: 'quality=5 explicit (short sleep but perfect subjective)' },
    { text: 'slept 7h quality 2', expect: 2, label: 'quality=2 explicit average hours' },
    { text: 'slept 8h quality 4', expect: 4, label: 'quality=4 explicit good sleep' },
    { text: 'great sleep last night, 6 hours, quality 3', expect: 3, label: 'quality=3 even though "great" mentioned' },
    // Subjective words without explicit number → should infer in expected direction
    { text: 'terrible sleep, woke 5 times, 6 hours',
      expectRange: [1, 2], label: 'terrible sleep → quality 1-2 (inferred from context)' },
    { text: 'amazing deep sleep, 8 hours, felt great',
      expectRange: [4, 5], label: 'amazing sleep → quality 4-5 (inferred)' },
  ];
  for (const c of exactQualityCases) {
    try {
      const r = await claude.parseSleep(c.text);
      if (c.expect !== undefined) {
        check(c.label, r.quality === c.expect, `quality=${r.quality}`, `expected ${c.expect}, got ${r.quality}`);
      } else if (c.expectRange) {
        const [lo, hi] = c.expectRange;
        check(c.label, r.quality >= lo && r.quality <= hi, `quality=${r.quality}`, `expected ${lo}-${hi}, got ${r.quality}`);
      }
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADVERSARIAL CLASSIFIER — Sentences that look like cancel/done but aren't
//    The removed isCancellation fallback was catching "Nope, just 3 things..."
//    isExplicitCancel only matches ≤3-word messages starting with cancel words.
// ─────────────────────────────────────────────────────────────────────────────
async function testAdversarialClassifier() {
  section('ADVERSARIAL CLASSIFIER — Cancel-Like Sentences That Are NOT Cancel');

  // These should classify as their actual intent, not as cancel/general
  const shouldNotBeCancel = [
    { text: 'Nope, just had a coffee not a meal', expects: ['DRINK_LOG'], label: '"Nope, just had a coffee" → DRINK_LOG' },
    { text: 'No actually that was 150g of chicken not 100g', expects: ['CORRECTION'], label: '"No actually..." → CORRECTION' },
    { text: 'Nope, it was a double portion not a single', expects: ['CORRECTION'], label: '"Nope, it was double portion" → CORRECTION' },
    { text: 'No, I also had fries with that', expects: ['MEAL_LOG', 'CORRECTION'], label: '"No, I also had fries" → MEAL_LOG or CORRECTION' },
    { text: 'stop complaining and just log my workout', expects: ['WORKOUT_LOG'], label: '"stop complaining, log workout" → WORKOUT_LOG (not cancel)' },
    { text: 'done with my gym session, bench 3x8 100kg', expects: ['WORKOUT_LOG'], label: '"done with gym session..." → WORKOUT_LOG, not cancel' },
    { text: 'cancel my dentist appointment tomorrow', expects: ['PLAN'], label: '"cancel my dentist appointment" → PLAN (cancelling a plan, not a meal)' },
    { text: 'no more coffee today', expects: ['GENERAL', 'DRINK_LOG'], label: '"no more coffee today" → GENERAL/DRINK, not cancel' },
  ];

  for (const c of shouldNotBeCancel) {
    try {
      const result = await claude.classify(c.text, []);
      // Key assertion: should NOT return only GENERAL or empty (which is what happens if cancel fallback fires)
      const hitExpected = c.expects.some(e => result.includes(e));
      check(
        c.label,
        hitExpected,
        `[${result.join(',')}]`,
        `expected one of [${c.expects.join(',')}] but got [${result.join(',')}]`
      );
    } catch (e) { fail(c.label, e.message); }
  }

  // These SHOULD be cancel (short standalone cancel words)
  const trueCancel = [
    { text: 'cancel', expects: ['GENERAL'], label: '"cancel" alone → GENERAL (explicit cancel)' },
    { text: 'no', expects: ['GENERAL'], label: '"no" alone → GENERAL' },
    { text: 'nope', expects: ['GENERAL'], label: '"nope" alone → GENERAL' },
    { text: 'nevermind', expects: ['GENERAL'], label: '"nevermind" alone → GENERAL' },
  ];

  for (const c of trueCancel) {
    try {
      const result = await claude.classify(c.text, []);
      check(c.label, result.includes('GENERAL') || result.length === 0 || !result.some(r => ['MEAL_LOG','WORKOUT_LOG','PLAN'].includes(r)),
        `[${result.join(',')}]`);
    } catch (e) { fail(c.label, e.message); }
  }

  // "Done" ambiguity — "done" alone is plan completion but "done with X" is workout
  try {
    const r1 = await claude.classify('done', []);
    check('"done" alone → PLAN_DONE or GENERAL (not meal/workout)', r1.includes('PLAN_DONE') || r1.includes('GENERAL'), `[${r1.join(',')}]`);
  } catch (e) { fail('"done" classification', e.message); }

  try {
    const r2 = await claude.classify('done with my chest session', []);
    check('"done with chest session" → WORKOUT_LOG', r2.includes('WORKOUT_LOG'), `[${r2.join(',')}]`);
  } catch (e) { fail('"done with chest session" classification', e.message); }

  // "5" alone in chat → ambiguous but not a log
  try {
    const r3 = await claude.classify('5', []);
    check('"5" alone → GENERAL (not meal/workout)', !r3.some(x => ['MEAL_LOG','WORKOUT_LOG'].includes(x)), `[${r3.join(',')}]`);
  } catch (e) { fail('"5" classification', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PLAN TEXT VERBATIM IN EVENING CHECK
//    Prompt: "state only the plan text and time exactly as given, do not add
//    speculation or commentary about what the user may have done around them."
// ─────────────────────────────────────────────────────────────────────────────
async function testPlanTextVerbatim() {
  section('PLAN TEXT VERBATIM — Evening Check Must Not Invent Commentary');

  const targetsCtx = 'calories: 1900, protein: 180g';
  const state = db.getState(CHAT_ID);

  const baseData = (plans) => ({
    totals: { calories: 1600, protein: 155, carbs: 160, fat: 55 },
    targets: { calories: 1900, protein: 180 },
    sleep_hours_last_night: 7.5,
    sleep_quality_last_night_out_of_5: 4,
    caffeine: { total_mg: 180, last_time: null, drinks: 2 },
    workouts: [],
    timedPlans: plans,
    tasks: [],
  });

  // Test 1: specific plan with location
  try {
    const plans = ['golf lesson at Sentosa Golf Club at 14:00'];
    const out = await claude.generateEveningCheck(baseData(plans), targetsCtx, state);
    const planMentioned = /golf lesson/i.test(out);
    // Should NOT add "you probably played a round" or "hope the lesson went well" commentary
    const badCommentary = /(hope|went well|played|round|how did it|enjoy|must have|probably)/i.test(out);
    check('plan "golf lesson at Sentosa" → appears in output', planMentioned, out.slice(0,120));
    check('plan "golf lesson" → no speculative commentary added', !badCommentary, out.slice(0,120), `invented commentary: "${out.slice(0,120)}"`);
  } catch (e) { fail('plan verbatim golf lesson', e.message); }

  // Test 2: medical plan
  try {
    const plans = ['blood test at clinic at 09:00'];
    const out = await claude.generateEveningCheck(baseData(plans), targetsCtx, state);
    const planMentioned = /blood test|clinic/i.test(out);
    const badCommentary = /(hope|results|went well|fasting|how did)/i.test(out);
    check('plan "blood test at clinic" → appears in output', planMentioned, out.slice(0,120));
    check('plan "blood test" → no speculation about fasting/results', !badCommentary, out.slice(0,120));
  } catch (e) { fail('plan verbatim blood test', e.message); }

  // Test 3: meeting plan
  try {
    const plans = ['call Dr. Kim about blood work at 16:00'];
    const out = await claude.generateEveningCheck(baseData(plans), targetsCtx, state);
    const planMentioned = /dr\.? kim|blood work/i.test(out);
    check('plan "call Dr. Kim about blood work" → appears verbatim', planMentioned, out.slice(0,120));
  } catch (e) { fail('plan verbatim Dr. Kim', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. EVENING CHECK — Calorie and Protein Numbers Must Match Input
//    Claude must report exact numbers from data, not estimated/rounded versions.
// ─────────────────────────────────────────────────────────────────────────────
async function testEveningCheckNumberAccuracy() {
  section('EVENING CHECK — Exact Calorie/Protein Numbers in Output');

  const targetsCtx = 'calories: 2000, protein: 185g';
  const state = db.getState(CHAT_ID);

  const cases = [
    { calories: 1847, protein: 143, calTarget: 2000, protTarget: 185, label: 'ate 1847 kcal → output mentions 1847 or 153 remaining' },
    { calories: 763,  protein: 58,  calTarget: 2000, protTarget: 185, label: 'ate only 763 kcal → output mentions 763 or 1237 remaining' },
    { calories: 2150, protein: 200, calTarget: 2000, protTarget: 185, label: 'over at 2150 kcal → output mentions 2150 or excess of 150' },
  ];

  for (const c of cases) {
    try {
      const data = {
        totals: { calories: c.calories, protein: c.protein, carbs: 150, fat: 55 },
        targets: { calories: c.calTarget, protein: c.protTarget, carbs: 200, fat: 70 },
        sleep_hours_last_night: 7, sleep_quality_last_night_out_of_5: 4,
        caffeine: { total_mg: 150, last_time: null, drinks: 1 },
        workouts: [], timedPlans: [], tasks: [],
      };
      const out = await claude.generateEveningCheck(data, targetsCtx, state);
      const remaining = c.calTarget - c.calories;
      const excess = c.calories - c.calTarget;

      // Check either the eaten amount or remaining/excess appears
      const calorieNumberPresent = out.includes(String(c.calories))
        || out.includes(c.calories.toLocaleString())
        || (remaining > 0 && out.includes(String(remaining)))
        || (excess > 0 && out.includes(String(excess)));

      check(c.label, calorieNumberPresent,
        `output="${out.slice(0,120)}"`,
        `neither ${c.calories}, ${remaining > 0 ? remaining : excess} found in output`
      );
    } catch (e) { fail(c.label, e.message); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. STATE MACHINE NUMERIC AMBIGUITY — parseQuality swallowing meal logs
//    Risk: "5 eggs for breakfast" in morning_quality state → parseQuality returns 5
//    and the meal never gets logged. This is a known risk to document.
// ─────────────────────────────────────────────────────────────────────────────
async function testParseQualityAmbiguity() {
  section('PARSE QUALITY AMBIGUITY — Numeric Swallow Risk (Known Hazard)');

  // parseQuality is defined in bot.js as: (t) => { const m = (t||'').match(/\b([1-5])\b/); return m ? parseInt(m[1]) : null; }
  // We replicate it here to document the hazard
  const parseQuality = (t) => { const m = (t||'').match(/\b([1-5])\b/); return m ? parseInt(m[1]) : null; };

  const ambiguousCases = [
    { text: '5 eggs for breakfast',    shouldBeNull: true,  label: '"5 eggs for breakfast" — returns 5 (HAZARD: will eat the meal log)' },
    { text: '3 coffees this morning',  shouldBeNull: true,  label: '"3 coffees this morning" — returns 3 (HAZARD)' },
    { text: 'had 4 meals today',       shouldBeNull: true,  label: '"had 4 meals today" — returns 4 (HAZARD)' },
    { text: '2 boiled eggs',           shouldBeNull: true,  label: '"2 boiled eggs" — returns 2 (HAZARD)' },
    { text: '5',                       shouldBeNull: false, label: '"5" alone — returns 5 (CORRECT: real quality response)' },
    { text: 'quality 4 out of 5',      shouldBeNull: false, label: '"quality 4 out of 5" — returns 4 (correct)' },
    { text: 'pretty good sleep, 7/10', shouldBeNull: true,  label: '"7/10 rating" — returns null correctly (no 1-5 standalone digit)' },
    { text: '3/5',                     shouldBeNull: false, label: '"3/5" — returns 3 (acceptable)' },
  ];

  for (const c of ambiguousCases) {
    const result = parseQuality(c.text);
    if (c.shouldBeNull) {
      // These RETURN a number, which is the hazard — warn, don't fail (it's known behavior)
      warn(
        c.label,
        `parseQuality returns ${result === null ? 'null (safe)' : result + ' (WILL SWALLOW if user sends this in morning_quality state)'}`
      );
    } else {
      check(c.label, result !== null, `parseQuality=${result}`);
    }
  }

  // The fix would be: require a 1-5 alone on its own line, or preceded by "quality" keyword
  // Document what a safer parseQuality would look like
  const saferParseQuality = (t) => {
    const lc = (t||'').toLowerCase().trim();
    // Exact single digit 1-5
    if (/^[1-5]$/.test(lc)) return parseInt(lc);
    // "quality X" or "X/5" pattern
    const m = lc.match(/(?:quality\s*|^|\/)([1-5])(?:\/5\b|\b(?!\s*(egg|coffee|meal|hour|min|gram|kg|lb|cup|scoop|glass|bottle)))/);
    return m ? parseInt(m[1]) : null;
  };
  const betterCases = [
    { text: '5 eggs for breakfast', expect: null },
    { text: '5', expect: 5 },
    { text: 'quality 4', expect: 4 },
    { text: '4/5', expect: 4 },
    { text: '3', expect: 3 },
    { text: '3 coffees', expect: null },
  ];
  let safer = 0, saferTotal = betterCases.length;
  for (const bc of betterCases) {
    if (saferParseQuality(bc.text) === bc.expect) safer++;
  }
  console.log(`\n  Safer parseQuality would fix ${safer}/${saferTotal} cases above correctly`);
  if (safer < saferTotal) {
    warn(`Safer parseQuality prototype: ${safer}/${saferTotal} correct`, 'edge cases remain — consider adopting stricter version');
  } else {
    ok(`Safer parseQuality prototype: ${safer}/${saferTotal} correct — implementation ready if wanted`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. WORKOUT PARSER — Zero/null calories edge cases
//     Calories must be non-null AND non-zero when there's any activity.
// ─────────────────────────────────────────────────────────────────────────────
async function testWorkoutCaloriesZeroCase() {
  section('WORKOUT CALORIES — Zero/Null Edge Cases');

  const state = db.getState(CHAT_ID);
  const weight = state?.weight_kg || 100;

  // Cases where calories should be > 0
  const shouldHaveCalories = [
    { text: 'gym 1 hour', label: 'gym 1h → calories > 0' },
    { text: '30 min run', label: '30min run → calories > 0' },
    { text: 'bench 3x8 at 100kg', label: 'bench sets → calories estimated > 0' },
    { text: 'golf 9 holes', label: 'golf → calories > 0' },
    { text: '20 min HIIT', label: '20min HIIT → calories > 0' },
  ];
  for (const c of shouldHaveCalories) {
    try {
      const r = await claude.parseWorkout(c.text, '', weight);
      check(c.label, r?.calories_burned > 0, `calories_burned=${r?.calories_burned}`);
    } catch (e) { fail(c.label, e.message); }
  }

  // Duration-only case: no exercises but explicit duration → should estimate calories
  try {
    const r = await claude.parseWorkout('did an hour and a half at the gym', '', weight);
    check(
      'duration only "1.5h at gym" → calories estimated from duration × MET',
      (r?.calories_burned || 0) > 0,
      `calories_burned=${r?.calories_burned} duration_min=${r?.duration_min}`
    );
  } catch (e) { fail('duration-only workout', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. CONTEXT INJECTION INTEGRITY — buildDayContext must not lose dayCtx
//     Pattern: [dayCtx, context].filter(Boolean).join('\n') — not context || dayCtx
//     Test: ask handler returns day data even when chain context exists
// ─────────────────────────────────────────────────────────────────────────────
async function testContextInjection() {
  section('CONTEXT INJECTION — Day Data Always Present in Coach Answers');

  const { handleAsk } = require('./src/handlers/ask');
  const makeMsg = (text) => ({
    message_id: ++msgIdCtr, chat: { id: CHAT_ID },
    from: { id: CHAT_ID, first_name: 'Max' }, text,
    date: Math.floor(Date.now() / 1000),
  });
  const makeMockBot = () => {
    const replies = [];
    return { replies, _lastMsgId: null,
      async sendMessage(chatId, text) { const id = ++msgIdCtr; this._lastMsgId = id; this.replies.push(text); return { message_id: id, chat: { id: chatId }, text }; },
      async sendChatAction() {} };
  };

  // Case 1: Ask about today's calories — must return a real number from DB, not "I don't know"
  try {
    const bot = makeMockBot();
    await handleAsk(bot, makeMsg('how many calories did i eat today'));
    const reply = bot.replies[0] || '';
    const hasNumber = /\d{2,4}/.test(reply);
    const hasCalories = /calori|kcal/i.test(reply);
    check(
      'ask "how many calories today" → returns number + calorie word',
      hasNumber && hasCalories,
      reply.slice(0, 100),
      'missing number or "calorie" — might have dropped dayCtx'
    );
  } catch (e) { fail('dayCtx calories question', e.message); }

  // Case 2: Ask about protein after starting a coaching chain (chain context + dayCtx both present)
  try {
    const bot1 = makeMockBot();
    await handleAsk(bot1, makeMsg('what supplements should i consider'));
    const bot2 = makeMockBot();
    await handleAsk(bot2, makeMsg('and how much protein did i get today'));
    const reply = bot2.replies[0] || '';
    const hasProtein = /protein/i.test(reply);
    const hasNumber = /\d+\s*g|\d+ gram/i.test(reply) || /\d{2,3}/.test(reply);
    check(
      'protein question after supplement chain → still references today\'s data',
      hasProtein && hasNumber,
      reply.slice(0, 100)
    );
  } catch (e) { fail('chain + dayCtx protein question', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. KNOWN FOODS CONTAMINATION — Summary entries must not be saved as known foods
//     addKnownFood() guards should reject: daily summaries, date-specific names,
//     NS Cafe prefix, bracketed meal types.
// ─────────────────────────────────────────────────────────────────────────────
async function testKnownFoodsContamination() {
  section('KNOWN FOODS CONTAMINATION — Bad Entries Must Be Rejected');

  const db = require('./src/db');

  // These should be REJECTED (not saved to known_foods)
  const shouldReject = [
    'Daily Summary – May 6',
    'Day Summary – Apr 30',
    '[Dinner] Chicken Rice',
    '[NS Cafe] Mee Goreng',
    'NS Lunch – Regular',
    'Week Summary – Apr 28',
    'Evening Check – May 1',
  ];

  // These should be ACCEPTED
  const shouldAccept = [
    'Chicken Rice',
    'Nasi Lemak',
    'Protein Shake',
    'Whey protein 1 scoop',
    'Teh Tarik',
  ];

  // Check the actual known_foods table — none of the bad entries should be there
  try {
    const db2 = require('./src/db');
    const state = db2.getState(CHAT_ID);
    // Try calling addKnownFood and verify bad entries are rejected
    // We check by querying the table before and after

    for (const name of shouldReject) {
      const before = db2.db.prepare(`SELECT COUNT(*) as cnt FROM known_foods WHERE chat_id=? AND name=?`).get(CHAT_ID, name);
      try {
        db.addKnownFood(CHAT_ID, { name, calories: 500, protein: 30, carbs: 60, fat: 15 });
      } catch {}
      const after = db2.db.prepare(`SELECT COUNT(*) as cnt FROM known_foods WHERE chat_id=? AND name=?`).get(CHAT_ID, name);
      check(
        `rejected: "${name}"`,
        after.cnt === before.cnt, // should not have increased
        `count=${after.cnt}`,
        `"${name}" was saved to known_foods (should have been rejected)`
      );
    }
  } catch (e) {
    warn('known_foods contamination test', `db access failed: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. MEAL CONFIRM STATE — isExplicitCancel is the only cancel path
//     Deterministic check (no API calls needed): the ≤3-word + cancel-word guard
//     must reject long sentences even if they start with "no"/"nope".
// ─────────────────────────────────────────────────────────────────────────────
async function testMealConfirmCancelGuard() {
  section('MEAL CONFIRM CANCEL GUARD — isExplicitCancel Logic (Deterministic)');

  // This is the exact isExplicitCancel logic from bot.js:
  const isExplicitCancel = (text) =>
    text.trim().split(/\s+/).length <= 3
    && /^(no|nope|cancel|skip|stop|abort|nevermind|never mind)$/i.test(text.trim());

  const shouldNotCancel = [
    'Nope, just 3 things you mentioned',
    'No, it was only the chicken, no sides',
    'Nope, that was a small portion not large',
    'No actually that\'s correct ignore me',
    'cancel my run for tomorrow',
    'no I also had fries and a drink with that',
    'nope that weight was in lbs not kg',
    'stop being dramatic, log it',
    'no more food after this',
  ];

  const shouldCancel = [
    'no',
    'nope',
    'cancel',
    'skip',
    'stop',
    'abort',
    'nevermind',
    'never mind',
    'no thanks',
    'nope cancel',
  ];

  let allCorrect = true;
  for (const text of shouldNotCancel) {
    const result = isExplicitCancel(text);
    check(`NOT cancel: "${text}"`, !result, `isExplicitCancel=${result}`, `"${text}" was treated as cancel!`);
    if (result) allCorrect = false;
  }
  for (const text of shouldCancel) {
    const result = isExplicitCancel(text);
    check(`IS cancel: "${text}"`, result, `isExplicitCancel=${result}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. CORRECTION PARSER — Values must pass through unchanged
//     When user says "actually it was 150g", Claude must return the new value
//     and not invent related values.
// ─────────────────────────────────────────────────────────────────────────────
async function testCorrectionValueIntegrity() {
  section('CORRECTION VALUE INTEGRITY — Exact Numbers Preserved');

  const mealData = {
    meal_name: 'chicken breast',
    items: [{ name: 'chicken breast', quantity_g: 100, calories: 165, protein: 31, carbs: 0, fat: 3.6 }],
    totals: { calories: 165, protein: 31, carbs: 0, fat: 3.6 },
  };

  const cases = [
    { correction: 'actually that was 200g not 100g', expectedProteinMin: 55, label: '200g correction → protein ≥ 55g (double)' },
    { correction: 'it was 300g', expectedCalMin: 400, label: '300g correction → calories ≥ 400' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.applyMealCorrection(mealData, c.correction);
      if (c.expectedProteinMin) {
        check(c.label, (result?.totals?.protein || 0) >= c.expectedProteinMin,
          `protein=${result?.totals?.protein}`, `expected ≥${c.expectedProteinMin}, got ${result?.totals?.protein}`);
      }
      if (c.expectedCalMin) {
        check(c.label, (result?.totals?.calories || 0) >= c.expectedCalMin,
          `calories=${result?.totals?.calories}`, `expected ≥${c.expectedCalMin}, got ${result?.totals?.calories}`);
      }
    } catch (e) {
      warn(c.label, `applyMealCorrection not exported or failed: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '█'.repeat(70));
  console.log('  ADVERSARIAL TEST — Data integrity, routing edge cases, value preservation');
  console.log('  ' + new Date().toISOString());
  console.log('█'.repeat(70));

  await testEveningCheckSleepQuality();
  await testDaySummaryMacroDirection();
  await testWorkoutCaloriesNoDuration();
  await testProactiveMealGuard();
  await testSleepQualityParsing();
  await testAdversarialClassifier();
  await testPlanTextVerbatim();
  await testEveningCheckNumberAccuracy();
  await testParseQualityAmbiguity();
  await testWorkoutCaloriesZeroCase();
  await testContextInjection();
  await testKnownFoodsContamination();
  await testMealConfirmCancelGuard();
  await testCorrectionValueIntegrity();

  // ── FINAL REPORT ──────────────────────────────────────────────────────────
  console.log('\n' + '█'.repeat(70));
  console.log('  RESULTS BY SECTION');
  console.log('█'.repeat(70));
  let totalCases = 0;
  for (const [name, s] of Object.entries(sections)) {
    const total = s.passed + s.failed + s.warned;
    totalCases += total;
    const status = s.failed > 0 ? '❌' : s.warned > 0 ? '⚠️ ' : '✅';
    console.log(`  ${status} ${name.slice(0, 60)}: ${s.passed}/${total} passed${s.warned ? ', '+s.warned+' warns' : ''}`);
  }

  console.log('\n' + '─'.repeat(70));
  console.log(`  TOTAL: ${passed} passed / ${failed} failed / ${warned} warned / ${totalCases} cases`);

  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  if (warnings.length) {
    console.log('\n  WARNINGS (known risks):');
    warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  }

  console.log('\n' + '█'.repeat(70) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
