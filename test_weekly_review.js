require('dotenv').config();
const claude = require('./src/claude');

// Controlled test dataset — known values for manual verification
const weekData = {
  dailyTotals: {
    '2026-05-06': { calories: 2350, protein: 145, carbs: 230, fat: 72 },
    '2026-05-07': { calories: 1900, protein: 172, carbs: 195, fat: 58 },
    '2026-05-08': { calories: 2100, protein: 158, carbs: 210, fat: 64 },
    '2026-05-09': { calories: 2450, protein: 140, carbs: 245, fat: 78 },
    '2026-05-10': { calories: 1950, protein: 165, carbs: 200, fat: 60 },
  },
  workouts: [
    { workout_name: 'Upper Body', duration_min: 55, calories_burned: 320 },
    { workout_name: 'Lower Body', duration_min: 60, calories_burned: 350 },
    { workout_name: 'Cardio Run', duration_min: 40, calories_burned: 420 },
  ],
  avgSleep: 7.2,
  avgSleepQuality: 3.8,
  bodyLogs: [
    { weight_kg: 104.2, body_fat_pct: 22.5, logged_at: Date.now() - 6 * 86400000 },
    { weight_kg: 103.6, body_fat_pct: 22.1, logged_at: Date.now() - 1 * 86400000 },
  ],
  latestBody: { weight_kg: 103.6, body_fat_pct: 22.1 },
  recoverySessions: [],
};

// Targets: calories 2200, protein 160g — intentionally: avg calories slightly over, protein under
const targets = {
  calories: 2200, protein: 160, carbs: 220, fat: 70,
  weight_kg: 103.6, goal_weight: 80,
};

console.log('=== buildWeekSummary output ===\n');
const summary = claude.buildWeekSummary(weekData, targets);
console.log(summary);

// Manual verification:
// weightDelta = 103.6 - 104.2 = -0.6 kg ✓
// avgCalories = (2350+1900+2100+2450+1950)/5 = 10750/5 = 2150  → under 2200 → OK
// avgProtein  = (145+172+158+140+165)/5 = 780/5 = 156  → under 160 → UNDER
// on-target protein (>=160): days 172,158? no 158<160. 172 yes, 145 no, 158 no, 140 no, 165 yes = 2/5 = 40%
// on-target calories (>=2200): 2350 yes, 1900 no, 2100 no, 2450 yes, 1950 no = 2/5 = 40%
// best day: highest protein = May 7 (172g)
// worst day: highest (cal - 2200): 2350-2200=150, 1900-2200=-300, 2100-2200=-100, 2450-2200=250, 1950-2200=-250 → May 9
// sleep: 7.2h → 7h 12m, quality 3.8/5
// goal: 80kg, currently 103.6, 23.6kg to go, delta -0.6/wk → ~39 weeks

console.log('\n=== Real API call: generateWeeklyReview ===\n');
const profile = { coaching_style: 2, language: 'English', name: 'Max' };
const targetsCtx = `Current weight: ~103.6kg, goal: 80kg\nDaily targets: 2200 kcal / 160g protein / 220g carbs / 70g fat`;

(async () => {
  const review = await claude.generateWeeklyReview(weekData, targetsCtx, profile, targets);
  console.log(review);
  console.log('\n--- Checks ---');
  console.log('Contains weight delta (-0.6kg):', /-0\.6/.test(review) || /0\.6.*kg/.test(review));
  console.log('Does NOT contain "want me to update":', !/want me to update/i.test(review));
  console.log('Contains "7h 12m" or sleep time:', /7h\s*12m/i.test(review) || /sleep/i.test(review));
})().catch(e => console.error(e.message));
