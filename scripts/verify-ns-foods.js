require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client } = require('@notionhq/client');
const fs = require('fs');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DB_ID = process.env.NOTION_KNOWN_FOODS_DS;

const DAY_MAP = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed',
  THURSDAY: 'Thu', FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
};

function parseLunch(lines, weekLabel) {
  const entries = [];
  let currentDay = '', currentProtein = '', currentItem = '', currentSize = '';
  for (const cols of lines) {
    const col0 = cols[0]?.trim(), col1 = cols[1]?.trim(), col2 = cols[2]?.trim(), col3 = cols[3]?.trim();
    const calories = parseFloat(cols[4]);
    if (DAY_MAP[col0]) { currentDay = DAY_MAP[col0]; currentProtein = ''; currentItem = ''; continue; }
    if (col1 === 'Item') continue;
    if (!currentDay) continue;
    if (col0) currentProtein = col0;
    if (col1) currentItem = col1;
    if (col2 === 'R' || col2 === 'D') currentSize = col2;
    if (!col3 || isNaN(calories)) continue;
    const sizeName = currentSize === 'R' ? 'Regular' : 'Double';
    entries.push({ name: `${currentItem} — ${sizeName} (${col3}) [${weekLabel}]` });
  }
  return entries;
}

function parseDinner(lines, weekLabel) {
  const entries = [];
  let currentDay = '';
  for (const cols of lines) {
    const col0 = cols[0]?.trim(), col1 = cols[1]?.trim();
    const calories = parseFloat(cols[2]);
    if (DAY_MAP[col0]) { currentDay = DAY_MAP[col0]; continue; }
    if (col1 === 'Item' || col0.startsWith('All nutrition')) continue;
    if (!currentDay) continue;
    const categoryWords = ['Base', 'Veggie', 'Protein', 'Vegan', 'Vegetarian', 'Sauce'];
    if (col0 && categoryWords.some(w => col0.startsWith(w))) continue;
    if (!col1 || isNaN(calories)) continue;
    entries.push({ name: `${col1} [Dinner ${currentDay} ${weekLabel}]` });
  }
  return entries;
}

function parseCafe(lines) {
  const entries = [];
  const sectionHeaders = ['Food', 'Smoothies', 'Cold-Pressed Juices', 'Espresso-Based', 'Non-Coffee Beverages', 'Dessert'];
  for (const cols of lines) {
    const col0 = cols[0]?.trim();
    if (!col0 || sectionHeaders.includes(col0) || cols[1]?.trim() === 'Calories (kcal)') continue;
    const calories = parseFloat(cols[1]);
    if (isNaN(calories)) continue;
    entries.push({ name: `${col0} [NS Cafe]` });
  }
  return entries;
}

async function getAllNotionFoodNames() {
  const names = new Set();
  let cursor;
  do {
    const res = await notion.databases.query({ database_id: DB_ID, page_size: 100, start_cursor: cursor });
    for (const page of res.results) {
      const n = page.properties['Food Name']?.title?.[0]?.text?.content;
      if (n) names.add(n);
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return names;
}

async function main() {
  const csvPath = '/tmp/ns_foods.csv';
  if (!fs.existsSync(csvPath)) {
    console.error('❌ /tmp/ns_foods.csv not found. Upload the spreadsheet CSV to /tmp/ns_foods.csv first.');
    process.exit(1);
  }

  const raw = fs.readFileSync(csvPath, 'utf8');
  const allLines = raw.split('\n').map(l => l.split(','));
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

  const fromSheet = [
    ...parseLunch(sections.lunchEven, 'Even Week'),
    ...parseLunch(sections.lunchOdd, 'Odd Week'),
    ...parseDinner(sections.dinnerOdd, 'Odd'),
    ...parseDinner(sections.dinnerEven, 'Even'),
    ...parseCafe(sections.cafe),
  ];
  console.log(`Sheet entries: ${fromSheet.length}`);

  console.log('Fetching Notion Known Foods DB...');
  const notionNames = await getAllNotionFoodNames();
  console.log(`Notion entries: ${notionNames.size}`);

  const missing = fromSheet.filter(e => !notionNames.has(e.name));
  const extra   = [...notionNames].filter(n => !fromSheet.some(e => e.name === n) && (n.includes('[Dinner') || n.includes('[Lunch') || n.includes('[NS Cafe]')));

  if (!missing.length && !extra.length) {
    console.log('\n✅ All NS entries match. DB is complete.');
    return;
  }

  if (missing.length) {
    console.log(`\n❌ Missing from Notion (${missing.length}):`);
    missing.forEach(e => console.log(`  - ${e.name}`));
  }
  if (extra.length) {
    console.log(`\n⚠️  In Notion but not in sheet (${extra.length}):`);
    extra.forEach(n => console.log(`  - ${n}`));
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
