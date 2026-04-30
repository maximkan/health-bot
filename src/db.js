const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    fire_ms INTEGER,
    text TEXT,
    fired INTEGER DEFAULT 0
  );
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

// user_state columns
addCol('user_state', 'caffeine_today_mg', 'INTEGER DEFAULT 0');
addCol('user_state', 'last_caffeine_time', 'TEXT');
addCol('user_state', 'last_coach_message_id', 'INTEGER');
addCol('user_state', 'last_coach_context', 'TEXT');
addCol('user_state', 'bed_nudge_sent', 'INTEGER DEFAULT 0');
addCol('user_state', 'weekly_waiting_weight', 'INTEGER DEFAULT 0');
addCol('user_state', 'bed_plans_tomorrow', 'TEXT');
// Multi-user columns
addCol('user_state', 'name', 'TEXT');
addCol('user_state', 'language', 'TEXT DEFAULT "en"');
addCol('user_state', 'onboarded', 'INTEGER DEFAULT 0');
addCol('user_state', 'onboard_step', 'INTEGER DEFAULT 0');
addCol('user_state', 'coaching_style', 'INTEGER DEFAULT 2');
addCol('user_state', 'notion_enabled', 'INTEGER DEFAULT 0');
addCol('user_state', 'gcal_refresh_token', 'TEXT');
addCol('user_state', 'goal', 'TEXT');
addCol('user_state', 'goal_weight_target', 'REAL');
addCol('user_state', 'body_fat_pct', 'REAL');
addCol('user_state', 'activity_level', 'INTEGER DEFAULT 2');
addCol('user_state', 'gym_days', 'INTEGER DEFAULT 3');
addCol('user_state', 'bed_time_pref', 'TEXT');
addCol('user_state', 'wake_time_pref', 'TEXT');
addCol('user_state', 'timezone', 'TEXT DEFAULT "Asia/Kuala_Lumpur"');
addCol('user_state', 'gender', 'TEXT DEFAULT "male"');
addCol('user_state', 'last_proactive_date', 'TEXT');
addCol('user_state', 'last_proactive_msg', 'TEXT');;

addCol('plans', 'gcal_event_id', 'TEXT');

// ── Plans table ───────────────────────────────────────────────────────────────

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

// ── Targets table — per-user migration ───────────────────────────────────────

