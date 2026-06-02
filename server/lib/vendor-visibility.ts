import { compact, uniq } from 'lodash';
import { Op } from 'sequelize';

import POLICIES, { UseVendorPolicyValue } from '../constants/policies';
import models, { Collective, User } from '../models';

import { getPolicy } from './policies';

/**
 * Whether a vendor can be attributed financial activity under this collective
 */
export function isVendorScopedToCollective(vendor: Collective, collective: Collective): boolean {
  const ids = vendor.data?.canBeUsedWithAccountIds ?? [];
  if (ids.length === 0) {
    return true;
  }
  if (ids.includes(collective.id)) {
    return true;
  }
  return collective.ParentCollectiveId !== null && ids.includes(collective.ParentCollectiveId);
}

/**
 * Resolve the `UseVendorPolicyValue` by host policy of vendor overwrite
 */
export function getEffectiveUseVendorPolicy(
  vendor: Collective,
  hostPolicy: UseVendorPolicyValue,
): UseVendorPolicyValue {
  return vendor.data?.useVendorPolicy ?? hostPolicy;
}

/**
 * Whether the remote user is allowed to attribute a financial activity
 * to the given vendor on the given collective.
 *
 */
export async function canUserUseVendor({
  remoteUser,
  vendor,
  collective,
  host,
  loaders,
}: {
  remoteUser: User;
  vendor: Collective;
  collective: Collective;
  host: Collective;
  loaders?: Express.Request['loaders'];
}): Promise<boolean> {
  if (remoteUser.isAdminOfCollective(host)) {
    return true;
  }

  if (!isVendorScopedToCollective(vendor, collective)) {
    return false;
  }

  const hostPolicy = await getPolicy(host, POLICIES.USE_VENDOR_POLICY, { loaders });
  const policy = getEffectiveUseVendorPolicy(vendor, hostPolicy);

  if (policy === UseVendorPolicyValue.ALL_SUBMITTERS) {
    return true;
  }
  if (policy === UseVendorPolicyValue.HOST_ADMINS) {
    return false;
  }
  if (policy === UseVendorPolicyValue.HOST_AND_COLLECTIVE_ADMINS) {
    return remoteUser.isAdminOfCollective(collective);
  }

  return false;
}

/**
 * Expand a list of account IDs to also include their parent collective IDs.
 */
export async function expandAccountIdsWithParents(accountIds: number[]): Promise<number[]> {
  if (!accountIds?.length) {
    return [];
  }
  const parentRows = await models.Collective.findAll({
    where: {
      id: accountIds,
      ParentCollectiveId: { [Op.ne]: null },
    },
    attributes: ['ParentCollectiveId'],
  });
  return uniq(compact([...accountIds, ...parentRows.map(p => p.ParentCollectiveId)]));
}
