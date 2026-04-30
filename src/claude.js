const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const HAIKU  = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

function parseJSON(text) {
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = codeBlock ? codeBlock[1] : text;
  const jsonMatch = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

// ── Classifier ────────────────────────────────────────────────────────────────

const CLASSIFIER_SYSTEM = `Classify the user's health bot message. Return ONLY a JSON array of intents.

Intents:
- MEAL_LOG: logging food they ate
- DRINK_LOG: logging a drink (coffee, tea, shake, smoothie, milo, teh tarik, juice, energy drink, alcohol)
- WORKOUT_START: starting a live workout session NOW ("started my workout", "at the gym", "starting gym", "начал тренировку")
- WORKOUT_LOG: logging exercise or training they did
- RECOVERY_LOG: logging sauna or cold plunge
- SLEEP_LOG: reporting a complete sleep session or nap with duration/times ("slept from 1am to 8am", "slept 6 hours", "went to bed at 2am woke at 9", "had a nap from 3-4pm"). NOT for just "woke up at X" alone — that's WAKE.
- WEIGHT_LOG: logging body weight or body fat
- BED: RIGHT NOW going to sleep — present intent only ("gn", "good night", "going to sleep", "heading to bed", "night", "спать", "спокойной ночи")
- WAKE: waking up, morning, first message, доброе утро
- PLAN: creating a plan, reminder, event, scheduling something
- PLAN_DONE: confirming a task is done
- PLAN_SKIP: skipping or postponing a plan
- CORRECTION: changing/fixing a previous log entry (time, values, etc.)
- DELETE: deleting/removing a log entry ("delete my chicken rice", "remove today's lunch", "delete that workout")
- UPDATE_TARGETS: changing daily nutrition targets ("change calorie target to 1800", "set protein to 200g", "update my macros")
- COACH_QUESTION: asking a health, nutrition, or fitness question
- GENERAL: greeting, thanks, anything else

Return ALL intents that apply. Examples:
"gn" → ["BED"]
"morning" → ["WAKE"]
"sauna then chicken rice" → ["RECOVERY_LOG","MEAL_LOG"]
"how much protein in eggs?" → ["COACH_QUESTION"]
"is chicken rice a good option?" → ["COACH_QUESTION"]
"would a burger fit my macros?" → ["COACH_QUESTION"]
"started my workout" → ["WORKOUT_START"]
"at the gym" → ["WORKOUT_START"]
"gym tomorrow at 10am" → ["PLAN"]
"change my lunch to 2pm" → ["CORRECTION"]
"weighed 104kg this morning" → ["WEIGHT_LOG"]

Return ONLY a JSON array, nothing else.`;

async function classify(text, history = []) {
  try {
    let content = text;
    if (history.length > 0) {
      const ctx = history.map(m => `${m.role === 'user' ? 'User' : 'Bot'}: ${m.text.slice(0, 150)}`).join('\n');
      content = `[Recent conversation:\n${ctx}\n]\n\nClassify this message: ${text}`;
    }
    const response = await anthropic.messages.create({
      model: HAIKU, max_tokens: 60, system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content }],
    });
    const match = response.content[0].text.match(/\[[\s\S]*?\]/);
    if (!match) return ['GENERAL'];
    const arr = JSON.parse(match[0]);
    const VALID = new Set(['MEAL_LOG','DRINK_LOG','WORKOUT_START','WORKOUT_LOG','RECOVERY_LOG','SLEEP_LOG',
      'WEIGHT_LOG','BED','WAKE','PLAN','PLAN_DONE','PLAN_SKIP','CORRECTION','DELETE','UPDATE_TARGETS','COACH_QUESTION','GENERAL']);
    const filtered = arr.filter(i => VALID.has(i));
    return filtered.length ? filtered : ['GENERAL'];
  } catch { return ['GENERAL']; }
}

// ── Plan matching for skip/done ───────────────────────────────────────────────

async function matchPlanToModify(userText, plans) {
  if (!plans.length) return null;
  if (plans.length === 1) return plans[0];
  const list = plans.map((p, i) => `${i + 1}. ${p.plan_text}${p.plan_date ? ' on ' + p.plan_date : ''}${p.plan_time ? ' at ' + p.plan_time : ''}`).join('\n');
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'Given a user message about a plan and a numbered list of plans, reply ONLY with the number of the best match, or 0 if none clearly match.',
    messages: [{ role: 'user', content: `Message: "${userText}"\n\nPlans:\n${list}` }],
  });
  const n = parseInt(response.content[0].text.trim());
  return (n >= 1 && n <= plans.length) ? plans[n - 1] : plans[plans.length - 1];
}

// ── Entry matching for deletion ───────────────────────────────────────────────

