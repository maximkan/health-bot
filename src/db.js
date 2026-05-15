const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/bot.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS recovery_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    rounds INTEGER DEFAULT 1,
    duration_per_round_min INTEGER,
    total_duration_min INTEGER,
    temperature_c REAL,
    notes TEXT,
    logged_at INTEGER NOT NULL,
    day_start INTEGER
  );
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
addCol('user_state', 'gcal_refresh_token', 'TEXT');
addCol('user_state', 'goal', 'TEXT');
addCol('user_state', 'goal_weight_target', 'REAL');
addCol('user_state', 'body_fat_pct', 'REAL');
addCol('user_state', 'activity_level', 'INTEGER DEFAULT 2');
addCol('user_state', 'gym_days', 'INTEGER DEFAULT 3');
addCol('user_state', 'bed_time_pref', 'TEXT');
addCol('user_state', 'wake_time_pref', 'TEXT');
addCol('user_state', 'timezone', 'TEXT');
addCol('user_state', 'gender', 'TEXT DEFAULT "male"');
addCol('user_state', 'last_proactive_date', 'TEXT');
addCol('user_state', 'last_proactive_msg', 'TEXT');
addCol('user_state', 'user_profile', 'TEXT');
addCol('user_state', 'body_metrics', 'TEXT DEFAULT "weight"');
addCol('user_state', 'user_reminders', 'TEXT DEFAULT "[]"');
addCol('user_state', 'institution_keywords', 'TEXT DEFAULT NULL');
addCol('sleep_log', 'type', 'TEXT DEFAULT "Night"');
addCol('recovery_log', 'protocol', 'TEXT DEFAULT "single"');
addCol('recovery_log', 'protocol_id', 'TEXT');
addCol('recovery_log', 'sequence_order', 'INTEGER DEFAULT 1');
addCol('recovery_log', 'round_number', 'INTEGER');
addCol('meal_log', 'bot_message_id', 'INTEGER');
addCol('meal_log', 'meal_time', 'TEXT');
addCol('workout_log', 'bot_message_id', 'INTEGER');
addCol('workout_log', 'workout_time', 'TEXT');

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
    calories INTEGER,
    protein REAL,
    carbs REAL,
    fat REAL,
    weight_kg REAL,
    goal_weight REAL,
    height_cm REAL,
    age INTEGER,
    birthday TEXT
  )`);
  if (primaryChatId) {
    const old = db.prepare("SELECT * FROM targets WHERE id=1").get();
    if (old) {
      db.prepare('INSERT OR IGNORE INTO targets_v2 (chat_id,calories,protein,carbs,fat,weight_kg,goal_weight,height_cm,age,birthday) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(primaryChatId, old.calories, old.protein, old.carbs, old.fat, old.weight_kg, old.goal_weight, old.height_cm ?? null, old.age ?? null, old.birthday ?? null);
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

// ── Mark existing users as onboarded ─────────────────────────────────────────

db.exec(`UPDATE user_state SET onboarded=1
  WHERE (onboarded IS NULL OR onboarded=0)
  AND chat_id IN (SELECT chat_id FROM targets)`);

// ── SQLite meal / workout / sleep logs ───────────────────────────────────────

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
  CREATE TABLE IF NOT EXISTS body_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    weight_kg REAL,
    body_fat_pct REAL,
    muscle_mass_kg REAL,
    bmi REAL,
    notes TEXT,
    logged_at INTEGER NOT NULL
  );
`);

db.exec(`CREATE TABLE IF NOT EXISTS coach_conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  messages_json TEXT,
  summary TEXT,
  closed_at INTEGER NOT NULL
)`);

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

const getPendingUntimed = (chatId)       => db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_time IS NULL AND status='pending' ORDER BY created_at ASC").all(chatId);
const getPendingTimed   = (chatId, date) => db.prepare("SELECT * FROM plans WHERE chat_id=? AND plan_date=? AND plan_time IS NOT NULL AND status IN ('pending','reminded') ORDER BY plan_time ASC").all(chatId, date);
const updatePlanStatus  = (id, status)   => db.prepare("UPDATE plans SET status=? WHERE id=?").run(status, id);
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

