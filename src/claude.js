const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');
const { calculateTDEE, ageFromBirthday } = require('./utils/tdee');

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
- RECOVERY_LOG: logging sauna, cold plunge, ice bath, cold shower, stretching, foam rolling, mobility work, yoga, or any active recovery
- SLEEP_LOG: reporting a complete sleep session or nap with duration/times ("slept from 1am to 8am", "slept 6 hours", "went to bed at 2am woke at 9", "had a nap from 3-4pm"). NOT for just "woke up at X" alone — that's WAKE.
- WEIGHT_LOG: logging body weight or body fat
- BED: RIGHT NOW going to sleep — present intent only ("gn", "good night", "going to sleep", "heading to bed", "night", "спать", "спокойной ночи")
- WAKE: waking up, morning, first message, доброе утро
- PLAN: creating a plan, reminder, event, scheduling something
- PLAN_DONE: confirming a task is done
- PLAN_SKIP: skipping or postponing a plan
- CORRECTION: changing/fixing a previous log entry (time, values, etc.)
- DELETE: deleting/removing a log entry ("delete my chicken rice", "remove today's lunch", "delete that workout")
- UPDATE_TARGETS: explicitly setting nutrition targets to specific numbers ("change calorie target to 1800", "set protein to 200g", "update my macros to 1800/180/100/60", "yes update them", "yes do it", "apply those targets"). NOT for asking advice about targets or vague requests like "maybe we should change targets".
- CANCEL_REMINDER: cancel/turn off a reminder for a plan WITHOUT cancelling the plan ("не надо напоминать", "cancel the reminder", "don't remind me", "отмени напоминание", "no reminder needed")
- UPDATE_TIMEZONE: changing the user's timezone ("change my timezone", "set my time to UTC+3", "поменяй время", "I'm in Moscow")
- RENAME: renaming or relabeling a previously logged meal or workout entry ("rename my workout to X", "call that burger a big mac", "log that as golf workout")
- FULL_ANALYSIS: asking for a comprehensive all-time progress report or deep dive ("full analysis", "how am i doing overall", "progress report", "overview since beginning", "как мой прогресс", "покажи весь прогресс", "полный анализ", "общий отчёт", "как я прогрессирую")
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
"cancel" → ["GENERAL"]
"nevermind" → ["GENERAL"]
"change my lunch to 2pm" → ["CORRECTION"]
"maybe we should adjust my targets" → ["COACH_QUESTION"]
"i keep going over calories, can you suggest new targets?" → ["COACH_QUESTION"]
"yes update the targets to what you suggested" → ["UPDATE_TARGETS"]
"set calories to 1800 and protein to 180" → ["UPDATE_TARGETS"]
"weighed 104kg this morning" → ["WEIGHT_LOG"]
"rename my workout to golf workout" → ["RENAME"]
"please rename my workout Kettlebell Pull to Golf Workout" → ["RENAME"]
"call that burger a big mac" → ["RENAME"]
"log that as rokeby smoothie" → ["RENAME"]
"change Kettlebell Workout to Golf Workout" → ["RENAME"]
"30 min foam rolling and stretching" → ["RECOVERY_LOG"]
"did some mobility work" → ["RECOVERY_LOG"]
"yoga 30min" → ["RECOVERY_LOG"]

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
      'WEIGHT_LOG','BED','WAKE','PLAN','PLAN_DONE','PLAN_SKIP','CORRECTION','DELETE','UPDATE_TARGETS',
      'CANCEL_REMINDER','UPDATE_TIMEZONE','RENAME','FULL_ANALYSIS','COACH_QUESTION','GENERAL']);
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
  return (n >= 1 && n <= plans.length) ? plans[n - 1] : null;
}

// ── Entry matching for deletion ───────────────────────────────────────────────

async function matchEntryToDelete(userText, entries) {
  const list = entries.map((e, i) => `${i + 1}. [${e.label}] ${e.title}${e.extra ? ' — ' + e.extra : ''}`).join('\n');
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'Given a deletion request and a numbered list of log entries (ordered oldest first, newest last), reply ONLY with the number of the best match, or 0 if none clearly match.',
    messages: [{ role: 'user', content: `Request: "${userText}"\n\nEntries:\n${list}` }],
  });
  const n = parseInt(response.content[0].text.trim());
  return (n >= 1 && n <= entries.length) ? entries[n - 1] : null;
}

// ── Meal analysis ─────────────────────────────────────────────────────────────

const MEAL_SYSTEM = `You are an expert food analysis assistant with deep knowledge of Southeast Asian cuisine. The message may contain multiple logs (workouts, plans, etc) — extract ONLY the food/drink items. Output ONLY the JSON object below — no preamble, no explanation, no calculations shown.

ACCURACY RULES:
- Asian side dishes (banchan, vegetable sides): 30–80g, 20–60 kcal each
- Korean banchan: spinach namul ~30 kcal, bean sprouts ~15 kcal, kimchi 50g ~20 kcal
- Small Asian rice bowls: ~150–180g cooked rice = 200–240 kcal
- Soups/broths: mostly water, low calorie unless creamy
- Do NOT double-count items

KNOWN FOODS RULES (when a Known Foods section is provided):
- Known Foods are measured ground truth — always use those exact calorie/macro values
- If an Institution trigger keywords block is present above the Known Foods section: any message containing one of those keywords (case-insensitive) is an institution meal — treat with 100% confidence, match to Known Foods, use those exact macros. Apply retroactively if the keyword appears in a correction or follow-up.
- If no Institution trigger keywords block is present: do not apply any institution matching. Analyze the food normally from the photo or description.
- For all other cases: analyze the food as-is from the photo/description, match individual items to Known Foods entries where they clearly match, and use those macros; only adjust for portion size
- If you see an item that looks like a DIFFERENT food from what's in Known Foods (e.g., rice on plate but Known Foods shows pasta): set confidence="low", clarification="I see [what you see] on the plate but today's menu shows [known foods entry] — did they swap it? Tell me what to use."
- If an item has no match at all in Known Foods: set new_food=true, confidence="low", clarification="[item] isn't in today's database — what should I use for macros?"
- If the photo could plausibly not be an institution meal (restaurant plating, single dish, home-cooked style) and institution keywords were triggered: set confidence="low", clarification="Is this an institution meal? (yes/no)"
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

async function analyzeMeal(photoBase64OrArray, caption, dayOfWeek, knownFoodsContext, currentTime, institutionKeywords = null) {
  const content = [];
  const photos = Array.isArray(photoBase64OrArray) ? photoBase64OrArray : (photoBase64OrArray ? [photoBase64OrArray] : []);
  for (const photo of photos) {
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: photo } });
  }
  let text = caption || 'Analyze this meal.';
  if (currentTime) text += `\n\n${currentTime}`;
  if (dayOfWeek) text += `\nDay: ${dayOfWeek}`;
  if (institutionKeywords) {
    text += `\n\nInstitution trigger keywords: ${institutionKeywords}\nIf the user's message contains any of these keywords (case-insensitive), treat the meal as an institution meal with 100% confidence — match items to the Known Foods menu and use those exact macros.`;
  }
  if (knownFoodsContext) text += `\n\nKnown Foods:\n${knownFoodsContext}`;
  content.push({ type: 'text', text });

  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 2048, system: MEAL_SYSTEM,
    messages: [{ role: 'user', content }],
  });
  const parsed = parseJSON(response.content[0].text);
  if (!parsed) throw new Error(`Could not parse meal: ${response.content[0].text}`);
  parsed._hasPhoto = photos.length > 0;
  return parsed;
}

