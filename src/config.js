module.exports = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  telegram: {
    healthToken: process.env.TELEGRAM_HEALTH_BOT_TOKEN,
    golfToken: process.env.TELEGRAM_GOLF_BOT_TOKEN,
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    db: {
      mealLog: process.env.NOTION_MEAL_LOG_DS,
      workoutLog: process.env.NOTION_WORKOUT_LOG_DS,
      recoveryLog: process.env.NOTION_RECOVERY_LOG_DS,
      sleepLog: process.env.NOTION_SLEEP_LOG_DS,
      bodyMeasurements: process.env.NOTION_BODY_MEASUREMENTS_DS,
      coachNotes: process.env.NOTION_COACH_NOTES_DS,
      knownFoods: process.env.NOTION_KNOWN_FOODS_DS,
      golfLog: process.env.NOTION_GOLF_LOG_DS,
      plans:   process.env.NOTION_PLANS_DS,
    },
    pages: {
      targets: process.env.NOTION_TARGETS_PAGE,
      golfHub: process.env.NOTION_GOLF_HUB_PAGE,
      healthHub: process.env.NOTION_HEALTH_HUB_PAGE,
    },
  },
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
};

