# Changelog

All notable changes to the health-bot, newest first. Each entry says what changed and why, in plain terms, with the files touched. (Work predating this file lives in git history.)

## 2026-06-25

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