// ── Workout parsing ───────────────────────────────────────────────────────────

function buildWorkoutSystem(weight_kg) {
  if (!weight_kg) throw new Error('buildWorkoutSystem called without weight_kg');
  return `Parse the user's workout. The message may contain multiple logs (food, plans, etc) — extract ONLY the workout/exercise part.

Calories = MET × ${weight_kg}kg × hours. MET values:
- Running: 8.5, Rowing machine: 7.5, Cycling: 6.8, Swimming: 6.0, Tennis: 7.3, Golf walking: 4.3, Yoga: 2.5, Hiking: 6.0
- Circuit training (sustained, moving between exercises, any duration): MET 8.0 → activity_type: "circuit"
- HIIT (near-maximal intervals, short sessions <30 min): MET 10.0 → activity_type: "hiit"

For weight training, use density to pick MET (density = total_sets / duration_min):
- density > 0.4 (many exercises, short rest — superset style): MET 5.5
- density 0.25–0.4 (normal gym pace, moderate rest): MET 4.5
- density < 0.25 (long rests, heavy compound focus): MET 3.5
Example: 8 exercises × 3 sets = 24 sets in 40 min → density 0.60 → MET 5.5 → 5.5 × ${weight_kg} × (40/60) = ~${Math.round(5.5 * weight_kg * 40 / 60)} kcal

CIRCUIT ROUNDS: If the workout lists exercises under labeled rounds (Round 1, Round 2, etc.):
- Keep each exercise per round as a SEPARATE entry — do NOT collapse rounds or sum reps across rounds
- Each entry gets "round": <round_number>, "sets": 1, "reps": as stated for that round
- activity_type MUST be "circuit"
- duration_min = total stated time for all rounds (including any interval rounds)
- For rounds with different reps, each round is its own entry with its own reps value

TIMED INTERVALS: "4×30s" or "4 sets of 30 seconds":
- Use "duration_sec": 30, "sets": 4 — omit reps entirely
- For distance-based cardio ("250m rowing"): use "distance_m": 250 — omit reps
- These still get a "round" field if part of a round
- DURATION: always add interval round time on top of stated circuit time. Calculate: sets × (work_sec + rest_sec) / 60 per exercise, sum all interval exercises. Example: Round 4 has 4×30s rowing (30s rest) + 4×30s ski erg (30s rest) → 4×60/60 + 4×60/60 = 4+4 = 8 min extra. If user said "12 min for rounds 1-3", total duration_min = 12 + 8 = 20.

If duration is not stated, ESTIMATE from exercises:
- Count total_sets across all exercises
- ~2.5 min per set for strength; ~1.5 min per set for lighter/cardio
- duration_min = total_sets × 2.5 (round to nearest 5)
- Never leave calories_burned null when exercises are present

SETS/REPS RULES:
- "3x10" → sets=3, reps=10
- "60 deadlifts" (no sets) → sets=1, reps=60
- "30 each leg" → reps=30 (the stated per-side number)
- For timed/distance exercises, omit reps — use duration_sec or distance_m instead

If Known Custom Exercises are provided, use their typical values as defaults.

Time parsing: extract START time if mentioned ("8am" → "08:00", "8 to 10am" → "08:00"). 24h format. Omit if none.

Return ONLY JSON:
{
  "workout_name": "Upper Body Circuit",
  "activity_type": "circuit",
  "duration_min": 16,
  "calories_burned": 216,
  "time": "08:00",
  "exercises": [
    {"name": "Dumbbell Rows", "round": 1, "sets": 1, "reps": 10, "weight_kg": 15},
    {"name": "Rowing Machine", "round": 1, "distance_m": 250},
    {"name": "Dumbbell Rows", "round": 2, "sets": 1, "reps": 10, "weight_kg": 15},
    {"name": "Rowing Machine", "round": 2, "distance_m": 250},
    {"name": "Rowing Intervals", "round": 4, "sets": 4, "duration_sec": 30},
    {"name": "Ski Erg", "round": 4, "sets": 4, "duration_sec": 30}
  ],
  "exercises_summary": "3 rounds: rows 10@15kg, shoulder press 10@7.5kg... + round 4 intervals"
}`;
}

