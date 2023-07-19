import { GraphQLList } from 'graphql';

import models, { Op } from '../../../models/index.js';
import { Forbidden, ValidationFailed } from '../../errors.js';
import { GraphQLMemberRole } from '../enum/MemberRole.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { GraphQLMemberInvitation } from '../object/MemberInvitation.js';

const MemberInvitationsQuery = {
  type: new GraphQLList(GraphQLMemberInvitation),
  description: '[AUTHENTICATED] Returns the pending invitations',
  args: {
    memberAccount: {
      type: GraphQLAccountReferenceInput,
      description:
        'A reference to an account (usually Individual). Will return invitations sent to the account to join as a member',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description:
        'A reference to an account (usually Collective, Fund or Organization). Will return invitations sent to join this account as a member.',
    },
    role: {
      type: new GraphQLList(GraphQLMemberRole),
      description: 'An array of Member roles to filter for',
    },
  },
  async resolve(collective, args, { remoteUser }) {
    if (!remoteUser) {
      throw new Forbidden('Only collective admins can see pending invitations');
    }

    if (!(args.account || args.memberAccount || collective)) {
      throw new ValidationFailed('You must provide a reference either for collective or member collective');
    }

    const account =
      collective || (args.account && (await fetchAccountWithReference(args.account, { throwIfMissing: true })));
    const memberAccount =
      args.memberAccount && (await fetchAccountWithReference(args.memberAccount, { throwIfMissing: true }));

    // Must be an admin to see pending invitations
    const isAdminOfAccount = account && remoteUser.isAdminOfCollective(account);
    const isAdminOfMemberAccount = memberAccount && remoteUser.isAdminOfCollective(memberAccount);

    // If not admin of account or member account throw forbidden
    if (!(isAdminOfAccount || isAdminOfMemberAccount)) {
      new Forbidden('Only collective admins can see pending invitations');
    }

    const where = {};
    if (account?.id) {
      where['CollectiveId'] = account.id;
    }
    if (memberAccount?.id) {
      where['MemberCollectiveId'] = memberAccount.id;
    }
    if (args.role) {
      where['role'] = { [Op.in]: args.role };
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
