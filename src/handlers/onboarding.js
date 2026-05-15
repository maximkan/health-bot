const db     = require('../db');
const claude = require('../claude');
const config = require('../config');

const S = {
  NAME: 1, LANGUAGE: 2, BIRTHDAY: 3, GENDER: 4, GOAL: 5,
  STATS: 6, TARGET_WEIGHT: 7, BODY_FAT: 8,
  ACTIVITY: 9, TRAINING: 10, TARGETS_CHOICE: 11,
  PLAN_CONFIRM: 12, TARGETS_INPUT: 13, COACHING_STYLE: 14,
  SLEEP: 15, TIMEZONE: 16, GCAL: 17, DONE: 18,
};

async function send(bot, chatId, text, language) {
  if (!language || /^en(glish)?$/i.test(language.trim())) {
    return bot.sendMessage(chatId, text);
  }
  try {
    const translated = await claude.translateText(text, language);
    return bot.sendMessage(chatId, translated);
  } catch {
    return bot.sendMessage(chatId, text);
  }
}

function ageFromBirthday(birthday) {
  if (!birthday) return null;
  const birth = new Date(birthday);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

const COACHING_Q = `How strict do you want me to be?\n\n1. Easy going — positive nudges, gentle when something's off\n2. Honest and direct — straight feedback, no fluff, but constructive\n3. No filter — full truth, no sugarcoating, ever`;

async function handleOnboarding(bot, msg) {
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const state  = db.getState(chatId);
  const step   = state.onboard_step || 0;
  const lang   = state.language || null;

  // ── Step 0: first message → welcome ──────────────────────────────────────
  if (step === 0) {
    db.setState(chatId, { onboard_step: S.NAME });
    await bot.sendMessage(chatId,
      "Hey! I'm your personal health coach bot 👋\n\nI'll help you track food, workouts, sleep, and keep you on track toward your goals.\n\nLet's get you set up in a couple minutes.\n\nWhat's your name?"
    );
    return;
  }

  // ── Step 1: name ──────────────────────────────────────────────────────────
  if (step === S.NAME) {
    const name = text.split(' ')[0];
    db.setState(chatId, { name, onboard_step: S.LANGUAGE });
    await bot.sendMessage(chatId, `Nice to meet you, ${name}! 🙌\n\nWhat language do you prefer? I'll talk to you in that language.\n(e.g. English, Malay, Chinese, Russian, etc.)`);
    return;
  }

  // ── Step 2: language ──────────────────────────────────────────────────────
  if (step === S.LANGUAGE) {
    db.setState(chatId, { language: text, onboard_step: S.BIRTHDAY });
    await send(bot, chatId, `Got it! What's your date of birth?`, text);
    return;
  }

  // ── Step 3: birthday ─────────────────────────────────────────────────────
  if (step === S.BIRTHDAY) {
    const parsed = await claude.parseOnboardingInput('birthday', text);
    if (!parsed?.date) {
      await send(bot, chatId, "Couldn't read that date. Try: 11/08/1999", lang);
      return;
    }
    const age = ageFromBirthday(parsed.date);
    db.setTargetsInDb(chatId, { birthday: parsed.date, age });
    db.setState(chatId, { onboard_step: S.GENDER });
    await send(bot, chatId, `Got it! Are you male or female?`, lang);
    return;
  }

  // ── Step 4: gender ───────────────────────────────────────────────────────
  if (step === S.GENDER) {
    const parsed = await claude.parseOnboardingInput('gender', text);
    if (!parsed?.gender) {
      await send(bot, chatId, "Please reply with male or female.", lang);
      return;
    }
    db.setState(chatId, { gender: parsed.gender, onboard_step: S.GOAL });
    await send(bot, chatId, `What's your main goal right now?\n\n1. Lose weight\n2. Gain muscle / bulk\n3. Maintain & recomp\n4. Just track habits`, lang);
    return;
  }

  // ── Step 5: goal ─────────────────────────────────────────────────────────
  if (step === S.GOAL) {
    const parsed = await claude.parseOnboardingInput('goal', text);
    if (!parsed?.goal) {
      await send(bot, chatId, "Please reply with 1, 2, 3, or 4.", lang);
      return;
    }
    db.setState(chatId, { goal: parsed.goal, onboard_step: S.STATS });
    await send(bot, chatId, `Got it 💪\n\nWhat's your current weight and height?\n(e.g. 95kg, 178cm)`, lang);
    return;
  }

  // ── Step 5: stats ─────────────────────────────────────────────────────────
  if (step === S.STATS) {
    const parsed = await claude.parseStats(text);
    if (!parsed?.weight_kg || !parsed?.height_cm) {
      await send(bot, chatId, "Need both weight and height, e.g: 95kg, 178cm", lang);
      return;
    }
    db.setTargetsInDb(chatId, { weight_kg: parsed.weight_kg, height_cm: parsed.height_cm });
    const needsTargetWeight = state.goal === 'lose' || state.goal === 'gain';
    if (needsTargetWeight) {
      db.setState(chatId, { onboard_step: S.TARGET_WEIGHT });
      const q = state.goal === 'lose' ? 'What weight are you aiming to reach?' : "What's your target weight for bulking?";
      await send(bot, chatId, q, lang);
    } else {
      db.setState(chatId, { onboard_step: S.BODY_FAT });
      await send(bot, chatId, "What body composition metrics do you track?\n\nShare what you have (e.g. \"18% body fat\", \"75kg muscle mass\", or both), or say skip.", lang);
    }
    return;
  }

  // ── Step 6: target weight ─────────────────────────────────────────────────
  if (step === S.TARGET_WEIGHT) {
    const parsed = await claude.parseOnboardingInput('goal_weight', text);
    if (!parsed?.weight_kg) {
      await send(bot, chatId, "Just type a number, e.g. 80", lang);
      return;
    }
    db.setTargetsInDb(chatId, { goal_weight: parsed.weight_kg });
    db.setState(chatId, { onboard_step: S.BODY_FAT });
    await send(bot, chatId, "What body composition metrics do you track?\n\nShare what you have (e.g. \"18% body fat\", \"75kg muscle mass\", or both), or say skip.", lang);
    return;
  }

  // ── Step 7: body fat + muscle mass ───────────────────────────────────────
  if (step === S.BODY_FAT) {
    const parsed = await claude.parseOnboardingInput('body_fat', text);
    const metrics = ['weight'];
    if (parsed?.body_fat) { db.setState(chatId, { body_fat_pct: parsed.body_fat }); metrics.push('body_fat'); }
    if (parsed?.muscle_mass_kg) {
      const tgts = db.getTargetsFromDb(chatId);
      db.setTargetsInDb(chatId, { ...tgts, muscle_mass_kg: parsed.muscle_mass_kg });
      metrics.push('muscle_mass');
    }
    db.setState(chatId, { body_metrics: metrics.join(','), onboard_step: S.ACTIVITY });
    await send(bot, chatId,
      "How active are you on a typical day outside the gym?\n\n1. Desk job, barely move\n2. Some walking, light movement\n3. On your feet a lot, 7k+ steps\n4. Very active — physical job or high activity", lang
    );
    return;
  }

  // ── Step 8: activity level ────────────────────────────────────────────────
  if (step === S.ACTIVITY) {
    const parsed = await claude.parseOnboardingInput('activity', text);
    if (!parsed?.level) {
      await send(bot, chatId, "Reply with 1, 2, 3, or 4.", lang);
      return;
    }
    db.setState(chatId, { activity_level: parsed.level, onboard_step: S.TRAINING });
    await send(bot, chatId, "Do you train or go to the gym? If yes — how many times a week?\n(e.g. yes, 4 times — or no)", lang);
    return;
  }

  // ── Step 9: training ──────────────────────────────────────────────────────
  if (step === S.TRAINING) {
    const parsed = await claude.parseOnboardingInput('training', text);
    const gymDays = parsed?.gym === false ? 0 : (parsed?.days ?? 3);
    db.setState(chatId, { gym_days: gymDays, onboard_step: S.TARGETS_CHOICE });
    await send(bot, chatId, "Do you already know your daily calorie and macro targets?\n\n- Yes → I'll use your numbers\n- No → I'll create a personalized plan for you", lang);
    return;
  }

  // ── Step 10: targets choice ───────────────────────────────────────────────
  if (step === S.TARGETS_CHOICE) {
    const parsed = await claude.parseOnboardingInput('knows_targets', text);
    if (parsed?.knows) {
      db.setState(chatId, { onboard_step: S.TARGETS_INPUT });
      await send(bot, chatId, "What are your daily targets?\n(e.g. 1800 kcal, 180g protein, 100g carbs, 60g fat)", lang);
    } else {
      await send(bot, chatId, "Calculating your personalized plan... 🧠", lang);
      await bot.sendChatAction(chatId, 'typing');
      try {
        const st  = db.getState(chatId);
        const tgt = db.getTargetsFromDb(chatId);
        const result = await claude.generateOnboardingTargets({
          name: st.name, weight_kg: tgt.weight_kg, height_cm: tgt.height_cm,
          age: tgt.age ?? ageFromBirthday(tgt.birthday),
          gender: st.gender,
          goal: st.goal, goal_weight: tgt.goal_weight,
          body_fat_pct: st.body_fat_pct, activity_level: st.activity_level,
          gym_days: st.gym_days, language: lang,
        });
        if (result) {
          db.setTargetsInDb(chatId, { calories: result.calories, protein: result.protein, carbs: result.carbs, fat: result.fat });
          db.setState(chatId, { onboard_step: S.PLAN_CONFIRM });
          const planMsg = `Here's your plan:\n\n🔥 ${result.calories} kcal/day\n🥩 ${result.protein}g protein\n🍞 ${result.carbs}g carbs\n🥑 ${result.fat}g fat\n\n${result.explanation}\n\nDoes this work for you, or do you want to adjust anything?`;
          await send(bot, chatId, planMsg, lang);
        } else {
          db.setState(chatId, { onboard_step: S.TARGETS_INPUT });
          await send(bot, chatId, "Couldn't generate targets. Please type them manually:\n(e.g. 1800 kcal, 180g protein, 100g carbs, 60g fat)", lang);
        }
      } catch (err) {
        console.error('Onboarding targets error:', err.message);
        db.setState(chatId, { onboard_step: S.TARGETS_INPUT });
        await send(bot, chatId, "Something went wrong. Please type your targets manually:\n(e.g. 1800 kcal, 180g protein)", lang);
      }
    }
    return;
  }

  // ── Step 11: plan confirm ─────────────────────────────────────────────────
  if (step === S.PLAN_CONFIRM) {
    const parsed = await claude.parseOnboardingInput('wants_change', text);
    if (parsed?.wants_change) {
      db.setState(chatId, { onboard_step: S.TARGETS_INPUT });
      await send(bot, chatId, "No problem — type your preferred targets.\n(e.g. 2500 kcal, 160g protein, 250g carbs, 70g fat)", lang);
    } else {
      db.setState(chatId, { onboard_step: S.COACHING_STYLE });
      await send(bot, chatId, COACHING_Q, lang);
    }
    return;
  }

  // ── Step 12: targets input ────────────────────────────────────────────────
  if (step === S.TARGETS_INPUT) {
    const calMatch  = text.match(/(\d+)\s*(?:kcal|cal|calories?|ккал|калор)/i);
    const protMatch = text.match(/(\d+)\s*g?\s*(?:protein|prot|белок|протеин)/i);
    const carbMatch = text.match(/(\d+)\s*g?\s*(?:carb|carbs|углев)/i);
    const fatMatch  = text.match(/(\d+)\s*g?\s*(?:fat|жир)/i);
    const nums      = [...text.matchAll(/\d+/g)].map(m => parseInt(m[0]));
    if (!calMatch && !protMatch && nums.length < 2) {
      await send(bot, chatId, "Try: 1800 kcal, 180g protein, 100g carbs, 60g fat", lang);
      return;
    }
    const updates = {};
    if (calMatch)        updates.calories = parseInt(calMatch[1]);
    else if (nums[0])    updates.calories = nums[0];
    if (protMatch)       updates.protein  = parseInt(protMatch[1]);
    else if (nums[1])    updates.protein  = nums[1];
    if (carbMatch)       updates.carbs    = parseInt(carbMatch[1]);
    else if (nums[2])    updates.carbs    = nums[2];
    if (fatMatch)        updates.fat      = parseInt(fatMatch[1]);
    else if (nums[3])    updates.fat      = nums[3];
    db.setTargetsInDb(chatId, updates);
    db.setState(chatId, { onboard_step: S.COACHING_STYLE });
    const t = db.getTargetsFromDb(chatId);
    await send(bot, chatId, `Saved: ${t.calories} kcal / ${t.protein}g P / ${t.carbs}g C / ${t.fat}g F\n\n${COACHING_Q}`, lang);
    return;
  }

  // ── Step 13: coaching style ───────────────────────────────────────────────
  if (step === S.COACHING_STYLE) {
    const parsed = await claude.parseOnboardingInput('coaching_style', text);
    const style = parsed?.style ?? 2;
    db.setState(chatId, { coaching_style: style, onboard_step: S.SLEEP });
    const styleName = style === 1 ? 'Chill — keeping it positive 😊' : style === 3 ? 'Strict — full honesty, no sugarcoating 💪' : 'Balanced — honest and constructive 👍';
    await send(bot, chatId, `${styleName}\n\nWhat time do you usually go to sleep and wake up?\n(e.g. midnight, 7am)`, lang);
    return;
  }

  // ── Step 14: sleep schedule ───────────────────────────────────────────────
  if (step === S.SLEEP) {
    const parsed = await claude.parseOnboardingInput('sleep', text);
    if (parsed?.bed)  db.setState(chatId, { bed_time_pref: parsed.bed });
    if (parsed?.wake) db.setState(chatId, { wake_time_pref: parsed.wake });
    db.setState(chatId, { onboard_step: S.TIMEZONE });
    await send(bot, chatId, "What city are you in? (I'll set the right timezone for your reminders)", lang);
    return;
  }

  // ── Step 15: timezone ─────────────────────────────────────────────────────
  if (step === S.TIMEZONE) {
    const TIMEZONE_MAP = {
      'kuala lumpur': 'Asia/Kuala_Lumpur', 'kl': 'Asia/Kuala_Lumpur', 'malaysia': 'Asia/Kuala_Lumpur',
      'singapore': 'Asia/Singapore', 'jakarta': 'Asia/Jakarta', 'bangkok': 'Asia/Bangkok',
      'moscow': 'Europe/Moscow', 'москва': 'Europe/Moscow',
      'london': 'Europe/London', 'paris': 'Europe/Paris', 'berlin': 'Europe/Berlin',
      'new york': 'America/New_York', 'los angeles': 'America/Los_Angeles',
      'dubai': 'Asia/Dubai', 'hong kong': 'Asia/Hong_Kong', 'tokyo': 'Asia/Tokyo',
      'seoul': 'Asia/Seoul', 'sydney': 'Australia/Sydney',
    };
    const lc = text.toLowerCase();
    const tz = TIMEZONE_MAP[lc] || TIMEZONE_MAP[Object.keys(TIMEZONE_MAP).find(k => lc.includes(k))] || 'Asia/Kuala_Lumpur';
    db.setState(chatId, { timezone: tz, onboard_step: S.GCAL });

    const gcalUrl = `${config.gcalAuthUrl}/auth/gcal?user=${chatId}`;
    await send(bot, chatId,
      `Set to ${tz} 🌍\n\nWant to connect Google Calendar? I'll sync your events automatically and remind you 30 min before each one.\n\nTap here to connect: ${gcalUrl}\n\nOr say "skip" to continue without it.`, lang
    );
    return;
  }

  // ── Step 16: gcal ─────────────────────────────────────────────────────────
  if (step === S.GCAL) {
    const freshState = db.getState(chatId);
    const parsed = await claude.parseOnboardingInput('knows_targets', text); // reuse yes/no parser
    const skipped = !parsed?.knows;
    if (!skipped && !freshState.gcal_refresh_token) {
      const gcalUrl = `${config.gcalAuthUrl}/auth/gcal?user=${chatId}`;
      await send(bot, chatId, `Haven't received the connection yet. Try the link again: ${gcalUrl}\n\nOr say "skip" to continue.`, lang);
      return;
    }
    await finishOnboarding(bot, chatId);
    return;
  }
}

async function finishOnboarding(bot, chatId) {
  const state = db.getState(chatId);
  const t     = db.getTargetsFromDb(chatId);
  const name  = state.name || 'there';
  const lang  = state.language || null;
  db.setState(chatId, { onboarded: 1, onboard_step: S.DONE, status: 'sleeping', current_day_start: null });
  require('../cron').scheduleUserDailyCrons(chatId);

  const guideText = `You're all set, ${name}! Here's how I work:

Morning: send any wake-up message ("gm", "morning", "woke up", or the equivalent in your language) — I'll show your schedule for the day.

Log anything in plain text or your language:
  "had chicken rice for lunch"
  "did chest + back, 45 min"
  "coffee, double shot"
  "weighed 94kg this morning"

Or send a photo of your meal — I'll estimate the macros.

I'll always show a preview before saving anything.

Plans & calendar:
  "gym tomorrow at 10am"
  "dentist Friday 3pm"
  I'll remind you 30 min before.${state.gcal_refresh_token ? '\n  Your Google Calendar is synced — events import automatically.' : ''}

At 7:30pm I'll check in on your day.
To go to bed — send any goodnight message ("gn", "going to bed", or the equivalent in your language). I'll send your full day summary — macros, training, energy balance, and whether you hit your targets.

Ask me anything:
  "what can I eat for 400 kcal?"
  "how's my week looking?"
  "full progress report since I started"

Your targets: ${t.calories} kcal / ${t.protein}g protein / ${t.carbs}g carbs / ${t.fat}g fat

Today you can log meals or workouts right away. Say goodnight when you're done and I'll send your first summary. Or just wake up tomorrow and start fresh. Let's go 🔥`;

  await send(bot, chatId, guideText, lang);
}

module.exports = { handleOnboarding, ageFromBirthday };
