// One-time migration: pull all known foods from Notion → SQLite
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const Database = require('better-sqlite3');
const { Client } = require('@notionhq/client');
const path = require('path');

const DB_PATH = process.env.SQLITE_PATH || path.join(__dirname, '../data/bot.db');
const db = new Database(DB_PATH);
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const NOTION_DB = process.env.NOTION_KNOWN_FOODS_DS;

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

const upsert = db.prepare(`INSERT INTO known_foods (name,serving,calories,protein,carbs,fat,day_of_week,notes,source)
  VALUES (?,?,?,?,?,?,?,?,?)
  ON CONFLICT(name) DO UPDATE SET serving=excluded.serving,calories=excluded.calories,protein=excluded.protein,carbs=excluded.carbs,fat=excluded.fat,day_of_week=excluded.day_of_week,notes=excluded.notes,source=excluded.source`);

async function main() {
  if (!NOTION_DB) { console.error('NOTION_KNOWN_FOODS_DS not set'); process.exit(1); }
  let count=0, cursor;
  do {
    const res = await notion.databases.query({ database_id:NOTION_DB, page_size:100, start_cursor:cursor });
    for (const page of res.results) {
      const p = page.properties;
      const name    = p['Food Name']?.title?.[0]?.text?.content;
      const serving = p['Serving Size']?.rich_text?.[0]?.text?.content ?? '1 serving';
      const calories= p['Calories']?.number ?? 0;
      const protein = p['Protein (g)']?.number ?? 0;
      const carbs   = p['Carbs (g)']?.number ?? 0;
      const fat     = p['Fat (g)']?.number ?? 0;
      const day     = p['Day of Week']?.rich_text?.[0]?.text?.content ?? null;
      const notes   = p['Notes']?.rich_text?.[0]?.text?.content ?? '';
      const source  = p['Source']?.select?.name ?? 'Network School';
      if (!name) continue;
      upsert.run(name, serving, calories, protein, carbs, fat, day||null, notes, source);
      count++;
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  console.log(`✅ Migrated ${count} entries from Notion → SQLite`);
  console.log(`Total in known_foods: ${db.prepare('SELECT COUNT(*) as c FROM known_foods').get().c}`);
}

main().catch(err=>{ console.error(err.message); process.exit(1); });
