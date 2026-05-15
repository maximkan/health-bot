# Health Bot — Product Specification

## What It Is

A personal health coaching system that runs as a Telegram bot. The user logs everything — meals, workouts, sleep, recovery, body measurements, plans — in plain text or photos. The bot tracks, analyses, and coaches based on actual logged data. No manual entry forms, no dashboards to maintain. You talk to it like a person.

Current state: fully functional Telegram bot, single user (Max), all core logic built. This document is the foundation for converting it into a multi-platform app.

---

## Core Philosophy

- **Input is natural language.** You don't fill in fields. You say "just had chicken rice and a protein shake" or "did legs, squats 4x10 at 100kg". The bot parses it.
- **The bot asks nothing it can figure out.** If you log a meal, it analyses it. It doesn't ask "was this breakfast or lunch?"
- **All data is local.** SQLite on the server. Google Calendar is a write-only mirror for scheduling. Notion is personal tooling for the current user — not a product feature.
- **Coaching is contextual.** Every response the bot gives is based on actual logged data from today, this week, and all-time history — not generic advice.

---

## Feature Set

### 1. Nutrition Tracking

**What the user does:** logs food in plain text or photo.

**What the bot does:**
- Parses meal name, calories, protein, carbs, fat, caffeine
- Identifies meal type (Breakfast, Lunch, Dinner, Snack, Drink) based on content and time of day
- Builds a running daily total against targets
- Maintains a "known foods" database — foods logged repeatedly get remembered with their macros, so future logs are faster and more accurate
- Supports photo logging: user sends a food photo (with or without caption), bot analyses visually + any description
- Supports retroactive logging: "had this yesterday morning" — bot assigns to previous day

**Targets tracked:** calories, protein, carbs, fat (per user, adjustable)

**Known foods system:** recurring items are saved and reused. Prevents contamination from one-off entries (e.g. daily summaries, restaurant names). Items are scoped per user.

---

### 2. Workout Tracking

**What the user does:** logs a workout in plain text after it's done, or starts a live session and logs exercises one at a time mid-workout.

**What the bot does:**
- Parses workout name, activity type, exercises (with sets, reps, weight)
- Estimates calories burned using MET × bodyweight × duration
- If duration is not stated, estimates it from total sets (×2.5 min/set for strength, including rest)
- Converts weight units automatically (lbs → kg)
- Classifies activity type: legs, push, pull, core, cardio, sport, full body, etc.
- Supports custom exercises with descriptions — evaluates them as real exercises, not just name strings
- After logging, automatically compares to the most recent previous session of the same type and posts a progress note (e.g. "squats up 5kg since your last legs day")

**Live workout mode (WORKOUT_START):**
- Triggered by "started my workout", "at the gym", etc.
- User logs exercises one at a time mid-session
- Bot tracks them as they're logged
- Session ends when user says done — bot compiles full workout, estimates calories, posts summary

**Strength MET by density:**
- Circuit/superset style (many sets, short rest) → MET 5.5
- Normal gym pace → MET 4.5
- Heavy compound, long rests → MET 3.5

**Known exercises:** custom exercises can be saved with their typical values, so future logs use them as defaults.

---

### 3. Sleep Tracking

**What the user does:** says GM in the morning (triggers wake flow). Optionally logs bed time at night before sleeping.

**What the bot does:**
- Calculates sleep duration from bed → wake timestamps
- Asks for sleep quality (1–5 scale)
- Stores sleep log: bed time, wake time, hours, quality
- Tracks sleep trends over time (weekly averages, quality patterns)

**Morning wake flow:**
1. User says GM (optionally with a time: "gm, woke up at 9" uses that as wake time)
2. Bot replies with sleep duration + asks quality
3. If bed time wasn't captured the night before, bot asks for it retroactively
4. After quality confirmed: day starts, catchup from yesterday is offered if anything was missed

---

### 4. Recovery Tracking

**What the user does:** logs sauna, cold plunge, contrast therapy sessions.

**What the bot does:**
- Parses protocol type: single, contrast (alternating hot/cold), custom
- Parses rounds, duration per session, temperature
- Handles uniform rounds ("same every round") and varied rounds
- Stores full session detail in `recovery_log`

**Supported types:** Sauna, Cold Plunge, Cold Shower, Ice Bath, Steam Room, Hot Tub.

---

### 5. Body Measurements

**What the user does:** logs weight and optionally body fat %.

**What the bot does:**
- Stores body log: weight, body fat %, BMI (computed), date
- Tracks trend over time
- Used in weekly reviews and full progress analysis to show rate of change, projected goal timeline

---

### 6. Pre-Bed Flow

**Triggered:** when user says GN / good night / going to bed.

