/**
 * Pass2U redemption -> Google Review Check auto fill.
 *
 * Setup in Google Sheets:
 * 1. Extensions -> Apps Script
 * 2. Paste this file.
 * 3. Project Settings -> Script Properties:
 *    PASS2U_SESSION_COOKIE = cookie from logged-in www.pass2u.net session
 *    Optional: PASS2U_API_TOKEN for official checkout model diagnostics
 * 4. Run fillLast14DaysFromPass2U() once and approve permissions.
 *
 * Pass2U redemption records come from the logged-in dashboard endpoint:
 * /api/v1/checkout/{modelId}/campaigns/{campaignId}/records?type=OneRedeem
 */

const SPREADSHEET_ID = '1xffQDGVLDM-65fG8Y2daoJloYjhvJZZAhRw27KqLwgY';
const TIME_ZONE = 'Australia/Sydney';

const CHECKOUT_ACCOUNT_TO_SHEET = {
  Hornsby: 'HB',
  Townhall: '505',
  Burwood: 'Burwood',
  Haymarket: 'Haymarket',
  // Add these if Pass2U has matching checkout accounts:
  // '614': '614',
  // 'HV': 'HV',
};

const VOUCHER_COLUMNS = {
  '$4': 6,       // F
  '$8': 7,       // G
  '$10': 8,      // H
  '1h free': 9,  // I
};

const MODEL_ID_TO_VOUCHER_TYPE = {
  360521: '$4',      // Google Review $4 Voucher Haymarket
  375821: '$4',      // SUMahjong Cityheroes $4 Voucher
  360752: '$4',      // Google Review $4 Voucher Hornsby
  360754: '$4',      // Google Review $4 Voucher Townhall
  360753: '$4',      // Google Review $4 Voucher Burwood
  362529: '$5',      // Cuesoc KOKO $5 Voucher, tracked only where sheet has $5 column
  360787: '$8',      // Cuecos Cityheroes $8 Voucher
  342422: '1h free', // One Hour free API
  343596: '$10',     // Cityheroes $10 Voucher
  339543: '$4',      // Cityheroes $4 Voucher
};

const MODEL_NAME_TO_SHEET_HINTS = [
  { pattern: /haymarket/i, sheetName: 'Haymarket' },
  { pattern: /hornsby/i, sheetName: 'HB' },
  { pattern: /townhall|town hall/i, sheetName: '505' },
  { pattern: /burwood/i, sheetName: 'Burwood' },
];

const PASS2U_ACCOUNTING_COLUMN = 5; // E
const DATE_COLUMN = 1;              // A
const FIRST_DATA_ROW = 3;
const PASS2U_CHECKOUT_BASE_URL = 'https://api.pass2u.net/v2/checkout';
const PASS2U_WEB_BASE_URL = 'https://www.pass2u.net';
const PASS2U_PAGE_SIZE = 100;

const PASS2U_MODELS = [
  { modelId: 360521, voucherType: '$4', name: 'Google Review $4 Voucher Haymarket' },
  { modelId: 375821, voucherType: '$4', name: 'SUMahjong Cityheroes $4 Voucher' },
  { modelId: 360752, voucherType: '$4', name: 'Google Review $4 Voucher Hornsby' },
  { modelId: 360754, voucherType: '$4', name: 'Google Review $4 Voucher Townhall' },
  { modelId: 360753, voucherType: '$4', name: 'Google Review $4 Voucher Burwood' },
  { modelId: 362529, voucherType: '$5', name: 'Cuesoc KOKO $5 Voucher' },
  { modelId: 360787, voucherType: '$8', name: 'Cuecos Cityheroes $8 Voucher' },
  { modelId: 342422, voucherType: '1h free', name: 'One Hour free API' },
  { modelId: 343596, voucherType: '$10', name: 'Cityheroes $10 Voucher' },
  { modelId: 339543, voucherType: '$4', name: 'Cityheroes $4 Voucher' },
];

function fillLast14DaysFromPass2U() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 13);
  fillPass2URange(start, end);
}

function fillPass2URange(startDate, endDate) {
  const records = fetchPass2UWebRedemptions(startDate, endDate)
    .map(normalizePass2URecord)
    .filter(Boolean)
    .filter(record => record.redeemed);

  const grouped = groupRedemptions(records);
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);

  Object.entries(grouped).forEach(([sheetName, byDate]) => {
    const sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      throw new Error(`Missing sheet tab: ${sheetName}`);
    }

    const dateToRow = buildDateToRowIndex(sheet);
    Object.entries(byDate).forEach(([dateKey, counts]) => {
      const row = dateToRow[dateKey];
      if (!row) {
        console.warn(`No row for ${dateKey} on ${sheetName}`);
        return;
      }

      const voucherCellsExist = hasVoucherTypeColumns(sheet);
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);

      sheet.getRange(row, PASS2U_ACCOUNTING_COLUMN).setValue(total || '');

      if (voucherCellsExist) {
        Object.entries(VOUCHER_COLUMNS).forEach(([voucherType, column]) => {
          sheet.getRange(row, column).setValue(counts[voucherType] || '');
        });
      }
    });
  });
}

