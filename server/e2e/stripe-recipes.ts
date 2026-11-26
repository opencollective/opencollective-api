import { ValidationError, type ValidationErrorItem } from 'sequelize';
import { z } from 'zod';

import { Service } from '../constants/connected-account';
import expenseStatus from '../constants/expense-status';
import expenseType from '../constants/expense-type';
import { Collective, ConnectedAccount, Expense, ExpenseItem, PayoutMethod, User } from '../models';
import { PayoutMethodTypes } from '../models/PayoutMethod';

import {
  accountHandle,
  actorHandle,
  createActor,
  createHost,
  createHostedCollective,
  defineRecipe,
  expenseHandle,
  type Recipe,
} from './builders';

/** Read-only use of seed data: the shared Stripe test connections live on these seeded accounts. */
const SEEDED_STRIPE_HOSTS = ['e2e-host', 'e2e-eur-host'] as const;
const SEEDED_STRIPE_PAYEE = { slug: 'ofitech', adminEmail: 'testuser+ofitech@opencollective.com' };

/** Answered as `INVALID_PREREQUISITE`, naming `path`, like a failed model validation. */
const unsuitable = (message: string, path: string) =>
  new ValidationError(message, [{ message, path } as ValidationErrorItem]);

/**
 * A seeded host whose Stripe connection journeys may share: a connected account with a publishable key. Shared
 * means read-only here: no recipe changes its configuration, and journeys never assert its balances.
 */
async function sharedStripeHost(slug: string, transaction): Promise<Collective> {
  const host = await Collective.findOne({ where: { slug }, transaction });
  const connection =
    host &&
    (await ConnectedAccount.findOne({ where: { CollectiveId: host.id, service: Service.STRIPE }, transaction }));
  if (!host?.hasMoneyManagement || !connection?.username?.startsWith('acct_') || !connection.data?.publishableKey) {
    throw unsuitable(`Seeded host ${slug} has no usable Stripe connection`, 'stripeConnection');
  }
  return host;
}

export const stripeRecipes: Record<string, Recipe> = {
  /**
   * A Collective of this request, hosted by a seeded host with a shared Stripe test connection (`e2e-host`, USD,
   * or `e2e-eur-host`, EUR), and a `contributor` with no payment method yet. Contributing is the journey.
   */
  'stripe-contribution': defineRecipe({
    inputs: z.object({ host: z.enum(SEEDED_STRIPE_HOSTS).default('e2e-host') }).strict(),
    build: async (ctx, inputs) => {
      const host = await sharedStripeHost(inputs.host, ctx.transaction);
      const collectiveAdmin = await createActor(ctx, 'collective-admin');
      const contributor = await createActor(ctx, 'contributor');
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: collectiveAdmin,
        admins: [collectiveAdmin],
      });
      return {
        actors: { contributor: actorHandle(contributor), collectiveAdmin: actorHandle(collectiveAdmin) },
        accounts: { host: accountHandle(host), collective: accountHandle(collective) },
        expenses: {},
        urls: {
          donate: `/${collective.slug}/donate`,
          transactions: `/${collective.slug}/transactions`,
          orders: `/${collective.slug}/orders`,
        },
      };
    },
  }),

  /**
   * A host of this request (admin `hostAdmin`) owing a pending $10 settlement expense to the seeded `ofitech`,
   * whose payout method is its shared Stripe connection. Approving and paying it with a card is the journey.
   */
  'stripe-settlement-expense': defineRecipe({
    inputs: z.object({}).strict(),
    build: async ctx => {
      const { transaction } = ctx;
      const payee = await Collective.findOne({ where: { slug: SEEDED_STRIPE_PAYEE.slug }, transaction });
      const payeeAdmin = await User.findOne({ where: { email: SEEDED_STRIPE_PAYEE.adminEmail }, transaction });
      const payoutMethod =
        payee &&
        (await PayoutMethod.findOne({
          where: { CollectiveId: payee.id, type: PayoutMethodTypes.STRIPE, isSaved: true },
          transaction,
        }));
      if (!payee || !payeeAdmin || !payoutMethod) {
        throw unsuitable('Seeded payee ofitech has no Stripe payout method or admin', 'stripePayoutMethod');
      }
      await sharedStripeHost(payee.slug, transaction);

      const hostAdmin = await createActor(ctx, 'host-admin');
      const host = await createHost(ctx, hostAdmin);
      ctx.checkConnection();
      const expense = await Expense.create(
        {
          type: expenseType.SETTLEMENT,
          status: expenseStatus.PENDING,
          description: `Settlement ${ctx.tag}`,
          currency: 'USD',
          amount: 1000,
          incurredAt: new Date(),
          CollectiveId: host.id,
          FromCollectiveId: payee.id,
          UserId: payeeAdmin.id,
          lastEditedById: payeeAdmin.id,
          PayoutMethodId: payoutMethod.id,
          legacyPayoutMethod: Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
          data: { taxes: [] },
        },
        { transaction },
      );
      await ExpenseItem.create(
        {
          description: 'Platform settlement',
          amount: 1000,
          currency: 'USD',
          expenseCurrencyFxRate: 1,
          incurredAt: expense.incurredAt,
          ExpenseId: expense.id,
          CreatedByUserId: payeeAdmin.id,
        },
        { transaction },
      );
      return {
        actors: { hostAdmin: actorHandle(hostAdmin) },
        accounts: { host: accountHandle(host), payee: accountHandle(payee) },
        expenses: { settlement: expenseHandle(expense, host) },
        urls: { expense: `/${host.slug}/expenses/${expense.id}` },
      };
    },
  }),
};
