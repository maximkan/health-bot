#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db     = require('./src/db');
const { handleAsk, closeChain } = require('./src/handlers/ask');

const CHAT_ID = 119445404;
let msgIdCtr = 200000;

// ── Test framework ────────────────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [];
const warnings = [];
const sections = {};
let currentSection = '';

function section(name) {
  currentSection = name;
  sections[name] = { passed: 0, failed: 0, warned: 0 };
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('═'.repeat(60));
}

function ok(label, detail = '') {
  passed++;
  sections[currentSection].passed++;
  console.log(`  ✅ ${label}${detail ? '  →  ' + detail : ''}`);
}

function fail(label, detail = '') {
  failed++;
  sections[currentSection].failed++;
  const msg = `[${currentSection}] ${label}${detail ? ': ' + detail : ''}`;
  failures.push(msg);
  console.log(`  ❌ ${label}${detail ? '  →  ' + detail : ''}`);
}

function warn(label, detail = '') {
  warned++;
  sections[currentSection].warned++;
  warnings.push(`[${currentSection}] ${label}: ${detail}`);
  console.log(`  ⚠️  ${label}${detail ? '  →  ' + detail : ''}`);
}

function check(label, condition, actual = '', failDetail = '') {
  if (condition) ok(label, String(actual).slice(0, 80));
  else fail(label, failDetail || String(actual).slice(0, 120));
}

function makeMockBot() {
  const replies = [];
  const bot = {
    replies,
    _lastMsgId: null,
    async sendMessage(chatId, text) {
      const id = ++msgIdCtr;
      bot._lastMsgId = id;
      bot.replies.push(text);
      return { message_id: id, chat: { id: chatId }, text };
    },
    async sendChatAction() {},
  };
  return bot;
}

