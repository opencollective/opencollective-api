import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLMemberRole } from '../enum';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';
import { GraphQLIndividualCreateInput } from './IndividualCreateInput';

export const GraphQLInviteMemberInput = new GraphQLInputObjectType({
  name: 'InviteMemberInput',
  fields: () => ({
    memberAccount: {
      type: GraphQLAccountReferenceInput,
      description: 'Reference to an account for the invitee',
    },
    memberInfo: {
      type: GraphQLIndividualCreateInput,
      description: 'Email and name of the invitee if no reference.',
    },
    role: {
      type: new GraphQLNonNull(GraphQLMemberRole),
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
