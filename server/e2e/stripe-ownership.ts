import { AsyncLocalStorage } from 'async_hooks';
import { createHash, randomUUID } from 'crypto';
import { EventEmitter } from 'events';

import config from 'config';
import type { Application, NextFunction, Request, Response } from 'express';
import { QueryTypes } from 'sequelize';
import type Stripe from 'stripe';
import type { z } from 'zod';

import logger from '../lib/logger';
import stripe from '../lib/stripe';
import { sequelize } from '../models';
import { setWebhookEventGate } from '../paymentProviders/stripe/webhook';

import { attemptSchema } from './recipes';

/**
 * Ownership of live Stripe test-mode resources in an owned E2E stack.
 *
 * Every E2E stack (local, each CI job, Cypress shards) forwards the same Stripe test account's Connect events
 * to its own API, with a genuine signature. A valid signature therefore says nothing about which stack, or
 * which test attempt, an event belongs to. This module, installed only by the guarded fixture hook:
 *
 * 1. records, per attempt, every Stripe object the API creates while serving that attempt's browser (the
 *    browser carries the attempt in the `oc_e2e_attempt` cookie), with its provider account;
 * 2. gates every received event before the mutating handlers: it reaches them only when one of the object IDs
 *    it references belongs to a live attempt of this stack. Objects Stripe.js creates in the browser (payment
 *    methods, mandates) become owned through the owned events that reference them;
 * 3. holds an event that references nothing known yet (it may have overtaken its registration) for a bounded
 *    time, then drops it as foreign; drops events of retired attempts; handles every event ID once.
 *
 * The records are a diagnostic and isolation ledger, never a cleanup list: Stripe records stay in place.
 */

const ATTEMPT_COOKIE = 'oc_e2e_attempt';
/** How long an event referencing nothing known yet waits for its registration. */
const holdMs = () => Number(process.env.E2E_STRIPE_HOLD_MS) || 15_000;
const RECHECK_MS = 1_000;
const RETIRE_QUIESCE_MS = 10_000;

type Attempt = z.infer<typeof attemptSchema>;
type AttemptContext = { key: string; attempt: Attempt };

const attemptContext = new AsyncLocalStorage<AttemptContext>();
const registrations = new EventEmitter().setMaxListeners(0);

const platformAccount = (): string => config.stripe.accountId;

const attemptKey = (ownerRunId: string, attempt: Attempt) =>
  createHash('sha256')
    .update(JSON.stringify(['stripe-attempt', ownerRunId, attempt]))
    .digest('hex');

const contextFor = (ownerRunId: string, raw: unknown): AttemptContext | null => {
  const parsed = attemptSchema.safeParse(raw);
  return parsed.success ? { key: attemptKey(ownerRunId, parsed.data), attempt: parsed.data } : null;
};

