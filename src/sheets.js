/**
 * Google Sheets writer.
 *
 * Talks to the Sheets REST API directly via Node's native fetch (undici) instead
 * of the `googleapis` client. The googleapis transport (gaxios + node-fetch) was
 * consistently failing on GitHub runners with "Invalid response body ... Premature
 * close" against oauth2.googleapis.com; native fetch handles the connection cleanly.
 *
 * Two auth modes (OAuth preferred):
 *
 *  1. OAuth user credentials (works even when an org policy blocks service-account
 *     keys). Set all three:
 *       - GOOGLE_OAUTH_CLIENT_ID
 *       - GOOGLE_OAUTH_CLIENT_SECRET
 *       - GOOGLE_OAUTH_REFRESH_TOKEN   (obtained once via `npm run auth`)
 *     The script writes AS that user, so the user just needs edit access to the
 *     sheet — no separate sharing step.
 *
 *  2. Service account (fallback). Set GOOGLE_SERVICE_ACCOUNT_KEY (JSON string) or
 *     GOOGLE_APPLICATION_CREDENTIALS (path), and share the sheet with the SA email.
 */

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { DateTime } from 'luxon';
import {
  SPREADSHEET_ID,
  SHEET_TIME_ZONE,
  DATE_COLUMN,
  FIRST_DATA_ROW,
  VOUCHER_COLUMNS,
} from './config.js';

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const COLUMN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Mint a short-lived access token. OAuth refresh-token grant, or a service-account JWT. */
async function getAccessToken() {
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
    const body = new URLSearchParams({
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    });
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(
        `OAuth token exchange failed (${res.status}): ${data.error || ''} ${data.error_description || ''}`.trim(),
      );
    }
    return data.access_token;
  }

  if (GOOGLE_SERVICE_ACCOUNT_KEY || GOOGLE_APPLICATION_CREDENTIALS) {
    // Service-account JWT bearer flow (RFC 7523), all via native fetch.
    const key = GOOGLE_SERVICE_ACCOUNT_KEY
      ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY)
      : JSON.parse(await readFile(GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
    const assertion = signServiceAccountJwt(key);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(`Service-account token exchange failed (${res.status}): ${data.error_description || data.error || ''}`);
    }
    return data.access_token;
  }

  throw new Error('No Google credentials. Set GOOGLE_OAUTH_* (preferred) or GOOGLE_SERVICE_ACCOUNT_KEY.');
}

/** Build and sign a service-account JWT assertion (RS256) for the token endpoint. */
function signServiceAccountJwt(key) {
  const now = Math.floor(Date.now() / 1000);
  const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({
    iss: key.client_email,
    scope: SCOPES.join(' '),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(key.private_key).toString('base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Minimal Sheets client over native fetch, shaped like the slice of the googleapis
 * client this code used (`sheets.spreadsheets.values.get` / `.batchUpdate`).
 */
export async function getSheetsClient() {
  const token = await getAccessToken();
  const authHeaders = { Authorization: `Bearer ${token}` };

  const valuesGet = async ({ spreadsheetId, range, valueRenderOption, dateTimeRenderOption }) => {
    const params = new URLSearchParams();
    if (valueRenderOption) params.set('valueRenderOption', valueRenderOption);
    if (dateTimeRenderOption) params.set('dateTimeRenderOption', dateTimeRenderOption);
    const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?${params}`;
    const res = await fetch(url, { headers: authHeaders });
    if (!res.ok) throw new Error(`Sheets values.get ${range} failed (${res.status}): ${await res.text()}`);
    return { data: await res.json() };
  };

  const batchUpdate = async ({ spreadsheetId, requestBody }) => {
    const url = `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    if (!res.ok) throw new Error(`Sheets values.batchUpdate failed (${res.status}): ${await res.text()}`);
    return { data: await res.json() };
  };

  return { spreadsheets: { values: { get: valuesGet, batchUpdate } } };
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
    // Only the per-voucher breakdown columns (F/G/H/I) are written. The
    // "Pass2U Accounting" total column (E) is left untouched on every tab.
    // A tab is written only if it actually has the $4/$8/$10/1h-free header row.
    const voucherColumns = await hasVoucherColumns(sheets, sheetName);
    if (!voucherColumns) {
      warnings.push(`${sheetName}: no voucher breakdown columns — nothing written (E left untouched)`);
      continue;
    }

    const dateToRow = await buildDateToRow(sheets, sheetName);
    for (const [dateKey, counts] of Object.entries(byDate)) {
      const row = dateToRow[dateKey];
      if (!row) {
        warnings.push(`${sheetName}: no row for ${dateKey} (skipped)`);
        continue;
      }

      for (const [voucherType, column] of Object.entries(VOUCHER_COLUMNS)) {
        updates.push({
          range: `${sheetName}!${colLetter(column)}${row}`,
          values: [[counts.byVoucher[voucherType] || '']],
        });
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
