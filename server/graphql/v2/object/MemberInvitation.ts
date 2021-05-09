import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';

import { MemberRole } from '../enum/MemberRole';
import { Account } from '../interface/Account';

import { Tier } from './Tier';

export const MemberInvitation = new GraphQLObjectType({
  name: 'MemberInvitation',
  description: 'An invitation to join the members of a collective',
  fields: () => {
    return {
      id: {
        type: GraphQLInt,
        resolve(member) {
          return member.id;
        },
      },
      createdAt: {
        type: GraphQLDateTime,
        resolve(member) {
          return member.createdAt;
        },
      },
      collective: {
        type: Account,
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.CollectiveId);
        },
      },
      member: {
        type: Account,
        resolve(member, args, req) {
          return req.loaders.Collective.byId.load(member.MemberCollectiveId);
        },
      },
      role: {
        type: MemberRole,
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
        type: Tier,
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
