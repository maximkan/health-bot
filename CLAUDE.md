# Health Bot — Claude Code Guide

## Project Overview
Telegram health coaching bot. Multi-user. Tracks nutrition, workouts, sleep, plans, body measurements, recovery. Uses Claude for intent classification, meal analysis, coaching responses, proactive nudges.

---

## Architecture & Data Flow

**SQLite (`data/bot.db`) is the ONLY source of truth.** Never trust Notion for reads.

- **Notion** — write-only mirror, and only for users with `notion_enabled = 1`. Never query Notion for data.
- **GCal** — only for users with `gcal_refresh_token` set.
- **Known foods** — stored in SQLite `known_foods` table, queried via `db.getKnownFoodsForDay()`. Lives in `notion.js` for legacy reasons but reads only from SQLite.
- **Targets** — stored in SQLite `targets` table. `notion.getTargets(chatId)` and `notion.getTargetsText(chatId)` both read from SQLite via `db.getTargetsFromDb`.

### Two legitimate Notion reads (by design)
1. `syncNotionPlansToDb(chatId, dateStr)` in `plans.js` — intentional one-way import: reads Notion plans and writes them into SQLite. Gated on `config.notion.db.plans` existing.
2. `notion.getEntriesForDay(...)` in `correction.js` — reads Notion page IDs to correct entry timestamps. Returns `[]` if Notion not configured. Only meaningful for `notion_enabled` users.

### Message flow
```
Telegram → bot.js → classify (Haiku, no history for RENAME) → pendingStates or routeMessage → handlers
```

Key routing in `bot.js`:
- `RENAME` is classified **without history** first (history gets poisoned by failed attempts)
- `DELETE` handled before the main switch
- `CORRECTION` handled before the main switch
- Final fallthrough: `routeMessage(bot, msg, chatId, userState, earlyIntents)`

