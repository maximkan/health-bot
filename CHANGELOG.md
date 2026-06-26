# Changelog

All notable changes to the health-bot, newest first. Each entry says what changed and why, in plain terms, with the files touched. (Work predating this file lives in git history.)

## 2026-06-26

### Golf logging — button wizard (#1, final)
- **Golf now gathers the real numbers with quick buttons** instead of guessing. Estimating was too rough (a round is 3–5h; "did simulator" tells us nothing), so the wizard asks — but only for what you didn't already say, one tap each:
  - **On course** → 🚶 Walking / 🛺 Cart → holes (9 / 18 / ✏️) → duration (2–5h / ✏️). MET walking 4.3 / cart 3.5.
  - **Driving range** → intensity 😌/💪/🔥 → balls (50/100/150/✏️) → duration (30m–1.5h / ✏️). MET 2.5/3.0/3.5.
  - **Simulator** → holes only. No walking + shared bays make wall-clock dishonest (4 players won't divide their time), so duration is derived from holes (~4 min active play/hole). MET 2.5.
- If you type it all inline ("18 holes on a cart in 3.5h") it skips straight to the preview; if you just say "played golf" it asks the type first. ✏️ Other lets you type an exact number/time. Calories = MET × your weight × duration (locked, so it won't be silently recomputed). Verified across 8 flows + real-parse routing. — `bot.js` (new golf wizard), `handlers/workout.js`, `utils/keyboards.js`

### Golf simulator option + duplicate-merge fix (#6)
- **Golf buttons are now 🚶 Walking / 🛺 Cart / 🖥 Simulator** (you can't play holes at a range, so "Range" → "Simulator"). Simulator = indoor, stand-and-swing, no walking — MET 2.5 (lowest; researched estimate). Walking 4.3 / Cart 3.5 / Simulator 2.5. — `utils/keyboards.js`, `bot.js`, seed
- **#6 fix:** the exercise normalizer now keeps digits, so "Golf - 12 Holes" and "Golf - 18 Holes" (and "21s" etc.) no longer collapse into one entry. — `utils/exnorm.js`

### Workout mutation + golf variants (#1, #2)
- **Workout corrections now stick (#2).** "make it 600 cal" / "way less, like half" → honored (manual override, no longer overwritten by the MET recompute); "count it as a 5km walk" / "golf with a cart" → re-classifies the activity and recomputes with the right MET. — `claude.js` (applyWorkoutCorrection), `bot.js`
- **Golf is asked how it was played (#1).** A golf preview now shows 🚶 Walking / 🛺 Cart / 🎯 Range buttons (unless the variant is already clear) — tapping recomputes with the correct MET: Walking 4.3, Cart 3.5, Driving Range 3.0 (research/Compendium values; range corrected 3.5→3.0). Defaults to walking if you just log. — `bot.js`, `handlers/workout.js`, `utils/keyboards.js`, seed
- Recommendation noted for the driving range: time-based (MET 3.0), optionally refined by intensity; ball-count is a poor calorie proxy.

### Exercise library — integration (the 5 fixes)
- **Sports calories fixed.** `computeWorkoutCalories` now looks up the catalog MET for cardio/sports — tennis 60min/100kg went from 351 kcal (wrong MET 3.5) to **732 kcal (MET 7.3)**; golf-18-holes → 4.3, hiking → 6.0, yoga → 2.5. Strength stays density-based. Per-user weight handling was already correct (uses latest weigh-in). — `handlers/workout.js`, `db.js`
- **Exercise names standardized on log.** Each logged exercise resolves to a canonical catalog name via a shared normalizer (case + plural + safe stemming — "Jumping Squats" = "jump squats", "running" = "run"). Kills new duplicates. — `db.js`, `utils/exnorm.js`, `handlers/workout.js`, `bot.js`
- **Unilateral reps consistent.** Catalog flags 89+ exercises unilateral; parse prompts now always output TOTAL reps ("10 each side" → 20) — fixes the false-progression bug from reps flipping 10↔20. — `claude.js`
- **History migrated.** One-time normalization deduped existing `known_exercises` (82 → 77 for the main user — Russian Twist/Twists, Hexagon case-dups, Run/Running merged; genuinely-different exercises kept separate) and rewrote workout-history names. Backup taken first. — `db.js`, `scripts/migrate-exercises.js`
- **Custom exercises captured.** An unrecognized exercise is auto-saved as a per-user catalog entry (with a unilateral guess), so it gets one canonical identity and stops duplicating. (Richer "describe it / answer questions" enrichment is a follow-up.) — `db.js`

### Exercise library — foundation (catalog seed)
- **New `exercise_catalog` table, seeded with 907 entries.** 868 strength/mobility exercises from the open free-exercise-db (canonical name, muscles, equipment, mechanic) + a curated 39-entry cardio/sport MET table from the Compendium of Physical Activities (Tennis 7.3, Golf-walking 4.3, Hiking 6.0, Yoga 2.5, …). 89 exercises auto-flagged unilateral (lunges/split squats/step-ups/one-arm) to fix per-side rep counting. — `scripts/seed-exercise-catalog.js`
- Not wired into the bot yet (no behavior change). Next: resolve-on-log (alias matching), catalog-MET calorie lookup (fixes tennis/golf being computed at the wrong ~3.5 MET), unilateral rep handling, history normalization migration, and custom-exercise creation.

### Data-quality — food display cleanup
- **Internal day/week markers no longer leak into logged meal names.** B5 was logging the raw known-food name including tags like "[Odd Week]" / "[Dinner Tue Odd]"; those are internal DB markers for day determination, not user-facing. Now stripped from the displayed/logged name (dish + base + variant kept). Verified clean across every day of the week, both odd/even, lunch + dinner. — `handlers/meal.js`

## 2026-06-25

### Cost/latency pass — batch 4 (B2 fewer classify calls, B4 prompt caching)
- **One classify call per message instead of two (B2).** The router used to run a no-history rename check AND a history-aware classify on every message. Now it runs the history-aware classify once; the no-history rename re-check only fires when the first pass found nothing actionable (where a history-poisoned rename would land). Most messages — logs, workouts, plans, coach questions — are now ~1 Haiku round-trip faster. Rename still works (verified). — `bot.js`
- **Prompt caching on the reused Sonnet prompts (B4).** The big meal-analysis prompt and the coaching prompt are now cached, so back-to-back meals and multi-turn coaching pay ~10% instead of 100% for re-sending the same system prompt. One-off daily calls (summaries, weekly review, proactive) are intentionally NOT cached — caching a once-a-day call costs more, not less. Verified caching engages (cache read confirmed) and coach answers are unchanged. — `claude.js`

### Cost/latency pass — batch 3 (B5 instant repeat-food logging)
- **Any food you log the same way logs instantly, no AI** — works for every user, not just menu users. When a text message resolves to exactly one of your known foods (a yogurt, a smoothie, a protein shake, or a fully-specified menu item like "double chicken lunch sweet potato"), the macros come straight from `known_foods`. Day-specific menus are scoped to today; plain repeats match by name. — `handlers/meal.js`
- **Day-scoped like the AI:** a menu reference (protein + variant + carb, e.g. "double beef sweet potato") matches **today's** menu; stale cross-day auto-saved copies are ignored so they can't cause false ambiguity. Matches the existing AI behavior exactly, just instant.
- **Safety first:** anything ambiguous goes to the AI, unchanged — underspecified ("double chicken" → which carb?, "chicken sweet potato" → regular/double?), any modifier ("half", "no rice", a quantity), caffeinated drinks (caffeine isn't stored), or a novel food. The matcher only "wins" when it's 100% certain, and you still see the preview + confirm. It can never log the wrong thing.

### Cost/latency pass — batch 2 (B1 inline buttons)
- **Tap-to-confirm instead of typing.** Meal and workout previews now show **✅ Log · ✏️ Edit · ❌ Cancel** buttons; the live-workout prompt shows a **🏁 Finished** button. Tapping is instant (no AI round-trip) and you can still type "ok"/"done" as before. Buttons survive a restart (they read the DB-backed pending state). — `bot.js`, `handlers/meal.js`, `handlers/workout.js`, new `utils/keyboards.js`
- Verified: Log writes the entry + clears state, Cancel cancels, Edit keeps the preview open, Finish names the session (e.g. "Leg Day") and moves to confirm.

### Cost/latency pass — batch 1 (B3 parsers→code, B6 model fixes)
- **`nameWorkout` is now pure code, not an AI call.** Live-workout naming (Leg Day / Upper Body / Mixed Strength & Cardio / etc.) is a deterministic keyword lookup — instant, free, and verified to reproduce the AI's labels on real sessions (8/8). — `claude.js`
- **Cheaper model for `parseCorrection`** (what kind of correction is this?): Sonnet → Haiku — same results, ~3–5× cheaper. — `claude.js`
- (Tried `isConversationContinuation` → Haiku too, but tests caught Haiku over-inheriting context on a nuanced case — reverted to Sonnet. Low-volume call, so no real loss.)
- **Proactive nudge skips the AI when there's nothing to flag.** The nudge prompt already returns "OK" when no item is flagged, so we now skip the Sonnet call entirely on those ticks (most of them). — `cron.js`
- (Kept `recalculateTargets` on Sonnet — rare and high-stakes nutrition math; `parseSleepQuality` stays AI — it needs to tell a real rating from an incidental number like "had 4 eggs".)

### Systemic root-cause fixes
- **Restarts no longer lose in-progress conversations (F1).** Pending states (meal confirm, morning quality, live workout, etc.) now persist to a `pending_states` DB table instead of an in-memory Map, so a deploy/restart mid-conversation doesn't drop the user's flow. — `db.js`, `bot.js`
- **Eliminated intermittent "works then randomly fails" (F2).** Set `temperature: 0` on the 24 classifier/parser/guard calls (kept the creative coach/summary calls as-is), so the same input classifies consistently. — `claude.js`

### Bug fixes (the 10 reported issues)
- **#1/#4/#5 — early-morning food/protein nags.** The proactive nudge no longer tells you "nothing logged / no protein yet" in the first 4h after waking; a protein shortfall only flags in the evening; added a deterministic hard gate as backstop. — `cron.js`
- **#2/#8 — hallucinated weight reasoning & weekly averages.** Weekly calorie/macro averages, running total vs budget, days-over-target, and weight trend are now precomputed in code and injected as authoritative facts, so the coach stops doing (and botching) the math or blaming a single day. — `ask.js`
- **#3 — "Invalid time value" crash on full analysis.** Fixed a field-name mismatch (`.logged_at` → `.date`) and the FULL_ANALYSIS + COACH_QUESTION double-fire that ran the analysis twice. — `ask.js`, `bot.js`
- **#6 — runs/cardio dropped.** Live and text workout parsers now capture distance ("1km" → 1000m, "1.5k" → 1500m) and timed cardio; salvage for improvised `distance_km`. — `claude.js`
- **#7 — meal corrections.** A refinement ("mostly beef, no sauce") now recomputes the macros instead of only relabeling; a question asked during a meal preview is answered instead of being silently logged as a "yes" (reordered the confirm/question branches + tightened the confirm guard). — `claude.js`, `bot.js`
- **#9 — backwards target proposal.** Suppressed the contradictory "you're losing too slow → eat more (-200)" message (the safe-calorie floor was inverting the direction); the label now matches the real change; raised the noise floor; the weekly review now affirms a clean week instead of inventing a fix. — `bot.js`, `claude.js`
- **#10 — wake-time parsing.** "gm, woke up 9" now parses to 09:00 instead of falling back to the message-receipt time (bare-hour parsing, scoped to the wake flow). — `time.js`, `bot.js`

### Other improvements (earlier in the session)
- **Sleep attribution** is now consistent (bed-day) across the coach "this week" view and the Monday review. — `db.js`
- **Workout naming**: live-logged sessions are named by muscle focus (Leg Day / Upper Body) instead of a hardcoded "Gym"; fixed the day-summary showing `undefined` for the workout name. — `bot.js`, `claude.js`, `day.js`
- **Sleep quality**: saved at wake (never lost if you forget to rate), backfillable any time, with a single reminder. — `db.js`, `cron.js`, `bot.js`, `claude.js`
- **Summary/coach tone**: macro tolerance band (a few grams over isn't a ⚠️), emoji-sentiment rules, no invented "minutes left in the evening" deadlines, under-target calories framed neutrally. — `claude.js`, `day.js`
