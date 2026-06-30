/**
 * Entry point: pull Pass2U redemptions for a date window and write daily
 * redeemed counts into the Google Sheet.
 *
 * Usage:
 *   node src/index.js                 # last 14 days (default)
 *   node src/index.js --days 30
 *   node src/index.js --from 2026-06-01 --to 2026-06-29
 *   node src/index.js --dry-run       # fetch + aggregate, print, but don't write
 */

import { DateTime } from 'luxon';
import { SHEET_TIME_ZONE } from './config.js';
import { Pass2UClient } from './pass2u.js';
import { aggregate } from './aggregate.js';
import { getSheetsClient, writeAggregates } from './sheets.js';

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
  if (!from.isValid || !to.isValid) {
    throw new Error('Invalid --from/--to date.');
  }
  return { from, to };
}

async function main() {
  const args = parseArgs(process.argv);
  const { from, to } = resolveWindow(args);

  console.log(
    `[pass2u-sync] window ${from.toFormat('dd/LL/yyyy')} – ${to.toFormat('dd/LL/yyyy')} (${SHEET_TIME_ZONE})` +
      (args.dryRun ? ' [dry-run]' : ''),
  );

  const client = new Pass2UClient({
    email: process.env.PASS2U_EMAIL,
    password: process.env.PASS2U_PASSWORD,
  });
  await client.login();
  console.log('[pass2u-sync] logged in.');

  const { records, unresolved } = await client.fetchAllRedemptions(from, to);
  console.log(`[pass2u-sync] fetched ${records.length} redeemed records.`);
  if (unresolved.length) {
    console.warn(
      `[pass2u-sync] ${unresolved.length} configured model(s) could not be resolved to a puid: ` +
        unresolved.map((m) => `${m.id} (${m.name})`).join(', '),
    );
  }

  const { result, skipped } = aggregate(records);
  if (skipped.length) {
    console.warn(`[pass2u-sync] ${skipped.length} records could not be routed to a store/date.`);
  }

  for (const [sheetName, byDate] of Object.entries(result)) {
    const total = Object.values(byDate).reduce((sum, d) => sum + d.total, 0);
    console.log(`  ${sheetName}: ${total} across ${Object.keys(byDate).length} day(s)`);
  }

  const sheets = await getSheetsClient();
  const { warnings, written, updates } = await writeAggregates(sheets, result, {
    dryRun: args.dryRun,
  });
  warnings.forEach((w) => console.warn(`[pass2u-sync] ${w}`));

  if (args.dryRun) {
    console.log(`[pass2u-sync] dry-run: ${updates.length} cell update(s) would be written.`);
  } else {
    console.log(`[pass2u-sync] wrote ${written} cell(s).`);
  }
}

main().catch((err) => {
  console.error(`[pass2u-sync] FAILED: ${err.message}`);
  process.exit(1);
});
