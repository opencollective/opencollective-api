import moment from 'moment';
import { ValidationError, type ValidationErrorItem } from 'sequelize';
import { z } from 'zod';

import { CollectiveType } from '../constants/collectives';
import { Service } from '../constants/connected-account';
import expenseStatus from '../constants/expense-status';
import expenseType from '../constants/expense-type';
import { Collective, ConnectedAccount, Expense, ExpenseItem, PayoutMethod, Tier, User } from '../models';
import { PayoutMethodTypes } from '../models/PayoutMethod';

import {
  accountHandle,
  actorHandle,
  arrangedBy,
  createActor,
  createHost,
  createHostedCollective,
  createOrganization,
  defineRecipe,
  expenseHandle,
  type Recipe,
} from './builders';

/**
 * Read-only use of seed data: the shared Stripe test connections live on these seeded accounts. `e2e-host` and
 * `e2e-eur-host` opted in to the Stripe Payment Element; `opensource` did not, so its contributors pay with the
 * card form of the contribution flow (Stripe's card element), like most hosts.
 */
const SEEDED_STRIPE_HOSTS = ['e2e-host', 'e2e-eur-host', 'opensource'] as const;
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
   * `e2e-eur-host`, EUR, or `opensource`, USD, card element), and a `contributor` with no payment method yet.
   * Optionally a monthly `sponsors` tier, an Organization the contributor administers, an upcoming Event of the
   * Collective (without tickets) and VAT on the Collective. Contributing is the journey.
   */
  'stripe-contribution': defineRecipe({
    inputs: z
      .object({
        host: z.enum(SEEDED_STRIPE_HOSTS).default('e2e-host'),
        /** A monthly `Sponsors` tier from $100, with $100, $250 and $500 presets (tier label `sponsors`). */
        sponsorsTier: z.boolean().default(false),
        /** An Organization (`organization`) administered by `contributor`, with no payment method yet. */
        contributorOrganization: z.boolean().default(false),
        /** An Event of the Collective in a week (`event`), without tickets, administered by `collectiveAdmin`. */
        event: z.boolean().default(false),
        /** The Collective is in Belgium and charges its own VAT (number `FRXX999999999`). */
        vat: z.boolean().default(false),
      })
      .strict(),
    build: async (ctx, inputs) => {
      const { transaction } = ctx;
      const host = await sharedStripeHost(inputs.host, transaction);
      const collectiveAdmin = await createActor(ctx, 'collective-admin');
      const contributor = await createActor(ctx, 'contributor');
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: collectiveAdmin,
        admins: [collectiveAdmin],
        ...(inputs.vat && { country: 'BE', settings: { VAT: { type: 'OWN', number: 'FRXX999999999' } } }),
      });

      const accounts: Record<string, ReturnType<typeof accountHandle>> = {
        host: accountHandle(host),
        collective: accountHandle(collective),
      };
      const urls: Record<string, string> = {
        collective: `/${collective.slug}`,
        donate: `/${collective.slug}/donate`,
        contribute: `/${collective.slug}/contribute`,
        transactions: `/${collective.slug}/transactions`,
        orders: `/${collective.slug}/orders`,
      };
      const tiers: Record<string, { legacyId: number; name: string; slug: string }> = {};

      if (inputs.sponsorsTier) {
        ctx.checkConnection();
        const tier = await Tier.create(
          {
            CollectiveId: collective.id,
            type: 'TIER',
            name: 'Sponsors',
            slug: 'sponsors',
            currency: collective.currency,
            interval: 'month',
            amountType: 'FLEXIBLE',
            amount: 10000,
            minimumAmount: 10000,
            presets: [10000, 25000, 50000],
          },
          { transaction },
        );
        tiers.sponsors = { legacyId: tier.id, name: tier.name, slug: tier.slug };
      }

      if (inputs.contributorOrganization) {
        accounts.organization = accountHandle(await createOrganization(ctx, 'organization', contributor));
      }

      if (inputs.event) {
        ctx.checkConnection();
        const startsAt = moment().add(7, 'days').startOf('day').add(19, 'hours');
        const event = await Collective.create(
          {
            type: CollectiveType.EVENT,
            name: `Event ${ctx.tag}`,
            slug: ctx.slug('event'),
            description: 'An independent Playwright Event',
            // As `createEvent` copies them from an active parent
            currency: collective.currency,
            HostCollectiveId: collective.HostCollectiveId,
            hostFeePercent: collective.hostFeePercent,
            platformFeePercent: collective.platformFeePercent,
            isActive: collective.isActive,
            approvedAt: new Date(),
            startsAt: startsAt.toDate(),
            endsAt: startsAt.clone().add(1, 'day').toDate(),
            timezone: 'UTC',
            ParentCollectiveId: collective.id,
            CreatedByUserId: collectiveAdmin.id,
            settings: {},
            data: arrangedBy(ctx),
          },
          { transaction },
        );
        accounts.event = accountHandle(event);
        urls.event = `/${collective.slug}/events/${event.slug}`;
        urls.eventTickets = `/dashboard/${event.slug}/tickets`;
      }

      return {
        actors: { contributor: actorHandle(contributor), collectiveAdmin: actorHandle(collectiveAdmin) },
        accounts,
        tiers,
        expenses: {},
        urls,
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