function logPass2UWebCampaigns() {
  PASS2U_MODELS.forEach(model => {
    console.log(model.modelId, model.name, JSON.stringify(fetchPass2UWebCampaigns(model.modelId)));
  });
}

function fetchPass2UWebRedemptions(startDate, endDate) {
  return PASS2U_MODELS.flatMap(model => {
    const campaigns = fetchPass2UWebCampaigns(model.modelId)
      .filter(campaign => campaign.type === 'OneRedeem');

    return campaigns.flatMap(campaign => (
      fetchPass2UWebCampaignRecords(model, campaign, startDate, endDate)
    ));
  });
}

function fetchPass2UWebCampaigns(modelId) {
  const response = fetchPass2UWebJson(
    `${PASS2U_WEB_BASE_URL}/api/v1/checkout/${modelId}/campaigns/`,
    {
      method: 'get',
    }
  );

  return Array.isArray(response) ? response : [];
}

function fetchPass2UWebCampaignRecords(model, campaign, startDate, endDate) {
  const records = [];
  let startIndex = 0;

  while (true) {
    const payload = {
      startIndex,
      pageSize: PASS2U_PAGE_SIZE,
      fromRedeemAt: formatPass2UFilterDateTime(startDate, 0, 0, 0),
      toRedeemAt: formatPass2UFilterDateTime(endDate, 23, 59, 59),
      allRecords: false,
    };

    const data = fetchPass2UWebJson(
      `${PASS2U_WEB_BASE_URL}/api/v1/checkout/${model.modelId}/campaigns/${campaign.id}/records?type=OneRedeem`,
      {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
      }
    );

    const pageRecords = data.records || [];
    pageRecords.forEach(record => {
      record.modelId = model.modelId;
      record.modelName = data.modelName || model.name;
      record.voucherType = model.voucherType;
      record.campaignId = campaign.id;
      record.campaignName = campaign.name;
    });
    records.push(...pageRecords);

    if (pageRecords.length < PASS2U_PAGE_SIZE) {
      break;
    }
    startIndex += PASS2U_PAGE_SIZE;
  }

  return records;
}

function fetchPass2UWebJson(url, options) {
  const properties = PropertiesService.getScriptProperties();
  const cookie = properties.getProperty('PASS2U_SESSION_COOKIE');

  if (!cookie) {
    throw new Error('Missing PASS2U_SESSION_COOKIE in Script Properties.');
  }

  const response = UrlFetchApp.fetch(url, {
    method: options.method,
    contentType: options.contentType,
    payload: options.payload,
    headers: {
      Cookie: cookie,
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status < 200 || status >= 300) {
    throw new Error(`Pass2U web request failed with ${status}: ${body}`);
  }

  return JSON.parse(body);
}

function logPass2UCheckoutModels() {
  const properties = PropertiesService.getScriptProperties();
  const token = properties.getProperty('PASS2U_API_TOKEN');

  if (!token) {
    throw new Error('Missing PASS2U_API_TOKEN in Script Properties.');
  }

  Object.keys(CHECKOUT_ACCOUNT_TO_SHEET).forEach(account => {
    const url = `${PASS2U_CHECKOUT_BASE_URL}/models?${toQueryString({ account })}`;
    const response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        'x-api-key': token,
        Accept: 'application/json',
      },
      muteHttpExceptions: true,
    });

    console.log(account, response.getResponseCode(), response.getContentText());
  });
}

function fetchPass2URedemptions(startDate, endDate) {
  const properties = PropertiesService.getScriptProperties();
  const apiUrl = properties.getProperty('PASS2U_API_URL');
  const token = properties.getProperty('PASS2U_API_TOKEN');

  if (!apiUrl || !token) {
    throw new Error('Missing PASS2U_API_URL or PASS2U_API_TOKEN in Script Properties.');
  }

  const query = {
    start_date: formatIsoDate(startDate),
    end_date: formatIsoDate(endDate),
  };

  const url = `${apiUrl}?${toQueryString(query)}`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      'x-api-key': token,
      Accept: 'application/json',
    },
    muteHttpExceptions: true,
  });

  const status = response.getResponseCode();
  const body = response.getContentText();

  if (status < 200 || status >= 300) {
    throw new Error(`Pass2U API failed with ${status}: ${body}`);
  }

  const json = JSON.parse(body);
  return Array.isArray(json) ? json : (json.data || json.records || json.results || []);
}

