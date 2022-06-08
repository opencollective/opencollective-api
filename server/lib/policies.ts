import { get, isUndefined } from 'lodash';

import POLICIES, { Policies } from '../constants/policies';

export const hasPolicy = (collective, policy: POLICIES): boolean => !isUndefined(getPolicy(collective, policy));

export const getPolicy = <T extends POLICIES>(collective, policy: T): Policies[T] =>
  get(collective, [collective, 'data', 'policies', policy]);
