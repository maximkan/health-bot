require('dotenv').config();
const { startBot }     = require('./src/bot');
const { startGolfBot } = require('./src/golfBot');

startBot();
startGolfBot();
