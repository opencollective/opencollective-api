import { pick } from 'lodash';

import { invalidateContributorsCache } from '../../lib/contributors';
import models from '../../models';
import { Forbidden, NotFound, Unauthorized } from '../errors';
import { fetchAccountWithReference } from '../v2/input/AccountReferenceInput';

/** A mutation to edit the public message of all matching members. */
export async function editPublicMessage(_, { fromAccount, toAccount, FromCollectiveId, CollectiveId, message }, req) {
  if (!fromAccount && FromCollectiveId) {
    fromAccount = await req.loaders.Collective.byId.load(FromCollectiveId);
  }
  if (!toAccount && CollectiveId) {
    toAccount = await req.loaders.Collective.byId.load(CollectiveId);
  }

  if (!req.remoteUser || !req.remoteUser.isAdminOfCollective(fromAccount)) {
    throw new Unauthorized("You don't have the permission to edit member public message");
  }
  const [quantityUpdated, updatedMembers] = await models.Member.update(
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
  args: { collective; inviteMembers: [{ memberAccount?; memberInfo?; role; description?; since? }]; skipDefaultAdmin },
  req,
  options: { transaction?; supportedRoles?: [string]; collective? },
) {
  const collective = options.collective || (await fetchAccountWithReference(args.collective));
  if (args.inviteMembers.length > 30) {
    throw new Error('You exceeded the maximum number of invitations allowed at Collective creation.');
  }
  for (const inviteMember of args.inviteMembers) {
    if (!options.supportedRoles?.includes(inviteMember.role)) {
      throw new Forbidden('You can only invite accountants, admins, or members.');
    }
    let memberAccount;
    if (inviteMember.memberAccount) {
      memberAccount = await fetchAccountWithReference(inviteMember.memberAccount, { throwIfMissing: true });
    } else if (inviteMember.memberInfo) {
      let user = await models.User.findOne({
        where: { email: inviteMember.memberInfo.email.toLowerCase() },
        transaction: options.transaction,
      });
      if (!user) {
        const userData = pick(inviteMember.memberInfo, ['name', 'email']);
        user = await models.User.createUserWithCollective(userData, options.transaction);
      }
      memberAccount = await models.Collective.findByPk(user.CollectiveId, { transaction: options.transaction });
    }
    const memberParams = {
      ...pick(inviteMember, ['role', 'description', 'since']),
      MemberCollectiveId: memberAccount.id,
      CreatedByUserId: req.remoteUser.id,
    };
    await models.MemberInvitation.invite(collective, memberParams, {
      transaction: options.transaction,
      skipDefaultAdmin: args.skipDefaultAdmin,
    });
  }
}
