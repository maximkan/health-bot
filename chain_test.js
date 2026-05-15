#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db = require('./src/db');
const db = require('./src/db');

const CHAT_ID = 119445404;

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  CHAIN OVERFLOW + CONTINUITY TEST');
  console.log('══════════════════════════════════════════\n');

  const targetsText = db.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  const currentProfile = db.getUserProfile(CHAT_ID);

  // ─── Simulate a realistic 8-turn conversation ───────────────────────────────
  // Topic: user wants to know what to eat for the rest of today
  // The coach makes a specific recommendation: 200g salmon + sweet potato
  // We want to see if that specific recommendation survives the chain overflow

  const chain = [
    { role: 'user',      content: 'hey so i have 800 kcal and 60g protein left for today. what should i eat for dinner?' },
    { role: 'assistant', content: 'With 800 kcal and 60g protein left, I\'d go with 200g salmon + medium sweet potato + greens. That\'s roughly 620 kcal / 46g protein. Leaves room for a small snack if needed.' },
    { role: 'user',      content: 'salmon sounds good. can i do it with rice instead of sweet potato?' },
    { role: 'assistant', content: 'Yes, 150g cooked rice instead of sweet potato keeps you at ~700 kcal. Macro split stays similar — you\'d hit your protein target with about 50g left.' },
    { role: 'user',      content: 'and what if i add a fried egg on top?' },
    { role: 'assistant', content: 'Fried egg adds ~90 kcal / 6g protein. Total would be ~790 kcal / 52g protein — nearly perfect for your remaining targets.' },
    { role: 'user',      content: 'nice. how should i cook the salmon? pan fry?' },
    { role: 'assistant', content: 'Pan fry with a small amount of olive oil or butter. Medium-high heat, 3-4 min per side. Season with salt, pepper, lemon. Simple and keeps the macros clean.' },
    { role: 'user',      content: 'got it. and is salmon the best option here or would chicken be better?' },
    { role: 'assistant', content: 'Salmon is better here — you get omega-3s on top of the protein, and it hits your calorie target without needing to over-eat. Chicken would require ~250g to hit 46g protein, saving only ~80 kcal. Salmon wins for the nutritional density.' },
    { role: 'user',      content: 'ok makes sense. should i have the snack you mentioned or is that unnecessary?' },
    { role: 'assistant', content: 'Skip the snack if you\'re not hungry. You\'ll be at ~790/800 kcal and 52/60g protein — close enough. Save the 10g protein gap for tomorrow. Chasing macros to the gram before bed usually isn\'t worth it.' },
    { role: 'user',      content: 'fair. ok one more thing — what time should i stop eating?' },
    { role: 'assistant', content: 'No hard rule, but ideally 2-3h before bed. If you sleep around midnight, finish dinner by 9-9:30pm. Digestion quality is better and it keeps insulin low before sleep.' },
    // Turn 8 — this is where it should overflow and close
    { role: 'user',      content: 'ok thanks. and any specific salmon brand you\'d recommend from the supermarket?' },
  ];

  console.log('STEP 1: Simulating an 8-turn conversation about salmon dinner...');
  console.log('(Last user message is turn 8 — triggers chain close)\n');

  // Simulate closeChain: summarize + update profile
  const convText = chain.map(m => `${m.role}: ${m.content}`).join('\n');

  console.log('STEP 2: Running closeChain operations...');
  const [summary, updatedProfile] = await Promise.all([
    claude.summarizeConversation(chain),
    claude.updateUserProfile(convText, currentProfile),
  ]);

  console.log('\n📋 CONVERSATION SUMMARY:');
  console.log(summary);

  console.log('\n👤 UPDATED USER PROFILE (diff from current):');
  if (updatedProfile !== currentProfile) {
    console.log('Profile was updated.');
    console.log('(Snippet):', updatedProfile.slice(0, 400));
  } else {
    console.log('⚠️  Profile unchanged — conversation not absorbed into user knowledge.');
  }

  // Save to DB as closeChain would
  db.saveCoachConversation(CHAT_ID, chain, summary);
  db.setUserProfile(CHAT_ID, updatedProfile);
  console.log('\n✅ Summary + profile saved to DB');

  // ─── Now simulate the FRESH handleAsk after chain overflow ──────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('STEP 3: Fresh handleAsk — user replies to chain overflow');
  console.log('══════════════════════════════════════════');

  // This is the question that SHOULD be answerable from context but ISN'T
  // because handleAsk doesn't read coach_conversations summaries
  const followUpQ1 = 'actually wait, what was that meal you recommended again? the salmon one';
  const followUpQ2 = 'ok so you were saying 200g salmon + rice + fried egg right? should i just do that?';
  const followUpQ3 = 'perfect. one more thing — earlier you said something about stopping eating 2-3 hours before bed. what time is that for me if i sleep at midnight?';

  const recentSummaries = db.getRecentConversationSummaries(CHAT_ID, 3);

  // Test A: WITHOUT summary injection (current behavior)
  console.log('\n─── Test A: Fresh coach WITHOUT summary context (current behavior) ───');
  const freshStateA = db.getState(CHAT_ID);
  const answerA = await claude.askCoach(followUpQ1, '', targetsText, '', freshStateA);
  console.log(`\nQ: "${followUpQ1}"`);
  console.log(`A: ${answerA}`);

  const hasMemoryA = answerA.toLowerCase().includes('salmon') || answerA.toLowerCase().includes('200g') || answerA.toLowerCase().includes('rice');
  console.log(`\n${hasMemoryA ? '✅' : '❌'} Coach ${hasMemoryA ? 'DID' : 'DID NOT'} remember the salmon recommendation`);

  // Test B: WITH summary injected into context (proposed fix)
  console.log('\n─── Test B: Fresh coach WITH summary injected (proposed fix) ───');
  const summaryCtx = recentSummaries.length
    ? `\nRecent conversation context:\n${recentSummaries.map(s => s.summary).join('\n---\n')}`
    : '';

  const answerB = await claude.askCoach(followUpQ1, summaryCtx, targetsText, '', freshStateA);
  console.log(`\nQ: "${followUpQ1}"`);
  console.log(`A: ${answerB}`);

  const hasMemoryB = answerB.toLowerCase().includes('salmon') || answerB.toLowerCase().includes('200g') || answerB.toLowerCase().includes('rice');
  console.log(`\n${hasMemoryB ? '✅' : '❌'} Coach ${hasMemoryB ? 'DID' : 'DID NOT'} remember the salmon recommendation`);

  // Test C: Clearer callback reference
  console.log('\n─── Test C: Direct callback ("you were saying 200g salmon") ───');
  const answerC_noCtx = await claude.askCoach(followUpQ2, '', targetsText, '', freshStateA);
  const answerC_ctx   = await claude.askCoach(followUpQ2, summaryCtx, targetsText, '', freshStateA);
  console.log(`\nQ: "${followUpQ2}"`);
  console.log(`Without ctx: ${answerC_noCtx.slice(0, 120)}...`);
  console.log(`With ctx:    ${answerC_ctx.slice(0, 120)}...`);

  // Test D: Time reference from previous chain
  console.log('\n─── Test D: Reference to advice given during chain ("you said 2-3h before bed") ───');
  const answerD_noCtx = await claude.askCoach(followUpQ3, '', targetsText, '', freshStateA);
  const answerD_ctx   = await claude.askCoach(followUpQ3, summaryCtx, targetsText, '', freshStateA);
  console.log(`\nQ: "${followUpQ3}"`);
  console.log(`Without ctx: ${answerD_noCtx.slice(0, 150)}...`);
  console.log(`With ctx:    ${answerD_ctx.slice(0, 150)}...`);

  // ─── Now simulate a FULL 20-message flow ────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('STEP 4: 20-message realistic conversation');
  console.log('(Messages 1-8: chain 1, message 9 triggers overflow, 9-16: chain 2, 17+ triggers overflow again)');
  console.log('══════════════════════════════════════════\n');

  // Fresh conversation — new topic: user asks about meal prep for the week
  const chain2_messages = [
    { role: 'user', content: 'i want to do meal prep this sunday. can you help me plan what to cook?' },
    { role: 'assistant', content: 'Sure. Given your targets (~2000 kcal, high protein), I\'d suggest: chicken breast as base protein, brown rice or sweet potato for carbs, roasted veg (broccoli, peppers, zucchini). You can batch cook Sunday and cover Mon-Wed.' },
    { role: 'user', content: 'how much chicken should i buy for 3 days of lunches?' },
    { role: 'assistant', content: 'For 3 lunches at 250g cooked chicken each: buy ~1kg raw chicken breast. About 30-35% shrinks when cooking.' },
    { role: 'user', content: 'and for dinner too? should i prep dinner separately?' },
    { role: 'assistant', content: 'Yes, prep dinner separately — different seasoning keeps it from getting boring. I\'d do 1kg for lunches + 800g for dinners. Total: 1.8kg raw chicken breast for the week.' },
    { role: 'user', content: 'ok. what about carbs? rice or sweet potato?' },
    { role: 'assistant', content: 'Mix both. Rice for lunches (easy to portion), sweet potato for dinners (more micronutrients, slower release). Cook 500g dry rice + 4 medium sweet potatoes.' },
    { role: 'user', content: 'sounds good. how do i keep it fresh for 3-4 days?' },
    { role: 'assistant', content: 'Glass containers if you have them — chicken + rice in one, sweet potato in another. Fridge keeps it good for 4 days. After day 4, discard. Don\'t freeze cooked rice.' },
    { role: 'user', content: 'what about eggs? should i hard boil some for snacks?' },
    { role: 'assistant', content: 'Yes, hard boil 10-12 eggs. Easy 6g protein snack per egg, no reheating needed. Keeps in the fridge 5-7 days with the shell on.' },
    // Message 8 — chain should overflow here
    { role: 'user', content: 'perfect. how long will all this take to prep on sunday?' },
  ];

  console.log('Simulating chain 2 (meal prep conversation, 8 turns)...');

  const convText2 = chain2_messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const [summary2, updatedProfile2] = await Promise.all([
    claude.summarizeConversation(chain2_messages),
    claude.updateUserProfile(convText2, db.getUserProfile(CHAT_ID)),
  ]);

  db.saveCoachConversation(CHAT_ID, chain2_messages, summary2);
  db.setUserProfile(CHAT_ID, updatedProfile2);

  console.log('\n📋 CHAIN 2 SUMMARY:');
  console.log(summary2);

  // Now messages 9-16: user asks about meal prep cost, referencing chain 1 AND chain 2
  const allSummaries = db.getRecentConversationSummaries(CHAT_ID, 5);
  const fullSummaryCtx = allSummaries.length
    ? `\nPrevious conversations:\n${allSummaries.map((s, i) => `[${i+1}] ${s.summary}`).join('\n---\n')}`
    : '';

  const msg9 = 'wait — so between the salmon dinner we discussed and this meal prep, how many grams of protein am i getting per day on average?';

  console.log('\n─── Message 9 (after 2 chain overflows, cross-references both chains) ───');
  const answer9_noCtx = await claude.askCoach(msg9, '', targetsText, '', db.getState(CHAT_ID));
  const answer9_ctx   = await claude.askCoach(msg9, fullSummaryCtx, targetsText, '', db.getState(CHAT_ID));

  console.log(`\nQ: "${msg9}"`);
  console.log(`\nWithout ctx (current):\n${answer9_noCtx}`);
  console.log(`\nWith ctx (fix):\n${answer9_ctx}`);

  // ─── VERDICT ────────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('══════════════════════════════════════════');
  console.log('Current behavior: handleAsk does NOT inject coach_conversations summaries.');
  console.log('When chain overflows, previous conversation context is LOST in fresh calls.');
  console.log('');
  console.log('Fix needed: inject getRecentConversationSummaries() into handleAsk context');
  console.log('when there are recent summaries available.');
  console.log('══════════════════════════════════════════\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
