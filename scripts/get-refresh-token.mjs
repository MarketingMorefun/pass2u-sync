/**
 * One-time helper: obtain a Google OAuth refresh token for the Sheets sync.
 *
 * Prereqs (in a GCP project with the Google Sheets API enabled):
 *   1. Configure the OAuth consent screen (User type "Internal" is fine for a
 *      Workspace org).
 *   2. Create an OAuth client ID of type "Desktop app". Note its Client ID/Secret.
 *
 * Run:
 *   cd Pass2u
 *   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com \
 *   GOOGLE_OAUTH_CLIENT_SECRET=... \
 *   npm run auth
 *
 * A browser opens; sign in as the account that can EDIT the target sheet and
 * approve. The script prints GOOGLE_OAUTH_REFRESH_TOKEN — store it as a secret.
 */

import http from 'node:http';
import { exec } from 'node:child_process';
import { google } from 'googleapis';

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const PORT = Number(process.env.OAUTH_PORT || 4571);
const REDIRECT_URI = `http://localhost:${PORT}`;
// AUTH_MODE=gmail authorizes the mailbox owner for the review-games check (read the
// tech CSV + send the summary) and prints GMAIL_OAUTH_REFRESH_TOKEN. Default mode
// authorizes Sheets + Business Profile and prints GOOGLE_OAUTH_REFRESH_TOKEN.
const GMAIL_MODE = process.env.AUTH_MODE === 'gmail';
const SCOPES = GMAIL_MODE
  ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
  : [
      'https://www.googleapis.com/auth/spreadsheets',
      // Business Profile API (Google reviews).
      'https://www.googleapis.com/auth/business.manage',
    ];
const OUTPUT_VAR = GMAIL_MODE ? 'GMAIL_OAUTH_REFRESH_TOKEN' : 'GOOGLE_OAUTH_REFRESH_TOKEN';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET env vars.');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent', // force a refresh_token even on repeat runs
  scope: SCOPES,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/') {
    res.writeHead(204).end();
    return;
  }
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.end(`Authorization failed: ${error}. You can close this tab.`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end('Missing ?code');
    return;
  }
  res.end('Authorized. You can close this tab and return to the terminal.');
  server.close();
  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error(
        '\nNo refresh_token returned. Remove this app at ' +
          'https://myaccount.google.com/permissions and run again.',
      );
      process.exit(1);
    }
    console.log('\n=== Success — store this as a secret ===');
    console.log(`${OUTPUT_VAR}=${tokens.refresh_token}`);
  } catch (err) {
    console.error(`\nToken exchange failed: ${err.message}`);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}\n`);
  console.log('Opening the consent screen. If it does not open, paste this URL:\n');
  console.log(authUrl + '\n');
  // Best-effort auto-open (macOS / Linux / WSL).
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  exec(`${opener} "${authUrl}"`, () => {});
});