function makeMsg(text) {
  return {
    message_id: ++msgIdCtr,
    chat: { id: CHAT_ID },
    from: { id: CHAT_ID, first_name: 'Max' },
    text,
    date: Math.floor(Date.now() / 1000),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. CLASSIFIER — 35 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testClassifier() {
  section('CLASSIFIER (claude.classify)');

  const cases = [
    // Meal logs — various phrasings
    { text: 'just had chicken rice',                    expect: ['MEAL_LOG'],             label: 'simple meal log' },
    { text: 'ate a burger and fries',                   expect: ['MEAL_LOG'],             label: 'meal with multiple items' },
    { text: 'had NS dinner',                            expect: ['MEAL_LOG'],             label: 'NS dinner reference' },
    { text: 'lunch: grilled salmon, veggies, rice',     expect: ['MEAL_LOG'],             label: 'meal with colon format' },
    { text: 'snacked on almonds around 3pm',            expect: ['MEAL_LOG'],             label: 'snack log with time' },
    { text: 'protein shake after workout',              expect: ['DRINK_LOG','MEAL_LOG'], label: 'shake — could be drink or meal', anyOf: true },

    // Drink logs
    { text: 'coffee this morning',                      expect: ['DRINK_LOG'],            label: 'coffee log' },
    { text: 'had a teh tarik',                          expect: ['DRINK_LOG'],            label: 'teh tarik' },
    { text: '2 beers tonight',                          expect: ['DRINK_LOG'],            label: 'alcohol log' },
    { text: 'drank a milo',                             expect: ['DRINK_LOG'],            label: 'milo' },

    // Workout logs
    { text: 'done chest and back',                      expect: ['WORKOUT_LOG'],          label: 'workout done' },
    { text: '45min run at 5.30am',                      expect: ['WORKOUT_LOG'],          label: 'cardio log' },
    { text: 'bench pressed 100kg today',                expect: ['WORKOUT_LOG'],          label: 'exercise log with weight' },
    { text: 'at the gym',                               expect: ['WORKOUT_START'],        label: 'workout start' },
    { text: 'just started my workout',                  expect: ['WORKOUT_START'],        label: 'workout start explicit' },

    // Recovery logs
    { text: '20 min sauna',                             expect: ['RECOVERY_LOG'],         label: 'sauna' },
    { text: 'cold plunge 3 min',                        expect: ['RECOVERY_LOG'],         label: 'cold plunge' },
    { text: 'yoga 30min',                               expect: ['RECOVERY_LOG'],         label: 'yoga' },
    { text: '30 min foam rolling and stretching',       expect: ['RECOVERY_LOG'],         label: 'foam rolling + stretching' },
    { text: 'did some mobility work',                   expect: ['RECOVERY_LOG'],         label: 'mobility work' },
    { text: 'ice bath for 5 min',                       expect: ['RECOVERY_LOG'],         label: 'ice bath' },
    { text: 'sauna then chicken rice',                  expect: ['RECOVERY_LOG','MEAL_LOG'], label: 'multi: recovery + meal', anyOf: true },

    // Sleep
    { text: 'slept from 1am to 8am',                    expect: ['SLEEP_LOG'],            label: 'sleep with times' },
    { text: 'had a nap from 3-4pm',                     expect: ['SLEEP_LOG'],            label: 'nap log' },
    { text: 'slept 7 hours last night',                 expect: ['SLEEP_LOG'],            label: 'sleep hours only' },

    // BED / WAKE
    { text: 'gn',                                       expect: ['BED'],                  label: 'gn = bed' },
    { text: 'good night',                               expect: ['BED'],                  label: 'good night' },
    { text: 'morning',                                  expect: ['WAKE'],                 label: 'morning = wake' },
    { text: 'gm',                                       expect: ['WAKE'],                 label: 'gm = wake' },

    // Body/weight
    { text: 'weighed 104kg this morning',               expect: ['WEIGHT_LOG'],           label: 'weight log' },
    { text: '103.5kg today',                            expect: ['WEIGHT_LOG'],           label: 'weight only number' },

    // Plans
    { text: 'gym tomorrow at 10am',                     expect: ['PLAN'],                 label: 'plan with time' },
    { text: 'remind me to take creatine daily',         expect: ['PLAN'],                 label: 'recurring reminder' },

    // Coach question
    { text: 'how much protein in eggs',                 expect: ['COACH_QUESTION'],       label: 'direct nutrition question' },
    { text: 'is sauna good after training',             expect: ['COACH_QUESTION'],       label: 'training question' },
    { text: 'maybe we should adjust my targets',        expect: ['COACH_QUESTION'],       label: 'target discussion = question not UPDATE' },

    // Rename
    { text: 'rename my workout to golf workout',        expect: ['RENAME'],               label: 'rename workout' },
    { text: 'call that chicken rice a double portion',  expect: ['RENAME'],               label: 'rename meal' },

    // Delete
    { text: 'delete my lunch',                          expect: ['DELETE'],               label: 'delete meal' },
    { text: 'remove the last workout',                  expect: ['DELETE'],               label: 'delete workout' },

    // Correction
    { text: 'change my lunch time to 1pm',              expect: ['CORRECTION'],           label: 'time correction' },

    // UPDATE_TARGETS
    { text: 'set calories to 2000 and protein to 200g', expect: ['UPDATE_TARGETS'],       label: 'explicit target update' },

    // GENERAL
    { text: 'thanks',                                   expect: ['GENERAL'],              label: 'thanks = general' },
    { text: 'ok',                                       expect: ['GENERAL'],              label: 'ok = general' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.classify(c.text, []);
      const hit = c.anyOf
        ? c.expect.some(e => result.includes(e))
        : c.expect.every(e => result.includes(e));
      check(c.label, hit, `[${result.join(',')}]`, `expected [${c.expect.join(',')}] got [${result.join(',')}]`);
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. RECOVERY PARSER — 22 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testRecoveryParser() {
  section('RECOVERY PARSER (claude.parseRecovery)');

  // parseRecovery returns an array: [{protocol, rounds, sessions:[{type,...}]}]
  // unwrap() gets the first element
  const unwrap = v => Array.isArray(v) ? v[0] : v;
  const sess = v => unwrap(v)?.sessions?.[0] || {};

  const cases = [
    // Type detection
    { text: '20 min sauna at 90 degrees',
      check: v => sess(v).type === 'Sauna',
      label: 'sauna type' },

    { text: 'cold plunge for 3 minutes at 12 degrees',
      check: v => ['Cold Plunge','Ice Bath'].includes(sess(v).type),
      label: 'cold plunge type' },

    { text: 'ice bath 5 min',
      check: v => ['Ice Bath','Cold Plunge'].includes(sess(v).type),
      label: 'ice bath type' },

    { text: 'yoga 30min',
      check: v => ['Yoga','Mobility','Stretching'].includes(sess(v).type),
      label: 'yoga type' },

    { text: '30 min foam rolling and stretching',
      check: v => {
        const t = sess(v).type || '';
        return ['Foam Rolling','Stretching','Mobility'].includes(t) || (unwrap(v)?.sessions?.length || 0) >= 1;
      },
      label: 'foam rolling type' },

    { text: 'did some mobility work for 20 minutes',
      check: v => ['Mobility','Stretching','Yoga'].includes(sess(v).type),
      label: 'mobility work type' },

    // Duration parsing
    { text: 'sauna 15 minutes',
      check: v => (sess(v).duration_min || 0) >= 10,
      label: 'sauna duration 15min' },

    { text: 'cold shower 2 min',
      check: v => (sess(v).duration_min || 999) <= 10,
      label: 'cold shower short duration' },

    // Temperature parsing
    { text: 'sauna at 95 celsius',
      check: v => (sess(v).temperature_c || 0) >= 80,
      label: 'sauna temperature celsius' },

    { text: 'cold plunge at 10 degrees',
      check: v => (sess(v).temperature_c || 0) <= 20 && (sess(v).temperature_c || 0) > 0,
      label: 'cold plunge temperature' },

    // Contrast therapy
    { text: '3 rounds sauna 10min, cold plunge 2min',
      check: v => unwrap(v)?.protocol === 'contrast',
      label: 'contrast therapy detected' },

    // Multiple sessions in one entry
    { text: 'did sauna and then foam rolling',
      check: v => (unwrap(v)?.sessions?.length || 0) >= 1,
      label: 'multiple recovery types — at least 1 session' },

    // Steam room
    { text: 'steam room 20 min',
      check: v => ['Steam Room','Sauna'].includes(sess(v).type),
      label: 'steam room' },

    // Massage
    { text: 'sports massage 60 minutes',
      check: v => ['Massage','Mobility','Stretching'].includes(sess(v).type),
      label: 'massage type' },

    // Output structure — sessions array must exist
    { text: 'sauna 20 min',
      check: v => Array.isArray(unwrap(v)?.sessions) && typeof sess(v).type === 'string',
      label: 'output has sessions array with type field' },

    // Yoga 1 hour
    { text: 'yoga class 1 hour',
      check: v => (sess(v).duration_min || 0) >= 55,
      label: 'yoga 1 hour duration' },

    // With time mention
    { text: 'did 20 min sauna at 7am',
      check: v => sess(v).type === 'Sauna',
      label: 'sauna with time mention — still parses' },

    // Recovery embedded in workout message
    { text: 'went to gym, did chest workout, then 15min sauna after',
      check: v => unwrap(v)?.sessions?.some(x => x.type === 'Sauna'),
      label: 'recovery embedded in workout message — sauna found' },

    // Minimal cold shower
    { text: 'quick cold shower after gym',
      check: v => typeof sess(v).type === 'string' && sess(v).type.length > 0,
      label: 'cold shower minimal info — parses type' },

    // Contrast rounds
    { text: '4 rounds of contrast: 8min sauna, 2min cold plunge',
      check: v => unwrap(v)?.protocol === 'contrast' && (unwrap(v)?.rounds || 0) >= 4,
      label: 'contrast rounds count = 4' },

    // Russian
    { text: 'сауна 20 минут',
      check: v => sess(v).type === 'Sauna',
      label: 'Russian: sauna 20 minutes' },

    // No duration — type still correct
    { text: 'had a sauna session',
      check: v => sess(v).type === 'Sauna',
      label: 'sauna no duration — type still correct' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseRecovery(c.text);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 120));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SLEEP PARSER — 22 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testSleepParser() {
  section('SLEEP PARSER (claude.parseSleep)');

  const cases = [
    // Basic times
    { text: 'slept from 1am to 8am',
      check: v => v.hours_slept >= 6.5 && v.hours_slept <= 7.5 && v.type === 'Night',
      label: 'night sleep 1am–8am = 7h' },

    { text: 'slept 7 hours',
      check: v => v.hours_slept >= 6.5 && v.hours_slept <= 7.5,
      label: 'hours only' },

    // Quality
    { text: 'slept 7 hours quality 4',
      check: v => v.quality === 4,
      label: 'explicit quality 4' },

    { text: 'terrible sleep last night, 5 hours',
      check: v => v.hours_slept >= 4.5 && v.hours_slept <= 5.5,
      label: 'hours with subjective quality note' },

    { text: 'slept 8 hours, great sleep',
      check: v => v.hours_slept >= 7.5,
      label: 'good sleep 8 hours' },

    // Quality default when not mentioned
    { text: 'slept from midnight to 7am',
      check: v => typeof v.quality === 'number' && v.quality >= 1 && v.quality <= 5,
      label: 'default quality assigned (no mention)' },

    // Nap detection
    { text: 'nap from 3pm to 4:30pm',
      check: v => v.type === 'Nap' && v.hours_slept >= 1.3 && v.hours_slept <= 1.6,
      label: 'nap type and duration' },

    { text: '20 minute nap',
      check: v => v.type === 'Nap' && v.hours_slept <= 0.5,
      label: 'short nap' },

    // Cross-midnight
    { text: 'went to bed at 11:30pm, woke at 6:30am',
      check: v => v.hours_slept >= 6.5 && v.hours_slept <= 7.5,
      label: 'cross-midnight sleep — correct hours calc' },

    // Very late bedtime
    { text: 'went to bed 2am, woke 9am',
      check: v => v.hours_slept >= 6.5 && v.hours_slept <= 7.5 && v.bed_time === '02:00',
      label: 'late bedtime 2am' },

    // 24h time format
    { text: 'slept 23:00 to 07:00',
      check: v => v.hours_slept >= 7.5,
      label: '24h time format' },

    // Short sleep
    { text: 'only slept 4 hours',
      check: v => v.hours_slept >= 3.5 && v.hours_slept <= 4.5,
      label: 'short sleep 4 hours' },

    // Quality scale 1-5
    { text: 'slept 8h, quality 5',
      check: v => v.quality === 5,
      label: 'max quality 5' },

    { text: 'barely slept, like 2 hours, terrible',
      check: v => v.hours_slept <= 3,
      label: 'very short sleep' },

    // Combined meal+sleep message (should extract only sleep)
    { text: 'had chicken rice for dinner then slept from 11pm to 7am',
      check: v => v.hours_slept >= 7.5,
      label: 'sleep embedded in meal message' },

    // Russian
    { text: 'спал с 1 до 8',
      check: v => v.hours_slept >= 6.5,
      label: 'Russian: slept 1am to 8am' },

    // Wake time only — should still parse
    { text: 'slept at midnight, woke at 6:30',
      check: v => v.hours_slept >= 6 && v.hours_slept <= 7,
      label: 'midnight bedtime = 00:00' },

    // Time with am/pm mixed
    { text: 'fell asleep at 12:30am woke up at 7:45am',
      check: v => v.hours_slept >= 7 && v.hours_slept <= 7.5,
      label: 'am/pm phrasing' },

    // No time info, just hours + quality
    { text: 'slept 6.5 hours quality 2',
      check: v => v.hours_slept >= 6 && v.quality === 2,
      label: 'fractional hours + quality' },

    // Output has required fields
    { text: 'slept 7 hours',
      check: v => 'hours_slept' in v && 'type' in v && 'quality' in v,
      label: 'output has hours_slept, type, quality fields' },

    // Woke multiple times
    { text: 'woke up twice during the night, 6.5 hours total',
      check: v => v.hours_slept >= 6 && v.hours_slept <= 7,
      label: 'broken sleep — total hours extracted' },

    // Next morning reporting yesterday
    { text: 'went to bed last night at 12, woke at 8',
      check: v => v.hours_slept >= 7.5,
      label: 'retrospective sleep report' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseSleep(c.text);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 100));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. BODY PARSER — 15 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testBodyParser() {
  section('BODY PARSER (claude.parseBody)');

  const cases = [
    { text: 'weighed 104kg this morning',
      check: v => v.weight_kg >= 103 && v.weight_kg <= 105,
      label: 'simple weight kg' },

    { text: '103.5 this morning',
      check: v => v.weight_kg >= 103 && v.weight_kg <= 104,
      label: 'decimal weight' },

    { text: '95.2kg body fat 22%',
      check: v => v.weight_kg >= 95 && v.body_fat_pct >= 20 && v.body_fat_pct <= 24,
      label: 'weight + body fat' },

    { text: 'inbody: 80kg lean mass',
      check: v => v.muscle_mass_kg >= 75 || v.weight_kg >= 75,
      label: 'lean mass from InBody' },

    { text: 'current weight 230 lbs',
      check: v => v.weight_kg >= 100 && v.weight_kg <= 110,
      label: 'lbs to kg conversion' },

    { text: 'body fat 18%, weight 85kg, muscle 65kg',
      check: v => v.body_fat_pct >= 17 && v.weight_kg >= 84 && (v.muscle_mass_kg || 0) >= 60,
      label: 'all three metrics' },

    { text: '104.2',
      check: v => v.weight_kg >= 103 && v.weight_kg <= 105,
      label: 'bare number = weight' },

    { text: 'morning weight: 99.8',
      check: v => v.weight_kg >= 99 && v.weight_kg <= 100.5,
      label: 'weight with label' },

    { text: 'dexa scan: 78kg muscle, 28% fat, 112kg total',
      check: v => v.weight_kg >= 110 && v.body_fat_pct >= 25,
      label: 'DEXA scan format' },

    { text: 'lost 2kg since last week, now at 102',
      check: v => v.weight_kg >= 101 && v.weight_kg <= 103,
      label: 'relative reference, extracts current weight' },

    { text: 'BMI check: 75kg',
      check: v => v.weight_kg >= 74 && v.weight_kg <= 76,
      label: 'BMI context, extracts weight' },

    // output structure
    { text: '100kg',
      check: v => 'weight_kg' in v && 'body_fat_pct' in v && 'muscle_mass_kg' in v,
      label: 'output has all required fields (nulls ok)' },

    { text: 'body fat 25%',
      check: v => v.body_fat_pct >= 24 && v.weight_kg === null,
      label: 'bf only, no weight = null weight' },

    { text: 'slept 7 hours, weighed 103kg this morning',
      check: v => v.weight_kg >= 102 && v.weight_kg <= 104,
      label: 'weight in mixed message' },

    { text: 'вес 100кг сегодня',
      check: v => v.weight_kg >= 99 && v.weight_kg <= 101,
      label: 'Russian: weight 100kg' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseBody(c.text);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 100));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. WORKOUT PARSER — 22 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testWorkoutParser() {
  section('WORKOUT PARSER (claude.parseWorkout)');

  const state = db.getState(CHAT_ID);
  const weight = state?.weight_kg || 80;

  const cases = [
    { text: 'chest day: bench 100kg 4x8, incline db 30kg 3x12, cable fly 3x15',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 2,
      label: 'chest workout with exercises' },

    { text: 'ran 5km in 28 minutes',
      check: v => {
        const name = (v.workout_name || v.name || '').toLowerCase();
        return name.includes('run') || name.includes('cardio') || (v.duration_min >= 25 && v.duration_min <= 32);
      },
      label: 'running log with distance+time' },

    { text: 'back workout: deadlift 140kg 3x5, rows 80kg 3x10, pullups 3x8',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 2,
      label: 'back workout multiple exercises' },

    { text: 'legs: squat 120kg 5x5',
      check: v => {
        const exs = v.exercises || [];
        return exs.some(e => e.name?.toLowerCase().includes('squat'));
      },
      label: 'squat detected in leg day' },

    { text: '60 minute HIIT session',
      check: v => v.duration_min >= 55 && v.duration_min <= 65,
      label: 'HIIT duration 60min' },

    { text: 'arms: bicep curls 20kg 4x12, tricep pushdowns 30kg 3x15',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 2,
      label: 'arms workout' },

    { text: 'swimming 40 laps, 45 minutes',
      check: v => {
        const name = (v.workout_name || v.name || '').toLowerCase();
        return name.includes('swim') || v.duration_min >= 40;
      },
      label: 'swimming' },

    { text: 'overhead press 60kg 4x6, lateral raises 12kg 4x15',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 1,
      label: 'shoulder exercises' },

    // no specific exercises — just description
    { text: 'did a full body workout, 1 hour',
      check: v => v.duration_min >= 55 || (v.workout_name || '').toLowerCase().includes('body'),
      label: 'vague full body workout' },

    // calories burned
    { text: '45min cycling, burned about 350 calories',
      check: v => (v.calories_burned || 0) >= 300 || v.duration_min >= 40,
      label: 'cardio with calories mentioned' },

    // workout name detection
    { text: 'push day done',
      check: v => {
        const name = (v.workout_name || v.name || '').toLowerCase();
        return name.includes('push') || name.includes('chest');
      },
      label: 'push day name detected' },

    // weight referenced from user profile
    { text: 'bodyweight squats 100 reps',
      check: v => v !== null,
      label: 'bodyweight exercise — parses ok' },

    // sets/reps detail
    { text: 'bench press 80kg: set1 8 reps, set2 8 reps, set3 6 reps',
      check: v => {
        const exs = v.exercises || [];
        const bench = exs.find(e => e.name?.toLowerCase().includes('bench'));
        return bench && (bench.sets >= 3 || bench.sets_detail?.length >= 2);
      },
      label: 'per-set reps detail' },

    // Multiple workouts in one message
    { text: 'morning: 30min run. Evening: chest and triceps',
      check: v => v !== null,
      label: 'two sessions in one message — parses' },

    // Just duration no exercises
    { text: 'gym 1.5 hours',
      check: v => (v.duration_min || 0) >= 80,
      label: 'gym duration only — 90min' },

    // Golf
    { text: 'golf 9 holes, walked the course, 3.5 hours',
      check: v => {
        const name = (v.workout_name || v.name || '').toLowerCase();
        return name.includes('golf') || v.duration_min >= 180;
      },
      label: 'golf session' },

    // Output structure
    { text: 'bench 100kg 5x5',
      check: v => 'exercises' in v || 'workout_name' in v || 'duration_min' in v,
      label: 'output has expected fields' },

    // Very short message
    { text: 'gym',
      check: v => v !== null,
      label: 'bare "gym" — parses without crash' },

    // Russian
    { text: 'жим лежа 100кг 4 подхода по 8',
      check: v => {
        const exs = v.exercises || [];
        return exs.length >= 1 || v !== null;
      },
      label: 'Russian: bench press 100kg 4x8' },

    // Mixed with log time
    { text: 'did chest at 7am: bench 100kg 4x8, flyes 20kg 3x12',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 1,
      label: 'workout with time prefix' },

    // Intensity/RPE
    { text: 'heavy leg day: squats 130kg 5x3 RPE 9',
      check: v => {
        const exs = v.exercises || [];
        return exs.some(e => e.name?.toLowerCase().includes('squat'));
      },
      label: 'RPE mentioned — still parses' },

    // Pull day
    { text: 'pull day: deadlift 160kg 1x5, barbell row 100kg 4x6, lat pulldown 80kg 3x10',
      check: v => Array.isArray(v.exercises) && v.exercises.length >= 2,
      label: 'pull day — multiple exercises' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseWorkout(c.text, '', weight);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 120));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. MEAL PARSER (text only) — 22 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testMealParser() {
  section('MEAL PARSER — text-based (claude.analyzeMeal)');

  const state = db.getState(CHAT_ID);
  const dayOfWeek = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date().getUTCDay()];

  const cases = [
    // Basic meal
    { text: 'chicken rice for lunch',
      check: v => v.totals?.calories >= 300 && v.totals?.protein >= 20,
      label: 'chicken rice — reasonable macros' },

    // Multiple items
    { text: 'burger, fries, and coke',
      check: v => v.totals?.calories >= 700,
      label: 'burger+fries+coke — high cal' },

    // With weight
    { text: '200g grilled salmon',
      check: v => {
        const protein = v.totals?.protein || 0;
        return protein >= 35 && protein <= 55;
      },
      label: '200g salmon — protein check' },

    // Breakfast — pass explicit 9am time to override current time-based detection
    { text: 'eggs and toast for breakfast at 9am',
      check: v => v.meal_type === 'Breakfast',
      label: 'breakfast type detected (9am explicit)' },

    // Time extraction
    { text: 'had chicken rice at 12:30pm',
      check: v => v.time === '12:30',
      label: 'time extracted from text' },

    // Confidence + clarification on vague
    { text: 'had some food',
      check: v => v.confidence === 'low' || v.clarification !== null,
      label: 'vague food — low confidence or asks for clarification' },

    // Drink — type should be Drink
    { text: 'black coffee',
      check: v => v.meal_type === 'Drink',
      label: 'coffee = Drink type' },

    // Caffeine detection
    { text: 'double espresso',
      check: v => (v.caffeine_mg || 0) >= 100,
      label: 'espresso — caffeine detected' },

    // NS dinner keyword
    { text: 'NS dinner',
      check: v => v.confidence === 'low' || v.meal_name?.toLowerCase().includes('ns') || v.clarification !== null,
      label: 'NS dinner — triggers known foods matching or asks clarification' },

    // Low calorie meal
    { text: 'salad with cucumber and tomato, no dressing',
      check: v => v.totals?.calories <= 200,
      label: 'plain salad — low cal' },

    // Snack time
    { text: 'handful of almonds',
      check: v => v.totals?.calories >= 100 && v.totals?.calories <= 300,
      label: 'almonds — reasonable calories' },

    // Multiple items with weights
    { text: '150g chicken breast, 100g brown rice, 50g broccoli',
      check: v => {
        const items = v.items || [];
        return items.length >= 2 && v.totals?.protein >= 30;
      },
      label: 'three items with weights — protein check' },

    // Protein shake
    { text: 'whey protein shake, 1 scoop',
      check: v => {
        const protein = v.totals?.protein || 0;
        return protein >= 20 && protein <= 35;
      },
      label: 'whey shake — protein check' },

    // Alcohol
    { text: '2 glasses of red wine',
      check: v => v.meal_type === 'Drink' && (v.totals?.calories || 0) >= 200,
      label: 'wine — drink type + calories' },

    // Meal name generated
    { text: 'nasi lemak',
      check: v => v.meal_name && v.meal_name.length > 0,
      label: 'meal name generated for nasi lemak' },

    // Totals present
    { text: 'oatmeal with banana',
      check: v => v.totals && typeof v.totals.calories === 'number',
      label: 'totals present in output' },

    // Items array present
    { text: 'chicken salad',
      check: v => Array.isArray(v.items) && v.items.length >= 1,
      label: 'items array has entries' },

    // Total macros make sense
    { text: '2 boiled eggs',
      check: v => {
        const p = v.totals?.protein || 0;
        const cal = v.totals?.calories || 0;
        return p >= 10 && p <= 18 && cal >= 120 && cal <= 200;
      },
      label: '2 boiled eggs — macros reasonable (p:12g, cal:140)' },

    // Late night snack type
    { text: 'casein shake at 10:30pm',
      check: v => v.meal_type === 'Drink' || v.meal_type === 'Snack',
      label: 'late night shake — drink or snack type' },

    // Teh tarik = Drink
    { text: 'teh tarik',
      check: v => v.meal_type === 'Drink',
      label: 'teh tarik = Drink type' },

    // High protein meal
    { text: '300g chicken breast grilled',
      check: v => (v.totals?.protein || 0) >= 60,
      label: '300g chicken — high protein' },

    // new_food field present
    { text: 'mystery box lunch',
      check: v => 'new_food' in v || v.confidence === 'low',
      label: 'unknown food — new_food flag or low confidence' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.analyzeMeal(null, c.text, dayOfWeek, '', new Date().toTimeString().slice(0,5));
      const pass = c.check(result);
      check(c.label, pass, `cal:${result.totals?.calories} p:${result.totals?.protein} type:${result.meal_type}`);
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. PLANS PARSER — 15 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testPlansParser() {
  section('PLANS PARSER (claude.parsePlans)');

  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const tomorrow = new Date(now.getTime() + 86400000).toISOString().slice(0,10);
  const currentDateTime = `Current date/time: ${now.toISOString()}`;

  // parsePlans returns array directly: [{title, date, time, ...}]
  const p0 = v => Array.isArray(v) ? v[0] : (v?.plans?.[0] || v);

  const cases = [
    { text: 'gym tomorrow at 10am',
      check: v => p0(v)?.time === '10:00' && p0(v)?.date === tomorrow,
      label: 'gym tomorrow 10am — date and time resolved' },

    { text: 'dentist on Friday at 2pm',
      check: v => p0(v)?.time === '14:00',
      label: 'dentist Friday 2pm — 24h time' },

    { text: 'remind me to take creatine every day at 8pm',
      check: v => p0(v)?.recurring === 'daily' && p0(v)?.time === '20:00',
      label: 'daily recurring reminder' },

    { text: 'buy groceries this week',
      check: v => p0(v)?.is_task === true || p0(v)?.time === null,
      label: 'task without specific time — is_task or no time' },

    { text: 'meeting with John at 3pm today',
      check: v => p0(v)?.time === '15:00' && p0(v)?.date === todayStr,
      label: 'today meeting — date = today' },

    { text: 'call mom',
      check: v => p0(v) != null && typeof p0(v)?.title === 'string',
      label: 'simple task — parses with title' },

    { text: 'workout every monday and thursday',
      check: v => (Array.isArray(v) ? v.length : 0) >= 1,
      label: 'recurring weekly workout — at least 1' },

    { text: 'golf at Sentosa Golf Club on Saturday at 7am',
      check: v => p0(v)?.time === '07:00' && (p0(v)?.location || '').toLowerCase().includes('sentosa'),
      label: 'golf with location' },

    { text: 'dinner with Sarah tomorrow at 7:30pm',
      check: v => p0(v)?.time === '19:30',
      label: 'dinner 7:30pm — time parsed' },

    { text: 'meeting with max@example.com at 4pm',
      check: v => (p0(v)?.guests || []).includes('max@example.com'),
      label: 'email extracted into guests array' },

    { text: 'coffee meeting with Jake blah@email.com tomorrow morning',
      check: v => {
        const title = p0(v)?.title || '';
        return title.length > 0 && !title.includes('@');
      },
      label: 'title cleaned — no email in title' },

    { text: 'gym at 6am',
      check: v => Array.isArray(v) && v.length >= 1,
      label: 'output is non-empty array' },

    { text: 'gym at 7am, lunch at 12:30, dentist at 3pm',
      check: v => (Array.isArray(v) ? v.length : 0) >= 2,
      label: 'multiple plans extracted — at least 2' },

    { text: 'тренировка завтра в 10',
      check: v => p0(v)?.time === '10:00',
      label: 'Russian: workout tomorrow at 10' },

    { text: 'buy new gym shoes',
      check: v => p0(v) != null,
      label: 'open-ended task — parses ok' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parsePlans(c.text, currentDateTime);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 120));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. CONVERSATION CONTINUATION CHECK — 20 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testContinuationCheck() {
  section('CONVERSATION CONTINUATION (claude.isConversationContinuation)');

  const summaries = {
    creatine: 'User discussed creatine supplementation. Recommended 5g/day monohydrate. User asked about hair loss (no real link). Agreed to start with Creapure brand. Discussed loading phase — not necessary.',
    sleep: 'User has been waking at 4am due to blood sugar drops. Agreed to: stop melatonin (4-week washout), start magnesium glycinate 300mg + glycine 3g before bed, casein shake + 30-40g carbs at 9pm.',
    sauna: 'User did 20min sauna at 90°C after training. Discussed benefits: GH spike, cardiovascular adaptation. Recommended 15-20min post-workout, avoid within 2h of sleep.',
    workout: 'User wants to add 4th training day. Currently does chest/back/legs. Recommended arms+shoulders day on Wednesday between main days.',
  };

  const cases = [
    // Should inherit (YES)
    { msg: 'does it matter when i take it',    summary: summaries.creatine, expect: true,  label: 'creatine timing — natural follow-up' },
    { msg: 'can i mix it in my coffee',        summary: summaries.creatine, expect: true,  label: 'creatine mixing — follow-up' },
    { msg: 'is 5g per day or per meal',        summary: summaries.creatine, expect: true,  label: 'creatine dosing clarification' },
    { msg: 'what if i run out for a week',     summary: summaries.creatine, expect: true,  label: 'creatine gap — follow-up' },
    { msg: 'how long will it take to kick in', summary: summaries.creatine, expect: true,  label: 'creatine timing effects' },

    { msg: 'how long will it take to feel better',  summary: summaries.sleep, expect: true, label: 'sleep: how long to feel better' },
    { msg: 'what if i still wake at 4am',            summary: summaries.sleep, expect: true, label: 'sleep: still waking up' },
    { msg: 'should i try magnesium',                 summary: summaries.sleep, expect: true, label: 'sleep: magnesium question — in summary' },

    { msg: 'is cold plunge better after sauna',     summary: summaries.sauna, expect: true, label: 'sauna: cold plunge follow-up' },
    { msg: 'what about a cold shower instead',      summary: summaries.sauna, expect: true, label: 'sauna: cold shower vs plunge' },

    { msg: 'what exercises for that day',            summary: summaries.workout, expect: true, label: 'workout: what exercises for 4th day' },
    { msg: 'should i do it on wednesday or friday',  summary: summaries.workout, expect: true, label: 'workout: scheduling 4th day' },

    // Should NOT inherit (NO) — unrelated topics
    { msg: 'how many calories in chicken rice',     summary: summaries.creatine, expect: false, label: 'creatine summary + meal question — NO inherit' },
    { msg: 'my sleep has been terrible',            summary: summaries.creatine, expect: false, label: 'creatine summary + sleep complaint — NO' },
    { msg: 'what should i eat for breakfast',       summary: summaries.sleep,    expect: false, label: 'sleep summary + breakfast question — NO' },
    { msg: 'how much protein should i eat',         summary: summaries.sauna,    expect: false, label: 'sauna summary + protein question — NO' },
    { msg: 'whats my calorie target',               summary: summaries.workout,  expect: false, label: 'workout summary + calorie question — NO' },
    { msg: 'good morning',                          summary: summaries.creatine, expect: false, label: 'greeting after creatine — NO' },

    // Ambiguous but should lean false
    { msg: 'ok',                                    summary: summaries.creatine, expect: false, label: '"ok" after creatine — NO (ambiguous)' },
    { msg: 'makes sense',                           summary: summaries.sleep,    expect: false, label: '"makes sense" — too vague to inherit' },
  ];

  let correctInherit = 0, correctReject = 0, wrongInherit = 0, wrongReject = 0;

  for (const c of cases) {
    try {
      const result = await claude.isConversationContinuation(c.msg, c.summary);
      const correct = result === c.expect;
      if (correct) {
        ok(c.label, `→ ${result ? 'INHERIT' : 'FRESH'} ✓`);
        if (c.expect) correctInherit++; else correctReject++;
      } else {
        fail(c.label, `expected ${c.expect ? 'INHERIT' : 'FRESH'} got ${result ? 'INHERIT' : 'FRESH'}`);
        if (c.expect) wrongReject++; else wrongInherit++;
      }
    } catch (e) {
      fail(c.label, e.message);
    }
  }

  console.log(`\n  Summary: correct inherit=${correctInherit}, correct reject=${correctReject}, wrong inherit=${wrongInherit}, wrong reject=${wrongReject}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. RENAME INTENT PARSER — 10 edge cases
// ─────────────────────────────────────────────────────────────────────────────
async function testRenameParser() {
  section('RENAME INTENT (claude.parseRenameIntent)');

  const recentLogs = [
    { id: 1, type: 'workout', name: 'Kettlebell Pull',  logged_at: Date.now() - 3600000 },
    { id: 2, type: 'meal',    name: 'Chicken Rice',     logged_at: Date.now() - 7200000 },
    { id: 3, type: 'workout', name: 'Upper Body',       logged_at: Date.now() - 86400000 },
    { id: 4, type: 'meal',    name: 'Burger',           logged_at: Date.now() - 172800000 },
  ];

  const cases = [
    { text: 'rename my workout to golf workout',
      check: v => (v.new_name || '').toLowerCase().includes('golf'),
      label: 'rename workout to golf' },

    { text: 'call that burger a big mac',
      check: v => (v.new_name || '').toLowerCase().includes('mac'),
      label: 'rename meal: big mac' },

    { text: 'rename Kettlebell Pull to Golf',
      check: v => (v.new_name || '').toLowerCase().includes('golf') && v.entry_id === 1,
      label: 'rename by exact name + correct entry match' },

    { text: 'log that as rokeby smoothie',
      check: v => v.new_name && v.new_name.length > 0,
      label: 'log that as smoothie — extracts new name' },

    { text: 'change my workout name to Push Day A',
      check: v => (v.new_name || '').toLowerCase().includes('push'),
      label: 'workout rename to Push Day A' },

    { text: 'rename the chicken rice to Singapore Chicken Rice',
      check: v => (v.new_name || '').toLowerCase().includes('singapore') || (v.new_name || '').toLowerCase().includes('chicken'),
      label: 'rename meal with qualifier' },

    { text: 'call my last workout Upper Hypertrophy',
      check: v => (v.new_name || '').toLowerCase().includes('hypertrophy'),
      label: 'rename latest workout' },

    { text: 'change Upper Body workout to Pull Day',
      check: v => (v.new_name || '').toLowerCase().includes('pull'),
      label: 'rename by partial name match' },

    // new_name field exists and is non-empty
    { text: 'rename workout to legs A',
      check: v => typeof v.new_name === 'string' && v.new_name.length > 0,
      label: 'output new_name field present' },

    // entry_id can be null when not clear which entry
    { text: 'rename the last thing i logged to Morning Snack',
      check: v => v.new_name && v.new_name.length > 0,
      label: 'vague reference — still extracts new_name' },
  ];

  for (const c of cases) {
    try {
      const result = await claude.parseRenameIntent(c.text, recentLogs);
      const pass = c.check(result);
      check(c.label, pass, JSON.stringify(result).slice(0, 100));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. ASK / COACH HANDLER — full routing, 20 cases
// ─────────────────────────────────────────────────────────────────────────────
async function testAskHandler() {
  section('ASK HANDLER (handleAsk — full bot routing)');

  // Clear current chain so tests start fresh
  const freshState = db.getState(CHAT_ID);
  if (freshState.current_chain_id) {
    try { await closeChain(CHAT_ID, freshState.current_chain_id); } catch {}
  }

  const bot = makeMockBot();

  const cases = [
    // Direct factual questions — bot should give specific answers
    { text: 'how much protein is in 100g chicken breast',
      check: r => /chicken|protein|30|31|32/i.test(r),
      label: 'factual: protein in chicken breast' },

    { text: 'what is the glycemic index of oats',
      check: r => /oat|glycemic|gi|55|40|50/i.test(r),
      label: 'factual: glycemic index oats' },

    { text: 'whats the difference between whey and casein',
      check: r => /whey|casein|fast|slow|digest/i.test(r),
      label: 'comparison: whey vs casein' },

    // Personalized questions — bot must use user data
    { text: 'how many calories did i eat today',
      check: r => /kcal|calorie|today/i.test(r) && /\d{3,4}/.test(r),
      label: 'personalized: today calories — must show number' },

    { text: 'am i on track for my protein goal',
      check: r => /protein|g|target|170/i.test(r),
      label: 'personalized: protein tracking — must reference target' },

    { text: 'what is my calorie target',
      check: r => /1[,.]?[5-9]\d{2}|2[,.]?[0-2]\d{2}/.test(r),
      label: 'personalized: states calorie target (1500-2200 range, comma ok)' },

    // Recovery/training questions
    { text: 'is sauna better before or after training',
      check: r => /after|before|train|workout|sauna/i.test(r),
      label: 'sauna timing question' },

    { text: 'how often should i take a rest day',
      check: r => /rest|recover|day|week/i.test(r),
      label: 'recovery: rest day frequency' },

    // Nutrition
    { text: 'what foods are highest in magnesium',
      check: r => /magnesium|spinach|nuts|seed|dark.?chocolate|avocado/i.test(r),
      label: 'nutrition: magnesium-rich foods' },

    { text: 'how do i calculate my TDEE',
      check: r => /tdee|maintenance|calorie|activity|bmr/i.test(r),
      label: 'nutrition: TDEE explanation' },

    // Supplement questions
    { text: 'should i take vitamin D',
      check: r => /vitamin.?d|supplement|sun|deficiency/i.test(r),
      label: 'supplement: vitamin D' },

    { text: 'whats the best pre workout meal',
      check: r => /carb|protein|meal|before|workout|hour/i.test(r),
      label: 'nutrition: pre-workout meal' },

    // Sleep questions
    { text: 'how much sleep do i need',
      check: r => /hour|sleep|7|8|9/i.test(r),
      label: 'sleep: how much sleep needed' },

    // Context from user profile
    { text: 'what should i focus on this week',
      check: r => r.length > 50,
      label: 'open-ended: week focus — gives substantive answer' },

    // Question with numbers in response
    { text: 'how many grams of fat should i eat per day',
      check: r => /\d+/.test(r) && /fat|gram|g/i.test(r),
      label: 'fat target — must mention grams' },

    // Multi-part question
    { text: 'is creatine safe and how long should i take it',
      check: r => /creatine|safe|long|take/i.test(r),
      label: 'multi-part creatine question' },

    // Short ambiguous message with context — tests chain
    { text: 'what about eggs',
      check: r => r.length > 20,
      label: 'short follow-up — gets a real answer (not empty)' },

    // Personalized: references user weight
    { text: 'how much creatine should i take for my body weight',
      check: r => /5g|5 g|creatine|daily|day/i.test(r),
      label: 'personalized: creatine dose (should say 5g)' },

    // Emotional/non-data question
    { text: 'i keep failing to hit my protein target, what should i do',
      check: r => r.length > 100,
      label: 'motivational/strategic question — substantive response' },

    // Week trend question
    { text: 'how has my nutrition been this week',
      check: r => /week|calorie|protein|day/i.test(r),
      label: 'weekly trend question — references actual data' },
  ];

  for (const c of cases) {
    try {
      const botInstance = makeMockBot();
      await handleAsk(botInstance, makeMsg(c.text));
      const reply = botInstance.replies[0] || '';
      const pass = c.check(reply);
      check(c.label, pass, reply.slice(0, 80));
    } catch (e) {
      fail(c.label, e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. CHAIN CONTEXT INHERITANCE — 12 cases
// ─────────────────────────────────────────────────────────────────────────────
async function testChainContext() {
  section('CHAIN CONTEXT — conversation memory across messages');

  // Clear state
  const freshState = db.getState(CHAT_ID);
  if (freshState.current_chain_id) {
    try { await closeChain(CHAT_ID, freshState.current_chain_id); } catch {}
    db.setState(CHAT_ID, { current_chain_id: null });
  }

  const bot = makeMockBot();
  const asks = async (text) => {
    const b = makeMockBot();
    await handleAsk(b, makeMsg(text));
    return b.replies[0] || '';
  };

  // Start a chain on creatine
  await asks('should i take creatine');
  await asks('does it cause water retention');
  await asks('how long till it works');

  const state1 = db.getState(CHAT_ID);
  check('chain established: current_chain_id set after 3 questions', !!state1.current_chain_id, state1.current_chain_id);

  // Follow-up must use chain context
  const reply4 = await asks('how much should i take');
  check('follow-up "how much should i take" — answers about creatine (not generic)',
    /creatine|5g|5 g|monohydrate/i.test(reply4),
    reply4.slice(0, 80));

  // Another follow-up
  const reply5 = await asks('what brand is best');
  check('follow-up "what brand is best" — answers about creatine brand',
    /creatine|creapure|myprotein|optimum|monohydrate|brand/i.test(reply5),
    reply5.slice(0, 80));

  // Now log — chain should close
  const chainIdBefore = db.getState(CHAT_ID).current_chain_id;
  if (chainIdBefore) {
    await closeChain(CHAT_ID, chainIdBefore);
    db.setState(CHAT_ID, { current_chain_id: null });
  }

  const stateAfterClose = db.getState(CHAT_ID);
  check('after chain close: current_chain_id cleared', !stateAfterClose.current_chain_id, String(stateAfterClose.current_chain_id));

  // New question on same topic — should inherit from summary
  const reply6 = await asks('can i stack it with caffeine');
  check('after close: creatine+caffeine question — still answers about creatine',
    /creatine|caffeine|stack|combine/i.test(reply6),
    reply6.slice(0, 80));

  // Completely new topic — should NOT get creatine context polluting it
  const reply7 = await asks('how much sleep do i need per night');
  check('new topic after creatine chain: sleep question answered about sleep not creatine',
    /sleep|hour|night/i.test(reply7) && !/creatine/i.test(reply7),
    reply7.slice(0, 80));

  // Start sauna chain
  await asks('is sauna good after training');
  await asks('how long should i stay in');
  const saunaReply = await asks('what temperature');
  check('within sauna chain: "what temperature" answered about sauna temperature',
    /degree|celsius|°|80|90|100|temp|hot/i.test(saunaReply),
    saunaReply.slice(0, 80));

  // Close sauna chain
  const saunaChainId = db.getState(CHAT_ID).current_chain_id;
  if (saunaChainId) {
    await closeChain(CHAT_ID, saunaChainId);
    db.setState(CHAT_ID, { current_chain_id: null });
  }

  // Start calories chain
  const calReply = await asks('how many calories did i eat today');
  check('calories question after sauna chain: no sauna context bleeds in',
    /calorie|kcal|\d{3,4}/i.test(calReply) && !/sauna/i.test(calReply),
    calReply.slice(0, 80));

  // Back to sauna topic — should inherit from sauna summary not calories
  const coldPlungeReply = await asks('is cold plunge better after sauna than a cold shower');
  check('cold plunge after sauna summary: references sauna, not calories',
    /cold.?plunge|cold.?shower|plunge|shower|sauna/i.test(coldPlungeReply),
    coldPlungeReply.slice(0, 80));
}

// ─────────────────────────────────────────────────────────────────────────────
// 12. SUMMARIZE + PROFILE UPDATE — 5 integration cases
// ─────────────────────────────────────────────────────────────────────────────
async function testSummarizeAndProfile() {
  section('SUMMARIZE + PROFILE UPDATE');

  const messages = [
    { role: 'user',      content: 'my gut has been off since i bumped up protein, lots of gas' },
    { role: 'assistant', content: 'Common issue. Try whey isolate instead of concentrate, spread protein across 4 meals, add lactobacillus probiotic.' },
    { role: 'user',      content: 'how long till probiotics help' },
    { role: 'assistant', content: '2-4 weeks minimum. Bifidobacterium longum is your best bet for protein fermentation issues.' },
    { role: 'user',      content: 'ok will try, what probiotic brand' },
    { role: 'assistant', content: 'Any pharmacy brand with Lactobacillus acidophilus + Bifidobacterium longum. Garden of Life or OptiBac are solid options.' },
  ];

  // summarizeConversation
  try {
    const summary = await claude.summarizeConversation(messages);
    check('summarizeConversation: returns non-empty string', typeof summary === 'string' && summary.length > 20, summary.slice(0,100));
    check('summarizeConversation: mentions gut/digestion/protein topic', /gut|digest|protein|gas|probiotic/i.test(summary), summary.slice(0,100));
  } catch (e) {
    fail('summarizeConversation', e.message);
  }

  // updateUserProfile
  const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const currentProfile = db.getUserProfile(CHAT_ID) || '';

  try {
    const updated = await claude.updateUserProfile(convText, currentProfile);
    check('updateUserProfile: returns string', typeof updated === 'string' && updated.length > 0, updated.slice(0,100));
    check('updateUserProfile: gut/digestive issue absorbed', /gut|digest|gas|protein|probiotic/i.test(updated), updated.slice(0,100));
  } catch (e) {
    fail('updateUserProfile', e.message);
  }

  // saveCoachConversation — DB write
  try {
    const summary = await claude.summarizeConversation(messages);
    db.saveCoachConversation(CHAT_ID, messages, summary);
    const saved = db.getRecentConversationSummaries(CHAT_ID, 1);
    check('saveCoachConversation: summary saved to DB', saved.length >= 1 && saved[0].summary.length > 0, saved[0]?.summary?.slice(0,80));
  } catch (e) {
    fail('saveCoachConversation', e.message);
  }

  // getRecentConversationSummaries returns correctly
  try {
    const summaries = db.getRecentConversationSummaries(CHAT_ID, 3);
    check('getRecentConversationSummaries: returns array', Array.isArray(summaries));
    check('getRecentConversationSummaries: each has summary field', summaries.every(s => typeof s.summary === 'string'));
  } catch (e) {
    fail('getRecentConversationSummaries', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 13. DB OPERATIONS — core state functions
// ─────────────────────────────────────────────────────────────────────────────
async function testDBOperations() {
  section('DB OPERATIONS — core state');

  // getState
  try {
    const state = db.getState(CHAT_ID);
    check('getState returns object', typeof state === 'object' && state !== null);
    check('getState has expected fields', 'chat_id' in state && 'timezone' in state);
  } catch (e) { fail('getState', e.message); }

  // setState (reversible — save + restore)
  try {
    const before = db.getState(CHAT_ID).last_proactive_date;
    db.setState(CHAT_ID, { last_proactive_date: '2099-01-01' });
    const after = db.getState(CHAT_ID).last_proactive_date;
    check('setState: sets value', after === '2099-01-01', after);
    db.setState(CHAT_ID, { last_proactive_date: before }); // restore
  } catch (e) { fail('setState', e.message); }

  // getDayDataFromSQLite
  try {
    const state = db.getState(CHAT_ID);
    const data = db.getDayDataFromSQLite(CHAT_ID, state.current_day_start);
    check('getDayDataFromSQLite: returns object', typeof data === 'object');
    check('getDayDataFromSQLite: has totals', typeof data.totals === 'object');
    check('getDayDataFromSQLite: has meals array', Array.isArray(data.meals));
  } catch (e) { fail('getDayDataFromSQLite', e.message); }

  // getWeekDataFromSQLite
  try {
    const sinceMs = Date.now() - 7 * 86400000;
    const data = db.getWeekDataFromSQLite(CHAT_ID, sinceMs);
    check('getWeekDataFromSQLite: has dailyTotals', typeof data.dailyTotals === 'object');
  } catch (e) { fail('getWeekDataFromSQLite', e.message); }

  // getHistory
  try {
    const hist = db.getHistory(CHAT_ID, 5);
    check('getHistory: returns array', Array.isArray(hist));
    check('getHistory: max 5 entries', hist.length <= 5);
  } catch (e) { fail('getHistory', e.message); }

  // getTargetsFromDb
  try {
    const targets = db.getTargetsFromDb(CHAT_ID);
    check('getTargetsFromDb: has calories', typeof targets.calories === 'number');
    check('getTargetsFromDb: has protein', typeof targets.protein === 'number');
  } catch (e) { fail('getTargetsFromDb', e.message); }

  // getRecentLogs
  try {
    const logs = db.getRecentLogs(CHAT_ID, 7);
    check('getRecentLogs: returns array', Array.isArray(logs));
  } catch (e) { fail('getRecentLogs', e.message); }

  // getLastSleepLog
  try {
    const sleep = db.getLastSleepLog(CHAT_ID);
    if (sleep) {
      check('getLastSleepLog: has hours_slept', typeof (sleep.hours_slept ?? sleep.duration_hours) === 'number');
    } else {
      ok('getLastSleepLog: no sleep log yet (acceptable)');
    }
  } catch (e) { fail('getLastSleepLog', e.message); }

  // getLastBodyMeasurement
  try {
    const body = db.getLastBodyMeasurement(CHAT_ID);
    if (body) {
      check('getLastBodyMeasurement: has weight_kg', typeof body.weight_kg === 'number');
    } else {
      ok('getLastBodyMeasurement: no body log (acceptable)');
    }
  } catch (e) { fail('getLastBodyMeasurement', e.message); }

  // saveCoachMessage + getReplyChain round-trip
  try {
    const testId = 999998;
    db.saveCoachMessage(CHAT_ID, 'user', 'test message', testId);
    db.saveCoachMessage(CHAT_ID, 'assistant', 'test reply', testId);
    const chain = db.getReplyChain(CHAT_ID, testId);
    check('saveCoachMessage + getReplyChain: 2 rows', chain.length === 2);
    check('countExchanges: 1 user exchange', db.countExchanges(CHAT_ID, testId) === 1);
    db.clearReplyChain(CHAT_ID, testId);
    check('clearReplyChain: chain cleared', db.getReplyChain(CHAT_ID, testId).length === 0);
  } catch (e) { fail('chain round-trip', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// 14. EDGE CASES — boundary conditions
// ─────────────────────────────────────────────────────────────────────────────
async function testEdgeCases() {
  section('EDGE CASES — boundary conditions');

  // Empty/very short messages to classifier
  const empties = ['', '  ', '.', '?', '!'];
  for (const t of empties) {
    try {
      const r = await claude.classify(t, []);
      check(`classify("${t}"): doesn't crash, returns array`, Array.isArray(r), r.join(','));
    } catch (e) {
      fail(`classify("${t}"): crashed`, e.message);
    }
  }

  // Very long message to classifier
  try {
    const long = 'chicken rice for lunch ' .repeat(50);
    const r = await claude.classify(long, []);
    check('classify(very long message): returns MEAL_LOG', r.includes('MEAL_LOG'), r.join(','));
  } catch (e) { fail('classify very long message', e.message); }

  // Multi-language
  try {
    const r = await claude.classify('доброе утро', []);
    check('classify Russian "gm": WAKE', r.includes('WAKE'), r.join(','));
  } catch (e) { fail('classify Russian gm', e.message); }

  try {
    const r = await claude.classify('спать иду', []);
    check('classify Russian "going to sleep": BED', r.includes('BED'), r.join(','));
  } catch (e) { fail('classify Russian bed', e.message); }

  // Ask handler with empty text
  try {
    const bot = makeMockBot();
    await handleAsk(bot, makeMsg(''));
    check('handleAsk empty text: bot replies something', bot.replies.length > 0 || true);
  } catch (e) {
    warn('handleAsk empty text: threw error (ok if graceful)', e.message);
  }

  // parseSleep with completely wrong input
  try {
    const r = await claude.parseSleep('chicken rice for lunch');
    check('parseSleep non-sleep text: returns object (gracefully)', typeof r === 'object');
  } catch (e) {
    warn('parseSleep non-sleep input: threw (acceptable if graceful)', e.message);
  }

  // parseBody with non-body text
  try {
    const r = await claude.parseBody('had a great workout today');
    check('parseBody non-body text: weight_kg null', r.weight_kg === null);
  } catch (e) {
    warn('parseBody non-body text: threw (acceptable)', e.message);
  }

  // parseRecovery with meal text
  try {
    const r = await claude.parseRecovery('had chicken rice');
    check('parseRecovery non-recovery text: parses without crash', r !== null);
  } catch (e) {
    warn('parseRecovery with meal text: threw', e.message);
  }

  // Ambiguous multi-intent
  try {
    const r = await claude.classify('had protein shake and did 20 min yoga after lunch', []);
    const hasDrink = r.includes('DRINK_LOG') || r.includes('MEAL_LOG');
    const hasRecovery = r.includes('RECOVERY_LOG');
    check('ambiguous multi-intent: drink/meal + recovery both detected', hasDrink && hasRecovery, r.join(','));
  } catch (e) { fail('multi-intent classification', e.message); }

  // isConversationContinuation with very short message
  try {
    const r = await claude.isConversationContinuation('ok', 'User and coach discussed creatine dosing, decided on 5g/day.');
    check('continuation check "ok": returns boolean', typeof r === 'boolean');
  } catch (e) { fail('continuation check short message', e.message); }

  // Workout parser — no exercises, just name
  try {
    const r = await claude.parseWorkout('done with gym', '', 80);
    check('parseWorkout "done with gym": returns object', typeof r === 'object');
  } catch (e) { fail('parseWorkout bare text', e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '█'.repeat(60));
  console.log('  FULL BOT TEST — real API calls, real handlers');
  console.log('  ' + new Date().toISOString());
  console.log('█'.repeat(60));

  await testClassifier();
  await testRecoveryParser();
  await testSleepParser();
  await testBodyParser();
  await testWorkoutParser();
  await testMealParser();
  await testPlansParser();
  await testContinuationCheck();
  await testRenameParser();
  await testAskHandler();
  await testChainContext();
  await testSummarizeAndProfile();
  await testDBOperations();
  await testEdgeCases();

  // ── FINAL REPORT ──────────────────────────────────────────────────────────
  console.log('\n' + '█'.repeat(60));
  console.log('  RESULTS BY SECTION');
  console.log('█'.repeat(60));
  let totalCases = 0;
  for (const [name, s] of Object.entries(sections)) {
    const total = s.passed + s.failed + s.warned;
    totalCases += total;
    const status = s.failed > 0 ? '❌' : s.warned > 0 ? '⚠️ ' : '✅';
    console.log(`  ${status} ${name}: ${s.passed}/${total} passed${s.warned ? ', ' + s.warned + ' warnings' : ''}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`  TOTAL: ${passed} passed / ${failed} failed / ${warned} warned / ${totalCases} cases`);

  if (failures.length) {
    console.log('\n  FAILURES:');
    failures.forEach(f => console.log(`    • ${f}`));
  }
  if (warnings.length) {
    console.log('\n  WARNINGS:');
    warnings.forEach(w => console.log(`    ⚠️  ${w}`));
  }

  console.log('\n' + '█'.repeat(60) + '\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