async function parseWorkout(text, knownExercisesCtx = '', weight_kg) {
  let content = text;
  if (knownExercisesCtx) content = `Known Custom Exercises:\n${knownExercisesCtx}\n\nWorkout: ${text}`;
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 1024, system: buildWorkoutSystem(weight_kg),
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

async function generateWorkoutComparison(comparisonBlock, userProfile = {}) {
  const exampleForStyle = WORKOUT_COMPARISON_EXAMPLES[userProfile.coaching_style] ?? WORKOUT_COMPARISON_EXAMPLES[2];
  const prompt = `Write a brief workout progress comment using the pre-computed comparison below. Each exercise shows its own previous date and workout name inline.

${comparisonBlock}

OUTPUT REQUIREMENTS:
- Open with 1 line matching the verdict tone: positive if mostly UP, honest if mostly FLAT or DOWN. You may naturally reference the previous dates shown inline.
- Then 1–2 sentences naming specific exercises by their tag: which went UP, which went FLAT, which went DOWN. Use the numbers from the block as-is — do not recompute.
- 2–3 sentences total. Casual, direct. No markdown.

GOOD EXAMPLE (calibrated to user's coaching style):
${exampleForStyle}`;
  const resp = await anthropic.messages.create({
    model: SONNET, max_tokens: 256,
    system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0].text.trim();
}

// ── Weekly strength/endurance summary ────────────────────────────────────────

async function generateWeeklyStrengthSummary(strengthBlock, userProfile = {}) {
  if (!strengthBlock || strengthBlock.startsWith('No workouts')) return null;
  const exampleForStyle = STRENGTH_SUMMARY_EXAMPLES[userProfile.coaching_style] ?? STRENGTH_SUMMARY_EXAMPLES[2];
  const prompt = `Write a weekly strength & endurance progress summary using the pre-computed data block below.

${strengthBlock}

OUTPUT REQUIREMENTS:
- 3–4 sentences, punchy, casual tone, no markdown.
- Lead with consistency: state this-week vs last-week session count.
- Name 1–2 specific exercises from the "Top exercises" list using their trend tag — call out a [UP +Xkg] as a win, a [DOWN -Xkg] or [FLAT] as the area to fix.
- Close with one specific opportunity (e.g. "push deadlifts up next week" or "add a 4th session").
- Use the numbers from the block as-is — do not recompute.

GOOD EXAMPLE (calibrated to user's coaching style):
${exampleForStyle}`;
  const resp = await anthropic.messages.create({
    model: SONNET, max_tokens: 384,
    system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return resp.content[0].text.trim();
}

// ── Recovery parsing ──────────────────────────────────────────────────────────

const RECOVERY_SYSTEM = `Parse recovery sessions from the message. Extract ONLY recovery content (ignore food, workouts, plans).

PROTOCOL RULES:
- "contrast" = alternating hot→cold cycles. Determine if UNIFORM (all rounds identical) or PER_ROUND (any round differs).
- "single" = one session or multiple sequential sessions, NOT alternating rounds.

UNIFORM contrast — all rounds identical — "3 rounds sauna 10min 100° + cold 3min 8°":
{"protocol": "contrast", "uniform": true, "rounds": 3, "sessions": [
  {"type": "Sauna",       "duration_min": 10, "temperature_c": 100, "sequence_order": 1},
  {"type": "Cold Plunge", "duration_min": 3,  "temperature_c": 8,   "sequence_order": 2}
]}

PER_ROUND contrast — rounds differ — "sauna 10min 100°, cold 10min 8°, sauna 10min 100°, cold 3min 9°, sauna 10min 100°, cold 3min 9°":
{"protocol": "contrast", "uniform": false, "rounds": [
  {"round_number": 1, "steps": [
    {"type": "Sauna",       "duration_min": 10, "temperature_c": 100, "sequence_order": 1},
    {"type": "Cold Plunge", "duration_min": 10, "temperature_c": 8,   "sequence_order": 2}
  ]},
  {"round_number": 2, "steps": [
    {"type": "Sauna",       "duration_min": 10, "temperature_c": 100, "sequence_order": 1},
    {"type": "Cold Plunge", "duration_min": 3,  "temperature_c": 9,   "sequence_order": 2}
  ]},
  {"round_number": 3, "steps": [
    {"type": "Sauna",       "duration_min": 10, "temperature_c": 100, "sequence_order": 1},
    {"type": "Cold Plunge", "duration_min": 3,  "temperature_c": 9,   "sequence_order": 2}
  ]}
]}

Single/sequential — "sauna 30min 100°C then cold plunge 10min 8°C":
{"protocol": "single", "rounds": 1, "sessions": [
  {"type": "Sauna",       "duration_min": 30, "temperature_c": 100, "sequence_order": 1},
  {"type": "Cold Plunge", "duration_min": 10, "temperature_c": 8,   "sequence_order": 2}
]}

Rules:
- Use EXACT temperatures. Never convert — 100°C stays 100°C, 8°C stays 8°C.
- Uniform: rounds = total round count. sessions = one cycle (one rep of all steps).
- Per-round: list every round in rounds array, even if most are identical.
- If ANY round differs in duration OR temperature from others → per_round.
- For single: sequence_order 1, 2, 3... for each step.
- temperature_c = null if not mentioned.
- Type must be exactly one of: "Sauna", "Cold Plunge", "Ice Bath", "Steam Room", "Massage", "Mobility", "Stretching", "Yoga", "Foam Rolling".

Return ONLY a JSON array:
[{"protocol": "...", ...}]`;

async function parseRecovery(text) {
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 512, system: RECOVERY_SYSTEM,
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
{"weight_kg": 104.2, "body_fat_pct": 28, "muscle_mass_kg": null, "notes": ""}
If a field is not mentioned, set it to null. muscle_mass_kg is lean/muscle mass in kg (from DEXA, InBody, etc.).`;

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

// Returns true if user is saying they have no plans (vs naming a plan/task)
async function isNoPlanResponse(text) {
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'User was asked "any plans for tomorrow?". Reply YES if they mean they have no plans (e.g. "no", "nah", "nothing", "free day", "all good"). Reply NO if they are describing a plan, task, or todo (regardless of how short or vague).',
    messages: [{ role: 'user', content: text }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
}

async function isPositiveResponse(text) {
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'User was asked if they want to apply suggested target changes. Reply YES if their message is any form of agreement, confirmation, or positive response. Reply NO if they are declining, asking questions, or saying something unrelated.',
    messages: [{ role: 'user', content: text }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
}

async function isConfirmIntent(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (/^(ok|okay|k|yes|yep|yup|y|sure|go|do it|log it|log|confirm|✅|👍|да|ок|окей|хорошо|ладно|давай|записывай|логируй|запиши|сохрани|подтверждаю)$/i.test(t)) return true;
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'User was asked to confirm or save something. Reply YES if their message is any form of agreement or confirmation in any language. Reply NO if they decline, want to edit or change something, ask a question, or say something unrelated.',
    messages: [{ role: 'user', content: t }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
}

async function isDeclineIntent(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (/^(no|nope|n|cancel|stop|skip|abort|нет|отмена|отменить|не\s+надо|неважно|пропусти)$/i.test(t)) return true;
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'User was asked to do something. Reply YES if their message is any form of refusal, cancellation, or wanting to skip/stop in any language. Reply NO if they agree, ask a question, or say something unrelated.',
    messages: [{ role: 'user', content: t }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
}

async function isDoneIntent(text) {
  if (!text) return false;
  const t = String(text).trim();
  if (/^(done|finished|finish|end|that'?s?\s*(it|all)|all done|all good|nothing|none|no|nah|nope|skip|готово|закончил|завершил|всё|все|хватит|ничего|нет)$/i.test(t)) return true;
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 10,
    system: 'User is in a multi-step flow and was asked if they are finished. Reply YES if their message means they are done/finished/completed or have nothing more to add, in any language. Reply NO if they are still going, logging more items, or saying something unrelated.',
    messages: [{ role: 'user', content: t }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
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

If the user explicitly states all four values (calories, protein, carbs, fat), use them exactly as given — do not recalculate or adjust.
If only some values are given, adjust the remaining ones to stay coherent (protein: 4 kcal/g, carbs: 4 kcal/g, fat: 9 kcal/g).
Return ONLY JSON: {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 128,
    system: 'You are a nutrition target calculator. Apply the requested change and recalculate all macros to stay coherent. Return only JSON.',
    messages: [{ role: 'user', content: prompt }],
  });
  return parseJSON(response.content[0].text);
}

// ── Coach system prompt ───────────────────────────────────────────────────────

const STYLE_TONE = {
  1: `Style 1 (gentle):
- Soften failure framing: "landed heavier than the target", "a bit higher than aimed", "shy of"
- Acknowledge effort and wins on every day, even bad ones
- End with forward-looking encouragement ("fresh start", "small win", "tomorrow's a new chance")
- Frame fixes as opportunities, not failures
- Use warm, supportive tone throughout`,
  2: `Style 2 (direct):
- State facts plainly. No softening verbs, no hedging.
- Acknowledge wins ONCE if they exist. Don't dwell.
- Use "Win:" and "Fix:" labels on summaries where appropriate.
- Don't moralize. Just call it.`,
  3: `Style 3 (max):
- No softening. Name failures plainly: "write-off", "over by X", "blew the cap"
- Skip win acknowledgments on bad days. Sleep being good doesn't redeem food choices.
- Call out behavior patterns the data reveals (e.g. specific food choices that broke the day)
- Direct and short. Cut hedge words.
- Critical rule: call out choices, not character. Never insult the user as a person.`,
};

function buildCoachSystem(targetsContext = '', coachingStyle = 2, language = 'en', userName = null, userProfileText = '') {
  const name = userName || 'the user';
  const styleLine = STYLE_TONE[coachingStyle] || STYLE_TONE[2];
  const langLine = language && language !== 'en' ? `\nRespond in ${language}. All messages must be in ${language}.` : '';
  const profileSection = userProfileText ? `\n${name}'s behavioral profile (observed patterns over time):\n${userProfileText}\n` : '';
  return `You are ${name}'s personal health coach. Always completely honest.${langLine}

Tone: ${styleLine}

${targetsContext ? `${name}'s current targets and profile:\n${targetsContext}\n` : ''}${profileSection}
Rules:
- SPECIFIC. "Need 40g more protein — chicken breast or double scoop shake" not "eat more protein."
- Daily messages: 3–5 sentences. Weekly reviews can be longer.
- Track TRENDS. "Protein low 4 days straight" > "protein was low today."
- No medical disclaimers unless warranted.
- Casual tone, like a knowledgeable friend.
- Practical, actionable answers.
- Plans: "You said you'd do this. Now do it."
- The context injected at the start of each message contains LIVE DATABASE STATE — always use those numbers for today's totals. Conversation history may contain outdated figures; the context is always authoritative.
- If asked about nutrition/workouts/progress and you have data in context, analyze it directly. If truly no data at all is available, ask the user to share what's missing.
- When user asks what's for lunch/dinner: scan the Known Foods section for entries appropriate to that meal time and list them clearly.
- For general nutrition questions (calories in X, macros of Y, can I eat Z): answer directly from your own knowledge. Never say "it's not in your known foods" or refuse to answer — Known Foods is only for logging accuracy, not a limit on what you can discuss.
- Never reference the conversation or context mechanics. Don't say "based on your previous message", "from our conversation", "as mentioned earlier", "given what you said". Just answer naturally as if it's a continuous conversation — the user knows what they asked.
- All durations must be formatted as Xh Ym (e.g. 7h 36m, 1h 5m). Never use decimal hours (7.5h, 7.1h) anywhere in responses.
FORMATTING:
- Each distinct thought or topic goes on its own line. Never run multiple unrelated points into one sentence.
- Emojis mark the start of a new line/thought — one emoji per line, at the beginning. Never mid-sentence.
- Plans and reminders: one item per line, no commas joining them.
- Use a blank line to separate clearly different sections (food vs workout vs sleep vs tomorrow).
EMOJI USE:
- Match emoji sentiment to the sentiment of the line they're on.
- 💪🔥⚡ = genuine wins only (target hit, training milestone, streak)
- ⚠️🛑 = warnings, overages, things to fix
- 😴🥩☕💊 = neutral descriptors (sleep, food types, drinks, reminders)
- Never use 💪🔥⚡ on lines reporting failure or overage
- Use sparingly. One emoji per 2-3 lines is plenty.
- Telegram plain text. No markdown stars, no headers.`;
}

// ── Onboarding: Opus-powered target generation ────────────────────────────────

async function generateOnboardingTargets(stats) {
  const { name, weight_kg, height_cm, age, gender, goal, goal_weight, body_fat_pct, activity_level, gym_days, language } = stats;
  const resolvedAge = typeof age === 'number' ? age : ageFromBirthday(age);

  // All numbers computed deterministically — no LLM arithmetic
  const tdee = calculateTDEE(weight_kg, height_cm, resolvedAge, gym_days ?? 0, activity_level ?? 2, gender || 'male');
  const calories = goal === 'lose' ? tdee - 500 : goal === 'gain' ? tdee + 350 : tdee;
  const protein  = Math.round((weight_kg * 2.1) / 5) * 5;
  const fat      = Math.round((weight_kg * 0.9) / 5) * 5;
  const carbs    = Math.round(((calories - protein * 4 - fat * 9) / 4) / 5) * 5;

  const activityDesc = ['', 'sedentary', 'lightly active', 'moderately active', 'very active'][activity_level] || 'moderately active';
  const langInstr = language && !/^en(glish)?$/i.test(language.trim()) ? `Write in ${language}.` : '';
  const prompt = `Write a 2-3 sentence explanation for ${name}'s personalized nutrition plan. Friendly, plain language — like a knowledgeable friend, no jargon or abbreviations.

Their stats: ${resolvedAge}yo ${gender || 'male'}, ${weight_kg}kg, ${height_cm}cm, ${activityDesc}, ${gym_days ?? 0} gym days/week.
Goal: ${goal === 'lose' ? `lose weight (target ${goal_weight}kg)` : goal === 'gain' ? `gain muscle (target ${goal_weight}kg)` : 'maintain weight / recomp'}.
Their plan: ${calories} kcal/day (maintenance is ${tdee} kcal, ${goal === 'lose' ? '500 kcal deficit' : goal === 'gain' ? '350 kcal surplus' : 'at maintenance'}), ${protein}g protein, ${carbs}g carbs, ${fat}g fat.

Explain why these numbers make sense for their goal. ${langInstr}
Return ONLY valid JSON: {"explanation": "..."}`;

  const OPUS = 'claude-opus-4-7';
  const langSystem = language && !/^en(glish)?$/i.test(language.trim()) ? ` Respond in ${language}.` : '';
  const response = await anthropic.messages.create({
    model: OPUS, max_tokens: 300,
    system: `You are a friendly health coach writing a short plan explanation.${langSystem}`,
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = parseJSON(response.content[0].text);
  return { calories, protein, carbs, fat, tdee, explanation: parsed?.explanation ?? '' };
}

async function parseOnboardingInput(step, text) {
  const schemas = {
    birthday:      'Extract birth date. Return: {"date": "YYYY-MM-DD"} or {"date": null}',
    goal:          'Fitness goal: 1 or "lose weight/cut" → "lose", 2 or "gain muscle/bulk" → "gain", 3 or "maintain/recomp" → "maintain", 4 or "habits/track" → "habits". Return: {"goal": "lose"|"gain"|"maintain"|"habits"|null}',
    body_fat:      'Body fat % and/or muscle/lean mass in kg. User may skip or say unknown. Return: {"body_fat": number|null, "muscle_mass_kg": number|null}',
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
    model: HAIKU,
    max_tokens: 1000,
    system: `You are a native ${language} speaker texting a friend. Rewrite the message naturally in ${language} — casual, direct, how a real person would say it. Not word-for-word translation. Preserve emojis, numbers, line breaks, and list structure. Return ONLY the rewritten text, nothing else.`,
    messages: [{ role: 'user', content: text }],
  });
  return resp.content[0].text.trim();
}

async function translateToEnglish(text) {
  const resp = await anthropic.messages.create({
    model: HAIKU,
    max_tokens: 500,
    system: 'Translate the message to English. Return ONLY the English translation, nothing else.',
    messages: [{ role: 'user', content: text }],
  });
  return resp.content[0].text.trim();
}

// ── Coach Q&A ─────────────────────────────────────────────────────────────────

async function askCoach(question, context = '', targetsContext = '', knownFoodsContext = '', userProfile = {}) {
  let userContent = context ? `${context}\n\nQuestion: ${question}` : question;
  if (knownFoodsContext) userContent = `Known foods for today:\n${knownFoodsContext}\n\n${userContent}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name, userProfile.user_profile),
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

async function continueCoachReply(messages, targetsContext = '', userProfile = {}) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name, userProfile.user_profile),
    messages,
  });
  return response.content[0].text;
}

