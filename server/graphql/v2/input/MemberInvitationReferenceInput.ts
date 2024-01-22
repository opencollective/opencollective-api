import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import MemberInvitation from '../../../models/MemberInvitation';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing MemberInvitations.
 */
export const GraphQLMemberInvitationReferenceInput = new GraphQLInputObjectType({
  name: 'MemberInvitationReferenceInput',
  fields: () => ({
    id: {
      type: GraphQLString,
      description: 'The public id identifying the member invitation (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the invitation (ie: 580)',
    },
  }),
});

export const fetchMemberInvitationWithReference = async (
  input,
  { throwIfMissing } = { throwIfMissing: false },
): Promise<any> => {
  let memberInvitation;
  if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.MEMBER_INVITATION);
    memberInvitation = await MemberInvitation.findByPk(id);
  } else if (input.legacyId) {
    memberInvitation = await MemberInvitation.findByPk(input.legacyId);
  } else {
    throw new Error('Please provide an id or a legacyId');
  }
  if (!memberInvitation && throwIfMissing) {
    throw new NotFound('MemberInvitation Not Found');
  }
  return memberInvitation;
};