/** The cookie the browser of a Stripe journey carries: base64url JSON of its fixture attempt identity. */
const contextFromCookie = (ownerRunId: string, value: unknown): AttemptContext | null => {
  if (typeof value !== 'string' || value.length > 1000) {
    return null;
  }
  try {
    return contextFor(ownerRunId, JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
};

const STRIPE_ID = /^[a-z]+_[a-zA-Z0-9_]{6,}$/;
const REFERENCE_FIELDS = [
  'id',
  'customer',
  'payment_intent',
  'payment_method',
  'setup_intent',
  'latest_charge',
  'charge',
  'mandate',
];

/** Stripe object IDs a Stripe object (or an event's `data.object`) is, or points to. */
const referencedIds = (object: unknown): string[] => {
  const ids = new Set<string>();
  if (object && typeof object === 'object') {
    for (const field of REFERENCE_FIELDS) {
      const value = object[field];
      const id = typeof value === 'string' ? value : value && typeof value === 'object' ? value.id : null;
      if (typeof id === 'string' && STRIPE_ID.test(id)) {
        ids.add(id);
      }
    }
  }
  return [...ids];
};

async function initializeStripeOwnership(): Promise<void> {
  // Same lifecycle as `E2EFixtureRequests`: only in explicitly owned disposable databases, never cleaned up.
  await sequelize.query(`CREATE TABLE IF NOT EXISTS "E2EStripeAttempts" (
    "key" text PRIMARY KEY, "attempt" jsonb NOT NULL,
    "registeredAt" timestamptz NOT NULL DEFAULT now(), "retiredAt" timestamptz
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS "E2EStripeObjects" (
    "account" text NOT NULL, "externalId" text NOT NULL,
    "attemptKey" text NOT NULL REFERENCES "E2EStripeAttempts" ("key"), "source" text NOT NULL,
    "registeredAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("account", "externalId")
  )`);
  await sequelize.query(`CREATE TABLE IF NOT EXISTS "E2EStripeEvents" (
    "id" text PRIMARY KEY, "type" text NOT NULL, "account" text NOT NULL, "verdict" text NOT NULL,
    "attemptKey" text, "receivedAt" timestamptz NOT NULL DEFAULT now(), "decidedAt" timestamptz
  )`);
}

const registerAttempt = (context: AttemptContext) =>
  sequelize.query(
    `INSERT INTO "E2EStripeAttempts" ("key", "attempt") VALUES (:key, CAST(:attempt AS jsonb)) ON CONFLICT DO NOTHING`,
    { replacements: { key: context.key, attempt: JSON.stringify(context.attempt) } },
  );

/** Records `ids` on `account` as owned by the attempt. An ID keeps its first owner. */
export async function recordOwnedObjects(context: AttemptContext, account: string, ids: string[], source: string) {
  if (!ids.length) {
    return;
  }
  await registerAttempt(context);
  const [claimed] = await sequelize.query(
    `INSERT INTO "E2EStripeObjects" ("account", "externalId", "attemptKey", "source")
     SELECT :account, id, :key, :source FROM unnest(ARRAY[:ids]::text[]) AS id
     ON CONFLICT DO NOTHING RETURNING "externalId"`,
    { replacements: { account, ids, key: context.key, source } },
  );
  if ((claimed as unknown[]).length) {
    registrations.emit('registered');
  }
}

/** Creation calls whose results the attempt owns; reads and updates never claim anything. */
const RECORDED_METHODS = {
  customers: ['create'],
  paymentIntents: ['create', 'confirm'],
  setupIntents: ['create', 'confirm'],
  paymentMethods: ['create', 'attach'],
} as const;

const accountOf = (args: unknown[]): string => {
  const options = args.find(arg => arg && typeof arg === 'object' && 'stripeAccount' in arg) as
    { stripeAccount?: string } | undefined;
  return options?.stripeAccount || platformAccount();
};

let instrumented = false;
function instrumentStripeClient(): void {
  if (instrumented) {
    return;
  }
  instrumented = true;
  for (const [resource, methods] of Object.entries(RECORDED_METHODS)) {
    for (const method of methods) {
      const target = stripe[resource];
      const original = target[method];
      target[method] = async function (...args: unknown[]) {
        const result = await original.apply(this, args);
        const context = attemptContext.getStore();
        if (context) {
          await recordOwnedObjects(context, accountOf(args), referencedIds(result), `api:${resource}.${method}`);
        }
        return result;
      };
    }
  }
}

type Owner = { key: string; retired: boolean };

/** The attempt owning any of `ids` on `account`; `ambiguous` when they point to several attempts. */
async function findOwner(account: string, ids: string[]): Promise<Owner | 'ambiguous' | null> {
  if (!ids.length) {
    return null;
  }
  const owners = await sequelize.query<{ key: string; retired: boolean }>(
    `SELECT DISTINCT a."key", (a."retiredAt" IS NOT NULL OR EXISTS (
       SELECT 1 FROM "E2EStripeAttempts" later
       WHERE later."attempt"->>'runId' = a."attempt"->>'runId' AND later."attempt"->>'testId' = a."attempt"->>'testId'
         AND (later."attempt"->>'retry')::int > (a."attempt"->>'retry')::int
     )) AS "retired"
     FROM "E2EStripeObjects" o JOIN "E2EStripeAttempts" a ON a."key" = o."attemptKey"
     WHERE o."account" = :account AND o."externalId" IN (:ids)`,
    { replacements: { account, ids }, type: QueryTypes.SELECT },
  );
  return owners.length > 1 ? 'ambiguous' : owners[0] || null;
}

/** False when this event ID is already being handled or was handled. Unowned or failed events may be redelivered. */
async function claimEvent(event: Stripe.Event, account: string): Promise<boolean> {
  const [rows] = await sequelize.query(
    `INSERT INTO "E2EStripeEvents" ("id", "type", "account", "verdict") VALUES (:id, :type, :account, 'received')
     ON CONFLICT ("id") DO UPDATE SET "verdict" = 'received', "receivedAt" = now(), "decidedAt" = NULL
     WHERE "E2EStripeEvents"."verdict" IN ('unowned', 'failed') RETURNING "id"`,
    { replacements: { id: event.id, type: event.type, account } },
  );
  return (rows as unknown[]).length > 0;
}

const setVerdict = (event: Stripe.Event, verdict: string, key: string | null = null) =>
  sequelize.query(
    `UPDATE "E2EStripeEvents" SET "verdict" = :verdict, "attemptKey" = COALESCE(:key, "attemptKey"), "decidedAt" = now()
     WHERE "id" = :id`,
    { replacements: { id: event.id, verdict, key } },
  );

async function decide(
  event: Stripe.Event,
  account: string,
  ids: string[],
  owner: Owner | 'ambiguous',
  handle: () => Promise<unknown>,
) {
  if (owner === 'ambiguous') {
    logger.warn(`E2E Stripe gate: ${event.type} ${event.id} references objects of several attempts; dropped`);
    return setVerdict(event, 'ambiguous');
  } else if (owner.retired) {
    logger.info(`E2E Stripe gate: ${event.type} ${event.id} belongs to a retired attempt; dropped`);
    return setVerdict(event, 'retired', owner.key);
  }
  // Payment methods and mandates created by Stripe.js become owned through the owned events naming them.
  const [{ attempt }] = await sequelize.query<{ attempt: Attempt }>(
    `SELECT "attempt" FROM "E2EStripeAttempts" WHERE "key" = :key`,
    { replacements: { key: owner.key }, type: QueryTypes.SELECT },
  );
  await recordOwnedObjects({ key: owner.key, attempt }, account, ids, `event:${event.type}`);
  await setVerdict(event, 'processing', owner.key);
  try {
    const result = await handle();
    await setVerdict(event, 'processed');
    return result;
  } catch (error) {
    await setVerdict(event, 'failed');
    throw error;
  }
}

const nextRegistrationOrTimeout = (ms: number) =>
  new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      registrations.off('registered', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    registrations.once('registered', done);
  });

/** An event that may have overtaken its registration: decide once an owner appears, or drop it when the hold ends. */
async function holdAndReconcile(event: Stripe.Event, account: string, ids: string[], handle: () => Promise<unknown>) {
  const deadline = Date.now() + holdMs();
  while (Date.now() < deadline) {
    await nextRegistrationOrTimeout(Math.min(RECHECK_MS, deadline - Date.now()));
    const owner = await findOwner(account, ids);
    if (owner) {
      return decide(event, account, ids, owner, handle);
    }
  }
  logger.debug(`E2E Stripe gate: ${event.type} ${event.id} references no object of this stack; dropped`);
  return setVerdict(event, 'unowned');
}

/** The webhook gate: see the module comment. Resolves once the event is handled, dropped or put on hold. */
export async function gateStripeEvent(event: Stripe.Event, handle: () => Promise<unknown>): Promise<unknown> {
  if (typeof event?.id !== 'string') {
    return;
  }
  const account = event.account || platformAccount();
  const ids = referencedIds(event.data?.object);
  if (!(await claimEvent(event, account))) {
    logger.info(`E2E Stripe gate: duplicate delivery of ${event.type} ${event.id} ignored`);
    return;
  }
  const owner = await findOwner(account, ids);
  if (owner) {
    return decide(event, account, ids, owner, handle);
  }
  // Acknowledge now (a Stripe listener does not wait long) and keep holding in the background.
  holdAndReconcile(event, account, ids, handle).catch(error => {
    logger.error(`E2E Stripe gate: held ${event.type} ${event.id} failed: ${error.message}`);
  });
}

/** What an attempt owned and what happened to its events: attached to the test report as evidence. */
async function ownershipEvidence(key: string) {
  const objects = await sequelize.query(
    `SELECT "account", "externalId", "source" FROM "E2EStripeObjects" WHERE "attemptKey" = :key ORDER BY "registeredAt"`,
    { replacements: { key }, type: QueryTypes.SELECT },
  );
  const events = await sequelize.query(
    `SELECT "id", "type", "verdict" FROM "E2EStripeEvents" WHERE "attemptKey" = :key ORDER BY "receivedAt"`,
    { replacements: { key }, type: QueryTypes.SELECT },
  );
  return { attemptKey: key, objects, events };
}

/** Retires the attempt: later events of its objects are dropped. Waits (bounded) for its in-flight events. */
export async function retireAttempt(context: AttemptContext) {
  await registerAttempt(context);
  await sequelize.query(
    `UPDATE "E2EStripeAttempts" SET "retiredAt" = COALESCE("retiredAt", now()) WHERE "key" = :key`,
    {
      replacements: { key: context.key },
    },
  );
  const deadline = Date.now() + RETIRE_QUIESCE_MS;
  for (;;) {
    const [{ count }] = await sequelize.query<{ count: number }>(
      `SELECT count(*)::int AS "count" FROM "E2EStripeEvents" WHERE "attemptKey" = :key AND "verdict" = 'processing'`,
      { replacements: { key: context.key }, type: QueryTypes.SELECT },
    );
    if (!count || Date.now() > deadline) {
      return { ...(await ownershipEvidence(context.key)), inFlight: count };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const PROBE_HOST_SLUG = 'e2e-host';

/**
 * Launcher readiness for Stripe journeys: test-mode configuration, a signing secret, a suitable shared host
 * connection, and the owned event path end to end. It creates one customer on the host's connected account as
 * a probe attempt and waits until Stripe's signed `customer.created` event for it went through the gate.
 */
async function probeStripe(ownerRunId: string, timeoutMs: number) {
  if (!/^(sk|rk)_test_/.test(config.stripe.secret || '')) {
    return {
      status: 412,
      code: 'STRIPE_NOT_TEST_MODE',
      message: 'The API Stripe secret is missing or not a test key.',
    };
  }
  if (!/^whsec_/.test(config.stripe.webhookSigningSecret || '')) {
    return {
      status: 412,
      code: 'STRIPE_SIGNING_SECRET_MISSING',
      message: 'STRIPE_WEBHOOK_SIGNING_SECRET is not set: start the API with the listener signing secret.',
    };
  }
  const [connection] = await sequelize.query<{ account: string }>(
    `SELECT ca."username" AS "account" FROM "ConnectedAccounts" ca JOIN "Collectives" c ON c."id" = ca."CollectiveId"
     WHERE c."slug" = :slug AND ca."service" = 'stripe' AND ca."deletedAt" IS NULL AND c."deletedAt" IS NULL LIMIT 1`,
    { replacements: { slug: PROBE_HOST_SLUG }, type: QueryTypes.SELECT },
  );
  if (!connection?.account) {
    return {
      status: 412,
      code: 'STRIPE_HOST_MISSING',
      message: `Seeded host ${PROBE_HOST_SLUG} has no Stripe connection.`,
    };
  }
  const context = contextFor(ownerRunId, {
    runId: ownerRunId,
    testId: 'stripe-webhook-probe',
    retry: 0,
    workerIndex: 0,
    nonce: randomUUID(),
  });
  const startedAt = Date.now();
  const customer = await attemptContext.run(context, () =>
    stripe.customers.create({ description: 'Playwright E2E webhook probe' }, { stripeAccount: connection.account }),
  );
  while (Date.now() - startedAt < timeoutMs) {
    const [event] = await sequelize.query<{ id: string }>(
      `SELECT "id" FROM "E2EStripeEvents" WHERE "attemptKey" = :key AND "verdict" = 'processed' LIMIT 1`,
      { replacements: { key: context.key }, type: QueryTypes.SELECT },
    );
    if (event) {
      await retireAttempt(context);
      return {
        status: 200,
        account: connection.account,
        customer: customer.id,
        event: event.id,
        deliveredMs: Date.now() - startedAt,
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await retireAttempt(context);
  const [{ received }] = await sequelize.query<{ received: number }>(
    `SELECT count(*)::int AS "received" FROM "E2EStripeEvents" WHERE "receivedAt" > now() - interval '5 minutes'`,
    { type: QueryTypes.SELECT },
  );
  return {
    status: 504,
    code: 'STRIPE_WEBHOOK_UNDELIVERED',
    message:
      `No signed customer.created event for probe customer ${customer.id} reached this API within ${timeoutMs} ms ` +
      `(${received} signed events received in the last 5 minutes). Check the Stripe listener forwards Connect events ` +
      `to this API's /webhooks/stripe and that the API runs with that listener's signing secret.`,
  };
}

/**
 * Installs the gate, the attempt context and the two Stripe routes. Called by `installE2EFixtures` only, after
 * it verified the launcher's ownership proof; `authorized` is its bearer-token check.
 */
// Dynamically loaded by the guarded E2E fixture hook.
// ts-unused-exports:disable-next-line
export async function installStripeOwnership(
  app: Application,
  ownerRunId: string,
  authorized: (req: Request, res: Response) => boolean,
): Promise<void> {
  await initializeStripeOwnership();
  instrumentStripeClient();
  setWebhookEventGate(gateStripeEvent);

  app.use((req: Request, res: Response, next: NextFunction) => {
    const context = contextFromCookie(ownerRunId, req.cookies?.[ATTEMPT_COOKIE]);
    return context ? attemptContext.run(context, next) : next();
  });

  app.post('/e2e/stripe/attempts/retire', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authorized(req, res)) {
      return;
    }
    const context = contextFor(ownerRunId, req.body?.attempt);
    if (!context) {
      res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Provide the complete attempt identity.' } });
      return;
    }
    res.json(await retireAttempt(context));
  });

  app.post('/e2e/stripe/probe', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!authorized(req, res)) {
      return;
    }
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeoutMs) || 60_000, 1_000), 120_000);
    try {
      const { status, ...result } = await probeStripe(ownerRunId, timeoutMs);
      res.status(status).json(status === 200 ? result : { error: result });
    } catch (error) {
      res.status(502).json({ error: { code: 'STRIPE_PROVIDER_ERROR', message: error.message } });
    }
  });
}