async function matchEntryToDelete(userText, entries) {
  const list = entries.map((e, i) => `${i + 1}. [${e.label}] ${e.title}${e.extra ? ' — ' + e.extra : ''}`).join('\n');
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'Given a deletion request and a numbered list of log entries, reply ONLY with the number of the best match, or 0 if none clearly match.',
    messages: [{ role: 'user', content: `Request: "${userText}"\n\nEntries:\n${list}` }],
  });
  const n = parseInt(response.content[0].text.trim());
  return (n >= 1 && n <= entries.length) ? entries[n - 1] : null;
}

// ── Meal analysis ─────────────────────────────────────────────────────────────

const MEAL_SYSTEM = `You are an expert food analysis assistant with deep knowledge of Southeast Asian cuisine. The message may contain multiple logs (workouts, plans, etc) — extract ONLY the food/drink items.

STEP 1: Identify every distinct food item visible or described.
STEP 2: Estimate realistic weight in grams for each item.
STEP 3: Calculate calories, protein, carbs, fat per item using accurate per-100g values.
STEP 4: Sum totals.

ACCURACY RULES:
- Asian side dishes (banchan, vegetable sides): 30–80g, 20–60 kcal each
- Korean banchan: spinach namul ~30 kcal, bean sprouts ~15 kcal, kimchi 50g ~20 kcal
- Small Asian rice bowls: ~150–180g cooked rice = 200–240 kcal
- Malaysian: nasi lemak (full plate) 500–650 kcal, chicken rice 450–550 kcal, roti canai 300 kcal
- Soups/broths: mostly water, low calorie unless creamy
- Do NOT double-count items

KNOWN FOODS RULES (when a Known Foods section is provided):
- Known Foods are measured ground truth — always use those exact calorie/macro values
- For photos showing a multi-component plate (buffet/cafeteria style with rice, protein, vegetables, sides): this is almost certainly an NS (Network School) cafeteria dinner — treat it as such
- Match each visible item to the closest Known Foods entry; use those macros exactly; only adjust for portion size relative to standard serving
- If you see an item that looks like a DIFFERENT food from what's in Known Foods (e.g., rice on plate but Known Foods shows pasta): set confidence="low", clarification="I see [what you see] on the plate but today's menu shows [known foods entry] — did they swap it? Tell me what to use."
- If an item has no match at all in Known Foods: set new_food=true, confidence="low", clarification="[item] isn't in today's database — what should I use for macros?"
- If the photo could plausibly NOT be NS (restaurant plating, single dish, home-cooked style): set confidence="low", clarification="Is this an NS dinner? (yes/no)"
- Never invent macros for items that exist in Known Foods — match and use, don't re-estimate

Parse time from the message in any format ("at 12:30", "at 11 30 am", "around noon", "just now", "1pm", "13:00") → always output as 24h "HH:MM". Omit time field only if truly no time mentioned.

Drink type rules: ANY beverage (coffee, tea, shake, smoothie, juice, milo, teh tarik, sirap, bandung, alcohol, water with flavoring) = Drink type, regardless of time.

Respond ONLY with this JSON:
{
  "meal_name": "Chicken Rice",
  "meal_type": "Lunch",
  "time": "12:30",
  "items": [
    {"name": "Chicken breast", "weight_g": 150, "calories": 248, "protein": 46, "carbs": 0, "fat": 5}
  ],
  "totals": {"calories": 482, "protein": 50, "carbs": 51, "fat": 5.4},
  "caffeine_mg": 0,
  "confidence": "high",
  "clarification": null,
  "new_food": false
}

meal_type (time-based unless it's a drink):
- Any beverage → "Drink"
- Before 11:00 → "Breakfast"
- 11:00–15:00 → "Lunch"
- 15:00–17:30 → "Snack"
- 17:30–21:00 → "Dinner"
- 21:00+ → "Snack"

caffeine_mg: estimate based on drink type. 0 for food.
Omit time field if no specific time mentioned.
Set weight_g to null if unknown.
Set clarification to a specific question only if confidence = "low".`;

async function analyzeMeal(photoBase64OrArray, caption, dayOfWeek, knownFoodsContext, currentTime) {
  const content = [];
  const photos = Array.isArray(photoBase64OrArray) ? photoBase64OrArray : (photoBase64OrArray ? [photoBase64OrArray] : []);
  for (const photo of photos) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } });
  }
  let text = caption || 'Analyze this meal.';
  if (currentTime) text += `\n\n${currentTime}`;
  if (dayOfWeek) text += `\nDay: ${dayOfWeek}`;
  if (knownFoodsContext) text += `\n\nKnown Foods:\n${knownFoodsContext}`;
  content.push({ type: 'text', text });

  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: MEAL_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse meal: ${response.content[0].text}`);
  parsed._hasPhoto = photos.length > 0;
  return parsed;
}

// ── Workout parsing ───────────────────────────────────────────────────────────

const WORKOUT_SYSTEM = `Parse the user's workout. The message may contain multiple logs (food, plans, etc) — extract ONLY the workout/exercise part.

