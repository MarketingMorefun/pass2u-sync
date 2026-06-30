/**
 * Turn raw Pass2U records into per-sheet, per-day voucher counts.
 *
 * Output shape:
 *   { [sheetName]: { [dd/MM/yyyy]: { total, byVoucher: { '$4': n, ... } } } }
 */

import { DateTime } from 'luxon';
import {
  SHEET_TIME_ZONE,
  PASS2U_SERVER_OFFSET,
  STORE_TO_SHEET,
  MODEL_NAME_TO_SHEET_HINTS,
} from './config.js';

/** Bucket key: the redemption's calendar day in the sheet timezone. */
export function sheetDateKey(redeemAt) {
  const dt = parseRedeemAt(redeemAt);
  return dt ? dt.setZone(SHEET_TIME_ZONE).toFormat('dd/LL/yyyy') : null;
}

/**
 * redeemAt may come back with an explicit offset or as a naive timestamp that
 * represents Pass2U server time (+08:00). Handle both.
 */
function parseRedeemAt(value) {
  if (!value) return null;
  const iso = DateTime.fromISO(value, { setZone: true });
  if (iso.isValid && /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return iso;
  const assumed = DateTime.fromISO(value, { zone: PASS2U_SERVER_OFFSET });
  if (assumed.isValid) return assumed;
  const sql = DateTime.fromSQL(value, { zone: PASS2U_SERVER_OFFSET });
  return sql.isValid ? sql : null;
}

function resolveSheet(record) {
  const byScanner = STORE_TO_SHEET[String(record.scannerName || '').trim()];
  if (byScanner) return byScanner;
  const byStore = STORE_TO_SHEET[String(record.scannerStore || '').trim()];
  if (byStore) return byStore;
  const hint = MODEL_NAME_TO_SHEET_HINTS.find((h) => h.pattern.test(record.modelName || ''));
  return hint ? hint.sheetName : null;
}

export function aggregate(records) {
  const result = {};
  const skipped = [];

  for (const record of records) {
    const sheetName = resolveSheet(record);
    const dateKey = sheetDateKey(record.redeemAt);
    const voucherType = record.voucherType;

    if (!sheetName || !dateKey) {
      skipped.push(record);
      continue;
    }

    result[sheetName] ??= {};
    result[sheetName][dateKey] ??= { total: 0, byVoucher: {} };
    const bucket = result[sheetName][dateKey];
    bucket.total += 1;
    if (voucherType) {
      bucket.byVoucher[voucherType] = (bucket.byVoucher[voucherType] || 0) + 1;
    }
  }

  return { result, skipped };
}