const hasTargetsChatId = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('targets') WHERE name='chat_id'").get().c > 0;
if (!hasTargetsChatId) {
  const primaryChatId = db.prepare('SELECT chat_id FROM user_state LIMIT 1').get()?.chat_id;
  db.exec(`CREATE TABLE targets_v2 (
    chat_id INTEGER PRIMARY KEY,
    calories INTEGER DEFAULT 1600,
    protein REAL DEFAULT 220,
    carbs REAL DEFAULT 80,
    fat REAL DEFAULT 53,
    weight_kg REAL DEFAULT 105,
    goal_weight REAL DEFAULT 80,
    height_cm REAL DEFAULT 176,
    age INTEGER DEFAULT 26,
    birthday TEXT
  )`);
  if (primaryChatId) {
    const old = db.prepare("SELECT * FROM targets WHERE id=1").get();
    if (old) {
      db.prepare('INSERT OR IGNORE INTO targets_v2 (chat_id,calories,protein,carbs,fat,weight_kg,goal_weight,height_cm,age,birthday) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(primaryChatId, old.calories, old.protein, old.carbs, old.fat, old.weight_kg, old.goal_weight, old.height_cm ?? 176, old.age ?? 26, old.birthday ?? null);
    }
  }
  try { db.exec('DROP TABLE targets'); } catch {}
  db.exec('ALTER TABLE targets_v2 RENAME TO targets');
}

// ── Known foods table — per-user migration ────────────────────────────────────

const hasKnownFoodsChatId = db.prepare("SELECT COUNT(*) as c FROM pragma_table_info('known_foods') WHERE name='chat_id'").get().c > 0;
if (!hasKnownFoodsChatId) {
  const primaryChatId = db.prepare('SELECT chat_id FROM user_state LIMIT 1').get()?.chat_id;
  db.exec(`CREATE TABLE IF NOT EXISTS known_foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    serving TEXT,
    calories INTEGER DEFAULT 0,
    protein REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fat REAL DEFAULT 0,
    day_of_week TEXT,
    notes TEXT,
    source TEXT DEFAULT 'User Logged'
  )`);
  db.exec(`CREATE TABLE known_foods_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    serving TEXT,
    calories INTEGER DEFAULT 0,
    protein REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fat REAL DEFAULT 0,
    day_of_week TEXT,
    notes TEXT,
    source TEXT DEFAULT 'User Logged',
    UNIQUE(chat_id, name)
  )`);
  if (primaryChatId) {
    db.prepare(`INSERT OR IGNORE INTO known_foods_v2 (chat_id,name,serving,calories,protein,carbs,fat,day_of_week,notes,source)
      SELECT ?,name,serving,calories,protein,carbs,fat,day_of_week,notes,source FROM known_foods`).run(primaryChatId);
  }
  db.exec('DROP TABLE known_foods; ALTER TABLE known_foods_v2 RENAME TO known_foods');
} else {
  // Table exists with chat_id — ensure it was created correctly
  db.exec(`CREATE TABLE IF NOT EXISTS known_foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    serving TEXT,
    calories INTEGER DEFAULT 0,
    protein REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fat REAL DEFAULT 0,
    day_of_week TEXT,
    notes TEXT,
    source TEXT DEFAULT 'User Logged',
    UNIQUE(chat_id, name)
  )`);
}

// ── Mark existing users as onboarded + notion_enabled ─────────────────────────

db.exec(`UPDATE user_state SET onboarded=1, notion_enabled=1
  WHERE (onboarded IS NULL OR onboarded=0)
  AND chat_id IN (SELECT chat_id FROM targets)`);

// ── SQLite meal / workout / sleep log (for non-Notion users) ─────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS meal_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    meal_name TEXT,
    meal_type TEXT,
    calories REAL DEFAULT 0,
    protein REAL DEFAULT 0,
    carbs REAL DEFAULT 0,
    fat REAL DEFAULT 0,
    caffeine_mg REAL DEFAULT 0,
    items_json TEXT,
    logged_at INTEGER NOT NULL,
    day_start INTEGER,
    retro_date TEXT
  );
  CREATE TABLE IF NOT EXISTS workout_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    workout_name TEXT,
    activity_type TEXT,
    duration_min INTEGER,
    calories_burned REAL,
    exercises_json TEXT,
    logged_at INTEGER NOT NULL,
    day_start INTEGER,
    retro_date TEXT
  );
  CREATE TABLE IF NOT EXISTS sleep_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    bed_time INTEGER,
    wake_time INTEGER,
    hours_slept REAL,
    quality INTEGER,
    notes TEXT,
    logged_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS known_exercises (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    name TEXT NOT NULL,
    sets INTEGER,
    reps INTEGER,
    weight_kg REAL,
    notes TEXT,
    last_logged TEXT DEFAULT (datetime('now')),
    UNIQUE(chat_id, name)
  );
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    role TEXT,
    text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Dynamic user state ────────────────────────────────────────────────────────

const _insertIgnoreState = db.prepare('INSERT OR IGNORE INTO user_state (chat_id) VALUES (?)');

function getState(chatId) {
  _insertIgnoreState.run(chatId);
  return db.prepare('SELECT * FROM user_state WHERE chat_id=?').get(chatId);
}

function setState(chatId, updates) {
  _insertIgnoreState.run(chatId);
  const keys = Object.keys(updates);
  if (!keys.length) return;
  // Column names are from internal code only — not user input
  const sql = `UPDATE user_state SET ${keys.map(k => `${k}=?`).join(',')} WHERE chat_id=?`;
  db.prepare(sql).run(...keys.map(k => updates[k] ?? null), chatId);
}

