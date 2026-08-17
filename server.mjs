import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import QRCode from 'qrcode';
import bech32 from 'bech32';
import { NWCClient } from '@getalby/sdk/nwc';
import { decodeWholeSatInvoice } from './lib/bolt11.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.md');
const config = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
const nwcUri = process.env.RIZFUL_NWC_URI || config.match(/^RIZFUL_NWC_URI=(.+)$/m)?.[1]?.trim();
if (!nwcUri?.startsWith('nostr+walletconnect://')) throw new Error('RIZFUL_NWC_URI missing');

process.umask(0o077);
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(dataDir, 0o700);
const dbPath = path.join(dataDir, 'satsball.db');
const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, balance INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invoices (
    payment_hash TEXT PRIMARY KEY, session_id TEXT NOT NULL, invoice TEXT NOT NULL, amount INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, credited_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS ledger_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, delta INTEGER NOT NULL,
    event_type TEXT, reference_type TEXT, reference_id TEXT, metadata TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id TEXT PRIMARY KEY, payment_hash TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, invoice TEXT NOT NULL,
    amount INTEGER NOT NULL, fee_sats INTEGER NOT NULL DEFAULT 0, total_debit INTEGER,
    state TEXT NOT NULL, preimage TEXT, fees_paid_msat INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempt_at INTEGER, next_attempt_at INTEGER, error_code TEXT,
    created_at INTEGER NOT NULL, completed_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS game_rounds (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, channels TEXT NOT NULL, results TEXT NOT NULL,
    payout INTEGER NOT NULL, hit_columns TEXT NOT NULL, shot_count INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, completed_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS lnurl_withdrawals (
    k1 TEXT PRIMARY KEY, session_id TEXT NOT NULL, amount INTEGER NOT NULL,
    fee_sats INTEGER NOT NULL DEFAULT 0, total_debit INTEGER,
    state TEXT NOT NULL DEFAULT 'pending', payment_hash TEXT, created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, completed_at INTEGER,
    FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS visitor_days (
    day TEXT NOT NULL, session_id TEXT NOT NULL, pageviews INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(day, session_id), FOREIGN KEY(session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT NOT NULL, subject_hash TEXT NOT NULL, window_start INTEGER NOT NULL,
    count INTEGER NOT NULL, PRIMARY KEY(bucket, subject_hash)
  );
  CREATE TABLE IF NOT EXISTS security_state (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  INSERT OR IGNORE INTO visitor_days (day, session_id, pageviews, first_seen_at, last_seen_at)
    SELECT date(created_at, 'unixepoch'), id, 1, created_at, updated_at FROM sessions;
`);

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function addColumn(table, name, definition) {
  if (!tableColumns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

addColumn('sessions', 'token_hash', 'TEXT');
addColumn('sessions', 'previous_token_hash', 'TEXT');
addColumn('sessions', 'previous_token_expires_at', 'INTEGER');
addColumn('ledger_events', 'event_type', 'TEXT');
addColumn('ledger_events', 'reference_type', 'TEXT');
addColumn('ledger_events', 'reference_id', 'TEXT');
addColumn('ledger_events', 'metadata', 'TEXT');
addColumn('withdrawals', 'fee_sats', 'INTEGER NOT NULL DEFAULT 0');
addColumn('withdrawals', 'total_debit', 'INTEGER');
addColumn('withdrawals', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('withdrawals', 'last_attempt_at', 'INTEGER');
addColumn('withdrawals', 'next_attempt_at', 'INTEGER');
addColumn('withdrawals', 'error_code', 'TEXT');
addColumn('lnurl_withdrawals', 'fee_sats', 'INTEGER NOT NULL DEFAULT 0');
addColumn('lnurl_withdrawals', 'total_debit', 'INTEGER');
addColumn('lnurl_withdrawals', 'token_rotated_at', 'INTEGER');
db.exec(`
  UPDATE withdrawals SET total_debit = amount + COALESCE(fee_sats, 0) WHERE total_debit IS NULL;
  UPDATE lnurl_withdrawals SET total_debit = amount + COALESCE(fee_sats, 0) WHERE total_debit IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_unique ON sessions(token_hash) WHERE token_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS sessions_previous_token_hash_idx
    ON sessions(previous_token_hash, previous_token_expires_at) WHERE previous_token_hash IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS ledger_reference_unique
    ON ledger_events(event_type, reference_id) WHERE event_type IS NOT NULL AND reference_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS withdrawals_recovery_idx ON withdrawals(state, next_attempt_at, created_at);
  CREATE INDEX IF NOT EXISTS withdrawals_session_created_idx ON withdrawals(session_id, created_at);
  CREATE TRIGGER IF NOT EXISTS sessions_balance_insert_guard
    BEFORE INSERT ON sessions WHEN NEW.balance < 0 BEGIN SELECT RAISE(ABORT, 'negative balance'); END;
  CREATE TRIGGER IF NOT EXISTS sessions_balance_update_guard
    BEFORE UPDATE OF balance ON sessions WHEN NEW.balance < 0 BEGIN SELECT RAISE(ABORT, 'negative balance'); END;
  CREATE TRIGGER IF NOT EXISTS invoice_amount_guard
    BEFORE INSERT ON invoices WHEN NEW.amount <= 0 BEGIN SELECT RAISE(ABORT, 'invalid invoice amount'); END;
  CREATE TRIGGER IF NOT EXISTS withdrawal_amount_guard
    BEFORE INSERT ON withdrawals
    WHEN NEW.amount <= 0 OR NEW.fee_sats < 0 OR NEW.total_debit < NEW.amount
    BEGIN SELECT RAISE(ABORT, 'invalid withdrawal amount'); END;
  CREATE TRIGGER IF NOT EXISTS round_insert_guard
    BEFORE INSERT ON game_rounds
    WHEN NEW.payout < 0 OR NEW.shot_count < 0 OR NEW.shot_count > 3
    BEGIN SELECT RAISE(ABORT, 'invalid round'); END;
  CREATE TRIGGER IF NOT EXISTS round_update_guard
    BEFORE UPDATE ON game_rounds
    WHEN NEW.payout < 0 OR NEW.shot_count < 0 OR NEW.shot_count > 3
      OR (NEW.state = 'completed' AND NEW.shot_count <> 3)
    BEGIN SELECT RAISE(ABORT, 'invalid round state'); END;
`);
for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try { fs.chmodSync(filename, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

const nwc = new NWCClient({ nostrWalletConnectUrl: nwcUri });
let walletClient = nwc;
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '8kb' }));

const publicOrigin = process.env.PUBLIC_ORIGIN;
const allowedOrigins = new Set([
  publicOrigin,
  ...(process.env.ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim()),
].filter(Boolean));
const monitoringUser = process.env.MONITORING_USER || config.match(/^MONITORING_USER=(.+)$/m)?.[1]?.trim() || 'operator';
const monitoringPassword = process.env.MONITORING_PASSWORD || config.match(/^MONITORING_PASSWORD=(.+)$/m)?.[1]?.trim();
const minWithdrawalSats = Number(process.env.MIN_WITHDRAWAL_SATS || 100);
const withdrawalBaseFeeSats = Number(process.env.WITHDRAWAL_BASE_FEE_SATS || 5);
const withdrawalFeeBps = Number(process.env.WITHDRAWAL_FEE_BPS || 200);
const withdrawalCooldownSeconds = Number(process.env.WITHDRAWAL_COOLDOWN_SECONDS || 600);
const maxWithdrawalSats = Number(process.env.MAX_WITHDRAWAL_SATS || 500);
const dailyWithdrawalLimitSats = Number(process.env.DAILY_WITHDRAWAL_LIMIT_SATS || 1000);
const maxDepositSats = Number(process.env.MAX_DEPOSIT_SATS || 500);
const dailyDepositLimitSats = Number(process.env.DAILY_DEPOSIT_LIMIT_SATS || 5000);
const berlinDayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const berlinDay = (timestamp = Date.now()) => berlinDayFormatter.format(new Date(timestamp));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function parseCookies(header = '') {
  const result = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    try { result[decodeURIComponent(part.slice(0, separator).trim())] = decodeURIComponent(part.slice(separator + 1).trim()); }
    catch { /* Malformed cookies are ignored instead of failing the request. */ }
  }
  return result;
}

function rateLimitSubject(req) {
  const cookie = parseCookies(req.headers.cookie);
  const token = cookie['__Host-satsball_guest'] || cookie.satsball_guest || '';
  return sha256(`${req.ip}|${token}`);
}

function consumeRateLimit(bucket, subjectHash, windowSeconds, limit) {
  const now = nowSeconds();
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT window_start, count FROM rate_limits WHERE bucket = ? AND subject_hash = ?').get(bucket, subjectHash);
    let count;
    if (!row || row.window_start + windowSeconds <= now) {
      db.prepare(`INSERT INTO rate_limits (bucket, subject_hash, window_start, count) VALUES (?, ?, ?, 1)
        ON CONFLICT(bucket, subject_hash) DO UPDATE SET window_start = excluded.window_start, count = 1`)
        .run(bucket, subjectHash, now);
      count = 1;
    } else {
      count = row.count + 1;
      db.prepare('UPDATE rate_limits SET count = ? WHERE bucket = ? AND subject_hash = ?').run(count, bucket, subjectHash);
    }
    db.exec('COMMIT');
    return { allowed: count <= limit, retryAfter: Math.max(1, (row?.window_start || now) + windowSeconds - now) };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function rateLimit(bucket, windowSeconds, limit) {
  return (req, res, next) => {
    const result = consumeRateLimit(bucket, rateLimitSubject(req), windowSeconds, limit);
    if (!result.allowed) {
      res.set('Retry-After', String(result.retryAfter));
      return res.status(429).json({ error: 'Too many requests; try again later' });
    }
    next();
  };
}

app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || allowedOrigins.size === 0) return next();
  if (!allowedOrigins.has(req.headers.origin)) return res.status(403).json({ error: 'Invalid request origin' });
  next();
});

function monitoringAuth(req, res, next) {
  if (!monitoringPassword) return res.sendStatus(404);
  const encoded = String(req.headers.authorization || '').match(/^Basic\s+(.+)$/i)?.[1];
  let supplied = '';
  try { supplied = Buffer.from(encoded || '', 'base64').toString('utf8'); } catch { /* invalid credentials */ }
  const expected = `${monitoringUser}:${monitoringPassword}`;
  const suppliedBuffer = Buffer.from(supplied); const expectedBuffer = Buffer.from(expected);
  const valid = suppliedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
  if (!valid) {
    const limited = consumeRateLimit('monitoring-auth', sha256(req.ip), 900, 5);
    if (!limited.allowed) {
      res.set('Retry-After', String(limited.retryAfter));
      return res.status(429).send('Too many authentication attempts');
    }
    res.set('WWW-Authenticate', 'Basic realm="Satsball Monitoring", charset="UTF-8"');
    return res.status(401).send('Authentication required');
  }
  next();
}

function setGuestCookie(res, token) {
  res.append('Set-Cookie', `__Host-satsball_guest=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure`);
}

function rotateGuestToken(sessionId, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = nowSeconds();
  // Parallel laufende Statusabfragen dürfen nach einer erfolgreichen Zahlung
  // noch kurz mit dem alten Cookie fertig werden. Der neue Bearer bleibt der
  // einzige langfristig gültige Token.
  db.prepare(`UPDATE sessions
    SET previous_token_hash = token_hash, previous_token_expires_at = ?, token_hash = ?, updated_at = ?
    WHERE id = ?`).run(now + 60, sha256(token), now, sessionId);
  setGuestCookie(res, token);
}

function guestSession(req, res) {
  const cookie = parseCookies(req.headers.cookie);
  const suppliedToken = cookie['__Host-satsball_guest'] || cookie.satsball_guest;
  if (suppliedToken && /^[a-f0-9]{64}$/.test(suppliedToken)) {
    const tokenHash = sha256(suppliedToken);
    const current = db.prepare('SELECT id FROM sessions WHERE token_hash = ?').get(tokenHash);
    if (current) return current.id;
    const previous = db.prepare(`SELECT id FROM sessions
      WHERE previous_token_hash = ? AND previous_token_expires_at > ?`).get(tokenHash, nowSeconds());
    if (previous) return previous.id;
    const legacy = db.prepare('SELECT id FROM sessions WHERE id = ? AND token_hash IS NULL').get(suppliedToken);
    if (legacy) {
      const rotatedToken = crypto.randomBytes(32).toString('hex');
      db.prepare('UPDATE sessions SET token_hash = ?, updated_at = ? WHERE id = ? AND token_hash IS NULL')
        .run(sha256(rotatedToken), nowSeconds(), legacy.id);
      setGuestCookie(res, rotatedToken);
      res.append('Set-Cookie', 'satsball_guest=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
      return legacy.id;
    }
  }
  const id = crypto.randomUUID(); const token = crypto.randomBytes(32).toString('hex'); const now = nowSeconds();
  db.prepare('INSERT INTO sessions (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(id, sha256(token), now, now);
  setGuestCookie(res, token);
  if (cookie.satsball_guest) res.append('Set-Cookie', 'satsball_guest=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
  return id;
}

function recordLedger(sessionId, delta, eventType, referenceType, referenceId, metadata = null) {
  const result = db.prepare(`INSERT OR IGNORE INTO ledger_events
    (id, session_id, delta, event_type, reference_type, reference_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(crypto.randomUUID(), sessionId, delta, eventType, referenceType, referenceId, metadata ? JSON.stringify(metadata) : null, nowSeconds());
  return result.changes === 1;
}

function applyBalanceDelta(sessionId, delta, eventType, referenceType, referenceId, metadata = null) {
  if (!recordLedger(sessionId, delta, eventType, referenceType, referenceId, metadata)) return false;
  const result = db.prepare('UPDATE sessions SET balance = balance + ?, updated_at = ? WHERE id = ? AND balance + ? >= 0')
    .run(delta, nowSeconds(), sessionId, delta);
  if (result.changes !== 1) throw new Error('Balance invariant failed');
  return true;
}

function initializeLedgerBaselines() {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const session of db.prepare(`SELECT s.id, s.balance, COALESCE(SUM(l.delta), 0) ledger_balance
      FROM sessions s LEFT JOIN ledger_events l ON l.session_id = s.id GROUP BY s.id`).all()) {
      const difference = Number(session.balance) - Number(session.ledger_balance);
      if (difference !== 0) recordLedger(session.id, difference, 'opening_balance', 'migration', `security-2026-08-17:${session.id}`, { reason: 'ledger activation' });
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
initializeLedgerBaselines();

app.get('/api/session', rateLimit('session', 60, 120), (req, res) => {
  const id = guestSession(req, res);
  const now = Math.floor(Date.now() / 1000); const day = berlinDay(now * 1000);
  db.prepare(`INSERT INTO visitor_days (day, session_id, pageviews, first_seen_at, last_seen_at)
    VALUES (?, ?, 1, ?, ?) ON CONFLICT(day, session_id) DO UPDATE SET
    pageviews = pageviews + 1, last_seen_at = excluded.last_seen_at`).run(day, id, now, now);
  const session = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(id);
  const depositRemaining = Math.max(0, dailyDepositLimitSats - incomingLast24Hours(now));
  res.set('Cache-Control', 'no-store').json({ balance: session.balance, depositRemaining });
});

const channelNumbers = [4, 1, 3, 2, 4, 3, 1, 4, 2, 4, 3, 1, 2, 4];
const matrix = [[1,3,4,1,2,2,1], [2,3,4,1,2,3,3], [3,3,4,1,2,4,4]];
const payouts = [10, 20, 40, 100, 80, 20, 10];

function generateChannel() {
  let channel = 0;
  const bytes = crypto.randomBytes(13);
  for (const byte of bytes) channel += byte & 1;
  return channel;
}

function evaluateResults(results) {
  const lit = matrix.map(() => matrix[0].map(() => false));
  for (const value of results) {
    for (let col = 0; col < matrix[0].length; col += 1) {
      const row = matrix.findIndex((matrixRow, rowIndex) => matrixRow[col] === value && !lit[rowIndex][col]);
      if (row >= 0) lit[row][col] = true;
    }
  }
  const hitColumns = matrix[0].map((_, col) => col).filter((col) => lit.every((row) => row[col]));
  return { hitColumns, payout: hitColumns.reduce((sum, col) => sum + payouts[col], 0) };
}

app.post('/api/game/start', rateLimit('game-start', 60, 30), (req, res) => {
  const sessionId = guestSession(req, res);
  db.exec('BEGIN IMMEDIATE');
  try {
    const session = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId);
    if (!session || session.balance < 10) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Not enough balance' }); }
    const id = crypto.randomUUID();
    const channels = [generateChannel(), generateChannel(), generateChannel()];
    const results = channels.map((channel) => channelNumbers[channel]);
    const { hitColumns, payout } = evaluateResults(results);
    const now = Math.floor(Date.now() / 1000);
    db.prepare('INSERT INTO game_rounds (id, session_id, channels, results, payout, hit_columns, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, sessionId, JSON.stringify(channels), JSON.stringify(results), payout, JSON.stringify(hitColumns), now);
    applyBalanceDelta(sessionId, -10, 'stake', 'game_round', id, { stake: 10 });
    db.exec('COMMIT');
    const balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId).balance;
    res.set('Cache-Control', 'no-store').json({ roundId: id, balance });
  } catch (error) {
    db.exec('ROLLBACK'); console.error('Game start failed:', error?.message || error);
    res.status(500).json({ error: 'Game could not be started' });
  }
});

app.post('/api/game/:roundId/shot', rateLimit('game-shot', 60, 120), (req, res) => {
  const sessionId = guestSession(req, res);
  const shotIndex = Number(req.body?.shotIndex);
  if (!Number.isInteger(shotIndex) || shotIndex < 0 || shotIndex > 2) return res.status(400).json({ error: 'Invalid ball number' });
  db.exec('BEGIN IMMEDIATE');
  try {
    const round = db.prepare('SELECT * FROM game_rounds WHERE id = ? AND session_id = ?').get(req.params.roundId, sessionId);
    if (!round) { db.exec('ROLLBACK'); return res.status(404).json({ error: 'Game not found' }); }
    if (shotIndex > round.shot_count) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Balls must be played in order' }); }
    const channels = JSON.parse(round.channels); const results = JSON.parse(round.results); const hitColumns = JSON.parse(round.hit_columns);
    let balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId).balance;
    if (shotIndex === round.shot_count) {
      if (round.state !== 'active') { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Game is already complete' }); }
      const nextCount = round.shot_count + 1; const now = Math.floor(Date.now() / 1000);
      if (nextCount === 3) {
        db.prepare("UPDATE game_rounds SET shot_count = 3, state = 'completed', completed_at = ? WHERE id = ?").run(now, round.id);
        if (round.payout > 0) applyBalanceDelta(sessionId, round.payout, 'win', 'game_round', round.id, { payout: round.payout });
        balance += round.payout;
      } else db.prepare('UPDATE game_rounds SET shot_count = ? WHERE id = ?').run(nextCount, round.id);
    }
    db.exec('COMMIT');
    res.set('Cache-Control', 'no-store').json({
      shotIndex, channel: channels[shotIndex], value: results[shotIndex], settled: shotIndex === 2,
      ...(shotIndex === 2 ? { win: round.payout, balance, results, hitColumns } : {})
    });
  } catch (error) {
    db.exec('ROLLBACK'); console.error('Ball release failed:', error?.message || error);
    res.status(500).json({ error: 'Ball could not be released' });
  }
});

const refundablePaymentErrors = new Set(['PAYMENT_FAILED', 'INSUFFICIENT_BALANCE', 'QUOTA_EXCEEDED', 'RESTRICTED', 'UNAUTHORIZED', 'NOT_IMPLEMENTED']);
const paymentsInProgress = new Set();
let activeNwcCalls = 0;
const nwcQueue = [];

async function withNwcLimit(operation) {
  if (activeNwcCalls >= 4) await new Promise((resolve) => nwcQueue.push(resolve));
  activeNwcCalls += 1;
  try { return await operation(); }
  finally {
    activeNwcCalls -= 1;
    nwcQueue.shift()?.();
  }
}

function securityState(key) {
  return db.prepare('SELECT value FROM security_state WHERE key = ?').get(key)?.value;
}

function setSecurityState(key, value) {
  db.prepare(`INSERT INTO security_state (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), nowSeconds());
}

function pausePayouts(reason) {
  setSecurityState('payouts_paused', '1');
  setSecurityState('payouts_pause_reason', String(reason).slice(0, 200));
  console.error('Payouts paused:', reason);
}

function withdrawalFee(amount) {
  return Math.max(withdrawalBaseFeeSats, Math.ceil((amount * withdrawalFeeBps) / 10000));
}

function outgoingLast24Hours(now = nowSeconds()) {
  return Number(db.prepare(`SELECT COALESCE(SUM(amount), 0) amount FROM withdrawals
    WHERE created_at >= ? AND state <> 'failed'`).get(now - 86400)?.amount || 0);
}

function incomingLast24Hours(now = nowSeconds()) {
  const resetAt = Number(securityState('deposit_limit_reset_at') || 0);
  const windowStart = Math.max(now - 86400, resetAt);
  return Number(db.prepare(`SELECT COALESCE(SUM(amount), 0) amount FROM invoices
    WHERE created_at >= ? AND (state IN ('settled', 'review')
      OR (state IN ('pending', 'creating') AND expires_at + 300 > ?))`).get(windowStart, now)?.amount || 0);
}

function assertPayoutAllowed(sessionId, amount) {
  if (!verifyFinancialInvariants()) throw Object.assign(new Error('Payouts are paused because the ledger requires review'), { status: 503 });
  if (securityState('payouts_paused') === '1') throw Object.assign(new Error('Payouts are temporarily paused for review'), { status: 503 });
  if (amount < minWithdrawalSats) throw Object.assign(new Error(`Minimum payout is ${minWithdrawalSats} sats`), { status: 409 });
  if (amount > maxWithdrawalSats) throw Object.assign(new Error(`Maximum payout is ${maxWithdrawalSats} sats per transaction`), { status: 409 });
  const now = nowSeconds();
  const last = db.prepare("SELECT MAX(created_at) created_at FROM withdrawals WHERE session_id = ? AND state <> 'failed'").get(sessionId)?.created_at;
  if (last && Number(last) + withdrawalCooldownSeconds > now) {
    throw Object.assign(new Error('Please wait before requesting another payout'), { status: 429, retryAfter: Number(last) + withdrawalCooldownSeconds - now });
  }
  const outgoingToday = outgoingLast24Hours(now);
  if (outgoingToday + amount > dailyWithdrawalLimitSats) {
    pausePayouts('daily outgoing limit reached');
    throw Object.assign(new Error('Daily payout limit reached'), { status: 503 });
  }
}

function verifyOutgoingTransaction(row, transaction) {
  if (transaction.payment_hash && transaction.payment_hash !== row.payment_hash) throw new Error('Provider payment hash mismatch');
  if (transaction.amount != null && Number(transaction.amount) !== Number(row.amount) * 1000) throw new Error('Provider payment amount mismatch');
}

function settleWithdrawal(id, paid) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!row || row.state === 'settled' || row.state === 'failed') { db.exec('COMMIT'); return; }
    verifyOutgoingTransaction(row, paid);
    const feesPaid = Number(paid.fees_paid || 0);
    db.prepare(`UPDATE withdrawals SET state = 'settled', preimage = ?, fees_paid_msat = ?,
      error_code = NULL, completed_at = ?, next_attempt_at = NULL WHERE id = ?`)
      .run(paid.preimage || '', feesPaid, nowSeconds(), id);
    db.prepare("UPDATE lnurl_withdrawals SET state = 'settled', completed_at = ? WHERE payment_hash = ?")
      .run(nowSeconds(), row.payment_hash);
    db.exec('COMMIT');
    if (feesPaid > Number(row.fee_sats || 0) * 1000) pausePayouts('routing fee exceeded reserved player fee');
  } catch (error) { db.exec('ROLLBACK'); pausePayouts(error.message); throw error; }
}

function refundWithdrawal(id, errorCode = 'PAYMENT_FAILED') {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!row || row.state === 'failed' || row.state === 'settled') { db.exec('COMMIT'); return; }
    const update = db.prepare(`UPDATE withdrawals SET state = 'failed', error_code = ?, completed_at = ?,
      next_attempt_at = NULL WHERE id = ? AND state NOT IN ('failed', 'settled')`)
      .run(errorCode, nowSeconds(), id);
    if (update.changes === 1) applyBalanceDelta(row.session_id, Number(row.total_debit), 'withdraw_refund', 'withdrawal', row.id, { errorCode });
    db.prepare("UPDATE lnurl_withdrawals SET state = 'failed', completed_at = ? WHERE payment_hash = ?")
      .run(nowSeconds(), row.payment_hash);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); pausePayouts(`refund failed: ${error.message}`); throw error; }
}

async function submitWithdrawal(id) {
  if (paymentsInProgress.has(id)) return;
  paymentsInProgress.add(id);
  try {
    const claimed = db.prepare(`UPDATE withdrawals SET state = 'submitting', attempt_count = attempt_count + 1,
      last_attempt_at = ?, next_attempt_at = ? WHERE id = ? AND state IN ('reserved', 'pending', 'review')`)
      .run(nowSeconds(), nowSeconds() + 30, id);
    if (claimed.changes !== 1) return;
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    try {
      const paid = await withNwcLimit(() => walletClient.payInvoice({ invoice: row.invoice }));
      settleWithdrawal(id, paid);
    } catch (error) {
      if (refundablePaymentErrors.has(error?.code)) refundWithdrawal(id, error.code);
      else db.prepare(`UPDATE withdrawals SET state = 'review', error_code = ?, next_attempt_at = ?
        WHERE id = ? AND state = 'submitting'`).run(String(error?.code || 'UNCERTAIN').slice(0, 80), nowSeconds() + 30, id);
      console.error('Withdrawal payment needs recovery:', error?.code || error?.message || error);
    }
  } finally { paymentsInProgress.delete(id); }
}

async function reconcileWithdrawal(id) {
  if (paymentsInProgress.has(id)) return;
  paymentsInProgress.add(id);
  try {
    const row = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!row || row.state === 'settled' || row.state === 'failed') return;
    try {
      let transaction = await withNwcLimit(() => walletClient.lookupInvoice({ payment_hash: row.payment_hash }));
      if (!transaction || transaction.payment_hash !== row.payment_hash) {
        const listed = await withNwcLimit(() => walletClient.listTransactions({ type: 'outgoing', from: Math.max(0, row.created_at - 60), limit: 100 }));
        transaction = listed.transactions?.find((entry) => entry.payment_hash === row.payment_hash);
      }
      if (transaction?.state === 'settled') return settleWithdrawal(id, transaction);
      if (transaction?.state === 'failed') return refundWithdrawal(id, 'PAYMENT_FAILED');
      if (transaction && ['pending', 'accepted'].includes(transaction.state)) {
        db.prepare("UPDATE withdrawals SET state = 'review', next_attempt_at = ? WHERE id = ?").run(nowSeconds() + 30, id);
        return;
      }
    } catch (error) {
      console.error('Withdrawal reconciliation lookup failed:', error?.code || error?.message || error);
    }
    if (Number(row.attempt_count || 0) < 5 && Number(row.last_attempt_at || row.created_at) <= nowSeconds() - 60) {
      db.prepare("UPDATE withdrawals SET state = 'reserved', next_attempt_at = ? WHERE id = ? AND state NOT IN ('settled', 'failed')")
        .run(nowSeconds(), id);
    } else {
      db.prepare("UPDATE withdrawals SET state = 'review', next_attempt_at = ? WHERE id = ? AND state NOT IN ('settled', 'failed')")
        .run(nowSeconds() + 60, id);
    }
  } finally { paymentsInProgress.delete(id); }
}

async function recoverWithdrawals() {
  const rows = db.prepare(`SELECT id, state FROM withdrawals
    WHERE state IN ('reserved', 'pending', 'submitting', 'review')
      AND COALESCE(next_attempt_at, 0) <= ? ORDER BY created_at LIMIT 20`).all(nowSeconds());
  for (const row of rows) {
    if (row.state === 'reserved' || row.state === 'pending') await submitWithdrawal(row.id);
    else await reconcileWithdrawal(row.id);
  }
}

async function verifyWalletSolvency() {
  try {
    const result = await withNwcLimit(() => walletClient.getBalance());
    const walletBalanceSats = Math.floor(Number(result.balance || 0) / 1000);
    const liabilities = Number(db.prepare(`SELECT
      (SELECT COALESCE(SUM(balance), 0) FROM sessions)
      + (SELECT COALESCE(SUM(amount), 0) FROM withdrawals WHERE state IN ('reserved','pending','submitting','review')) value`).get()?.value || 0);
    setSecurityState('wallet_balance_sats', walletBalanceSats);
    setSecurityState('wallet_liabilities_sats', liabilities);
    setSecurityState('wallet_checked_at', nowSeconds());
    if (walletBalanceSats < liabilities) pausePayouts(`wallet balance ${walletBalanceSats} below liabilities ${liabilities}`);
    return { walletBalanceSats, liabilities };
  } catch (error) {
    setSecurityState('wallet_check_error', String(error?.code || error?.message || error).slice(0, 120));
    console.error('Wallet solvency check failed:', error?.code || error?.message || error);
    return null;
  }
}

app.post('/api/lnurl/withdraw', rateLimit('withdraw-create', 600, 3), async (req, res) => {
  try {
    const sessionId = guestSession(req, res);
    const balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId)?.balance || 0;
    const dailyRemaining = Math.max(0, dailyWithdrawalLimitSats - outgoingLast24Hours());
    let amount = Math.min(maxWithdrawalSats, dailyRemaining, balance);
    let feeSats = withdrawalFee(amount);
    if (amount + feeSats > balance) amount = Math.max(0, balance - feeSats);
    feeSats = withdrawalFee(amount);
    assertPayoutAllowed(sessionId, amount);
    if (amount <= 0) return res.status(409).json({ error: 'Balance is below the payout fee' });
    const now = Math.floor(Date.now() / 1000); const k1 = crypto.randomBytes(32).toString('hex');
    db.prepare("UPDATE lnurl_withdrawals SET state = 'expired' WHERE session_id = ? AND state = 'pending'").run(sessionId);
    db.prepare(`INSERT INTO lnurl_withdrawals
      (k1, session_id, amount, fee_sats, total_debit, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(k1, sessionId, amount, feeSats, balance, now, now + 300);
    const origin = publicOrigin || `${req.protocol}://${req.get('host')}`;
    const endpoint = `${origin}/api/lnurl/withdraw/${k1}`;
    const lnurl = bech32.encode('lnurl', bech32.toWords(Buffer.from(endpoint, 'utf8')), 2000).toUpperCase();
    const qr = await QRCode.toDataURL(lnurl, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store').json({ k1, amount, fee: feeSats, expiresAt: now + 300, lnurl, qr });
  } catch (error) {
    console.error('LNURL withdraw creation failed:', error?.message || error);
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    res.status(error.status || 500).json({ error: error.message || 'Payout QR could not be created' });
  }
});

app.get('/api/lnurl/withdraw/:k1', (req, res) => {
  const row = db.prepare('SELECT amount, state, expires_at FROM lnurl_withdrawals WHERE k1 = ?').get(req.params.k1);
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.state !== 'pending' || row.expires_at <= now) return res.json({ status: 'ERROR', reason: 'Payout link is invalid or expired' });
  const origin = publicOrigin || `${req.protocol}://${req.get('host')}`;
  res.set('Cache-Control', 'no-store').json({
    // Der Callback liegt bewusst nicht unter /withdraw/:k1. Andernfalls
    // interpretiert Express "callback" als k1 und lehnt die Wallet-Anfrage ab.
    tag: 'withdrawRequest', callback: `${origin}/api/lnurl/withdraw-callback`, k1: req.params.k1,
    minWithdrawable: row.amount * 1000, maxWithdrawable: row.amount * 1000,
    defaultDescription: `Satsball payout ${row.amount} sats`
  });
});

app.get('/api/lnurl/withdraw/status/:k1', rateLimit('withdraw-status', 60, 60), (req, res) => {
  const sessionId = guestSession(req, res);
  const row = db.prepare('SELECT amount, state, expires_at, token_rotated_at FROM lnurl_withdrawals WHERE k1 = ? AND session_id = ?').get(req.params.k1, sessionId);
  if (!row) return res.status(404).json({ error: 'Payout not found' });
  const balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId).balance;
  const state = ['reserved', 'submitting'].includes(row.state) ? 'paying' : row.state;
  if (state === 'settled' && row.token_rotated_at == null) {
    const marked = db.prepare(`UPDATE lnurl_withdrawals SET token_rotated_at = ?
      WHERE k1 = ? AND token_rotated_at IS NULL`).run(nowSeconds(), req.params.k1);
    if (marked.changes === 1) rotateGuestToken(sessionId, res);
  }
  res.set('Cache-Control', 'no-store').json({ amount: row.amount, state, expiresAt: row.expires_at, balance });
});

app.get('/api/lnurl/withdraw-callback', rateLimit('lnurl-callback', 60, 10), (req, res) => {
  const k1 = String(req.query.k1 || '');
  let parsed;
  try { parsed = decodeWholeSatInvoice(req.query.pr); }
  catch (error) { return res.json({ status: 'ERROR', reason: error.message }); }
  let token; const withdrawalId = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    token = db.prepare('SELECT * FROM lnurl_withdrawals WHERE k1 = ?').get(k1);
    const now = Math.floor(Date.now() / 1000);
    if (!token || token.state !== 'pending' || token.expires_at <= now) { db.exec('ROLLBACK'); return res.json({ status: 'ERROR', reason: 'Payout link is invalid, expired or already used' }); }
    if (parsed.amount !== token.amount) { db.exec('ROLLBACK'); return res.json({ status: 'ERROR', reason: 'Invoice amount does not match payout' }); }
    const session = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(token.session_id);
    if (!session || session.balance < token.total_debit) { db.exec('ROLLBACK'); return res.json({ status: 'ERROR', reason: 'Balance is no longer available' }); }
    if (db.prepare('SELECT 1 FROM withdrawals WHERE payment_hash = ?').get(parsed.paymentHash)) { db.exec('ROLLBACK'); return res.json({ status: 'ERROR', reason: 'Invoice has already been submitted' }); }
    assertPayoutAllowed(token.session_id, token.amount);
    db.prepare(`INSERT INTO withdrawals
      (id, payment_hash, session_id, invoice, amount, fee_sats, total_debit, state, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
      .run(withdrawalId, parsed.paymentHash, token.session_id, parsed.invoice, token.amount, token.fee_sats, token.total_debit, now, now);
    db.prepare("UPDATE lnurl_withdrawals SET state = 'paying', payment_hash = ? WHERE k1 = ?").run(parsed.paymentHash, k1);
    applyBalanceDelta(token.session_id, -Number(token.total_debit), 'withdraw_reserve', 'withdrawal', withdrawalId,
      { payout: token.amount, fee: token.fee_sats });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK'); console.error('LNURL payout reservation failed:', error?.message || error);
    return res.json({ status: 'ERROR', reason: 'Payout could not be reserved' });
  }

  res.json({ status: 'OK' });
  setImmediate(() => void submitWithdrawal(withdrawalId));
});

app.post('/api/withdrawals', rateLimit('withdraw-direct', 600, 3), async (req, res) => {
  const sessionId = guestSession(req, res);
  let parsed;
  try { parsed = decodeWholeSatInvoice(req.body?.invoice); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const { invoice, paymentHash, amount } = parsed;
  const feeSats = withdrawalFee(amount); const totalDebit = amount + feeSats;
  const withdrawalId = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    assertPayoutAllowed(sessionId, amount);
    const prior = db.prepare('SELECT session_id, state FROM withdrawals WHERE payment_hash = ?').get(paymentHash);
    if (prior) { db.exec('ROLLBACK'); return res.status(409).json({ error: 'Invoice has already been submitted' }); }
    const session = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId);
    if (!session || totalDebit > session.balance) { db.exec('ROLLBACK'); return res.status(409).json({ error: `Invoice plus ${feeSats} sat payout fee exceeds balance` }); }
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO withdrawals
      (id, payment_hash, session_id, invoice, amount, fee_sats, total_debit, state, next_attempt_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`)
      .run(withdrawalId, paymentHash, sessionId, invoice, amount, feeSats, totalDebit, now, now);
    applyBalanceDelta(sessionId, -totalDebit, 'withdraw_reserve', 'withdrawal', withdrawalId, { payout: amount, fee: feeSats });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK'); console.error('Withdrawal reservation failed:', error?.message || error);
    if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
    return res.status(error.status || 500).json({ error: error.message || 'Withdrawal could not be reserved' });
  }
  await submitWithdrawal(withdrawalId);
  const current = db.prepare('SELECT state FROM withdrawals WHERE id = ?').get(withdrawalId);
  const balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId).balance;
  if (current.state === 'settled') {
    rotateGuestToken(sessionId, res);
    return res.set('Cache-Control', 'no-store').json({ state: 'settled', amount, fee: feeSats, balance });
  }
  if (current.state === 'failed') return res.status(502).json({ error: 'Lightning payment failed; balance restored', balance });
  res.status(202).json({ state: 'review', error: 'Payment status uncertain; withdrawal reserved for review', balance });
});

app.post('/api/deposits', rateLimit('deposit-create', 600, 3), async (req, res) => {
  let reservationId = '';
  try {
    const sessionId = guestSession(req, res);
    const amount = Number(req.body?.amount);
    if (![10, 50, 100, 250, 500].includes(amount) || amount > maxDepositSats) return res.status(400).json({ error: `Choose a deposit of 10, 50, 100, 250 or 500 sats (maximum ${maxDepositSats} sats per transaction)` });
    const now = nowSeconds();
    reservationId = `creating:${crypto.randomUUID()}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM invoices WHERE state = 'creating' AND expires_at + 300 <= ?").run(now);
      const remaining = Math.max(0, dailyDepositLimitSats - incomingLast24Hours(now));
      if (amount > remaining) {
        db.exec('ROLLBACK');
        return res.status(409).json({ error: `Daily deposit limit reached; ${remaining} sats remaining`, depositRemaining: remaining });
      }
      db.prepare(`INSERT INTO invoices (payment_hash, session_id, invoice, amount, state, created_at, expires_at)
        VALUES (?, ?, 'creating', ?, 'creating', ?, ?)`).run(reservationId, sessionId, amount, now, now + 600);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const created = await withNwcLimit(() => walletClient.makeInvoice({ amount: amount * 1000, description: `Satsball deposit ${amount} sats`, expiry: 600 }));
    const invoice = created.invoice;
    const paymentHash = created.payment_hash;
    if (!invoice || !paymentHash) throw new Error('Rizful returned an incomplete invoice');
    const decoded = decodeWholeSatInvoice(invoice);
    if (decoded.paymentHash !== paymentHash || decoded.amount !== amount) throw new Error('Rizful invoice does not match requested deposit');
    if (created.amount != null && Number(created.amount) !== amount * 1000) throw new Error('Rizful returned an incorrect deposit amount');
    const expiresAt = created.expires_at || now + 600;
    db.prepare(`UPDATE invoices SET payment_hash = ?, invoice = ?, state = 'pending', expires_at = ?
      WHERE payment_hash = ? AND state = 'creating'`).run(paymentHash, invoice, expiresAt, reservationId);
    const qr = await QRCode.toDataURL(`lightning:${invoice.toUpperCase()}`, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
    const depositRemaining = Math.max(0, dailyDepositLimitSats - incomingLast24Hours());
    res.set('Cache-Control', 'no-store').json({ paymentHash, invoice, amount, expiresAt, qr, depositRemaining });
  } catch (error) {
    if (reservationId) db.prepare("DELETE FROM invoices WHERE payment_hash = ? AND state = 'creating'").run(reservationId);
    console.error('Deposit invoice failed:', error?.code || error?.message || error);
    res.status(502).json({ error: 'Lightning invoice could not be created' });
  }
});

app.get('/api/deposits/:paymentHash', rateLimit('deposit-status', 60, 60), async (req, res) => {
  try {
    const sessionId = guestSession(req, res);
    const row = db.prepare('SELECT * FROM invoices WHERE payment_hash = ? AND session_id = ?').get(req.params.paymentHash, sessionId);
    if (!row) return res.status(404).json({ error: 'Invoice not found' });
    const now = nowSeconds();
    let newlyCredited = false;
    if (row.state === 'pending' && row.expires_at + 300 > now) {
      const invoice = await withNwcLimit(() => walletClient.lookupInvoice({ payment_hash: row.payment_hash }));
      if (invoice.state === 'settled') {
        const valid = invoice.type === 'incoming'
          && invoice.payment_hash === row.payment_hash
          && Number(invoice.amount) === Number(row.amount) * 1000;
        if (!valid) {
          db.prepare("UPDATE invoices SET state = 'review' WHERE payment_hash = ? AND state = 'pending'").run(row.payment_hash);
          pausePayouts('deposit provider response mismatch');
          throw new Error('Deposit requires manual review');
        }
        db.exec('BEGIN IMMEDIATE');
        try {
          const update = db.prepare("UPDATE invoices SET state = 'settled', credited_at = ? WHERE payment_hash = ? AND state = 'pending'")
            .run(nowSeconds(), row.payment_hash);
          if (update.changes === 1) {
            applyBalanceDelta(sessionId, Number(row.amount), 'deposit', 'invoice', row.payment_hash, { amount: Number(row.amount) });
            newlyCredited = true;
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
    } else if (row.state === 'pending' && row.expires_at + 300 <= now) {
      db.prepare("UPDATE invoices SET state = 'expired' WHERE payment_hash = ? AND state = 'pending'").run(row.payment_hash);
    }
    const current = db.prepare('SELECT state, expires_at FROM invoices WHERE payment_hash = ?').get(row.payment_hash);
    const balance = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(sessionId).balance;
    if (newlyCredited) rotateGuestToken(sessionId, res);
    res.set('Cache-Control', 'no-store').json({ state: current.state, expiresAt: current.expires_at, balance });
  } catch (error) {
    console.error('Deposit lookup failed:', error?.code || error?.message || error);
    res.status(502).json({ error: 'Payment status unavailable' });
  }
});

function scalar(sql, ...params) {
  return Number(db.prepare(sql).get(...params)?.value || 0);
}

function monitoringSnapshot() {
  const now = Math.floor(Date.now() / 1000); const since = now - 30 * 86400;
  const roundsStarted = scalar('SELECT COUNT(*) value FROM game_rounds');
  const roundsCompleted = scalar("SELECT COUNT(*) value FROM game_rounds WHERE state = 'completed'");
  const visitors = scalar('SELECT COUNT(*) value FROM sessions');
  const players = scalar("SELECT COUNT(DISTINCT session_id) value FROM invoices WHERE state = 'settled'");
  const visitorsOnly = visitors - players;
  const stakes = roundsStarted * 10;
  const payouts = scalar("SELECT COALESCE(SUM(payout), 0) value FROM game_rounds WHERE state = 'completed'");
  const deposits = scalar("SELECT COALESCE(SUM(amount), 0) value FROM invoices WHERE state = 'settled'");
  const withdrawals = scalar("SELECT COALESCE(SUM(amount), 0) value FROM withdrawals WHERE state = 'settled'");
  const withdrawalFees = scalar("SELECT COALESCE(SUM(fee_sats), 0) value FROM withdrawals WHERE state = 'settled'");
  const reservedWithdrawals = scalar("SELECT COALESCE(SUM(amount), 0) value FROM withdrawals WHERE state IN ('reserved','pending','submitting','review')");
  const reservedWithdrawalFees = scalar("SELECT COALESCE(SUM(fee_sats), 0) value FROM withdrawals WHERE state IN ('reserved','pending','submitting','review')");
  const feesMsat = scalar("SELECT COALESCE(SUM(fees_paid_msat), 0) value FROM withdrawals WHERE state = 'settled'");
  const outstanding = scalar('SELECT COALESCE(SUM(balance), 0) value FROM sessions');
  const ledgerDifference = scalar(`SELECT COALESCE(SUM(balance - ledger_balance), 0) value FROM (
    SELECT s.balance, COALESCE(SUM(l.delta), 0) ledger_balance
    FROM sessions s LEFT JOIN ledger_events l ON l.session_id = s.id GROUP BY s.id)`);
  const ggr = stakes - payouts;
  const days = new Map();
  const ensureDay = (day) => {
    if (!days.has(day)) days.set(day, { day, visitors: 0, visitorsOnly: 0, players: 0, pageviews: 0, rounds: 0, completed: 0, wins: 0, losses: 0, stakes: 0, payouts: 0, ggr: 0, deposits: 0, withdrawals: 0, feesMsat: 0 });
    return days.get(day);
  };
  for (const row of db.prepare(`SELECT vd.day, COUNT(*) visitors, SUM(vd.pageviews) pageviews,
      SUM(EXISTS(SELECT 1 FROM invoices i WHERE i.session_id = vd.session_id AND i.state = 'settled')) players,
      SUM(NOT EXISTS(SELECT 1 FROM invoices i WHERE i.session_id = vd.session_id AND i.state = 'settled')) visitors_only
    FROM visitor_days vd WHERE vd.last_seen_at >= ? GROUP BY vd.day`).all(since)) {
    Object.assign(ensureDay(row.day), {
      visitors: Number(row.visitors), visitorsOnly: Number(row.visitors_only), players: Number(row.players), pageviews: Number(row.pageviews)
    });
  }
  for (const row of db.prepare('SELECT created_at, state, payout FROM game_rounds WHERE created_at >= ?').all(since)) {
    const day = ensureDay(berlinDay(Number(row.created_at) * 1000)); day.rounds += 1; day.stakes += 10;
    if (row.state === 'completed') { day.completed += 1; day.payouts += Number(row.payout); row.payout > 0 ? day.wins += 1 : day.losses += 1; }
  }
  for (const row of db.prepare("SELECT COALESCE(credited_at, created_at) timestamp, amount FROM invoices WHERE state = 'settled' AND COALESCE(credited_at, created_at) >= ?").all(since)) {
    ensureDay(berlinDay(Number(row.timestamp) * 1000)).deposits += Number(row.amount);
  }
  for (const row of db.prepare("SELECT COALESCE(completed_at, created_at) timestamp, amount, COALESCE(fees_paid_msat, 0) fees_msat FROM withdrawals WHERE state = 'settled' AND COALESCE(completed_at, created_at) >= ?").all(since)) {
    const day = ensureDay(berlinDay(Number(row.timestamp) * 1000)); day.withdrawals += Number(row.amount); day.feesMsat += Number(row.fees_msat);
  }
  for (const day of days.values()) day.ggr = day.stakes - day.payouts;
  return {
    generatedAt: new Date().toISOString(),
    traffic: {
      visitors, visitorsOnly, players,
      visitorsToday: scalar('SELECT COUNT(*) value FROM visitor_days WHERE day = ?', berlinDay()),
      visitors7d: scalar('SELECT COUNT(DISTINCT session_id) value FROM visitor_days WHERE last_seen_at >= ?', now - 7 * 86400),
      pageviews: scalar('SELECT COALESCE(SUM(pageviews), 0) value FROM visitor_days')
    },
    games: {
      roundsStarted, roundsCompleted, unfinished: roundsStarted - roundsCompleted,
      winningRounds: scalar("SELECT COUNT(*) value FROM game_rounds WHERE state = 'completed' AND payout > 0"),
      losingRounds: scalar("SELECT COUNT(*) value FROM game_rounds WHERE state = 'completed' AND payout = 0"),
      stakes, payouts, ggr, rtp: stakes > 0 ? payouts / stakes : 0,
      largestWin: scalar("SELECT COALESCE(MAX(payout), 0) value FROM game_rounds WHERE state = 'completed'")
    },
    money: {
      deposits, withdrawals, withdrawalFees, reservedWithdrawals, reservedWithdrawalFees, feesMsat, outstanding, ledgerDifference,
      paymentCashflow: deposits - withdrawals,
      houseEarnings: ggr + withdrawalFees,
      netEarningsMsat: (ggr + withdrawalFees) * 1000 - feesMsat,
      reconciliationDifference: deposits - withdrawals - withdrawalFees - reservedWithdrawals - reservedWithdrawalFees - outstanding - ggr
    },
    security: {
      payoutsPaused: securityState('payouts_paused') === '1',
      pauseReason: securityState('payouts_pause_reason') || null,
      unresolvedWithdrawals: scalar("SELECT COUNT(*) value FROM withdrawals WHERE state IN ('reserved','pending','submitting','review')"),
      walletBalanceSats: Number(securityState('wallet_balance_sats') || 0),
      walletLiabilitiesSats: Number(securityState('wallet_liabilities_sats') || 0),
      walletCheckedAt: Number(securityState('wallet_checked_at') || 0)
    },
    daily: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).slice(0, 30)
  };
}

app.get('/api/monitoring', monitoringAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store').json(monitoringSnapshot());
});

app.use('/monitoring', monitoringAuth, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
  express.static(path.join(root, 'monitoring'), { index: 'index.html', dotfiles: 'deny', fallthrough: false }));

const publicFiles = new Map([
  ['/', 'index.html'], ['/index.html', 'index.html'], ['/game.js', 'game.js'], ['/physics.js', 'physics.js'], ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'], ['/satsball-edit.png', 'satsball-edit.png'],
  ['/satsball-social-card-v2.png', 'satsball-social-card-v2.png']
]);
for (const [route, filename] of publicFiles) app.get(route, (_req, res) => res.sendFile(path.join(root, filename)));
app.get('/vendor/jsqr.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'jsqr', 'dist', 'jsQR.js')));
app.use((_req, res) => res.sendStatus(404));

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '0.0.0.0';
let server;
let recoveryTimer;
let cleanupTimer;
let solvencyTimer;

function verifyFinancialInvariants() {
  const snapshot = monitoringSnapshot();
  const agedWithdrawals = scalar(`SELECT COUNT(*) value FROM withdrawals
    WHERE state IN ('reserved','pending','submitting','review') AND created_at < ?`, nowSeconds() - 300);
  if (snapshot.money.reconciliationDifference !== 0 || snapshot.money.ledgerDifference !== 0 || agedWithdrawals > 0) {
    pausePayouts(`financial invariant mismatch: accounting=${snapshot.money.reconciliationDifference}, ledger=${snapshot.money.ledgerDifference}`);
    return false;
  }
  return true;
}
function startRuntime(runtimePort = port, runtimeHost = host) {
  if (server) return server;
  verifyFinancialInvariants();
  server = app.listen(runtimePort, runtimeHost, () => console.log(`Satsball listening on http://${runtimeHost}:${runtimePort}`));
  recoveryTimer = setInterval(() => void recoverWithdrawals().catch((error) => console.error('Withdrawal recovery failed:', error?.message || error)), 15000);
  recoveryTimer.unref();
  setTimeout(() => void recoverWithdrawals().catch((error) => console.error('Initial withdrawal recovery failed:', error?.message || error)), 1000).unref();
  setTimeout(() => void verifyWalletSolvency(), 2000).unref();
  cleanupTimer = setInterval(() => db.prepare('DELETE FROM rate_limits WHERE window_start < ?').run(nowSeconds() - 86400), 3600000);
  cleanupTimer.unref();
  solvencyTimer = setInterval(() => void verifyWalletSolvency(), 60000);
  solvencyTimer.unref();
  return server;
}

async function stopRuntime() {
  clearInterval(recoveryTimer);
  clearInterval(cleanupTimer);
  clearInterval(solvencyTimer);
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  nwc.close();
  db.close();
}

function setWalletClientForTest(client) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Wallet client injection is test-only');
  walletClient = client;
}

if (process.env.NODE_ENV !== 'test') {
  startRuntime();
  process.once('SIGTERM', () => void stopRuntime());
  process.once('SIGINT', () => void stopRuntime());
}

export { app, db, recoverWithdrawals, refundWithdrawal, setWalletClientForTest, settleWithdrawal, startRuntime, stopRuntime, submitWithdrawal, verifyFinancialInvariants, verifyWalletSolvency };