function wasRecentlyActive(chatId, withinMinutes = 15) {
  const row = db.prepare("SELECT timestamp FROM message_log WHERE chat_id=? ORDER BY id DESC LIMIT 1").get(chatId);
  if (!row) return false;
  const lastMs = new Date(row.timestamp + 'Z').getTime();
  return (Date.now() - lastMs) < withinMinutes * 60 * 1000;
}

// ── Reminders ─────────────────────────────────────────────────────────────────

addCol('reminders', 'plan_id', 'INTEGER');

const saveReminder         = (chatId, fireMs, text, planId = null) => db.prepare("INSERT INTO reminders (chat_id, fire_ms, text, plan_id) VALUES (?, ?, ?, ?)").run(chatId, fireMs, text, planId).lastInsertRowid;
const getPendingReminders  = () => db.prepare("SELECT * FROM reminders WHERE fired=0 AND fire_ms > ? ORDER BY fire_ms ASC").all(Date.now());
const markReminderFired    = (id) => db.prepare("UPDATE reminders SET fired=1 WHERE id=?").run(id);
const cleanOldReminders    = () => db.prepare("DELETE FROM reminders WHERE fire_ms < ?").run(Date.now() - 7 * 24 * 3600 * 1000);
const getReminderByTime    = (chatId, fireMs) => db.prepare("SELECT id FROM reminders WHERE chat_id=? AND fire_ms=? AND fired=0 LIMIT 1").get(chatId, fireMs);
function cancelPlanReminders(chatId, planId) {
  const rows = db.prepare('SELECT id, fire_ms FROM reminders WHERE chat_id=? AND plan_id=? AND fired=0').all(chatId, planId);
  for (const r of rows) {
    db.prepare('UPDATE reminders SET fired=1 WHERE id=?').run(r.id);
    try { require('./cron').cancelOnce(chatId, r.fire_ms); } catch {}
  }
}
function deleteUnfiredReminders(chatId) {
  const rows = db.prepare('SELECT id, fire_ms FROM reminders WHERE chat_id=? AND fired=0').all(chatId);
  db.prepare('UPDATE reminders SET fired=1 WHERE chat_id=? AND fired=0').run(chatId);
  try { require('./cron').cancelAllForChat(chatId); } catch {}
  return rows;
}

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

function getTargetsFromDb(chatId) {
  if (!chatId) return null;
  return db.prepare('SELECT * FROM targets WHERE chat_id=?').get(chatId) ?? null;
}

