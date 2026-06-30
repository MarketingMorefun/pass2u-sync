/**
 * Static configuration: Pass2U models, store/voucher mappings and sheet layout.
 *
 * Routing rules:
 *  - Which sheet tab (store)  -> from the redemption's `scannerName` (who scanned it),
 *    with a fallback to the model name when scannerName is missing/unknown.
 *  - Which voucher column     -> from the redemption's `modelId`.
 *
 * Only the per-voucher breakdown columns (F/G/H/I) are written, and only on tabs
 * that actually have the $4/$8/$10/1h-free header row (detected at runtime). Column E
 * ("Pass2U Accounting") is intentionally left untouched everywhere for manual upkeep.
 */

export const SPREADSHEET_ID = '1xffQDGVLDM-65fG8Y2daoJloYjhvJZZAhRw27KqLwgY';

// Sheet rows are bucketed by this timezone's calendar day.
export const SHEET_TIME_ZONE = 'Australia/Sydney';
// Pass2U stores/serves timestamps in this fixed offset (Taiwan server time).
export const PASS2U_SERVER_OFFSET = '+08:00';

export const PASS2U_WEB_BASE_URL = 'https://www.pass2u.net';
export const PASS2U_PAGE_SIZE = 100;

// Sheet layout (1-based column indexes). Column E ("Pass2U Accounting") is
// deliberately NOT written — it is maintained manually.
export const DATE_COLUMN = 1; // A
export const FIRST_DATA_ROW = 3;

// Voucher type -> breakdown column. Sheets that lack these columns only get column E.
export const VOUCHER_COLUMNS = {
  $4: 6, // F
  $8: 7, // G
  $10: 8, // H
  '1h free': 9, // I
};

// scannerName (checkout account) -> sheet tab name.
export const STORE_TO_SHEET = {
  Hornsby: 'HB',
  Townhall: '505',
  Burwood: 'Burwood',
  Haymarket: 'Haymarket',
};

// Fallback when scannerName is empty/unknown: guess the store from the model name.
export const MODEL_NAME_TO_SHEET_HINTS = [
  { pattern: /haymarket/i, sheetName: 'Haymarket' },
  { pattern: /hornsby/i, sheetName: 'HB' },
  { pattern: /townhall|town hall/i, sheetName: '505' },
  { pattern: /burwood/i, sheetName: 'Burwood' },
];

// Pass-model statuses to scan when resolving id -> puid (preferred order).
// A pass that is currently issuing (ISSUE) is where new redemptions land.
export const MODEL_DIRECTORY_STATUSES = ['ISSUE', 'SUSPEND', 'DRAFT'];

// The models to pull, keyed by the STABLE numeric `id`.
//   - `voucherType` : which breakdown column the redemptions count into.
// The records API actually keys on each pass's alphanumeric `puid`, which CHANGES
// when a pass is re-published. So puids are resolved at runtime from the model
// directory (see Pass2UClient.resolveModels) rather than hardcoded here.
// $5 (Cuesoc KOKO, id 362529) is intentionally excluded — it is not recorded.
export const PASS2U_MODELS = [
  { id: 360521, voucherType: '$4', name: 'Google Review $4 Voucher Haymarket' },
  { id: 375821, voucherType: '$4', name: 'SUMahjong Cityheroes $4 Voucher' },
  { id: 360752, voucherType: '$4', name: 'Google Review $4 Voucher Hornsby' },
  { id: 360754, voucherType: '$4', name: 'Google Review $4 Voucher Townhall' },
  { id: 360753, voucherType: '$4', name: 'Google Review $4 Voucher Burwood' },
  { id: 360787, voucherType: '$8', name: 'Cuecos Cityheroes $8 Voucher' },
  { id: 342422, voucherType: '1h free', name: 'One Hour free API' },
  { id: 343596, voucherType: '$10', name: 'Cityheroes $10 Voucher' },
  { id: 339543, voucherType: '$4', name: 'Cityheroes $4 Voucher' },
];