Calories = MET × 105kg × hours. MET values for cardio/sport:
- Rowing machine: 7.0, Running 8km/h: 8.0, Swimming: 7.0, Tennis: 7.3, Golf walking: 4.3, Yoga: 2.5, Hiking: 6.0

For weight training, use density to pick MET (density = total_sets / duration_min):
- density > 0.4 (many exercises, short rest — circuit/superset style): MET 5.5
- density 0.25–0.4 (normal gym pace, moderate rest): MET 4.5
- density < 0.25 (long rests, heavy compound focus): MET 3.5
Example: 8 exercises × 3 sets = 24 sets in 40 min → density 0.60 → MET 5.5 → 5.5 × 105 × (40/60) = ~385 kcal

SETS/REPS RULES:
- "3x10" or "3 sets x 10 reps" → sets=3, reps=10
- "60 deadlifts" (total reps, no sets) → sets=1, reps=60
- "30 each leg" means that side's count; total reps = stated number (e.g. "60 bulgarian squats (30 each leg)" → sets=1, reps=60)
- Always populate both sets AND reps. Never leave both null.

If Known Custom Exercises are provided, use their typical values as defaults when the user doesn't specify sets/reps/weight.

Time parsing: extract the START time of the workout if mentioned in any format ("8am", "8:00", "8 to 10am" → "08:00", "from 9" → "09:00"). Use 24h "HH:MM" format. Omit if no time mentioned.

Return ONLY JSON:
{
  "workout_name": "Legs Day",
  "activity_type": "legs",
  "duration_min": 45,
  "calories_burned": 280,
  "time": "08:00",
  "exercises": [{"name": "Squats", "sets": 4, "reps": 10, "weight_kg": 60}],
  "exercises_summary": "squats 4x10@60kg, lunges 3x12"
}`;

async function parseWorkout(text, knownExercisesCtx = '') {
  let content = text;
  if (knownExercisesCtx) content = `Known Custom Exercises:\n${knownExercisesCtx}\n\nWorkout: ${text}`;
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 1024, system: WORKOUT_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse workout: ${response.content[0].text}`);
  return parsed;
}

async function applyWorkoutCorrection(existingData, correction) {
  const prompt = `Current workout data:\n${JSON.stringify(existingData, null, 2)}\n\nUser correction: "${correction}"\n\nApply the correction:\n- If user says exercises were missed/skipped, ADD them to the exercises array\n- If user changes duration/intensity, recalculate calories_burned\n- Only modify what was mentioned\nReturn the complete updated JSON with same structure.`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024,
    system: 'You are a workout data editor. Apply corrections to workout JSON precisely. Return only valid JSON with same structure.',
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error('Could not parse correction response');
  return parsed;
}

// ── Live exercise parsing ─────────────────────────────────────────────────────

const LIVE_EXERCISE_SYSTEM = `Parse a single exercise log from the gym. The user is logging one exercise at a time mid-workout.

Support mixed weights per set: "bench press 1x10 30kg, 2x10 50kg" means set 1: 1×10 at 30kg, sets 2-3: 2×10 at 50kg.

Return ONLY JSON:
{
  "name": "Bench Press",
  "sets_detail": [
    {"sets": 1, "reps": 10, "weight_kg": 30},
    {"sets": 2, "reps": 10, "weight_kg": 50}
  ]
}

For uniform weight (e.g. "bench press 3x10 100kg"), return a single sets_detail entry:
{"sets_detail": [{"sets": 3, "reps": 10, "weight_kg": 100}]}

weight_kg: null if bodyweight. reps: total reps if no sets specified.`;

async function parseLiveExercise(text) {
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 256, system: LIVE_EXERCISE_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  return parseJSON(resp.content[0].text);
}

// ── Workout comparison ────────────────────────────────────────────────────────