function setTargetsInDb(chatId, t) {
  const cur = getTargetsFromDb(chatId);
  db.prepare(`INSERT INTO targets (chat_id,calories,protein,carbs,fat,weight_kg,goal_weight,height_cm,age,birthday)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,
    fat=excluded.fat,weight_kg=excluded.weight_kg,goal_weight=excluded.goal_weight,height_cm=excluded.height_cm,age=excluded.age,birthday=excluded.birthday`)
    .run(chatId, t.calories ?? cur?.calories ?? null, t.protein ?? cur?.protein ?? null, t.carbs ?? cur?.carbs ?? null, t.fat ?? cur?.fat ?? null,
      t.weight_kg ?? cur?.weight_kg ?? null, t.goal_weight ?? cur?.goal_weight ?? null,
      t.height_cm ?? cur?.height_cm ?? null, t.age ?? cur?.age ?? null, t.birthday ?? cur?.birthday ?? null);
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
  const id = db.prepare(`INSERT INTO meal_log (chat_id,meal_name,meal_type,calories,protein,carbs,fat,caffeine_mg,items_json,logged_at,day_start,retro_date,meal_time)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, data.meal_name, data.meal_type ?? 'Meal',
      data.totals?.calories ?? 0, data.totals?.protein ?? 0, data.totals?.carbs ?? 0, data.totals?.fat ?? 0,
      data.caffeine_mg ?? 0, JSON.stringify(data.items ?? []), Date.now(), dayStart ?? null, data.date ?? null,
      data.time ?? null
    ).lastInsertRowid;
  return id;
}

function getDayDataFromSQLite(chatId, dayStart) {
  // dayStart to dayEnd (up to 24h later or next dayStart)
  const dayEnd = dayStart + 24 * 3600 * 1000;
  const meals = db.prepare('SELECT * FROM meal_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  const workouts = db.prepare('SELECT * FROM workout_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  const recoveries = db.prepare('SELECT * FROM recovery_log WHERE chat_id=? AND day_start=?').all(chatId, dayStart);
  const totals = meals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories ?? 0),
    protein:  acc.protein  + (m.protein  ?? 0),
    carbs:    acc.carbs    + (m.carbs    ?? 0),
    fat:      acc.fat      + (m.fat      ?? 0),
    caffeine: acc.caffeine + (m.caffeine_mg ?? 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0, caffeine: 0 });
  // Last sleep entry that ended within this day window (wake_time falls in [dayStart, dayEnd])
  const lastSleep = db.prepare('SELECT * FROM sleep_log WHERE chat_id=? AND wake_time>=? AND wake_time<? ORDER BY wake_time DESC LIMIT 1').get(chatId, dayStart, dayEnd);
  return {
    totals: { calories: Math.round(totals.calories), protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat), caffeine: Math.round(totals.caffeine) },
    meals:    meals.map(m => ({ name: m.meal_name, type: m.meal_type, calories: Math.round(m.calories), protein: Math.round(m.protein), carbs: Math.round(m.carbs), fat: Math.round(m.fat) })),
    workouts: workouts.map(w => ({ name: w.workout_name, duration_min: w.duration_min, calories_burned: w.calories_burned })),
    sleep:    lastSleep ? { hours_slept: lastSleep.hours_slept, quality: lastSleep.quality, type: lastSleep.type ?? 'Night' } : null,
    recovery: recoveries.map(r => ({ type: r.type, rounds: r.rounds, duration_per_round_min: r.duration_per_round_min, total_duration_min: r.total_duration_min, temperature_c: r.temperature_c, protocol: r.protocol ?? 'single', protocol_id: r.protocol_id, sequence_order: r.sequence_order })),
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
  return db.prepare(`INSERT INTO workout_log (chat_id,workout_name,activity_type,duration_min,calories_burned,exercises_json,logged_at,day_start,retro_date,workout_time)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, data.workout_name, data.activity_type, data.duration_min, data.calories_burned,
      JSON.stringify(data.exercises ?? []), Date.now(), dayStart ?? null, data.date ?? null,
      data.time ?? null
    ).lastInsertRowid;
}

function getTodayEntriesFromSQLite(chatId, dayStart) {
  const meals    = db.prepare('SELECT id, meal_name, meal_type, calories FROM meal_log WHERE chat_id=? AND day_start=? ORDER BY logged_at ASC').all(chatId, dayStart);
  const workouts = db.prepare('SELECT id, workout_name, duration_min FROM workout_log WHERE chat_id=? AND day_start=? ORDER BY logged_at ASC').all(chatId, dayStart);
  const entries = [
    ...meals.map(m    => ({ id: m.id,    table: 'meal_log',    label: 'Meal',    title: m.meal_name,    extra: `${Math.round(m.calories)} kcal` })),
    ...workouts.map(w => ({ id: w.id,    table: 'workout_log', label: 'Workout', title: w.workout_name, extra: w.duration_min ? `${w.duration_min} min` : '' })),
  ];
  return entries;
}

function deleteTodayEntry(entry) {
  db.prepare(`DELETE FROM ${entry.table} WHERE id=?`).run(entry.id);
}

