import { createHash } from 'crypto';

import { QueryTypes, ValidationError } from 'sequelize';
import { z } from 'zod';

import { CollectiveType } from '../constants/collectives';
import { createAccountAdminMembers } from '../lib/account-admins';
import { TOKEN_EXPIRATION_SESSION } from '../lib/auth';
import { Collective, sequelize, User } from '../models';

const identifier = z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/);
const requestSchema = z
  .object({
    attempt: z
      .object({
        runId: identifier,
        testId: identifier,
        retry: z.number().int().min(0).max(1),
        workerIndex: z.number().int().nonnegative(),
        nonce: z.string().uuid(),
      })
      .strict(),
    requestId: identifier,
    recipe: z.enum(['account-profile', 'account-conversation']),
    inputs: z.object({ name: z.string().trim().min(1).max(1000) }).strict(),
  })
  .strict();

class FixtureError extends Error {
  constructor(
    public status: number,
    public code: string,
    public safeMessage: string,
  ) {
    super(safeMessage);
  }
}

// Dynamically loaded by the guarded E2E route.
// ts-unused-exports:disable-next-line
export async function initializeFixtures(database: string): Promise<void> {
  const [{ actual }] = await sequelize.query<{ actual: string }>('SELECT current_database() AS actual', {
    type: QueryTypes.SELECT,
  });
  if (actual !== database) {
    throw new Error('Fixture database does not match launcher ownership.');
  }
  // This table only exists in explicitly owned disposable databases. It is a
  // durable idempotency receipt, never a deletion/cleanup registry.
  await sequelize.query(`CREATE TABLE IF NOT EXISTS "E2EFixtureRequests" (
    "key" text PRIMARY KEY, "payload" jsonb NOT NULL, "result" jsonb NOT NULL,
    "createdAt" timestamptz NOT NULL DEFAULT now()
  )`);
}

// ts-unused-exports:disable-next-line
export async function arrangeFixture(ownerRunId: string, body: unknown, disconnected: () => boolean) {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    throw new FixtureError(
      400,
      'INVALID_REQUEST',
      'Provide a named recipe, valid inputs, requestId and complete attempt identity.',
    );
  }
  const request = parsed.data;
  const key = createHash('sha256')
    .update(JSON.stringify([ownerRunId, request.attempt, request.requestId]))
    .digest('hex');
  const payload = JSON.stringify({ recipe: request.recipe, inputs: request.inputs });
  const slug = `pw-${key.slice(0, 32)}`;
  const checkConnection = () => {
    if (disconnected()) {
      throw new FixtureError(
        499,
        'SETUP_INTERRUPTED',
        'Fixture setup interrupted and rolled back; retry the same request.',
      );
    }
  };
  try {
    return await sequelize.transaction(async transaction => {
      // Bound waits and serialize the same request across API processes. Different
      // requests retain independent locks; the receipt and domain writes commit together.
      await sequelize.query("SELECT set_config('application_name', :name, true)", {
        replacements: { name: `e2e-fixture-${key.slice(0, 32)}` },
        transaction,
      });
      await sequelize.query("SET LOCAL lock_timeout = '15s'", { transaction });
      await sequelize.query("SET LOCAL statement_timeout = '20s'", { transaction });
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))', {
        replacements: { key },
        transaction,
      });
      const [receipt] = await sequelize.query<{ matches: boolean; result: unknown }>(
        'SELECT "payload" = CAST(:payload AS jsonb) AS matches, "result" FROM "E2EFixtureRequests" WHERE "key" = :key',
        { replacements: { key, payload }, transaction, type: QueryTypes.SELECT },
      );
      if (receipt) {
        if (!receipt.matches) {
          throw new FixtureError(
            409,
            'REQUEST_CONFLICT',
            'This request identity already committed different recipe inputs. Use a new requestId.',
          );
        }
        return receipt.result;
      }
      checkConnection();
      const user = await User.createUserWithCollective(
        {
          email: `testuser+${slug}@opencollective.com`,
          name: `Fixture admin ${key.slice(0, 12)}`,
          slug: `${slug}-admin`,
          data: { requiresProfileCompletion: false },
        },
        transaction,
      );
      checkConnection();
      const account = await Collective.create(
        {
          type: CollectiveType.COLLECTIVE,
          name: request.inputs.name,
          slug,
          description: 'An independent Playwright scenario',
          currency: 'USD',
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          isActive: false,
          settings: { features: { conversations: request.recipe === 'account-conversation' } },
          data: { e2eAttempt: request.attempt, e2eRequestId: request.requestId },
        },
        { transaction },
      );
      checkConnection();
      await createAccountAdminMembers(account, [user], { transaction });
      // These handles are safe to return only after commit. Session auth avoids
      // global sign-in rate counters and tokens in browser navigation URLs.
      const result = {
        recipe: request.recipe,
        attempt: request.attempt,
        requestId: request.requestId,
        account: { id: account.publicId, slug: account.slug, name: account.name },
        user: { id: user.collective.publicId, email: user.email, slug: user.collective.slug },
        urls: {
          profile: `/${slug}`,
          info: `/dashboard/${slug}/info`,
          conversations: `/${slug}/conversations`,
          newConversation: `/${slug}/conversations/new`,
        },
        auth: { token: user.jwt({ scope: 'session' }, TOKEN_EXPIRATION_SESSION) },
      };
      await sequelize.query(
        'INSERT INTO "E2EFixtureRequests" ("key", "payload", "result") VALUES (:key, CAST(:payload AS jsonb), CAST(:result AS jsonb))',
        {
          replacements: { key, payload, result: JSON.stringify(result) },
          transaction,
        },
      );
      checkConnection();
      return result;
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new FixtureError(
        422,
        'INVALID_PREREQUISITE',
        `Account validation failed (${error.errors.map(e => e.path).join(', ')}). Setup rolled back.`,
      );
    }
    throw error;
  }
}
