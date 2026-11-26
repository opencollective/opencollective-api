import { randomUUID } from 'crypto';

import { z } from 'zod';

import expenseStatus from '../constants/expense-status';
import expenseType from '../constants/expense-type';
import OrderStatuses from '../constants/order-status';
import roles from '../constants/roles';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { sessionCache } from '../lib/cache';
import { Expense, Member, Order, Tier, Transaction, type User } from '../models';
import { SocialLinkType } from '../models/SocialLink';

import {
  accountHandle,
  actorHandle,
  createActor,
  createHost,
  createHostedCollective,
  createOrganization,
  createPayoutMethod,
  defineRecipe,
  type Recipe,
} from './builders';

const inputs = z
  .object({
    /** Currency of the host, and so of the hosted Collective and its tiers. */
    currency: z.enum(['USD', 'EUR']).default('USD'),
    /** Links shown in the Collective's hero, in this order. */
    socialLinks: z
      .array(z.object({ type: z.enum(SocialLinkType), url: z.string().url() }).strict())
      .max(10)
      .default([]),
    /** An unhosted Organization, also administered by `admin`. */
    organization: z.boolean().default(false),
    /**
     * Money that already moved between `organization` and the Collective (cents of `currency`): a one-time
     * contribution from the Organization, and, earlier, a paid expense from the Organization to the Collective.
     * Requires `organization`.
     */
    history: z
      .object({ contribution: z.number().int().positive(), expense: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(graph => !graph.history || graph.organization, {
    message: 'history moves money from and to the organization: set organization too',
    path: ['history'],
  });

/**
 * A restored database hands out user ids again, while the API's Redis keeps the 2FA sessions and failed-code
 * counters of the previous database's users. Forget those of this new user, so the journey starts with a clean
 * budget. Only this user's keys: if the request rolls back, the id is never reused. (Same as the `individual`
 * recipe of the auth journeys.)
 */
async function forgetStaleTwoFactorState(user: User) {
  const staleSessions = await sessionCache.keys(`2fa:${user.id}:*`);
  if (staleSessions.length) {
    await sessionCache.delete(staleSessions);
  }
  await sessionCache.delete([`user_2FA_graphql_${user.id}`, `user_2FA_endpoint_${user.id}`]);
}

export const collectiveRecipes: Record<string, Recipe> = {
  /**
   * The admin of a Collective, hosted by a fiscal host of its own, with the two tiers a host's approval gives
   * it (`backer`, `sponsor`), and optionally social links, an Organization the admin also runs and money that
   * moved between the two. Editing, creating, archiving or reading these Accounts is the journey's behaviour.
   */
  'collective-admin': defineRecipe({
    inputs,
    build: async (ctx, graph) => {
      const { transaction } = ctx;
      const admin = await createActor(ctx, 'admin');
      const hostAdmin = await createActor(ctx, 'host-admin');
      await forgetStaleTwoFactorState(admin);
      const host = await createHost(ctx, hostAdmin, { currency: graph.currency });
      const collective = await createHostedCollective(ctx, 'collective', { host, creator: admin, admins: [admin] });
      // Short names and address, which pages show whole and forms accept (cards and lists cut the slug-based
      // default names off; a new Collective's address must be under 30 characters)
      await collective.update({ name: `Collective ${ctx.tag}`, slug: `pwc-${ctx.tag}` }, { transaction });
      if (graph.socialLinks.length) {
        await collective.updateSocialLinks(graph.socialLinks, transaction);
      }

      // The default tiers approval by a host creates (`defaultTiers` in `server/models/Collective.ts`)
      ctx.checkConnection();
      const tierBase = {
        CollectiveId: collective.id,
        type: 'TIER' as const,
        interval: 'month' as const,
        currency: graph.currency,
        amountType: 'FLEXIBLE' as const,
      };
      const backer = await Tier.create(
        {
          ...tierBase,
          name: 'backer',
          slug: 'backers',
          amount: 500,
          minimumAmount: 500,
          presets: [500, 1000, 2500, 5000],
        },
        { transaction },
      );
      const sponsor = await Tier.create(
        {
          ...tierBase,
          name: 'sponsor',
          slug: 'sponsors',
          amount: 10000,
          minimumAmount: 10000,
          presets: [10000, 25000, 50000],
        },
        { transaction },
      );

      const organization = graph.organization ? await createOrganization(ctx, 'organization', admin) : null;
      await organization?.update({ name: `Organization ${ctx.tag}` }, { transaction });
      if (graph.history && organization) {
        await arrangeHistory(ctx, { host, collective, organization, admin, ...graph.history });
      }

      const tierHandle = (tier: Tier) => ({ legacyId: tier.id, slug: tier.slug, name: tier.name });
      return {
        actors: { admin: actorHandle(admin), hostAdmin: actorHandle(hostAdmin) },
        accounts: {
          host: accountHandle(host),
          collective: accountHandle(collective),
          ...(organization && { organization: accountHandle(organization) }),
        },
        tiers: { backer: tierHandle(backer), sponsor: tierHandle(sponsor) },
        expenses: {},
        vendors: {},
        urls: {
          collective: `/${collective.slug}`,
          dashboard: `/dashboard/${collective.slug}`,
          info: `/dashboard/${collective.slug}/info`,
          tiers: `/dashboard/${collective.slug}/tiers`,
          advanced: `/dashboard/${collective.slug}/advanced`,
          newEvent: `/${collective.slug}/events/create`,
          backerTier: `/${collective.slug}/contribute/${backer.slug}-${backer.id}`,
          userSecurity: `/dashboard/${admin.collective.slug}/user-security`,
          ...(organization && {
            organization: `/${organization.slug}`,
            organizationAdvanced: `/dashboard/${organization.slug}/advanced`,
          }),
        },
      };
    },
  }),
};

type HistoryInput = {
  host: Awaited<ReturnType<typeof createHost>>;
  collective: Awaited<ReturnType<typeof createHostedCollective>>;
  organization: Awaited<ReturnType<typeof createOrganization>>;
  admin: User;
  contribution: number;
  expense: number;
};

/**
 * A paid expense from `organization` to `collective`, then a paid one-time contribution from `organization` to
 * `collective`, each with its ledger pair. Hooks are skipped: no activity or email.
 */
async function arrangeHistory(
  ctx: Parameters<Recipe['build']>[0],
  { host, collective, organization, admin, contribution, expense }: HistoryInput,
) {
  const { transaction } = ctx;
  const currency = collective.currency;
  const paidAt = new Date(Date.now() - 2 * 60_000);
  const contributedAt = new Date(Date.now() - 60_000);
  const ledgerBase = {
    currency,
    hostCurrency: currency,
    hostCurrencyFxRate: 1,
    hostFeeInHostCurrency: 0,
    platformFeeInHostCurrency: 0,
    paymentProcessorFeeInHostCurrency: 0,
    HostCollectiveId: host.id,
    CreatedByUserId: admin.id,
  };

  ctx.checkConnection();
  const payoutMethod = await createPayoutMethod(ctx, {
    account: organization,
    creator: admin,
    name: `Payout ${ctx.tag}`,
    currency,
  });
  const paidExpense = await Expense.create(
    {
      type: expenseType.INVOICE,
      status: expenseStatus.PAID,
      description: `Expense ${ctx.tag}`,
      currency,
      amount: expense,
      incurredAt: paidAt,
      CollectiveId: collective.id,
      HostCollectiveId: host.id,
      FromCollectiveId: organization.id,
      UserId: admin.id,
      lastEditedById: admin.id,
      PayoutMethodId: payoutMethod.id,
      legacyPayoutMethod: Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      data: { taxes: [] },
      createdAt: paidAt,
    },
    { transaction },
  );
  const expenseLedger = {
    ...ledgerBase,
    kind: TransactionKind.EXPENSE,
    ExpenseId: paidExpense.id,
    PayoutMethodId: payoutMethod.id,
    TransactionGroup: randomUUID(),
    description: paidExpense.description,
    createdAt: paidAt,
    clearedAt: paidAt,
  };
  await Transaction.create(
    {
      ...expenseLedger,
      type: TransactionTypes.DEBIT,
      amount: -expense,
      amountInHostCurrency: -expense,
      netAmountInCollectiveCurrency: -expense,
      CollectiveId: collective.id,
      FromCollectiveId: organization.id,
    },
    { transaction, hooks: false },
  );
  await Transaction.create(
    {
      ...expenseLedger,
      type: TransactionTypes.CREDIT,
      amount: expense,
      amountInHostCurrency: expense,
      netAmountInCollectiveCurrency: expense,
      CollectiveId: organization.id,
      FromCollectiveId: collective.id,
    },
    { transaction, hooks: false },
  );

  ctx.checkConnection();
  const order = await Order.create(
    {
      CreatedByUserId: admin.id,
      FromCollectiveId: organization.id,
      CollectiveId: collective.id,
      totalAmount: contribution,
      platformTipAmount: 0,
      currency,
      quantity: 1,
      status: OrderStatuses.PAID,
      description: `Financial contribution to ${collective.name}`,
      processedAt: contributedAt,
    },
    { transaction },
  );
  const contributionLedger = {
    ...ledgerBase,
    kind: TransactionKind.CONTRIBUTION,
    OrderId: order.id,
    TransactionGroup: randomUUID(),
    description: order.description,
    createdAt: contributedAt,
    clearedAt: contributedAt,
  };
  await Transaction.create(
    {
      ...contributionLedger,
      type: TransactionTypes.CREDIT,
      amount: contribution,
      amountInHostCurrency: contribution,
      netAmountInCollectiveCurrency: contribution,
      CollectiveId: collective.id,
      FromCollectiveId: organization.id,
    },
    { transaction, hooks: false },
  );
  await Transaction.create(
    {
      ...contributionLedger,
      type: TransactionTypes.DEBIT,
      amount: -contribution,
      amountInHostCurrency: -contribution,
      netAmountInCollectiveCurrency: -contribution,
      CollectiveId: organization.id,
      FromCollectiveId: collective.id,
    },
    { transaction, hooks: false },
  );
  await Member.create(
    {
      role: roles.BACKER,
      MemberCollectiveId: organization.id,
      CollectiveId: collective.id,
      CreatedByUserId: admin.id,
      since: contributedAt,
    },
    { transaction },
  );
}
