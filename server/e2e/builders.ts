import type { Transaction } from 'sequelize';
import type { z } from 'zod';

import { CollectiveType } from '../constants/collectives';
import type { SupportedCurrency } from '../constants/currencies';
import expenseStatus from '../constants/expense-status';
import expenseType from '../constants/expense-type';
import roles from '../constants/roles';
import { createAccountAdminMembers } from '../lib/account-admins';
import { TOKEN_EXPIRATION_SESSION } from '../lib/auth';
import { Collective, Expense, ExpenseItem, Member, PayoutMethod, User } from '../models';
import { PayoutMethodTypes } from '../models/PayoutMethod';

/**
 * Small prerequisite builders shared by the named recipes. Every write joins the
 * recipe transaction, so a request commits its whole graph with its receipt or
 * nothing at all. Builders arrange starting state only: they bypass mutations,
 * send no mail and record no activity a journey could mistake for its own.
 */
type FixtureContext = {
  transaction: Transaction;
  /** sha256 of the owner run, attempt identity and request ID. */
  key: string;
  attempt: Record<string, unknown>;
  requestId: string;
  /** Attempt-unique slug/identifier for a labelled part of the graph. */
  slug: (label: string) => string;
  /** Short attempt-unique suffix for human-readable names. */
  tag: string;
  /** Throws (and rolls back) once the requesting client has gone away. */
  checkConnection: () => void;
};

/**
 * A named recipe validates its own inputs and arranges one prerequisite graph
 * inside the request transaction. The protocol adds the echoed request identity
 * and the durable receipt around whatever references it returns.
 */
export type Recipe = {
  inputs: z.ZodType;
  build: (ctx: FixtureContext, inputs: unknown) => Promise<Record<string, unknown>>;
};
export const defineRecipe = <Schema extends z.ZodType>(recipe: {
  inputs: Schema;
  build: (ctx: FixtureContext, inputs: z.output<Schema>) => Promise<Record<string, unknown>>;
}): Recipe => recipe as Recipe;

type AccountSettings = Record<string, unknown>;

export const actorHandle = (user: User) => ({
  id: user.collective.publicId,
  legacyId: user.collective.id,
  slug: user.collective.slug,
  name: user.collective.name,
  email: user.email,
  // Session auth avoids global sign-in rate counters and tokens in browser
  // navigation URLs. Only safe to return after commit.
  token: user.jwt({ scope: 'session' }, TOKEN_EXPIRATION_SESSION),
});

export const accountHandle = (account: Collective) => ({
  id: account.publicId,
  legacyId: account.id,
  slug: account.slug,
  name: account.name,
  type: account.type,
});

export const expenseHandle = (expense: Expense, account: Collective) => ({
  id: expense.publicId,
  legacyId: expense.id,
  description: expense.description,
  status: expense.status,
  url: `/${account.slug}/expenses/${expense.id}`,
});

/**
 * A signed-up user with a completed profile and no memberships. The profile
 * slug derives from the name, so always use the returned handle.
 */
export async function createActor(ctx: FixtureContext, label: string): Promise<User> {
  ctx.checkConnection();
  return User.createUserWithCollective(
    {
      // Matches the local sign-in shortcut pattern for journeys that sign in through the UI.
      email: `testuser+${ctx.slug(label)}@opencollective.com`,
      name: ctx.slug(label),
      data: { requiresProfileCompletion: false },
    },
    ctx.transaction,
  );
}

/** An active fiscal host owned by this request, with the money-management setup of `createOrganization`. */
export async function createHost(
  ctx: FixtureContext,
  admin: User,
  { currency = 'USD' }: { currency?: SupportedCurrency } = {},
): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const host = await Collective.create(
    {
      type: CollectiveType.ORGANIZATION,
      name: `Host ${ctx.tag}`,
      slug: ctx.slug('host'),
      description: 'An independent Playwright fiscal host',
      currency,
      CreatedByUserId: admin.id,
      data: { e2eAttempt: ctx.attempt, e2eRequestId: ctx.requestId },
    },
    { transaction },
  );
  await host.activateMoneyManagement({ remoteUser: admin, silent: true, transaction });
  // `activateHosting` without its activity, which would email the admin even if this request rolls back.
  await host.update({ hasHosting: true }, { transaction });
  await createAccountAdminMembers(host, [admin], { transaction });
  return host;
}

/** An approved, active Collective under a host. `admins` may be empty for a Collective nobody in the journey manages. */
export async function createHostedCollective(
  ctx: FixtureContext,
  label: string,
  {
    host,
    creator,
    admins = [],
    country,
    settings = {},
  }: { host: Collective; creator: User; admins?: User[]; country?: string; settings?: AccountSettings },
): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const slug = ctx.slug(label);
  const account = await Collective.create(
    {
      type: CollectiveType.COLLECTIVE,
      // The slug is part of the name so journeys can find and assert the Account in pickers and summaries.
      name: `${slug} Collective`,
      slug,
      description: 'An independent Playwright hosted Collective',
      currency: host.currency,
      HostCollectiveId: host.id,
      hostFeePercent: host.hostFeePercent,
      platformFeePercent: host.platformFeePercent,
      isActive: true,
      approvedAt: new Date(),
      CreatedByUserId: creator.id,
      settings,
      data: { e2eAttempt: ctx.attempt, e2eRequestId: ctx.requestId },
    },
    { transaction },
  );
  await Member.create(
    { CollectiveId: account.id, MemberCollectiveId: host.id, role: roles.HOST, CreatedByUserId: creator.id },
    { transaction },
  );
  if (country) {
    await account.setLocation({ country }, transaction);
  }
  await createAccountAdminMembers(account, admins, { transaction });
  return account;
}

