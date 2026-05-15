require('dotenv').config();
const claude = require('./src/claude');

const baseProfile = { coaching_style: 2, language: 'English', name: 'Max' };
const baseTargets = 'Calories: 2200 | Protein: 160g | Carbs: 220g | Fat: 70g';

// Test 1: caffeine_mg=450, last_caffeine_time=18:00 — should flag
const data1 = {
  today: { meals: ['Breakfast: eggs', 'Lunch: chicken rice'], caffeine_mg: 450, last_caffeine_time: '18:00', minutesAwake: 600 },
  todayAlert: null,
  recentAlerts: [],
};

// Test 2: caffeine_mg=200, last_caffeine_time=14:00 — should NOT flag caffeine
const data2 = {
  today: { meals: ['Breakfast: eggs', 'Lunch: chicken rice'], caffeine_mg: 200, last_caffeine_time: '14:00', minutesAwake: 600 },
  todayAlert: null,
  recentAlerts: [],
};

(async () => {
  console.log('=== Test 1: caffeine=450mg, last_caffeine_time=18:00 ===');
  const r1 = await claude.checkProactivePatterns(data1, baseTargets, baseProfile);
  console.log('result:', r1);

  console.log('\n=== Test 2: caffeine=200mg, last_caffeine_time=14:00 ===');
  const r2 = await claude.checkProactivePatterns(data2, baseTargets, baseProfile);
  console.log('result:', r2);
})().catch(e => console.error(e.message));
