#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db = require('./src/db');
const db = require('./src/db');

const CHAT_ID = 119445404;
let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, detail) { failed++; failures.push(`${label}: ${detail}`); console.log(`  ❌ ${label} — ${detail}`); }
function section(t) { console.log(`\n${'═'.repeat(52)}\n  ${t}\n${'═'.repeat(52)}`); }

const targetsText = db.getTargetsText(CHAT_ID);

async function simulateClose(messages) {
  const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const [summary, profile] = await Promise.all([
    claude.summarizeConversation(messages),
    claude.updateUserProfile(convText, db.getUserProfile(CHAT_ID)),
  ]);
  db.saveCoachConversation(CHAT_ID, messages, summary);
  db.setUserProfile(CHAT_ID, profile);
  return summary;
}

async function simulateFreshAsk(newMsg) {
  const summaries = db.getRecentConversationSummaries(CHAT_ID, 1);
  let ctx = '';
  let inherited = false;
  if (summaries.length) {
    const continues = await claude.isConversationContinuation(newMsg, summaries[0].summary);
    if (continues) {
      ctx = `Previous conversation context:\n${summaries[0].summary}`;
      inherited = true;
    }
  }
  const answer = await claude.askCoach(newMsg, ctx, targetsText, '', db.getState(CHAT_ID));
  return { answer, inherited, summary: summaries[0]?.summary || '' };
}