// ── Recovery display helper ────────────────────────────────────────────────────

function formatRecoveryRows(rows) {
  const contrastGroups = {};
  const singles = [];
  for (const r of rows) {
    if (r.protocol === 'contrast' && r.protocol_id) {
      if (!contrastGroups[r.protocol_id]) contrastGroups[r.protocol_id] = [];
      contrastGroups[r.protocol_id].push(r);
    } else {
      singles.push(r);
    }
  }
  const parts = [];
  for (const group of Object.values(contrastGroups)) {
    const isPerRound = group.some(r => r.round_number != null);
    if (isPerRound) {
      const roundMap = {};
      for (const r of group) {
        if (!roundMap[r.round_number]) roundMap[r.round_number] = [];
        roundMap[r.round_number].push(r);
      }
      const totalRounds = Object.keys(roundMap).length;
      const roundStrs = Object.entries(roundMap)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([rn, steps]) => {
          const sorted = steps.sort((a, b) => a.sequence_order - b.sequence_order);
          return `R${rn}: ${sorted.map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_per_round_min}min`).join('→')}`;
        });
      parts.push(`Contrast therapy ${totalRounds} rounds (variable): ${roundStrs.join(', ')}`);
    } else {
      const sorted = group.sort((a, b) => a.sequence_order - b.sequence_order);
      const totalRounds = sorted[0].rounds;
      const steps = sorted.map(s => `${s.type.toLowerCase()}${s.temperature_c ? ` ${s.temperature_c}°C` : ''} ${s.duration_per_round_min}min`).join('→');
      parts.push(`Contrast therapy ${totalRounds} rounds (${steps})`);
    }
  }
  for (const r of singles) {
    parts.push(`${r.type}${r.rounds > 1 ? ` ${r.rounds}×${r.duration_per_round_min}min` : ` ${r.total_duration_min}min`}${r.temperature_c ? ` @${r.temperature_c}°C` : ''}`);
  }
  return parts;
}

// ── Per-style examples ────────────────────────────────────────────────────────

const DAY_SUMMARY_EXAMPLES = {
  1: `"Today landed heavier than the target — 2567 cal vs 1800, with fat (137g) and carbs (183g) higher than aimed. Protein 21g short. Sleep was great at 8h 6m quality 4 — keep that going. Tomorrow's a fresh start.
prep for tomorrow: pick a lighter lunch."`,
  2: `"Heavy fat and carbs day — 137g vs 60g, 183g vs 110g, calories 2567 vs 1800. Protein 21g short. Sleep was good. Win: 35min circuit 💪. Fix: cut cooking fats.
prep for tomorrow: pick a low-fat lunch."`,
  3: `"Today was a write-off. Fat at 137g — more than double the 60g target. Carbs 73g over. Calories 767 above your cap, the workout barely dented it. Protein 21g short on top. Sleep was the one bright spot. Fix: dumplings plus double-protein NS don't fit a 1800 cap.
prep for tomorrow: low-fat lunch, no exceptions."`,
};

const EVENING_CHECK_EXAMPLES = {
  1: `"233 kcal still on the table for today. Protein landed at 149 — about 21g shy of 170. A chicken breast or shake would close that nicely 🥩. Fat and carbs ran a bit high today. 💊 reminder: evening pills with dinner.
prep for tomorrow: a lighter lunch will help."`,
  2: `"233 kcal left vs your 1800 target — already at 2567 ⚠️. Protein 21g short (149/170) — chicken breast or a shake closes it. Fat over at 137g vs 60g, carbs over at 183g. 💊 evening pills with dinner.
prep for tomorrow: pick a low-fat lunch option."`,
  3: `"You're 767 over your 1800 cap and it's only 7:30pm ⚠️. Protein still 21g short (149/170) — chicken breast or shake, now. Fat at 137g, more than double the 60g target. Carbs over by 73g. 💊 pills with dinner.
prep for tomorrow: low-fat lunch, no exceptions."`,
};

const STRENGTH_SUMMARY_EXAMPLES = {
  1: `"Good week in the gym — squats crept up to 100kg for 4×8, which is a nice step from 95kg last time. Pull volume held steady. The big opportunity is bench press — it's been flat for three sessions, so a small deload and reset might unlock the next jump. Keep the consistency going 💪"`,
  2: `"Squat up to 100kg 4×8 — solid gain from 95kg. Pull volume consistent. Bench flat three sessions in a row — deload or technique check needed. Win: lower body progress. Fix: break the bench plateau."`,
  3: `"Squats moved — 100kg 4×8, up from 95kg. Everything else held or stalled. Bench has gone nowhere for three sessions; that's a plateau. Pick a weight, reset, and move it next week."`,
};

const WORKOUT_COMPARISON_EXAMPLES = {
  1: `"Nice progress since your last legs session on Mon 5 May — squats went from 90kg to 100kg, which is a meaningful jump. Leg press held steady at 120kg. Romanian deadlifts were a touch lighter today, but overall a stronger session 💪"`,
  2: `"Solid step up from your Mon 5 May legs session. Squats: 90kg → 100kg. Leg press: flat at 120kg. RDLs: down 5kg. Net: better session."`,
  3: `"Up from Mon 5 May. Squats 90 → 100kg — that's the win. Leg press flat. RDLs dropped 5kg — don't let that slide next time. One step forward, one sideways."`,
};

// ── Day summary ───────────────────────────────────────────────────────────────

async function generateDaySummary({ dataSummary, exampleForStyle }, userProfile = {}) {
  const prompt = `Write the end-of-day summary using the data below. Only state facts present in this block — if a section is missing or marked "not logged", skip it. Do not infer or invent.

${dataSummary}

OUTPUT REQUIREMENTS:
- Each distinct point on its own line. No run-on paragraphs.
- Emojis at the start of the line they belong to, never mid-sentence.
- Mention every macro line marked "(flag)" — state the actual number and the target.
- Skip macros not flagged.
- If sleep is "not logged", skip the sleep mention entirely. Otherwise comment briefly on it.
- If workouts section says "none", mention no training today. Otherwise name the type and duration or kcal burned.
- Close with one line starting "prep for tomorrow:" plus one specific action.
- 5–7 lines total.

GOOD EXAMPLE (calibrated to the user's coaching style):
${exampleForStyle}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 600, system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text;
}

// ── Evening check ─────────────────────────────────────────────────────────────

async function generateEveningCheck({ dataSummary, exampleForStyle }, userProfile = {}) {
  const prompt = `Generate a 7:30 PM check-in using the data below. Only state facts present in this block — if a section is missing, skip it. Do not infer.

${dataSummary}

OUTPUT REQUIREMENTS:
- Each distinct point on its own line. No run-on paragraphs.
- Emojis at the start of the line they belong to, never mid-sentence.
- Lead with calories remaining vs target (exact numbers).
- Mention every macro line marked "(flag)" with the actual number and target. For protein specifically — if flagged as UNDER — give one concrete suggestion to close the gap (e.g. "chicken breast or a shake").
- If caffeine is marked "[flag]", mention it briefly.
- If "User reminders" section is present, each reminder on its own line.
- If "Upcoming plans" section is present, each plan on its own line. Do not add speculation.
- Close with one line starting "prep for tomorrow:" + one specific action.
- 4–6 lines total.
- Do not invent historical patterns ("4 days in a row…") — you only have today's data.

GOOD EXAMPLE (calibrated to the user's coaching style):
${exampleForStyle}`;
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 512, system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text;
}

// ── Weekly review ─────────────────────────────────────────────────────────────

function buildWeekSummary(weekData, targets) {
  const t = targets || {};
  const bodyLogs  = weekData.bodyLogs ?? [];
  const dailyTotals = weekData.dailyTotals ?? {};

  // Weight & body fat
  const startWeight = bodyLogs[0]?.weight_kg ?? null;
  const endWeight   = bodyLogs[bodyLogs.length - 1]?.weight_kg ?? null;
  const weightDelta = (startWeight != null && endWeight != null && bodyLogs.length > 1)
    ? +(endWeight - startWeight).toFixed(1) : null;
  const startBF = bodyLogs[0]?.body_fat_pct ?? null;
  const endBF   = bodyLogs[bodyLogs.length - 1]?.body_fat_pct ?? null;
  const bfDelta = (startBF != null && endBF != null && bodyLogs.length > 1)
    ? +(endBF - startBF).toFixed(1) : null;

  const weightSection = [
    `Weight:   ${endWeight != null ? endWeight + 'kg' : 'not logged'}`,
    `          ${weightDelta !== null ? (weightDelta > 0 ? `+${weightDelta}` : `${weightDelta}`) + 'kg this week' : 'no delta (single or no weigh-in)'}`,
    `Body fat: ${endBF != null ? endBF + '%' : 'not logged'}`,
    `          ${bfDelta !== null ? (bfDelta > 0 ? `+${bfDelta}` : `${bfDelta}`) + '% this week' : 'no delta'}`,
  ].join('\n');

  // Macro adherence
  const mealDays   = Object.entries(dailyTotals).map(([date, d]) => ({ date, ...d }));
  const loggedDays = mealDays.filter(d => d.calories > 0);
  const n = loggedDays.length;

  let macroSection;
  if (n === 0) {
    macroSection = 'Macro adherence: no food logged this week';
  } else {
    const sum = key => loggedDays.reduce((s, d) => s + (d[key] ?? 0), 0);
    const avgCalories = Math.round(sum('calories') / n);
    const avgProtein  = Math.round(sum('protein')  / n);
    const avgCarbs    = Math.round(sum('carbs')    / n);
    const avgFat      = Math.round(sum('fat')      / n);
    const onTarget = (key, tKey) =>
      (n && t[tKey]) ? Math.round(loggedDays.filter(d => d[key] >= t[tKey]).length / n * 100) : null;
    const calFlag  = t.calories && avgCalories > t.calories ? 'OVER'  : 'OK';
    const protFlag = t.protein  && avgProtein  < t.protein  ? 'UNDER' : 'OK';
    macroSection = [
      `Macro adherence (${n} days logged):`,
      `- Calories: avg ${avgCalories} / ${t.calories ?? '?'} kcal  [${calFlag}]`,
      `            on-target ${onTarget('calories', 'calories') ?? '?'}% of days`,
      `- Protein:  avg ${avgProtein}g / ${t.protein ?? '?'}g       [${protFlag}]`,
      `            on-target ${onTarget('protein', 'protein') ?? '?'}% of days`,
      `- Carbs:    avg ${avgCarbs}g / ${t.carbs ?? '?'}g`,
      `- Fat:      avg ${avgFat}g / ${t.fat ?? '?'}g`,
    ].join('\n');
  }

  // Training
  const workouts = weekData.workouts ?? [];
  const trainingLines = workouts.length
    ? workouts.map(w => `  - ${w.workout_name}, ${w.duration_min ?? '?'}min, ${w.calories_burned ?? '?'}kcal`).join('\n')
    : '  none';
  const trainingSection = `Training: ${workouts.length} session(s) this week\n${trainingLines}`;

  // Sleep
  const fmtH = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}h ${m % 60}m`; };
  const sleepSection = [
    'Sleep:',
    `- Average: ${weekData.avgSleep != null ? fmtH(weekData.avgSleep) : 'not logged'}`,
    `- Quality: ${weekData.avgSleepQuality != null ? weekData.avgSleepQuality + ' / 5' : 'not logged'}`,
  ].join('\n');

  // Projected goal timeline
  let goalSection = null;
  if (t.goal_weight != null && endWeight != null) {
    const kgRemaining = +(t.goal_weight - endWeight).toFixed(1);
    let projection;
    if (weightDelta === null || weightDelta === 0) {
      projection = 'holding steady — no rate to project from';
    } else if (Math.sign(weightDelta) !== Math.sign(kgRemaining)) {
      projection = 'moving away from goal this week';
    } else {
      const weeksToGoal = Math.round(Math.abs(kgRemaining / weightDelta));
      const projDate = new Date();
      projDate.setDate(projDate.getDate() + weeksToGoal * 7);
      projection = `~${projDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })} at current rate (${weeksToGoal} weeks)`;
    }
    const kgToGoStr = Math.abs(kgRemaining) < 0.1
      ? 'at goal'
      : kgRemaining < 0
        ? `${Math.abs(kgRemaining).toFixed(1)}kg to lose`
        : `${kgRemaining.toFixed(1)}kg to gain`;
    goalSection = [
      `Goal: ${t.goal_weight}kg (currently ${endWeight}kg, ${kgToGoStr})`,
      `Projected: ${projection}`,
    ].join('\n');
  }

  // Target alignment
  let adjustmentFlag = 'insufficient data';
  if (weightDelta !== null && t.tdee) {
    const dailyDelta = t.calories - t.tdee;
    const expectedWeeklyKg = +(dailyDelta * 7 / 7700).toFixed(2);
    adjustmentFlag = Math.abs(weightDelta - expectedWeeklyKg) > 0.3
      ? `DIVERGED — expected ${expectedWeeklyKg}kg, actual ${weightDelta}kg`
      : 'ON TRACK';
  }

  // Best / worst day
  let bestWorstSection = 'Best/worst day: insufficient data (no food logged)';
  if (loggedDays.length > 0) {
    const bestDay  = loggedDays.reduce((a, b) => a.protein > b.protein ? a : b);
    const worstDay = loggedDays.reduce((a, b) =>
      (a.calories - (t.calories ?? 0)) > (b.calories - (t.calories ?? 0)) ? a : b);
    bestWorstSection = [
      `Best day:  ${bestDay.date} — ${bestDay.protein}g protein`,
      `Worst day: ${worstDay.date} — ${worstDay.calories} kcal (${worstDay.calories - (t.calories ?? 0)} over target)`,
    ].join('\n');
  }

  return [
    weightSection,
    macroSection,
    trainingSection,
    sleepSection,
    ...(goalSection ? [goalSection] : []),
    `Target alignment: ${adjustmentFlag}`,
    bestWorstSection,
  ].join('\n\n');
}

async function generateWeeklyReview(weekData, targetsContext = '', userProfile = {}, targets = {}) {
  const summary = buildWeekSummary(weekData, targets);
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 1024, system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `Write the weekly review using the pre-computed data block below.\n\n${summary}\n\nOUTPUT REQUIREMENTS:\n- Open with weight change and goal progress (use the Weight section).\n- Cover macro adherence using the flagged lines only: mention avg vs target and on-target % for any macro marked OVER or UNDER. Skip macros with no flag.\n- State training days count and name each session.\n- State sleep average in Xh Ym format and quality score. Never use decimal hours.\n- Call out best day and worst day using the pre-labeled values.\n- State one specific fix for the coming week.\n- If Target alignment says DIVERGED: suggest a concrete target adjustment (use the divergence numbers given) and end with "want me to update your targets?"\n- If Target alignment says ON TRACK or insufficient data: omit the target adjustment offer.\n- Length: 8-12 sentences. No markdown. Casual, direct tone.` }],
  });
  return response.content[0].text;
}