function getWeekDataFromSQLite(chatId, sinceMs) {
  const { getOffsetMs } = require('./utils/time');
  const tz = db.prepare('SELECT timezone FROM user_state WHERE chat_id=?').get(chatId)?.timezone;
  if (!tz) throw new Error(`timezone missing for chat ${chatId} — complete onboarding to fix.`);
  const OFFSET = getOffsetMs(tz);
  const meals      = db.prepare('SELECT * FROM meal_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at ASC').all(chatId, sinceMs);
  const workouts   = db.prepare('SELECT * FROM workout_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at ASC').all(chatId, sinceMs);
  const sleeps     = db.prepare('SELECT hours_slept, quality, type, wake_time, logged_at FROM sleep_log WHERE chat_id=? AND logged_at>?').all(chatId, sinceMs);
  const recoveries = db.prepare('SELECT type, rounds, duration_per_round_min, total_duration_min, temperature_c, protocol, protocol_id, sequence_order, round_number, logged_at FROM recovery_log WHERE chat_id=? AND logged_at>?').all(chatId, sinceMs);

  const dailyTotals = {};
  for (const m of meals) {
    const key = new Date((m.day_start || m.logged_at) + OFFSET).toISOString().split('T')[0];
    if (!dailyTotals[key]) dailyTotals[key] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[key].calories += m.calories ?? 0;
    dailyTotals[key].protein  += m.protein  ?? 0;
    dailyTotals[key].carbs    += m.carbs    ?? 0;
    dailyTotals[key].fat      += m.fat      ?? 0;
  }
  for (const k of Object.keys(dailyTotals)) {
    const d = dailyTotals[k];
    dailyTotals[k] = { calories: Math.round(d.calories), protein: Math.round(d.protein), carbs: Math.round(d.carbs), fat: Math.round(d.fat) };
  }

  for (const w of workouts) {
    const key = new Date((w.day_start || w.logged_at) + OFFSET).toISOString().split('T')[0];
    if (!dailyTotals[key]) dailyTotals[key] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[key].trained = true;
  }
  for (const s of sleeps) {
    if ((s.type ?? 'Night') !== 'Night') continue;
    const wakeMs = s.wake_time || s.logged_at;
    if (!wakeMs) continue;
    const key = new Date(wakeMs + OFFSET).toISOString().split('T')[0];
    if (!dailyTotals[key]) dailyTotals[key] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[key].sleep_h = s.hours_slept;
    dailyTotals[key].sleep_q = s.quality;
  }
  for (const r of recoveries) {
    const key = new Date(r.logged_at + OFFSET).toISOString().split('T')[0];
    if (!dailyTotals[key]) dailyTotals[key] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[key].recovery = true;
  }

  const trainDaySet = new Set(workouts.map(w => new Date((w.day_start || w.logged_at) + OFFSET).toISOString().split('T')[0]));
  const nightSleeps = sleeps.filter(s => (s.type ?? 'Night') === 'Night');
  const avgSleep = nightSleeps.length ? Math.round(nightSleeps.reduce((s, r) => s + (r.hours_slept || 0), 0) / nightSleeps.length * 10) / 10 : null;
  const avgSleepQuality = nightSleeps.length ? Math.round(nightSleeps.reduce((s, r) => s + (r.quality || 3), 0) / nightSleeps.length * 10) / 10 : null;
  const recoverySessions = recoveries.map(r => ({ date: new Date(r.logged_at + OFFSET).toISOString().split('T')[0], type: r.type, rounds: r.rounds, duration_per_round_min: r.duration_per_round_min, total_duration_min: r.total_duration_min, temperature_c: r.temperature_c, protocol: r.protocol, protocol_id: r.protocol_id, sequence_order: r.sequence_order, round_number: r.round_number }));

  const bodyLogs = db.prepare('SELECT weight_kg, body_fat_pct, muscle_mass_kg, logged_at FROM body_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at ASC').all(chatId, sinceMs);
  const latestBody = bodyLogs.length ? bodyLogs[bodyLogs.length - 1] : null;

  return { dailyTotals, trainDays: trainDaySet.size, workouts, avgSleep, avgSleepQuality, recoverySessions, bodyLogs, latestBody };
}

function getRecentWorkouts(chatId, days = 30) {
  const sinceMs = Date.now() - days * 24 * 3600 * 1000;
  return db.prepare('SELECT * FROM workout_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at DESC')
    .all(chatId, sinceMs)
    .map(w => ({ ...w, exercises: JSON.parse(w.exercises_json || '[]') }));
}

