const { Client } = require('@notionhq/client');
const config = require('./config');
const { getMalaysiaISO, getMalaysiaDateStr, getDayOfWeek, getTodayRange, tsToISO, buildTimeISO, buildDateTimeISO } = require('./utils/time');

const notion = new Client({ auth: config.notion.token });

// ── Notion write queue (max 3 req/sec) ────────────────────────────────────────
const _queue = [];
let _running = false;

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    _queue.push({ fn, resolve, reject });
    if (!_running) _processQueue();
  });
}

async function _processQueue() {
  _running = true;
  while (_queue.length) {
    const { fn, resolve, reject } = _queue.shift();
    try { resolve(await fn()); } catch (e) { reject(e); }
    if (_queue.length) await new Promise(r => setTimeout(r, 350));
  }
  _running = false;
}

// ── Block helpers ─────────────────────────────────────────────────────────────

function rt(text) { return [{ type: 'text', text: { content: String(text ?? '') } }]; }
function block(type, content) { return { object: 'block', type, [type]: content }; }
const divider = { object: 'block', type: 'divider', divider: {} };
const h2     = (t) => block('heading_2', { rich_text: rt(t) });
const h3     = (t) => block('heading_3', { rich_text: rt(t) });
const para   = (t) => block('paragraph', { rich_text: rt(t) });
const bullet = (t) => block('bulleted_list_item', { rich_text: rt(t) });
const numbered = (t) => block('numbered_list_item', { rich_text: rt(t) });

function callout(text, emoji = '💡', color = 'gray_background') {
  return { object: 'block', type: 'callout', callout: { rich_text: rt(text), icon: { type: 'emoji', emoji }, color } };
}

function progressBar(value, max, unit = '') {
  const ratio  = Math.min(1, value / max);
  const filled = Math.round(ratio * 10);
  const bar    = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  const pct    = Math.round((value / max) * 100);
  const suffix = pct >= 100 ? ' ✓' : ` (${pct}%)`;
  return `${bar}  ${Math.round(value)} / ${max}${unit ? ' ' + unit : ''}${suffix}`;
}

function qualityStars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

// ── Targets cache ─────────────────────────────────────────────────────────────

const DEFAULT_TARGETS = { calories: 1600, protein: 220, carbs: 80, fat: 53, weight_kg: 105, goal_weight: 80 };
let _targetsCache = null;
let _targetsFetched = 0;

async function getTargets() {
  if (_targetsCache && Date.now() - _targetsFetched < 3600000) return _targetsCache;
  try {
    const page = await notion.pages.retrieve({ page_id: config.notion.pages.targets });
    const p = page.properties ?? {};
    // Try to extract properties from the targets page
    const cal  = p['Calories']?.number ?? p['Calorie Target']?.number ?? DEFAULT_TARGETS.calories;
    const prot = p['Protein']?.number  ?? p['Protein Target']?.number ?? DEFAULT_TARGETS.protein;
    const carb = p['Carbs']?.number    ?? DEFAULT_TARGETS.carbs;
    const fat  = p['Fat']?.number      ?? DEFAULT_TARGETS.fat;
    const wt   = p['Current Weight']?.number ?? p['Weight']?.number ?? DEFAULT_TARGETS.weight_kg;
    const goal = p['Goal Weight']?.number ?? DEFAULT_TARGETS.goal_weight;
    _targetsCache = { calories: cal, protein: prot, carbs: carb, fat: fat, weight_kg: wt, goal_weight: goal };
  } catch {
    _targetsCache = DEFAULT_TARGETS;
  }
  _targetsFetched = Date.now();
  return _targetsCache;
}

async function getTargetsText() {
  const t = await getTargets();
  return `Current weight: ~${t.weight_kg}kg, goal: ${t.goal_weight}kg\nDaily targets: ${t.calories} kcal / ${t.protein}g protein / ${t.carbs}g carbs / ${t.fat}g fat`;
}

// ── Day range filter ──────────────────────────────────────────────────────────

function dayRangeFilter(dayStartMs) {
  return {
    and: [
      { property: 'Date', date: { on_or_after: tsToISO(dayStartMs) } },
      { property: 'Date', date: { on_or_before: getMalaysiaISO() } },
    ],
  };
}

