# Changelog

All notable changes to the health-bot, newest first. Each entry says what changed and why, in plain terms, with the files touched. (Work predating this file lives in git history.)

## 2026-06-25

### Cost/latency pass — batch 3 (B5 instant menu logging)
- **Fully-specified NS menu meals log instantly, no AI.** When a text meal message resolves to exactly one of today's menu items with the variant pinned and no modifiers (e.g. "double chicken lunch sweet potato"), the macros come straight from `known_foods` — instant, free, exact. — `handlers/meal.js`
- **Safety first:** anything ambiguous still goes to the AI, unchanged — no variant ("double chicken lunch"), base ambiguity, any modifier ("half", "no rice", a quantity), drinks/coffee (caffeine), dinner (needs portions), or a novel food. The code only "wins" when 100% certain, so it can never log the wrong thing. Verified 11/11 against the real menu + correct macros on save.

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