async function main() {

  // ──────────────────────────────────────────────────────────────
  // TEST 1: 12-MESSAGE CONVO — natural continuations, NO hints
  // User never references what was said. Just continues naturally.
  // ──────────────────────────────────────────────────────────────
  section('TEST 1: 12-MESSAGE CONVO — no hints, purely natural messages');

  const creatineChain = [
    { role: 'user',      content: 'should i take creatine' },
    { role: 'assistant', content: '5g/day creatine monohydrate. Timing doesn\'t matter. Expect +5-10% strength over 3-4 weeks and 1-2kg scale increase from intracellular water.' },
    { role: 'user',      content: 'does it cause hair loss' },
    { role: 'assistant', content: 'One small unconfirmed study linked it to DHT — never replicated. No meaningful evidence at 5g/day. If you\'re genetically prone to baldness, theoretical minor risk. Not a real concern.' },
    { role: 'user',      content: 'what brand should i get' },
    { role: 'assistant', content: 'Creapure (German pharmaceutical grade) is best. MyProtein and Optimum Nutrition both use it. Pure monohydrate only — skip blends with "complexes".' },
    { role: 'user',      content: 'how long till i notice something' },
    { role: 'assistant', content: '2-4 weeks. You\'ll notice more reps on same weight, faster recovery, slight muscle fullness. Scale goes up 1-2kg — that\'s water in muscle, not fat.' },
    { role: 'user',      content: 'will it mess up my cut' },
    { role: 'assistant', content: 'No. The water is intramuscular — you won\'t look puffy. You\'ll actually look more muscular while cutting.' },
    { role: 'user',      content: 'should i cycle on and off' },
    { role: 'assistant', content: 'No. That\'s a 90s myth. Your receptors don\'t downregulate. Take 5g daily indefinitely.' },
    { role: 'user',      content: 'what about a loading phase' },
    { role: 'assistant', content: '20g/day for 5-7 days saturates faster but causes more GI issues. Not worth it — steady 5g/day gets there in 3-4 weeks with zero downsides.' },
    // CHAIN CUTS HERE at 8 exchanges
  ];

  const summary1 = await simulateClose(creatineChain);
  console.log(`\n  Chain closed. Summary:\n  "${summary1}"\n`);

  // Messages 9-12: NATURAL continuations — no "you said", no hints
  const naturalMessages = [
    { msg: 'does it matter when i take it',            expectInherit: true,  label: 'timing question — natural, no hint' },
    { msg: 'can i put it in my coffee',                expectInherit: true,  label: 'mixing question — natural, no hint' },
    { msg: 'is it better with food or without',         expectInherit: true,  label: 'administration question — creatine context needed' },
    { msg: 'which one is better, monohydrate or HCl',  expectInherit: true,  label: 'product comparison — creatine types, needs context' },
  ];

  for (const t of naturalMessages) {
    const r = await simulateFreshAsk(t.msg);
    const correct = r.inherited === t.expectInherit;
    if (correct) ok(`"${t.msg}" → ${r.inherited ? 'inherited ✓' : 'fresh ✓'} — ${t.label}`);
    else fail(t.label, `expected inherit=${t.expectInherit}, got ${r.inherited}. Summary was: "${summary1.slice(0,80)}"`);
    console.log(`     Bot: "${r.answer.slice(0,100)}..."\n`);
  }

  // ──────────────────────────────────────────────────────────────
  // TEST 2: TWO CHAINS BACK TO BACK — full conversation log printed
  // Chain A: digestion/gut issues
  // Chain B: workout programming
  // After B closes: gas question should NOT get workout context
  // Workout question SHOULD get workout context
  // ──────────────────────────────────────────────────────────────
  section('TEST 2: TWO CHAINS BACK TO BACK — full logs printed');

  const chainA = [
    { role: 'user',      content: 'stomach has been off lately, lots of gas after meals' },
    { role: 'assistant', content: 'Common triggers: whey concentrate, cruciferous veg, eating too fast, sudden protein increase. When did it start? What changed recently?' },
    { role: 'user',      content: 'i think it started when i bumped up protein' },
    { role: 'assistant', content: 'Classic. High protein ferments in the gut if bacteria can\'t keep up. Switch to whey isolate, spread protein across more meals, add probiotics.' },
    { role: 'user',      content: 'how long till probiotics help' },
    { role: 'assistant', content: '2-4 weeks minimum. Gut bacteria shift slowly. Lactobacillus acidophilus + Bifidobacterium longum — any pharmacy brand with those strains.' },
  ];

  const chainB = [
    { role: 'user',      content: 'thinking of adding a 4th training day, what makes sense' },
    { role: 'assistant', content: 'Depends on your split. With 3 days you likely have push/pull/legs or upper/lower. A 4th could be: lagging muscle group, upper hypertrophy, or pure cardio/conditioning.' },
    { role: 'user',      content: 'currently do chest/back/legs, what would you add' },
    { role: 'assistant', content: 'Arms + shoulders day. Biceps, triceps, lateral raises, rear delts. Gets more volume on muscles that get secondary work in your current 3 days.' },
    { role: 'user',      content: 'what day should i put it' },
    { role: 'assistant', content: 'Depends on current schedule. Avoid putting it right after chest (triceps) or back (biceps) — they\'ll be fatigued. Wednesday or Saturday between your main days.' },
  ];

  console.log('  CHAIN A CONVERSATION (digestion):');
  chainA.forEach(m => console.log(`    ${m.role === 'user' ? '👤' : '🤖'} ${m.content}`));
  const summaryA = await simulateClose(chainA);
  console.log(`  → Compressed: "${summaryA}"\n`);

  console.log('  CHAIN B CONVERSATION (workout programming):');
  chainB.forEach(m => console.log(`    ${m.role === 'user' ? '👤' : '🤖'} ${m.content}`));
  const summaryB = await simulateClose(chainB);
  console.log(`  → Compressed: "${summaryB}"\n`);

  console.log('  Most recent summary in DB is Chain B (workout).');
  console.log('  Now asking about gas/digestion — should NOT get workout context:\n');

  const gasQ = 'still gassy today, its been a week';
  const rGas = await simulateFreshAsk(gasQ);
  console.log(`  👤 "${gasQ}"`);
  console.log(`  Context inherited: ${rGas.inherited}`);
  console.log(`  🤖 "${rGas.answer.slice(0,200)}..."\n`);

  if (!rGas.inherited) ok('gas question: workout context correctly rejected');
  else fail('gas question context bleed', `workout context injected. Summary was: "${summaryB.slice(0,80)}"`);

  console.log('  Now asking workout follow-up — should get Chain B context:\n');

  const workoutQ = 'actually what exercises for that day';
  const rWorkout = await simulateFreshAsk(workoutQ);
  console.log(`  👤 "${workoutQ}"`);
  console.log(`  Context inherited: ${rWorkout.inherited}`);
  console.log(`  🤖 "${rWorkout.answer.slice(0,200)}..."\n`);

  if (rWorkout.inherited) ok('workout follow-up: Chain B context correctly inherited');
  else fail('workout follow-up', `context not inherited. Summary was: "${summaryB.slice(0,80)}"`);

  // ──────────────────────────────────────────────────────────────
  // TEST 3: COMPLETELY AMBIGUOUS short messages
  // These could mean anything — test what the bot does
  // ──────────────────────────────────────────────────────────────
  section('TEST 3: AMBIGUOUS SHORT MESSAGES after workout chain');

  const ambiguous = [
    { msg: 'ok',            label: '"ok" — meaningless, should go fresh' },
    { msg: 'got it',        label: '"got it" — closing acknowledgement' },
    { msg: 'makes sense',   label: '"makes sense" — could continue anything' },
    { msg: 'sounds good',   label: '"sounds good" — same' },
  ];

  for (const t of ambiguous) {
    const r = await simulateFreshAsk(t.msg);
    // For truly ambiguous messages, we're not asserting inherit yes or no
    // Just checking the bot responds something sensible either way
    console.log(`  👤 "${t.msg}" → inherited: ${r.inherited}`);
    console.log(`  🤖 "${r.answer.slice(0,100)}..."\n`);
    if (r.answer.length > 5) ok(`${t.label} → answered cleanly`);
    else fail(t.label, 'empty response');
  }

  // ──────────────────────────────────────────────────────────────
  // RESULTS
  // ──────────────────────────────────────────────────────────────
  section('RESULTS');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length) failures.forEach(f => console.log('  •', f));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