// ── Meal Log ──────────────────────────────────────────────────────────────────

async function createMealEntry(data) {
  const { meal_name, meal_type, items = [], totals, notes = '', time, caffeine_mg = 0 } = data;
  const dateISO = data.date
    ? buildDateTimeISO(data.date, time || null)
    : (time ? buildTimeISO(time) : getMalaysiaISO());
  const itemsSummary = items.map(i => i.weight_g ? `${i.name} ${i.weight_g}g` : i.name).join(', ');

  const children = [
    callout(`${meal_name}  ·  ${meal_type}  ·  ${Math.round(totals.calories)} kcal`, '🍽️', 'blue_background'),
    h2('Items'),
    ...items.map(item => {
      const g = item.weight_g ? `  ·  ${item.weight_g}g` : '';
      return bullet(`${item.name}${g}  ·  ${item.calories} kcal  ·  ${item.protein}g P  ·  ${item.carbs}g C  ·  ${item.fat}g F`);
    }),
    divider,
    para(`Calories  ${Math.round(totals.calories)} kcal`),
    para(`Protein    ${Math.round(totals.protein)}g`),
    para(`Carbs      ${Math.round(totals.carbs)}g`),
    para(`Fat          ${Math.round(totals.fat)}g`),
    ...(caffeine_mg > 0 ? [para(`Caffeine  ${caffeine_mg}mg`)] : []),
    ...(notes ? [divider, para(notes)] : []),
  ];

  const props = {
    Meal: { title: rt(meal_name) },
    Date: { date: { start: dateISO } },
    'Meal Type':       { select: { name: meal_type } },
    'Total Calories':  { number: totals.calories },
    'Protein (g)':     { number: totals.protein },
    'Carbs (g)':       { number: totals.carbs },
    'Fat (g)':         { number: totals.fat },
    Items:             { rich_text: rt(itemsSummary) },
    Notes:             { rich_text: rt(notes) },
  };
  if (caffeine_mg > 0) props['Caffeine (mg)'] = { number: caffeine_mg };

  return enqueue(() => notion.pages.create({ parent: { database_id: config.notion.db.mealLog }, properties: props, children }));
}

// ── Workout Log ───────────────────────────────────────────────────────────────

async function createWorkoutEntry(data) {
  const { workout_name, activity_type, duration_min, calories_burned, exercises = [], exercises_summary = '', notes = '' } = data;
  const children = [
    callout(`${workout_name}  ·  ${duration_min} min  ·  ~${calories_burned} kcal burned`, '💪', 'orange_background'),
    h2('Exercises'),
    ...exercises.map(ex => {
      let line = ex.name;
      if (ex.sets && ex.reps) line += `  ·  ${ex.sets} × ${ex.reps}`;
      if (ex.weight_kg)       line += ` @ ${ex.weight_kg} kg`;
      return numbered(line);
    }),
    ...(notes ? [divider, para(notes)] : []),
  ];
  return enqueue(() => notion.pages.create({
    parent: { database_id: config.notion.db.workoutLog },
    properties: {
      Workout:          { title: rt(workout_name) },
      Date:             { date: { start: data.date ? buildDateTimeISO(data.date, data.time || null) : (data.time ? buildTimeISO(data.time) : getMalaysiaISO()) } },
      'Activity Type':  { rich_text: rt(activity_type) },
      'Duration (min)': { number: duration_min },
      'Calories Burned':{ number: calories_burned },
      Exercises:        { rich_text: rt(exercises_summary) },
      Notes:            { rich_text: rt(notes) },
    },
    children,
  }));
}

async function updateWorkoutEntry(pageId, data) {
  const { duration_min, calories_burned, exercises = [], exercises_summary = '' } = data;
  const props = {};
  if (duration_min)    props['Duration (min)']  = { number: duration_min };
  if (calories_burned) props['Calories Burned']  = { number: calories_burned };
  if (exercises_summary) props['Exercises']      = { rich_text: rt(exercises_summary) };
  await notion.pages.update({ page_id: pageId, properties: props });

  // Append exercise details as new blocks if provided
  if (exercises.length) {
    const blocks = exercises.map(ex => {
      let line = ex.name;
      if (ex.sets && ex.reps) line += `  ·  ${ex.sets} × ${ex.reps}`;
      if (ex.weight_kg)       line += ` @ ${ex.weight_kg} kg`;
      return numbered(line);
    });
    await notion.blocks.children.append({ block_id: pageId, children: blocks });
  }
}