function saveRecoveryLog(chatId, data, dayStart) {
  return db.prepare(`INSERT INTO recovery_log (chat_id,type,rounds,duration_per_round_min,total_duration_min,temperature_c,notes,protocol,protocol_id,sequence_order,round_number,logged_at,day_start)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(chatId, data.type, data.rounds ?? 1, data.duration_per_round_min ?? null, data.total_duration_min ?? null, data.temperature_c ?? null, data.notes ?? '', data.protocol ?? 'single', data.protocol_id ?? null, data.sequence_order ?? 1, data.round_number ?? null, Date.now(), dayStart ?? null).lastInsertRowid;
}

function saveSleepLog(chatId, { bed_time, wake_time, hours_slept, quality, notes, type }) {
  return db.prepare(`INSERT INTO sleep_log (chat_id,bed_time,wake_time,hours_slept,quality,notes,type,logged_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(chatId, bed_time ?? null, wake_time ?? null, hours_slept ?? null, quality ?? null, notes ?? '', type ?? 'Night', Date.now()).lastInsertRowid;
}

function getLastSleepLog(chatId) {
  return db.prepare('SELECT bed_time, wake_time, hours_slept, quality FROM sleep_log WHERE chat_id=? ORDER BY id DESC LIMIT 1').get(chatId) || null;
}

// ── Chat history ──────────────────────────────────────────────────────────────

function saveHistory(chatId, role, text) {
  db.prepare('INSERT INTO chat_history (chat_id, role, text) VALUES (?, ?, ?)').run(chatId, role, String(text).slice(0, 500));
  db.prepare('DELETE FROM chat_history WHERE chat_id=? AND id NOT IN (SELECT id FROM chat_history WHERE chat_id=? ORDER BY id DESC LIMIT 20)').run(chatId, chatId);
}

const getHistory = (chatId, n = 10) => db.prepare('SELECT role, text FROM chat_history WHERE chat_id=? ORDER BY id DESC LIMIT ?').all(chatId, n).reverse();


function getRecentLogs(chatId, days = 7) {
  const since = Date.now() - days * 86400000;
  const meals    = db.prepare("SELECT id, meal_name as name, 'meal' as type, logged_at FROM meal_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at DESC").all(chatId, since);
  const workouts = db.prepare("SELECT id, workout_name as name, 'workout' as type, logged_at FROM workout_log WHERE chat_id=? AND logged_at>? ORDER BY logged_at DESC").all(chatId, since);
  return [...meals, ...workouts].sort((a, b) => b.logged_at - a.logged_at);
}

function getLogById(chatId, type, id) {
  const col = type === 'meal' ? 'meal_name' : 'workout_name';
  return db.prepare(`SELECT id, ${col} as name, ? as type FROM ${type}_log WHERE chat_id=? AND id=?`).get(type, chatId, id) || null;
}

function getLastLogEntry(chatId, dayStart) {
  const meal    = db.prepare('SELECT id, meal_name as name, "meal" as type, logged_at FROM meal_log WHERE chat_id=? AND day_start=? ORDER BY logged_at DESC LIMIT 1').get(chatId, dayStart);
  const workout = db.prepare('SELECT id, workout_name as name, "workout" as type, logged_at FROM workout_log WHERE chat_id=? AND day_start=? ORDER BY logged_at DESC LIMIT 1').get(chatId, dayStart);
  if (!meal && !workout) return null;
  if (!meal) return workout;
  if (!workout) return meal;
  return meal.logged_at >= workout.logged_at ? meal : workout;
}

function getLogByName(chatId, name) {
  // Strip emoji and non-alphanumeric prefix/noise for matching
  const clean = (s) => s.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27FF}]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const lc = clean(name);
  const meal = db.prepare("SELECT id, meal_name as name, 'meal' as type FROM meal_log WHERE chat_id=? AND lower(meal_name)=? ORDER BY logged_at DESC LIMIT 1").get(chatId, lc);
  if (meal) return meal;
  const workout = db.prepare("SELECT id, workout_name as name, 'workout' as type FROM workout_log WHERE chat_id=? AND lower(workout_name)=? ORDER BY logged_at DESC LIMIT 1").get(chatId, lc);
  if (workout) return workout;
  const mealFuzzy = db.prepare("SELECT id, meal_name as name, 'meal' as type FROM meal_log WHERE chat_id=? AND lower(meal_name) LIKE ? ORDER BY logged_at DESC LIMIT 1").get(chatId, `%${lc}%`);
  if (mealFuzzy) return mealFuzzy;
  const workFuzzy = db.prepare("SELECT id, workout_name as name, 'workout' as type FROM workout_log WHERE chat_id=? AND lower(workout_name) LIKE ? ORDER BY logged_at DESC LIMIT 1").get(chatId, `%${lc}%`);
  return workFuzzy || null;
}

