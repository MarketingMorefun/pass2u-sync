/**
 * "G Review 2 Free Games" abuse check.
 *
 * A tech mailbox (REVIEW_GAMES_SENDER) emails a CSV listing every free-games
 * button press with the card number used. This reads the latest such email from
 * the marketing@ Gmail inbox, flags cards pressed repeatedly (same card claiming
 * free games more than once — the "连着相同的卡" abuse pattern), and emails a
 * summary to REVIEW_ALERT_TO.
 *
 * Runs entirely on a dedicated Gmail credential (GMAIL_OAUTH_*, authorized as the
 * inbox owner with gmail.readonly + gmail.send). It does NOT touch Sheets or GBP.
 *
 * Usage:
 *   node src/review-games.js            # read latest report, email summary
 *   node src/review-games.js --dry-run  # analyze + print summary, don't send
 *   node src/review-games.js --file path/to.csv   # analyze a local CSV instead
 */

import { readFile } from 'node:fs/promises';
import { REVIEW_GAMES_SENDER, REVIEW_ALERT_TO, CARD_REPEAT_THRESHOLD } from './config.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// ---------- CSV parsing + analysis (pure, unit-testable) ----------

/** Parse one CSV line, honoring quoted fields that contain commas. */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Analyze the report CSV. Returns per-location totals, same-timestamp duplicate
 * presses (hard evidence), and cards pressed CARD_REPEAT_THRESHOLD+ times.
 */
export function analyzeReport(csvText) {
  const lines = csvText.split(/\r?\n/);
  const executionTime = (lines[1] || '').trim();

  const headerIdx = lines.findIndex((l) => l.startsWith('LocalTransactionDate,'));
  if (headerIdx === -1) throw new Error('CSV detail section (LocalTransactionDate,...) not found.');

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) break;
    const [date, accountsRaw, , location] = parseCsvLine(lines[i]);
    const cards = accountsRaw.split(',').map((s) => s.trim()).filter(Boolean);
    rows.push({ date, cards, location });
  }

  const perLocation = {};
  const card = {};
  let totalPresses = 0;
  for (const r of rows) {
    perLocation[r.location] = (perLocation[r.location] || 0) + r.cards.length;
    totalPresses += r.cards.length;
    for (const c of r.cards) {
      (card[c] ??= { count: 0, events: [] }).count += 1;
      card[c].events.push({ date: r.date, location: r.location });
    }
  }

  // Same-timestamp duplicates: same card at the exact same LocalTransactionDate.
  const sameTimestamp = [];
  for (const [c, info] of Object.entries(card)) {
    const byTs = {};
    for (const e of info.events) (byTs[e.date] ??= []).push(e.location);
    for (const [ts, locs] of Object.entries(byTs)) {
      if (locs.length >= 2) sameTimestamp.push({ card: c, count: locs.length, timestamp: ts, location: locs[0] });
    }
  }
  sameTimestamp.sort((a, b) => b.count - a.count);

  const repeatedCards = Object.entries(card)
    .filter(([, i]) => i.count >= CARD_REPEAT_THRESHOLD)
    .map(([c, i]) => ({ card: c, count: i.count, locations: [...new Set(i.events.map((e) => e.location))] }))
    .sort((a, b) => b.count - a.count);

  return { executionTime, totalPresses, rowCount: rows.length, perLocation, sameTimestamp, repeatedCards };
}

/** Build the summary email (subject + plain-text body) from an analysis. */
export function buildSummary(a) {
  const subject =
    `[G Review 2 Free Games] ${a.sameTimestamp.length} same-second dup(s), ` +
    `${a.repeatedCards.length} card(s) used ${CARD_REPEAT_THRESHOLD}+×`;

  const L = [];
  L.push(`Report execution time: ${a.executionTime || '(unknown)'}`);
  L.push(`Total presses: ${a.totalPresses} across ${a.rowCount} rows`);
  L.push('');
  L.push('Presses per location:');
  for (const [loc, n] of Object.entries(a.perLocation).sort((x, y) => y[1] - x[1])) {
    L.push(`  ${loc}: ${n}`);
  }
  L.push('');
  L.push(`⚠️ Same-second duplicate presses (same card, identical timestamp) — ${a.sameTimestamp.length}:`);
  if (a.sameTimestamp.length === 0) L.push('  (none)');
  for (const s of a.sameTimestamp) L.push(`  card ${s.card}  ${s.count}× @ ${s.timestamp}  (${s.location})`);
  L.push('');
  L.push(`Cards used ${CARD_REPEAT_THRESHOLD}+ times in this report — ${a.repeatedCards.length}:`);
  if (a.repeatedCards.length === 0) L.push('  (none)');
  for (const r of a.repeatedCards) L.push(`  card ${r.card}  ${r.count}×  [${r.locations.join(', ')}]`);

  return { subject, body: L.join('\n') };
}

