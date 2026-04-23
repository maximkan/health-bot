#!/usr/bin/env node
// Run once: node scripts/google-auth.js
// Prints GOOGLE_REFRESH_TOKEN to add to .env

const { google } = require('googleapis');
const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');

const creds = JSON.parse(fs.readFileSync(path.join(__dirname, '../credentials.json'))).installed;
const oauth2Client = new google.auth.OAuth2(creds.client_id, creds.client_secret, 'http://localhost:3123');

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/calendar'],
});

console.log('\nOpen this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for Google to redirect...\n');

const server = http.createServer(async (req, res) => {
  const code = new url.URL(req.url, 'http://localhost:3123').searchParams.get('code');
  if (!code) { res.end('No code'); return; }

  res.end('<h2>Done! You can close this tab.</h2>');
  server.close();

  const { tokens } = await oauth2Client.getToken(code);
  console.log('\n✅ Add this to your .env file:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log('\nDone.\n');
});

server.listen(3123);
