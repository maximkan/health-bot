// Seeds a global exercise_catalog: strength/mobility from free-exercise-db (muscles, equipment) +
// a curated MET table for cardio/sports (Compendium of Physical Activities). Idempotent.
require('dotenv').config();
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, '..', 'data', 'bot.db'));

db.exec(`CREATE TABLE IF NOT EXISTS exercise_catalog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,                 -- NULL = global/pre-built; set = a user's custom exercise
  canonical_name TEXT NOT NULL,
  norm_name TEXT,                  -- normalized key for matching (lowercase, singularized, sorted words)
  aliases TEXT DEFAULT '[]',       -- JSON array of extra lowercase alias strings
  category TEXT,                   -- strength | cardio | sport | stretching | plyometrics | strongman | olympic
  equipment TEXT,
  primary_muscles TEXT DEFAULT '[]',
  secondary_muscles TEXT DEFAULT '[]',
  mechanic TEXT,                   -- compound | isolation
  met REAL,                        -- fixed MET for cardio/sport; NULL for strength (density-based)
  unilateral INTEGER DEFAULT 0,
  is_custom INTEGER DEFAULT 0,
  description TEXT,
  source TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_catalog_norm ON exercise_catalog(norm_name)`);
db.prepare('DELETE FROM exercise_catalog WHERE chat_id IS NULL').run(); // clean re-seed (shared norm may have changed)

const { normEx: norm } = require('../src/utils/exnorm'); // shared with the runtime resolver so keys match
const UNILATERAL = /lunge|split squat|bulgarian|single|one[- ]?arm|one[- ]?leg|each (side|leg|arm)|step[- ]?up|pistol|unilateral/i;

// ---- curated MET table: cardio + sports (Compendium of Physical Activities) ----
const MET = [
  ['Running', 9.8, 'cardio'], ['Jogging', 7.0, 'cardio'], ['Treadmill Running', 9.0, 'cardio'],
  ['Cycling', 7.5, 'cardio'], ['Stationary Cycling', 6.8, 'cardio'], ['Rowing Machine', 7.0, 'cardio'],
  ['Swimming', 7.0, 'cardio'], ['Elliptical Trainer', 5.0, 'cardio'], ['Jump Rope', 11.0, 'cardio'],
  ['Stair Climber', 9.0, 'cardio'], ['Walking', 3.5, 'cardio'], ['Brisk Walking', 4.3, 'cardio'],
  ['Hiking', 6.0, 'cardio'], ['HIIT', 10.0, 'cardio'], ['Circuit Training', 8.0, 'cardio'],
  ['Tennis', 7.3, 'sport'], ['Tennis (doubles)', 6.0, 'sport'], ['Badminton', 5.5, 'sport'],
  ['Squash', 12.0, 'sport'], ['Table Tennis', 4.0, 'sport'], ['Golf (walking)', 4.3, 'sport'],
  ['Golf (cart)', 3.5, 'sport'], ['Driving Range', 3.5, 'sport'], ['Basketball', 6.5, 'sport'],
  ['Soccer', 7.0, 'sport'], ['Volleyball', 4.0, 'sport'], ['Boxing', 7.8, 'sport'],
  ['Kickboxing', 7.5, 'sport'], ['Martial Arts', 7.8, 'sport'], ['Climbing', 8.0, 'sport'],
  ['Yoga', 2.5, 'sport'], ['Pilates', 3.0, 'sport'], ['Stretching', 2.3, 'stretching'],
  ['Skiing', 7.0, 'sport'], ['Snowboarding', 5.3, 'sport'], ['Skating', 7.0, 'sport'],
  ['Dancing', 5.0, 'sport'], ['Surfing', 5.0, 'sport'], ['Paddleboarding', 6.0, 'sport'],
];
const ins = db.prepare(`INSERT INTO exercise_catalog (chat_id,canonical_name,norm_name,aliases,category,equipment,primary_muscles,secondary_muscles,mechanic,met,unilateral,is_custom,source)
  VALUES (NULL,?,?,?,?,?,?,?,?,?,?,0,?)`);
const exists = db.prepare('SELECT 1 FROM exercise_catalog WHERE chat_id IS NULL AND norm_name=?');
const seedOne = (name, cat, equip, pm, sm, mech, met, src) => {
  const nn = norm(name); if (exists.get(nn)) return false;
  ins.run(name, nn, '[]', cat, equip, JSON.stringify(pm||[]), JSON.stringify(sm||[]), mech, met, UNILATERAL.test(name)?1:0, src);
  return true;
};

let n=0;
for (const [name, met, cat] of MET) if (seedOne(name, cat, 'bodyweight', [], [], null, met, 'compendium')) n++;

// ---- strength/mobility from free-exercise-db ----
const https = require('https');
https.get('https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json', res => {
  let data=''; res.on('data',c=>data+=c); res.on('end',()=>{
    const arr = JSON.parse(data); let s=0;
    const tx = db.transaction(() => { for (const e of arr) if (seedOne(e.name, e.category, e.equipment||'other', e.primaryMuscles, e.secondaryMuscles, e.mechanic, null, 'free-exercise-db')) s++; });
    tx();
    console.log('seeded:', n, 'cardio/sport (with MET) +', s, 'strength/mobility =', db.prepare('SELECT COUNT(*) c FROM exercise_catalog WHERE chat_id IS NULL').get().c, 'global catalog entries');
    console.log('sample sports:', db.prepare("SELECT canonical_name,met FROM exercise_catalog WHERE category='sport' LIMIT 6").all().map(r=>r.canonical_name+'('+r.met+')').join(', '));
    console.log('unilateral flagged:', db.prepare('SELECT COUNT(*) c FROM exercise_catalog WHERE unilateral=1').get().c, 'e.g.', db.prepare('SELECT canonical_name FROM exercise_catalog WHERE unilateral=1 LIMIT 5').all().map(r=>r.canonical_name).join(', '));
  });
});
