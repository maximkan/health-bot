// Parse NS Nutrition spreadsheet CSV → SQLite known_foods
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/bot.db');
const db = new Database(DB_PATH);

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

const DAY_MAP = { MONDAY:'Mon', TUESDAY:'Tue', WEDNESDAY:'Wed', THURSDAY:'Thu', FRIDAY:'Fri', SATURDAY:'Sat', SUNDAY:'Sun' };

function parseLunch(lines, weekLabel) {
  const entries = [];
  let currentDay = '', currentProtein = '', currentItem = '', currentSize = 'R';

  for (const cols of lines) {
    const col0 = cols[0]?.trim() ?? '';
    const col1 = cols[1]?.trim() ?? '';
    const col2 = cols[2]?.trim() ?? '';
    const col3 = cols[3]?.trim() ?? '';

    // Day header: MONDAY,Item,,Base,CALORIES...
    if (DAY_MAP[col0]) {
      currentDay = DAY_MAP[col0];
      currentProtein = ''; currentItem = ''; currentSize = 'R';
      continue;
    }
    if (!currentDay) continue;

    // Shifted format: CSV exported some rows as "-ItemName,R/D,base,cal,..." (col0 has dash+item, no protein prefix)
    if (col0.startsWith('-')) {
      currentItem = col0.slice(1).trim();
      if (col1 === 'R' || col1 === 'D') currentSize = col1;
      const base = col2;
      const calories = parseFloat(cols[3]);
      if (!base || !currentItem || isNaN(calories) || calories <= 0) continue;
      const sizeName = currentSize === 'D' ? 'Double' : 'Regular';
      entries.push({
        name: `${currentItem} — ${sizeName} (${base}) [${weekLabel}]`,
        day: currentDay,
        serving: `1 plate ${sizeName}`,
        calories: Math.round(calories),
        carbs: Math.round(parseFloat(cols[4]) || 0),
        protein: Math.round(parseFloat(cols[5]) || 0),
        fat: Math.round(parseFloat(cols[6]) || 0),
        notes: `Lunch ${weekLabel} | Vegetarian | ${currentDay}`,
        source: 'Network School',
      });
      continue;
    }

    // Standard format: protein type, item name, R/D, base, calories...
    if (col0 && col0 !== 'Item') currentProtein = col0;
    if (col1 && col1 !== 'Item' && col1 !== 'R' && col1 !== 'D') currentItem = col1;
    if (col2 === 'R' || col2 === 'D') currentSize = col2;

    const base = col3;
    const calories = parseFloat(cols[4]);
    if (!base || !currentItem || isNaN(calories) || calories <= 0) continue;

    const sizeName = currentSize === 'D' ? 'Double' : 'Regular';
    const name = `${currentItem} — ${sizeName} (${base}) [${weekLabel}]`;

    entries.push({
      name,
      day: currentDay,
      serving: `1 plate ${sizeName}`,
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[5]) || 0),
      protein: Math.round(parseFloat(cols[6]) || 0),
      fat: Math.round(parseFloat(cols[7]) || 0),
      notes: `Lunch ${weekLabel} | ${currentProtein} | ${currentDay}`,
      source: 'Network School',
    });
  }
  return entries;
}

function parseDinner(lines, weekLabel) {
  const entries = [];
  let currentDay = '', currentCategory = '';

  for (const cols of lines) {
    const col0 = cols[0]?.trim() ?? '';
    const col1 = cols[1]?.trim() ?? '';

    if (col0.startsWith('All nutrition')) continue;
    if (col1 === 'Item' || col1 === 'CALORIES (KCAL)') continue;

    if (DAY_MAP[col0]) {
      currentDay = DAY_MAP[col0];
      currentCategory = '';
      continue;
    }
    if (!currentDay) continue;

    const catPrefixes = ['Base', 'Veggie', 'Protein', 'Vegan Protein', 'Vegetarian Protein', 'Sauce'];
    if (col0 && catPrefixes.some(c => col0.trim().startsWith(c))) {
      currentCategory = col0.trim();
    }

    if (!col1) continue;
    const calories = parseFloat(cols[2]);
    if (isNaN(calories) || calories <= 0) continue;

    const name = `${col1} [Dinner ${currentDay} ${weekLabel}]`;
    entries.push({
      name,
      day: currentDay,
      serving: '100g',
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[3]) || 0),
      protein: Math.round(parseFloat(cols[4]) || 0),
      fat: Math.round(parseFloat(cols[5]) || 0),
      notes: `Dinner ${weekLabel} | ${currentCategory} | ${currentDay} | per 100g`,
      source: 'Network School',
    });
  }
  return entries;
}