async function generateWorkoutComparison(current, previous, userProfile = {}) {
  const prompt = `Compare these two workouts and give a brief progress comment.

Previous workout (${previous.date || 'earlier'}):
${JSON.stringify(previous.exercises, null, 2)}

Current workout:
${JSON.stringify(current.exercises, null, 2)}

Focus on: weight increases, rep increases, volume changes. Be specific — name the exercise and the improvement.
If there's no improvement or it's worse somewhere, note it too.
2-3 sentences max. Casual, direct. No markdown.`;
  const resp = await anthropic.messages.create({
    model: SONNET, max_tokens: 256,
    system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0].text.trim();
}

// ── Weekly strength/endurance summary ────────────────────────────────────────

async function generateWeeklyStrengthSummary(workouts, userProfile = {}) {
  if (!workouts.length) return null;
  const prompt = `Analyze these workouts from the past few weeks and give a weekly strength & endurance progress summary.

Workouts (newest first):
${JSON.stringify(workouts.map(w => ({ date: new Date(w.logged_at).toISOString().split('T')[0], name: w.workout_name, duration_min: w.duration_min, exercises: w.exercises })), null, 2)}

Look for:
- Strength gains: heavier weights on key lifts vs 2-4 weeks ago
- Volume increases: more sets/reps on the same exercises
- Endurance: longer sessions or better workout density
- Consistency: how many gym sessions this week vs previous weeks

Give a punchy 3-4 sentence summary. Highlight the biggest win and biggest opportunity. No markdown, casual tone.`;
  const resp = await anthropic.messages.create({
    model: SONNET, max_tokens: 384,
    system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0].text.trim();
}

// ── Recovery parsing ──────────────────────────────────────────────────────────

const RECOVERY_SYSTEM = `Parse a sauna or cold plunge session from the message. The message may contain other logs — extract ONLY the recovery session. Type must be exactly "Sauna" or "Cold Plunge".
Return ONLY JSON:
{"type": "Sauna", "duration_min": 15, "temperature_c": 85, "notes": ""}
If temperature not mentioned, set temperature_c to null.`;

async function parseRecovery(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 256, system: RECOVERY_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse recovery: ${response.content[0].text}`);
  return parsed;
}

// ── Sleep parsing ─────────────────────────────────────────────────────────────

const SLEEP_SYSTEM = `Parse sleep info from the message. The message may contain other logs — extract ONLY the sleep data.

type: "Night" for main sleep, "Nap" for naps.
For naps: bed_time = nap start, wake_time = nap end. hours_slept = duration. quality = null.
If quality not mentioned for night sleep, default to 3.

Return ONLY JSON:
{"type": "Night", "bed_time": "01:00", "wake_time": "08:30", "hours_slept": 7.5, "quality": 3, "notes": ""}

Nap example — "nap from 4 to 5pm":
{"type": "Nap", "bed_time": "16:00", "wake_time": "17:00", "hours_slept": 1.0, "quality": null, "notes": ""}`;

async function parseSleep(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 256, system: SLEEP_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse sleep: ${response.content[0].text}`);
  return parsed;
}

// ── Body parsing ──────────────────────────────────────────────────────────────

const BODY_SYSTEM = `Parse body measurement from the message. The message may contain other logs — extract ONLY the weight/body data. Return ONLY JSON:
{"weight_kg": 104.2, "body_fat_pct": 28, "notes": ""}
If body fat not mentioned, set body_fat_pct to null.`;

async function parseBody(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 256, system: BODY_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse body: ${response.content[0].text}`);
  return parsed;
}

// ── Plan parsing ──────────────────────────────────────────────────────────────

const PLAN_SYSTEM = `Parse plans/reminders from natural language. Extract all details.

Return ONLY JSON:
{
  "plans": [
    {
      "title": "Golf",
      "date": "2026-04-24",
      "time": "15:00",
      "duration_min": 60,
      "location": null,
      "guests": [],
      "recurring": "one-time",
      "is_task": false
    }
  ]
}

Rules:
- title: clean human-readable name (NOT the raw message). "meeting with Max blabla@gmail.com at 3pm" → "Meeting with Max"
- date: YYYY-MM-DD. Resolve "tomorrow", "Friday" etc. relative to the current date provided.
- time: HH:MM 24h, or null if no specific time
- guests: extract email addresses from the message
- location: extract if mentioned after "in", "at", "at location"
- is_task: true if this is a task/errand (no specific time, not an event)
- recurring: "one-time", "daily", "weekly"`;

async function parsePlans(text, currentDateTime) {
  const content = currentDateTime ? `${currentDateTime}\n\n${text}` : text;
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 512, system: PLAN_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const parsed = parseJSON(response.content[0].text);
  return parsed?.plans ?? [];
}

// ── Time correction parsing ───────────────────────────────────────────────────

const TIME_CORRECTION_SYSTEM = `Parse a log time correction. Return ONLY JSON:
{"entry_type": "meal", "description": "lunch", "new_time": "14:00"}
entry_type: meal | workout | sleep | recovery | body`;

async function parseTimeCorrection(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 128, system: TIME_CORRECTION_SYSTEM,
    messages: [{ role: 'user', content: text }],
  });
  return parseJSON(response.content[0].text);
}

// ── General correction (Sonnet) ───────────────────────────────────────────────

async function parseCorrection(text, context) {
  const prompt = `${context ? context + '\n\n' : ''}User says: "${text}"

What should be corrected? Return ONLY JSON:
{
  "action": "update_time" | "update_calories" | "update_weight" | "delete" | "backdate" | "other",
  "entry_type": "meal" | "workout" | "sleep" | "recovery" | "body",
  "description": "brief description of which entry",
  "new_value": "the new value (time HH:MM, or calories number, etc.)",
  "new_time": "HH:MM if this is a time update, else null",
  "details": "any other details"
}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 256,
    system: 'You parse correction instructions for a health tracking bot. Return only JSON.',
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJSON(response.content[0].text);
}

// ── Meal correction ───────────────────────────────────────────────────────────

async function applyMealCorrection(existingData, correction) {
  const prompt = `Current meal data:\n${JSON.stringify(existingData, null, 2)}\n\nUser correction: "${correction}"\n\nApply the correction precisely:
- If user says they DIDN'T have something, REMOVE those items from the items array entirely
- If user says to change a quantity/weight, update that item's calories/macros proportionally
- If user says to add something, add it as a new item with estimated macros
- NEVER change meal_name unless explicitly asked
- After ALL changes, recalculate totals.calories/protein/carbs/fat as the exact SUM of all remaining items
- Return the complete updated JSON with the same structure`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024,
    system: 'You are a meal data editor. Apply corrections to meal JSON precisely. When removing items, delete them from the items array. When changing amounts, scale the macros. Always recalculate totals as sum of items. Return only valid JSON with same structure.',
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error('Could not parse correction response');
  return parsed;
}

// ── Target update parsing ─────────────────────────────────────────────────────

async function parseTargetUpdate(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 128,
    system: 'Parse a nutrition target update. Return ONLY JSON: {"calories": null, "protein": null, "carbs": null, "fat": null}. Set only the values explicitly mentioned, leave others null.',
    messages: [{ role: 'user', content: text }],
  });
  return parseJSON(response.content[0].text);
}

