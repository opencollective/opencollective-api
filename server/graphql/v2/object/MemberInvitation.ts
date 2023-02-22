import express from 'express';
import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLMemberRole } from '../enum/MemberRole';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';

import { GraphQLIndividual } from './Individual';
import { GraphQLTier } from './Tier';

export const GraphQLMemberInvitation = new GraphQLObjectType({
  name: 'MemberInvitation',
  description: 'An invitation to join the members of a collective',
  fields: () => {
    return {
      id: {
        type: new GraphQLNonNull(GraphQLString),
        resolve: getIdEncodeResolver(IDENTIFIER_TYPES.MEMBER_INVITATION),
      },
      inviter: {
        type: GraphQLIndividual,
        description: 'The person who invited the member, if any',
        resolve: async (member, _, req: express.Request): Promise<Record<string, unknown>> => {
          const collective = await req.loaders.Collective.byUserId.load(member.CreatedByUserId);
          if (!collective?.isIncognito) {
            return collective;
          }
        },
      },
      createdAt: {
        type: new GraphQLNonNull(GraphQLDateTime),
        resolve(member) {
          return member.createdAt;
        },
      },
      account: {
        type: new GraphQLNonNull(GraphQLAccount),
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.CollectiveId);
        },
      },
      memberAccount: {
        type: new GraphQLNonNull(GraphQLAccount),
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.MemberCollectiveId);
        },
      },
      role: {
        type: new GraphQLNonNull(GraphQLMemberRole),
        resolve(member) {
          return member.role;
        },
      },
      description: {
        type: GraphQLString,
        resolve(member) {
          return member.description;
        },
      },
      tier: {
        type: GraphQLTier,
        resolve(member, args, req) {
          return member.TierId && req.loaders.Tier.byId.load(member.TierId);
        },
      },
      since: {
        type: GraphQLDateTime,
        resolve(member) {
          return member.since;
        },
      },
    };
  },
});
