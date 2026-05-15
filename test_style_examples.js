require('dotenv').config();
const claude = require('./src/claude');

const workouts = [
  {
    logged_at: Date.now() - 3 * 86400000,
    workout_name: 'Upper Body',
    duration_min: 55,
    exercises: [
      { name: 'Bench Press', sets: 4, reps: 8, weight_kg: 80 },
      { name: 'Pull-ups',    sets: 4, reps: 8, weight_kg: null },
      { name: 'OHP',         sets: 3, reps: 10, weight_kg: 60 },
    ],
  },
  {
    logged_at: Date.now() - 10 * 86400000,
    workout_name: 'Upper Body',
    duration_min: 50,
    exercises: [
      { name: 'Bench Press', sets: 4, reps: 8, weight_kg: 80 },
      { name: 'Pull-ups',    sets: 4, reps: 8, weight_kg: null },
      { name: 'OHP',         sets: 3, reps: 8,  weight_kg: 60 },
    ],
  },
  {
    logged_at: Date.now() - 17 * 86400000,
    workout_name: 'Upper Body',
    duration_min: 50,
    exercises: [
      { name: 'Bench Press', sets: 4, reps: 8, weight_kg: 77.5 },
      { name: 'OHP',         sets: 3, reps: 8,  weight_kg: 57.5 },
    ],
  },
];

const current = workouts[0];
const previous = { ...workouts[1], date: '5 May 2026' };

(async () => {
  // WEEKLY_STRENGTH_SUMMARY: style 1 vs style 3
  console.log('=== WEEKLY_STRENGTH_SUMMARY style 1 ===');
  const s1 = await claude.generateWeeklyStrengthSummary(workouts, { coaching_style: 1, language: 'English', name: 'Max' });
  console.log(s1);

  console.log('\n=== WEEKLY_STRENGTH_SUMMARY style 3 ===');
  const s3 = await claude.generateWeeklyStrengthSummary(workouts, { coaching_style: 3, language: 'English', name: 'Max' });
  console.log(s3);

  console.log('\n=== WEEKLY_STRENGTH_SUMMARY style null (fallback → 2) ===');
  const sN = await claude.generateWeeklyStrengthSummary(workouts, { coaching_style: null, language: 'English', name: 'Max' });
  console.log(sN);

  // WORKOUT_COMPARISON: style 1 vs style 3
  console.log('\n=== WORKOUT_COMPARISON style 1 ===');
  const c1 = await claude.generateWorkoutComparison(current, previous, { coaching_style: 1, language: 'English', name: 'Max' });
  console.log(c1);

  console.log('\n=== WORKOUT_COMPARISON style 3 ===');
  const c3 = await claude.generateWorkoutComparison(current, previous, { coaching_style: 3, language: 'English', name: 'Max' });
  console.log(c3);
})().catch(e => console.error(e.message));