async function recalculateTargets(currentTargets, userInstruction) {
  const prompt = `Current nutrition targets:
Calories: ${currentTargets.calories} kcal
Protein: ${currentTargets.protein}g
Carbs: ${currentTargets.carbs}g
Fat: ${currentTargets.fat}g
Body weight: ${currentTargets.weight_kg}kg, goal: ${currentTargets.goal_weight}kg

User wants to change: "${userInstruction}"

Recalculate all four macros so they stay coherent and add up to the target calories (protein: 4 kcal/g, carbs: 4 kcal/g, fat: 9 kcal/g). Keep the same diet approach (high protein, low carb). Return ONLY JSON: {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 128,
    system: 'You are a nutrition target calculator. Apply the requested change and recalculate all macros to stay coherent. Return only JSON.',
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJSON(response.content[0].text);
}

// ── Coach system prompt ───────────────────────────────────────────────────────

const STYLE_TONE = {
  1: 'Gentle and encouraging. Celebrate progress. When something is off, point it out softly — frame problems as opportunities. Never shame or guilt. Still 100% honest, just kind delivery.',
  2: 'Direct and honest. Call out problems clearly but constructively. Balanced — acknowledge wins, address failures without drama.',
  3: 'Fully direct. No softening, no diplomatic hedging. If habits are bad, say so plainly. Tough love — the user wants hard truth, not comfort.',
};

function buildCoachSystem(targetsContext = '', coachingStyle = 2, language = 'en', userName = null) {
  const name = userName || 'the user';
  const styleLine = STYLE_TONE[coachingStyle] || STYLE_TONE[2];
  const langLine = language && language !== 'en' ? `\nRespond in ${language}. All messages must be in ${language}.` : '';
  return `You are ${name}'s personal health coach. Always completely honest.${langLine}

Tone: ${styleLine}

${targetsContext ? `${name}'s current targets and profile:\n${targetsContext}\n` : ''}

Rules:
- SPECIFIC. "Need 40g more protein — chicken breast or double scoop shake" not "eat more protein."
- Daily messages: 3–5 sentences. Weekly reviews can be longer.
- Track TRENDS. "Protein low 4 days straight" > "protein was low today."
- No medical disclaimers unless warranted.
- Casual tone, like a knowledgeable friend.
- Practical, actionable answers.
- Caffeine: over 300mg/day or after 4 PM → flag.
- Plans: "You said you'd do this. Now do it."
- If asked about nutrition/workouts/progress and you have data in context, analyze it directly. If truly no data at all is available, ask the user to share what's missing.
- When user asks what's for lunch/dinner: scan the Known Foods section for LUNCH MENU or DINNER MENU entries and list them clearly.
- FORMATTING: Use emojis (🔥💪🥩😴📊⚡🧠🍗☕ etc). NEVER use ** or * for bold, NEVER use # headers. When listing things, put each item on its own line. Structure with emojis and line breaks only. Telegram plain text.`;
}

// ── Onboarding: Opus-powered target generation ────────────────────────────────

