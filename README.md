# pass2u-sync

Three scheduled automations that keep the Morefun accounting Google Sheet up to
date and watch for review-voucher abuse. Everything runs on GitHub Actions with no
server to babysit.

- **Spreadsheet:** <https://docs.google.com/spreadsheets/d/1xffQDGVLDM-65fG8Y2daoJloYjhvJZZAhRw27KqLwgY/edit>
- **Repo:** `MarketingMorefun/pass2u-sync`
- **Runtime:** Node ≥ 18, zero runtime dependencies for the Google calls (native `fetch`); `luxon` for dates.

| # | Automation | Source | Writes / sends | Schedule |
|---|---|---|---|---|
| 1 | Pass2U redemption sync | Pass2U dashboard | Sheet columns **F/G/H/I** (voucher breakdown) | Daily |
| 2 | Google review counter | Business Profile API | Sheet columns **C** (KOKO) & **K** (Cityheroes) | Daily |
| 3 | "G Review 2 Free Games" abuse check | Weekly tech email (CSV) | Summary **email** to marketing@ | Weekly (Mon) |

---

## Sheet layout (per store tab)

Tabs: **`505`**, **`Haymarket`**, **`HB`** (Hornsby), **`Burwood`**. Data rows start at
row 3; column A holds the date (`dd/MM/yyyy`, Australia/Sydney).