/** An unhosted Organization administered by an actor (a payee or invitee profile). */
export async function createOrganization(ctx: FixtureContext, label: string, admin: User): Promise<Collective> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const slug = ctx.slug(label);
  const organization = await Collective.create(
    {
      type: CollectiveType.ORGANIZATION,
      name: `${slug} Organization`,
      slug,
      currency: 'USD',
      HostCollectiveId: null,
      isActive: false,
      CreatedByUserId: admin.id,
      data: { e2eAttempt: ctx.attempt, e2eRequestId: ctx.requestId },
    },
    { transaction },
  );
  await createAccountAdminMembers(organization, [admin], { transaction });
  return organization;
}

/** A saved "Other" payout method on an Account. */
export async function createPayoutMethod(
  ctx: FixtureContext,
  {
    account,
    creator,
    name,
    currency = 'USD',
  }: { account: Collective; creator: User; name: string; currency?: SupportedCurrency },
): Promise<PayoutMethod> {
  ctx.checkConnection();
  return PayoutMethod.create(
    {
      type: PayoutMethodTypes.OTHER,
      name,
      data: { content: `Payout details for ${name}`, currency },
      currency,
      isSaved: true,
      CollectiveId: account.id,
      CreatedByUserId: creator.id,
    },
    { transaction: ctx.transaction },
  );
}

type ItemInput = { description: string; amount: number };

/** An already submitted (pending) invoice: prior history, never the submission a journey is testing. */
export async function createSubmittedExpense(
  ctx: FixtureContext,
  {
    account,
    submitter,
    payoutMethod,
    description,
    items,
  }: { account: Collective; submitter: User; payoutMethod: PayoutMethod; description: string; items: ItemInput[] },
): Promise<Expense> {
  ctx.checkConnection();
  const { transaction } = ctx;
  const incurredAt = new Date();
  const expense = await Expense.create(
    {
      type: expenseType.INVOICE,
      status: expenseStatus.PENDING,
      description,
      tags: ['engineering'],
      currency: account.currency,
      amount: items.reduce((total, item) => total + item.amount, 0),
      incurredAt,
      CollectiveId: account.id,
      FromCollectiveId: submitter.CollectiveId,
      UserId: submitter.id,
      lastEditedById: submitter.id,
      PayoutMethodId: payoutMethod.id,
      legacyPayoutMethod: Expense.getLegacyPayoutMethodTypeFromPayoutMethod(payoutMethod),
      data: { taxes: [] },
    },
    { transaction },
  );
  for (const [order, item] of items.entries()) {
    await ExpenseItem.create(
      {
        ...item,
        order,
        currency: expense.currency,
        expenseCurrencyFxRate: 1,
        incurredAt,
        ExpenseId: expense.id,
        CreatedByUserId: submitter.id,
      },
      { transaction },
    );
  }
  return expense;
}

/**
 * A draft an inviter addressed to an existing payee Account, in the state
 * `draftExpenseAndInviteUser` leaves behind, minus the invitation email.
 * Completing the draft is the journey's behavior.
 */
export async function createInvitedDraftExpense(
  ctx: FixtureContext,
  {
    account,
    inviter,
    payee,
    description,
    currency,
    items,
  }: {
    account: Collective;
    inviter: User;
    payee: Collective;
    description: string;
    currency: SupportedCurrency;
    items: ItemInput[];
  },
): Promise<{ expense: Expense; draftKey: string }> {
  ctx.checkConnection();
  // The product uses this constant key in E2E environments; recipes only exist there.
  const draftKey = 'draft-key';
  const expense = await Expense.create(
    {
      type: expenseType.INVOICE,
      status: expenseStatus.DRAFT,
      description,
      currency,
      amount: items.reduce((total, item) => total + item.amount, 0),
      incurredAt: new Date(),
      CollectiveId: account.id,
      FromCollectiveId: inviter.CollectiveId,
      UserId: inviter.id,
      lastEditedById: inviter.id,
      data: {
        items: items.map((item, order) => ({
          ...item,
          order,
          currency,
          expenseCurrencyFxRate: 1,
          expenseCurrencyFxRateSource: null,
        })),
        attachedFiles: null,
        invoiceFile: null,
        payee: payee.minimal,
        invitedByCollectiveId: inviter.CollectiveId,
        draftKey,
        notify: false,
      },
    },
    { transaction: ctx.transaction },
  );
  return { expense, draftKey };
}