function setLogBotMessageId(table, rowId, botMsgId) {
  db.prepare(`UPDATE ${table} SET bot_message_id=? WHERE id=?`).run(botMsgId, rowId);
}

function getLogByBotMessageId(chatId, botMsgId) {
  const meal = db.prepare('SELECT id, meal_name as name, "meal" as type FROM meal_log WHERE chat_id=? AND bot_message_id=?').get(chatId, botMsgId);
  if (meal) return meal;
  const workout = db.prepare('SELECT id, workout_name as name, "workout" as type FROM workout_log WHERE chat_id=? AND bot_message_id=?').get(chatId, botMsgId);
  return workout || null;
}

function renameLog(type, rowId, newName) {
  const col = type === 'meal' ? 'meal_name' : 'workout_name';
  db.prepare(`UPDATE ${type}_log SET ${col}=? WHERE id=?`).run(newName, rowId);
}

function updateLogTime(type, rowId, timeStr) {
  const col = type === 'meal' ? 'meal_time' : 'workout_time';
  db.prepare(`UPDATE ${type}_log SET ${col}=? WHERE id=?`).run(timeStr, rowId);
}

function getEntriesForDay(chatId, type, dayStart) {
  if (type === 'meal') {
    return db.prepare('SELECT id, meal_name as title FROM meal_log WHERE chat_id=? AND day_start=? ORDER BY logged_at ASC').all(chatId, dayStart);
  }
  if (type === 'workout') {
    return db.prepare('SELECT id, workout_name as title FROM workout_log WHERE chat_id=? AND day_start=? ORDER BY logged_at ASC').all(chatId, dayStart);
  }
  if (type === 'sleep') {
    return db.prepare('SELECT id, hours_slept as title FROM sleep_log WHERE chat_id=? AND logged_at > ? ORDER BY logged_at ASC').all(chatId, dayStart);
  }
  return [];
}

// ── Body measurements ─────────────────────────────────────────────────────────

function saveBodyLog(chatId, data) {
  const bmi = data.weight_kg && data.height_cm
    ? +(data.weight_kg / ((data.height_cm / 100) ** 2)).toFixed(1)
    : data.bmi ?? null;
  return db.prepare(`INSERT INTO body_log (chat_id,weight_kg,body_fat_pct,muscle_mass_kg,bmi,notes,logged_at) VALUES (?,?,?,?,?,?,?)`)
    .run(chatId, data.weight_kg ?? null, data.body_fat_pct ?? null, data.muscle_mass_kg ?? null, bmi, data.notes ?? null, Date.now()).lastInsertRowid;
}

function getLastBodyMeasurement(chatId) {
  return db.prepare('SELECT * FROM body_log WHERE chat_id=? ORDER BY logged_at DESC LIMIT 1').get(chatId) ?? null;
}

function getAllBodyMeasurements(chatId) {
  return db.prepare('SELECT * FROM body_log WHERE chat_id=? ORDER BY logged_at ASC').all(chatId)
    .map(r => ({ date: new Date(r.logged_at).toISOString().split('T')[0], weight_kg: r.weight_kg, body_fat_pct: r.body_fat_pct, bmi: r.bmi }));
}

// ── Historical data (replaces Notion getHistoricalData) ───────────────────────

