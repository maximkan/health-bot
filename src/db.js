const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS user_state (
    chat_id INTEGER PRIMARY KEY,
    status TEXT DEFAULT 'sleeping',
    current_day_start INTEGER,
    bed_time INTEGER
  );
  CREATE TABLE IF NOT EXISTS coach_reply_chain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    role TEXT,
    content TEXT,
    timestamp TEXT,
    coach_message_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS message_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    message_text TEXT,
    message_type TEXT,
    timestamp TEXT,
    telegram_message_id INTEGER
  );
  CREATE TABLE IF NOT EXISTS golf_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    role TEXT,
    content TEXT,
    timestamp TEXT
  );
`);

function addCol(tbl, col, def) {
  try { db.exec(`ALTER TABLE ${tbl} ADD COLUMN ${col} ${def}`); } catch {}
}
addCol('user_state', 'caffeine_today_mg', 'INTEGER DEFAULT 0');
addCol('user_state', 'last_caffeine_time', 'TEXT');
addCol('user_state', 'last_coach_message_id', 'INTEGER');
addCol('user_state', 'last_coach_context', 'TEXT');
addCol('user_state', 'bed_nudge_sent', 'INTEGER DEFAULT 0');
addCol('user_state', 'weekly_waiting_weight', 'INTEGER DEFAULT 0');
addCol('user_state', 'bed_plans_tomorrow', 'TEXT');

const hasNewPlans = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('plans') WHERE name='plan_date'").get().c > 0;
if (!hasNewPlans) {
  db.exec('DROP TABLE IF EXISTS plans');
  db.exec(`CREATE TABLE plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    plan_text TEXT,
    plan_date TEXT,
    plan_time TEXT,
    status TEXT DEFAULT 'pending',
    recurring TEXT DEFAULT 'one-time',
    last_reminded TEXT,
    notion_page_id TEXT,
    calendar_event_created INTEGER DEFAULT 0,
    guests TEXT,
    location TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

const stmts = {
  getState: db.prepare('SELECT * FROM user_state WHERE chat_id = ?'),
  upsertState: db.prepare(`INSERT INTO user_state (chat_id,status,current_day_start,bed_time,caffeine_today_mg,last_caffeine_time,last_coach_message_id,last_coach_context,bed_nudge_sent,weekly_waiting_weight) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET status=excluded.status,current_day_start=excluded.current_day_start,bed_time=excluded.bed_time,caffeine_today_mg=excluded.caffeine_today_mg,last_caffeine_time=excluded.last_caffeine_time,last_coach_message_id=excluded.last_coach_message_id,last_coach_context=excluded.last_coach_context,bed_nudge_sent=excluded.bed_nudge_sent,weekly_waiting_weight=excluded.weekly_waiting_weight`),
  allChats: db.prepare('SELECT chat_id FROM user_state'),

  savePlan: db.prepare("INSERT INTO plans (chat_id,plan_text,plan_date,plan_time,status,recurring,guests,location,created_at) VALUES (?,?,?,?,'pending',?,?,?,datetime('now'))"),
  getPlansByDate: db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_date=? AND status NOT IN ('done','skipped') ORDER BY plan_time ASC"),
  getPendingUntimed: db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_time IS NULL AND status='pending' ORDER BY created_at ASC"),
  getPendingTimed: db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_date=? AND plan_time IS NOT NULL AND status IN ('pending','reminded') ORDER BY plan_time ASC"),
  updatePlanStatus: db.prepare("UPDATE plans SET status=? WHERE id=?"),
  markPlanReminded: db.prepare("UPDATE plans SET status='reminded',last_reminded=datetime('now') WHERE id=?"),
  setPlanNotionId: db.prepare("UPDATE plans SET notion_page_id=? WHERE id=?"),
  setPlanCalendar: db.prepare("UPDATE plans SET calendar_event_created=1 WHERE id=?"),
  getLastPending: db.prepare("SELECT * FROM plans WHERE chat_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1"),
  getAllPending: db.prepare("SELECT * FROM plans WHERE chat_id=? AND status NOT IN ('done','skipped') ORDER BY plan_date,plan_time"),

  saveReply: db.prepare("INSERT INTO coach_reply_chain (chat_id,role,content,timestamp,coach_message_id) VALUES (?,?,?,datetime('now'),?)"),
  getChain: db.prepare('SELECT * FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=? ORDER BY id ASC LIMIT 10'),
  clearChain: db.prepare('DELETE FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=?'),
  countExchanges: db.prepare("SELECT COUNT(*) as c FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=? AND role='user'"),

  logMessage: db.prepare("INSERT INTO message_log (chat_id,message_text,message_type,timestamp,telegram_message_id) VALUES (?,?,?,datetime('now'),?)"),
  getRecentMessages: db.prepare('SELECT * FROM message_log WHERE chat_id=? ORDER BY id DESC LIMIT ?'),

  saveGolfMsg: db.prepare("INSERT INTO golf_messages (chat_id,role,content,timestamp) VALUES (?,?,?,datetime('now'))"),
  getGolfHistory: db.prepare('SELECT * FROM golf_messages WHERE chat_id=? ORDER BY id DESC LIMIT ?'),
  countGolfMessages: db.prepare('SELECT COUNT(*) as c FROM golf_messages WHERE chat_id=?'),
  deleteOldGolfMessages: db.prepare('DELETE FROM golf_messages WHERE chat_id=? AND id IN (SELECT id FROM golf_messages WHERE chat_id=? ORDER BY id ASC LIMIT ?)'),
  clearGolfHistory: db.prepare('DELETE FROM golf_messages WHERE chat_id=?'),
};

