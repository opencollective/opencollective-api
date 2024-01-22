import { pick } from 'lodash';

import { invalidateContributorsCache } from '../../lib/contributors';
import twoFactorAuthLib from '../../lib/two-factor-authentication';
import { Collective, Member, MemberInvitation, User } from '../../models';
import { Forbidden, NotFound, Unauthorized } from '../errors';
import { fetchAccountWithReference } from '../v2/input/AccountReferenceInput';

import { checkRemoteUserCanUseAccount } from './scope-check';

/** A mutation to edit the public message of all matching members. */
export async function editPublicMessage(
  _,
  { fromAccount, toAccount, FromCollectiveId = null, CollectiveId = null, message },
  req,
) {
  checkRemoteUserCanUseAccount(req);

  if (!fromAccount && FromCollectiveId) {
    fromAccount = await req.loaders.Collective.byId.load(FromCollectiveId);
  }
  if (!toAccount && CollectiveId) {
    toAccount = await req.loaders.Collective.byId.load(CollectiveId);
  }

  if (!req.remoteUser.isAdminOfCollective(fromAccount)) {
    throw new Unauthorized("You don't have the permission to edit member public message");
  }

  await twoFactorAuthLib.enforceForAccount(req, fromAccount, { onlyAskOnLogin: true });

  const [quantityUpdated, updatedMembers] = await Member.update(
    {
      publicMessage: message,
    },
    {
      returning: true,
      where: {
        MemberCollectiveId: fromAccount.id,
        CollectiveId: toAccount.id,
      },
    },
  );
  if (quantityUpdated === 0) {
    throw new NotFound('No member found');
  }

  /**
   * After updating the public message it is necessary to update the cache
   * used in the collective page. Member's `afterUpdate` hook is not triggered here
   * because we don't update the model directly (we use Model.update(..., {where})).
   */
  invalidateContributorsCache(toAccount.id);
  return updatedMembers;
}

export async function processInviteMembersInput(
  collective: Collective,
  inviteMemberInputs: [{ memberAccount?; memberInfo?; role; description?; since? }],
  options: { skipDefaultAdmin?; transaction?; supportedRoles?: [string]; user? },
) {
  if (inviteMemberInputs.length > 30) {
    throw new Error('You exceeded the maximum number of invitations allowed at Collective creation.');
  }

  for (const inviteMember of inviteMemberInputs) {
    if (!options.supportedRoles?.includes(inviteMember.role)) {
      throw new Forbidden('You can only invite accountants, admins, or members.');
    }

    let memberAccount;
    if (inviteMember.memberAccount) {
      memberAccount = await fetchAccountWithReference(inviteMember.memberAccount, { throwIfMissing: true });
    } else if (inviteMember.memberInfo) {
      let user = await User.findOne({
        where: { email: inviteMember.memberInfo.email.toLowerCase() },
        transaction: options.transaction,
      });
      if (!user) {
        const userData = pick(inviteMember.memberInfo, ['name', 'email']);
        user = await User.createUserWithCollective(userData, options.transaction);
      }
      memberAccount = await Collective.findByPk(user.CollectiveId, { transaction: options.transaction });
    }

    const memberParams = {
      ...pick(inviteMember, ['role', 'description', 'since']),
      MemberCollectiveId: memberAccount.id,
      CreatedByUserId: options.user?.id,
    };
    await MemberInvitation.invite(collective, memberParams, {
      transaction: options.transaction,
      skipDefaultAdmin: options.skipDefaultAdmin,
    });
  }
}
