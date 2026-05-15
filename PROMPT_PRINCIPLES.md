# PROMPT_PRINCIPLES.md — Prompt Engineering Rules for Health Bot

This document codifies the rules every prompt in the Health Bot must follow. It exists to:

- Spec prompt rewrites — every new or rewritten prompt is checked against these rules before shipping.
- Stop us re-deriving the same lessons each time we fix a bug.
- Onboard future collaborators (human or AI) to how prompts here are designed.

Apply it like a code style guide: when in doubt, the principle wins. This is a living doc — we add principles as we hit new failure modes, and remove ones that stop earning their keep.

Related docs in this project:
- `PRODUCT_PRINCIPLES.md` — how the product itself behaves (design philosophy)
- `WORKFLOW_PRINCIPLES.md` — how we collaborate to build it

---

## 1. Pre-compute math in code, not in Claude

**Rule.** Any comparison, sum, delta, or classification should happen in JavaScript before reaching the prompt. Hand Claude the verdict, not the raw numbers.

**Why.** Claude reliably writes sentences about pre-stamped facts. It unreliably computes facts from raw numbers — especially under length pressure, where it glosses. Pre-computation moves brittleness out of the model and into deterministic code, where bugs are testable.

**Wrong.** Pass raw `totals` and `targets`; let Claude compare them and decide what to flag.

```
totals:  { fat: 137 }
targets: { fat: 60 }
Rule: "Only say a macro is over if actual is strictly greater than target."
```

**Right.** Compute the verdict in `day.js`, label it, pass the label.

```
macro_status:
- fat: 137 / 60 → OVER by 77 (flag)
```

---

## 2. Inject structured, labeled blocks — not raw JSON

**Rule.** Data the model needs to reason about should be formatted as labeled, human-readable blocks. Raw JSON dumps invite gloss.

**Why.** A `fat: 137 / 60 → OVER by 77` line is impossible to misread. A `{"fat": 137}` field inside a 200-line JSON object is easy to skim past. Format your data the way you'd want it presented in a one-page brief.

**Wrong.**

```
Data: { "totals": {...}, "targets": {...}, "workouts": [...], "sleep": {...} }
```

**Right.**

```
Macros today:
- calories: 2567 / 1800 → OVER by 767 (flag)
- protein: 149 / 170 → UNDER by 21 (flag)
- carbs:   183 / 110 → OVER by 73 (flag)
- fat:     137 / 60  → OVER by 77 (flag)

Workouts today:
- Circuit, 35 min, 476 kcal burned

Sleep last night:
- 8h 6m at quality 4 (good)
```

---

## 3. Positive rules beat negative rules

**Rule.** For every "don't do X" instruction, prefer a "do Y" instruction. Stacked negatives bias the model toward inaction.

**Why.** Models implicitly weight whichever side of the prompt is louder. Four "don't say over when…" rules against one "say over when…" rule creates a strong don't-flag bias, which is exactly the bug we saw in `DAY_SUMMARY`. Phrase rules as actions to take, not actions to avoid.

**Wrong.**

```
- Carbs under target = fine, do NOT say "over"
- Fat under target = fine, do NOT say "over"
- Only say "over" if strictly greater than target
- Do NOT invent or speculate about historical patterns
```

**Right.**

```
- Mention every macro marked "flag" in macro_status.
- Skip macros not marked "flag."
- Only state facts present in the data block.
```

---

## 4. Every prompt declares what to do when data is missing

**Rule.** For every field a prompt expects, state what to do if the field is empty, null, or absent.

**Why.** Silent gaps invite hallucination. Claude fills empty fields with plausible inferences ("you probably slept fine"). Explicit "if X is empty, say Y" instructions kill that failure mode.

**Wrong.** Prompt says "cover sleep quality." User didn't log sleep. Claude invents: "rest seems decent today."

**Right.** Prompt says: "If sleep is null, say 'no sleep logged' and skip the sleep section. Do not infer sleep quality from any other field."

---

## 5. No single-user assumptions in prompt text

**Rule.** User-specific content — names, hardcoded reminders, custom food libraries, coaching style, language — is injected via variables, never hardcoded into the prompt body.

**Why.** A prompt that says "always include a pill reminder" works for Max and fails for every other user. The product is moving to multi-user. Every prompt must be written as if the next user is not Max.

**Wrong.**

```
"Always include a pill reminder (user takes pills with dinner)."
"Match items to the NS Lunch / Dinner menu when user says 'NS'."
```

**Right.**

```
"If `user_reminders` contains items, include them in the evening section."
"If a `user_food_library` block is provided, match items against it for exact macros."
```

