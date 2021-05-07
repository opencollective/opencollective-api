import { GraphQLInt, GraphQLList } from 'graphql';

import models from '../../../models';
import { Forbidden, ValidationFailed } from '../../errors';
import { MemberInvitation } from '../object/MemberInvitation';

const MemberInvitationsQuery = {
  type: new GraphQLList(MemberInvitation),
  description: '[AUTHENTICATED] Returns the pending invitations',
  args: {
    CollectiveId: { type: GraphQLInt },
    MemberCollectiveId: { type: GraphQLInt },
  },
  resolve(collective, args, { remoteUser }) {
    if (!remoteUser) {
      throw new Forbidden('Only collective admins can see pending invitations');
    }
    if (!args.CollectiveId && !args.MemberCollectiveId) {
      throw new ValidationFailed('You must either provide a CollectiveId or a MemberCollectiveId');
    }

    // Must be an admin to see pending invitations
    const isAdminOfCollective = args.CollectiveId && remoteUser.isAdmin(args.CollectiveId);
    const isAdminOfMemberCollective = args.MemberCollectiveId && remoteUser.isAdmin(args.MemberCollectiveId);
    if (!isAdminOfCollective && !isAdminOfMemberCollective) {
      new Forbidden('Only collective admins can see pending invitations');
    }

    type whereType = {
      CollectiveId?: typeof GraphQLInt;
      MemberCollectiveId?: typeof GraphQLInt;
    };
    const where: whereType = {};
    if (args.CollectiveId) {
      where.CollectiveId = args.CollectiveId;
    }
    if (args.MemberCollectiveId) {
      where.MemberCollectiveId = args.MemberCollectiveId;
    }

    return models.MemberInvitation.findAll({
      where,
      include: [
        { association: 'collective', required: true, attributes: [] },
        { association: 'memberCollective', required: true, attributes: [] },
      ],
    });
  },
};

export default MemberInvitationsQuery;