// ── Recovery Log ──────────────────────────────────────────────────────────────

async function createRecoveryEntry(data) {
  const { type, duration_min, temperature_c, notes = '' } = data;
  const sessionName = `${type} ${duration_min} min`;
  const tempStr = temperature_c != null ? `  ·  ${temperature_c}°C` : '';
  const children = [
    callout(`${type}  ·  ${duration_min} min${tempStr}`, '🧖', 'green_background'),
    ...(notes ? [para(notes)] : []),
  ];
  const props = {
    Session:          { title: rt(sessionName) },
    Date:             { date: { start: data.date ? buildDateTimeISO(data.date, data.time || null) : (data.time ? buildTimeISO(data.time) : getMalaysiaISO()) } },
    Type:             { select: { name: type } },
    'Duration (min)': { number: duration_min },
    Notes:            { rich_text: rt(notes) },
  };
  if (temperature_c != null) props['Temperature (C)'] = { number: temperature_c };
  return enqueue(() => notion.pages.create({ parent: { database_id: config.notion.db.recoveryLog }, properties: props, children }));
}

// ── Sleep Log ─────────────────────────────────────────────────────────────────

async function createSleepEntry(data) {
  const { bed_time, wake_time, hours_slept, quality, notes = '', bed_date, type = 'Night' } = data;
  const isNap = type === 'Nap';
  const dateLabel = bed_date || getMalaysiaDateStr();
  const title = isNap ? `Nap ${dateLabel} ${bed_time}` : `Night of ${dateLabel}`;

  // For night sleep: check if entry already exists today and update instead of creating
  if (!isNap) {
    const existing = await enqueue(() => notion.databases.query({
      database_id: config.notion.db.sleepLog,
      filter: { property: 'Sleep', title: { equals: title } },
      page_size: 1,
    }));
    if (existing.results.length) {
      const pageId = existing.results[0].id;
      return enqueue(() => notion.pages.update({
        page_id: pageId,
        properties: {
          'Bed Time':    { rich_text: rt(bed_time) },
          'Wake Time':   { rich_text: rt(wake_time) },
          'Hours Slept': { number: hours_slept },
          Quality:       { select: { name: String(quality) } },
          Notes:         { rich_text: rt(notes) },
        },
      }));
    }
  }

  const fmtH = (h) => { if (h == null) return '?'; const m = Math.round(h * 60); return `${Math.floor(m/60)}h ${m%60}m`; };
  const children = isNap ? [
    callout(`Nap ${bed_time} → ${wake_time}  ·  ${fmtH(hours_slept)}`, '😪', 'yellow_background'),
  ] : [
    callout(`${bed_time} → ${wake_time}  ·  ${fmtH(hours_slept)}  ·  ${qualityStars(quality)}`, '😴', 'purple_background'),
    para(`Bed:    ${bed_time}`),
    para(`Wake:   ${wake_time}`),
    para(`Hours:  ${fmtH(hours_slept)}`),
    para(`Quality: ${qualityStars(quality)} (${quality}/5)`),
    ...(notes ? [divider, para(notes)] : []),
  ];

  return enqueue(() => notion.pages.create({
    parent: { database_id: config.notion.db.sleepLog },
    properties: {
      Sleep:         { title: rt(title) },
      'Bed Time':    { rich_text: rt(bed_time) },
      'Wake Time':   { rich_text: rt(wake_time) },
      'Hours Slept': { number: hours_slept },
      ...(quality !== null && quality !== undefined ? { Quality: { select: { name: String(quality) } } } : {}),
      Notes:         { rich_text: rt(notes) },
    },
    children,
  }));
}

// ── Body Measurements ─────────────────────────────────────────────────────────