// ---------- Gmail I/O ----------

async function getGmailToken() {
  const { GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET, GMAIL_OAUTH_REFRESH_TOKEN } = process.env;
  if (!GMAIL_OAUTH_CLIENT_ID || !GMAIL_OAUTH_CLIENT_SECRET || !GMAIL_OAUTH_REFRESH_TOKEN) {
    throw new Error('Set GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET / GMAIL_OAUTH_REFRESH_TOKEN (run: npm run auth:gmail).');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_OAUTH_CLIENT_ID,
      client_secret: GMAIL_OAUTH_CLIENT_SECRET,
      refresh_token: GMAIL_OAUTH_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Gmail token exchange failed (${res.status}): ${data.error_description || data.error || ''}`);
  }
  return data.access_token;
}

async function gmailGet(pathAndQuery, token) {
  const res = await fetch(`${GMAIL_BASE}${pathAndQuery}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Gmail GET ${pathAndQuery} failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

/** Fetch the newest report email's CSV attachment as text. */
async function fetchLatestReportCsv(token) {
  const q = encodeURIComponent(`from:${REVIEW_GAMES_SENDER} has:attachment filename:csv newer_than:60d`);
  const list = await gmailGet(`/messages?q=${q}&maxResults=1`, token);
  if (!list.messages?.length) throw new Error(`No email from ${REVIEW_GAMES_SENDER} with a CSV in the last 60 days.`);

  const msg = await gmailGet(`/messages/${list.messages[0].id}?format=full`, token);
  const part = findCsvPart(msg.payload);
  if (!part) throw new Error('Latest report email has no CSV attachment part.');

  const att = await gmailGet(`/messages/${msg.id}/attachments/${part.body.attachmentId}`, token);
  return Buffer.from(att.data, 'base64url').toString('utf8');
}

function findCsvPart(payload) {
  const stack = [payload];
  while (stack.length) {
    const p = stack.pop();
    if (p.filename && p.filename.toLowerCase().endsWith('.csv') && p.body?.attachmentId) return p;
    if (p.parts) stack.push(...p.parts);
  }
  return null;
}

async function sendEmail(token, to, subject, body) {
  const mime =
    `To: ${to}\r\n` +
    `Subject: ${subject}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    '\r\n' +
    body;
  const raw = Buffer.from(mime, 'utf8').toString('base64url');
  const res = await fetch(`${GMAIL_BASE}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fileIdx = argv.indexOf('--file');
  const localFile = fileIdx !== -1 ? argv[fileIdx + 1] : null;

  let csvText;
  let token = null;
  if (localFile) {
    csvText = await readFile(localFile, 'utf8');
    console.log(`[review-games] analyzing local file ${localFile}`);
  } else {
    token = await getGmailToken();
    csvText = await fetchLatestReportCsv(token);
    console.log('[review-games] fetched latest report email.');
  }

  const analysis = analyzeReport(csvText);
  const { subject, body } = buildSummary(analysis);

  console.log(`\n${subject}\n\n${body}\n`);

  if (dryRun || localFile) {
    console.log('[review-games] dry-run/local: summary not emailed.');
    return;
  }
  await sendEmail(token, REVIEW_ALERT_TO, subject, body);
  console.log(`[review-games] summary emailed to ${REVIEW_ALERT_TO}.`);
}

main().catch((err) => {
  console.error(`[review-games] FAILED: ${err.message}`);
  process.exit(1);
});
