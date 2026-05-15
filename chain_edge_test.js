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

// Simulates the EXACT handleCoachReply logic:
// builds messages array, pushes new user msg, calls continueCoachReply
async function simulateContinueReply(chainMessages, newUserMsg) {
  const messages = chainMessages.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: newUserMsg });
  return claude.continueCoachReply(messages, targetsText, db.getState(CHAT_ID));
}

// Simulates closeChain: summarize + update profile + save
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

// Simulates handleAsk for message N after chain reset:
// checks if new message continues previous summary, injects if yes
async function simulateFreshAsk(newMsg) {
  const summaries = db.getRecentConversationSummaries(CHAT_ID, 1);
  let ctx = '';
  if (summaries.length) {
    const continues = await claude.isConversationContinuation(newMsg, summaries[0].summary);
    if (continues) ctx = `Previous conversation context:\n${summaries[0].summary}`;
  }
  return {
    answer: await claude.askCoach(newMsg, ctx, targetsText, '', db.getState(CHAT_ID)),
    hadContext: ctx.length > 0,
  };
}

async function main() {

  // ─────────────────────────────────────────────────────────────────
  // TEST 1: CONTINUOUS 12-MESSAGE CONVO — crosses 8-turn boundary
  // Messages 1-8: build chain, discuss creatine dosing
  // Message 9: SAME TOPIC — should inherit context seamlessly
  // Message 10-12: continue naturally
  // ─────────────────────────────────────────────────────────────────
  section('TEST 1: 12-MESSAGE CONTINUOUS CONVO (crosses 8-turn boundary)');

  const chain1 = [
    { role: 'user',      content: 'should i take creatine' },
    { role: 'assistant', content: '5g/day creatine monohydrate. Take it any time — timing doesn\'t matter. Benefits: +5-10% strength, better recovery, slight muscle fullness.' },
    { role: 'user',      content: 'does it cause hair loss' },
    { role: 'assistant', content: 'The DHT study was one small trial — never replicated. Current evidence: no meaningful link between creatine and hair loss at 5g/day. If you\'re genetically prone to baldness it may slightly accelerate it, but that\'s theoretical.' },
    { role: 'user',      content: 'ok i\'ll take it. what brand' },
    { role: 'assistant', content: 'Creapure (German pharmaceutical grade) is the gold standard. MyProtein, Optimum Nutrition, and Bulk both use Creapure. Avoid cheap blends with added "complexes" — pure monohydrate is all you need.' },
    { role: 'user',      content: 'how long till i notice it' },
    { role: 'assistant', content: '2-4 weeks at 5g/day. You\'ll notice: more reps on the same weight, better pump, recovery feels faster. Scale may go up 1-2kg — that\'s intracellular water, not fat.' },
    { role: 'user',      content: 'will it affect my cut' },
    { role: 'assistant', content: 'No, it won\'t hinder fat loss. The water weight is intramuscular — it doesn\'t make you look puffy. You\'ll actually look more muscular while cutting, which is a win.' },
    { role: 'user',      content: 'should i cycle it' },
    { role: 'assistant', content: 'No need. Cycling creatine was a 90s myth. Your receptors don\'t downregulate. Take 5g daily indefinitely — you don\'t need on/off periods.' },
    { role: 'user',      content: 'what about loading phase' },
    { role: 'assistant', content: 'Optional. 20g/day for 5-7 days saturates faster but causes more water retention and GI discomfort for some people. Steady 5g/day reaches the same saturation in 3-4 weeks. Not worth the loading hassle.' },
    // Message 8 triggers chain close
  ];

  const summary1 = await simulateClose(chain1);
  console.log(`  Chain closed. Summary: "${summary1.slice(0, 90)}..."`);

  // Message 9 — same topic, should inherit
  const msg9 = 'wait — you said 5g per day, does it matter if i take it all at once or split it';
  const result9 = await simulateFreshAsk(msg9);

  if (result9.hadContext) ok('msg 9 (same topic): context inherited after chain reset');
  else fail('msg 9 same topic', 'context NOT inherited — conversation broken');

  // Check the response actually knows we were discussing creatine
  const knowsCreatine = result9.answer.toLowerCase().includes('creatine') || result9.answer.toLowerCase().includes('5g');
  if (knowsCreatine) ok('msg 9 response references creatine — seamless continuation');
  else fail('msg 9 response quality', `doesn't mention creatine: "${result9.answer.slice(0,100)}"`);

  console.log(`  Msg 9 answer: "${result9.answer.slice(0, 120)}..."`);

  // Messages 10-12: continue the creatine thread
  const continuations = [
    'can i mix it in my protein shake',
    'what if i miss a day',
    'ok starting tomorrow',
  ];
  for (const msg of continuations) {
    const r = await simulateFreshAsk(msg);
    const label = `"${msg}" — ${r.hadContext ? 'inherited context' : 'fresh (context faded)'}`;
    // These might or might not inherit — just check they don't crash and give sensible answers
    if (r.answer.length > 10) ok(label);
    else fail(label, 'empty response');
  }

  // ─────────────────────────────────────────────────────────────────
  // TEST 2: SHORT CHAIN (4 exchanges), closed by a LOG
  // Then new question SAME TOPIC — should inherit
  // ─────────────────────────────────────────────────────────────────
  section('TEST 2: SHORT CHAIN (4 exchanges) closed by log → same topic next');

  const shortChain = [
    { role: 'user',      content: 'thinking about adding a pre-workout, is it worth it' },
    { role: 'assistant', content: 'Depends what\'s in it. Most pre-workouts are just caffeine + beta-alanine + some fillers. 200mg caffeine 30min before training does the same thing for a fraction of the cost.' },
    { role: 'user',      content: 'what about the tingles from beta-alanine' },
    { role: 'assistant', content: 'Paresthesia — harmless. Beta-alanine builds up in muscles and causes that pins-and-needles feeling. It fades after a few weeks of regular use. Split doses reduce it.' },
    { role: 'user',      content: 'does beta-alanine actually do anything' },
    { role: 'assistant', content: 'Yes — it increases carnosine in muscles, which buffers lactic acid. Real benefit for high-rep sets and endurance. Less noticeable for heavy strength work.' },
    { role: 'user',      content: 'which pre-workout has good doses of both' },
    { role: 'assistant', content: 'Transparent Labs BULK has clinical doses: 200mg caffeine, 4g beta-alanine, 6g citrulline. Pricey but actually dosed properly. Most cheap ones are under-dosed.' },
  ];

  const summary2 = await simulateClose(shortChain);
  console.log(`  Chain closed at 4 exchanges. Summary: "${summary2.slice(0,90)}..."`);

  // Simulate: user logs a meal (chain close already happened above)
  // Now asks follow-up on same topic
  const followUpSame = 'actually how much caffeine is in a coffee vs that pre-workout';
  const r2 = await simulateFreshAsk(followUpSame);

  if (r2.hadContext) ok('post-log same topic: context inherited correctly');
  else fail('post-log same topic', 'context lost after log-triggered close');
  console.log(`  Answer: "${r2.answer.slice(0, 120)}..."`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 3: SHORT CHAIN closed by log → DIFFERENT TOPIC next
  // Should NOT inherit pre-workout context when asking about sleep
  // ─────────────────────────────────────────────────────────────────
  section('TEST 3: SHORT CHAIN closed by log → completely different topic next');

  // Same summary2 still in DB — now ask something totally unrelated
  const differentTopic = 'my sleep has been terrible this week, only 5 hours';
  const r3 = await simulateFreshAsk(differentTopic);

  if (!r3.hadContext) ok('different topic after log: context correctly NOT inherited');
  else fail('different topic context bleed', 'pre-workout context injected into sleep question — wrong');
  console.log(`  Answer: "${r3.answer.slice(0,120)}..."`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 4: TWO TOPICS BACK TO BACK — boundary detection
  // Chain A: digestion. Chain B: workout programming.
  // After B closes, asking about digestion should NOT inherit B context
  // ─────────────────────────────────────────────────────────────────
  section('TEST 4: TWO DIFFERENT CHAINS — does wrong context bleed through?');

  const chainA = [
    { role: 'user',      content: 'gut has been off since i started creatine, lot of gas' },
    { role: 'assistant', content: 'Creatine can cause GI issues if taken in large doses or on an empty stomach. Try taking it with food and reducing to 3g/day temporarily.' },
    { role: 'user',      content: 'ok will try with food. anything else?' },
    { role: 'assistant', content: 'Stay well hydrated — creatine pulls water into muscles which can dehydrate the gut. 3+ litres a day. If it persists, switch to creatine HCl which is easier on the stomach.' },
  ];

  const chainB = [
    { role: 'user',      content: 'i want to add a 4th training day, what should it be' },
    { role: 'assistant', content: 'With 3 days already: add upper body hypertrophy — chest/shoulder/tricep focus. Or add a full cardio/conditioning day if fat loss is priority.' },
    { role: 'user',      content: 'hypertrophy sounds good, what exercises' },
    { role: 'assistant', content: 'Incline dumbbell press 4x10, cable flyes 3x15, lateral raises 4x15, overhead press 3x10, tricep pushdowns 3x15. 60-75min session.' },
    { role: 'user',      content: 'should i do it on wednesday' },
    { role: 'assistant', content: 'Wednesday works if you\'re resting Mon and Fri. Mon-Wed-Fri-Sat split gives good recovery. Avoid back to back days with chest heavy sessions.' },
  ];

  await simulateClose(chainA);
  console.log('  Chain A (digestion) closed.');
  const summaryB = await simulateClose(chainB);
  console.log(`  Chain B (workout) closed. Summary: "${summaryB.slice(0,80)}..."`);

  // Now ask about digestion — should NOT inherit Chain B (workout) context
  const digestQ = 'still having gas issues, is it the creatine?';
  const r4 = await simulateFreshAsk(digestQ);

  // Chain B is the most recent — its context should NOT be injected for a digestion question
  if (!r4.hadContext) ok('digestion question: does NOT inherit workout chain B context');
  else {
    // If it did inherit, check if the inherited context is the digestion one (chain A) — which would be correct
    // but chain A is older so it may not be retrieved
    fail('context bleed check', `workout context may have been injected into digestion question`);
  }
  console.log(`  Answer: "${r4.answer.slice(0,120)}..."`);

  // Workout follow-up SHOULD inherit Chain B
  const workoutQ = 'actually for that 4th day, should i go heavier or focus on volume';
  const r5 = await simulateFreshAsk(workoutQ);

  if (r5.hadContext) ok('workout follow-up: correctly inherits Chain B context');
  else fail('workout follow-up', 'context not inherited for direct workout continuation');
  console.log(`  Answer: "${r5.answer.slice(0,120)}..."`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 5: IMPLICIT REFERENCE — user says something that only makes
  // sense if you know the previous chain
  // ─────────────────────────────────────────────────────────────────
  section('TEST 5: IMPLICIT REFERENCE — no keywords, just implied context');

  const chainC = [
    { role: 'user',      content: 'should i eat at the NS cafe today, thinking the korean bbq set' },
    { role: 'assistant', content: 'Korean BBQ set at NS is around 650-700 kcal, ~45g protein. Given you have 900 kcal left for the day, it fits but leaves you tight for dinner.' },
    { role: 'user',      content: 'what if i get the chicken rice instead' },
    { role: 'assistant', content: 'NS chicken rice is about 550 kcal, 38g protein. Better calorie room but lower protein. If you\'re close to protein target, add a side of eggs.' },
    { role: 'user',      content: 'ok going with chicken rice and one egg' },
    { role: 'assistant', content: 'Good call. That\'s ~630 kcal, ~44g protein. Leaves ~270 kcal for dinner. Keep dinner light — salad with protein, or a shake.' },
  ];

  const summaryC = await simulateClose(chainC);
  console.log(`  Chain C (NS lunch decision) closed. Summary: "${summaryC.slice(0,80)}..."`);

  // Implicit follow-up — user doesn't say "NS" or "chicken rice" explicitly
  const implicitMsg = 'ended up going with that, was pretty good';
  const r6 = await simulateFreshAsk(implicitMsg);

  if (r6.hadContext) ok('"ended up going with that" — implicit reference correctly triggers context');
  else fail('implicit reference', 'context not inherited — bot has no idea what "that" refers to');
  console.log(`  Answer: "${r6.answer.slice(0, 120)}..."`);

  // ─────────────────────────────────────────────────────────────────
  // TEST 6: STALE CONTEXT — chain from yesterday, ask new topic today
  // Should NOT inject old context for a fresh unrelated question
  // ─────────────────────────────────────────────────────────────────
  section('TEST 6: BRAND NEW TOPIC — no relation to any previous chain');

  const brandNewQ = 'whats the best time to do cardio';
  const r7 = await simulateFreshAsk(brandNewQ);

  // This could go either way — "best time for cardio" might relate to workout timing chain
  // The answer should be good regardless
  if (r7.answer.length > 20) ok(`brand new question answers cleanly (context: ${r7.hadContext ? 'inherited' : 'fresh'})`);
  else fail('brand new question', 'empty or broken response');
  console.log(`  Answer: "${r7.answer.slice(0,120)}..."`);

  // ─────────────────────────────────────────────────────────────────
  // FINAL
  // ─────────────────────────────────────────────────────────────────
  section('RESULTS');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length) failures.forEach(f => console.log('  •', f));
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