function addCaffeine(chatId, mg) {
  const state = getState(chatId);
  setState(chatId, { caffeine_today_mg: (state.caffeine_today_mg ?? 0) + mg, last_caffeine_time: new Date().toISOString() });
}
function resetCaffeine(chatId) { setState(chatId, { caffeine_today_mg: 0, last_caffeine_time: null }); }

const getAllChatIds = () => db.prepare('SELECT chat_id FROM user_state').all().map(r => r.chat_id);

// ── Plans ─────────────────────────────────────────────────────────────────────

const _savePlan = db.prepare("INSERT INTO plans (chat_id,plan_text,plan_date,plan_time,status,recurring,guests,location,created_at) VALUES (?,?,?,?,'pending',?,?,?,datetime('now'))");

function savePlan(chatId, { text, date, time, recurring = 'one-time', guests, location }) {
  return _savePlan.run(chatId, text, date || null, time || null, recurring, guests ? JSON.stringify(guests) : null, location || null).lastInsertRowid;
}

const getPlansByDate    = (chatId, date) => db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_date=? AND status NOT IN ('done','skipped') ORDER BY plan_time ASC").all(chatId, date);
const getPendingUntimed = (chatId)       => db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_time IS NULL AND status='pending' ORDER BY created_at ASC").all(chatId);
const getPendingTimed   = (chatId, date) => db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_date=? AND plan_time IS NOT NULL AND status IN ('pending','reminded') ORDER BY plan_time ASC").all(chatId, date);
const updatePlanStatus  = (id, status)   => db.prepare("UPDATE plans SET status=? WHERE id=?").run(status, id);
const markPlanReminded  = (id)           => db.prepare("UPDATE plans SET status='reminded',last_reminded=datetime('now') WHERE id=?").run(id);
const setPlanNotionId   = (id, pageId)   => db.prepare("UPDATE plans SET notion_page_id=? WHERE id=?").run(pageId, id);
const setPlanCalendar   = (id)           => db.prepare("UPDATE plans SET calendar_event_created=1 WHERE id=?").run(id);
const setPlanGCalId     = (id, eventId)  => db.prepare('UPDATE plans SET gcal_event_id=? WHERE id=?').run(eventId, id);
const getPlanByNotionId  = (pageId)             => db.prepare("SELECT id FROM plans WHERE notion_page_id=? LIMIT 1").get(pageId);
const getPlanByTitleDate = (chatId, text, date) => db.prepare("SELECT id FROM plans WHERE chat_id=? AND plan_text=? AND plan_date=? LIMIT 1").get(chatId, text, date);
const getLastPending    = (chatId)       => db.prepare("SELECT * FROM plans WHERE chat_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1").get(chatId);
const getAllPending      = (chatId)       => db.prepare("SELECT * FROM plans WHERE chat_id=? AND status NOT IN ('done','skipped') ORDER BY plan_date,plan_time").all(chatId);

// ── Coach reply chain ─────────────────────────────────────────────────────────

const saveCoachMessage = (chatId, role, content, coachMsgId) =>
  db.prepare("INSERT INTO coach_reply_chain (chat_id,role,content,timestamp,coach_message_id) VALUES (?,?,?,datetime('now'),?)").run(chatId, role, content, coachMsgId ?? null);
const getReplyChain    = (chatId, coachMsgId) => db.prepare('SELECT * FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=? ORDER BY id ASC LIMIT 10').all(chatId, coachMsgId);
const countExchanges   = (chatId, coachMsgId) => db.prepare("SELECT COUNT(*) as c FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=? AND role='user'").get(chatId, coachMsgId).c;
const clearReplyChain  = (chatId, coachMsgId) => db.prepare('DELETE FROM coach_reply_chain WHERE chat_id=? AND coach_message_id=?').run(chatId, coachMsgId);

// ── Message log ───────────────────────────────────────────────────────────────