function normalizePass2URecord(raw) {
  const checkoutAccount =
    raw.checkout_account ||
    raw.checkoutAccount ||
    raw.checkout_account_name ||
    raw.checkoutAccountName ||
    raw.checkout_user ||
    raw.checkoutUser ||
    raw.scannerName ||
    raw.store_name ||
    raw.storeName ||
    raw.scannerStore;

  const modelId =
    raw.model_id ||
    raw.modelId ||
    raw.modelID ||
    raw.pass_model_id ||
    raw.passModelId ||
    raw.model?.id ||
    raw.model?.modelId;

  const redeemedAt =
    raw.redeemed_at ||
    raw.redeemedAt ||
    raw.checkout_time ||
    raw.checkoutTime ||
    raw.redeemAt ||
    raw.updated_at ||
    raw.updatedAt;

  const voucherName =
    raw.model_name ||
    raw.modelName ||
    raw.model?.name ||
    raw.voucherType ||
    raw.voucher_name ||
    raw.voucherName ||
    raw.coupon_name ||
    raw.couponName ||
    raw.pass_name ||
    raw.passName ||
    raw.description ||
    '';

  const redeemed =
    raw.redeemed === true ||
    raw.status === 'redeemed' ||
    raw.status === 'used' ||
    Boolean(redeemedAt);

  const sheetName =
    CHECKOUT_ACCOUNT_TO_SHEET[String(checkoutAccount || '').trim()] ||
    detectSheetFromModelName(voucherName);
  const voucherType = detectVoucherType(modelId, voucherName);

  if (!sheetName || !redeemedAt || !voucherType) {
    return null;
  }

  return {
    sheetName,
    dateKey: formatSheetDate(new Date(redeemedAt)),
    voucherType,
    redeemed,
  };
}

function detectVoucherType(modelId, value) {
  const modelVoucherType = MODEL_ID_TO_VOUCHER_TYPE[Number(modelId)];
  if (modelVoucherType) {
    return modelVoucherType;
  }

  const text = String(value || '').toLowerCase();

  if (text.includes('$5') || text.includes('5 voucher')) {
    return '$5';
  }
  if (text.includes('1h') || text.includes('1 hour') || text.includes('one hour')) {
    return '1h free';
  }
  if (text.includes('$10') || text.includes('10 voucher')) {
    return '$10';
  }
  if (text.includes('$8') || text.includes('8 voucher')) {
    return '$8';
  }
  if (text.includes('$4') || text.includes('4 voucher')) {
    return '$4';
  }

  return null;
}

function detectSheetFromModelName(value) {
  const text = String(value || '');
  const match = MODEL_NAME_TO_SHEET_HINTS.find(({ pattern }) => pattern.test(text));
  return match ? match.sheetName : null;
}

function groupRedemptions(records) {
  return records.reduce((result, record) => {
    if (!result[record.sheetName]) {
      result[record.sheetName] = {};
    }
    if (!result[record.sheetName][record.dateKey]) {
      result[record.sheetName][record.dateKey] = {};
    }
    const dateCounts = result[record.sheetName][record.dateKey];
    dateCounts[record.voucherType] = (dateCounts[record.voucherType] || 0) + 1;
    return result;
  }, {});
}

function buildDateToRowIndex(sheet) {
  const lastRow = sheet.getLastRow();
  const values = sheet
    .getRange(FIRST_DATA_ROW, DATE_COLUMN, Math.max(lastRow - FIRST_DATA_ROW + 1, 1), 1)
    .getValues();

  return values.reduce((result, [value], index) => {
    if (value instanceof Date) {
      result[formatSheetDate(value)] = FIRST_DATA_ROW + index;
    } else if (value) {
      result[formatSheetDate(parseSheetDate(value))] = FIRST_DATA_ROW + index;
    }
    return result;
  }, {});
}

function hasVoucherTypeColumns(sheet) {
  const headers = sheet.getRange(2, 6, 1, 4).getDisplayValues()[0];
  return headers.join('|').includes('$4') && headers.join('|').includes('1h free');
}

function parseSheetDate(value) {
  const parts = String(value).split(/[/-]/).map(Number);
  if (parts.length !== 3) {
    throw new Error(`Unsupported sheet date: ${value}`);
  }

  const [first, second, year] = parts;
  const day = first > 12 ? first : second;
  const month = first > 12 ? second : first;
  return new Date(year, month - 1, day);
}

function formatSheetDate(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'dd/MM/yyyy');
}

function formatIsoDate(date) {
  return Utilities.formatDate(date, TIME_ZONE, 'yyyy-MM-dd');
}

function formatPass2UFilterDateTime(date, hour, minute, second) {
  const local = new Date(date);
  local.setHours(hour, minute, second, 0);
  const utc = local.getTime() + local.getTimezoneOffset() * 60 * 1000;
  const serverTime = new Date(utc + 8 * 60 * 60 * 1000);
  return Utilities.formatDate(serverTime, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'+08:00'");
}

function toQueryString(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