async function generateOnboardingTargets(stats) {
  const { name, weight_kg, height_cm, age, gender, goal, goal_weight, body_fat_pct, activity_level, gym_days, language } = stats;
  const activityDesc = ['', 'sedentary (desk job, minimal movement)', 'lightly active (some walking)', 'moderately active (7k+ steps daily)', 'very active (physical job)'][activity_level] || 'lightly active';
  const langInstr = language && !/^en(glish)?$/i.test(language.trim()) ? `Write the explanation in ${language}.` : '';
  const prompt = `You are setting up a personalized nutrition plan for ${name}.

Stats:
- Age: ${age}, Height: ${height_cm}cm, Weight: ${weight_kg}kg, Gender: ${gender || 'male'}
- Goal: ${goal === 'lose' ? `lose weight → target ${goal_weight}kg` : goal === 'gain' ? `gain muscle → target ${goal_weight}kg` : goal === 'maintain' ? 'maintain weight / recomp' : 'track habits and health'}
- Body fat: ${body_fat_pct ? body_fat_pct + '%' : 'unknown'}
- Daily activity: ${activityDesc}
- Training: ${gym_days ? gym_days + ' days/week' : 'no gym'}

Calculate in this exact order:
1. BMR using Mifflin-St Jeor: male → (10×weight)+(6.25×height)-(5×age)+5, female → (10×weight)+(6.25×height)-(5×age)-161
2. TDEE = BMR × activity multiplier
3. Target calories = TDEE ${goal === 'lose' ? '− 500 (deficit for ~0.5kg/week loss)' : goal === 'gain' ? '+ 350 (surplus for muscle gain)' : '(maintenance)'}
4. Protein = 2.0–2.2g × weight_kg (round to nearest 5g)
5. Fat = 0.9g × weight_kg (round to nearest 5g)
6. Carbs = (target_calories − protein×4 − fat×9) ÷ 4 (round to nearest 5g)

CRITICAL: protein×4 + carbs×4 + fat×9 MUST equal target_calories exactly. Adjust carbs to make it balance.

For the explanation: write 2-3 sentences in simple, friendly language — like a knowledgeable friend, not a doctor. No abbreviations (BMR, TDEE, etc.) — explain everything in plain words. ${langInstr}

Return ONLY valid JSON:
{
  "calories": 0,
  "protein": 0,
  "carbs": 0,
  "fat": 0,
  "tdee": 0,
  "explanation": "..."
}`;

  const OPUS = 'claude-opus-4-7';
  const langSystem = language && !/^en(glish)?$/i.test(language.trim()) ? ` Write the explanation field in ${language}.` : '';
  const response = await anthropic.messages.create({
    model: OPUS, max_tokens: 512,
    system: `You are an expert sports nutritionist. Calculate precise macro targets. Return only valid JSON.${langSystem}`,
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJSON(response.content[0].text);
}

async function parseOnboardingInput(step, text) {
  const schemas = {
    birthday:      'Extract birth date. Return: {"date": "YYYY-MM-DD"} or {"date": null}',
    goal:          'Fitness goal: 1 or "lose weight/cut" → "lose", 2 or "gain muscle/bulk" → "gain", 3 or "maintain/recomp" → "maintain", 4 or "habits/track" → "habits". Return: {"goal": "lose"|"gain"|"maintain"|"habits"|null}',
    body_fat:      'Body fat % or skip/unknown. Return: {"body_fat": number|null}',
    activity:      'Activity level: 1 or sedentary/desk/barely move → 1, 2 or light/some walking → 2, 3 or moderate/7k+steps/on feet → 3, 4 or very active/physical job → 4. Return: {"level": 1|2|3|4|null}',
    training:      'Goes to gym? How many days/week? Return: {"gym": true|false, "days": number}',
    knows_targets: 'Does user know their calorie/macro targets? Return: {"knows": true|false}',
    wants_change:  'Wants to change/adjust the plan, or happy with it? Return: {"wants_change": true|false}',
    coaching_style:'Coaching strictness: 1 or gentle/chill/soft/easy → 1, 2 or balanced/normal/middle → 2, 3 or strict/harsh/brutal/hard → 3. Default 2 if unclear. Return: {"style": 1|2|3}',
    sleep:         'Bed time and wake time. Return: {"bed": "HH:MM"|null, "wake": "HH:MM"|null}',
    goal_weight:   'Target weight in kg, convert any units. Return: {"weight_kg": number|null}',
    gender:        'Gender from user input in any language. male/man/guy/парень/мужчина → "male", female/woman/girl/женщина/девушка → "female". Return: {"gender": "male"|"female"|null}',
  };
  const schema = schemas[step];
  if (!schema) return null;
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: `Extract structured data from user input. User may write in any language. ${schema} Return ONLY valid JSON.`,
    messages: [{ role: 'user', content: text }],
  });
  return parseJSON(resp.content[0].text);
}

