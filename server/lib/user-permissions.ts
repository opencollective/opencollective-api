/**
 * Defines what users are allowed to do on the platform.
 */

import FEATURE from '../constants/feature';
import models from '../models';
import User from '../models/User';

/**
 * Returns true if the given user can use the passed feature. Will always return false
 * if user is not set.
 */
export const canUseFeature = (account: User | typeof models.Collective, feature: FEATURE): boolean => {
  // Must be provided
  if (!account) {
    return false;
  }

  // Check if user is limited, globally or for this specific feature
  const userFeaturesFlags = account.data && account.data.features;
  if (userFeaturesFlags) {
    if (userFeaturesFlags.ALL === false || userFeaturesFlags[feature] === false) {
      return false;
    }
  }

  return true;
};

/**
 * Returns whether `user` is allowed to see `legalName` for an account. Legal names are always
 * publics for hosts, otherwise user needs to be an admin of the profile.
 * Some exceptions can be added to this rule depending on the context (ie. host admins can see the legal name
 * for the payees of expenses they have to treat). See `PERMISSION_TYPE.SEE_ACCOUNT_LEGAL_NAME`.
 */
export const canSeeLegalName = (user: User | null, account: typeof models.Collective | null): boolean => {
  return account?.isHostAccount || Boolean(user?.isAdminOfCollective(account));
};
