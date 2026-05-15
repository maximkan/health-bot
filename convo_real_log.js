#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db = require('./src/db');
const notion = require('./src/notion');

const CHAT_ID = 119445404;
const targetsText = notion.getTargetsText(CHAT_ID);

function user(msg) { console.log(`\n👤 YOU: ${msg}`); }
function bot(msg)  { console.log(`🤖 BOT: ${msg}`); }
function divider(label) { console.log(`\n${'─'.repeat(60)}\n  ${label}\n${'─'.repeat(60)}`); }

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

async function send(msg, chain) {
  // This is what handleAsk does: check if new message continues last summary
  const summaries = db.getRecentConversationSummaries(CHAT_ID, 1);
  let ctx = '';
  if (summaries.length) {
    const continues = await claude.isConversationContinuation(msg, summaries[0].summary);
    if (continues) ctx = `Previous conversation context:\n${summaries[0].summary}`;
  }
  const answer = await claude.askCoach(msg, ctx, targetsText, '', db.getState(CHAT_ID));
  chain.push({ role: 'user', content: msg });
  chain.push({ role: 'assistant', content: answer });
  user(msg);
  bot(answer);
  return answer;
}

async function continueChain(msg, chain) {
  // This is handleCoachReply: just continues with full chain in context
  const messages = chain.map(m => ({ role: m.role, content: m.content }));
  messages.push({ role: 'user', content: msg });
  const answer = await claude.continueCoachReply(messages, targetsText, db.getState(CHAT_ID));
  chain.push({ role: 'user', content: msg });
  chain.push({ role: 'assistant', content: answer });
  user(msg);
  bot(answer);
  // If chain hits 8 user messages, close it
  const userMsgs = chain.filter(m => m.role === 'user').length;
  if (userMsgs >= 8) {
    console.log('\n  [chain hit 8 — compressing and saving...]\n');
    const summary = await simulateClose(chain);
    console.log(`  [compressed: "${summary.slice(0,100)}..."]\n`);
    chain.length = 0; // reset for next chain
  }
  return answer;
}

async function main() {

  // ════════════════════════════════════════════════════════════
  // SCENARIO 1: CONTINUOUS 12-MESSAGE CONVO
  // Messages 1-8: creatine discussion (chain fills up and resets)
  // Messages 9-12: user continues naturally, no hint to bot
  // ════════════════════════════════════════════════════════════
  divider('SCENARIO 1: 12-message convo. Chain resets at 8. Does it continue naturally?');

  const chain1 = [];

  // Messages 1-8 (these fill the chain)
  await continueChain('should i take creatine', chain1);
  await continueChain('does it cause hair loss', chain1);
  await continueChain('which brand', chain1);
  await continueChain('how long till i notice it', chain1);
  await continueChain('will it affect my cut', chain1);
  await continueChain('do i need to cycle it', chain1);
  await continueChain('what about a loading phase', chain1);
  await continueChain('can i take it with caffeine', chain1);
  // ^ chain resets here

  // Messages 9-12: fresh send() — bot has to figure out context from summary
  console.log('\n  [chain reset. next messages go through handleAsk with continuation check]\n');
  await send('does it matter if i take it in the morning or night', []);
  await send('can i mix it into my shake', []);
  await send('what if i run out and miss a few days', []);
  await send('ok gonna order some today', []);

  // ════════════════════════════════════════════════════════════
  // SCENARIO 2: GUT CONVO → LOG → WORKOUT CONVO → ASK ABOUT GUT
  // Two completely different topics. Does wrong context bleed?
  // ════════════════════════════════════════════════════════════
  divider('SCENARIO 2: Gut convo closes. Workout convo closes. Then ask about gut again.');

  const chain2 = [];
  await continueChain('been having bad bloating after every meal this week', chain2);
  await continueChain('started when i upped my protein', chain2);
  await continueChain('should i cut dairy', chain2);
  // User logs a meal — chain closes with only 3 exchanges
  console.log('\n  [user logs a meal — chain closes]\n');
  await simulateClose(chain2);
  chain2.length = 0;

  // New topic: workout
  const chain3 = [];
  await continueChain('want to add a 4th training day', chain3);
  await continueChain('currently chest back legs', chain3);
  await continueChain('what day should i put it', chain3);
  console.log('\n  [user logs workout — chain closes]\n');
  await simulateClose(chain3);
  chain3.length = 0;

  // Now ask about gut — most recent summary is workout
  // Should NOT get workout context
  console.log('\n  [asking about gut — most recent summary is about workout programming]\n');
  await send('still bloated today, the dairy thing didnt help', []);

  // Then ask about workout — should get workout context
  console.log('\n  [asking about workout — should inherit workout context]\n');
  await send('actually what exercises for that arms day', []);

  // ════════════════════════════════════════════════════════════
  // SCENARIO 3: COMPLETELY FRESH TOPIC — no prior context applies
  // ════════════════════════════════════════════════════════════
  divider('SCENARIO 3: Totally new question with no relation to recent convos.');

  await send('whats the best time to do cardio for fat loss', []);

  // ════════════════════════════════════════════════════════════
  // SCENARIO 4: IMPLICIT REFERENCE — "that thing" without naming it
  // ════════════════════════════════════════════════════════════
  divider('SCENARIO 4: User references previous chat without naming what it was.');

  const chain4 = [];
  await continueChain('should i eat at NS today, thinking the double beef', chain4);
  await continueChain('how many calories is that roughly', chain4);
  await continueChain('ok going with it', chain4);
  console.log('\n  [chain closes via log]\n');
  await simulateClose(chain4);
  chain4.length = 0;

  // Implicit reference
  await send('ended up being pretty good actually', []);
  await send('felt a bit heavy though, should i go lighter next time', []);

  console.log('\n\nDONE.\n');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
