/**
 * Pass2U dashboard client.
 *
 * The public api.pass2u.net/v2 API only does checkout/redeem, it has no history.
 * Redemption history lives behind the logged-in dashboard endpoint
 *   POST /api/v1/checkout/{puid}/campaigns/{campaignId}/records?type=OneRedeem
 * which authenticates purely via the session cookie set by /users/login.
 * Note: the records API keys on the alphanumeric `puid`, not the numeric model id.
 *
 * Because login is a plain JSON POST, we simply log in fresh on every run and
 * keep the JSESSIONID cookie for the rest of the process — no persisted session,
 * nothing to expire.
 */

import { FixedOffsetZone } from 'luxon';
import {
  PASS2U_WEB_BASE_URL,
  PASS2U_PAGE_SIZE,
  PASS2U_SERVER_OFFSET,
  PASS2U_MODELS,
  MODEL_DIRECTORY_STATUSES,
} from './config.js';

// Pass2U expects timestamps in a fixed +08:00 offset. Build the zone arithmetically
// via FixedOffsetZone instead of setZone('+08:00'): offset-style IANA names are only
// accepted by newer V8/ICU (Node 22+), so on the Node 20 GitHub runner
// setZone('+08:00') yields an invalid DateTime that formats to the literal string
// "Invalid DateTime" — which Pass2U then rejects with a 400.
const SERVER_ZONE = FixedOffsetZone.parseSpecifier(`UTC${PASS2U_SERVER_OFFSET}`);

export class Pass2UClient {
  constructor({ email, password }) {
    if (!email || !password) {
      throw new Error('Missing PASS2U_EMAIL / PASS2U_PASSWORD.');
    }
    this.email = email;
    this.password = password;
    this.cookies = new Map();
  }

  /** Merge Set-Cookie headers from a response into the cookie jar. */
  storeCookies(response) {
    // Node fetch exposes combined cookies via getSetCookie() (preserves multiples).
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '_remove_') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async request(path, { method = 'GET', body } = {}) {
    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${PASS2U_WEB_BASE_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    this.storeCookies(response);
    return response;
  }

  async login() {
    const response = await this.request('/users/login', {
      method: 'POST',
      body: { email: this.email, password: this.password },
    });
    const text = await response.text();

    // Hard failure: the endpoint sometimes returns a 401 with a JSON error body.
    if (response.status >= 400) {
      let detail = text;
      try {
        detail = JSON.parse(text).error?.message ?? text;
      } catch {
        /* keep raw text */
      }
      throw new Error(`Pass2U login failed (${response.status}): ${detail}`);
    }
    if (!this.cookies.has('JSESSIONID')) {
      throw new Error('Pass2U login returned no JSESSIONID cookie.');
    }
    // The browser sets this client-side; mirror it.
    this.cookies.set('p2uMail', this.email);

    // The login endpoint can answer 200 with an empty body for BOTH success and
    // failure (and rate-limits repeated attempts), so status alone is not a
    // reliable signal. Confirm the cookie is actually authenticated by hitting a
    // protected endpoint.
    await this.verifySession();
  }

  /** Throws if the current cookie jar is not an authenticated dashboard session. */
  async verifySession() {
    // The /users/{email}/info endpoint only returns real data for a logged-in session.
    let info;
    try {
      info = await this.getJson(`/api/v2/users/${encodeURIComponent(this.email)}/info`);
    } catch (err) {
      throw new Error(
        `Pass2U login did not establish an authenticated session ` +
          `(check PASS2U_EMAIL/PASS2U_PASSWORD; repeated failed logins are temporarily rate-limited). ` +
          `Underlying: ${err.message}`,
      );
    }
    if (!info || info.email?.toLowerCase() !== this.email.toLowerCase()) {
      throw new Error('Pass2U session check returned unexpected user info.');
    }
  }

  async getJson(path, options) {
    const response = await this.request(path, options);
    const text = await response.text();
    if (response.status === 401 || response.status === 901) {
      throw new Error(`Pass2U session rejected (${response.status}) for ${path}.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Pass2U request ${path} failed (${response.status}): ${text}`);
    }
    return JSON.parse(text);
  }

  async fetchCampaigns(puid) {
    const data = await this.getJson(`/api/v1/checkout/${puid}/campaigns/`);
    return Array.isArray(data) ? data : [];
  }

  /**
   * Build a stable-id -> current-puid map by scanning the account's pass directory.
   * Earlier statuses in MODEL_DIRECTORY_STATUSES win (ISSUE before SUSPEND/DRAFT),
   * so a re-published pass resolves to its currently-issuing puid.
   */
  async fetchModelDirectory() {
    const idToPuid = new Map();
    for (const status of MODEL_DIRECTORY_STATUSES) {
      const data = await this.getJson(
        `/api/v1/passes/models/${status}/query?pageSize=300&pageNo=1`,
        { method: 'POST', body: {} },
      );
      for (const model of data.models ?? []) {
        if (model.id != null && model.puid && !idToPuid.has(model.id)) {
          idToPuid.set(model.id, model.puid);
        }
      }
    }
    return idToPuid;
  }

  /** Attach the current puid to each configured model; warns on any that can't be resolved. */
  async resolveModels() {
    const idToPuid = await this.fetchModelDirectory();
    const resolved = [];
    const unresolved = [];
    for (const model of PASS2U_MODELS) {
      const puid = idToPuid.get(model.id);
      if (puid) resolved.push({ ...model, puid });
      else unresolved.push(model);
    }
    return { resolved, unresolved };
  }

  /**
   * Fetch all redeemed (OneRedeem) records for a campaign within [from, to].
   * `from`/`to` are luxon DateTime instants; they are sent in Pass2U's +08:00 wire format.
   */
  async fetchCampaignRecords(model, campaign, from, to) {
    const records = [];
    let startIndex = 0;

    for (;;) {
      const payload = {
        startIndex,
        pageSize: PASS2U_PAGE_SIZE,
        fromRedeemAt: toServerStamp(from),
        toRedeemAt: toServerStamp(to),
        allRecords: false, // only redeemed records
      };
      const data = await this.getJson(
        `/api/v1/checkout/${model.puid}/campaigns/${campaign.id}/records?type=OneRedeem`,
        { method: 'POST', body: payload },
      );
      const page = data.records ?? [];
      for (const record of page) {
        records.push({
          puid: model.puid,
          voucherType: model.voucherType,
          modelName: data.modelName ?? model.name,
          campaignId: campaign.id,
          redeemAt: record.redeemAt,
          scannerName: record.scannerName ?? '',
          scannerStore: record.scannerStore ?? '',
          barcode: record.barcode ?? '',
        });
      }
      if (page.length < PASS2U_PAGE_SIZE) break;
      startIndex += PASS2U_PAGE_SIZE;
    }
    return records;
  }

  /**
   * Pull every OneRedeem record across all configured models in the date window.
   * Resolves current puids first; returns the records plus any models that could
   * not be resolved (so the caller can warn).
   */
  async fetchAllRedemptions(from, to) {
    const { resolved, unresolved } = await this.resolveModels();
    const all = [];
    for (const model of resolved) {
      const campaigns = (await this.fetchCampaigns(model.puid)).filter(
        (c) => c.type === 'OneRedeem',
      );
      for (const campaign of campaigns) {
        const records = await this.fetchCampaignRecords(model, campaign, from, to);
        all.push(...records);
      }
    }
    return { records: all, unresolved };
  }
}

function toServerStamp(dt) {
  return dt.setZone(SERVER_ZONE).toFormat("yyyy-MM-dd'T'HH:mm:ssZZ");
}
