import { get, isUndefined } from 'lodash';

import POLICIES, { DEFAULT_POLICIES, Policies } from '../constants/policies';
import { Collective, User } from '../models';

export const hasPolicy = async (collective, policy: POLICIES): Promise<boolean> => {
  let account = collective;
  if (collective?.ParentCollectiveId) {
    account = await collective.getParentCollective();
  }
  return !isUndefined(get(account, ['data', 'policies', policy]));
};

export const getPolicy = async <T extends POLICIES>(
  collective,
  policy: T,
  { loaders = undefined } = {},
): Promise<Policies[T]> => {
  let account = collective;
  if (collective?.ParentCollectiveId) {
    if (loaders) {
      account = await loaders.Collective.byId.load(collective.ParentCollectiveId);
    } else {
      account = await collective.getParentCollective();
    }
  }
  return get(account, ['data', 'policies', policy], DEFAULT_POLICIES[policy]);
};

export const POLICIES_EDITABLE_BY_HOST_ONLY = [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS];

export const canEditPolicy = (user: User, collective: Collective, policy: POLICIES): boolean => {
  if (!user) {
    return false;
  } else if (POLICIES_EDITABLE_BY_HOST_ONLY.includes(policy)) {
    return user.isAdmin(collective.HostCollectiveId);
  } else {
    return user.isAdminOfCollective(collective);
  }
};