const logMessage        = (chatId, text, type, tgId) => db.prepare("INSERT INTO message_log (chat_id,message_text,message_type,timestamp,telegram_message_id) VALUES (?,?,?,datetime('now'),?)").run(chatId, text, type, tgId ?? null);
const getRecentMessages = (chatId, limit = 5) => db.prepare('SELECT * FROM message_log WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, limit);

function wasRecentlyActive(chatId, withinMinutes = 15) {
  const row = db.prepare("SELECT timestamp FROM message_log WHERE chat_id=? ORDER BY id DESC LIMIT 1").get(chatId);
  if (!row) return false;
  const lastMs = new Date(row.timestamp + 'Z').getTime();
  return (Date.now() - lastMs) < withinMinutes * 60 * 1000;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

const saveReminder      = (chatId, fireMs, text) => db.prepare("INSERT INTO reminders (chat_id, fire_ms, text) VALUES (?, ?, ?)").run(chatId, fireMs, text).lastInsertRowid;
const getPendingReminders  = () => db.prepare("SELECT * FROM reminders WHERE fired=0 AND fire_ms > ? ORDER BY fire_ms ASC").all(Date.now());
const markReminderFired    = (id) => db.prepare("UPDATE reminders SET fired=1 WHERE id=?").run(id);
const cleanOldReminders    = () => db.prepare("DELETE FROM reminders WHERE fire_ms < ?").run(Date.now() - 7 * 24 * 3600 * 1000);

// ── Known foods — per user ────────────────────────────────────────────────────

function upsertKnownFood(chatId, { name, serving = '1 serving', calories = 0, protein = 0, carbs = 0, fat = 0, day_of_week = null, notes = '', source = 'User Logged' }) {
  db.prepare(`INSERT INTO known_foods (chat_id,name,serving,calories,protein,carbs,fat,day_of_week,notes,source)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id,name) DO UPDATE SET serving=excluded.serving,calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,day_of_week=excluded.day_of_week,notes=excluded.notes,source=excluded.source`)
    .run(chatId, name, serving, Math.round(calories), protein, carbs, fat, day_of_week || null, notes || '', source);
}

function knownFoodExists(chatId, name) { return !!db.prepare('SELECT id FROM known_foods WHERE chat_id=? AND name=? LIMIT 1').get(chatId, name); }

function getKnownFoodsForDay(chatId, dayOfWeek, weekType) {
  const isEven = weekType === 'even';
  const isOdd  = weekType === 'odd';
  return db.prepare(`SELECT * FROM known_foods WHERE chat_id=? AND (day_of_week=? OR day_of_week IS NULL OR day_of_week='')
    AND NOT (? AND notes LIKE 'Lunch Odd Week%') AND NOT (? AND notes LIKE 'Lunch Even Week%')
    AND NOT (? AND notes LIKE 'Dinner Odd%') AND NOT (? AND notes LIKE 'Dinner Even%')`)
    .all(chatId, dayOfWeek, isEven ? 1 : 0, isOdd ? 1 : 0, isEven ? 1 : 0, isOdd ? 1 : 0);
}

function getAllKnownFoods(chatId) { return db.prepare('SELECT * FROM known_foods WHERE chat_id=?').all(chatId); }
function clearKnownFoods(chatId)  { db.prepare('DELETE FROM known_foods WHERE chat_id=?').run(chatId); }

// ── Targets — per user ────────────────────────────────────────────────────────

const TARGETS_DEFAULTS = { calories: 1600, protein: 220, carbs: 80, fat: 53, weight_kg: 105, goal_weight: 80, height_cm: 176, age: 26 };

function getTargetsFromDb(chatId) {
  if (!chatId) return TARGETS_DEFAULTS;
  return db.prepare('SELECT * FROM targets WHERE chat_id=?').get(chatId) ?? TARGETS_DEFAULTS;
}

function setTargetsInDb(chatId, t) {
  const cur = getTargetsFromDb(chatId);
  db.prepare(`INSERT INTO targets (chat_id,calories,protein,carbs,fat,weight_kg,goal_weight,height_cm,age,birthday)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,
    fat=excluded.fat,weight_kg=excluded.weight_kg,goal_weight=excluded.goal_weight,height_cm=excluded.height_cm,age=excluded.age,birthday=excluded.birthday`)
    .run(chatId, t.calories ?? cur.calories, t.protein ?? cur.protein, t.carbs ?? cur.carbs, t.fat ?? cur.fat,
      t.weight_kg ?? cur.weight_kg, t.goal_weight ?? cur.goal_weight,
      t.height_cm ?? cur.height_cm ?? 176, t.age ?? cur.age ?? 26, t.birthday ?? cur.birthday ?? null);
}

// ── Known exercises ───────────────────────────────────────────────────────────

function upsertKnownExercise(chatId, { name, sets, reps, weight_kg, notes }) {
  db.prepare(`INSERT INTO known_exercises (chat_id, name, sets, reps, weight_kg, notes)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, name) DO UPDATE SET sets=excluded.sets, reps=excluded.reps, weight_kg=excluded.weight_kg,
    notes=COALESCE(excluded.notes, notes), last_logged=datetime('now')`)
    .run(chatId, name, sets ?? null, reps ?? null, weight_kg ?? null, notes ?? null);
}

const getKnownExercises = (chatId) => db.prepare('SELECT * FROM known_exercises WHERE chat_id=? ORDER BY last_logged DESC LIMIT 40').all(chatId);

// ── SQLite meal log ───────────────────────────────────────────────────────────

function saveMealLog(chatId, data, dayStart) {
  return db.prepare(`INSERT INTO meal_log (chat_id,meal_name,meal_type,calories,protein,carbs,fat,caffeine_mg,items_json,logged_at,day_start,retro_date)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, data.meal_name, data.meal_type ?? 'Meal',
      data.totals?.calories ?? 0, data.totals?.protein ?? 0, data.totals?.carbs ?? 0, data.totals?.fat ?? 0,
      data.caffeine_mg ?? 0, JSON.stringify(data.items ?? []), Date.now(), dayStart ?? null, data.date ?? null
    ).lastInsertRowid;
}

function getDayDataFromSQLite(chatId, dayStart) {
  // dayStart to dayEnd (up to 24h later or next dayStart)
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const meals = db.prepare('SELECT * FROM meal_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  const workouts = db.prepare('SELECT * FROM workout_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  const totals = meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories ?? 0),
    protein:  acc.protein  + (m.protein  ?? 0),
    carbs:    acc.carbs    + (m.carbs    ?? 0),
    fat:      acc.fat      + (m.fat      ?? 0),
    caffeine: acc.caffeine + (m.caffeine_mg ?? 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, caffeine: 0 });
  return {
    totals: { calories: Math.round(totals.calories), protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat), caffeine: Math.round(totals.caffeine) },
    meals:    meals.map(m => ({ name: m.meal_name, type: m.meal_type, calories: Math.round(m.calories), protein: Math.round(m.protein), carbs: Math.round(m.carbs), fat: Math.round(m.fat) })),
    workouts: workouts.map(w => ({ name: w.workout_name, duration_min: w.duration_min, calories_burned: w.calories_burned })),
    recovery: [],
  };
}

function getDailyMealTotalsFromSQLite(chatId, dayStart) {
  const meals = db.prepare('SELECT * FROM meal_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  return meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories ?? 0),
    protein:  acc.protein  + (m.protein  ?? 0),
    carbs:    acc.carbs    + (m.carbs    ?? 0),
    fat:      acc.fat      + (m.fat      ?? 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

function saveWorkoutLog(chatId, data, dayStart) {
  return db.prepare(`INSERT INTO workout_log (chat_id,workout_name,activity_type,duration_min,calories_burned,exercises_json,logged_at,day_start,retro_date)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(chatId, data.workout_name, data.activity_type, data.duration_min, data.calories_burned,
      JSON.stringify(data.exercises ?? []), Date.now(), dayStart ?? null, data.date ?? null
    ).lastInsertRowid;
}

function getRecentWorkouts(chatId, days = 30) {
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  return db.prepare('SELECT * FROM workout_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at DESC LIMIT 20')
    .all(chatId, sinceMs)
    .map(w => ({ ...w, exercises: JSON.parse(w.exercises_json || '[]') }));
}

function saveSleepLog(chatId, { bed_time, wake_time, hours_slept, quality, notes }) {
  return db.prepare(`INSERT INTO sleep_log (chat_id,bed_time,wake_time,hours_slept,quality,notes,logged_at) VALUES (?,?,?,?,?,?,?)`)
    .run(chatId, bed_time ?? null, wake_time ?? null, hours_slept ?? null, quality ?? null, notes ?? '', Date.now()).lastInsertRowid;
}

// ── Chat history ──────────────────────────────────────────────────────────────

function saveHistory(chatId, role, text) {
  db.prepare('INSERT INTO chat_history (chat_id, role, text) VALUES (?, ?, ?)').run(chatId, role, String(text).slice(0, 500));
  db.prepare('DELETE FROM chat_history WHERE chat_id=? AND id NOT IN (SELECT id FROM chat_history WHERE chat_id=? ORDER BY id DESC LIMIT 20)').run(chatId, chatId);
}

const getHistory = (chatId, n = 10) => db.prepare('SELECT role, text FROM chat_history WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, n).reverse();

// ── Golf messages ─────────────────────────────────────────────────────────────

const saveGolfMessage      = (chatId, role, content) => db.prepare("INSERT INTO golf_messages (chat_id,role,content,timestamp) VALUES (?,?,?,datetime('now'))").run(chatId, role, content);
const getGolfHistory       = (chatId, limit = 10)    => db.prepare('SELECT * FROM golf_messages WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, limit).reverse();
const getGolfMessageCount  = (chatId)                => db.prepare('SELECT COUNT(*) as c FROM golf_messages WHERE chat_id=?').get(chatId).c;
const deleteOldGolfMessages = (chatId, n)            => db.prepare('DELETE FROM golf_messages WHERE chat_id=? AND id IN (SELECT id FROM golf_messages WHERE chat_id=? ORDER BY id ASC LIMIT ?)').run(chatId, chatId, n);
const clearGolfHistory     = (chatId)                => db.prepare('DELETE FROM golf_messages WHERE chat_id=?').run(chatId);

function replaceGolfHistory(chatId, messages) {
  clearGolfHistory(chatId);
  for (const m of messages) db.prepare("INSERT INTO golf_messages (chat_id,role,content,timestamp) VALUES (?,?,?,datetime('now'))").run(chatId, m.role, m.content);
}

module.exports = {
  getState, setState, addCaffeine, resetCaffeine, getAllChatIds,
  savePlan, getPlansByDate, getPendingUntimed, getPendingTimed,
  getPlanByNotionId, getPlanByTitleDate,
  updatePlanStatus, markPlanReminded, setPlanNotionId, setPlanCalendar, setPlanGCalId,
  getLastPending, getAllPending,
  saveCoachMessage, getReplyChain, countExchanges, clearReplyChain,
  logMessage, getRecentMessages, wasRecentlyActive,
  saveReminder, getPendingReminders, markReminderFired, cleanOldReminders,
  saveHistory, getHistory,
  saveGolfMessage, getGolfHistory, getGolfMessageCount,
  deleteOldGolfMessages, clearGolfHistory, replaceGolfHistory,
  upsertKnownFood, knownFoodExists, getKnownFoodsForDay, getAllKnownFoods, clearKnownFoods,
  upsertKnownExercise, getKnownExercises,
  getTargetsFromDb, setTargetsInDb,
  saveMealLog, getDayDataFromSQLite, getDailyMealTotalsFromSQLite,
  saveWorkoutLog, getRecentWorkouts, saveSleepLog,
};