| Col | Header | Filled by | Notes |
|---|---|---|---|
| A | Date | — | Row key |
| B | G_Button_Useage | **manual** (accounting, from receipts) | Not touched by any script |
| C | KOKO Actual Review | **auto** — `reviews.js` | Daily new reviews for the KOKO listing |
| D | Variance | sheet formula | Not touched |
| E | Pass2U Accounting | **manual** | ⚠️ Never written — see [gotchas](#column-e-is-off-limits) |
| F–I | $4 / $8 / $10 / 1h free | **auto** — `index.js` | Pass2U voucher breakdown |
| J | Issue-Accounting | manual | Not touched |
| K | CH Actual Review | **auto** — `reviews.js` | Daily new reviews for the Cityheroes listing |
| L | Variance | sheet formula | Not touched |
| M | Easter $5 Voucher | manual | Not touched |

Scripts only write the columns marked **auto**. Writes are idempotent (they overwrite
the same cells), so re-running a full window self-heals missed days.

---

## Repository layout

```
src/
  index.js         # Automation 1 entry — Pass2U redemption sync
  pass2u.js        #   Pass2U dashboard client (login + records + id→puid)
  aggregate.js     #   raw records → per-tab, per-day voucher counts
  reviews.js       # Automation 2 entry — Google review counter (C/K columns)
  review-games.js  # Automation 3 entry — abuse check (Gmail CSV → summary email)
  sheets.js        # Google Sheets writer + OAuth/SA token mint (native fetch)
  config.js        # ALL mappings: stores, models, review locations, thresholds
scripts/
  get-refresh-token.mjs   # one-time OAuth helper (npm run auth / auth:gmail)
  list-gbp-locations.mjs  # list Business Profile account/location IDs
.github/workflows/
  sync.yml            # daily: Pass2U + reviews
  review-games.yml    # weekly: abuse check
```

---

## Google Cloud setup

Everything runs through **one** GCP project: **`morefun-gbp-api`**. The OAuth client's
project must have each API enabled — that is why the older `pass2u-sheet-sync` project
is no longer used (Business Profile review access was approved only in
`morefun-gbp-api`).

### APIs to enable (in `morefun-gbp-api`)

| API | Used by |
|---|---|
| Google Sheets API | Pass2U sync, review counter |
| Account Management API (`mybusinessaccountmanagement`) | `gbp:locations` discovery |
| Business Information API (`mybusinessbusinessinformation`) | `gbp:locations` discovery |
| Google My Business API — v4 (`mybusiness`) | review counter (reviews) — **access-gated, already approved** |
| Gmail API | abuse check |

### OAuth client

One **Desktop app** OAuth client in `morefun-gbp-api` is reused for everything
(`402801798369-…apps.googleusercontent.com`). Only the **refresh token** differs per
use, because each is authorized as a different account with different scopes.

The consent screen is **External + Testing**, so every account that authorizes must be
added under **Test users** (`https://console.cloud.google.com/auth/audience?project=morefun-gbp-api`).

### Two credential sets

| Env prefix | Account | Scopes | Used by |
|---|---|---|---|
| `GOOGLE_OAUTH_*` | the GBP-managing Google account | `spreadsheets`, `business.manage` | Pass2U sync + review counter |
| `GMAIL_OAUTH_*` | `marketing@morefun.com.au` (koko email inbox) | `gmail.readonly`, `gmail.send` | abuse check |

`GOOGLE_OAUTH_CLIENT_ID/SECRET` and `GMAIL_OAUTH_CLIENT_ID/SECRET` hold the **same**
client values; only the refresh tokens differ. This is expected, not a conflict.

### Getting the tokens

```bash
# Set 1 (Sheets + Business Profile) — sign in as the GBP-managing account:
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-… \
npm run auth                 # prints GOOGLE_OAUTH_REFRESH_TOKEN

# Set 2 (Gmail) — sign in as marketing@morefun.com.au:
GOOGLE_OAUTH_CLIENT_ID=…apps.googleusercontent.com \
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-… \
npm run auth:gmail           # prints GMAIL_OAUTH_REFRESH_TOKEN
```

On the "Google hasn't verified this app" screen (expected in Testing) → **Advanced →
Continue**.

---

## GitHub Secrets

Settings → Secrets and variables → Actions:

| Secret | For |
|---|---|
| `PASS2U_EMAIL` / `PASS2U_PASSWORD` | Pass2U issuer login |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REFRESH_TOKEN` | Pass2U sync + review counter |
| `GMAIL_OAUTH_CLIENT_ID` / `GMAIL_OAUTH_CLIENT_SECRET` / `GMAIL_OAUTH_REFRESH_TOKEN` | abuse check |

---

## Automation 1 — Pass2U redemption sync

```
POST /users/login                       email + password → JSESSIONID cookie
POST /api/v1/passes/models/{status}/query   resolve each config id → current puid
POST /api/v1/checkout/{puid}/campaigns/{id}/records?type=OneRedeem   per model
  → bucket by Sydney day + store (scannerName) + voucher type (modelId)
  → write F/G/H/I per tab via the Sheets REST API
```

**Why login every run:** the public `api.pass2u.net/v2` API has no redemption history;
it lives behind the dashboard endpoint, authed by a session cookie. Login is a plain
JSON POST, so every run logs in fresh and discards the cookie — nothing to expire.

**id vs puid:** each pass has a stable numeric `id` and an alphanumeric `puid` that
**changes when the pass is re-published**. The records API keys on `puid`. `config.js`
stores only the stable `id`s; `puid`s are resolved at runtime, so re-publishing a
voucher never silently breaks the sync.

Run:

```bash
npm run dry-run                                   # fetch + aggregate, print, no write
npm run sync                                      # last 14 days
node src/index.js --days 30
node src/index.js --from 2026-03-02 --to 2026-06-30
```

---

## Automation 2 — Google review counter

For each location in `REVIEW_SOURCES`, pages all reviews via **My Business v4**
(`GET …/v4/{account}/{location}/reviews`), counts them by **createTime** in the Sydney
calendar day, and writes the daily count into that source's column for every date row
in the window (0 on days with no reviews).

- **C column** ← KOKO Amusement listings, **K column** ← Cityheroes Billiards listings.
- Counts are **new reviews per day** (the daily increase), not a running total.
- Discover location IDs with `npm run gbp:locations`.

```bash
npm run reviews:dry-run                # fetch + count, print planned writes, no write
npm run reviews                        # last 14 days
node src/reviews.js --from 2026-03-02  # backfill history
```

---

## Automation 3 — "G Review 2 Free Games" abuse check

A tech mailbox (`support@kokoamusement.com.au`) emails a CSV of every free-games
button press (one card number per press). The check:

1. Reads the newest such email from the `marketing@morefun.com.au` inbox (Gmail API).
2. Parses the CSV detail section (`LocalTransactionDate, AccountNumbers, Quantity, Location`).
3. Flags abuse — the same card claiming free games more than once:
   - **Same-second duplicates** — same card at an identical timestamp (hard evidence).
   - **Repeated cards** — any card used `CARD_REPEAT_THRESHOLD`+ times (default 3).
4. Emails a summary to `REVIEW_ALERT_TO` (default `marketing@morefun.com.au`).

```bash
npm run review-games:dry-run                       # read latest email, print, don't send
npm run review-games                               # read + send the summary email
node src/review-games.js --file path/to/report.csv # analyze a local CSV instead
```

---

## GitHub Actions

Both workflows also support **Actions → Run workflow** (manual). `sync.yml` takes a
`days` input (e.g. `121` to backfill). All jobs run node with
`--dns-result-order=ipv4first` (see gotchas).

| Workflow | Schedule (UTC cron) | Sydney time | Does |
|---|---|---|---|
| `sync.yml` | `0 14 * * *` | ~00:00 AEST / 01:00 AEDT | Pass2U sync, then review counter (review step runs even if Pass2U fails) |
| `review-games.yml` | `0 3 * * 1` (Mondays) | ~13:00 | abuse check |

> Cron is fixed UTC and does **not** follow daylight saving; local fire time shifts an
> hour between AEST/AEDT. Adjust the cron if the exact hour matters.

---

## Configuration reference (`src/config.js`)

| Constant | Meaning |
|---|---|
| `SPREADSHEET_ID` | Target sheet |
| `SHEET_TIME_ZONE` | `Australia/Sydney` — day bucketing |
| `PASS2U_SERVER_OFFSET` | `+08:00` — Pass2U wire time (see FixedOffsetZone gotcha) |
| `VOUCHER_COLUMNS` | voucher type → column (`$4`→F … `1h free`→I) |
| `STORE_TO_SHEET` / `MODEL_NAME_TO_SHEET_HINTS` | scannerName → tab, with a model-name fallback |
| `PASS2U_MODELS` | passes to pull, keyed by stable `id` (+ `voucherType`) |
| `REVIEW_SOURCES` | KOKO/Cityheroes → target column + per-tab location IDs |
| `REVIEW_GAMES_SENDER` | `support@kokoamusement.com.au` |
| `REVIEW_ALERT_TO` | summary recipient (env-overridable) |
| `CARD_REPEAT_THRESHOLD` | flag cards used ≥ this many times (default 3) |

`$5` (Cuesoc KOKO, id `362529`) is intentionally excluded from the Pass2U pull.

---

## Troubleshooting

**`invalid_client` — "The provided client secret is invalid."**
The client secret is wrong/truncated. Desktop-app secrets start with `GOCSPX-`; copy
the full value from the OAuth client (or `Download JSON`).

**`invalid_grant`**
The refresh token was minted by a different OAuth client than the one now in use, or it
was revoked. Re-run `npm run auth` (or `auth:gmail`) and update the token everywhere.

**Business Profile / Gmail `403` SERVICE_DISABLED**
The API isn't enabled in the OAuth client's project. Enable it in **`morefun-gbp-api`**
(not `pass2u-sheet-sync`), since that project owns the client and the review access.

**`403 access_denied` — "app has not completed the Google verification process"**
The consent screen is in Testing and the account isn't a test user. Add it under **Test
users** (`…/auth/audience?project=morefun-gbp-api`), then re-authorize.

**`Invalid DateTime` sent to Pass2U (HTTP 400)** *(already fixed in code)*
`setZone('+08:00')` fails on Node 20's ICU (offset-style tz names need Node 22+). The
code builds the offset with `FixedOffsetZone` instead; keep that.

**`Premature close` against `oauth2.googleapis.com` / Sheets** *(already fixed)*
The `googleapis`/node-fetch transport drops connections on CI runners. All Google calls
use native `fetch` (undici), and workflows run with `--dns-result-order=ipv4first`
(runner IPv6 to Google is often broken). Keep both.

<a id="column-e-is-off-limits"></a>**Column E must never be written**
Column E ("Pass2U Accounting") is maintained manually. A sync once overwrote it and had
to be restored from Sheets version history. The Pass2U sync only writes F/G/H/I; do not
add an E write.

**Pass2U login rate limiting**
Repeated failed logins get throttled (ambiguous empty `200`s). `login()` verifies the
session with a real authed call and fails loudly — don't loop login on bad credentials.
