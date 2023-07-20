import { get, isUndefined } from 'lodash-es';

import POLICIES, { DEFAULT_POLICIES, Policies } from '../constants/policies.js';

export const hasPolicy = async (collective, policy: POLICIES): Promise<boolean> => {
  let account = collective;
  if (collective?.ParentCollectiveId) {
    account = await collective.getParentCollective();
  }
  return !isUndefined(get(account, ['data', 'policies', policy]));
};

export const getPolicy = async <T extends POLICIES>(collective, policy: T): Promise<Policies[T]> => {
  let account = collective;
  if (collective?.ParentCollectiveId) {
    account = await collective.getParentCollective();
  }
  return get(account, ['data', 'policies', policy], DEFAULT_POLICIES[policy]);
};