async function parseStats(text) {
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system: 'Extract weight in kg and height in cm from user input. Handle any language, units (lbs, stone, feet/inches, etc.) and convert to metric. Return only valid JSON: {"weight_kg": number|null, "height_cm": number|null}',
    messages: [{ role: 'user', content: text }],
  });
  return parseJSON(resp.content[0].text);
}

async function translateText(text, language) {
  const resp = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1000,
    system: `You are a translation tool. Translate EVERY word into ${language} — option labels, short phrases, everything. Do NOT leave any English words untranslated. Preserve emojis, line breaks, numbers, and list structure exactly. Return ONLY the translated text, nothing else.`,
    messages: [{ role: 'user', content: `Translate fully to ${language}:\n\n${text}` }],
  });
  return resp.content[0].text.trim();
}

// ── Coach Q&A ─────────────────────────────────────────────────────────────────

async function askCoach(question, context = '', targetsContext = '', knownFoodsContext = '', userProfile = {}) {
  let userContent = context ? `${context}\n\nQuestion: ${question}` : question;
  if (knownFoodsContext) userContent = `Known foods for today:\n${knownFoodsContext}\n\n${userContent}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: userContent }],
  });
  return response.content[0].text;
}

async function askWithPhoto(photoBase64, caption, targetsContext = '', userProfile = {}) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{
      role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } },
        { type: 'text', text: caption || 'What can you tell me about this?' },
      ],
    }],
  });
  return response.content[0].text;
}

// ── Coach reply chain ─────────────────────────────────────────────────────────

async function continueCoachReply(messages, targetsContext = '') {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext),
    messages,
  });
  return response.content[0].text;
}

// ── Day summary ───────────────────────────────────────────────────────────────

async function generateDaySummary(dayData, targetsContext = '', tdeeCtx = null, userProfile = {}) {
  const dataStr = JSON.stringify(dayData, null, 2);
  let tdeeSection = '';
  if (tdeeCtx) {
    const { tdee, workoutKcal, eaten, netIntake, deficit, weeklyDeficitNeeded, weight_kg, goal_weight } = tdeeCtx;
    tdeeSection = `\n\nTDEE / Energy Balance:
- TDEE (maintenance): ${tdee} kcal
- Calories eaten: ${eaten} kcal
- Workout calories burned: ${workoutKcal} kcal
- Net intake (eaten - workout): ${netIntake} kcal
- Deficit vs TDEE: ${deficit > 0 ? '+' : ''}${deficit} kcal (positive = in deficit)
- Target weekly deficit to reach ${goal_weight}kg: ~${weeklyDeficitNeeded} kcal/day
- Current weight: ${weight_kg}kg, goal: ${goal_weight}kg

Analyze the deficit: was it enough, too little, or too aggressive? Give a specific recommendation — lower intake, increase activity, or stay course. Be direct, like a real coach.`;
  }
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 600, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `Write a concise end-of-day summary for this day's data:\n${dataStr}${tdeeSection}\n\nCover: macro numbers vs targets, training, recovery, energy balance verdict, one win, one specific actionable fix for tomorrow. End with a "prep for tomorrow:" line. 5–6 lines, plain text.` }],
  });
  return response.content[0].text;
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function generateEveningCheck(data, targetsContext = '', userProfile = {}) {
  const tdee = data.tdee;
  let tdeeNote = '';
  if (tdee) {
    const remaining = tdee.tdee - tdee.eaten;
    tdeeNote = ` TDEE is ${tdee.tdee} kcal; eaten ${tdee.eaten} kcal so far (${tdee.workoutKcal} kcal burned in workouts); currently ${remaining > 0 ? remaining + ' kcal under maintenance' : Math.abs(remaining) + ' kcal over maintenance'}.`;
  }
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 512, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `Generate a 7:30 PM check-in message. Data:\n${JSON.stringify(data)}\n\nShow: calories eaten/remaining vs target, protein status with specific suggestion if short, carbs/fat brief, caffeine flag if needed.${tdeeNote} Include any upcoming plans. Always include a pill reminder (user takes pills with dinner). End with a "prep for tomorrow:" line with one specific action. 4–5 lines max. Use plain text with emojis — no markdown stars or headers. Keep it conversational and direct.` }],
  });
  return response.content[0].text;
}

// ── Weekly review ─────────────────────────────────────────────────────────────

async function generateWeeklyReview(weekData, targetsContext = '') {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext),
    messages: [{ role: 'user', content: `Generate the weekly review. Data:\n${JSON.stringify(weekData, null, 2)}\n\nInclude: weight change, macro adherence %, training days, sleep avg, best/worst day, one main fix for this week, projected 80kg timeline.` }],
  });
  return response.content[0].text;
}

