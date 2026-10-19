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
    assert.equal((await post({ ...body('inherited', 'Inherited'), recipe: 'constructor' })).status, 400);
  });

  it('validates inputs per recipe and commits a multi-party graph only as a whole', async () => {
    const submission = (requestId: string, inputs: unknown) => ({
      attempt,
      requestId,
      recipe: 'expense-submission',
      inputs,
    });
    // Inputs of another recipe, or options this recipe does not define, create nothing.
    assert.equal((await post(submission('foreign-inputs', { name: 'An Account' }))).status, 400);
    assert.equal((await post(submission('unknown-option', { vendor: true }))).status, 400);

    // An unknown country fails domain validation after the actors, host and Collective were written.
    const vat = { type: 'OWN', number: 'FRXX999999999' };
    const invalid = await post(submission('graph', { collective: { country: 'ZZ', vat }, priorExpense: true }));
    assert.equal(invalid.status, 422);
    assert.equal((await invalid.json()).error.code, 'INVALID_PREREQUISITE');

    // Leftovers would collide with the same identities on the corrected request.
    const inputs = { collective: { country: 'BE', vat }, priorExpense: true, payeeOrganization: true };
    const corrected = await post(submission('graph', inputs));
    assert.equal(corrected.status, 200);
    const graph = await corrected.json();
    assert.deepEqual(Object.keys(graph.actors).sort(), ['hostAdmin', 'submitter']);
    assert.deepEqual(Object.keys(graph.accounts).sort(), ['collective', 'host', 'organization']);
    assert.equal(graph.expenses.prior.status, 'PENDING');
    const [stored] = await sequelize.query<{ hosted: boolean; country: string; items: number }>(
      `SELECT c."isActive" AND c."HostCollectiveId" = :host AS hosted, c."countryISO" AS country,
        (SELECT COUNT(*)::int FROM "ExpenseItems" i WHERE i."ExpenseId" = :expense) AS items
      FROM "Collectives" c WHERE c.id = :collective`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          host: graph.accounts.host.legacyId,
          collective: graph.accounts.collective.legacyId,
          expense: graph.expenses.prior.legacyId,
        },
      },
    );
    assert.deepEqual(stored, { hosted: true, country: 'BE', items: 1 });

    // The receipt returns the same graph, including each actor's session handle.
    const repeated = await (await post(submission('graph', inputs))).json();
    assert.deepEqual(repeated, graph);
    assert.equal((await post(submission('graph', { ...inputs, invitee: true }))).status, 409);
  });

  it('arranges a prior reimbursement whose item points at a receipt held in file storage', async () => {
    const submission = (requestId: string, inputs: unknown) => ({
      attempt,
      requestId,
      recipe: 'expense-submission',
      inputs,
    });
    assert.equal((await post(submission('grant', { priorExpense: true, priorExpenseType: 'GRANT' }))).status, 400);
    const response = await post(submission('reimbursement', { priorExpense: true, priorExpenseType: 'RECEIPT' }));
    assert.equal(response.status, 200);
    const graph = await response.json();
    const [stored] = await sequelize.query<Record<string, unknown>>(
      `SELECT e.type AS type, f."publicId" AS file, f.kind AS kind, f."fileType" AS "fileType",
        f."fileSize" AS "fileSize", f."CreatedByUserId" = e."UserId" AS "uploadedBySubmitter"
      FROM "Expenses" e
      JOIN "ExpenseItems" i ON i."ExpenseId" = e.id
      LEFT JOIN "UploadedFiles" f ON f.url = i.url
      WHERE e.id = :expense`,
      { type: QueryTypes.SELECT, replacements: { expense: graph.expenses.prior.legacyId } },
    );
    const { file, fileSize, ...receipt } = stored;
    assert.deepEqual(receipt, {
      type: 'RECEIPT',
      kind: 'EXPENSE_ITEM',
      fileType: 'image/png',
      uploadedBySubmitter: true,
    });
    // The file is really there: the submitter gets it from the product's file route, as the expense page does.
    const link = await fetch(`${process.env.API_URL}/files/${file}?json&expenseId=${graph.expenses.prior.id}`, {
      headers: { Authorization: `Bearer ${graph.actors.submitter.token}` },
    });
    assert.equal(link.status, 200);
    const served = await fetch((await link.json()).url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal((await served.arrayBuffer()).byteLength, fileSize);
  });

  it('arranges an invitable Organization with its own admin and no activity that would notify them', async () => {
    const response = await post({
      attempt,
      requestId: 'invitable-organization',
      recipe: 'expense-submission',
      inputs: { inviteeOrganization: true },
    });
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.deepEqual(Object.keys(graph.actors).sort(), ['hostAdmin', 'inviteeAdmin', 'submitter']);
    assert.deepEqual(Object.keys(graph.accounts).sort(), ['collective', 'host', 'inviteeOrganization']);
    assert.equal(graph.accounts.inviteeOrganization.type, 'ORGANIZATION');
    const [stored] = await sequelize.query<{ admins: number[]; activities: number }>(
      `SELECT ARRAY(SELECT m."MemberCollectiveId" FROM "Members" m
          WHERE m."CollectiveId" = :organization AND m.role = 'ADMIN' AND m."deletedAt" IS NULL) AS admins,
        (SELECT COUNT(*)::int FROM "Activities" a WHERE a."CollectiveId" = :organization) AS activities`,
      { type: QueryTypes.SELECT, replacements: { organization: graph.accounts.inviteeOrganization.legacyId } },
    );
    // Only its own admin manages it. Activities drive notification mail: the journey's invitation must be the first.
    assert.deepEqual(stored, { admins: [graph.actors.inviteeAdmin.legacyId], activities: 0 });
  });

  it('arranges a Collective admin with a pending expense and a Project under the same host, without policies', async () => {
    const management = (requestId: string, inputs: unknown) => ({
      attempt,
      requestId,
      recipe: 'expense-management',
      inputs,
    });
    assert.equal((await post(management('no-items', { expense: { description: 'Empty', items: [] } }))).status, 400);
    const bare = await (await post(management('bare', {}))).json();
    assert.deepEqual(Object.keys(bare.accounts).sort(), ['collective', 'host']);
    assert.deepEqual(bare.expenses, {});

    const response = await post(
      management('managed', {
        expense: { description: 'Expense for E2E tests', items: [{ description: 'Some stuff', amount: 1000 }] },
        project: true,
      }),
    );
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.deepEqual(Object.keys(graph.actors).sort(), ['admin', 'hostAdmin']);
    assert.equal(graph.accounts.project.type, 'PROJECT');
    assert.equal(graph.expenses.pending.status, 'PENDING');
    assert.equal(graph.urls.projectNewExpense, `/${graph.accounts.project.slug}/expenses/new`);
    const [stored] = await sequelize.query<Record<string, unknown>>(
      `SELECT p."ParentCollectiveId" AS parent, p."HostCollectiveId" AS host, p."isActive" AS active,
        c.data->'policies' AS policies,
        ARRAY(SELECT m."MemberCollectiveId" FROM "Members" m
          WHERE m."CollectiveId" = c.id AND m.role = 'ADMIN' AND m."deletedAt" IS NULL) AS admins,
        e."FromCollectiveId" AS payee, e.amount AS amount, e.type AS type
      FROM "Collectives" p
      JOIN "Collectives" c ON c.id = p."ParentCollectiveId"
      JOIN "Expenses" e ON e.id = :expense
      WHERE p.id = :project`,
      {
        type: QueryTypes.SELECT,
        replacements: { project: graph.accounts.project.legacyId, expense: graph.expenses.pending.legacyId },
      },
    );
    assert.deepEqual(stored, {
      parent: graph.accounts.collective.legacyId,
      host: graph.accounts.host.legacyId,
      active: true,
      // The journey writes the expense policy; the recipe must not.
      policies: null,
      admins: [graph.actors.admin.legacyId],
      payee: graph.actors.admin.legacyId,
      amount: 1000,
      type: 'INVOICE',
    });
  });

  it('arranges vendors scoped and restricted as named, on hosts whose policy only the request sets', async () => {
    const vendorHost = (requestId: string, inputs: unknown) => ({
      attempt,
      requestId: `vendor-${requestId}`,
      recipe: 'vendor-host',
      inputs,
    });
    // A vendor is scoped to its own host or to Accounts that host holds, and only to Accounts the request arranges.
    for (const [requestId, inputs] of Object.entries({
      'unarranged-scope': { vendors: [{ label: 'a', usableWith: ['project'] }] },
      'foreign-scope': { otherHost: { admin: 'hostAdmin' }, vendors: [{ label: 'a', usableWith: ['otherHost'] }] },
      'missing-host': { vendors: [{ label: 'a', host: 'otherHost' }] },
      'duplicate-label': { vendors: [{ label: 'a' }, { label: 'a' }] },
      'unknown-policy': { useVendorPolicy: 'EVERYONE' },
    })) {
      assert.equal((await post(vendorHost(requestId, inputs))).status, 400, requestId);
    }

    const bare = await (await post(vendorHost('bare', {}))).json();
    assert.deepEqual(Object.keys(bare.actors).sort(), ['collectiveAdmin', 'hostAdmin']);
    assert.deepEqual(Object.keys(bare.accounts).sort(), ['collective', 'host']);
    assert.deepEqual(bare.vendors, {});

    const response = await post(
      vendorHost('graph', {
        useVendorPolicy: 'ALL_SUBMITTERS',
        grants: true,
        secondCollective: true,
        project: true,
        outsider: true,
        otherHost: { admin: 'otherHostAdmin', collective: true },
        vendors: [
          { label: 'everywhere' },
          {
            label: 'scoped',
            usableWith: ['collective', 'project'],
            useVendorPolicy: 'HOST_ADMINS',
            payoutMethod: true,
          },
          { label: 'foreign', host: 'otherHost', usableWith: ['otherCollective'] },
        ],
      }),
    );
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.deepEqual(Object.keys(graph.actors).sort(), [
      'collectiveAdmin',
      'hostAdmin',
      'otherCollectiveAdmin',
      'otherHostAdmin',
      'outsider',
    ]);
    const { host, collective, collective2, project, otherHost, otherCollective } = graph.accounts;
    assert.deepEqual(graph.urls, {
      hostedCollectives: `/dashboard/${host.slug}/hosted-collectives`,
      vendors: `/dashboard/${host.slug}/vendors`,
      expectedFunds: `/dashboard/${host.slug}/expected-funds`,
    });
    const stored = await sequelize.query<Record<string, unknown>>(
      `SELECT v.name, v.type, v."ParentCollectiveId" AS host, v."isActive" AS active,
        v.data->'canBeUsedWithAccountIds' AS scope, v.data->'useVendorPolicy' AS policy,
        h.data->'policies' AS "hostPolicies",
        (SELECT COUNT(*)::int FROM "PayoutMethods" p WHERE p."CollectiveId" = v.id AND p."isSaved") AS "payoutMethods",
        (SELECT COUNT(*)::int FROM "Activities" a WHERE a."CollectiveId" = h.id) AS activities
      FROM "Collectives" v JOIN "Collectives" h ON h.id = v."ParentCollectiveId"
      WHERE v.id IN (:vendors) ORDER BY v.id`,
      {
        type: QueryTypes.SELECT,
        replacements: { vendors: Object.values<{ legacyId: number }>(graph.vendors).map(v => v.legacyId) },
      },
    );
    const vendor = { type: 'VENDOR', active: false, activities: 0 };
    assert.deepEqual(stored, [
      {
        ...vendor,
        name: graph.vendors.everywhere.name,
        host: host.legacyId,
        scope: [],
        policy: null,
        hostPolicies: { USE_VENDOR_POLICY: 'ALL_SUBMITTERS' },
        payoutMethods: 0,
      },
      {
        ...vendor,
        name: graph.vendors.scoped.name,
        host: host.legacyId,
        scope: [collective.legacyId, project.legacyId],
        policy: 'HOST_ADMINS',
        hostPolicies: { USE_VENDOR_POLICY: 'ALL_SUBMITTERS' },
        payoutMethods: 1,
      },
      {
        ...vendor,
        name: graph.vendors.foreign.name,
        host: otherHost.legacyId,
        scope: [otherCollective.legacyId],
        policy: null,
        // The second host keeps the product default: the request named no policy for it.
        hostPolicies: null,
        payoutMethods: 0,
      },
    ]);
    // Names stay whole in pickers, which cut them off after about 35 characters.
    assert.ok(Object.values<{ name: string }>(graph.vendors).every(v => v.name.length <= 33));
    const [parties] = await sequelize.query<Record<string, unknown>>(
      `SELECT c."settings"->'expenseTypes' AS "expenseTypes",
        (SELECT "HostCollectiveId" FROM "Collectives" WHERE id = :collective2) AS "collective2Host",
        ARRAY(SELECT m."MemberCollectiveId" FROM "Members" m
          WHERE m."CollectiveId" = :otherHost AND m.role = 'ADMIN' AND m."deletedAt" IS NULL) AS "otherHostAdmins",
        (SELECT COUNT(*)::int FROM "Members" m
          WHERE m."MemberCollectiveId" = :outsider AND m."deletedAt" IS NULL) AS "outsiderRoles"
      FROM "Collectives" c WHERE c.id = :collective`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          collective: collective.legacyId,
          collective2: collective2.legacyId,
          otherHost: otherHost.legacyId,
          outsider: graph.actors.outsider.legacyId,
        },
      },
    );
    assert.deepEqual(parties, {
      expenseTypes: { GRANT: true },
      collective2Host: host.legacyId,
      otherHostAdmins: [graph.actors.otherHostAdmin.legacyId],
      outsiderRoles: 0,
    });

    // One person can administer both hosts.
    const shared = await (await post(vendorHost('shared-admin', { otherHost: { admin: 'hostAdmin' } }))).json();
    assert.deepEqual(Object.keys(shared.actors).sort(), ['collectiveAdmin', 'hostAdmin']);
    const [{ admins }] = await sequelize.query<{ admins: number[] }>(
      `SELECT ARRAY(SELECT m."MemberCollectiveId" FROM "Members" m
        WHERE m."CollectiveId" = :otherHost AND m.role = 'ADMIN' AND m."deletedAt" IS NULL) AS admins`,
      { type: QueryTypes.SELECT, replacements: { otherHost: shared.accounts.otherHost.legacyId } },
    );
    assert.deepEqual(admins, [shared.actors.hostAdmin.legacyId]);
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
