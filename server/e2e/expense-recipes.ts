import { z } from 'zod';

import {
  accountHandle,
  actorHandle,
  createActor,
  createHost,
  createHostedCollective,
  createInvitedDraftExpense,
  createOrganization,
  createPayoutMethod,
  createProject,
  createSubmittedExpense,
  defineRecipe,
  expenseHandle,
  type Recipe,
} from './builders';

const item = z.object({ description: z.string().trim().min(1).max(255), amount: z.number().int().positive() }).strict();

/**
 * Graph recipes share one result shape, keyed by role label:
 * `actors` (with a private session token each), `accounts`, `expenses`, `urls`.
 * Journeys pick who is signed in; a recipe never decides that.
 */
export const expenseRecipes: Record<string, Recipe> = {
  /**
   * A submitter facing a Collective on an attempt-owned host that someone else
   * administers. Options add only prior history and unrelated payee/invitee
   * profiles; submitting is always the journey's own behavior.
   */
  'expense-submission': defineRecipe({
    inputs: z
      .object({
        /** Tax context of the paying Collective, e.g. country `BE` with its own VAT number. */
        collective: z
          .object({
            country: z.string().regex(/^[A-Z]{2}$/),
            vat: z.object({ type: z.enum(['OWN', 'HOST']), number: z.string().trim().min(1).max(50) }).strict(),
          })
          .strict()
          .optional(),
        /** A second Collective on the same host. */
        secondCollective: z.boolean().default(false),
        /** An Organization the submitter administers, usable as payee. */
        payeeOrganization: z.boolean().default(false),
        /** One pending invoice the submitter already sent to `collective`, with a saved payout method. */
        priorExpense: z.boolean().default(false),
        /** An unrelated user the submitter can invite by profile. */
        invitee: z.boolean().default(false),
        /** An unrelated Organization with its own admin, which the submitter can invite by profile. */
        inviteeOrganization: z.boolean().default(false),
      })
      .strict(),
    build: async (ctx, inputs) => {
      const hostAdmin = await createActor(ctx, 'host-admin');
      const submitter = await createActor(ctx, 'submitter');
      const host = await createHost(ctx, hostAdmin);
      const hosted = { host, creator: hostAdmin, admins: [hostAdmin] };
      const collective = await createHostedCollective(ctx, 'collective', {
        ...hosted,
        country: inputs.collective?.country,
        settings: inputs.collective ? { VAT: inputs.collective.vat } : {},
      });
      const collective2 = inputs.secondCollective && (await createHostedCollective(ctx, 'collective2', hosted));
      const organization = inputs.payeeOrganization && (await createOrganization(ctx, 'organization', submitter));
      const invitee = inputs.invitee && (await createActor(ctx, 'invitee'));
      const inviteeAdmin = inputs.inviteeOrganization && (await createActor(ctx, 'invitee-admin'));
      const inviteeOrganization = inviteeAdmin && (await createOrganization(ctx, 'invitee-organization', inviteeAdmin));
      const priorExpense =
        inputs.priorExpense &&
        (await createSubmittedExpense(ctx, {
          account: collective,
          submitter,
          payoutMethod: await createPayoutMethod(ctx, {
            account: submitter.collective,
            creator: submitter,
            name: `Saved payout ${ctx.tag}`,
          }),
          description: `Prior expense ${ctx.tag}`,
          items: [{ description: 'Some stuff', amount: 1000 }],
        }));
      return {
        actors: {
          hostAdmin: actorHandle(hostAdmin),
          submitter: actorHandle(submitter),
          ...(invitee && { invitee: actorHandle(invitee) }),
          ...(inviteeAdmin && { inviteeAdmin: actorHandle(inviteeAdmin) }),
        },
        accounts: {
          host: accountHandle(host),
          collective: accountHandle(collective),
          ...(collective2 && { collective2: accountHandle(collective2) }),
          ...(organization && { organization: accountHandle(organization) }),
          ...(inviteeOrganization && { inviteeOrganization: accountHandle(inviteeOrganization) }),
        },
        expenses: { ...(priorExpense && { prior: expenseHandle(priorExpense, collective) }) },
        urls: {
          collective: `/${collective.slug}`,
          newExpense: `/${collective.slug}/expenses/new`,
          submittedExpenses: `/dashboard/${submitter.collective.slug}/submitted-expenses`,
        },
      };
    },
  }),

  /**
   * A Collective admin facing their own Collective on an attempt-owned host:
   * the party who approves, rejects and deletes expenses and writes the
   * expense policy. Options add a pending invoice the admin submitted to the
   * Collective and a Project under it. Policies start empty; every transition,
   * deletion and policy edit is the journey's own behavior.
   */
  'expense-management': defineRecipe({
    inputs: z
      .object({
        /** One pending invoice by `admin` (also its payee) on `collective`, with a saved payout method. */
        expense: z
          .object({ description: z.string().trim().min(1).max(255), items: z.array(item).min(1).max(5) })
          .strict()
          .optional(),
        /** A Project under `collective`. */
        project: z.boolean().default(false),
      })
      .strict(),
    build: async (ctx, inputs) => {
      const hostAdmin = await createActor(ctx, 'host-admin');
      const admin = await createActor(ctx, 'admin');
      const host = await createHost(ctx, hostAdmin);
      const collective = await createHostedCollective(ctx, 'collective', { host, creator: admin, admins: [admin] });
      const project = inputs.project && (await createProject(ctx, 'project', { parent: collective, creator: admin }));
      const expense =
        inputs.expense &&
        (await createSubmittedExpense(ctx, {
          account: collective,
          submitter: admin,
          payoutMethod: await createPayoutMethod(ctx, {
            account: admin.collective,
            creator: admin,
            name: `Saved payout ${ctx.tag}`,
          }),
          ...inputs.expense,
        }));
      return {
        actors: { hostAdmin: actorHandle(hostAdmin), admin: actorHandle(admin) },
        accounts: {
          host: accountHandle(host),
          collective: accountHandle(collective),
          ...(project && { project: accountHandle(project) }),
        },
        expenses: { ...(expense && { pending: expenseHandle(expense, collective) }) },
        urls: {
          expenses: `/${collective.slug}/expenses`,
          policies: `/dashboard/${collective.slug}/policies`,
          ...(project && { projectNewExpense: `/${project.slug}/expenses/new` }),
        },
      };
    },
  }),

  /**
   * A Collective admin has already invited an existing Organization to submit
   * an invoice. The Organization's admin completes the draft in the journey.
   */
  'expense-draft-invite': defineRecipe({
    inputs: z
      .object({
        description: z.string().trim().min(1).max(255),
        currency: z.enum(['USD', 'EUR']),
        items: z.array(item).min(1).max(5),
      })
      .strict(),
    build: async (ctx, inputs) => {
      const hostAdmin = await createActor(ctx, 'host-admin');
      const drafter = await createActor(ctx, 'drafter');
      const payeeAdmin = await createActor(ctx, 'payee-admin');
      const host = await createHost(ctx, hostAdmin);
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: drafter,
        admins: [drafter],
      });
      const payee = await createOrganization(ctx, 'payee', payeeAdmin);
      const { expense, draftKey } = await createInvitedDraftExpense(ctx, {
        account: collective,
        inviter: drafter,
        payee,
        ...inputs,
      });
      const draft = expenseHandle(expense, collective);
      return {
        actors: {
          hostAdmin: actorHandle(hostAdmin),
          drafter: actorHandle(drafter),
          payeeAdmin: actorHandle(payeeAdmin),
        },
        accounts: { host: accountHandle(host), collective: accountHandle(collective), payee: accountHandle(payee) },
        expenses: { draft },
        urls: { draft: `${draft.url}?key=${draftKey}` },
      };
    },
  }),
};
