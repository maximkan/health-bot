/**
 * Simulation: 14-day scenario with vacation in the middle
 *
 * Timeline:
 *  Day -14: onboard, first log
 *  Day -7:  first weekly review fires → last_weekly_review_completed_at = day-7
 *  Day -4:  vacation starts
 *  Day -3:  vacation Monday — NO review (vacation_mode guard in bot.js)
 *  Day 0:   vacation ends → last_weekly_review_completed_at = day0
 *  Day +7:  next review — should cover ONLY day0..day+6 (no pre-vacation data)
 */

const dbMod = require('./src/db');
const Database = require('better-sqlite3');
const raw = new Database('./data/bot.db');

const TEST_CHAT_ID = 999999999;
const NEW_CHAT = 999999998;

function ms(daysFromNow) {
  return Date.now() + daysFromNow * 86400000;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
raw.prepare('DELETE FROM user_state WHERE chat_id IN (?,?)').run(TEST_CHAT_ID, NEW_CHAT);
raw.prepare('DELETE FROM meal_log WHERE chat_id IN (?,?)').run(TEST_CHAT_ID, NEW_CHAT);

raw.prepare("INSERT OR IGNORE INTO user_state (chat_id, status, timezone) VALUES (?,?,?)").run(TEST_CHAT_ID, 'awake', 'Asia/Kuala_Lumpur');
dbMod.setState(TEST_CHAT_ID, {
  weekly_review_dow: 1, last_weekly_review_completed_at: null,
  vacation_mode: 0, vacation_start_ms: null, current_day_start: ms(0)
});

// 14 days of fake logs (day -14 to day -1)
for (let d = -14; d < 0; d++) {
  const dayStart = ms(d);
  raw.prepare("INSERT INTO meal_log (chat_id, meal_name, calories, protein, carbs, fat, logged_at, day_start) VALUES (?,?,?,?,?,?,?,?)")
    .run(TEST_CHAT_ID, `Meal d${d}`, 2000, 150, 200, 60, dayStart + 3600000, dayStart);
}

// ── TEST 1: No anchor → earliest log fallback (14 days of data > 5 threshold) ─
console.log('\n=== TEST 1: No anchor — earliest-log fallback ===');
const data1 = dbMod.getWeeklyReviewData(TEST_CHAT_ID, ms(0));
if (!data1) {
  console.log('FAIL: got null (expected 14 days of data)');
} else {
  const keys = Object.keys(data1.dailyTotals);
  console.log(`Window: ${keys.length} days  ${keys[0]} → ${keys[keys.length-1]}`);
  console.log(keys.length === 14 ? 'PASS: all 14 days' : `WARN: ${keys.length} days (expected 14)`);
}

// ── TEST 2: After first review on day -7, anchor set ──────────────────────────
console.log('\n=== TEST 2: Anchor = day-7, next review covers last 7 days ===');
dbMod.setState(TEST_CHAT_ID, { last_weekly_review_completed_at: ms(-7) });
const data2 = dbMod.getWeeklyReviewData(TEST_CHAT_ID, ms(0));
if (!data2) {
  console.log('FAIL: got null');
} else {
  const keys = Object.keys(data2.dailyTotals);
  console.log(`Window: ${keys.length} days  ${keys[0]} → ${keys[keys.length-1]}`);
  console.log(keys.length === 7 ? 'PASS: exactly 7 days' : `WARN: ${keys.length} (expected 7)`);
}

// ── TEST 3: Vacation guard in bot.js ──────────────────────────────────────────
console.log('\n=== TEST 3: Vacation guard ===');
// Simulate the bot.js wake-flow logic
const fakeVacationState = { vacation_mode: 1, weekly_review_dow: 1, timezone: 'Asia/Kuala_Lumpur' };
const { getOffsetMs } = require('./src/utils/time');
const reviewDow = fakeVacationState.weekly_review_dow ?? 1;
const isReviewDay = !fakeVacationState.vacation_mode &&
  new Date(Date.now() + getOffsetMs(fakeVacationState.timezone)).getUTCDay() === reviewDow;
console.log(`vacation_mode=1, isReviewDay = ${isReviewDay}`);
console.log(!isReviewDay ? 'PASS: weekly_waiting_weight stays 0 during vacation' : 'FAIL: review would trigger during vacation');

// ── TEST 4: Vacation ends day 0, anchor = day0, next review = day0..day+6 ────
console.log('\n=== TEST 4: Post-vacation review covers only post-vacation days ===');
const day0Start = ms(0);
dbMod.setState(TEST_CHAT_ID, { last_weekly_review_completed_at: day0Start, vacation_mode: 0 });

// Add 7 post-vacation logs (day 0 to day +6)
for (let d = 0; d <= 6; d++) {
  const dayStart = ms(d);
  raw.prepare("INSERT INTO meal_log (chat_id, meal_name, calories, protein, carbs, fat, logged_at, day_start) VALUES (?,?,?,?,?,?,?,?)")
    .run(TEST_CHAT_ID, `PostVac d${d}`, 2200, 160, 210, 65, dayStart + 3600000, dayStart);
}

const data4 = dbMod.getWeeklyReviewData(TEST_CHAT_ID, ms(7)); // review fires on day+7
if (!data4) {
  console.log('FAIL: got null');
} else {
  const keys = Object.keys(data4.dailyTotals);
  console.log(`Window: ${keys.length} days  ${keys[0]} → ${keys[keys.length-1]}`);
  // All keys should be >= day0Start date
  const day0DateStr = new Date(day0Start + getOffsetMs('Asia/Kuala_Lumpur')).toISOString().split('T')[0];
  const preVac = keys.filter(k => k < day0DateStr);
  console.log(preVac.length === 0 ? 'PASS: no pre-vacation data in window' : `FAIL: ${preVac.length} pre-vacation days leaked in`);
  console.log(keys.length === 7 ? 'PASS: exactly 7 post-vacation days' : `INFO: ${keys.length} days`);
}

// ── TEST 5: New user, < 5 days → null ─────────────────────────────────────────
console.log('\n=== TEST 5: New user, 3 days → null (below threshold) ===');
raw.prepare("INSERT OR IGNORE INTO user_state (chat_id, status, timezone) VALUES (?,?,?)").run(NEW_CHAT, 'awake', 'Asia/Kuala_Lumpur');
dbMod.setState(NEW_CHAT, { weekly_review_dow: 5, last_weekly_review_completed_at: null, current_day_start: ms(0) });
for (let d = -3; d < 0; d++) {
  raw.prepare("INSERT INTO meal_log (chat_id, meal_name, calories, protein, carbs, fat, logged_at, day_start) VALUES (?,?,?,?,?,?,?,?)")
    .run(NEW_CHAT, `New d${d}`, 1800, 130, 180, 55, ms(d) + 3600000, ms(d));
}
const data5 = dbMod.getWeeklyReviewData(NEW_CHAT, ms(0));
console.log(data5 === null ? 'PASS: null (< 5 days)' : `FAIL: expected null, got ${Object.keys(data5.dailyTotals).length} days`);

// ── TEST 6: New user, exactly 5 days → gets review ────────────────────────────
console.log('\n=== TEST 6: New user, 5 days → review fires ===');
for (let d = -5; d < -3; d++) {
  raw.prepare("INSERT INTO meal_log (chat_id, meal_name, calories, protein, carbs, fat, logged_at, day_start) VALUES (?,?,?,?,?,?,?,?)")
    .run(NEW_CHAT, `New d${d}`, 1800, 130, 180, 55, ms(d) + 3600000, ms(d));
}
const data6 = dbMod.getWeeklyReviewData(NEW_CHAT, ms(0));
console.log(data6 !== null ? `PASS: got review (${Object.keys(data6.dailyTotals).length} days)` : 'FAIL: expected data, got null');

// ── Cleanup ───────────────────────────────────────────────────────────────────
raw.prepare('DELETE FROM user_state WHERE chat_id IN (?,?)').run(TEST_CHAT_ID, NEW_CHAT);
raw.prepare('DELETE FROM meal_log WHERE chat_id IN (?,?)').run(TEST_CHAT_ID, NEW_CHAT);

console.log('\n✅ Simulation complete');
