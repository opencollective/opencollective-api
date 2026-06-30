import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { getCollectiveAvatarUrl } from '../../../lib/collectivelib';
import { canSeePrivateAccount } from '../../../lib/private-accounts';
import Collective from '../../../models/Collective';
import { GraphQLImageFormat, GraphQLMemberRole } from '../enum';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLAmount } from './Amount';

export const GraphQLContributor = new GraphQLObjectType({
  name: 'Contributor',
  description: `
    A person or an entity that contributes financially or by any other mean to the mission
    of the collective. While "Member" is dedicated to permissions, this type is meant
    to surface all the public contributors and properly groups contributors who are part of
    multiple tiers.
  `,
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A unique identifier for this member',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name of the contributor',
      deprecationReason: '2024-08-26: Use account.name instead',
    },
    roles: {
      type: new GraphQLList(GraphQLMemberRole),
      description: 'All the roles for a given contributor',
    },
    isAdmin: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a collective admin',
    },
    isCore: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a core contributor',
    },
    isBacker: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'True if the contributor is a financial contributor',
    },
    since: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Member join date',
    },
    totalAmountDonated: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'How much money the user has contributed for this (in cents, using collective currency)',
      deprecationReason: '2024-08-26: Use totalAmountContributed instead',
    },
    totalAmountContributed: {
      type: new GraphQLNonNull(GraphQLAmount),
      description: 'How much money the user has contributed',
      resolve(contributor): { value: number; currency: string } {
        return { value: contributor.totalAmountDonated, currency: contributor.collectiveCurrency };
      },
    },
    type: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Whether the contributor is an individual, an organization...',
      deprecationReason: '2024-08-26: Use account.type instead',
    },
    isIncognito: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Defines if the contributors wants to be incognito (name not displayed)',
      deprecationReason: '2024-08-26: Use account.isIncognito instead',
    },
    description: {
      type: GraphQLString,
      description: 'Description of how the member contribute. Will usually be a tier name, or "design" or "code".',
    },
    collectiveSlug: {
      type: GraphQLString,
      description:
        'If the contributor has a page on Open Collective, this is the slug to link to it. Always null for incognito contributors',
      deprecationReason: '2024-08-26: Use account.slug instead',
      async resolve(contributor, _, req): Promise<string | null> {
        if (contributor.isIncognito) {
          return null;
        }
        if (
          contributor.isPrivate &&
          !(await canSeePrivateAccount(req, { id: contributor.id, isPrivate: true } as Collective))
        ) {
          return null;
        }
        return contributor.collectiveSlug;
      },
    },
    account: {
      type: GraphQLAccount,
      async resolve(contributor, _, req): Promise<Collective | null> {
        const account = await req.loaders.Collective.byId.load(contributor.id);
        if (!account || !(await canSeePrivateAccount(req, account))) {
          return null;
        }
        return account;
      },
    },
    image: {
      type: GraphQLString,
      description: 'Contributor avatar or logo',
      deprecationReason: '2024-08-26: Use account.image instead',
      args: {
        height: { type: GraphQLInt },
        format: { type: GraphQLImageFormat },
      },
      resolve(contributor, args): string | null {
        if (!contributor.collectiveSlug) {
          return null;
        } else {
          return getCollectiveAvatarUrl(contributor.collectiveSlug, contributor.type, contributor.image, args);
        }
      },
    },
    publicMessage: {
      type: GraphQLString,
      description: 'A public message from contributors to describe their contributions',
    },
  }),
});