### Context injection (ask.js `buildDayContext`)
Always builds: current time (user's TZ), wake time, today's totals from SQLite, meals logged, workouts, plans.
**Pattern**: `[dayCtx, context, trendCtx].filter(Boolean).join('\n')` — `dayCtx` must ALWAYS be present. Never use `context || dayCtx` (drops live data when context exists).

---

## Server & Deployment

- **Server**: `204.168.220.82`
- **Entry point**: `/root/health-bot/index.js` → `require('./src/bot')`
- **pm2 process**: `health-bot`
- **Deploy pattern**: `scp local/file.js root@204.168.220.82:/root/health-bot/src/file.js && pm2 restart health-bot`

### ⚠️ Critical: Two file locations
The server has stale legacy copies in `src/` root (`src/ask.js`, `src/day.js`, `src/meal.js`, etc.) that are NOT used. The live code is in `src/handlers/`. Always deploy to the correct path.

**Active files**:
- `src/bot.js` — main router (imports from `./handlers/*`)
- `src/claude.js` — all Claude API calls (also copied to `src/handlers/claude.js`)
- `src/db.js` — all DB operations
- `src/cron.js` — scheduled jobs
- `src/notion.js` — Notion write-only sync + SQLite-backed helpers (getTargets, getKnownFoodsContext, addKnownFood)
- `src/handlers/` — ask, meal, workout, day, plans, correction, sleep, recovery, body, onboarding

When deploying `claude.js`: always `scp` to BOTH `src/claude.js` AND `src/handlers/claude.js`.

---

## Per-user feature flags (in `user_state`)

| Flag | Meaning |
|------|---------|
| `notion_enabled` | Notion writes are mirrored for this user |
| `gcal_refresh_token` | GCal integration active |
| `timezone` | User's IANA timezone string (e.g. `Asia/Kuala_Lumpur`) |
| `onboarded` | Onboarding complete |
| `current_chain_id` | Active conversation chain ID (stable across the whole Q&A thread) |
| `last_coach_message_id` | Telegram message_id of the last bot coaching reply |

All time calculations must use `getOffsetMs(state.timezone)` — never hardcode `+8h`.

---

## Conversation Chain System (ask.js)

This is the core of multi-turn coaching. Every Q&A exchange lives in a "chain" — a thread of messages under a stable ID.

### Tables
- **`coach_reply_chain`** — live messages in an open chain: `(chat_id, coach_message_id, role, content, created_at)`
- **`coach_conversations`** — compressed summaries of closed chains: `(chat_id, summary, created_at)`

### Key fields in `user_state`
- **`current_chain_id`** — stable across the whole conversation thread. Set when chain opens, cleared when chain closes. This was the critical fix: previously the chain ID changed on every bot reply, so each `handleCoachReply` call saw an empty chain.
- **`last_coach_message_id`** — Telegram message_id of latest bot reply, used to detect "reply to bot" gestures.

### Flow in `handleAsk`
1. Read `current_chain_id` from state
2. If chain exists: inject last 6 messages as `recentChainCtx`
3. If no chain: check `getRecentConversationSummaries` + `isConversationContinuation` to inherit previous context
4. Save user message to chain under stable `chainId`
5. Generate answer via `claude.askCoach`
6. Save assistant message to chain
7. If `countExchanges >= 8`: call `closeChain`, clear `current_chain_id`
8. Else: update `current_chain_id` in state

### Flow in `handleCoachReply`
- Uses `state.current_chain_id || coachMessageId` as chain key — never just the replied-to message ID
- Saves both user and assistant messages under same stable `chainId`
- Updates `current_chain_id` after each reply

### `closeChain(chatId, chainId)`
- Summarises the chain via Claude
- Saves summary to `coach_conversations`
- Updates user profile from the conversation
- Clears `current_chain_id` in state (in `finally` block — always runs)

### `isConversationContinuation(text, summary)`
- Sonnet call: does this new message continue the topic of a recently closed chain?
- Only called when there is NO active chain
- Allows context to survive a meal log or other chain-breaking event

### Chain reset at 8 exchanges
When `countExchanges >= 8`, the chain closes and compresses. The next message starts fresh but can inherit context via `isConversationContinuation`. This prevents unbounded context growth while preserving continuity.

---

## Workout Calorie Estimation

### MET-based calculation
`Calories = MET × weight_kg × hours`

MET values for cardio: Rowing 7.0, Running 8km/h 8.0, Swimming 7.0, Tennis 7.3, Golf walking 4.3, Yoga 2.5, Hiking 6.0.

For weight training, MET is chosen by **density** (`total_sets / duration_min`):
- `> 0.4` (circuit/superset): MET 5.5
- `0.25–0.4` (normal gym pace): MET 4.5
- `< 0.25` (heavy compound, long rests): MET 3.5

### Duration estimation when not stated
If user logs exercises without a duration, Claude estimates:
- `total_sets × 2.5 min` for strength (includes rest)
- `total_sets × 1.5 min` for lighter/cardio exercises
- Round to nearest 5 min, then compute density and calories normally
- **`calories_burned` and `duration_min` must never be null when exercises are present**

### Sets/reps rules
- `"3x10"` → sets=3, reps=10
- `"60 deadlifts"` (no sets) → sets=1, reps=60
- `"30 each leg"` → reps=30 (the stated number per side)
- Always populate both sets AND reps — never leave both null

---

## Proactive Nudge System (cron.js)

### Windows
Three random daily windows per user (local time): `[10,13]`, `[14,17]`, `[19,21]`. One fire per window per day, scheduled at 8am local time via `scheduleProactiveForDay`.

### Meal-absence guard
**Do not use a hard `minutesAwake < 240` return.** Proactive nudges for caffeine, bad food patterns, protein history, etc. are valid at any time after wake. The guard is data-level:
- `noMealsYet` flag only set true when `minutesAwake >= 240 && meals.length === 0`
- When `minutesAwake < 240 && meals.length === 0`: `today.meals` is **omitted** from the Claude payload entirely — Claude physically cannot see an empty meals array and cannot construct a "nothing logged yet" message

### `checkProactivePatterns` prompt rules
- Only flag one thing — the single most important
- `todayAlert` field: do not re-flag the same category that was already sent today
- `recentAlerts`: if pattern persists/worsens since last alert → escalate tone. If improved → don't repeat.
- If nothing genuinely needs flagging → return `"OK"` (not null, not empty)

---

## Scheduled Jobs (cron.js)

### Per-user daily crons (timezone-aware)
- `19:30` local — evening check (`runEveningCheckForUser`)
- `08:00` local — schedule proactive windows + bed nudges for the day

### Proactive
- Three windows per day, randomised fire time within each window
- `scheduleProactiveForDay(chatId)` called at 8am local and on server startup

### Bed nudges
- `scheduleBedNudgesForDay(chatId)` — based on `bed_time_pref`, schedules two nudges
- Called on 8am cron and also `scheduleAllBedNudges()` on startup

### Untimed task reminders
- **Not a global UTC cron.** Per-user, anchored to wake time.
- `scheduleUntimedRemindersForUser(chatId, wakeMs)` — called from bot.js immediately after morning quality is processed
- Schedules fires at `wakeMs + 2h`, `+4h`, `+6h`, `+8h`, `+10h` via `scheduleOnce`
- Skips slots already in the past (safe for server restarts)
- On startup: re-scheduled for all users with `status === 'awake'`
- Each slot checks `getPendingUntimed` at fire time — if tasks are done, nothing sends

### GCal sync
- `*/30 * * * *` UTC — `runGCalSync` — bidirectional: GCal→DB and DB→GCal

---

## End-of-Day Summary Macro Rules

In `generateDaySummary`, Claude must follow explicit macro evaluation:
- Protein **under** target → flag it (bad)
- Protein **at or over** target → good
- Carbs **under** target → fine, do NOT say "over"
- Fat **under** target → fine, do NOT say "over"
- Only say a macro is "over" if the actual number is **strictly greater than** the target

This rule exists because Claude defaulted to saying both carbs and fat were "over" when they were under target, due to vague "macro numbers vs targets" instruction.

---

## User Preferences & Working Style

These are non-negotiable expectations for every session:

- **NEVER write or deploy code without discussing first.** When given a bug or issue: investigate, trace the root cause, explain findings, recommend fixes with options. The user decides what to implement. Only write code after explicit approval. No exceptions — not even for "obvious" one-line fixes.
- **Verify on the server before claiming a fix works.** SSH + grep the deployed file. "It should work" is not acceptable — confirm it does.
- **Never claim you tested something you didn't.** If a test was run with real API calls on the server and produced real failures (wrong time of day, actual API response format, etc.), say so explicitly. If you haven't run it, say so.
- **Fix the right thing.** Before touching code, identify exactly which function/line causes the issue. The "Issue 3" pattern: I was asked to fix the proactive nudge firing before 4h, and instead changed the untimed reminder guard — a completely different function. Read the code, trace the path, fix the actual cause.
- **Don't fix symptoms.** The proactive nudge sent "nothing logged" because Claude saw `meals: []` + `minutesAwake: 136`. The symptom fix was adding a hard return at < 240min. The root fix was hiding the empty meals data. Symptom fixes create new bugs.
- **Short answers.** No trailing summaries of what you just did. No "here's what I changed" paragraphs after a deploy. The user can read the diff.
- **Ask before architectural changes.** Single-function bug fix → just do it. Changing how a whole system works → surface the approach first.
- **One fix, one deploy.** Don't bundle unrelated changes. If two bugs need fixing, state both and confirm scope before touching code.
- **Always test immediately after coding.** Any feature or fix must be followed by real tests with real entries on the server before reporting it done. Not classification-only tests — the actual flow, with real DB state, real API calls where needed, and verification of the actual output.
- **Never respond without 100% confidence and 100% reasoning. Never lie or hallucinate.** If you don't know something, say so explicitly. Do not fill gaps with assumptions and present them as facts. Every claim must be traceable to actual code, logs, or data you have read in this session.

---

## Workflow Rules

### Before writing any code
1. **Read the deployed server file**, not just the local copy — they can diverge.
2. **Trace the actual code path** for the failing case. Check pm2 logs. Don't assume.
3. **Check which DB file** is being used — `data/bot.db`, not `data/health.db`.
4. Test DB queries with `node -e "require('dotenv').config(); ..."` on the server before assuming results.

### Before deploying
1. Verify the correct destination path (`src/` vs `src/handlers/`).
2. If editing `claude.js`, deploy to both locations.
3. Check `pm2 restart` output — if status isn't `online`, investigate immediately.

### Coding
- **Use Claude for intent detection, always.** Never regex/keyword match user messages.
- **RENAME and similar intents** must be classified without chat history — history gets poisoned by failed prior attempts.
- **Don't make multiple small sequential fixes** without understanding root cause. Each fix that misses the root cause adds noise.
- **Never delete DB rows without asking permission.** Especially `chat_history`, `coach_reply_chain`, `meal_log`.
- **Don't touch unrelated code** when fixing a specific bug.
- **Notion is write-only.** Never add new Notion reads. All data lives in SQLite.

---

## Non-negotiable Rules

### No keyword matching for intent detection — ever
**Never use keyword lists, regex, or string matching to decide what a user means.** Use Claude to classify intent. Keyword matching breaks on any phrasing variation, misses context, and has been a source of repeated bugs. The ONLY exceptions are data extraction (e.g. parsing a number from "last 10 days") and strict safety guards (e.g. detecting if a timestamp is valid). Routing decisions, "is this a trend question", "is this a plan" — all Claude.

### Issue review methodology
When something breaks: (1) check DB/logs for actual data before theorizing, (2) trace the exact code path, (3) raise findings with the user before touching any code, (4) fix root cause — never symptoms.

### Proactive timing
Never use a hard `minutesAwake < 240` return to block all proactive nudges. Suppress only the meal-absence data. Other nudge categories (caffeine, food quality, protein trends, workouts) are valid in the first 4 hours.

---

## Common Mistakes (anti-patterns we've hit repeatedly)

### Intent & routing
- **Classifying RENAME with history** → history gets poisoned when prior attempts failed → classifier returns GENERAL → handleAsk → coach says "I can't rename workouts". Fix: classify RENAME without history.
- **Keyword-gating historical data** → e.g. only injecting 7-day trend context when message contains "this week". Fix: always include relevant data, let Claude decide what to use.
- **Keyword/regex for user message parsing** → breaks for any natural phrasing variation. Always use Claude.
- **Safety net falls through to handleAsk** → when a rename/action lookup fails (entry not found), silently falling through to the coach instead of returning an error message.

### Conversation chain
- **Using `sent.message_id` as chain key** → chain ID changes every reply → each `handleCoachReply` sees an empty chain → all conversation context is lost. Fix: stable `current_chain_id` in state.
- **Clearing `current_chain_id` only in the happy path** → if `closeChain` throws, `current_chain_id` stays set → stale chain. Fix: clear in `finally` block.
- **Skipping `isConversationContinuation` check** → after a chain closes (e.g. post-meal-log), a follow-up question on the same topic gets no context. Fix: always check summaries when no active chain.

### Data & context
- **`context || dayCtx` pattern** → when meal/workout context is passed, dayCtx is dropped, Claude has no live nutrition data and hallucinates. Always use `[dayCtx, context].filter(Boolean).join('\n')`.
- **Known foods contamination** → date-specific entries like "Daily Summary – Apr 30" getting saved as known foods, then injected into every meal analysis as "1346 kcal today". Guard: never save entries matching `daily summary`, `day summary`, or `– MonthName Day` pattern.
- **Skipping nutrition line when 0 calories** → `if (t.calories > 0)` guard means empty days have no context → Claude invents numbers. Always inject the nutrition line even at 0.
- **Hardcoded timezone offset** → `+ 8 * 3600 * 1000` instead of `getOffsetMs(tz)`. All time calculations must use the user's actual timezone from `state.timezone`.
- **Macro direction in summaries** → vague "vs targets" prompt causes Claude to say "over" for under-target macros. Always include explicit under/over rules per macro.

### Notion
- **Adding new Notion reads** → Notion is write-only. Any new data need must be solved in SQLite.
- **Writing Notion without `notion_enabled` check** → always guard: `if (state.notion_enabled) notion.createXxx(...)`. The `notionEnabled(chatId)` helper in notion.js does this internally for most functions.

### DB operations
- **Opening `data/health.db` directly** → wrong file. Use `data/bot.db` or the `db` module.
- **`current_day_start` set during onboarding** → should only be set by GM (morning wake), never during onboarding. Onboarding sets `status: 'sleeping'`, `current_day_start: null`.
- **Modifying `known_foods` for wrong chatId** → always scope by `chat_id`.

### Deployment
- **Deploying to `src/meal.js`** instead of `src/handlers/meal.js` → stale legacy file, not imported by bot.js.
- **Not deploying `claude.js` to both paths** → `src/claude.js` and `src/handlers/claude.js` must match.

### Cron / scheduling
- **Global UTC cron for per-user time-sensitive reminders** → if user wakes at 8:10am and cron fires at 10:00am UTC, it may be < 120min since wake and skip entirely. Next fire at 12:00 is 3h50m after wake. Fix: per-user `scheduleOnce` anchored to actual wake time.
- **Hard `minutesAwake < 240` return in proactive** → blocks all nudges including caffeine/food-quality alerts that are valid early. Fix: suppress only the meals data field, not the whole function.

---

## Code Patterns & Key Functions

### DB
```js
db.getState(chatId)                              // full user state
db.getDayDataFromSQLite(chatId, dayStart)        // today's meals+workouts+totals
db.getDailyMealTotalsFromSQLite(chatId, dayStart)
db.getWeekDataFromSQLite(chatId, sinceMs)        // uses user's timezone
db.getHistoricalDataFromSQLite(chatId)           // all-time meals+workouts+sleep
db.getRecentLogs(chatId, 7)                      // last 7 days meals+workouts for rename/context
db.renameLog(type, id, newName)                  // 'meal' or 'workout'
db.getLogByBotMessageId(chatId, msgId)           // look up log entry by Telegram message id
db.saveBodyLog(chatId, data)                     // weight, body_fat_pct, bmi, etc.
db.getLastBodyMeasurement(chatId)                // most recent body_log row
db.getAllBodyMeasurements(chatId)                 // all body_log rows, ascending
db.getTargetsFromDb(chatId)                      // calories, protein, carbs, fat, weight_kg, goal_weight
db.saveCoachMessage(chatId, role, content, chainId)   // save to coach_reply_chain
db.getReplyChain(chatId, chainId)                // all messages for a chain
db.countExchanges(chatId, chainId)               // number of user+assistant turns
db.getRecentConversationSummaries(chatId, n)     // last n closed chain summaries
db.getPendingUntimed(chatId)                     // plans with no time, status='pending'
db.updatePlanStatus(id, status)                  // 'done', 'skipped', 'pending'
```

### Claude
```js
claude.classify(text, history)                   // intent array — use [] for rename/action-sensitive
claude.parseRenameIntent(text, recentLogs)        // {entry_id, new_name}
claude.askCoach(text, context, targets, knownFoods, userProfile)   // single-turn coach
claude.continueCoachReply(messages, targets)      // multi-turn coach chain
claude.isConversationContinuation(text, summary)  // bool — does this message continue that topic?
claude.checkProactivePatterns(data, targets, profile)  // nudge string or null
claude.generateDaySummary(dayData, targetsCtx, tdeeCtx, userProfile)
claude.generateEveningCheck(data, targetsCtx, userProfile)
claude.generateWeeklyReview(weekData, targetsCtx, userProfile)
claude.parseWorkout(text, knownExercisesCtx, weight_kg)
claude.parseMeal(text, ...)
claude.parseSleep(text)     // only call after SLEEP_LOG classification — throws on non-sleep input
claude.parseRecovery(text)  // returns [{protocol, rounds, sessions:[...]}] — unwrap array
claude.parsePlans(text)     // returns [{title, date, time,...}] — unwrap array
```

### Time utils
```js
getOffsetMs(tz)          // ms offset for a timezone string
getDateStrTz(tz)         // today's date string in user's timezone
nowContextTz(tz)         // "Current time: ..." line for context injection
```

### Cron exports
```js
cronSvc.scheduleUntimedRemindersForUser(chatId, wakeMs)  // call after morning quality processed
cronSvc.scheduleBedNudgesForDay(chatId)
cronSvc.scheduleUserDailyCrons(chatId)
cronSvc.scheduleOnce(chatId, atMs, fn)
cronSvc.cancelOnce(chatId, atMs)
cronSvc.cancelAllForChat(chatId)
```

---

## Known Foods Rules
`addKnownFood()` in `notion.js` must skip:
- `[Dinner` / `[Lunch` / `[NS Cafe]` prefix
- `daily summary` / `day summary` (case-insensitive)
- Date-specific names: `– Jan/Feb/.../Dec DD` pattern
- Only save recurring foods (no one-time date entries)

NS lunch menu: `R` = Regular protein, `D` = Double protein.

---

## Log Integration — where each log type is used

Every log table keeps full history forever (never deleted). All-time trends are always queryable.

| Log | Today context | Evening check | Proactive nudge | Weekly view | Full history |
|-----|:---:|:---:|:---:|:---:|:---:|
| meal_log | ✅ | ✅ | ✅ | ✅ | ✅ |
| workout_log | ✅ | ✅ | ✅ | ✅ | ✅ |
| body_log | ✅ | ✅ | ✅ | ✅ | ✅ |
| sleep_log | ✅ | ✅ | ✅ | ✅ + quality | ✅ |
| recovery_log | ✅ | ✅ | ✅ | ✅ | ✅ |

When adding a new log type: it must appear in ALL five columns above — `getDayDataFromSQLite`, `sendEveningCheck` checkData, `runProactiveForUser` recentData, `getWeekDataFromSQLite`, `getHistoricalDataFromSQLite`.

**When reporting multi-file changes**, use this table format to show what was added/fixed across the system.

---

## Testing

### Full test suite: `full_bot_test.js`
Run on the server only (real API calls):
```bash
ssh root@204.168.220.82 'cd /root/health-bot && node full_bot_test.js 2>&1 | tail -20'
```
260 cases covering all parsers and handlers. Last run: 259/260 passed, 1 warning (`parseSleep` throws on non-sleep input — acceptable, only called after SLEEP_LOG classification).

### Parser return shapes (critical)
- `parseRecovery` returns `[{protocol, rounds, sessions:[...]}]` — always unwrap: `const r = Array.isArray(v) ? v[0] : v`
- `parsePlans` returns `[{title, date, time,...}]` — always unwrap: `const p = Array.isArray(v) ? v[0] : (v?.plans?.[0] || v)`

### Conversation flow test: `real_convo_test.js`
Run on the server for end-to-end chain/context testing:
```bash
ssh root@204.168.220.82 'cd /root/health-bot && node real_convo_test.js 2>&1'
```
Tests: multi-turn Q&A → meal log → context continuity; 10-message chain reset; cross-topic context bleed prevention.

---

## Debugging Checklist
When something isn't working:
1. Check pm2 logs: `pm2 logs health-bot --lines 50 --nostream`
2. Verify deployed file matches local: `ssh` + `grep` the key function
3. Test the classifier: `node -e "require('dotenv').config(); const c = require('./src/claude'); c.classify('...', []).then(console.log)"`
4. Check DB state: `node -e "require('dotenv').config(); const db = require('./src/db'); console.log(db.getState(CHATID))"`
5. Check chat history for poisoning: recent assistant messages giving wrong responses become training signal for the classifier
6. Check known_foods table for contamination: date-specific or summary entries that inflate nutrition context
7. Check `current_chain_id` in state: if stuck non-null after conversation ended, closeChain may have failed silently
