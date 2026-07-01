/**
 * One-time helper: list the Google Business Profile accounts + locations the
 * authorized user manages, printing the IDs needed to configure the review sync.
 *
 * Prereqs:
 *   - Re-authorize with the business.manage scope: `npm run auth` (scope already
 *     added), then update GOOGLE_OAUTH_REFRESH_TOKEN.
 *   - Enable these APIs in the GCP project:
 *       Account Management API   (mybusinessaccountmanagement.googleapis.com)
 *       Business Information API (mybusinessbusinessinformation.googleapis.com)
 *
 * Run:
 *   export GOOGLE_OAUTH_CLIENT_ID=...  GOOGLE_OAUTH_CLIENT_SECRET=...  GOOGLE_OAUTH_REFRESH_TOKEN=...
 *   npm run gbp:locations
 *
 * Copy each printed `accounts/<id>/locations/<id>` into config.js (GBP_LOCATIONS).
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ACCT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';

async function getAccessToken() {
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error('Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN.');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Token exchange failed (${res.status}): ${data.error_description || data.error || ''}`);
  }
  return data.access_token;
}

async function getJson(url, token) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

async function main() {
  const token = await getAccessToken();

  const accounts = [];
  let pageToken;
  do {
    const url = `${ACCT_API}/accounts?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const data = await getJson(url, token);
    accounts.push(...(data.accounts || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  if (!accounts.length) {
    console.log('No Business Profile accounts found for this user.');
    return;
  }

  for (const account of accounts) {
    // account.name is "accounts/<id>"
    console.log(`\n# ${account.accountName || account.name} (${account.name})`);
    let lpt;
    do {
      const url =
        `${INFO_API}/${account.name}/locations` +
        `?readMask=name,title,storefrontAddress&pageSize=100${lpt ? `&pageToken=${lpt}` : ''}`;
      const data = await getJson(url, token);
      for (const loc of data.locations || []) {
        // loc.name is "locations/<id>"; the v4 reviews endpoint needs it under the account.
        const v4Name = `${account.name}/${loc.name}`;
        const city = loc.storefrontAddress?.locality || '';
        console.log(`  ${(loc.title || '(no title)').padEnd(32)} ${v4Name}${city ? `   [${city}]` : ''}`);
      }
      lpt = data.nextPageToken;
    } while (lpt);
  }

  console.log('\nCopy the "accounts/.../locations/..." values into config.js (GBP_LOCATIONS).');
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
