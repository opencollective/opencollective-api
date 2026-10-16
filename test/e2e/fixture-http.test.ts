import assert from 'assert/strict';
import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import http from 'http';

import { QueryTypes } from 'sequelize';

import { getDBConf } from '../../server/lib/db';
import { sequelize } from '../../server/models';

const ownerFile = process.env.PLAYWRIGHT_FIXTURE_OWNER_FILE;

// Explicit opt-in integration checks against a launched, owned disposable stack.
// The normal API suite neither exposes fixtures nor locks its test database.
(ownerFile ? describe : describe.skip)('owned fixture HTTP interruption contract', () => {
  let token: string;
  let endpoint: string;
  const attempt = {
    runId: `run-contract-${randomUUID()}`,
    testId: 'http-interruption',
    workerIndex: 0,
    retry: 0,
    nonce: randomUUID(),
  };
  const body = (requestId: string, name: string) => ({
    attempt,
    requestId,
    recipe: 'account-profile',
    inputs: { name },
  });
  const post = (payload: unknown) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  before(() => {
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8'));
    assert.match(owner.database, /^opencollective_pw_e2e(?:_[a-z0-9_]+)?$/);
    assert.equal(
      getDBConf('database').database,
      owner.database,
      'Refusing locks outside the launcher-owned disposable database',
    );
    token = owner.token;
    endpoint = `${process.env.API_URL}/e2e/fixtures`;
  });
  after(() => sequelize.close());

  it('rejects missing attempt identity and unknown recipes without creating prerequisites', async () => {
    assert.equal(
      (await post({ requestId: 'missing-attempt', recipe: 'account-profile', inputs: { name: 'Missing identity' } }))
        .status,
      400,
    );
    assert.equal((await post({ ...body('unknown', 'Unknown'), recipe: 'not-a-recipe' })).status, 400);
  });

  it('recovers a committed result after the client discards the HTTP response', async () => {
    const payload = body('lost-response', 'Recoverable Account');
    await new Promise<void>((resolve, reject) => {
      const client = http.request(
        endpoint,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        },
        response => {
          assert.equal(response.statusCode, 200);
          response.destroy();
          resolve();
        },
      );
      client.on('error', reject);
      client.end(JSON.stringify(payload));
    });
    const [recovered, duplicate] = await Promise.all([post(payload), post(payload)]);
    assert.equal(recovered.status, 200);
    assert.equal(duplicate.status, 200);
    const recoveredResult = await recovered.json();
    const duplicateResult = await duplicate.json();
    assert.equal(duplicateResult.account.id, recoveredResult.account.id);
    assert.equal(duplicateResult.user.id, recoveredResult.user.id);
  });

  it('reports partial domain setup failure and rolls it back before a corrected retry', async () => {
    const invalid = await post(body('invalid-name', 'x'.repeat(256)));
    assert.equal(invalid.status, 422);
    const { error } = await invalid.json();
    assert.equal(error.code, 'INVALID_PREREQUISITE');
    assert.match(error.message, /name.*rolled back/);
    assert.equal((await post(body('invalid-name', 'x'.repeat(256)))).status, 422);
    assert.equal((await post(body('retry-failure-peer', 'Valid peer'))).status, 200);
    // User/profile were already created before account validation failed.
    // Leftovers would collide with these identities on the corrected request.
    const corrected = await post(body('invalid-name', 'Valid retry'));
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json()).account.name, 'Valid retry');
  });

  it('rolls back a disconnected request blocked midway through setup, then recovers beside another request', async function () {
    this.timeout(45_000);
    const lock = await sequelize.transaction();
    let interrupted: http.ClientRequest;
    try {
      // Fault injection at the database boundary, owned by this API test only.
      // No table mutations/deletions or fixture reset is performed.
      await sequelize.query('LOCK TABLE "Members" IN ACCESS EXCLUSIVE MODE', { transaction: lock });
      interrupted = http.request(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      interrupted.on('error', () => {}); // Intentional client disconnect below.
      interrupted.end(JSON.stringify(body('interrupted', 'Interrupted Account')));
      const deadline = Date.now() + 10_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const [row] = await sequelize.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'e2e-fixture-%' AND wait_event_type = 'Lock') AS waiting",
          { type: QueryTypes.SELECT },
        );
        waiting = row.waiting;
        if (!waiting) {
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      assert.equal(waiting, true, 'Fixture did not reach the injected setup interruption');
      interrupted.destroy();
      // Let the API observe the closed socket before unblocking domain writes.
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      interrupted?.destroy();
      await lock.rollback();
    }
    const [recovered, peer] = await Promise.all([
      post(body('interrupted', 'Recovered Account')),
      post(body('peer', 'Independent peer')),
    ]);
    assert.equal(recovered.status, 200);
    assert.equal(peer.status, 200);
    const recoveredResult = await recovered.json();
    const peerResult = await peer.json();
    assert.equal(recoveredResult.account.name, 'Recovered Account');
    assert.notEqual(recoveredResult.account.id, peerResult.account.id);
    const duplicate = await post(body('interrupted', 'Recovered Account'));
    const { auth: duplicateAuth, ...duplicateReferences } = await duplicate.json();
    const { auth: recoveredAuth, ...recoveredReferences } = recoveredResult;
    assert.deepEqual(duplicateReferences, recoveredReferences);
    const tokenDigest = (value: string) => createHash('sha256').update(value).digest('hex');
    assert.equal(tokenDigest(duplicateAuth.token), tokenDigest(recoveredAuth.token));
  });
});