// ── Full analysis ─────────────────────────────────────────────────────────────

async function generateFullAnalysis(allData, targetsContext = '') {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 2048, system: buildCoachSystem(targetsContext),
    messages: [{ role: 'user', content: `Generate a comprehensive progress report since the beginning. Data:\n${JSON.stringify(allData, null, 2)}\n\nCover: total weight lost, weekly rate, BMI/BF change, calorie/protein adherence %, training frequency, sleep averages, best/worst week, projected 80kg date at current rate, top 3 working + top 3 to fix.` }],
  });
  return response.content[0].text;
}

// ── Proactive pattern check ───────────────────────────────────────────────────

async function checkProactivePatterns(recentData, targetsContext = '', userProfile = {}) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 256, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `You are a proactive health coach check. Analyze the data and decide if the user needs a nudge right now.\n\nData:\n${JSON.stringify(recentData)}\n\nWhat to look for (no hardcoded rules — use judgment):\n- Meal names in recentWeek/today revealing fast food, junk food, or poor choices building up over days\n- Protein consistently below target across multiple days\n- Calories over budget multiple days in a row\n- No workouts for several days\n- No food logged 4+ hours after waking (noMealsYet: true)\n- Caffeine over 400mg today or last_caffeine_time after 17:00\n\nContext rules:\n- recentAlerts contains what was already sent recently — if you flagged something yesterday and the pattern continues/worsens, re-alert with escalation ("still doing it" tone). If the user improved since the last alert, don't repeat it.\n- First offense of a pattern: warn. Repeated offense: call it out harder.\n- Only flag the single most important thing. Not multiple issues at once.\n- If nothing truly needs flagging: "OK"\n\nRespond with ONE direct, casual message (1–2 sentences, no markdown, no emojis from ** or ##). Or exactly "OK".` }],
  });
  const msg = response.content[0].text.trim();
  return msg === 'OK' ? null : msg;
}



// ── Golf ──────────────────────────────────────────────────────────────────────

const GOLF_SYSTEM = `You are Max's golf assistant. He's a beginner who recently played his first course round.

Equipment, distances, and focus areas from his Golf Profile are in context. Recent session history provided.

Rules:
- Encouraging but technically accurate
- ONE thing at a time — the single most impactful improvement
- Don't overcomplicate — he's a beginner
- Priorities: tee shots in play > avoiding big numbers > short game > course management
- Reference past sessions for patterns: "last month you sliced everything, now just the driver — that's progress"
- For coach sessions: help document and internalize thoroughly
- Casual tone`;

async function chatGolf(messages, golfHubContext = '', recentSessions = []) {
  const systemParts = [GOLF_SYSTEM];
  if (golfHubContext) systemParts.push(`\nGolf Profile:\n${golfHubContext}`);
  if (recentSessions.length) systemParts.push(`\nRecent sessions (last 3):\n${JSON.stringify(recentSessions, null, 2)}`);

  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: systemParts.join('\n'),
    messages,
  });
  return response.content[0].text;
}

const GOLF_SESSION_SYSTEM = `Parse a golf session log. Extract all available information.
Return ONLY JSON:
{
  "session_type": "Course Round" | "Range Practice" | "Coach Session",
  "location": null,
  "score": null,
  "holes": null,
  "duration_min": null,
  "focus_areas": "",
  "what_went_well": "",
  "what_to_improve": "",
  "coach_feedback": "",
  "notes": ""
}`;

async function parseGolfSession(text, sessionType) {
  const content = `Session type: ${sessionType}\n\n${text}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 512, system: GOLF_SESSION_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  return parseJSON(response.content[0].text) ?? {};
}

async function analyzeGolfPhoto(photoBase64, caption) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: GOLF_SYSTEM,
    messages: [{
      role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photoBase64 } },
        { type: 'text', text: caption || 'Analyze my golf stance/grip/swing.' },
      ],
    }],
  });
  return response.content[0].text;
}

module.exports = {
  classify,
  analyzeMeal, applyMealCorrection, parseTargetUpdate, recalculateTargets,
  parseWorkout, applyWorkoutCorrection, parseRecovery, parseSleep, parseBody,
  parseLiveExercise, generateWorkoutComparison, generateWeeklyStrengthSummary,
  parsePlans, parseTimeCorrection, parseCorrection,
  askCoach, askWithPhoto, continueCoachReply,
  generateDaySummary, generateEveningCheck, generateWeeklyReview,
  generateFullAnalysis, checkProactivePatterns,
  chatGolf, parseGolfSession, analyzeGolfPhoto,
  buildCoachSystem, matchEntryToDelete, matchPlanToModify,
  generateOnboardingTargets, translateText, parseStats, parseOnboardingInput,
};
