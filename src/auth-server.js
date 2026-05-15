const http = require('http');
const url  = require('url');
const gcal = require('./gcal');
const db   = require('./db');

function start(botRef) {
  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);

    if (parsed.pathname === '/auth/gcal') {
      const chatId = parsed.query.user;
      if (!chatId) { res.end('Missing user parameter'); return; }
      const authUrl = gcal.getAuthUrl(chatId);
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    if (parsed.pathname === '/auth/gcal/callback') {
      const { code, state: chatId } = parsed.query;
      if (!code || !chatId) { res.end('Invalid callback'); return; }
      try {
        const refreshToken = await gcal.exchangeCode(code);
        if (refreshToken) {
          db.setState(Number(chatId), { gcal_refresh_token: refreshToken });
          const bot = botRef();
          await bot?.sendMessage(chatId, '✅ Google Calendar connected! Your events will now sync automatically.');
        }
        res.end('<html><body><h2>Connected! You can close this tab.</h2></body></html>');
      } catch (err) {
        console.error('GCal OAuth error:', err.message);
        res.end('Error connecting calendar. Please try again.');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(3000, () => console.log('✅ Auth server running on port 3000'));
}

module.exports = { start };