async function createBodyEntry(data) {
  const { weight_kg, body_fat_pct, weight_change, notes = '' } = data;
  const bmi = +(weight_kg / (1.76 * 1.76)).toFixed(1);
  const changeStr = weight_change !== null && weight_change !== undefined
    ? (weight_change >= 0 ? `+${weight_change}` : `${weight_change}`) + ' kg'
    : '';
  const children = [
    callout(`${weight_kg} kg  ·  BMI ${bmi}${body_fat_pct != null ? `  ·  ${body_fat_pct}% BF` : ''}`, '⚖️', 'yellow_background'),
    para(`Weight:   ${weight_kg} kg${changeStr ? `  (${changeStr})` : ''}`),
    para(`BMI:      ${bmi}`),
    ...(body_fat_pct != null ? [para(`Body fat: ${body_fat_pct}%`)] : []),
    ...(notes ? [divider, para(notes)] : []),
  ];
  const props = {
    'Check-in':    { title: rt(`Body Check — ${getMalaysiaDateStr()}`) },
    Date:          { date: { start: getMalaysiaISO() } },
    'Weight (kg)': { number: weight_kg },
    BMI:           { number: bmi },
    Notes:         { rich_text: rt(notes) },
  };
  if (body_fat_pct != null) props['Body Fat (%)'] = { number: body_fat_pct };
  if (weight_change != null) props['Weight Change'] = { number: weight_change };
  return enqueue(() => notion.pages.create({ parent: { database_id: config.notion.db.bodyMeasurements }, properties: props, children }));
}

// ── Plans & Reminders ─────────────────────────────────────────────────────────

async function createPlanEntry(plan) {
  const { title, date, time, recurring = 'One-time', notes = '' } = plan;
  if (!config.notion.db.plans) return null;
  const dateISO = time ? buildDateTimeISO(date, time) : `${date}T09:00:00+08:00`;
  return enqueue(() => notion.pages.create({
    parent: { database_id: config.notion.db.plans },
    properties: {
      Plan:      { title: rt(title) },
      Date:      { date: { start: dateISO } },
      Time:      { rich_text: rt(time || '') },
      Status:    { select: { name: 'Pending' } },
      Recurring: { select: { name: recurring === 'daily' ? 'Daily' : recurring === 'weekly' ? 'Weekly' : 'One-time' } },
      Notes:     { rich_text: rt(notes) },
    },
  }));
}

async function updatePlanStatusNotion(pageId, status) {
  if (!pageId) return;
  return enqueue(() => notion.pages.update({
    page_id: pageId,
    properties: { Status: { select: { name: status } } },
  }));
}

// ── Golf Log ──────────────────────────────────────────────────────────────────

async function createGolfEntry(data) {
  if (!config.notion.db.golfLog) return null;
  const { session_type = 'Course Round', location, score, holes, focus_areas, what_went_well, what_to_improve, coach_feedback, notes = '' } = data;
  const title = `${session_type} — ${getMalaysiaDateStr()}`;
  const children = [
    callout(title, '⛳', 'green_background'),
    ...(what_went_well ? [h2('What Went Well'), para(what_went_well)] : []),
    ...(what_to_improve ? [h2('To Improve'), para(what_to_improve)] : []),
    ...(coach_feedback ? [h2('Coach Feedback'), para(coach_feedback)] : []),
    ...(notes ? [h2('Notes'), para(notes)] : []),
  ];
  const props = {
    Session:     { title: rt(title) },
    Date:        { date: { start: getMalaysiaISO() } },
    Type:        { select: { name: session_type } },
    Notes:       { rich_text: rt(notes) },
  };
  if (location)      props['Location']        = { rich_text: rt(location) };
  if (score != null) props['Score']           = { number: score };
  if (holes)         props['Holes']           = { select: { name: String(holes) } };
  if (focus_areas)   props['Focus Areas']     = { rich_text: rt(focus_areas) };
  if (what_went_well)  props['What Went Well']  = { rich_text: rt(what_went_well) };
  if (what_to_improve) props['What to Improve'] = { rich_text: rt(what_to_improve) };
  if (coach_feedback)  props['Coach Feedback']  = { rich_text: rt(coach_feedback) };
  return enqueue(() => notion.pages.create({ parent: { database_id: config.notion.db.golfLog }, properties: props, children }));
}

