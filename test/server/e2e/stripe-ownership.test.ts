/* eslint-disable camelcase */
import { randomUUID } from 'crypto';

import { expect } from 'chai';
import config from 'config';
import cookieParser from 'cookie-parser';
import express from 'express';
import type { AddressInfo } from 'net';
import { QueryTypes } from 'sequelize';
import { createSandbox } from 'sinon';
import type Stripe from 'stripe';

import {
  gateStripeEvent,
  installStripeOwnership,
  probeStripeRoute,
  recordOwnedObjects,
  retireAttempt,
  retireAttemptRoute,
} from '../../../server/e2e/stripe-ownership';
import stripe from '../../../server/lib/stripe';
import models, { sequelize } from '../../../server/models';
import * as webhook from '../../../server/paymentProviders/stripe/webhook';
import { fakeCollective, fakeConnectedAccount } from '../../test-helpers/fake-data';
import * as utils from '../../utils';

const OWNER_RUN = 'run-ownership-test';
const HOST_ACCOUNT = 'acct_1HostOwnershipTest';

const attemptOf = (testId: string, retry = 0) => {
  const attempt = { runId: 'run-pw-test', testId, retry, workerIndex: 0, nonce: randomUUID() };
  return { attempt, key: `key-${testId}-${retry}-${attempt.nonce}` };
};

let eventCount = 0;
const eventFor = (type: string, object: Record<string, unknown>, account: string = HOST_ACCOUNT) =>
  ({
    id: `evt_test${++eventCount}${randomUUID().slice(0, 8)}`,
    type,
    account,
    data: { object },
  }) as unknown as Stripe.Event;

const verdictOf = async (event: Stripe.Event) => {
  const [row] = await sequelize.query<{ verdict: string }>(`SELECT "verdict" FROM "E2EStripeEvents" WHERE "id" = :id`, {
    replacements: { id: event.id },
    type: QueryTypes.SELECT,
  });
  return row?.verdict;
};

