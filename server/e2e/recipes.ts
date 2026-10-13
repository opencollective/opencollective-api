import { createHash } from 'crypto';

import { QueryTypes, ValidationError } from 'sequelize';
import { z } from 'zod';

import { CollectiveType } from '../constants/collectives';
import { createAccountAdminMembers } from '../lib/account-admins';
import { TOKEN_EXPIRATION_SESSION } from '../lib/auth';
import { Collective, sequelize, User } from '../models';

import { defineRecipe, type Recipe } from './builders';
import { expenseRecipes } from './expense-recipes';
import { vendorRecipes } from './vendor-recipes';

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
    recipe: z.string(),
    inputs: z.unknown(),
  })
  .strict();

/** One user administering one unhosted Account: no host or payment graph. */
const accountRecipe = (conversations: boolean) =>
  defineRecipe({
    inputs: z.object({ name: z.string().trim().min(1).max(1000) }).strict(),
    build: async (ctx, inputs) => {
      const { transaction } = ctx;
      const slug = `pw-${ctx.key.slice(0, 32)}`;
      const user = await User.createUserWithCollective(
        {
          email: `testuser+${slug}@opencollective.com`,
          name: `Fixture admin ${ctx.key.slice(0, 12)}`,
          slug: `${slug}-admin`,
          data: { requiresProfileCompletion: false },
        },
        transaction,
      );
      ctx.checkConnection();
      const account = await Collective.create(
        {
          type: CollectiveType.COLLECTIVE,
          name: inputs.name,
          slug,
          description: 'An independent Playwright scenario',
          currency: 'USD',
          HostCollectiveId: null,
          CreatedByUserId: user.id,
          isActive: false,
          settings: { features: { conversations } },
          data: { e2eAttempt: ctx.attempt, e2eRequestId: ctx.requestId },
        },
        { transaction },
      );
      ctx.checkConnection();
      await createAccountAdminMembers(account, [user], { transaction });
      return {
        account: { id: account.publicId, slug: account.slug, name: account.name },
        user: { id: user.collective.publicId, email: user.email, slug: user.collective.slug },
        urls: {
          profile: `/${slug}`,
          info: `/dashboard/${slug}/info`,
          conversations: `/${slug}/conversations`,
          newConversation: `/${slug}/conversations/new`,
        },
        // Session auth avoids global sign-in rate counters and tokens in browser
        // navigation URLs. Only safe to return after commit.
        auth: { token: user.jwt({ scope: 'session' }, TOKEN_EXPIRATION_SESSION) },
      };
    },
  });

// Add a recipe by registering it here and describing its inputs in the frontend transport.
const recipes: Record<string, Recipe> = {
  'account-profile': accountRecipe(false),
  'account-conversation': accountRecipe(true),
  ...expenseRecipes,
  ...vendorRecipes,
};

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
  const recipe = parsed.success && Object.hasOwn(recipes, parsed.data.recipe) ? recipes[parsed.data.recipe] : null;
  const inputs = recipe?.inputs.safeParse(parsed.data.inputs);
  if (!parsed.success || !inputs?.success) {
    throw new FixtureError(
      400,
      'INVALID_REQUEST',
      'Provide a named recipe, valid inputs, requestId and complete attempt identity.',
    );
  }
  const request = { ...parsed.data, inputs: inputs.data };
  const key = createHash('sha256')
    .update(JSON.stringify([ownerRunId, request.attempt, request.requestId]))
    .digest('hex');
  const payload = JSON.stringify({ recipe: request.recipe, inputs: request.inputs });
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
      const references = await recipe.build(
        {
          transaction,
          key,
          attempt: request.attempt,
          requestId: request.requestId,
          slug: label => `pw-${key.slice(0, 24)}-${label}`,
          tag: key.slice(0, 12),
          checkConnection,
        },
        request.inputs,
      );
      // The receipt commits with the prerequisites, so handles are only ever
      // returned for a graph that exists.
      const result = { recipe: request.recipe, attempt: request.attempt, requestId: request.requestId, ...references };
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
        `Prerequisite validation failed (${error.errors.map(e => e.path).join(', ')}). Setup rolled back.`,
      );
    }
    throw error;
  }
}
