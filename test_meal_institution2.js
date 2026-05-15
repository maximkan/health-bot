require('dotenv').config();
const claude = require('./src/claude');
const db = require('./src/db');

// Max's real known foods contain NS items
const maxKnownFoods = `NS Lunch — African Spiced Beef Brisket Regular: 450 kcal, 42g protein, 38g carbs, 14g fat
NS Dinner — Lemon Garlic Chicken & Sides: 778 kcal, 65g protein, 52g carbs, 28g fat
Rokeby Farms Protein Smoothie: 282 kcal, 28g protein, 24g carbs, 8g fat`;

// Other user has no NS items in their known foods
const otherKnownFoods = `Chicken Rice: 520 kcal, 35g protein, 58g carbs, 14g fat
Oatmeal with banana: 350 kcal, 12g protein, 62g carbs, 6g fat`;

(async () => {
  const maxState = db.getState(119445404);

  // Test 1: Max — "NS dinner" — institution_keywords set, NS items in Known Foods
  console.log('=== Test 1: Max ("NS dinner") ===');
  const r1 = await claude.analyzeMeal(null, 'NS dinner', 'Tuesday', maxKnownFoods, null, maxState.institution_keywords);
  console.log('meal_name:', r1.meal_name);
  console.log('confidence:', r1.confidence);
  console.log('calories:', r1.totals?.calories);
  console.log('clarification:', r1.clarification);

  // Test 2: Other user — "NS dinner" — no institution_keywords, Known Foods has no NS items
  console.log('\n=== Test 2: Other user ("NS dinner") — no institution_keywords, no NS in Known Foods ===');
  const r2 = await claude.analyzeMeal(null, 'NS dinner', 'Tuesday', otherKnownFoods, null, null);
  console.log('meal_name:', r2.meal_name);
  console.log('confidence:', r2.confidence);
  console.log('calories:', r2.totals?.calories);
  console.log('clarification:', r2.clarification);

  // Test 3: Other user — "NS dinner" — with institution_keywords set (hypothetical non-Max user with their own institution)
  console.log('\n=== Test 3: Other user with their own institution keywords ("canteen,staff cafe") + "NS dinner" ===');
  const r3 = await claude.analyzeMeal(null, 'NS dinner', 'Tuesday', otherKnownFoods, null, 'canteen,staff cafe');
  console.log('meal_name:', r3.meal_name);
  console.log('confidence:', r3.confidence);
  console.log('calories:', r3.totals?.calories);
  console.log('clarification:', r3.clarification);
})().catch(e => console.error(e.message));
