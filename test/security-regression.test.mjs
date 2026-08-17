import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const projectRoot = path.resolve(import.meta.dirname, '..');

async function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'satsball-security-'));
  const port = 36000 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: origin,
    MONITORING_USER: 'security-test', MONITORING_PASSWORD: 'test-only-monitoring-password'
  });
  const runtime = await import(`../server.mjs?security-test=${Date.now()}`);
  runtime.startRuntime(port, '127.0.0.1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { runtime, dataDir, origin, dbPath: path.join(dataDir, 'satsball.db') };
}

function cookieToken(response) {
  const header = response.headers.get('set-cookie') || '';
  return header.match(/__Host-satsball_guest=([a-f0-9]{64})/)?.[1];
}

async function request(origin, pathname, { token, method = 'GET', body, requestOrigin = origin } = {}) {
  const headers = {};
  if (token) headers.Cookie = `__Host-satsball_guest=${token}`;
  if (method !== 'GET') {
    headers.Origin = requestOrigin;
    headers['Content-Type'] = 'application/json';
  }
  return fetch(`${origin}${pathname}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
}

test('session, static boundary, replay protection, ledger and auth limits', async (t) => {
  const fixture = await startServer();
  t.after(async () => {
    await fixture.runtime.stopRuntime();
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  });

  const first = await request(fixture.origin, '/api/session');
  assert.equal(first.status, 200);
  assert.equal((await first.clone().json()).depositRemaining, 5000);
  const token = cookieToken(first);
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.match(first.headers.get('set-cookie'), /HttpOnly/);
  assert.match(first.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(first.headers.get('set-cookie'), /Secure/);

  const db = new DatabaseSync(fixture.dbPath);
  const session = db.prepare('SELECT id, token_hash FROM sessions').get();
  assert.notEqual(session.id, token);
  assert.equal(session.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(fs.statSync(fixture.dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(fixture.dbPath).mode & 0o777, 0o600);

  const attackerToken = 'a'.repeat(64);
  const attacker = await request(fixture.origin, '/api/session', { token: attackerToken });
  assert.equal(attacker.status, 200);
  assert.notEqual(cookieToken(attacker), attackerToken);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM sessions WHERE id = ?').get(attackerToken).count, 0);

  const malformed = await fetch(`${fixture.origin}/api/session`, { headers: { Cookie: '__Host-satsball_guest=%' } });
  assert.equal(malformed.status, 200);
  assert.equal((await request(fixture.origin, '/deploy/satsball.service')).status, 404);
  assert.equal((await request(fixture.origin, '/server.mjs')).status, 404);
  assert.equal((await request(fixture.origin, '/')).status, 200);

  const forged = await request(fixture.origin, '/api/game/start', { token, method: 'POST', body: {}, requestOrigin: 'https://attacker.invalid' });
  assert.equal(forged.status, 403);
  const oversizedDeposit = await request(fixture.origin, '/api/deposits', { token, method: 'POST', body: { amount: 1000 } });
  assert.equal(oversizedDeposit.status, 400);

  db.exec('BEGIN IMMEDIATE');
  db.prepare('UPDATE sessions SET balance = 100 WHERE id = ?').run(session.id);
  db.prepare(`INSERT INTO ledger_events
    (id, session_id, delta, event_type, reference_type, reference_id, created_at)
    VALUES (?, ?, 100, 'test_opening', 'test', 'opening', unixepoch())`).run(crypto.randomUUID(), session.id);
  db.exec('COMMIT');

  const started = await request(fixture.origin, '/api/game/start', { token, method: 'POST', body: {} });
  assert.equal(started.status, 200);
  const { roundId } = await started.json();
  for (const shotIndex of [0, 1, 2]) {
    const attempts = await Promise.all(Array.from({ length: 20 }, () => request(fixture.origin, `/api/game/${roundId}/shot`, {
      token, method: 'POST', body: { shotIndex }
    })));
    assert.ok(attempts.every((response) => response.status === 200));
  }
  assert.equal(db.prepare('SELECT shot_count FROM game_rounds WHERE id = ?').get(roundId).shot_count, 3);
  assert.ok(db.prepare("SELECT COUNT(*) count FROM ledger_events WHERE event_type = 'win' AND reference_id = ?").get(roundId).count <= 1);
  const ledger = db.prepare(`SELECT s.balance, COALESCE(SUM(l.delta), 0) ledger_balance
    FROM sessions s LEFT JOIN ledger_events l ON l.session_id = s.id WHERE s.id = ? GROUP BY s.id`).get(session.id);
  assert.equal(ledger.balance, ledger.ledger_balance);

  const depositHash = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO invoices
    (payment_hash,session_id,invoice,amount,state,created_at,expires_at)
    VALUES (?,?,?,100,'pending',unixepoch(),unixepoch()+600)`)
    .run(depositHash, session.id, 'test-deposit-invoice');
  fixture.runtime.setWalletClientForTest({
    lookupInvoice: async ({ payment_hash }) => ({ type: 'incoming', state: 'settled', payment_hash, amount: 100000 }),
    getBalance: async () => ({ balance: 1000000 })
  });
  const depositBalanceBefore = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(session.id).balance;
  const depositPolls = await Promise.all(Array.from({ length: 20 }, () => request(fixture.origin, `/api/deposits/${depositHash}`, { token })));
  assert.ok(depositPolls.every((response) => response.status === 200));
  assert.equal(db.prepare('SELECT balance FROM sessions WHERE id = ?').get(session.id).balance, depositBalanceBefore + 100);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM ledger_events WHERE event_type='deposit' AND reference_id=?").get(depositHash).count, 1);
  const monitoringResponse = await fetch(`${fixture.origin}/api/monitoring`, {
    headers: { Authorization: `Basic ${Buffer.from('security-test:test-only-monitoring-password').toString('base64')}` }
  });
  assert.equal(monitoringResponse.status, 200);
  const monitoring = await monitoringResponse.json();
  assert.equal(monitoring.traffic.players, 1);
  assert.equal(monitoring.traffic.visitors, monitoring.traffic.visitorsOnly + monitoring.traffic.players);
  assert.ok(monitoring.daily.every((day) => day.visitors === day.visitorsOnly + day.players));

  const refundableId = crypto.randomUUID();
  db.exec('BEGIN IMMEDIATE');
  db.prepare(`INSERT INTO withdrawals
    (id,payment_hash,session_id,invoice,amount,fee_sats,total_debit,state,created_at)
    VALUES (?,?,?,?,20,5,25,'review',unixepoch())`)
    .run(refundableId, crypto.randomBytes(32).toString('hex'), session.id, 'test-invoice-refund');
  db.prepare('UPDATE sessions SET balance = balance - 25 WHERE id = ?').run(session.id);
  db.prepare(`INSERT INTO ledger_events
    (id,session_id,delta,event_type,reference_type,reference_id,created_at)
    VALUES (?,?,-25,'withdraw_reserve','withdrawal',?,unixepoch())`)
    .run(crypto.randomUUID(), session.id, refundableId);
  db.exec('COMMIT');
  const beforeRefund = db.prepare('SELECT balance FROM sessions WHERE id = ?').get(session.id).balance;
  fixture.runtime.refundWithdrawal(refundableId, 'PAYMENT_FAILED');
  fixture.runtime.refundWithdrawal(refundableId, 'PAYMENT_FAILED');
  assert.equal(db.prepare('SELECT balance FROM sessions WHERE id = ?').get(session.id).balance, beforeRefund + 25);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM ledger_events WHERE event_type='withdraw_refund' AND reference_id=?").get(refundableId).count, 1);

  const workerId = crypto.randomUUID(); const workerHash = crypto.randomBytes(32).toString('hex');
  db.exec('BEGIN IMMEDIATE');
  db.prepare(`INSERT INTO withdrawals
    (id,payment_hash,session_id,invoice,amount,fee_sats,total_debit,state,next_attempt_at,created_at)
    VALUES (?,?,?,?,10,5,15,'reserved',unixepoch(),unixepoch())`)
    .run(workerId, workerHash, session.id, 'test-worker-invoice');
  db.prepare('UPDATE sessions SET balance = balance - 15 WHERE id = ?').run(session.id);
  db.prepare(`INSERT INTO ledger_events
    (id,session_id,delta,event_type,reference_type,reference_id,created_at)
    VALUES (?,?,-15,'withdraw_reserve','withdrawal',?,unixepoch())`)
    .run(crypto.randomUUID(), session.id, workerId);
  db.exec('COMMIT');
  fixture.runtime.setWalletClientForTest({
    payInvoice: async () => ({ preimage: 'worker-paid', fees_paid: 3000 }),
    lookupInvoice: async ({ payment_hash }) => ({ payment_hash, amount: 10000, state: 'settled', preimage: 'recovered', fees_paid: 3000 }),
    listTransactions: async () => ({ transactions: [] })
  });
  await fixture.runtime.submitWithdrawal(workerId);
  assert.equal(db.prepare('SELECT state FROM withdrawals WHERE id = ?').get(workerId).state, 'settled');

  const crashedId = crypto.randomUUID(); const crashedHash = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO withdrawals
    (id,payment_hash,session_id,invoice,amount,fee_sats,total_debit,state,attempt_count,last_attempt_at,next_attempt_at,created_at)
    VALUES (?,?,?,?,10,5,15,'submitting',1,unixepoch()-60,unixepoch(),unixepoch()-60)`)
    .run(crashedId, crashedHash, session.id, 'test-crashed-invoice');
  await fixture.runtime.recoverWithdrawals();
  assert.equal(db.prepare('SELECT state FROM withdrawals WHERE id = ?').get(crashedId).state, 'settled');

  const settledId = crypto.randomUUID(); const settledHash = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO withdrawals
    (id,payment_hash,session_id,invoice,amount,fee_sats,total_debit,state,created_at)
    VALUES (?,?,?,?,20,5,25,'review',unixepoch())`)
    .run(settledId, settledHash, session.id, 'test-invoice-settle');
  fixture.runtime.settleWithdrawal(settledId, { payment_hash: settledHash, amount: 20000, preimage: 'test', fees_paid: 3000 });
  fixture.runtime.settleWithdrawal(settledId, { payment_hash: settledHash, amount: 20000, preimage: 'test', fees_paid: 3000 });
  assert.equal(db.prepare('SELECT state FROM withdrawals WHERE id = ?').get(settledId).state, 'settled');

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const response = await fetch(`${fixture.origin}/api/monitoring`, { headers: { Authorization: 'Basic bm9wZTpub3Bl' } });
    assert.equal(response.status, attempt <= 5 ? 401 : 429);
  }

  const mismatchHash = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO invoices
    (payment_hash,session_id,invoice,amount,state,created_at,expires_at)
    VALUES (?,?,?,100,'pending',unixepoch(),unixepoch()+600)`)
    .run(mismatchHash, session.id, 'test-mismatched-deposit');
  fixture.runtime.setWalletClientForTest({
    lookupInvoice: async ({ payment_hash }) => ({ type: 'incoming', state: 'settled', payment_hash, amount: 99000 }),
    getBalance: async () => ({ balance: 1000000 })
  });
  const mismatch = await request(fixture.origin, `/api/deposits/${mismatchHash}`, { token });
  assert.equal(mismatch.status, 502);
  assert.equal(db.prepare('SELECT state FROM invoices WHERE payment_hash = ?').get(mismatchHash).state, 'review');
  assert.equal(db.prepare("SELECT value FROM security_state WHERE key='payouts_paused'").get().value, '1');
  db.close();
});
