require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('@notionhq/client');
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_KNOWN_FOODS_DS;

const DAY_MAP = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed',
  THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
};

function rt(text) {
  return [{ type: 'text', text: { content: String(text ?? '') } }];
}

async function clearExisting() {
  console.log('Clearing existing Known Foods entries...');
  let cleared = 0;
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DB_ID,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of res.results) {
      await notion.pages.update({ page_id: page.id, archived: true });
      cleared++;
      process.stdout.write(`\r  Archived ${cleared} entries...`);
      await delay(200);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  console.log(`\n  Done. ${cleared} entries cleared.`);
}

async function uploadEntry(entry) {
  const props = {
    'Food Name': { title: rt(entry.name) },
    'Source': { select: { name: 'Network School' } },
    'Serving Size': { rich_text: rt(entry.serving) },
    'Calories': { number: entry.calories },
    'Protein (g)': { number: entry.protein },
    'Carbs (g)': { number: entry.carbs },
    'Fat (g)': { number: entry.fat },
    'Notes': { rich_text: rt(entry.notes) },
  };
  if (entry.day) props['Day of Week'] = { rich_text: rt(entry.day) };
  await notion.pages.create({ parent: { database_id: DB_ID }, properties: props });
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LUNCH PARSER ─────────────────────────────────────────────────────────────
function parseLunch(lines, weekLabel) {
  const entries = [];
  let currentDay = '';
  let currentProtein = '';
  let currentItem = '';
  let currentSize = '';

  for (const cols of lines) {
    const col0 = cols[0]?.trim();
    const col1 = cols[1]?.trim();
    const col2 = cols[2]?.trim();
    const col3 = cols[3]?.trim();
    const calories = parseFloat(cols[4]);

    if (DAY_MAP[col0]) { currentDay = DAY_MAP[col0]; currentProtein = ''; currentItem = ''; continue; }
    if (col1 === 'Item') continue;
    if (!currentDay) continue;

    if (col0) currentProtein = col0;
    if (col1) currentItem = col1;
    if (col2 === 'R' || col2 === 'D') currentSize = col2;

    if (!col3 || isNaN(calories)) continue;

    const sizeName = currentSize === 'R' ? 'Regular' : 'Double';
    entries.push({
      name: `${currentItem} — ${sizeName} (${col3}) [${weekLabel}]`,
      day: currentDay,
      serving: `1 plate ${sizeName}`,
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[5]) || 0),
      protein: Math.round(parseFloat(cols[6]) || 0),
      fat: Math.round(parseFloat(cols[7]) || 0),
      notes: `Lunch ${weekLabel} | ${currentProtein} | ${currentDay}`,
    });
  }
  return entries;
}

// ── DINNER PARSER ─────────────────────────────────────────────────────────────
// Columns: Category, Item, CALORIES, CARBS, PROTEIN, FAT, FIBER
function parseDinner(lines, weekLabel) {
  const entries = [];
  let currentDay = '';
  let currentCategory = '';

  for (const cols of lines) {
    const col0 = cols[0]?.trim();
    const col1 = cols[1]?.trim();
    const calories = parseFloat(cols[2]);

    if (DAY_MAP[col0]) { currentDay = DAY_MAP[col0]; currentCategory = ''; continue; }
    if (col1 === 'Item' || col0.startsWith('All nutrition')) continue;
    if (!currentDay) continue;

    // Category cells (Base, Veggie, Protein, Vegan Protein, Vegetarian Protein, Sauce)
    const categoryWords = ['Base', 'Veggie', 'Protein', 'Vegan', 'Vegetarian', 'Sauce'];
    if (col0 && categoryWords.some(w => col0.startsWith(w))) currentCategory = col0.replace(/\s+$/, '');

    if (!col1 || isNaN(calories)) continue;

    entries.push({
      name: `${col1} [Dinner ${currentDay} ${weekLabel}]`,
      day: currentDay,
      serving: '100g',
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[3]) || 0),
      protein: Math.round(parseFloat(cols[4]) || 0),
      fat: Math.round(parseFloat(cols[5]) || 0),
      notes: `Dinner ${weekLabel} | ${currentCategory} | ${currentDay} | per 100g`,
    });
  }
  return entries;
}

// ── CAFE PARSER ───────────────────────────────────────────────────────────────
function parseCafe(lines) {
  const entries = [];
  let currentSection = 'Food';
  const sectionHeaders = ['Food', 'Smoothies', 'Cold-Pressed Juices', 'Espresso-Based', 'Non-Coffee Beverages', 'Dessert'];

  for (const cols of lines) {
    const col0 = cols[0]?.trim();
    if (!col0) continue;

    // Section header rows have text in col0 and nothing useful in cal col
    if (sectionHeaders.includes(col0) || col0 === 'Smoothies') {
      currentSection = col0;
      continue;
    }
    // Column header rows
    if (cols[1]?.trim() === 'Calories (kcal)') continue;

    const calories = parseFloat(cols[1]);
    if (!col0 || isNaN(calories)) continue;

    entries.push({
      name: `${col0} [NS Cafe]`,
      day: '',
      serving: '1 serving',
      calories: Math.round(calories),
      carbs: Math.round(parseFloat(cols[2]) || 0),
      protein: Math.round(parseFloat(cols[3]) || 0),
      fat: Math.round(parseFloat(cols[4]) || 0),
      notes: `NS Cafe | ${currentSection}`,
    });
  }
  return entries;
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  const raw = fs.readFileSync('/tmp/ns_foods.csv', 'utf8');
  const allLines = raw.split('\n').map(l => l.split(','));

  // Split into sections
  const sections = { lunchEven: [], lunchOdd: [], dinnerOdd: [], dinnerEven: [], cafe: [] };
  let current = null;

  for (const cols of allLines) {
    const header = cols[0]?.trim();
    if (header === 'LUNCH EVEN WEEKS')      { current = 'lunchEven'; continue; }
    if (header === 'LUNCH ODD WEEKS')       { current = 'lunchOdd'; continue; }
    if (header === 'DINNERS ODD WEEKS')     { current = 'dinnerOdd'; continue; }
    if (header === 'DINNERS EVEN')          { current = 'dinnerEven'; continue; }
    if (header === 'NS CAFE')               { current = 'cafe'; continue; }
    if (current) sections[current].push(cols);
  }

  const lunchEven = parseLunch(sections.lunchEven, 'Even Week');
  const lunchOdd  = parseLunch(sections.lunchOdd,  'Odd Week');
  const dinnerOdd = parseDinner(sections.dinnerOdd,  'Odd');
  const dinnerEven= parseDinner(sections.dinnerEven, 'Even');
  const cafe      = parseCafe(sections.cafe);

  const all = [...lunchEven, ...lunchOdd, ...dinnerOdd, ...dinnerEven, ...cafe];
  console.log(`Parsed: ${lunchEven.length} lunch-even, ${lunchOdd.length} lunch-odd, ${dinnerOdd.length} dinner-odd, ${dinnerEven.length} dinner-even, ${cafe.length} cafe`);
  console.log(`Total: ${all.length} entries\n`);

  await clearExisting();

  console.log('\nUploading...');
  let uploaded = 0;
  for (const entry of all) {
    try {
      await uploadEntry(entry);
      uploaded++;
      process.stdout.write(`\r${uploaded}/${all.length} uploaded...`);
      await delay(350);
    } catch (err) {
      console.error(`\nFailed: ${entry.name} — ${err.message}`);
    }
  }
  console.log(`\nDone. ${uploaded}/${all.length} uploaded.`);
}

main();
