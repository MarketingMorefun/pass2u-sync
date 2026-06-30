/**
 * Google Sheets writer.
 *
 * Two auth modes are supported (OAuth preferred):
 *
 *  1. OAuth user credentials (works even when an org policy blocks service-account
 *     keys). Set all three:
 *       - GOOGLE_OAUTH_CLIENT_ID
 *       - GOOGLE_OAUTH_CLIENT_SECRET
 *       - GOOGLE_OAUTH_REFRESH_TOKEN   (obtained once via `npm run auth`)
 *     The script then writes AS that user, so the user just needs edit access to
 *     the sheet — no separate sharing step.
 *
 *  2. Service account (fallback). Set GOOGLE_SERVICE_ACCOUNT_KEY (JSON string) or
 *     GOOGLE_APPLICATION_CREDENTIALS (path), and share the sheet with the SA email.
 */

import { google } from 'googleapis';
import { DateTime } from 'luxon';
import {
  SPREADSHEET_ID,
  SHEET_TIME_ZONE,
  DATE_COLUMN,
  FIRST_DATA_ROW,
  PASS2U_ACCOUNTING_COLUMN,
  VOUCHER_COLUMNS,
} from './config.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

async function resolveAuth() {
  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN,
    GOOGLE_SERVICE_ACCOUNT_KEY,
    GOOGLE_APPLICATION_CREDENTIALS,
  } = process.env;

  if (GOOGLE_OAUTH_REFRESH_TOKEN) {
    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
      throw new Error('GOOGLE_OAUTH_REFRESH_TOKEN is set but CLIENT_ID/CLIENT_SECRET are missing.');
    }
    const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
    oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
    return oauth2;
  }

  if (GOOGLE_SERVICE_ACCOUNT_KEY || GOOGLE_APPLICATION_CREDENTIALS) {
    const credentials = GOOGLE_SERVICE_ACCOUNT_KEY ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY) : undefined;
    const auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
    return auth.getClient();
  }

  throw new Error(
    'No Google credentials. Set GOOGLE_OAUTH_* (preferred) or GOOGLE_SERVICE_ACCOUNT_KEY.',
  );
}

export async function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: await resolveAuth() });
}

const colLetter = (index) => COLUMN_LETTERS[index - 1];

/** Read column A and return { 'dd/MM/yyyy' -> rowNumber }. */
async function buildDateToRow(sheets, sheetName) {
  const range = `${sheetName}!${colLetter(DATE_COLUMN)}${FIRST_DATA_ROW}:${colLetter(DATE_COLUMN)}`;
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  });

  const map = {};
  (data.values || []).forEach((row, i) => {
    const key = normalizeDateCell(row[0]);
    if (key) map[key] = FIRST_DATA_ROW + i;
  });
  return map;
}

function normalizeDateCell(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    // Google Sheets serial date: days since 1899-12-30 (UTC), display in sheet tz.
    const dt = DateTime.fromObject({ year: 1899, month: 12, day: 30 }, { zone: 'UTC' })
      .plus({ days: Math.floor(value) })
      .setZone(SHEET_TIME_ZONE, { keepLocalTime: true });
    return dt.isValid ? dt.toFormat('dd/LL/yyyy') : null;
  }
  const text = String(value).trim();
  for (const fmt of ['d/L/yyyy', 'd-L-yyyy', 'yyyy-LL-dd', 'yyyy/LL/dd']) {
    const dt = DateTime.fromFormat(text, fmt);
    if (dt.isValid) return dt.toFormat('dd/LL/yyyy');
  }
  return null;
}

/** Does this tab have the F:I voucher breakdown columns? (Burwood does not.) */
async function hasVoucherColumns(sheets, sheetName) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!F2:I2`,
  });
  const header = (data.values?.[0] || []).join('|');
  return header.includes('$4');
}

/**
 * Write aggregated counts. `bySheet` is the aggregate() result.
 * Returns a list of human-readable warnings (e.g. dates with no matching row).
 */
export async function writeAggregates(sheets, bySheet, { dryRun = false } = {}) {
  const warnings = [];
  const updates = [];

  for (const [sheetName, byDate] of Object.entries(bySheet)) {
    const dateToRow = await buildDateToRow(sheets, sheetName);
    const voucherColumns = await hasVoucherColumns(sheets, sheetName);

    for (const [dateKey, counts] of Object.entries(byDate)) {
      const row = dateToRow[dateKey];
      if (!row) {
        warnings.push(`${sheetName}: no row for ${dateKey} (skipped)`);
        continue;
      }

      updates.push({
        range: `${sheetName}!${colLetter(PASS2U_ACCOUNTING_COLUMN)}${row}`,
        values: [[counts.total || '']],
      });

      if (voucherColumns) {
        for (const [voucherType, column] of Object.entries(VOUCHER_COLUMNS)) {
          updates.push({
            range: `${sheetName}!${colLetter(column)}${row}`,
            values: [[counts.byVoucher[voucherType] || '']],
          });
        }
      }
    }
  }

  if (dryRun) {
    return { warnings, written: 0, updates };
  }
  if (updates.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
    });
  }
  return { warnings, written: updates.length };
}
