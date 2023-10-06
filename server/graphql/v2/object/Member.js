import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { checkScope } from '../../common/scope-check';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { idEncode } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLTier } from '../object/Tier';

const getMemberFields = () => ({
  // _internal_id: {
  //   type: GraphQLInt,
  //   resolve(member) {
  //     return member.id;
  //   },
  // },
  id: {
    type: GraphQLString,
    resolve(member) {
      return idEncode(member.id, 'member');
    },
  },
  role: {
    type: GraphQLMemberRole,
    resolve(member) {
      return member.role;
    },
  },
  tier: {
    type: GraphQLTier,
    resolve(member, args, req) {
      if (member.tier) {
        return member.tier;
      }
      if (member.TierId) {
        return req.loaders.Tier.byId.load(member.TierId);
      }
    },
  },
  createdAt: {
    type: GraphQLDateTime,
    resolve(member) {
      return member.createdAt;
    },
  },
  updatedAt: {
    type: GraphQLDateTime,
    resolve(member) {
      return member.updatedAt;
    },
  },
  since: {
    type: GraphQLDateTime,
    resolve(member) {
      return member.since;
    },
  },
  totalDonations: {
    type: new GraphQLNonNull(GraphQLAmount),
    description: 'Total amount donated',
    async resolve(member, args, req) {
      if (member.totalDonations) {
        return { value: member.totalDonations };
      }
      const collective = await req.loaders.Collective.byId.load(member.CollectiveId);
      const value = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: member.MemberCollectiveId,
        CollectiveId: member.CollectiveId,
      });
      return { value, currency: collective.currency };
    },
  },
  publicMessage: {
    type: GraphQLString,
    description: 'Custom user message from member to the collective',
    resolve(member) {
      return member.publicMessage;
    },
  },
  description: {
    type: GraphQLString,
    description: 'Custom user description',
    resolve(member) {
      return member.description;
    },
  },
  inherited: {
    type: GraphQLBoolean,
    description: 'If membership is inherited from parent collective',
    resolve(member) {
      // Fetching from dataValues because this is a virtual property that is generated at query time
      return member.dataValues?.inherited;
    },
  },
});

const getMemberAccountResolver = field => async (member, args, req) => {
  const memberAccount = member.memberCollective || (await req.loaders.Collective.byId.load(member.MemberCollectiveId));
  const account = member.collective || (await req.loaders.Collective.byId.load(member.CollectiveId));

  if (!account?.isIncognito || (req.remoteUser?.isAdmin(memberAccount.id) && checkScope(req, 'incognito'))) {
    return field === 'collective' ? account : memberAccount;
  }
};

export const GraphQLMember = new GraphQLObjectType({
  name: 'Member',
  description: 'This represents a Member relationship (ie: Organization backing a Collective)',
  fields: () => {
    return {
      ...getMemberFields(),
      account: {
        type: GraphQLAccount,
        resolve: getMemberAccountResolver('memberCollective'),
      },
    };
  },
});

export const GraphQLMemberOf = new GraphQLObjectType({
  name: 'MemberOf',
  description: 'This represents a MemberOf relationship (ie: Collective backed by an Organization)',
  fields: () => {
    return {
      ...getMemberFields(),
      account: {
        type: GraphQLAccount,
        resolve: getMemberAccountResolver('collective'),
      },
    };
  },
});
