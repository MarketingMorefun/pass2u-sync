/**
 * Google review counter.
 *
 * Fetches each KOKO location's reviews via the Business Profile API (Google My
 * Business v4), counts how many reviews were created on each calendar day
 * (Australia/Sydney), and writes the daily count into each store tab's review
 * column. Idempotent: it overwrites the review column for every existing date row
 * inside the window (0 on days with no reviews), so re-running just refreshes.
 *
 * Usage mirrors the Pass2U sync:
 *   node src/reviews.js                 # last 14 days
 *   node src/reviews.js --days 30
 *   node src/reviews.js --from 2026-03-02
 *   node src/reviews.js --dry-run       # fetch + count, print, but don't write
 */

import { DateTime } from 'luxon';
import { SPREADSHEET_ID, SHEET_TIME_ZONE, REVIEW_LOCATIONS, REVIEW_COLUMN } from './config.js';
import { getAccessToken, getSheetsClient, buildDateToRow } from './sheets.js';

const GBP_BASE = 'https://mybusiness.googleapis.com/v4';
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const colLetter = (i) => COLUMN_LETTERS[i - 1];

function parseArgs(argv) {
  const args = { days: 14, dryRun: false, from: null, to: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--days') args.days = Number(argv[++i]);
    else if (arg === '--from') args.from = argv[++i];
    else if (arg === '--to') args.to = argv[++i];
  }
  return args;
}

function resolveWindow(args) {
  const tz = SHEET_TIME_ZONE;
  const to = args.to
    ? DateTime.fromISO(args.to, { zone: tz }).endOf('day')
    : DateTime.now().setZone(tz).endOf('day');
  const from = args.from
    ? DateTime.fromISO(args.from, { zone: tz }).startOf('day')
    : to.startOf('day').minus({ days: args.days - 1 });
  if (!from.isValid || !to.isValid) throw new Error('Invalid --from/--to date.');
  return { from, to };
}

/** Page through every review for a location (v4). Returns the raw review objects. */
async function fetchReviews(locationName, token) {
  const reviews = [];
  let pageToken;
  do {
    const url = `${GBP_BASE}/${locationName}/reviews?pageSize=50${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Business Profile reviews ${locationName} failed (${res.status}): ${text}`);
    const data = JSON.parse(text);
    reviews.push(...(data.reviews || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return reviews;
}

/** Count reviews by Sydney calendar day. Returns { 'dd/LL/yyyy' -> count }. */
function countByDay(reviews) {
  const byDate = {};
  for (const review of reviews) {
    if (!review.createTime) continue;
    const dt = DateTime.fromISO(review.createTime, { zone: 'utc' }).setZone(SHEET_TIME_ZONE);
    if (!dt.isValid) continue;
    const key = dt.toFormat('dd/LL/yyyy');
    byDate[key] = (byDate[key] || 0) + 1;
  }
  return byDate;
}

async function main() {
  const args = parseArgs(process.argv);
  const { from, to } = resolveWindow(args);

  console.log(
    `[reviews] window ${from.toFormat('dd/LL/yyyy')} – ${to.toFormat('dd/LL/yyyy')} (${SHEET_TIME_ZONE})` +
      (args.dryRun ? ' [dry-run]' : ''),
  );

  const token = await getAccessToken();

  // Fetch + count per store tab.
  const bySheet = {};
  for (const [sheetName, location] of Object.entries(REVIEW_LOCATIONS)) {
    const byDate = countByDay(await fetchReviews(location, token));
    bySheet[sheetName] = byDate;
    const inWindow = Object.entries(byDate).filter(([k]) => {
      const dt = DateTime.fromFormat(k, 'dd/LL/yyyy', { zone: SHEET_TIME_ZONE });
      return dt.isValid && dt >= from && dt <= to;
    });
    const total = inWindow.reduce((sum, [, n]) => sum + n, 0);
    console.log(`  ${sheetName}: ${total} review(s) across ${inWindow.length} day(s) in window`);
  }

  // Write the count into every existing date row inside the window (0 if none).
  const sheets = await getSheetsClient(token);
  const warnings = [];
  const updates = [];
  for (const [sheetName, byDate] of Object.entries(bySheet)) {
    const dateToRow = await buildDateToRow(sheets, sheetName);
    for (const [dateKey, row] of Object.entries(dateToRow)) {
      const dt = DateTime.fromFormat(dateKey, 'dd/LL/yyyy', { zone: SHEET_TIME_ZONE });
      if (!dt.isValid || dt < from || dt > to) continue;
      updates.push({
        range: `${sheetName}!${colLetter(REVIEW_COLUMN)}${row}`,
        values: [[byDate[dateKey] || 0]],
      });
    }
  }
  warnings.forEach((w) => console.warn(`[reviews] ${w}`));

  if (args.dryRun) {
    console.log(`[reviews] dry-run: ${updates.length} cell update(s) would be written to column ${colLetter(REVIEW_COLUMN)}:`);
    for (const u of updates) console.log(`   ${u.range} = ${u.values[0][0]}`);
    return;
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }
  console.log(`[reviews] wrote ${updates.length} cell(s).`);
}

main().catch((err) => {
  console.error(`[reviews] FAILED: ${err.message}`);
  process.exit(1);
});
