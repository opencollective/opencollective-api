import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull } from 'graphql';

import { GraphQLMemberCollection } from '../collection/MemberCollection';
import { GraphQLAccountType } from '../enum/AccountType';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { GraphQLChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import MembersCollectionQuery from '../query/collection/MembersCollectionQuery';
import MemberInvitationsQuery from '../query/MemberInvitationsQuery';
import EmailAddress from '../scalar/EmailAddress';

export const HasMembersFields = {
  members: {
    description: 'Get all members (admins, members, backers, followers)',
    type: new GraphQLNonNull(GraphQLMemberCollection),
    args: {
      limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 100 },
      offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
      role: { type: new GraphQLList(GraphQLMemberRole) },
      accountType: { type: new GraphQLList(GraphQLAccountType) },
      email: {
        type: EmailAddress,
        description: 'Admin only. To filter on the email address of a member, useful to check if a member exists.',
      },
      orderBy: {
        type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
        defaultValue: { field: 'createdAt', direction: 'ASC' },
        description: 'Order of the results',
      },
      includeInherited: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
    },
    resolve(account, args, req) {
      return MembersCollectionQuery.resolve(null, { ...args, account }, req);
    },
  },
  memberInvitations: MemberInvitationsQuery,
};
