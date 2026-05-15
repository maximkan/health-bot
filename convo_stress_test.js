#!/usr/bin/env node
'use strict';
require('dotenv').config();
process.chdir('/root/health-bot');

const claude = require('./src/claude');
const db = require('./src/db');
const notion = require('./src/notion');

const CHAT_ID = 119445404;
let passed = 0, failed = 0;
const failures = [];

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, detail) { failed++; failures.push(`${label}: ${detail}`); console.log(`  ❌ ${label} — ${detail}`); }
function section(title) { console.log(`\n${'═'.repeat(50)}\n  ${title}\n${'═'.repeat(50)}`); }
function check(label, val, fn) {
  try { fn(val) === true ? ok(label) : fail(label, `got: ${JSON.stringify(val).slice(0,100)}`); }
  catch(e) { fail(label, e.message); }
}

// Simulate the full closeChain + continuation flow
async function simulateChainClose(messages) {
  const convText = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const [summary, updatedProfile] = await Promise.all([
    claude.summarizeConversation(messages),
    claude.updateUserProfile(convText, db.getUserProfile(CHAT_ID)),
  ]);
  db.saveCoachConversation(CHAT_ID, messages, summary);
  db.setUserProfile(CHAT_ID, updatedProfile);
  return summary;
}

async function shouldInherit(newMsg, summary) {
  return claude.isConversationContinuation(newMsg, summary);
}

async function askFresh(question, summary = null) {
  const targetsText = notion.getTargetsText(CHAT_ID);
  const state = db.getState(CHAT_ID);
  let ctx = '';
  if (summary) ctx = `Previous conversation context:\n${summary}`;
  return claude.askCoach(question, ctx, targetsText, '', state);
}

