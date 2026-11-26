import { z } from 'zod';

import {
  accountHandle,
  actorHandle,
  createActor,
  createAddedFunds,
  createHost,
  createHostedCollective,
  createPayoutMethod,
  createSubmittedExpense,
  createUnhostedCollective,
  defineRecipe,
  expenseHandle,
  type Recipe,
} from './builders';

const inputs = z
  .object({
    /** The host takes applications: it is listed among the hosts to apply to and its profile has an apply button. */
    openToApplications: z.boolean().default(false),
    /** Money (in cents) the host already added to `collective` from its own account. */
    collectiveBalance: z.number().int().min(0).max(1_000_000).default(0),
    /** A second Collective on the host, administered by the host admin. */
    secondCollective: z.boolean().default(false),
    /** One pending $10 invoice `collectiveAdmin` sent to `collective`, payable through a saved "Other" payout method. */
    pendingExpense: z.boolean().default(false),
    /**
     * A user with no role anywhere, who can be named as the source of funds: the host may record funds from any
     * account (`allowAddFundsFromAllAccounts`, which trusted hosts also have), not only from its own Accounts.
     */
    contributor: z.boolean().default(false),
    /** A user with no role anywhere, who may apply to the host. */
    applicant: z.boolean().default(false),
    /** A Collective without a host, administered by `applicant` (implies `applicant`). */
    applicantCollective: z.boolean().default(false),
  })
  .strict();

export const hostRecipes: Record<string, Recipe> = {
  /**
   * A fiscal host administered by `hostAdmin`, hosting `collective` (administered by `collectiveAdmin`).
   * Options add what a host admin's journey starts from: an open host, money on the Collective, a second
   * Collective, a pending expense, a contributor, an applicant and their unhosted Collective. Hosting,
   * applying, adding or recording funds, paying and every host setting are the journey's own behavior.
   */
  'fiscal-host': defineRecipe({
    inputs,
    build: async (ctx, graph) => {
      const hostAdmin = await createActor(ctx, 'host-admin');
      const collectiveAdmin = await createActor(ctx, 'collective-admin');
      const contributor = graph.contributor && (await createActor(ctx, 'contributor'));
      const applicant = (graph.applicant || graph.applicantCollective) && (await createActor(ctx, 'applicant'));
      const host = await createHost(ctx, hostAdmin, { openToApplications: graph.openToApplications });
      if (contributor) {
        await host.update(
          { data: { ...host.data, allowAddFundsFromAllAccounts: true } },
          { transaction: ctx.transaction },
        );
      }
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: collectiveAdmin,
        admins: [collectiveAdmin],
      });
      const collective2 =
        graph.secondCollective &&
        (await createHostedCollective(ctx, 'collective2', { host, creator: hostAdmin, admins: [hostAdmin] }));
      const applicantCollective =
        graph.applicantCollective && (await createUnhostedCollective(ctx, 'applicant-collective', applicant));
      if (graph.collectiveBalance) {
        await createAddedFunds(ctx, { host, collective, creator: hostAdmin, amount: graph.collectiveBalance });
      }
      const expense =
        graph.pendingExpense &&
        (await createSubmittedExpense(ctx, {
          account: collective,
          submitter: collectiveAdmin,
          payoutMethod: await createPayoutMethod(ctx, {
            account: collectiveAdmin.collective,
            creator: collectiveAdmin,
            name: `Saved payout ${ctx.tag}`,
          }),
          description: `Expense ${ctx.tag}`,
          items: [{ description: 'Some stuff', amount: 1000 }],
        }));

      const dashboard = `/dashboard/${host.slug}`;
      return {
        actors: {
          hostAdmin: actorHandle(hostAdmin),
          collectiveAdmin: actorHandle(collectiveAdmin),
          ...(contributor && { contributor: actorHandle(contributor) }),
          ...(applicant && { applicant: actorHandle(applicant) }),
        },
        accounts: {
          host: accountHandle(host),
          collective: accountHandle(collective),
          ...(collective2 && { collective2: accountHandle(collective2) }),
          ...(applicantCollective && { applicantCollective: accountHandle(applicantCollective) }),
        },
        expenses: { ...(expense && { pending: expenseHandle(expense, collective) }) },
        urls: {
          hostProfile: `/${host.slug}`,
          hostedCollectives: `${dashboard}/hosted-collectives`,
          hostApplications: `${dashboard}/host-applications`,
          expectedFunds: `${dashboard}/expected-funds`,
          chartOfAccounts: `${dashboard}/chart-of-accounts`,
          agreements: `${dashboard}/host-agreements`,
          payDisbursements: `${dashboard}/pay-disbursements`,
        },
      };
    },
  }),
};
