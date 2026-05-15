module.exports = {
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
  },
  telegram: {
    healthToken: process.env.TELEGRAM_HEALTH_BOT_TOKEN,
    golfToken: process.env.TELEGRAM_GOLF_BOT_TOKEN,
  },
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN,
  gcalAuthUrl: process.env.GCAL_AUTH_URL || 'http://204.168.220.82:3000',
};

