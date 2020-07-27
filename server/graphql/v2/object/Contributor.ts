import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { getCollectiveAvatarUrl } from '../../../lib/collectivelib';
import { ContributorRoleEnum } from '../../v1/types';
import { ImageFormat } from '../enum';
import ISODateTime from '../scalar/ISODateTime';

export const Contributor = new GraphQLObjectType({
  name: 'Contributor',
  description: `
    A person or an entity that contributes financially or by any other mean to the mission
    of the collective. While "Member" is dedicated to permissions, this type is meant
    to surface all the public contributors.
  `,
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'A unique identifier for this member',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Name of the contributor',
    },
    roles: {
      type: new GraphQLList(ContributorRoleEnum),
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
      type: new GraphQLNonNull(ISODateTime),
      description: 'Member join date',
    },
    totalAmountDonated: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'How much money the user has contributed for this (in cents, using collective currency)',
    },
    type: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Wether the contributor is an individual, an organization...',
    },
    isIncognito: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'Defines if the contributors wants to be incognito (name not displayed)',
    },
    description: {
      type: GraphQLString,
      description: 'Description of how the member contribute. Will usually be a tier name, or "design" or "code".',
    },
    collectiveSlug: {
      type: GraphQLString,
      description: 'If the contributor has a page on Open Collective, this is the slug to link to it',
      resolve(contributor): Promise<string | null> {
        // Don't return the collective slug if the contributor wants to be incognito
        return contributor.isIncognito ? null : contributor.collectiveSlug;
      },
    },
    image: {
      type: GraphQLString,
      description: 'Contributor avatar or logo',
      args: {
        height: { type: GraphQLInt },
        format: { type: ImageFormat },
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
  },
});