function parseCafe(lines) {
  const entries = [];
  const sectionHeaders = new Set(['Food', 'Smoothies', 'Cold-Pressed Juices', 'Espresso-Based', 'Non-Coffee Beverages', 'Dessert']);
  let section = 'Food';

  for (const cols of lines) {
    const col0 = cols[0]?.trim() ?? '';
    if (!col0) continue;
    if (sectionHeaders.has(col0)) { section = col0; continue; }
    if (cols[1]?.trim() === 'Calories (kcal)') continue;

    const calories = parseFloat(cols[1]);
    if (isNaN(calories) || calories <= 0) continue;

    entries.push({
      name: `${col0} [NS Cafe]`,
      day: null,
      serving: '1 serving',
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[2]) || 0),
      protein: Math.round(parseFloat(cols[3]) || 0),
      fat: Math.round(parseFloat(cols[4]) || 0),
      notes: `NS Cafe | ${section}`,
      source: 'Network School',
    });
  }
  return entries;
}

const upsert = db.prepare(`INSERT INTO known_foods (name,serving,calories,protein,carbs,fat,day_of_week,notes,source)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET serving=excluded.serving,calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,day_of_week=excluded.day_of_week,notes=excluded.notes,source=excluded.source`);

async function main() {
  const csvPath = process.argv[2] || '/tmp/ns_foods.csv';
  if (!fs.existsSync(csvPath)) { console.error(`❌ ${csvPath} not found`); process.exit(1); }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const allLines = raw.split(/\r?\n/).map(l => l.split(','));

  const sections = { lunchEven: [], lunchOdd: [], dinnerOdd: [], dinnerEven: [], cafe: [] };
  let current = null;
  for (const cols of allLines) {
    const h = cols[0]?.trim();
    if (h === 'LUNCH EVEN WEEKS')  { current = 'lunchEven'; continue; }
    if (h === 'LUNCH ODD WEEKS')   { current = 'lunchOdd';  continue; }
    if (h === 'DINNERS ODD WEEKS') { current = 'dinnerOdd'; continue; }
    if (h === 'DINNERS EVEN' || h === 'DINNERS EVEN ') { current = 'dinnerEven'; continue; }
    if (h === 'NS CAFE')           { current = 'cafe';       continue; }
    if (current) sections[current].push(cols);
  }

  const all = [
    ...parseLunch(sections.lunchEven, 'Even Week'),
    ...parseLunch(sections.lunchOdd,  'Odd Week'),
    ...parseDinner(sections.dinnerOdd,  'Odd'),
    ...parseDinner(sections.dinnerEven, 'Even'),
    ...parseCafe(sections.cafe),
  ];
  console.log(`Parsed ${all.length} entries from CSV`);

  let sqliteNew = 0, sqliteUpdated = 0;
  for (const entry of all) {
    const existing = db.prepare('SELECT id FROM known_foods WHERE name=?').get(entry.name);
    upsert.run(entry.name, entry.serving, entry.calories, entry.protein, entry.carbs, entry.fat, entry.day || null, entry.notes, entry.source);
    if (existing) sqliteUpdated++; else sqliteNew++;
  }

  console.log(`✅ SQLite: ${sqliteNew} new, ${sqliteUpdated} updated`);
  console.log(`Total in known_foods: ${db.prepare('SELECT COUNT(*) as c FROM known_foods').get().c}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