async function getGolfHistory(limit = 3) {
  if (!config.notion.db.golfLog) return [];
  const res = await notion.databases.query({
    database_id: config.notion.db.golfLog,
    sorts: [{ property: 'Date', direction: 'descending' }],
    page_size: limit,
  }).catch(() => ({ results: [] }));
  return res.results.map(page => {
    const p = page.properties;
    return {
      title:            p['Session']?.title?.[0]?.text?.content ?? '',
      type:             p['Type']?.select?.name ?? '',
      date:             p['Date']?.date?.start ?? '',
      score:            p['Score']?.number ?? null,
      what_went_well:   p['What Went Well']?.rich_text?.[0]?.text?.content ?? '',
      what_to_improve:  p['What to Improve']?.rich_text?.[0]?.text?.content ?? '',
    };
  });
}

// ── Read Golf Hub page ────────────────────────────────────────────────────────

async function getGolfHubContent() {
  if (!config.notion.pages.golfHub) return '';
  try {
    const blocks = await notion.blocks.children.list({ block_id: config.notion.pages.golfHub });
    return blocks.results
      .map(b => b[b.type]?.rich_text?.map(r => r.text?.content).join('') || '')
      .filter(Boolean)
      .join('\n');
  } catch { return ''; }
}

// ── Daily totals & data ───────────────────────────────────────────────────────