// ── User state ────────────────────────────────────────────────────────────────

function getState(chatId) {
  const existing = stmts.getState.get(chatId);
  if (existing) return existing;
  const OFFSET_MS = 8 * 60 * 60 * 1000;
  const nowMYT = new Date(Date.now() + OFFSET_MS);
  const midnightUTC = Date.UTC(nowMYT.getUTCFullYear(), nowMYT.getUTCMonth(), nowMYT.getUTCDate()) - OFFSET_MS;
  return { chat_id: chatId, status: 'sleeping', current_day_start: null, bed_time: null, caffeine_today_mg: 0, last_caffeine_time: null, last_coach_message_id: null, last_coach_context: null, bed_nudge_sent: 0, weekly_waiting_weight: 0 };
}

function setState(chatId, updates) {
  const cur = getState(chatId);
  stmts.upsertState.run(
    chatId,
    updates.status ?? cur.status,
    'current_day_start' in updates ? updates.current_day_start : cur.current_day_start,
    'bed_time'          in updates ? updates.bed_time          : cur.bed_time,
    updates.caffeine_today_mg      ?? cur.caffeine_today_mg ?? 0,
    'last_caffeine_time'       in updates ? updates.last_caffeine_time       : cur.last_caffeine_time,
    'last_coach_message_id'    in updates ? updates.last_coach_message_id    : cur.last_coach_message_id,
    'last_coach_context'       in updates ? updates.last_coach_context       : cur.last_coach_context,
    'bed_nudge_sent'           in updates ? updates.bed_nudge_sent           : (cur.bed_nudge_sent ?? 0),
    'weekly_waiting_weight'    in updates ? updates.weekly_waiting_weight    : (cur.weekly_waiting_weight ?? 0),
  );
}

function addCaffeine(chatId, mg) {
  const state = getState(chatId);
  setState(chatId, { caffeine_today_mg: (state.caffeine_today_mg ?? 0) + mg, last_caffeine_time: new Date().toISOString() });
}

function resetCaffeine(chatId) {
  setState(chatId, { caffeine_today_mg: 0, last_caffeine_time: null });
}

