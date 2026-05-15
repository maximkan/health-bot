#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const db     = require('./src/db');
const claude = require('./src/claude');
const { handleAsk, handleCoachReply, closeChain } = require('./src/handlers/ask');

const CHAT_ID = 119445404;
let msgIdCounter = 90000;

function makeMockBot() {
  const bot = {
    _lastMsgId: null,
    async sendMessage(chatId, text) {
      const id = ++msgIdCounter;
      bot._lastMsgId = id;
      console.log(`\n🤖 BOT:\n${text}\n`);
      return { message_id: id, chat: { id: chatId }, text };
    },
    async sendChatAction() {},
  };
  return bot;
}

function makeMsg(text, replyToMsgId = null) {
  const id = ++msgIdCounter;
  const msg = {
    message_id: id,
    chat: { id: CHAT_ID },
    from: { id: CHAT_ID, first_name: 'Max' },
    text,
    date: Math.floor(Date.now() / 1000),
  };
  if (replyToMsgId) msg.reply_to_message = { message_id: replyToMsgId };
  return msg;
}

// Send a question through the real handleAsk, return bot's reply message_id
async function userSays(bot, text, replyToId = null) {
  console.log(`👤 YOU: ${text}`);
  const msg = makeMsg(text, replyToId);
  const state = db.getState(CHAT_ID);

  if (replyToId && replyToId === state.last_coach_message_id) {
    await handleCoachReply(bot, msg, replyToId);
  } else {
    await handleAsk(bot, msg);
  }
  return bot._lastMsgId;
}

// Simulate a log arriving — classify the text, and if it's a log, close any open chain
async function userLogs(bot, text) {
  console.log(`👤 YOU: ${text}  [LOG]`);
  const intents = await claude.classify(text, db.getHistory(CHAT_ID, 5));
  console.log(`   → classified as: ${intents.join(', ')}`);

  const LOG_INTENTS = new Set(['MEAL_LOG','DRINK_LOG','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG','WEIGHT_LOG']);
  if (intents.some(i => LOG_INTENTS.has(i))) {
    const state = db.getState(CHAT_ID);
    const prevChainId = state.last_coach_message_id;
    if (prevChainId) {
      const exchanges = db.countExchanges(CHAT_ID, prevChainId);
      if (exchanges >= 1) {
        await closeChain(CHAT_ID, prevChainId);
        console.log('   → chain closed + compressed\n');
      }
    }
  }
}

function divider(t) {
  console.log(`\n${'═'.repeat(55)}`);
  console.log(`  ${t}`);
  console.log(`${'═'.repeat(55)}\n`);
}

async function main() {

  // ══════════════════════════════════════════════════════
  // SCENARIO 1: Ask 3 questions → log a meal → continue
  // Does the bot inherit the protein context after the log?
  // ══════════════════════════════════════════════════════
  divider('SCENARIO 1: Ask 3 questions, log a meal, then continue on same topic');

  const bot1 = makeMockBot();

  let lastBotMsgId;
  lastBotMsgId = await userSays(bot1, 'how much protein should i be having per day');
  lastBotMsgId = await userSays(bot1, 'what if i cant hit it some days', lastBotMsgId);
  lastBotMsgId = await userSays(bot1, 'which foods are easiest to hit it with', lastBotMsgId);

  console.log('\n[user logs lunch]\n');
  await userLogs(bot1, 'just had chicken rice for lunch');

  console.log('\n[continuing on protein topic — no hint to bot]\n');
  lastBotMsgId = await userSays(bot1, 'what about eggs, how much protein per egg');
  lastBotMsgId = await userSays(bot1, 'so if i have 4 eggs that covers what percentage of my target');

  // ══════════════════════════════════════════════════════
  // SCENARIO 2: 10 back-and-forth on sleep — chain resets at 8, should continue naturally
  // ══════════════════════════════════════════════════════
  divider('SCENARIO 2: 10 back-and-forth on same topic, chain resets at 8, continues naturally');

  const bot2 = makeMockBot();

  lastBotMsgId = await userSays(bot2, 'my sleep has been terrible this week');
  lastBotMsgId = await userSays(bot2, 'waking up at 4am and cant go back to sleep', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'could it be the food im eating before bed', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'i usually have protein shake at 11pm', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'what about magnesium you think it would help', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'how much should i take', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'i have been on melatonin for 2 years is that a problem', lastBotMsgId);
  lastBotMsgId = await userSays(bot2, 'ok so i should stop melatonin, how do i do that', lastBotMsgId);
  // ^ chain should hit 8 here and reset

  console.log('\n[chain should have reset — next messages go fresh but inherit context]\n');

  lastBotMsgId = await userSays(bot2, 'how long will it take to feel better after stopping');
  lastBotMsgId = await userSays(bot2, 'what do i do on nights when i still cant sleep');

  // ══════════════════════════════════════════════════════
  // SCENARIO 3: Two different topics — does wrong context bleed?
  // ══════════════════════════════════════════════════════
  divider('SCENARIO 3: Two different topics — does wrong context bleed?');

  const bot3 = makeMockBot();

  lastBotMsgId = await userSays(bot3, 'is sauna good after training');
  lastBotMsgId = await userSays(bot3, 'how long should i stay in', lastBotMsgId);
  lastBotMsgId = await userSays(bot3, 'what temperature', lastBotMsgId);

  console.log('\n[user logs sauna session]\n');
  await userLogs(bot3, 'did 20min sauna at 90 degrees');

  console.log('\n[completely different topic now]\n');
  lastBotMsgId = await userSays(bot3, 'how many calories did i eat today');
  lastBotMsgId = await userSays(bot3, 'am i on track', lastBotMsgId);

  console.log('\n[back to sauna topic — should NOT reference calories, should reference sauna]\n');
  lastBotMsgId = await userSays(bot3, 'is cold plunge better than just cold shower after sauna');

  console.log('\nDONE.\n');
}

main().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
