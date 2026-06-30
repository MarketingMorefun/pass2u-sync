# Pass2U → Google Sheet sync

Pulls Pass2U redemption (OneRedeem) records and writes **daily redeemed counts**
into the accounting Google Sheet — one column E total per store/day, plus the
`$4 / $8 / $10 / 1h free` breakdown on tabs that have those columns.

- Spreadsheet: <https://docs.google.com/spreadsheets/d/1xffQDGVLDM-65fG8Y2daoJloYjhvJZZAhRw27KqLwgY/edit>
- Runs on a schedule via GitHub Actions (`.github/workflows/pass2u-sync.yml`).

## How it works

```
GitHub Actions (cron)
  → POST /users/login           (email + password → JSESSIONID cookie)
  → POST .../records?type=OneRedeem  for each model/campaign in the window
  → bucket by Sydney day + store (scannerName) + voucher type (modelId)
  → write column E + F:I via the Google Sheets API (service account)
```

### Why this design

- The **public `api.pass2u.net/v2` API has no redemption history** — it only does
  checkout/redeem. History only exists behind the logged-in dashboard endpoint
  `POST /api/v1/checkout/{modelId}/campaigns/{campaignId}/records`, which auth's
  purely via the session cookie.
- That session cookie expires, which made the old Apps Script (cookie pasted into
  Script Properties) unsustainable. **But login is just a plain JSON POST**, so we
  don't persist a session at all — every run logs in fresh and discards the cookie
  when it finishes. Nothing to expire, nothing to babysit. No Playwright needed.

## Configuration

All store/voucher/model mappings live in [`src/config.js`](src/config.js):

- `STORE_TO_SHEET` — `scannerName` (checkout account) → sheet tab. Verified against
  live data: redemptions come back tagged `Haymarket / Townhall / Hornsby / Burwood`,
  all of which route cleanly (0 unrouted in testing).
- `PASS2U_MODELS` — each pass keyed by its **stable numeric `id`** plus a `voucherType`.
- `$5` (Cuesoc KOKO, id `362529`) is intentionally **excluded** — it is not recorded
  at all (not fetched, not counted in column E).
- Column E is the **total** of every recorded redemption for that store/day; F:I are
  the per-type breakdown. Tabs without the F:I headers (e.g. `Burwood`) only get E.

### id vs. puid (important)

Each Pass2U pass has two identifiers: a stable numeric `id` (e.g. `360521`) and an
alphanumeric `puid` (e.g. `JwmCUielf10J`). **The records API keys on `puid`, not `id`**
— and the `puid` changes whenever a pass is re-published. So `config.js` stores only
the stable `id`s, and the client resolves the current `puid` for each at runtime from
the account's pass directory (`POST /api/v1/passes/models/{ISSUE|SUSPEND|DRAFT}/query`).
This is self-healing: re-publishing a voucher won't silently break the sync.

## Setup

### 1. Pass2U credentials

Use the **issuer (dashboard owner)** account that can see redemption records — ideally
a dedicated login. You need its email + password.

### 2. Google auth — OAuth (recommended)

Use this when an org policy blocks service-account keys
(`iam.disableServiceAccountKeyCreation`). The job writes AS a real user, so that
user just needs **edit access to the sheet** — no separate sharing step.

1. In Google Cloud Console (a project with the **Google Sheets API** enabled):
   configure the **OAuth consent screen** (User type *Internal* is fine for a
   Workspace org).
2. Create an **OAuth client ID** of type **Desktop app**. Note the **Client ID**
   and **Client secret**.
3. Get a refresh token once, locally, signing in as the account that can edit the
   sheet:
   ```bash
   cd Pass2u && npm install
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com \
   GOOGLE_OAUTH_CLIENT_SECRET=... \
   npm run auth
   ```
   A browser opens; approve, and the script prints `GOOGLE_OAUTH_REFRESH_TOKEN`.

> Fallback: if your org *does* allow service-account keys, you can instead set
> `GOOGLE_SERVICE_ACCOUNT_KEY` (the JSON) and share the sheet with the SA email.
> The code auto-detects whichever is configured (OAuth wins).

### 3. GitHub repository secrets

In the repo (`monoyuzu/website`) → Settings → Secrets and variables → Actions, add:

| Secret | Value |
| --- | --- |
| `PASS2U_EMAIL` | issuer account email |
| `PASS2U_PASSWORD` | issuer account password |
| `GOOGLE_OAUTH_CLIENT_ID` | Desktop OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Desktop OAuth client secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | from `npm run auth` |

The workflow runs daily at **21:10 UTC** (07:10 Sydney AEST). It also supports manual
runs via **Actions → Pass2U Sheet Sync → Run workflow**, with `days` and `dry_run`
inputs. Note: the cron is fixed UTC, so during AEDT (UTC+11) it fires at 08:10 local —
adjust the cron in the workflow if that matters.

## Local run

```bash
cd Pass2u
npm install
cp .env.example .env          # fill in real values
set -a; source .env; set +a

npm run dry-run               # fetch + aggregate, print, DO NOT write
npm run sync                  # last 14 days, write to sheet
node src/index.js --days 30
node src/index.js --from 2026-06-01 --to 2026-06-29
```

## Notes / gotchas

- **Login rate limiting:** repeated failed logins from one IP get throttled (the
  endpoint starts returning ambiguous `200` empty bodies). `login()` therefore
  verifies the session with a real authenticated call and fails loudly if the
  cookie isn't actually logged in. Don't loop the login on bad credentials.
- **Timezone:** rows are bucketed by `Australia/Sydney` calendar day. Record
  `redeemAt` values come back in **UTC** (`+00:00`); the date filter is sent in
  Pass2U's `+08:00` server time. Both representations are handled and the timezone
  constants live in `src/config.js`.
- **Idempotent:** re-running overwrites the same cells, so a daily full-window sync
  self-heals any previously missed days.
- The old `pass2u_google_sheet_auto_fill.gs` (Apps Script + manually pasted cookie)
  is superseded by this and kept only for reference.
# pass2u-sync
# pass2u-sync