**What the bot does:**
1. Asks "any plans for tomorrow?" — user can name tasks/events or say nothing
2. Saves any plans to tomorrow's date
3. Says good night
4. Schedules bed nudges at 10pm and 11pm local time if user hasn't gone to bed yet — sent as a gentle reminder

**Bed time logging:** the GN message is timestamped as bed time. If user forgets GN and logs it retroactively in the morning ("went to bed at 1am"), the bot accepts that in the morning wake flow.

---

### 7. Plans & Reminders

**What the user does:** says things like "I have a golf lesson tomorrow at 3pm" or "remind me to take creatine".

**What the bot does:**
- Classifies as timed (specific time) or untimed (no time)
- Saves to plans table with date, time, text
- **Timed plans:** schedules a reminder 30 minutes before via `scheduleOnce`
- **Untimed plans:** reminds at `wake time + 2h`, then every 2h throughout the day until marked done
- User marks done: "done with creatine" → `PLAN_DONE` intent → status updated to 'done'
- Supports Google Calendar sync (bidirectional, for users with GCal connected)

---

### 8. AI Coaching (Q&A)

**What the user does:** asks anything — nutrition questions, training advice, interpreting their data, what to eat, how to improve. Can also send a photo (gym form, food, etc.) for coaching.

**What the bot does:**
- Answers with full context of today's data (meals, workouts, targets, plans)
- Maintains a multi-turn conversation chain — remembers what was said in the last 6 messages of the current thread
- Chain closes after 8 exchanges (compressed to a summary)
- After a chain closes, can detect if a follow-up message is continuing the same topic and inherit the summary as context
- Never gives generic advice — always grounded in the user's actual logged data

**Conversation chain mechanics:**
- `current_chain_id` is stable for the full thread (not per-reply)
- Meal/workout logs mid-conversation trigger chain close + compression
- Context survives topic continuation across chain resets

**User behavioral profile:**
- After every chain closes, Claude extracts behavioral patterns from the conversation and updates a persistent profile
- Profile format: ACTIVE (current patterns, habits, tendencies) + RESOLVED (things user has overcome)
- Injected into every coaching prompt — responses become more personalized over time
- Examples tracked: skips breakfast on workdays, motivation style, recurring struggles, food preferences

---

### 9. Corrections & Renames

**What the user does:** says "actually that was 150g not 100g" or "rename that to chicken bowl".

**What the bot does:**
- `CORRECTION` intent: adjusts an existing meal/workout entry's values
- `RENAME` intent: renames a logged entry — classified **without** chat history to avoid poisoning from failed prior attempts
- `DELETE` intent: removes a log entry (asks for confirmation)
- Time correction: "that was actually at 12pm" — corrects timestamp

---

### 10. Daily Summary

**Triggered:** end of day (user asks, or bot generates at end-of-day check).

**Covers:**
- Macro totals vs targets (with correct under/over direction per macro)
- Net calorie intake after workout burn
- TDEE-based energy balance (if TDEE set for user)
- Sleep quality
- One win + one specific fix for tomorrow
- "prep for tomorrow:" closing line

**Macro evaluation rules (non-negotiable):**
- Protein under target → flag as issue
- Carbs under target → fine, not flagged as over
- Fat under target → fine, not flagged as over
- Only "over" when actual > target

---

### 11. Evening Check-in (19:30 local time)

**Automatic daily check-in sent at 7:30pm.**

**Covers:**
- Calories eaten vs remaining target
- Protein status with specific suggestion if short
- Carbs/fat brief status
- Caffeine flag if over 400mg or after 5pm
- Upcoming plans
- Pill reminder (hardcoded for current user — will be configurable per user in app)
- "prep for tomorrow:" closing action

---

### 12. Weekly Review (Monday)

**Triggered:** Monday morning, bot asks for weight + body fat before generating review.

**Covers:**
- Weight and body fat change week over week
- Macro adherence % across the week
- Training days count
- Sleep average (hours + quality)
- Best and worst day
- One main fix for the coming week
- Projected goal timeline based on actual weight trend
- Suggestion to update targets if actual progress diverges from expected

---

### 13. Proactive Nudges

**Automatic, up to 3 per day** (one per time window: morning, afternoon, evening).

**What it flags (single most important thing per nudge):**
- Protein consistently below target across multiple days
- Calories over budget multiple days in a row
- No food logged 4+ hours after waking
- No workouts for several days
- Poor food choices visible in meal names (fast food, junk building up)
- Caffeine over 400mg or late in the day
- Escalates if the same pattern persists: first flag = warning, repeat = direct call-out

