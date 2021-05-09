import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { MemberRole } from '../enum/MemberRole';
import ISODateTime from '../scalar/ISODateTime';

import { AccountReferenceInput } from './AccountReferenceInput';

export const MemberInvitationInput = new GraphQLInputObjectType({
  name: 'MemberInvitationInput',
  description: 'Input to invite a member',
  fields: () => ({
    memberAccount: {
      type: GraphQLNonNull(AccountReferenceInput),
      description: 'Reference to an account for the invitee',
    },
    account: {
      type: GraphQLNonNull(AccountReferenceInput),
      description: 'Reference to an account for the inviting Collective',
    },
    role: {
      type: MemberRole,
      description: 'Role of the invitee',
    },
    description: {
      type: GraphQLString,
    },
    since: {
      type: ISODateTime,
    },
  }),
});
