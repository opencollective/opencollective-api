import { z } from 'zod';

import { UseVendorPolicyValue } from '../constants/policies';
import type { Collective } from '../models';

import {
  accountHandle,
  actorHandle,
  createActor,
  createHost,
  createHostedCollective,
  createProject,
  createVendor,
  defineRecipe,
  type Recipe,
} from './builders';

const useVendorPolicy = z.enum(UseVendorPolicyValue);

/** Account labels a vendor can be scoped to, by the host label that holds the vendor. */
const SCOPES = {
  host: ['host', 'collective', 'collective2', 'project'],
  otherHost: ['otherHost', 'otherCollective'],
} as const;

const vendor = z
  .object({
    /** Key of the vendor in the result. Its name is `<label> <attempt tag>`, short enough to show whole in pickers. */
    label: z.string().regex(/^[a-z][a-zA-Z0-9]{0,19}$/),
    /** The host holding the vendor. */
    host: z.enum(['host', 'otherHost']).default('host'),
    /** Accounts the vendor can be used with, by label. Empty: every Account of its host. */
    usableWith: z.array(z.enum([...SCOPES.host, ...SCOPES.otherHost])).default([]),
    /** The vendor's own policy. Omitted: the vendor follows its host's policy. */
    useVendorPolicy: useVendorPolicy.optional(),
    /** A saved "Other" payout method, so the vendor can be paid. */
    payoutMethod: z.boolean().default(false),
  })
  .strict();

const inputs = z
  .object({
    /** Who may use the host's vendors. Omitted: the host has no policy and the product default applies. */
    useVendorPolicy: useVendorPolicy.optional(),
    /** Grants are enabled on `collective`. */
    grants: z.boolean().default(false),
    /** A second Collective on the host, administered by the host admin only. */
    secondCollective: z.boolean().default(false),
    /** A Project under `collective`, with no admins of its own. */
    project: z.boolean().default(false),
    /** A signed-up user with no role anywhere. */
    outsider: z.boolean().default(false),
    /**
     * A second, unrelated fiscal host. Its admin is either `hostAdmin` too or its own `otherHostAdmin`;
     * `collective` adds a Collective on it with its own `otherCollectiveAdmin`.
     */
    otherHost: z
      .object({ admin: z.enum(['hostAdmin', 'otherHostAdmin']), collective: z.boolean().default(false) })
      .strict()
      .optional(),
    vendors: z.array(vendor).max(6).default([]),
  })
  .strict()
  .superRefine((graph, issues) => {
    const arranged = new Set<string>(['host', 'collective']);
    for (const [label, present] of [
      ['collective2', graph.secondCollective],
      ['project', graph.project],
      ['otherHost', graph.otherHost],
      ['otherCollective', graph.otherHost?.collective],
    ] as const) {
      if (present) {
        arranged.add(label);
      }
    }
    const labels = new Set<string>();
    graph.vendors.forEach((entry, index) => {
      if (labels.has(entry.label)) {
        issues.addIssue({ code: 'custom', path: ['vendors', index, 'label'], message: 'Duplicate vendor label' });
      }
      labels.add(entry.label);
      for (const account of [entry.host, ...entry.usableWith]) {
        if (!arranged.has(account) || !(SCOPES[entry.host] as readonly string[]).includes(account)) {
          // Same rule as the product: a vendor is scoped to its host or to Accounts that host holds.
          issues.addIssue({
            code: 'custom',
            path: ['vendors', index],
            message: `Account ${account} is not arranged on ${entry.host}`,
          });
        }
      }
    });
  });

export const vendorRecipes: Record<string, Recipe> = {
  /**
   * A fiscal host with its admin, one Collective with its own admin, and the
   * vendors the journey names: each held by a host, optionally scoped to some
   * of its Accounts and optionally overriding the host's vendor policy.
   * Options add the other Accounts and parties a vendor can be seen from.
   * Using, creating or editing vendors is always the journey's own behavior.
   */
  'vendor-host': defineRecipe({
    inputs,
    build: async (ctx, graph) => {
      const hostAdmin = await createActor(ctx, 'host-admin');
      const collectiveAdmin = await createActor(ctx, 'collective-admin');
      const outsider = graph.outsider && (await createActor(ctx, 'outsider'));
      const host = await createHost(ctx, hostAdmin, { useVendorPolicy: graph.useVendorPolicy });
      const collective = await createHostedCollective(ctx, 'collective', {
        host,
        creator: collectiveAdmin,
        admins: [collectiveAdmin],
        settings: graph.grants ? { expenseTypes: { GRANT: true } } : {},
      });
      const collective2 =
        graph.secondCollective &&
        (await createHostedCollective(ctx, 'collective2', { host, creator: hostAdmin, admins: [hostAdmin] }));
      const project =
        graph.project && (await createProject(ctx, 'project', { parent: collective, creator: collectiveAdmin }));

      const otherHostAdmin =
        graph.otherHost?.admin === 'otherHostAdmin' && (await createActor(ctx, 'other-host-admin'));
      const otherHost =
        graph.otherHost && (await createHost(ctx, otherHostAdmin || hostAdmin, { label: 'other-host' }));
      const otherCollectiveAdmin = graph.otherHost?.collective && (await createActor(ctx, 'other-collective-admin'));
      const otherCollective =
        otherHost &&
        otherCollectiveAdmin &&
        (await createHostedCollective(ctx, 'other-collective', {
          host: otherHost,
          creator: otherCollectiveAdmin,
          admins: [otherCollectiveAdmin],
        }));

      const accounts: Record<string, Collective> = {
        host,
        collective,
        ...(collective2 && { collective2 }),
        ...(project && { project }),
        ...(otherHost && { otherHost }),
        ...(otherCollective && { otherCollective }),
      };
      const vendors: Record<string, ReturnType<typeof accountHandle>> = {};
      for (const entry of graph.vendors) {
        vendors[entry.label] = accountHandle(
          await createVendor(ctx, `vendor-${entry.label}`, {
            host: accounts[entry.host],
            name: `${entry.label} ${ctx.tag}`,
            creator: entry.host === 'otherHost' && otherHostAdmin ? otherHostAdmin : hostAdmin,
            usableWith: entry.usableWith.map(label => accounts[label]),
            useVendorPolicy: entry.useVendorPolicy ?? null,
            payoutMethod: entry.payoutMethod,
          }),
        );
      }

      return {
        actors: {
          hostAdmin: actorHandle(hostAdmin),
          collectiveAdmin: actorHandle(collectiveAdmin),
          ...(outsider && { outsider: actorHandle(outsider) }),
          ...(otherHostAdmin && { otherHostAdmin: actorHandle(otherHostAdmin) }),
          ...(otherCollectiveAdmin && { otherCollectiveAdmin: actorHandle(otherCollectiveAdmin) }),
        },
        accounts: Object.fromEntries(
          Object.entries(accounts).map(([label, account]) => [label, accountHandle(account)]),
        ),
        vendors,
        expenses: {},
        urls: {
          hostedCollectives: `/dashboard/${host.slug}/hosted-collectives`,
        },
      };
    },
  }),
};
