import { GraphQLInputObjectType, GraphQLInt, GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';

/**
 * An input for referencing MemberInvitations.
 */
export const GraphQLMemberInvitationReferenceInput = new GraphQLInputObjectType({
  name: 'MemberInvitationReferenceInput',
  fields: () => ({
    publicId: {
      type: GraphQLString,
      description: `The resource public id (ie: ${models.MemberInvitation.nanoIdPrefix}_xxxxxxxx)`,
    },
    id: {
      type: GraphQLString,
      description: 'The public id identifying the member invitation (ie: dgm9bnk8-0437xqry-ejpvzeol-jdayw5re)',
      deprecationReason: '2026-02-25: use publicId',
    },
    legacyId: {
      type: GraphQLInt,
      description: 'The internal id of the invitation (ie: 580)',
      deprecationReason: '2026-02-25: use publicId',
    },
  }),
});

export const fetchMemberInvitationWithReference = async (
  input,
  { throwIfMissing } = { throwIfMissing: false },
): Promise<any> => {
  let memberInvitation;
  if (input.publicId) {
    const expectedPrefix = models.MemberInvitation.nanoIdPrefix;
    if (!input.publicId.startsWith(`${expectedPrefix}_`)) {
      throw new Error(`Invalid publicId for MemberInvitation, expected prefix ${expectedPrefix}_`);
    }

    memberInvitation = await models.MemberInvitation.findOne({ where: { publicId: input.publicId } });
  } else if (input.id) {
    const id = idDecode(input.id, IDENTIFIER_TYPES.MEMBER_INVITATION);
    memberInvitation = await models.MemberInvitation.findByPk(id);
  } else if (input.legacyId) {
    memberInvitation = await models.MemberInvitation.findByPk(input.legacyId);
  } else {
    throw new Error('Please provide an id or a legacyId');
  }
  if (!memberInvitation && throwIfMissing) {
    throw new NotFound('MemberInvitation Not Found');
  }
  return memberInvitation;
};
