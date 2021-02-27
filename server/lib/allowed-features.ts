import { get } from 'lodash';

import { types } from '../constants/collectives';
import FEATURE from '../constants/feature';

const FeatureAllowedForTypes = {
  [FEATURE.CONVERSATIONS]: [types.COLLECTIVE, types.ORGANIZATION],
  [FEATURE.RECEIVE_EXPENSES]: [types.COLLECTIVE, types.EVENT],
  [FEATURE.UPDATES]: [types.COLLECTIVE, types.ORGANIZATION],
};

/**
 * A map of paths to retrieve the value of a feature flag from a collective
 */
export const OPTIN_FEATURE_FLAGS = {
  [FEATURE.CONVERSATIONS]: 'settings.features.conversations',
  [FEATURE.COLLECTIVE_GOALS]: 'settings.collectivePage.showGoals',
  [FEATURE.UPDATES]: 'settings.features.updates',
  [FEATURE.TRANSFERWISE]: 'settings.features.transferwise',
  [FEATURE.PAYPAL_PAYOUTS]: 'settings.features.paypalPayouts',
};

/**
 * Returns true if feature is allowed for this collective type, false otherwise.
 */
export const isFeatureAllowedForCollectiveType = (
  collectiveType: types,
  isHost: boolean,
  feature: FEATURE,
): boolean => {
  // Check if allowed for type
  const allowedTypes = FeatureAllowedForTypes[feature];
  const allowedForType = allowedTypes ? allowedTypes.includes(collectiveType) : true;
  if (!allowedForType) {
    return false;
  }

  // Check if allowed for hosts
  if (feature === FEATURE.TRANSFERWISE && !isHost) {
    return false;
  }

  return true;
};

/**
 * Check if the given feature is activated for collective.
 */
export const hasFeature = (collective, feature: FEATURE): boolean => {
  if (!collective) {
    return false;
  }

  // Allow Host Collectives to receive expenses
  if (feature === FEATURE.RECEIVE_EXPENSES && collective.isHostAccount) {
    return true;
  }

  // Check collective type
  if (!isFeatureAllowedForCollectiveType(collective.type, collective.isHostAccount, feature)) {
    return false;
  }

  // Check opt-in flags
  const activationFlag = OPTIN_FEATURE_FLAGS[feature];
  if (activationFlag) {
    return Boolean(get(collective, activationFlag, false));
  }

  switch (feature) {
    case FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS:
      return (
        (collective.isActive && collective.type === types.COLLECTIVE) ||
        (collective.isHost && collective.type === types.ORGANIZATION)
      );
    default:
      return true;
  }
};

export default hasFeature;