// ── Full analysis ─────────────────────────────────────────────────────────────

async function generateFullAnalysis(analysisBlock, targetsContext = '', userProfile = {}) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 2048,
    system: buildCoachSystem(targetsContext, userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `Write a comprehensive all-time progress report using the pre-computed block below.

${analysisBlock}

OUTPUT REQUIREMENTS:
- Open with the headline: period covered + weight change (use the Body composition section).
- Cover each section present in the block in order: body composition, goal projection (if present), nutrition adherence, training, sleep.
- Use the numbers from the block as-is — do not recompute.
- After the data narrative, give "Top 3 working" + "Top 3 to fix" — derive these qualitatively from the data shown.
- Casual tone, no markdown headers, plain Telegram text.
- Length: 10–14 sentences total.` }],
  });
  return response.content[0].text;
}

// ── Proactive pattern check ───────────────────────────────────────────────────

async function checkProactivePatterns(dataBlock, userProfile = {}) {
  const response = await anthropic.messages.create({
    model: SONNET, max_tokens: 256,
    system: buildCoachSystem('', userProfile.coaching_style, userProfile.language, userProfile.name),
    messages: [{ role: 'user', content: `Decide if the user needs a proactive nudge right now, based on the pre-computed data block below.

${dataBlock}

DECISION RULES (positive, in priority order):
- Flag the single most important issue marked [FLAG] in the block. If multiple, pick the most actionable one.
- Match each [FLAG] to a category: "macros" (calories/protein/carbs/fat), "caffeine", "meals" (missing), "workouts" (none), or "sleep".
- If "Today's nudge already sent" appears: that category is closed for today. Only flag a different category.
- For tone calibration: if a similar issue appears in "Recent assistant messages" from prior days, escalate tone for a repeat ("still doing it"). If no prior message on this category, first-offense tone.
- If no [FLAG] appears anywhere in the block: respond exactly "OK".

OUTPUT:
- One direct sentence (max two). Casual. No markdown.
- Or exactly "OK" if nothing needs flagging.` }],
  });
  const msg = response.content[0].text.trim();
  return msg === 'OK' ? null : msg;
}