function getHistoricalDataFromSQLite(chatId) {
  const meals      = db.prepare('SELECT * FROM meal_log WHERE chat_id=? ORDER BY logged_at ASC').all(chatId);
  const workouts   = db.prepare('SELECT * FROM workout_log WHERE chat_id=? ORDER BY logged_at ASC').all(chatId);
  const sleeps     = db.prepare('SELECT * FROM sleep_log WHERE chat_id=? ORDER BY logged_at ASC').all(chatId);
  const recoveries = db.prepare('SELECT * FROM recovery_log WHERE chat_id=? ORDER BY logged_at ASC').all(chatId);

  const { getOffsetMs } = require('./utils/time');
  const tz = db.prepare('SELECT timezone FROM user_state WHERE chat_id=?').get(chatId)?.timezone;
  if (!tz) throw new Error(`timezone missing for chat ${chatId} — complete onboarding to fix.`);
  const OFFSET = getOffsetMs(tz);
  const dailyTotals = {};
  for (const m of meals) {
    const key = new Date((m.day_start || m.logged_at) + OFFSET).toISOString().split('T')[0];
    if (!dailyTotals[key]) dailyTotals[key] = { calories: 0, protein: 0, carbs: 0, fat: 0, meals: [] };
    dailyTotals[key].calories += m.calories ?? 0;
    dailyTotals[key].protein  += m.protein  ?? 0;
    dailyTotals[key].carbs    += m.carbs    ?? 0;
    dailyTotals[key].fat      += m.fat      ?? 0;
    if (m.meal_name) dailyTotals[key].meals.push(m.meal_name);
  }
  for (const d of Object.values(dailyTotals)) {
    d.calories = Math.round(d.calories); d.protein = Math.round(d.protein); d.carbs = Math.round(d.carbs); d.fat = Math.round(d.fat);
  }

  return {
    dailyTotals,
    workouts:  workouts.map(w => ({ date: new Date((w.day_start || w.logged_at) + OFFSET).toISOString().split('T')[0], name: w.workout_name, duration: w.duration_min })),
    sleep:     sleeps.map(s => ({ date: new Date(s.logged_at + OFFSET).toISOString().split('T')[0], hours: s.hours_slept, quality: s.quality, type: s.type ?? 'Night' })),
    recovery:  recoveries.map(r => ({ date: new Date(r.logged_at + OFFSET).toISOString().split('T')[0], type: r.type, rounds: r.rounds, total_duration_min: r.total_duration_min, temperature_c: r.temperature_c })),
  };
}

// ── Coach conversations + user profile ────────────────────────────────────────

function saveCoachConversation(chatId, messages, summary) {
  return db.prepare('INSERT INTO coach_conversations (chat_id, messages_json, summary, closed_at) VALUES (?, ?, ?, ?)')
    .run(chatId, JSON.stringify(messages), summary, Date.now()).lastInsertRowid;
}

function getRecentConversationSummaries(chatId, limit = 5) {
  return db.prepare('SELECT summary, closed_at FROM coach_conversations WHERE chat_id=? ORDER BY closed_at DESC LIMIT ?')
    .all(chatId, limit);
}

function getUserProfile(chatId) {
  return db.prepare('SELECT user_profile FROM user_state WHERE chat_id=?').get(chatId)?.user_profile || '';
}

function setUserProfile(chatId, profile) {
  setState(chatId, { user_profile: profile });
}

// ── Targets helpers (migrated from notion.js) ─────────────────────────────────

function getTargets(chatId) {
  return getTargetsFromDb(chatId);
}

function getTargetsText(chatId) {
  const t = getTargets(chatId);
  return `Current weight: ~${t.weight_kg}kg, goal: ${t.goal_weight}kg\nDaily targets: ${t.calories} kcal / ${t.protein}g protein / ${t.carbs}g carbs / ${t.fat}g fat`;
}

function updateTargets(chatId, updates) {
  setTargetsInDb(chatId, updates);
}

// ── Day data wrappers (migrated from notion.js) ───────────────────────────────

function getDayData(chatId, dayStartMs) {
  return getDayDataFromSQLite(chatId, dayStartMs);
}

function getDailyMealTotals(chatId, dayStartMs) {
  return getDailyMealTotalsFromSQLite(chatId, dayStartMs);
}

function getDrinkEntries(chatId, dayStartMs) {
  return getDayDataFromSQLite(chatId, dayStartMs).meals
    .filter(m => m.type === 'Drink')
    .map(m => ({ meal_name: m.name, caffeine_mg: 0 }));
}

// ── Known foods helpers (migrated from notion.js) ────────────────────────────

function shouldSkipKnownFood(name) {
  if (!name) return true;
  if (name.includes('[Dinner') || name.includes('[Lunch') || name.includes('[NS Cafe]')) return true;
  if (name.toLowerCase().includes('daily summary') || name.toLowerCase().includes('day summary')) return true;
  if (/–\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d/i.test(name)) return true;
  return false;
}