const waitForVerdict = async (event: Stripe.Event, expected: string) => {
  for (let tries = 0; tries < 100; tries++) {
    if ((await verdictOf(event)) === expected) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${event.id} never reached ${expected} (is ${await verdictOf(event)})`);
};

describe('server/e2e/stripe-ownership', () => {
  const sandbox = createSandbox();
  let server: ReturnType<express.Express['listen']>;
  let baseUrl: string;

  before(async () => {
    await utils.resetTestDB();
    process.env.E2E_STRIPE_HOLD_MS = '1500';
    // The probe and SDK instrumentation must never reach Stripe from unit tests.
    sandbox
      .stub(stripe.customers, 'create')
      .callsFake(async () => ({ id: `cus_${randomUUID().replace(/-/g, '').slice(0, 14)}` }));
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    await installStripeOwnership(app, OWNER_RUN);
    // As `installE2EFixtures` mounts them, minus its bearer-token check
    for (const [path, route] of [
      ['/e2e/stripe/attempts/retire', retireAttemptRoute],
      ['/e2e/stripe/probe', probeStripeRoute],
    ] as const) {
      app.post(path, async (req, res) => {
        const { status, body } = await route(OWNER_RUN, req.body);
        res.status(status).json(body);
      });
    }
    app.post('/create-customer', async (req, res) => {
      res.json(await stripe.customers.create({}, { stripeAccount: HOST_ACCOUNT }));
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    webhook.setWebhookEventGate(null);
    delete process.env.E2E_STRIPE_HOLD_MS;
    sandbox.restore();
    server.close();
    await sequelize.query(`DROP TABLE "E2EStripeEvents", "E2EStripeObjects", "E2EStripeAttempts"`);
  });

  beforeEach(async () => {
    await sequelize.query(`TRUNCATE "E2EStripeEvents", "E2EStripeObjects", "E2EStripeAttempts"`);
  });

  const handler = () => {
    const calls: string[] = [];
    return { calls, handle: (event: Stripe.Event) => () => Promise.resolve(calls.push(event.id)) };
  };

  it('lets an event about an owned object reach the handler, and owns what it references', async () => {
    const attempt = attemptOf('owned');
    await recordOwnedObjects(attempt, HOST_ACCOUNT, ['pi_ownedIntent1'], 'test');
    const { calls, handle } = handler();
    const succeeded = eventFor('payment_intent.succeeded', {
      id: 'pi_ownedIntent1',
      payment_method: 'pm_fromBrowser1',
    });
    await gateStripeEvent(succeeded, handle(succeeded));
    expect(calls).to.deep.equal([succeeded.id]);
    expect(await verdictOf(succeeded)).to.equal('processed');

    // A mandate names only the payment method Stripe.js created: owned through the event above
    const mandate = eventFor('mandate.updated', { id: 'mandate_owned1', payment_method: 'pm_fromBrowser1' });
    await gateStripeEvent(mandate, handle(mandate));
    expect(calls).to.deep.equal([succeeded.id, mandate.id]);
  });

  it('drops foreign events after the bounded hold, without reaching the handler', async () => {
    await recordOwnedObjects(attemptOf('other'), HOST_ACCOUNT, ['cus_ourCustomer1'], 'test');
    const { calls, handle } = handler();
    const foreign = [
      eventFor('payment_method.attached', { id: 'pm_foreign1', customer: 'cus_foreignCustomer1' }),
      eventFor('mandate.updated', { id: 'mandate_foreign1', payment_method: 'pm_foreign2' }),
      // Our customer ID on another provider account is still not ours
      eventFor('payment_method.attached', { id: 'pm_foreign3', customer: 'cus_ourCustomer1' }, 'acct_1SomeoneElse'),
      eventFor('issuing_authorization.request', { id: 'iauth_foreign1', card: 'ic_foreign1' }),
    ];
    for (const event of foreign) {
      await gateStripeEvent(event, handle(event));
    }
    for (const event of foreign) {
      await waitForVerdict(event, 'unowned');
    }
    expect(calls).to.be.empty;
  });

  it('holds an event that arrives before its registration, then handles it', async () => {
    const { calls, handle } = handler();
    const early = eventFor('payment_method.attached', { id: 'pm_earlyMethod1', customer: 'cus_lateCustomer1' });
    await gateStripeEvent(early, handle(early));
    expect(calls).to.be.empty;
    await recordOwnedObjects(attemptOf('late'), HOST_ACCOUNT, ['cus_lateCustomer1'], 'test');
    await waitForVerdict(early, 'processed');
    expect(calls).to.deep.equal([early.id]);
  });

  it('handles a duplicate delivery once', async () => {
    await recordOwnedObjects(attemptOf('duplicate'), HOST_ACCOUNT, ['pi_duplicated1'], 'test');
    const { calls, handle } = handler();
    const event = eventFor('payment_intent.processing', { id: 'pi_duplicated1' });
    await Promise.all([gateStripeEvent(event, handle(event)), gateStripeEvent(event, handle(event))]);
    await gateStripeEvent(event, handle(event));
    expect(calls).to.deep.equal([event.id]);
  });

  it('lets a failed event be redelivered', async () => {
    await recordOwnedObjects(attemptOf('failing'), HOST_ACCOUNT, ['pi_failing1'], 'test');
    const event = eventFor('payment_intent.succeeded', { id: 'pi_failing1' });
    await expect(gateStripeEvent(event, () => Promise.reject(new Error('handler failed')))).to.be.rejectedWith(
      'handler failed',
    );
    expect(await verdictOf(event)).to.equal('failed');
    const { calls, handle } = handler();
    await gateStripeEvent(event, handle(event));
    expect(calls).to.deep.equal([event.id]);
  });

  it('drops late events of a retired attempt and of an attempt its retry replaced', async () => {
    const retired = attemptOf('retired');
    await recordOwnedObjects(retired, HOST_ACCOUNT, ['pi_retired1'], 'test');
    const evidence = await retireAttempt(retired);
    expect(evidence.objects).to.deep.equal([{ account: HOST_ACCOUNT, externalId: 'pi_retired1', source: 'test' }]);

    const first = attemptOf('retried', 0);
    const retry = { ...attemptOf('retried', 1), attempt: { ...first.attempt, retry: 1, nonce: randomUUID() } };
    retry.key = `${first.key}-retry`;
    await recordOwnedObjects(first, HOST_ACCOUNT, ['pi_firstAttempt1'], 'test');
    await recordOwnedObjects(retry, HOST_ACCOUNT, ['pi_retryAttempt1'], 'test');

    const { calls, handle } = handler();
    const late = eventFor('payment_intent.succeeded', { id: 'pi_retired1' });
    const stale = eventFor('payment_intent.succeeded', { id: 'pi_firstAttempt1' });
    const current = eventFor('payment_intent.succeeded', { id: 'pi_retryAttempt1' });
    for (const event of [late, stale, current]) {
      await gateStripeEvent(event, handle(event));
    }
    expect(calls).to.deep.equal([current.id]);
    expect(await verdictOf(late)).to.equal('retired');
    expect(await verdictOf(stale)).to.equal('retired');
  });

  it('keeps concurrent attempts apart', async () => {
    const [a, b] = [attemptOf('concurrent-a'), attemptOf('concurrent-b')];
    await Promise.all([
      recordOwnedObjects(a, HOST_ACCOUNT, ['cus_concurrentA1'], 'test'),
      recordOwnedObjects(b, HOST_ACCOUNT, ['cus_concurrentB1'], 'test'),
    ]);
    await retireAttempt(a);
    const { calls, handle } = handler();
    const ofA = eventFor('payment_method.attached', { id: 'pm_concurrentA1', customer: 'cus_concurrentA1' });
    const ofB = eventFor('payment_method.attached', { id: 'pm_concurrentB1', customer: 'cus_concurrentB1' });
    // An object first claimed by B cannot be taken over by A's later events
    const mixed = eventFor('charge.succeeded', {
      id: 'ch_mixed1',
      customer: 'cus_concurrentB1',
      payment_intent: 'pi_mixedIntent1',
    });
    await recordOwnedObjects(a, HOST_ACCOUNT, ['pi_mixedIntent1'], 'test');
    await Promise.all([ofA, ofB, mixed].map(event => gateStripeEvent(event, handle(event))));
    expect(calls).to.deep.equal([ofB.id]);
    expect(await verdictOf(mixed)).to.equal('ambiguous');
  });

  describe('through the webhook endpoint', () => {
    beforeEach(() => {
      sandbox.stub(stripe.webhooks, 'constructEvent').callsFake(body => JSON.parse(body as string));
    });
    afterEach(() => {
      (stripe.webhooks.constructEvent as unknown as { restore: () => void }).restore();
    });

    const deliver = (event: Stripe.Event) =>
      webhook.webhook({ body: event, rawBody: JSON.stringify(event), headers: { 'stripe-signature': 'sig' } } as never);

    it('stops foreign attachment and mandate events before they create payment methods', async () => {
      const contributor = await fakeCollective();
      // A Stripe customer mapping as a seeded dump shares it with every stack
      await fakeConnectedAccount({
        service: 'stripe_customer',
        clientId: HOST_ACCOUNT,
        username: 'cus_sharedSeed1',
        CollectiveId: contributor.id,
      });
      const retrieve = sandbox.stub(stripe.paymentMethods, 'retrieve');
      const attached = eventFor('payment_method.attached', {
        id: 'pm_foreignSepa1',
        type: 'sepa_debit',
        customer: 'cus_sharedSeed1',
        sepa_debit: { last4: '3000' },
      });
      const mandate = eventFor('mandate.updated', { id: 'mandate_foreign2', payment_method: 'pm_foreignSepa2' });
      await deliver(attached);
      await deliver(mandate);
      await waitForVerdict(attached, 'unowned');
      await waitForVerdict(mandate, 'unowned');
      expect(retrieve.called).to.be.false;
      expect(await models.PaymentMethod.count({ where: { CollectiveId: contributor.id, service: 'stripe' } })).to.equal(
        0,
      );
      retrieve.restore();
    });

    it('lets an owned attachment through to its handler', async () => {
      const contributor = await fakeCollective();
      await fakeConnectedAccount({
        service: 'stripe_customer',
        clientId: HOST_ACCOUNT,
        username: 'cus_ownedAch1',
        CollectiveId: contributor.id,
      });
      await recordOwnedObjects(attemptOf('ach'), HOST_ACCOUNT, ['cus_ownedAch1'], 'test');
      await deliver(
        eventFor('payment_method.attached', {
          id: 'pm_ownedAch1',
          type: 'us_bank_account',
          customer: 'cus_ownedAch1',
          us_bank_account: { bank_name: 'STRIPE TEST BANK', last4: '6789' },
        }),
      );
      expect(await models.PaymentMethod.count({ where: { CollectiveId: contributor.id, service: 'stripe' } })).to.equal(
        1,
      );
    });
  });

  describe('routes', () => {
    const cookie = (attempt: Record<string, unknown>) =>
      `oc_e2e_attempt=${Buffer.from(JSON.stringify(attempt)).toString('base64url')}`;

    it('records what the API creates for the attempt named by the browser cookie, and reports it on retirement', async () => {
      const { attempt } = attemptOf('cookie');
      const created = await fetch(`${baseUrl}/create-customer`, {
        method: 'POST',
        headers: { Cookie: cookie(attempt) },
      });
      const customer = await created.json();
      const anonymous = await (await fetch(`${baseUrl}/create-customer`, { method: 'POST' })).json();

      const retired = await fetch(`${baseUrl}/e2e/stripe/attempts/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attempt }),
      });
      const evidence = await retired.json();
      expect(evidence.objects).to.deep.equal([
        { account: HOST_ACCOUNT, externalId: customer.id, source: 'api:customers.create' },
      ]);
      const [{ count }] = await sequelize.query<{ count: number }>(
        `SELECT count(*)::int AS "count" FROM "E2EStripeObjects" WHERE "externalId" = :id`,
        { replacements: { id: anonymous.id }, type: QueryTypes.SELECT },
      );
      expect(count).to.equal(0);
    });

    it('fails the probe before touching Stripe without a listener signing secret', async () => {
      expect(config.stripe.webhookSigningSecret).to.not.match(/^whsec_/);
      const calls = (stripe.customers.create as unknown as { callCount: number }).callCount;
      const response = await fetch(`${baseUrl}/e2e/stripe/probe`, { method: 'POST' });
      expect(response.status).to.equal(412);
      expect((await response.json()).error.code).to.equal('STRIPE_SIGNING_SECRET_MISSING');
      expect((stripe.customers.create as unknown as { callCount: number }).callCount).to.equal(calls);
    });
  });
});
