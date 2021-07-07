import { GraphQLList } from 'graphql';

import models from '../../../models';
import { Forbidden, ValidationFailed } from '../../errors';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { MemberInvitation } from '../object/MemberInvitation';

const MemberInvitationsQuery = {
  type: new GraphQLList(MemberInvitation),
  description: '[AUTHENTICATED] Returns the pending invitations',
  args: {
    memberAccount: {
      type: AccountReferenceInput,
      description: 'Reference to an account of member to remove',
    },
    account: {
      type: AccountReferenceInput,
      description: 'Reference to the Collective account',
    },
  },
  async resolve(collective, args, { remoteUser }) {
    if (!remoteUser) {
      throw new Forbidden('Only collective admins can see pending invitations');
    }
    if (!args.account && !args.memberAccount) {
      throw new ValidationFailed('You must provide a reference either for collective or  member collective');
    }

    let { memberAccount, account } = args;

    if (account) {
      account = await fetchAccountWithReference(account, { throwIfMissing: true });
    }

    if (memberAccount) {
      memberAccount = await fetchAccountWithReference(memberAccount, { throwIfMissing: true });
    }

    // Must be an admin to see pending invitations
    const isAdminOfAccount = account && remoteUser.isAdminOfCollective(account);
    const isAdminOfMemberAccount = memberAccount && remoteUser.isAdminOfCollective(memberAccount);
    if (!isAdminOfAccount && !isAdminOfMemberAccount) {
      new Forbidden('Only collective admins can see pending invitations');
    }

    const where: Record<string, unknown> = {};
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