async function parseRenameIntent(text, recentLogs = []) {
  const logsCtx = recentLogs.length
    ? `\n\nRecent logged entries (id, type, name):\n${recentLogs.map(e => `- id:${e.id} [${e.type}] "${e.name}"`).join('\n')}`
    : '';
  const response = await anthropic.messages.create({
    model: HAIKU, max_tokens: 120,
    messages: [{ role: 'user', content: `The user wants to rename a logged meal or workout entry. Given their message and the recent log entries, identify which entry they mean and what to rename it to.\n\nReturn JSON: {"entry_id": number or null, "new_name": string}. entry_id is the id of the matching log entry (null if you can't determine it from the list).${logsCtx}\n\nMessage: ${text}` }],
  });
  try {
    const match = response.content[0].text.match(/\{[\s\S]*?\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch { return null; }
}

// ── Conversation continuation check ──────────────────────────────────────────

async function isConversationContinuation(newMessage, previousSummary) {
  const resp = await anthropic.messages.create({
    model: SONNET, max_tokens: 5,
    system: `A user just sent a new message. You have a summary of their most recent conversation with a health coach.
Reply YES only if the previous conversation provides direct, specific context that meaningfully changes how you'd answer the new message — for example, a recommendation you made, a problem they described, or a decision that was reached.
Reply NO if the connection is only superficial (both mention food, both mention health) or if the previous conversation is on a clearly different topic.
Think like a human coach: would you actually reference the previous conversation when answering this new question, or would you just answer it fresh?`,
    messages: [{ role: 'user', content: `Previous conversation summary:\n${previousSummary}\n\nNew message: "${newMessage}"` }],
  });
  return resp.content[0].text.trim().toUpperCase().startsWith('Y');
}

// ── Conversation summary + user profile update ────────────────────────────────

async function summarizeConversation(messages) {
  const text = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 150,
    system: 'Summarize this health coaching conversation in 1-2 sentences. Focus on what was asked and what conclusion was reached. Be specific — include numbers or topics discussed.',
    messages: [{ role: 'user', content: text }],
  });
  return resp.content[0].text.trim();
}

async function updateUserProfile(conversationText, currentProfile) {
  const resp = await anthropic.messages.create({
    model: HAIKU, max_tokens: 800,
    system: `You maintain a behavioral profile for a health app user. The profile has two sections:

ACTIVE: Persistent patterns, habits, preferences, tendencies, challenges. Max 10 bullets. Be specific ("skips breakfast on workdays" not "sometimes skips meals").
RESOLVED: Patterns the user has overcome, each with approximate timeframe.

Rules:
- Only add to ACTIVE if the conversation reveals a clear, repeated pattern or meaningful preference — not a one-time question or thing already tracked in the database (weight, specific meals, targets)
- Move ACTIVE items to RESOLVED when the conversation shows the user overcame an issue
- Remove or refine ACTIVE items contradicted by new information
- Good candidates: behavioral tendencies, food preferences/aversions, motivation style, recurring struggles, workout habits, social patterns affecting food
- Bad candidates: one-time questions, specific log entries, things already in the DB
- Keep total under 600 tokens
- If nothing meaningful to update, return the profile unchanged

Return the updated profile in exactly this format:
ACTIVE:
- [observations]

RESOLVED:
- [approx timeframe]: [what was overcome]`,
    messages: [{ role: 'user', content: `Current profile:\n${currentProfile || '(empty — new user)'}\n\nConversation to process:\n${conversationText}` }],
  });
  return resp.content[0].text.trim();
}

module.exports = {
  classify, parseRenameIntent,
  analyzeMeal, applyMealCorrection, parseTargetUpdate, recalculateTargets,
  parseWorkout, applyWorkoutCorrection, parseRecovery, parseSleep, parseBody,
  parseLiveExercise, generateWorkoutComparison, generateWeeklyStrengthSummary,
  parsePlans, isNoPlanResponse, isPositiveResponse, isConfirmIntent, isDeclineIntent, isDoneIntent, parseTimeCorrection, parseCorrection,
  askCoach, askWithPhoto, continueCoachReply,
  generateDaySummary, generateEveningCheck, generateWeeklyReview, buildWeekSummary, formatRecoveryRows,
  DAY_SUMMARY_EXAMPLES, EVENING_CHECK_EXAMPLES, STRENGTH_SUMMARY_EXAMPLES, WORKOUT_COMPARISON_EXAMPLES,
  generateFullAnalysis, checkProactivePatterns, summarizeConversation, updateUserProfile,
buildCoachSystem, matchEntryToDelete, matchPlanToModify,
  generateOnboardingTargets, translateText, translateToEnglish, parseStats, parseOnboardingInput,
  isConversationContinuation,
};