**What it doesn't do:**
- Repeat the same category twice in one day
- Mention missing meals in the first 4 hours after wake — the empty meals data is hidden from Claude entirely so it can't construct a "nothing logged yet" message; other nudge categories (caffeine, workouts, food quality) are still valid early
- Fire if user was active in the last 15 minutes (recently active guard)

---

### 14. Onboarding

New user flow (in-chat):
1. Name
2. Goal (lose weight / build muscle / maintain / improve health)
3. Current weight + goal weight
4. Height → BMI computed
5. Calorie and macro targets set
6. Timezone detected
7. GCal connection (optional)
8. Coaching style preference

After onboarding: `status: 'sleeping'`, `current_day_start: null` — day starts only on first GM.

---

### 15. Google Calendar Integration

**Bidirectional sync for users with GCal connected:**
- GCal → DB: imports events as plans (today + 2 days ahead)
- DB → GCal: pushes new plans to GCal
- Sync runs every 30 minutes
- Timed plans created in chat automatically appear in calendar

---

### Note on Notion

Notion is **not a product feature**. It is personal tooling used by the current user (Max) to mirror logged data into a personal Notion workspace. It is write-only — SQLite is always the source of truth and Notion is never queried. The app version should not include Notion integration. Do not treat it as a feature to preserve or port.

---

## Data Model (Key Tables)

| Table | What's stored |
|-------|--------------|
| `user_state` | All per-user flags, current day start, chain ID, caffeine, timezone, targets ref |
| `meal_log` | Every meal: name, macros, meal type, timestamp |
| `workout_log` | Every workout: name, type, exercises JSON, calories, duration, timestamp |
| `sleep_log` | Bed time, wake time, hours, quality, date |
| `recovery_log` | Protocol, rounds, sessions JSON, timestamp |
| `body_log` | Weight, body fat %, BMI, timestamp |
| `plans` | Text, date, time, status (pending/done/skipped), GCal event ID |
| `targets` | Calories, protein, carbs, fat, weight, goal weight per user |
| `known_foods` | Recurring food items with their macros, scoped per user |
| `coach_reply_chain` | Live messages in an open conversation chain |
| `coach_conversations` | Compressed summaries of closed conversation chains |
| `chat_history` | All messages (user + assistant) for classifier context |
| `reminders` | Scheduled one-shot reminders (timed plans, etc.) |

---

## What's Built vs What's Needed for the App

### Fully built (logic complete)
- All tracking: meals, workouts, sleep, recovery, body, plans
- Live workout mode (mid-session exercise logging)
- Full AI coaching with multi-turn conversation and context continuity
- User behavioral profile — auto-updated after every conversation, injected into all coaching
- Workout progress comparison (auto-fires after each session)
- Weekly strength/endurance trend summary
- Proactive nudge system (3 windows/day, per-user timezone)
- Evening check-in, weekly review, daily summary, full progress analysis
- Pre-bed flow (plans for tomorrow + bed nudges)
- Corrections, renames, deletes
- Onboarding flow
- GCal bidirectional sync
- TDEE-based calorie balance
- Photo meal logging + photo Q&A coaching
- Retroactive logging
- Per-user targets, coaching style, timezone

### What the app layer needs to add
- **Multi-device / web interface** — currently Telegram only; all logic is in handlers that can be adapted to any input layer
- **Push notifications** — currently Telegram messages; needs mapping to native mobile push
- **User accounts & auth** — currently identified by Telegram chat_id; needs proper auth layer
- **UI for data views** — currently text-only summaries; needs charts for weight trend, weekly macro bars, sleep quality graph, etc.
- **Configurable reminders** — pill reminder is hardcoded; needs per-user configurable reminder items
- **Target update UI** — currently done via coach conversation; app should have a settings screen
- **Multi-user management** — infrastructure exists (multi-user DB), but no admin interface
- **Offline/sync** — currently server-only; app needs local-first or sync strategy

### Logic that maps directly to app screens
| Bot feature | App screen |
|-------------|-----------|
| Daily summary text | Today dashboard |
| Evening check-in | Daily progress card |
| Weekly review | Weekly stats screen |
| Full analysis | Progress / history screen |
| Plans list | To-do / schedule screen |
| Known foods | Food library |
| Body log history | Weight trend chart |
| Proactive nudges | Push notifications |
| Q&A coaching | Chat / coach screen |
| Onboarding flow | Onboarding wizard |

---

## User Preferences (current user: Max)

- Proactive nudges: 3 windows/day, missing-meals nudge suppressed in first 4h after wake
- Untimed reminders: first fire at wake + 2h, then every 2h
- Evening check at 19:30 local time
- Coaching style: direct, no fluff
- Timezone: Asia/Kuala_Lumpur
- GCal enabled
- NS lunch: R = Regular protein, D = Double protein
- Pill reminder included in evening check
