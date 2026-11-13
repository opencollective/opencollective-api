import { randomUUID } from 'crypto';

import moment from 'moment';
import { z } from 'zod';

import OrderStatuses from '../constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../constants/paymentMethods';
import roles from '../constants/roles';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { Member, Order, PaymentMethod, Subscription, Tier, Transaction } from '../models';

import {
  accountHandle,
  actorHandle,
  createActor,
  createHost,
  createHostedCollective,
  defineRecipe,
  type Recipe,
} from './builders';

const inputs = z
  .object({
    /** Monthly amount of the contribution, charged once already. */
    amount: z.number().int().min(100).default(100),
    /**
     * The contributor already asked to move to the Gold tier (at its price), which waits for the next charge
     * (`Order.data.pendingTierChange`), as `updateOrder` leaves it.
     */
    pendingGoldTier: z.boolean().default(false),
  })
  .strict();

export const contributionRecipes: Record<string, Recipe> = {
  /**
   * A fiscal host, a hosted Collective with two paid tiers (`gold`: fixed $1,000/month, `silver`: from
   * $100/month) and a contributor with a monthly contribution to it, without tier, charged once with a saved
   * card. The contributor is a backer of the Collective. Updating the contribution is the journey's behavior.
   */
  'recurring-contribution': defineRecipe({
    inputs,
    build: async (ctx, graph) => {
      const { transaction } = ctx;
      const hostAdmin = await createActor(ctx, 'host-admin');
      const contributor = await createActor(ctx, 'contributor');
      const host = await createHost(ctx, hostAdmin);
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: hostAdmin,
        admins: [hostAdmin],
      });

      // Readable names: these journeys illustrate pull requests
      await contributor.collective.update({ name: 'Alex Rivera' }, { transaction });
      await collective.update({ name: 'Example Collective' }, { transaction });

      ctx.checkConnection();
      const tierBase = {
        CollectiveId: collective.id,
        type: 'TIER' as const,
        currency: 'USD' as const,
        interval: 'month' as const,
      };
      const gold = await Tier.create(
        {
          ...tierBase,
          name: 'Gold Sponsor',
          slug: 'gold-sponsor',
          description: 'Logo on the README and website',
          amountType: 'FIXED',
          amount: 100000,
        },
        { transaction },
      );
      const silver = await Tier.create(
        {
          ...tierBase,
          name: 'Silver Sponsor',
          slug: 'silver-sponsor',
          description: 'Name on the website',
          amountType: 'FLEXIBLE',
          amount: 10000,
          minimumAmount: 10000,
          presets: [10000, 25000],
        },
        { transaction },
      );

      ctx.checkConnection();
      const paymentMethod = await PaymentMethod.create(
        {
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.CREDITCARD,
          name: '4242',
          // Shaped like a Stripe token (24 characters), never sent to Stripe
          token: `pm_${ctx.key.slice(0, 24)}`,
          currency: 'USD',
          saved: true,
          CollectiveId: contributor.CollectiveId,
          CreatedByUserId: contributor.id,
          data: { brand: 'Visa', expMonth: 12, expYear: moment().year() + 3, fingerprint: ctx.tag },
        },
        { transaction },
      );

      const chargedAt = new Date();
      const nextChargeDate = moment().add(1, 'month').startOf('month').toDate();
      const amount = graph.pendingGoldTier ? gold.amount : graph.amount;
      const subscription = await Subscription.create(
        {
          amount,
          currency: 'USD',
          interval: 'month',
          isActive: true,
          activatedAt: chargedAt,
          lastChargedAt: chargedAt,
          nextChargeDate,
          nextPeriodStart: nextChargeDate,
          chargeNumber: 1,
        },
        { transaction },
      );
      const order = await Order.create(
        {
          CreatedByUserId: contributor.id,
          FromCollectiveId: contributor.CollectiveId,
          CollectiveId: collective.id,
          PaymentMethodId: paymentMethod.id,
          SubscriptionId: subscription.id,
          TierId: null,
          totalAmount: amount,
          platformTipAmount: 0,
          currency: 'USD',
          interval: 'month',
          quantity: 1,
          status: OrderStatuses.ACTIVE,
          description: `Monthly financial contribution to ${collective.name}`,
          processedAt: chargedAt,
          data: graph.pendingGoldTier
            ? {
                pendingTierChange: {
                  TierId: gold.id,
                  previousTierId: null,
                  requestedAt: new Date().toISOString(),
                  requestedByUserId: contributor.id,
                },
              }
            : {},
        },
        { transaction },
      );

      // The first charge, at the amount before any upgrade. Hooks are skipped: no activity or email.
      ctx.checkConnection();
      const TransactionGroup = randomUUID();
      const ledgerBase = {
        kind: TransactionKind.CONTRIBUTION,
        currency: 'USD' as const,
        hostCurrency: 'USD' as const,
        hostCurrencyFxRate: 1,
        hostFeeInHostCurrency: 0,
        platformFeeInHostCurrency: 0,
        paymentProcessorFeeInHostCurrency: 0,
        HostCollectiveId: host.id,
        OrderId: order.id,
        PaymentMethodId: paymentMethod.id,
        CreatedByUserId: contributor.id,
        TransactionGroup,
        description: order.description,
        createdAt: chargedAt,
        clearedAt: chargedAt,
      };
      await Transaction.create(
        {
          ...ledgerBase,
          type: TransactionTypes.CREDIT,
          amount: graph.amount,
          amountInHostCurrency: graph.amount,
          netAmountInCollectiveCurrency: graph.amount,
          CollectiveId: collective.id,
          FromCollectiveId: contributor.CollectiveId,
        },
        { transaction, hooks: false },
      );
      await Transaction.create(
        {
          ...ledgerBase,
          type: TransactionTypes.DEBIT,
          amount: -graph.amount,
          amountInHostCurrency: -graph.amount,
          netAmountInCollectiveCurrency: -graph.amount,
          CollectiveId: contributor.CollectiveId,
          FromCollectiveId: collective.id,
        },
        { transaction, hooks: false },
      );

      await Member.create(
        {
          role: roles.BACKER,
          MemberCollectiveId: contributor.CollectiveId,
          CollectiveId: collective.id,
          TierId: null,
          CreatedByUserId: contributor.id,
          since: chargedAt,
        },
        { transaction },
      );

      const contributorSlug = contributor.collective.slug;
      return {
        actors: { contributor: actorHandle(contributor), hostAdmin: actorHandle(hostAdmin) },
        accounts: { host: accountHandle(host), collective: accountHandle(collective) },
        tiers: {
          gold: { legacyId: gold.id, name: gold.name },
          silver: { legacyId: silver.id, name: silver.name },
        },
        contribution: { legacyId: order.id, id: order.publicId },
        vendors: {},
        expenses: {},
        urls: {
          outgoingContributions: `/dashboard/${contributorSlug}/outgoing-contributions`,
          contribution: `/dashboard/${contributorSlug}/outgoing-contributions?orderId=${order.id}`,
          collectiveContributors: `/${collective.slug}/contributors`,
        },
      };
    },
  }),
};