function getKnownFoodsContext(chatId, dayOfWeek, weekType) {
  const foods = getKnownFoodsForDay(chatId, dayOfWeek, weekType);
  const fmt = f => `  ${f.name} (${f.serving}): ${f.calories} kcal, ${f.protein}g P, ${f.carbs}g C, ${f.fat}g F`;
  const dinner = foods.filter(f => f.notes?.startsWith('Dinner') || f.name?.includes('[Dinner'));
  const lunch  = foods.filter(f => !f.notes?.startsWith('Dinner') && !f.name?.includes('[Dinner') && (f.notes?.startsWith('Lunch') || f.name?.includes('Week]')));
  const other  = foods.filter(f => !dinner.includes(f) && !lunch.includes(f));
  const sections = [];
  if (lunch.length)  sections.push(`LUNCH MENU TODAY:\n${lunch.map(fmt).join('\n')}`);
  if (dinner.length) sections.push(`DINNER MENU TODAY (macros per 100g):\n${dinner.map(fmt).join('\n')}`);
  if (other.length)  sections.push(`OTHER FOODS:\n${other.map(fmt).join('\n')}`);
  return sections.join('\n\n');
}

function addKnownFood(chatId, data) {
  const items = data.items;
  if (items && items.length > 1) {
    for (const item of items) {
      if (shouldSkipKnownFood(item.name)) continue;
      if (knownFoodExists(chatId, item.name)) continue;
      upsertKnownFood(chatId, {
        name:    item.name,
        serving: item.weight_g ? `${item.weight_g}g` : '1 serving',
        calories: item.calories ?? 0,
        protein:  item.protein  ?? 0,
        carbs:    item.carbs    ?? 0,
        fat:      item.fat      ?? 0,
        notes:  'Auto-saved',
        source: 'User Logged',
      });
    }
    return;
  }
  const name = data.meal_name;
  if (shouldSkipKnownFood(name)) return;
  if (knownFoodExists(chatId, name)) return;
  upsertKnownFood(chatId, {
    name,
    serving:  '1 serving',
    calories: data.totals?.calories ?? 0,
    protein:  data.totals?.protein  ?? 0,
    carbs:    data.totals?.carbs    ?? 0,
    fat:      data.totals?.fat      ?? 0,
    notes:  'Auto-saved',
    source: 'User Logged',
  });
}

module.exports = {
  getState, setState, addCaffeine, resetCaffeine, getAllChatIds,
  savePlan, getPendingUntimed, getPendingTimed,
  getPlanByNotionId, getPlanByTitleDate,
  updatePlanStatus, setPlanNotionId, setPlanCalendar, setPlanGCalId,
  getLastPending, getAllPending,
  saveCoachMessage, getReplyChain, countExchanges, clearReplyChain,
  logMessage, wasRecentlyActive,
  saveReminder, getPendingReminders, markReminderFired, cleanOldReminders, getReminderByTime, cancelPlanReminders, deleteUnfiredReminders,
  saveHistory, getHistory,
upsertKnownFood, knownFoodExists, getKnownFoodsForDay, getAllKnownFoods, clearKnownFoods,
  upsertKnownExercise, getKnownExercises,
  getTargetsFromDb, setTargetsInDb,
  saveMealLog, getDayDataFromSQLite, getDailyMealTotalsFromSQLite,
  saveWorkoutLog, getRecentWorkouts, saveRecoveryLog, saveSleepLog, getLastSleepLog,
  getTodayEntriesFromSQLite, deleteTodayEntry, getWeekDataFromSQLite,
  setLogBotMessageId, getLogByBotMessageId, renameLog, getLastLogEntry, getRecentLogs,
  saveBodyLog, getLastBodyMeasurement, getAllBodyMeasurements, getHistoricalDataFromSQLite,
  updateLogTime, getEntriesForDay,
  saveCoachConversation, getRecentConversationSummaries, getUserProfile, setUserProfile,
  getTargets, getTargetsText, updateTargets,
  getDayData, getDailyMealTotals, getDrinkEntries,
  getKnownFoodsContext, shouldSkipKnownFood, addKnownFood,
};