async function getDailyMealTotals(dayStartMs) {
  if (!config.notion.db.mealLog) return { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const filter = dayStartMs ? dayRangeFilter(dayStartMs) : (() => {
    const { start, end } = getTodayRange();
    return { and: [{ property: 'Date', date: { on_or_after: start } }, { property: 'Date', date: { before: end } }] };
  })();
  const response = await notion.databases.query({ database_id: config.notion.db.mealLog, filter });
  return response.results.reduce((acc, page) => {
    const p = page.properties;
    acc.calories += p['Total Calories']?.number ?? 0;
    acc.protein  += p['Protein (g)']?.number    ?? 0;
    acc.carbs    += p['Carbs (g)']?.number      ?? 0;
    acc.fat      += p['Fat (g)']?.number        ?? 0;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });
}

async function getDrinkEntries(dayStartMs) {
  if (!config.notion.db.mealLog) return [];
  const response = await notion.databases.query({
    database_id: config.notion.db.mealLog,
    filter: { and: [dayRangeFilter(dayStartMs).and[0], { property: 'Meal Type', select: { equals: 'Drink' } }] },
  }).catch(() => ({ results: [] }));
  return response.results.map(page => {
    const p = page.properties;
    return {
      meal_name:    p['Meal']?.title?.[0]?.text?.content ?? '',
      date_iso:     p['Date']?.date?.start ?? '',
      caffeine_mg:  p['Caffeine (mg)']?.number ?? 0,
    };
  });
}

async function getEntriesForDay(dbKey, titleProp, dayStartMs) {
  const dbId = config.notion.db[dbKey];
  if (!dbId) return [];
  const response = await notion.databases.query({
    database_id: dbId,
    filter: dayRangeFilter(dayStartMs),
    sorts: [{ property: 'Date', direction: 'ascending' }],
  }).catch(() => ({ results: [] }));
  return response.results.map(page => ({
    pageId: page.id,
    title:  page.properties[titleProp]?.title?.[0]?.text?.content ?? titleProp,
    date:   page.properties['Date']?.date?.start ?? '',
  }));
}

async function getDayData(dayStartMs) {
  const filter = dayRangeFilter(dayStartMs);
  const [mealsRes, workoutsRes, recoveryRes] = await Promise.all([
    notion.databases.query({ database_id: config.notion.db.mealLog,    filter }).catch(() => ({ results: [] })),
    notion.databases.query({ database_id: config.notion.db.workoutLog, filter }).catch(() => ({ results: [] })),
    notion.databases.query({ database_id: config.notion.db.recoveryLog,filter }).catch(() => ({ results: [] })),
  ]);

  const totals = { calories: 0, protein: 0, carbs: 0, fat: 0, caffeine: 0 };
  const meals = mealsRes.results.map(page => {
    const p = page.properties;
    const cal = p['Total Calories']?.number ?? 0;
    const prot = p['Protein (g)']?.number ?? 0;
    const carb = p['Carbs (g)']?.number ?? 0;
    const fat  = p['Fat (g)']?.number   ?? 0;
    const caff = p['Caffeine (mg)']?.number ?? 0;
    totals.calories += cal; totals.protein += prot; totals.carbs += carb; totals.fat += fat; totals.caffeine += caff;
    return { name: p['Meal']?.title?.[0]?.text?.content ?? '?', type: p['Meal Type']?.select?.name ?? '', calories: Math.round(cal), protein: Math.round(prot), carbs: Math.round(carb), fat: Math.round(fat) };
  });

  const workouts = workoutsRes.results.map(page => {
    const p = page.properties;
    return { name: p['Workout']?.title?.[0]?.text?.content ?? 'Workout', duration_min: p['Duration (min)']?.number ?? 0, calories_burned: p['Calories Burned']?.number ?? 0 };
  });

  const recovery = recoveryRes.results.map(page => {
    const p = page.properties;
    return { type: p['Session']?.title?.[0]?.text?.content ?? 'Recovery', duration_min: p['Duration (min)']?.number ?? 0 };
  });

  return {
    totals: { calories: Math.round(totals.calories), protein: Math.round(totals.protein), carbs: Math.round(totals.carbs), fat: Math.round(totals.fat), caffeine: Math.round(totals.caffeine) },
    meals, workouts, recovery,
  };
}

// ── Last body measurement ─────────────────────────────────────────────────────

async function getLastBodyMeasurement() {
  if (!config.notion.db.bodyMeasurements) return null;
  const res = await notion.databases.query({
    database_id: config.notion.db.bodyMeasurements,
    sorts: [{ property: 'Date', direction: 'descending' }],
    page_size: 1,
  }).catch(() => ({ results: [] }));
  if (!res.results.length) return null;
  const p = res.results[0].properties;
  return { weight_kg: p['Weight (kg)']?.number ?? null, body_fat_pct: p['Body Fat (%)']?.number ?? null, bmi: p['BMI']?.number ?? null };
}

// ── Today entries (for /today command) ───────────────────────────────────────

const DB_CONFIGS = [
  { key: 'mealLog',          label: 'Meal',     titleProp: 'Meal',      extraFn: p => `${p['Total Calories']?.number ?? '?'} kcal` },
  { key: 'workoutLog',       label: 'Workout',  titleProp: 'Workout',   extraFn: p => `${p['Duration (min)']?.number ?? '?'} min` },
  { key: 'recoveryLog',      label: 'Recovery', titleProp: 'Session',   extraFn: () => '' },
  { key: 'sleepLog',         label: 'Sleep',    titleProp: 'Sleep',     extraFn: p => `${p['Hours Slept']?.number ?? '?'}h` },
  { key: 'bodyMeasurements', label: 'Body',     titleProp: 'Check-in',  extraFn: p => `${p['Weight (kg)']?.number ?? '?'} kg` },
];

async function getTodayEntries(dayStartMs) {
  const filter = dayStartMs
    ? dayRangeFilter(dayStartMs)
    : (() => { const { start, end } = getTodayRange(); return { and: [{ property: 'Date', date: { on_or_after: start } }, { property: 'Date', date: { before: end } }] }; })();
  const entries = [];
  for (const dbConf of DB_CONFIGS) {
    const dbId = config.notion.db[dbConf.key];
    if (!dbId) continue;
    try {
      const res = await notion.databases.query({ database_id: dbId, filter, sorts: [{ property: 'Date', direction: 'ascending' }] });
      for (const page of res.results) {
        const p = page.properties;
        entries.push({ pageId: page.id, label: dbConf.label, title: p[dbConf.titleProp]?.title?.[0]?.text?.content ?? dbConf.label, extra: dbConf.extraFn(p) });
      }
    } catch {}
  }
  return entries;
}

async function deleteEntry(pageId) {
  return enqueue(() => notion.pages.update({ page_id: pageId, archived: true }));
}

// ── Known foods ───────────────────────────────────────────────────────────────

async function getKnownFoodsContext(dayOfWeek, weekType) {
  if (!config.notion.db.knownFoods) return '';
  const dayFilter = { or: [{ property: 'Day of Week', rich_text: { equals: dayOfWeek } }, { property: 'Day of Week', rich_text: { is_empty: true } }] };
  let filter = dayFilter;
  if (weekType) {
    const other = weekType === 'even' ? 'Odd' : 'Even';
    filter = { and: [dayFilter, { property: 'Notes', rich_text: { does_not_contain: `Lunch ${other} Week` } }] };
  }
  const res = await notion.databases.query({ database_id: config.notion.db.knownFoods, filter }).catch(() => ({ results: [] }));
  return res.results.map(page => {
    const p = page.properties;
    return `${p['Food Name']?.title?.[0]?.text?.content ?? ''} (${p['Serving Size']?.rich_text?.[0]?.text?.content ?? ''}): ${p['Calories']?.number ?? 0} kcal, ${p['Protein (g)']?.number ?? 0}g P, ${p['Carbs (g)']?.number ?? 0}g C, ${p['Fat (g)']?.number ?? 0}g F`;
  }).join('\n');
}

// ── Coach Notes ───────────────────────────────────────────────────────────────

async function createDailySummaryPage(dayData, summaryText, dateStr, targets) {
  if (!config.notion.db.coachNotes) return;
  const T = targets || { calories: 1600, protein: 220, carbs: 80, fat: 53 };
  const { totals, meals, workouts, recovery } = dayData;

  const children = [
    callout(`Daily Summary — ${dateStr}`, '🌙', 'purple_background'),
    h2('📊 Nutrition'),
    para(`Calories  ${progressBar(totals.calories, T.calories, 'kcal')}`),
    para(`Protein   ${progressBar(totals.protein,  T.protein,  'g')}`),
    para(`Carbs     ${progressBar(totals.carbs,    T.carbs,    'g')}`),
    para(`Fat       ${progressBar(totals.fat,      T.fat,      'g')}`),
    ...(totals.caffeine > 0 ? [para(`Caffeine  ${totals.caffeine}mg`)] : []),
    ...(meals.length ? [divider, h2('🍽️ Meals'), ...meals.map(m => bullet(`${m.name}  ·  ${m.calories} kcal  ·  ${m.protein}g P`))] : []),
    ...(workouts.length ? [h2('💪 Training'), ...workouts.map(w => bullet(`${w.name}  ·  ${w.duration_min} min  ·  ~${w.calories_burned} kcal`))] : []),
    ...(recovery.length ? [h2('🧖 Recovery'), ...recovery.map(r => bullet(r.type))] : []),
    divider,
    callout(summaryText, '💬', 'gray_background'),
  ];

  return enqueue(() => notion.pages.create({
    parent: { database_id: config.notion.db.coachNotes },
    properties: {
      Summary: { title: rt(`Daily Summary — ${dateStr}`) },
      Date:    { date: { start: getMalaysiaISO() } },
      Type:    { select: { name: 'Daily Night Summary' } },
      Content: { rich_text: rt(summaryText.slice(0, 2000)) },
      'Calories Eaten':  { number: totals.calories },
      'Protein Hit':     { select: { name: totals.protein >= T.protein ? 'Yes' : totals.protein >= T.protein * 0.9 ? 'Close' : 'No' } },
      'Trained Today':   { select: { name: workouts.length > 0 ? 'Yes' : 'No' } },
    },
    children,
  }));
}

async function createCoachNote(title, bodyText, type = 'Daily Evening Check') {
  if (!config.notion.db.coachNotes) return;
  return enqueue(() => notion.pages.create({
    parent: { database_id: config.notion.db.coachNotes },
    properties: {
      Summary: { title: rt(title) },
      Date:    { date: { start: getMalaysiaISO() } },
      Type:    { select: { name: type } },
      Content: { rich_text: rt(bodyText.slice(0, 2000)) },
    },
    children: [para(bodyText)],
  }));
}

// ── Correct entry time ────────────────────────────────────────────────────────

async function correctEntryTime(pageId, newISO) {
  return enqueue(() => notion.pages.update({ page_id: pageId, properties: { Date: { date: { start: newISO } } } }));
}

// ── Weekly data for review ────────────────────────────────────────────────────

async function getWeekData(weekStartMs) {
  const weekEndMs = weekStartMs + 7 * 24 * 3600 * 1000;
  const filter = {
    and: [
      { property: 'Date', date: { on_or_after: tsToISO(weekStartMs) } },
      { property: 'Date', date: { before: tsToISO(weekEndMs) } },
    ],
  };
  const [mealsRes, workoutsRes, recoveryRes, sleepRes] = await Promise.all([
    notion.databases.query({ database_id: config.notion.db.mealLog,     filter }).catch(() => ({ results: [] })),
    notion.databases.query({ database_id: config.notion.db.workoutLog,  filter }).catch(() => ({ results: [] })),
    notion.databases.query({ database_id: config.notion.db.recoveryLog, filter }).catch(() => ({ results: [] })),
    notion.databases.query({ database_id: config.notion.db.sleepLog,    filter }).catch(() => ({ results: [] })),
  ]);

  const dailyTotals = {};
  for (const page of mealsRes.results) {
    const p = page.properties;
    const date = p['Date']?.date?.start?.split('T')[0] ?? 'unknown';
    if (!dailyTotals[date]) dailyTotals[date] = { calories: 0, protein: 0, carbs: 0, fat: 0 };
    dailyTotals[date].calories += p['Total Calories']?.number ?? 0;
    dailyTotals[date].protein  += p['Protein (g)']?.number ?? 0;
  }

  const days = Object.values(dailyTotals);
  const avgCal  = days.length ? Math.round(days.reduce((s, d) => s + d.calories, 0) / days.length) : 0;
  const avgProt = days.length ? Math.round(days.reduce((s, d) => s + d.protein,  0) / days.length) : 0;

  const sleepEntries = sleepRes.results.map(p => ({
    hours: p.properties['Hours Slept']?.number ?? 0,
    quality: Number(p.properties['Quality']?.select?.name ?? '3'),
  }));
  const avgSleep = sleepEntries.length ? +(sleepEntries.reduce((s, e) => s + e.hours, 0) / sleepEntries.length).toFixed(1) : 0;
  const avgQuality = sleepEntries.length ? +(sleepEntries.reduce((s, e) => s + e.quality, 0) / sleepEntries.length).toFixed(1) : 0;

  const sauna  = recoveryRes.results.filter(p => p.properties['Type']?.select?.name === 'Sauna').length;
  const plunge = recoveryRes.results.filter(p => p.properties['Type']?.select?.name === 'Cold Plunge').length;

  return { dailyTotals, avgCal, avgProt, trainDays: workoutsRes.results.length, avgSleep, avgQuality, sauna, plunge };
}

// ── All body measurements (for full analysis) ─────────────────────────────────

async function getAllBodyMeasurements() {
  if (!config.notion.db.bodyMeasurements) return [];
  const res = await notion.databases.query({
    database_id: config.notion.db.bodyMeasurements,
    sorts: [{ property: 'Date', direction: 'ascending' }],
  }).catch(() => ({ results: [] }));
  return res.results.map(page => {
    const p = page.properties;
    return { date: p['Date']?.date?.start ?? '', weight_kg: p['Weight (kg)']?.number, body_fat_pct: p['Body Fat (%)']?.number, bmi: p['BMI']?.number };
  });
}

module.exports = {
  getTargets, getTargetsText,
  createMealEntry, createWorkoutEntry, updateWorkoutEntry, createRecoveryEntry, createSleepEntry, createBodyEntry,
  createPlanEntry, updatePlanStatusNotion,
  createGolfEntry, getGolfHistory, getGolfHubContent,
  getDailyMealTotals, getDrinkEntries, getEntriesForDay, getDayData, getTodayEntries,
  deleteEntry, getLastBodyMeasurement, getKnownFoodsContext,
  createDailySummaryPage, createCoachNote, correctEntryTime,
  getWeekData, getAllBodyMeasurements,
};
