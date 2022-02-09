import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { MemberRole } from '../enum';

import { AccountReferenceInput } from './AccountReferenceInput';
import { IndividualCreateInput } from './IndividualCreateInput';

export const InviteMemberInput = new GraphQLInputObjectType({
  name: 'InviteMemberInput',
  fields: () => ({
    memberAccount: {
      type: AccountReferenceInput,
      description: 'Reference to an account for the invitee',
    },
    memberInfo: {
      type: IndividualCreateInput,
      description: 'Email and name of the invitee if no reference.',
    },
    role: {
      type: new GraphQLNonNull(MemberRole),
      description: 'Role of the invitee',
    },
    description: {
      type: GraphQLString,
    },
    since: {
      type: GraphQLDateTime,
    },
  }),
});
