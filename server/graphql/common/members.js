import { invalidateContributorsCache } from '../../lib/contributors';
import models from '../../models';
import { NotFound, Unauthorized } from '../errors';

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
