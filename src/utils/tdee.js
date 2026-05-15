// Mifflin-St Jeor BMR — gender-aware
function calculateBMR(weight_kg, height_cm, age, gender = 'male') {
  const base = (10 * weight_kg) + (6.25 * height_cm) - (5 * age);
  return gender === 'female' ? base - 161 : base + 5;
}

// Combined NEAT (daily activity outside gym) + gym sessions
function activityFactor(weeklyWorkouts, activityLevel = 2) {
  const neat = [0, 1.2, 1.375, 1.55, 1.725][activityLevel] || 1.375;
  const gymBonus = weeklyWorkouts >= 5 ? 0.15 : weeklyWorkouts >= 3 ? 0.1 : weeklyWorkouts >= 1 ? 0.05 : 0;
  return Math.min(neat + gymBonus, 1.9);
}

function calculateTDEE(weight_kg, height_cm, age, weeklyWorkouts = 3, activityLevel = 2, gender = 'male') {
  const bmr = calculateBMR(weight_kg, height_cm, age, gender);
  return Math.round(bmr * activityFactor(weeklyWorkouts, activityLevel));
}

// Dynamic age from ISO birthday string — use this instead of stored age
function ageFromBirthday(birthday) {
  if (!birthday) return null;
  const birth = new Date(birthday);
  const now   = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

// Estimate workout calories burned from workout entries
function sumWorkoutCalories(workouts = []) {
  return Math.round(workouts.reduce((sum, w) => sum + (w.calories_burned ?? 0), 0));
}

module.exports = { calculateTDEE, sumWorkoutCalories, calculateBMR, activityFactor, ageFromBirthday };