Single-user content lives in the data, not the prompt.

---

## 6. Shared rules live in one place

**Rule.** Rules that apply to multiple prompts — duration formatting, macro evaluation rules, anti-hallucination guardrails, tone, emoji policy — live in `COACH_SYSTEM` (the base system prompt). Individual prompts do not redefine or paraphrase them.

**Why.** Today the macro evaluation rules appear in three prompts with subtle drift. When we update one, the others rot. A single source of truth keeps them aligned forever and makes the per-prompt text shorter and clearer.

**Wrong.** Macro rules duplicated (with slight wording drift) across `DAY_SUMMARY`, `EVENING_CHECK`, `WEEKLY_REVIEW`.

**Right.** Macro rules stated once in `COACH_SYSTEM`. Each prompt assumes the `macro_status` format and the system-level rules apply.

---

## 7. One prompt, one job

**Rule.** A prompt that does more than one distinct thing should be split. If you can describe the prompt's job using the word "and," it's probably two prompts.

**Why.** Multi-job prompts are hard to debug — when output is wrong, which sub-job failed? They're also hard to tune — improving sub-job A often breaks sub-job B. Smaller prompts have smaller failure surfaces.

**Wrong.** `MEAL_PARSER` does photo analysis + known-food matching + new-food detection + meal-type classification + low-confidence clarification flow, all in one call.

**Right.** Parse the meal → match against known foods in a separate step → trigger clarification flow only when confidence is low.

This is aspirational where it conflicts with latency or cost. When we can't split, we acknowledge the prompt is doing too much and accept the tax.

---

## 8. Examples beat rules

**Rule.** For any non-trivial output requirement — tone, format, structure — show two or three examples of correct output. Examples beat rules.

**Why.** Showing beats telling. A single "Here's a good response:" example often replaces five lines of prose rules and produces more reliable output. Especially powerful for tone and length.

**Wrong.** A wall of rules describing the desired style.

**Right.** Brief rules + examples.

```
Tone: casual, direct, name specific numbers, end with "prep for tomorrow:".

Good example:
"Heavy day on fat — 137g vs 60g target, mostly from curry and dumplings.
Solid 35min circuit but it didn't dent the deficit. Sleep was 8h 6m, quality 4.
Win: training. Fix: track fat before lunch tomorrow.
prep for tomorrow: pick one low-fat lunch option."
```

---

## 9. Live context overrides conversation history

**Rule.** Coaching prompts state explicitly that the data block injected at the start of the message is authoritative. Conversation history may contain stale figures and must not override fresh data.

**Why.** As conversations grow, old numbers ("you had 1500 cal yesterday") linger in history. If the model treats history with equal weight to live context, it produces drifting and conflicting outputs.

**Wrong.** Leaving the model to guess which numbers are current.

**Right.**

```
"The data block below is live database state.
Use these numbers for today's totals. Prior messages may show outdated figures."
```

---

## 10. When output varies by user config, the example must vary too

**Rule.** If a prompt's desired output depends on a user setting — `coaching_style`, `language`, plan tier, anything — don't bake one example into the prompt and ask the model to adjust. Inject a config-specific example at runtime.

**Why.** Examples set the tonal/structural floor of the output (Principle 8). A single example with verbal instructions to "soften this for gentle users, harden it for max users" does not work reliably — we lived through this with the coaching-style tone fix. The model mirrors the example far more than it follows the adjustment instruction. One example per relevant config value is the only reliable way.

**Wrong.**

```
"Adjust tone based on coaching_style: gentler for 1, harder for 3."
GOOD EXAMPLE:
[one example calibrated for style 2]
```

**Right.**

```
GOOD EXAMPLE (calibrated to user's coaching_style):
{example_for_style}
```

Where `{example_for_style}` is resolved at runtime to one of N pre-written examples, selected by the config value. Per-request token cost stays the same (only one example goes through). Setup cost is paying once to write N examples instead of one.

---

## How this doc evolves

When we fix a prompt bug, we ask: "is this a one-off, or a pattern?" If it's a pattern, the lesson becomes a new principle here. When a principle stops earning its keep (because we've internalized it, or it's no longer relevant), we cut it.

A good principle satisfies all three:

- **Specific enough** to apply mechanically. ("Be clearer" doesn't qualify.)
- **General enough** to apply across multiple prompts.
- **Earned** — born from a real bug, not from theory.

Every prompt rewrite this document spawns gets a one-line entry in `DECISIONS.md`: which principle drove the change, and what the failure mode was. That's how we keep ourselves honest about whether the rules are working.
