// Normalize existing exercise data to canonical catalog names. DRY-RUN by default; --apply to write.
// Always back up data/bot.db before --apply. All work runs through db.js (single connection).
require('dotenv').config();
const db = require('../src/db');
const APPLY = process.argv.includes('--apply');
const r = db.migrateExerciseNames(APPLY);
console.log((APPLY ? '✅ APPLIED' : '🔍 DRY-RUN') + `: known_exercises renames=${r.keRenames}  merges(rows deleted)=${r.keMerges}  |  workout_log rows updated=${r.wlUpdates}`);
console.log('examples:\n  ' + r.examples.join('\n  '));