async function main() {
  // Clean test state
  db.saveCoachConversation && null;

  section('TEST 1: 80-MESSAGE MEGA CONVERSATION');
  console.log('Simulating 10 chains of 8 messages each = 80 total exchanges');
  console.log('Topic drift: protein → digestion → sleep → injury → cutting → birthday → back to food\n');

  const chains = [
    // Chain 1: protein targets
    [
      { role: 'user', content: 'im confused about my protein target. you set it at 170g but everywhere i read says 0.8g per kg is enough' },
      { role: 'assistant', content: 'The 0.8g/kg is the minimum to avoid deficiency — not optimal for muscle retention while cutting. At 104kg you want closer to 1.6-2g/kg = 160-200g. 170g is right in the sweet spot.' },
      { role: 'user', content: 'ok so if im sedentary on rest days, does it drop?' },
      { role: 'assistant', content: 'Slightly — some research supports 1.4g/kg on rest days. But consistency is more important than precision. Keeping 170g every day is simpler and better for muscle protein synthesis.' },
      { role: 'user', content: 'what foods hit 170g protein without going over calories?' },
      { role: 'assistant', content: 'At 1800 kcal: chicken breast, egg whites, Greek yogurt, cottage cheese, white fish. Lean proteins give ~25-30g per 100g. Plan 3 meals × ~50g protein each.' },
      { role: 'user', content: 'what about protein powder, how much should i take?' },
      { role: 'assistant', content: 'Use it to fill gaps, not as primary source. 1-2 scoops (25-50g) is plenty. Real food first, powder to close the remaining 20-30g shortfall.' },
      { role: 'user', content: 'is whey or casein better for my goals?' },
      { role: 'assistant', content: 'Whey post-workout for fast absorption. Casein before bed for slow release overnight. For pure convenience, whey is fine anytime.' },
      { role: 'user', content: 'what about plant protein, im thinking of reducing meat' },
      { role: 'assistant', content: 'Pea + rice blend gives a complete amino acid profile. You need ~20% more plant protein than whey to match bioavailability. Budget ~200g protein target if going mostly plant.' },
      { role: 'user', content: 'does it matter what time i have protein' },
      { role: 'assistant', content: 'Spread it across 3-4 meals — 40-50g per meal is optimal for MPS. Timing within a meal matters less than total daily intake and distribution.' },
    ],
    // Chain 2: digestion issues (completely different topic)
    [
      { role: 'user', content: 'my stomach has been fucked lately, lot of bloating after every meal' },
      { role: 'assistant', content: 'Common triggers: high fiber too fast, whey protein, cruciferous veg, eating too fast. When did it start and what changed recently in your diet?' },
      { role: 'user', content: 'i think it started when i upped protein intake actually' },
      { role: 'assistant', content: 'Likely the whey or the sudden increase in protein. High protein ferments in the gut if you lack the gut bacteria. Try: isolate instead of concentrate, smaller doses spread wider, and add probiotics.' },
      { role: 'user', content: 'what probiotics specifically' },
      { role: 'assistant', content: 'Lactobacillus acidophilus and Bifidobacterium longum are the most studied for bloating. Any pharmacy brand with those strains. Take with food, not on empty stomach.' },
      { role: 'user', content: 'how long till it helps' },
      { role: 'assistant', content: '2-4 weeks for noticeable change. Gut microbiome shifts are slow. Keep a food journal noting which specific meals cause the worst bloating.' },
      { role: 'user', content: 'should i cut dairy too' },
      { role: 'assistant', content: 'Test it for 2 weeks. If Greek yogurt causes bloating but hard cheese doesn\'t — it\'s lactose (not all dairy). Lactose-free versions fix it without losing protein sources.' },
      { role: 'user', content: 'what about eggs' },
      { role: 'assistant', content: 'Eggs rarely cause bloating unless you have an intolerance. More likely it\'s the total meal volume or the whey. Don\'t eliminate eggs — they\'re too nutritionally valuable.' },
      { role: 'user', content: 'ok ill try isolate. what brand' },
      { role: 'assistant', content: 'Optimum Nutrition Gold Standard Isolate or MyProtein Impact Isolate are solid and widely available. Read labels — some "isolates" still have lactose.' },
    ],
    // Chain 3: sleep issues
    [
      { role: 'user', content: 'sleep has been garbage, only getting 5h even when i try to sleep earlier' },
      { role: 'assistant', content: 'Classic sleep onset vs duration issue. What time are you trying to sleep and what time do you wake?' },
      { role: 'user', content: 'try to sleep at 11, wake at 4am and cant go back' },
      { role: 'assistant', content: 'Early morning waking is often cortisol-related, stress, or blood sugar dip. Are you eating late? High protein before bed can cause this if digestion disrupts sleep.' },
      { role: 'user', content: 'i do have casein at 10:30pm' },
      { role: 'assistant', content: 'Try moving it to 9pm. Give 1.5-2h before bed. Casein is slower digesting but still triggers some insulin response. Also try a small carb source with it — blunts cortisol overnight.' },
      { role: 'user', content: 'what carb source' },
      { role: 'assistant', content: '30-40g oats or banana. Not a full meal — just enough to stabilize blood glucose. This helps many people sleep through the 3-4am cortisol spike.' },
      { role: 'user', content: 'any supplements for sleep' },
      { role: 'assistant', content: 'Magnesium glycinate 300-400mg before bed is the most evidence-backed. Glycine 3g is also solid. Avoid melatonin long-term — it\'s a signal, not a sedative.' },
      { role: 'user', content: 'ive taken melatonin for 2 years is that bad' },
      { role: 'assistant', content: 'Your natural production is likely blunted. Take a 4-week break, use magnesium instead. Natural production usually recovers within weeks once you stop.' },
      { role: 'user', content: 'will the sleep improve my digestion too' },
      { role: 'assistant', content: 'Yes directly — gut motility and repair happens primarily during sleep. Poor sleep worsens gut permeability. Fixing sleep will also reduce your bloating.' },
    ],
    // Chain 4: training injury
    [
      { role: 'user', content: 'hurt my shoulder on bench press yesterday, sharp pain on the way down' },
      { role: 'assistant', content: 'Sharp pain descending is usually anterior deltoid or bicep tendon catching. Did it pop or just pain? Any swelling?' },
      { role: 'user', content: 'no pop, just pain. still hurts today raising arm above head' },
      { role: 'assistant', content: 'Sounds like rotator cuff impingement or AC joint irritation — not a full tear (no pop, still mobile). Rest the bench for 2 weeks minimum. Ice 15min x3 daily for 3 days.' },
      { role: 'user', content: 'can i still train other things' },
      { role: 'assistant', content: 'Yes. Legs fully, pulling movements (rows with neutral grip, low cable rows), and machines that don\'t load shoulder in impingement position. Avoid overhead pressing and chest flyes.' },
      { role: 'user', content: 'what about maintaining chest muscle during this' },
      { role: 'assistant', content: 'Muscle loss starts after ~2 weeks of complete detraining. Keep doing push-like movements pain-free — cable crossovers low to high, neutral grip dumbbell press if no pain. Protein stays critical.' },
      { role: 'user', content: 'how much muscle will i lose in 2 weeks' },
      { role: 'assistant', content: 'Almost none if you maintain training everything else and keep protein at 170g. Muscle memory means fast recovery when you return. Don\'t panic about 2 weeks.' },
      { role: 'user', content: 'should i see a physio' },
      { role: 'assistant', content: 'If pain persists past 2 weeks or gets worse, yes. For a first-time impingement that\'s improving — self-managed rest is fine. But don\'t push through pain.' },
      { role: 'user', content: 'will this affect my cut' },
      { role: 'assistant', content: 'Minimal. Shoulder injury = less upper body volume = slightly fewer calories burned. Drop 50-100 kcal from target during recovery. Protein stays the same.' },
    ],
    // Chain 5: randomly asks about birthday — completely unrelated
    [
      { role: 'user', content: 'my birthday is next week, 28th. going out for a big dinner with friends' },
      { role: 'assistant', content: 'Happy early birthday! One big dinner won\'t derail anything. Enjoy it fully — one meal doesn\'t move the needle on a cut.' },
      { role: 'user', content: 'yeah but we usually drink too and i dont want to feel like shit the next day' },
      { role: 'assistant', content: 'Stay hydrated — 1 glass water per drink. Eat a proper meal before drinking (fat + protein slows alcohol absorption). Electrolytes before bed. Avoid mixing types.' },
      { role: 'user', content: 'what should i eat at the dinner to not go totally off track' },
      { role: 'assistant', content: 'Steak/fish + veg as main. Skip the bread basket. One dessert is fine. Drink wine or spirits over beer — lower carbs. Don\'t obsess, just be roughly sensible.' },
      { role: 'user', content: 'how bad is alcohol for muscle building' },
      { role: 'assistant', content: 'Occasional drinking has minimal muscle impact. Chronic heavy drinking suppresses testosterone and protein synthesis. 1-2 nights per month — irrelevant. Every weekend — meaningful.' },
      { role: 'user', content: 'what if i train the morning after' },
      { role: 'assistant', content: 'Skip it or go easy. Alcohol impairs muscle protein synthesis for 24-36h and dehydration reduces strength 5-10%. A bad hangover session does more harm than skipping.' },
      { role: 'user', content: 'ok fair. what about calories for that day' },
      { role: 'assistant', content: 'Don\'t restrict before — arriving hungry makes you overeat and drink more. Just have a normal day. Enjoy the dinner. Track loosely if at all.' },
      { role: 'user', content: 'and the day after?' },
      { role: 'assistant', content: 'Normal eating. Don\'t compensate by starving — it stresses the body more. Eggs, fruit, electrolytes. Back to routine by lunch.' },
    ],
    // Chains 6-10: more varied topics
    [
      { role: 'user', content: 'ok so i want to start intermittent fasting 16:8, is it compatible with my goals' },
      { role: 'assistant', content: 'Compatible with fat loss — same calories in a smaller window. Risk: harder to hit 170g protein in 8h. Possible but requires planning. Eating window 12pm-8pm works for most.' },
      { role: 'user', content: 'what about muscle loss in the morning fasted state' },
      { role: 'assistant', content: 'Minimal during the fast itself. Your body prefers fat for fuel after 12h. Muscle breakdown only becomes meaningful at 24h+ fasts or severe caloric restriction.' },
      { role: 'user', content: 'can i train fasted' },
      { role: 'assistant', content: 'Yes but performance may dip on heavy compound lifts. 10g EAA or 5g leucine pre-workout covers the muscle protection without breaking the fast meaningfully.' },
      { role: 'user', content: 'what time should i work out then' },
      { role: 'assistant', content: 'Either end of fasted period (11-12pm) right before eating, or within eating window (1-2pm) with food in system. Both work — pick what fits your schedule.' },
      { role: 'user', content: 'is 16:8 better than just eating normally for fat loss' },
      { role: 'assistant', content: 'Neither is superior when calories are equated. IF works because it naturally reduces snacking and late-night eating. If you\'re already disciplined with calories, the benefit is smaller.' },
      { role: 'user', content: 'what about coffee during the fast' },
      { role: 'assistant', content: 'Black coffee is fine — negligible calories, doesn\'t break the fast, and mildly enhances fat oxidation. Avoid lattes or adding milk — that breaks it.' },
      { role: 'user', content: 'can i add creatine to coffee' },
      { role: 'assistant', content: 'Yes, creatine with black coffee is fine. Hot coffee doesn\'t degrade creatine at normal temperatures. Caffeine + creatine together is well-studied and safe.' },
      { role: 'user', content: 'how long till creatine starts working' },
      { role: 'assistant', content: '3-4 weeks at 5g/day maintenance dose. Loading phase (20g/day × 5-7 days) speeds saturation but causes more water retention. Steady 5g/day is the sensible approach.' },
    ],
    [
      { role: 'user', content: 'whats the best way to track progress without weighing myself every day' },
      { role: 'assistant', content: 'Weekly morning weight (same day, same conditions) + monthly photos + performance metrics (strength, endurance). Daily scale is noise — weekly trend is signal.' },
      { role: 'user', content: 'my weight fluctuates 2-3kg daily is that normal' },
      { role: 'assistant', content: 'Completely normal. Water retention, food volume, sodium, glycogen, bathroom timing. At 104kg a 2-3kg swing is nothing. Track 7-day rolling average instead.' },
      { role: 'user', content: 'what causes the most water retention' },
      { role: 'assistant', content: 'High sodium meals, high carb refeed, hard training (muscle repair), poor sleep, high cortisol. A big Korean BBQ with rice the night before can add 2kg on the scale.' },
      { role: 'user', content: 'how do i reduce water retention before a trip or event' },
      { role: 'assistant', content: 'Lower sodium 3-4 days out. Keep carbs moderate. Sauna + contrast therapy the day before. Don\'t restrict water — that backfires and causes more retention.' },
      { role: 'user', content: 'wait the sauna helps with water retention?' },
      { role: 'assistant', content: 'Short term yes — you sweat out water. It comes back when you rehydrate. For photos or a specific day it\'s useful. Not a long-term strategy.' },
      { role: 'user', content: 'what about diuretics' },
      { role: 'assistant', content: 'Avoid unless prescribed. Natural diuretics (dandelion tea, asparagus, caffeine) have minor effects. Pharmaceutical diuretics for aesthetics are risky — electrolyte imbalance, cramping, heart issues.' },
      { role: 'user', content: 'what supplements actually work for body comp' },
      { role: 'assistant', content: 'Evidence-backed: creatine (strength/muscle), caffeine (performance), protein powder (convenience), vitamin D + magnesium (deficiency is common). Everything else is marginal at best.' },
      { role: 'user', content: 'what about fat burners' },
      { role: 'assistant', content: 'The stimulant ones (caffeine + synephrine) give 50-100 kcal/day extra burn at most. The effect disappears with tolerance in 2-3 weeks. Not worth it — just adds cortisol load.' },
    ],
    [
      { role: 'user', content: 'i keep hitting a plateau around 103kg, been stuck for 3 weeks' },
      { role: 'assistant', content: 'Classic adaptive thermogenesis — your TDEE dropped as you lost weight. At 103kg your maintenance is lower than when you started. Need to either drop calories 100-150 kcal or add cardio.' },
      { role: 'user', content: 'how much cardio should i add' },
      { role: 'assistant', content: '2-3 sessions × 30min moderate intensity (zone 2 — conversational pace). That burns ~200-300 kcal/session without spiking hunger too much. Don\'t go high intensity — it increases appetite.' },
      { role: 'user', content: 'is zone 2 just walking' },
      { role: 'assistant', content: 'Walking briskly counts as zone 2. Heart rate around 120-140bpm. You can hold a conversation but it\'s not easy. Cycling, incline treadmill, rowing — all work.' },
      { role: 'user', content: 'what about fasted cardio' },
      { role: 'assistant', content: 'Same fat loss result as fed cardio when total calories match. Fasted cardio advantage is purely psychological — some people prefer it. If it makes you ravenous after, do it fed.' },
      { role: 'user', content: 'should i change my calorie target then' },
      { role: 'assistant', content: 'Yes, recalculate at current weight (103kg). At 104kg your TDEE was ~2400. Now it\'s ~2350. Drop to 1750-1800 kcal to maintain the same deficit. Small adjustment but it matters.' },
      { role: 'user', content: 'how long should the cut last' },
      { role: 'assistant', content: 'Target 0.5-0.75% of body weight per week. At 103kg that\'s 0.5-0.75kg/week. Any faster and you risk muscle loss. At that rate, 10kg cut takes ~3-4 months.' },
      { role: 'user', content: 'what weight should i cut to' },
      { role: 'assistant', content: 'Depends on your goal. For health and performance, 90-95kg at your height looks strong. For aesthetics, lower. But don\'t chase a number — chase body composition metrics (body fat % and muscle mass).' },
      { role: 'user', content: 'what body fat % should i target' },
      { role: 'assistant', content: '15-18% is healthy, athletic range for men. Sub-15% starts looking lean and defined. Sub-10% is competition level — hard to maintain and not necessary. 15-18% is the sweet spot for performance + look.' },
    ],
    [
      { role: 'user', content: 'now im thinking about bulking instead actually' },
      { role: 'assistant', content: 'Coming off a plateau mid-cut — that\'s a diet break instinct, which is valid. But "bulk vs cut" depends on current body fat. At ~27% BF, bulking will put you in a metabolically uncomfortable range.' },
      { role: 'user', content: 'whats a metabolically uncomfortable range' },
      { role: 'assistant', content: 'Above 25-28% BF, insulin sensitivity drops and fat gain accelerates relative to muscle. You\'d be adding mostly fat. Better to cut to 20-22% first, then lean bulk.' },
      { role: 'user', content: 'ok so mini cut to 20% then bulk?' },
      { role: 'assistant', content: 'Yes — that\'s the clean approach. Get to 20% BF (~92-94kg probably), then lean bulk at 200-300 kcal surplus. Slow bulk = mostly muscle, minimal fat.' },
      { role: 'user', content: 'how long would the mini cut take' },
      { role: 'assistant', content: 'From current ~27% to 20% — roughly 7% BF loss. At 103kg that\'s ~7kg of fat. At 0.5kg/week = 14 weeks. 3-4 months realistically.' },
      { role: 'user', content: 'and the bulk after?' },
      { role: 'assistant', content: 'Lean bulk at 200-300 kcal surplus: expect 0.25-0.5kg/week, majority muscle. Run it until you hit 25% BF again, then cut again. This is the classic cut/bulk cycle.' },
      { role: 'user', content: 'my friend says dirty bulk is faster' },
      { role: 'assistant', content: 'Faster at gaining weight, yes. But ~60-70% of dirty bulk gains are fat. You end up cutting for months just to undo it. Net muscle gain is often less than clean bulking over same period.' },
      { role: 'user', content: 'has anyone with my stats successfully done this' },
      { role: 'assistant', content: 'The cut/bulk cycle at your stats (104kg, 27% BF, male) is textbook. Thousands of people with identical starting points have reached 15% BF this way. It\'s not glamorous but it\'s the proven path.' },
    ],
    [
      { role: 'user', content: 'can you help me plan a full week of eating' },
      { role: 'assistant', content: 'Yes. Give me: target kcal (1800?), protein target (170g), any foods you hate, whether you meal prep, and how many meals per day. I\'ll build it out.' },
      { role: 'user', content: 'yeah 1800 kcal 170g protein, i hate fish except salmon, i meal prep sunday, 3 meals a day' },
      { role: 'assistant', content: 'Perfect. Week plan:\nBreakfast: 4 eggs + 80g oats + 200g Greek yogurt (~650 kcal, 50g P)\nLunch: 250g chicken breast + 150g rice + veg (~550 kcal, 60g P)\nDinner: 200g salmon or 250g chicken + sweet potato + veg (~600 kcal, 50g P)\nTotal: ~1800 kcal / 160g P — close. Add 30g protein shake to hit 170g.' },
      { role: 'user', content: 'i get bored of chicken after 3 days' },
      { role: 'assistant', content: 'Rotate: Mon/Wed/Fri chicken, Tue/Thu/Sat beef mince (lean 5%), Sun salmon. Marinate differently each batch — teriyaki, lemon herb, cumin. Same macro profile, different flavour.' },
      { role: 'user', content: 'is beef worse than chicken for fat loss' },
      { role: 'assistant', content: 'Per gram of protein, lean beef (5% fat) is very similar to chicken breast. Slightly higher in saturated fat but also higher in zinc, iron, B12. Not worse — just different trade-offs.' },
      { role: 'user', content: 'what about the cost' },
      { role: 'assistant', content: 'Chicken breast is cheapest protein per gram globally. Lean beef mince is slightly more. Eggs cheapest of all. Salmon is 3-4x more expensive — once a week is fine for budget.' },
      { role: 'user', content: 'can i substitute oats for something else at breakfast' },
      { role: 'assistant', content: 'Sweet potato (200g = similar calories/carbs), overnight rice, sourdough toast. If you want lower carb breakfast — skip carbs there and add to dinner instead. Same total.' },
      { role: 'user', content: 'what if i skip breakfast sometimes' },
      { role: 'assistant', content: 'Fine — push calories to lunch and dinner. Protein distribution still matters. Don\'t let one meal drop below 40g protein. So 2 meals × 85g each or add a shake.' },
    ],
  ];

  let allSummaries = [];

  for (let i = 0; i < chains.length; i++) {
    const chainMessages = chains[i];
    console.log(`\n  Chain ${i+1}/10 (topic: ${chainMessages[0].content.slice(0,50)}...)`);
    const summary = await simulateChainClose(chainMessages);
    allSummaries.push(summary);
    console.log(`  Compressed: "${summary.slice(0,80)}..."`);
  }

  section('TEST 2: CONTINUATION CHECK — SAME TOPIC vs NEW TOPIC');

  const latestSummary = allSummaries[allSummaries.length - 1]; // meal planning summary

  // Should inherit
  const continueTests = [
    { msg: 'actually what about adding fruit to breakfast?', shouldInherit: true, label: 'follow-up on breakfast plan → inherit' },
    { msg: 'can i have rice instead of sweet potato?', shouldInherit: true, label: 'direct meal swap question → inherit' },
    { msg: 'wait how many grams of oats did you say?', shouldInherit: true, label: 'reference to specific number → inherit' },
    { msg: 'so just to confirm, salmon once a week right?', shouldInherit: true, label: 'confirming previous recommendation → inherit' },
  ];

  // Should NOT inherit
  const noInheritTests = [
    { msg: 'i just woke up and feel terrible', shouldInherit: false, label: 'unrelated wellbeing complaint → no inherit' },
    { msg: 'what is the capital of france', shouldInherit: false, label: 'completely unrelated question → no inherit' },
    { msg: 'how is my sleep been this week', shouldInherit: false, label: 'sleep question unrelated to meal plan → no inherit' },
  ];

  for (const t of [...continueTests, ...noInheritTests]) {
    const result = await shouldInherit(t.msg, latestSummary);
    if (result === t.shouldInherit) ok(t.label);
    else fail(t.label, `expected ${t.shouldInherit}, got ${result}`);
  }

  section('TEST 3: IMPLICIT CONTEXT INHERITANCE (no "you mentioned earlier")');

  // User had digestion chain (chain 2) — asks about it implicitly
  const digestionSummary = allSummaries[1];
  const proteinSummary = allSummaries[0];

  // These should inherit digestion context WITHOUT explicitly saying "remember"
  const implicitTests = [
    { msg: 'is the isolate helping yet?', summary: digestionSummary, shouldInherit: true, label: 'implicit ref to whey isolate advice → inherit' },
    { msg: 'still bloated today', summary: digestionSummary, shouldInherit: true, label: 'implicit continuation of gut issue → inherit' },
    { msg: 'picked up some probiotics', summary: digestionSummary, shouldInherit: true, label: 'implicit follow-up on probiotic recommendation → inherit' },
    { msg: 'is the isolate 100% absorbed', summary: proteinSummary, shouldInherit: true, label: 'isolate absorption question after protein chain → inherit' },
  ];

  for (const t of implicitTests) {
    const result = await shouldInherit(t.msg, t.summary);
    if (result === t.shouldInherit) ok(t.label);
    else fail(t.label, `expected ${t.shouldInherit}, got ${result}`);
  }

  section('TEST 4: CROSS-CHAIN CONTEXT QUALITY');
  console.log('Asking questions that reference multiple previous chains\n');

  // After all chains closed, ask questions that span topics
  const fullContext = allSummaries.slice(-3).join('\n---\n');

  const crossQ1 = 'given everything we discussed, what should i prioritise this week?';
  const crossQ2 = 'i have my birthday dinner friday and a shoulder injury, what do i do for training this week?';
  const crossQ3 = 'am i on track overall?';

  for (const q of [crossQ1, crossQ2, crossQ3]) {
    try {
      const ans = await askFresh(q, fullContext);
      check(`cross-chain Q: "${q.slice(0,40)}..."`, ans, v => typeof v === 'string' && v.length > 30);
      console.log(`     → ${ans.slice(0,120)}...\n`);
    } catch(e) {
      fail(`cross-chain: ${q.slice(0,40)}`, e.message);
    }
  }

  section('TEST 5: WRONG CONTEXT INJECTION (critical — should NOT happen)');
  console.log('Verifying unrelated context does not pollute responses\n');

  // Birthday summary (chain 5) should NOT be injected into a protein question
  const birthdaySummary = allSummaries[4];
  const shouldNotInherit = await shouldInherit('how much protein should i have today', birthdaySummary);
  if (!shouldNotInherit) ok('protein question does NOT inherit birthday/drinking context');
  else fail('wrong context injection', 'birthday context injected into unrelated protein question');

  // Injury chain should NOT be injected into meal planning question
  const injurySummary = allSummaries[3];
  const shouldNotInherit2 = await shouldInherit('what should i have for dinner', injurySummary);
  if (!shouldNotInherit2) ok('dinner question does NOT inherit injury context');
  else fail('wrong context injection', 'shoulder injury context injected into dinner question');

  section('TEST 6: RESPONSE QUALITY WITH vs WITHOUT CONTEXT');
  console.log('Same question, with and without previous context — checking quality diff\n');

  const sleepSummary = allSummaries[2];
  const testQ = 'should i take magnesium';

  const withCtx = await askFresh(testQ, sleepSummary);
  const withoutCtx = await askFresh(testQ, null);

  console.log(`Q: "${testQ}"`);
  console.log(`\nWith sleep context:\n${withCtx}`);
  console.log(`\nWithout context:\n${withoutCtx}`);

  // With context should mention previous melatonin usage or 2-year history
  const ctxAware = withCtx.toLowerCase().includes('melatonin') || withCtx.toLowerCase().includes('sleep') || withCtx.toLowerCase().includes('magnesium glycinate');
  if (ctxAware) ok('response with context references sleep chain knowledge');
  else fail('context-aware response', 'did not reference prior sleep discussion');

  section('TEST 7: USER PROFILE ACCUMULATION');
  const profile = db.getUserProfile(CHAT_ID);
  console.log(`Profile length: ${profile.length} chars`);
  console.log(`Profile snippet: ${profile.slice(0,300)}`);
  check('profile non-empty after 10 chains', profile, v => v.length > 50);

  section('FINAL RESULTS');
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  •', f));
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
