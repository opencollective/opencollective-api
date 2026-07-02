import type express from 'express';
import { GraphQLBoolean, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { EntityShortIdPrefix, isEntityMigratedToPublicId } from '../../../lib/permalink/entity-map';
import { canSeeAllPrivateAccounts } from '../../../lib/private-accounts';
import { Collective, Member } from '../../../models';
import { checkScope } from '../../common/scope-check';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { idEncode } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLAmount, GraphQLAmountFields } from '../object/Amount';
import { GraphQLTier } from '../object/Tier';

const getMemberFields = () => ({
  id: {
    type: new GraphQLNonNull(GraphQLString),
    resolve(member) {
      if (isEntityMigratedToPublicId(EntityShortIdPrefix.Member, member.createdAt)) {
        return member.publicId;
      } else {
        return idEncode(member.id, 'member');
      }
    },
  },
  publicId: {
    type: new GraphQLNonNull(GraphQLString),
    description: `The resource public id (ie: ${EntityShortIdPrefix.Member}_xxxxxxxx)`,
  },
  role: {
    type: new GraphQLNonNull(GraphQLMemberRole),
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
    type: new GraphQLNonNull(GraphQLDateTime),
    resolve(member) {
      return member.createdAt;
    },
  },
  updatedAt: {
    type: new GraphQLNonNull(GraphQLDateTime),
    resolve(member) {
      return member.updatedAt;
    },
  },
  since: {
    type: new GraphQLNonNull(GraphQLDateTime),
    resolve(member) {
      return member.since || member.createdAt;
    },
  },
  totalDonations: {
    type: new GraphQLNonNull(GraphQLAmount),
    description: 'Total amount donated',
    async resolve(member, args, req): Promise<GraphQLAmountFields> {
      const collective = await req.loaders.Collective.byId.load(member.CollectiveId);
      if (member.totalDonations) {
        return { value: member.totalDonations, currency: collective.currency };
      }

      const value = await req.loaders.Transaction.totalAmountDonatedFromTo.load({
        FromCollectiveId: member.MemberCollectiveId,
        CollectiveId: member.CollectiveId,
        currency: collective.currency,
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
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'If membership is inherited from parent collective',
    resolve(member) {
      // Fetching from dataValues because this is a virtual property that is generated at query time
      return Boolean(member.dataValues?.inherited);
    },
  },
  isActive: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Whether the membership is active. Warning: this definition is subject to change.',
    async resolve(member: Member, _, req: express.Request) {
      return req.loaders.Member.isActive.load(member.id);
    },
  },
});

const canSeeIncognitoMember = (req: express.Request, account: Collective, memberAccount: Collective): boolean => {
  return (
    req.remoteUser &&
    checkScope(req, 'incognito') &&
    (req.remoteUser.isAdminOfCollective(account) || req.remoteUser.isAdminOfCollective(memberAccount))
  );
};

const getMemberAccountResolver = field => async (member: Member, args, req: express.Request) => {
  const memberAccount = member.memberCollective || (await req.loaders.Collective.byId.load(member.MemberCollectiveId));
  const account = member.collective || (await req.loaders.Collective.byId.load(member.CollectiveId));
  const resolvedAccount = field === 'collective' ? account : memberAccount;
  if (!resolvedAccount) {
    return null;
  } else if (resolvedAccount.isIncognito && !canSeeIncognitoMember(req, account, memberAccount)) {
    return null;
  } else if (!(await canSeeAllPrivateAccounts(req, [memberAccount, account]))) {
    return null;
  }

  return resolvedAccount;
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
