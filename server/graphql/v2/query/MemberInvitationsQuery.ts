import { GraphQLList } from 'graphql';

import models, { Collective, Op, User } from '../../../models';
import { ValidationFailed } from '../../errors';
import { GraphQLMemberRole } from '../enum/MemberRole';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLMemberInvitation } from '../object/MemberInvitation';

/**
 * Users can see the pending invitations for an account in 3 cases:
 * - They're an admin of the profile
 * - They're an admin of the host of the profile
 * - The account has a pending application and user is an admin of the host
 */
const canViewMemberInvitationsForAccount = (account: Collective, remoteUser: User) => {
  if (!account) {
    return false;
  } else if (remoteUser.isAdminOfCollectiveOrHost(account)) {
    return true;
  } else if (account.HostCollectiveId) {
    // We're not looking at the `approvedAt` flag here on purpose
    return remoteUser.isAdmin(account.HostCollectiveId);
  }

  return false;
};

const MemberInvitationsQuery = {
  type: new GraphQLList(GraphQLMemberInvitation),
  description: 'Returns the pending invitations, or null if not allowed.',
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
      return null;
    }

    if (!(args.account || args.memberAccount || collective)) {
      throw new ValidationFailed('You must provide a reference either for collective or member collective');
    }

    const account =
      collective || (args.account && (await fetchAccountWithReference(args.account, { throwIfMissing: true })));
    const memberAccount =
      args.memberAccount && (await fetchAccountWithReference(args.memberAccount, { throwIfMissing: true }));

    // Must be an admin to see pending invitations
    const isAdminOfAccount = account && canViewMemberInvitationsForAccount(account, remoteUser);
    const isAdminOfMemberAccount = memberAccount && canViewMemberInvitationsForAccount(memberAccount, remoteUser);

    // If not admin of account or member account throw forbidden
    if (!(isAdminOfAccount || isAdminOfMemberAccount)) {
      return null;
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
