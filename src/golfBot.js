const TelegramBot = require('node-telegram-bot-api');
const config  = require('./config');
const db      = require('./db');
const claude  = require('./claude');
const notion  = require('./notion');

const LOG_KEYWORDS = {
  course: /\b(played|course|round|shot|hole|par|birdie|bogey|eagle|score)\b/i,
  range:  /\b(range|practiced|practice|hit balls|driving range|warm[- ]?up)\b/i,
  coach:  /\b(lesson|coach|instructor|drill|tip)\b/i,
};

async function downloadPhoto(bot, msg) {
  const largest = msg.photo[msg.photo.length - 1];
  const link = await bot.getFileLink(largest.file_id);
  const res = await fetch(link);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

let _golfHubCache = null;
let _golfHubFetched = 0;

async function getGolfHubContext() {
  if (_golfHubCache && Date.now() - _golfHubFetched < 30 * 60 * 1000) return _golfHubCache;
  try {
    _golfHubCache = await notion.getGolfHubContent();
    _golfHubFetched = Date.now();
    return _golfHubCache;
  } catch { return ''; }
}

async function routeGolfMessage(bot, msg) {
  const chatId = msg.chat.id;
  const text   = msg.text || msg.caption || '';

  // Photo → analyze
  if (msg.photo) {
    await bot.sendChatAction(chatId, 'typing');
    try {
      const photoBase64 = await downloadPhoto(bot, msg);
      const caption = msg.caption || 'Analyze my golf stance, grip, or this scene.';
      const answer = await claude.analyzeGolfPhoto(photoBase64, caption);
      await bot.sendMessage(chatId, answer);
    } catch (err) {
      console.error('Golf photo error:', err.message);
      await bot.sendMessage(chatId, '❌ Could not analyze photo. Try again.');
    }
    return;
  }

  if (!text) return;

  // Detect session type
  let sessionType = null;
  if (LOG_KEYWORDS.course.test(text)) sessionType = 'Course Round';
  else if (LOG_KEYWORDS.range.test(text)) sessionType = 'Range Practice';
  else if (LOG_KEYWORDS.coach.test(text)) sessionType = 'Coach Session';

  if (sessionType) {
    await bot.sendChatAction(chatId, 'typing');
    try {
      const recentSessions = await notion.getGolfHistory(3).catch(() => []);
      const sessionData = await claude.parseGolfSession(text, sessionType);

      await notion.createGolfEntry(sessionData);

      // Also have a conversational follow-up
      const followUp = await generateGolfFollowUp(chatId, text, sessionData, sessionType);
      await bot.sendMessage(chatId, followUp);

      // Save to history
      db.saveGolfMessage(chatId, 'user', text);
      db.saveGolfMessage(chatId, 'assistant', followUp);
    } catch (err) {
      console.error('Golf session log error:', err.message);
      await bot.sendMessage(chatId, '❌ Failed to log session. Try again.');
    }
    return;
  }

  // Conversational mode
  await bot.sendChatAction(chatId, 'typing');
  try {
    // Compact history if > 20 messages
    const count = db.getGolfMessageCount(chatId);
    if (count > 20) {
      const old = db.getGolfHistory(chatId, 10).slice(0, 10);
      const oldText = old.map(m => `${m.role}: ${m.content}`).join('\n');
      const summary = await claude.chatGolf([
        { role: 'user', content: `Summarize this golf conversation in 2-3 sentences:\n${oldText}` }
      ]);
      db.deleteOldGolfMessages(chatId, 10);
      db.saveGolfMessage(chatId, 'assistant', `[Earlier conversation summary: ${summary}]`);
    }

    const history = db.getGolfHistory(chatId, 10);
    const hubCtx  = await getGolfHubContext();
    const recentSessions = await notion.getGolfHistory(3).catch(() => []);

    const messages = history.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: text });

    const answer = await claude.chatGolf(messages, hubCtx, recentSessions);

    db.saveGolfMessage(chatId, 'user', text);
    db.saveGolfMessage(chatId, 'assistant', answer);

    await bot.sendMessage(chatId, answer);
  } catch (err) {
    console.error('Golf chat error:', err.message);
    await bot.sendMessage(chatId, '❌ Something went wrong. Try again.');
  }
}

async function generateGolfFollowUp(chatId, userText, sessionData, sessionType) {
  const recentSessions = await notion.getGolfHistory(3).catch(() => []);
  const hubCtx = await getGolfHubContext();
  const messages = [
    { role: 'user', content: `I just had a ${sessionType}. Here's what I logged: ${userText}\n\nParsed data: ${JSON.stringify(sessionData, null, 2)}\n\nGive me a brief response (2-3 sentences): acknowledge the session, reference anything notable from recent sessions if relevant, give one specific actionable takeaway for next time.` }
  ];
  return claude.chatGolf(messages, hubCtx, recentSessions);
}

function startGolfBot() {
  if (!config.telegram.golfToken) {
    console.log('⚠️  TELEGRAM_GOLF_BOT_TOKEN not set — golf bot skipped');
    return null;
  }

  const bot = new TelegramBot(config.telegram.golfToken, { polling: true });
  console.log('✅ Golf bot polling started');

  bot.on('message', async (msg) => {
    try { await routeGolfMessage(bot, msg); }
    catch (err) { console.error('Golf bot error:', err.message); }
  });

  bot.on('polling_error', (err) => console.error('Golf polling error:', err.code, err.message));

  return bot;
}

module.exports = { startGolfBot };
