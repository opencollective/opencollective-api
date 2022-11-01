import { get, isUndefined } from 'lodash';

import POLICIES, { DEFAULT_POLICIES, Policies } from '../constants/policies';

export const hasPolicy = (collective, policy: POLICIES): boolean =>
  !isUndefined(get(collective, ['data', 'policies', policy]));

export const getPolicy = <T extends POLICIES>(collective, policy: T): Policies[T] =>
  get(collective, ['data', 'policies', policy], DEFAULT_POLICIES[policy]);