const getAllChatIds = () => stmts.allChats.all().map(r => r.chat_id);

// ── Plans ─────────────────────────────────────────────────────────────────────

function savePlan(chatId, { text, date, time, recurring = 'one-time', guests, location }) {
  return stmts.savePlan.run(chatId, text, date || null, time || null, recurring, guests ? JSON.stringify(guests) : null, location || null).lastInsertRowid;
}

const getPlansByDate    = (chatId, date) => stmts.getPlansByDate.all(chatId, date);
const getPendingUntimed = (chatId)       => stmts.getPendingUntimed.all(chatId);
const getPendingTimed   = (chatId, date) => stmts.getPendingTimed.all(chatId, date);
const updatePlanStatus  = (id, status)   => stmts.updatePlanStatus.run(status, id);
const markPlanReminded  = (id)           => stmts.markPlanReminded.run(id);
const setPlanNotionId   = (id, pageId)   => stmts.setPlanNotionId.run(pageId, id);
const setPlanCalendar   = (id)           => stmts.setPlanCalendar.run(id);
const getLastPending    = (chatId)       => stmts.getLastPending.get(chatId);
const getAllPending      = (chatId)       => stmts.getAllPending.all(chatId);

// ── Coach reply chain ─────────────────────────────────────────────────────────

const saveCoachMessage = (chatId, role, content, coachMsgId) => stmts.saveReply.run(chatId, role, content, coachMsgId ?? null);
const getReplyChain    = (chatId, coachMsgId) => stmts.getChain.all(chatId, coachMsgId);
const countExchanges   = (chatId, coachMsgId) => stmts.countExchanges.get(chatId, coachMsgId).c;
const clearReplyChain  = (chatId, coachMsgId) => stmts.clearChain.run(chatId, coachMsgId);

// ── Message log ───────────────────────────────────────────────────────────────

const logMessage       = (chatId, text, type, tgId) => stmts.logMessage.run(chatId, text, type, tgId ?? null);
const getRecentMessages = (chatId, limit = 5)        => stmts.getRecentMessages.all(chatId, limit);
function wasRecentlyActive(chatId, withinMinutes = 15) {
  const row = db.prepare("SELECT timestamp FROM message_log WHERE chat_id=? ORDER BY id DESC LIMIT 1").get(chatId);
  if (!row) return false;
  const lastMs = new Date(row.timestamp + 'Z').getTime();
  return (Date.now() - lastMs) < withinMinutes * 60 * 1000;
}

// ── Golf messages ─────────────────────────────────────────────────────────────

const saveGolfMessage    = (chatId, role, content) => stmts.saveGolfMsg.run(chatId, role, content);
const getGolfHistory     = (chatId, limit = 10)    => stmts.getGolfHistory.all(chatId, limit).reverse();
const getGolfMessageCount = (chatId)               => stmts.countGolfMessages.get(chatId).c;
const deleteOldGolfMessages = (chatId, n)          => stmts.deleteOldGolfMessages.run(chatId, chatId, n);
const clearGolfHistory   = (chatId)                => stmts.clearGolfHistory.run(chatId);

function replaceGolfHistory(chatId, messages) {
  clearGolfHistory(chatId);
  for (const m of messages) stmts.saveGolfMsg.run(chatId, m.role, m.content);
}

module.exports = {
  getState, setState, addCaffeine, resetCaffeine, getAllChatIds,
  savePlan, getPlansByDate, getPendingUntimed, getPendingTimed,
  updatePlanStatus, markPlanReminded, setPlanNotionId, setPlanCalendar,
  getLastPending, getAllPending,
  saveCoachMessage, getReplyChain, countExchanges, clearReplyChain,
  logMessage, getRecentMessages, wasRecentlyActive,
  saveGolfMessage, getGolfHistory, getGolfMessageCount,
  deleteOldGolfMessages, clearGolfHistory, replaceGolfHistory,
};
