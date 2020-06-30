import { get } from 'lodash';

import { types } from '../constants/collectives';
import FEATURE from '../constants/feature';

const FeatureAllowedForTypes = {
  [FEATURE.CONVERSATIONS]: [types.COLLECTIVE, types.ORGANIZATION],
  [FEATURE.CONTACT_FORM]: [types.COLLECTIVE, types.EVENT],
};

/**
 * A map of paths to retrieve the value of a feature flag from a collective
 */
export const OPT_OUT_FEATURE_FLAGS = {
  [FEATURE.CONTACT_FORM]: 'settings.features.contactForm',
};

/**
 * Returns true if feature is allowed for this collective type, false otherwise.
 */
export const isFeatureAllowedForCollectiveType = (collectiveType: keyof types, feature: FEATURE): boolean => {
  const allowedTypes = FeatureAllowedForTypes[feature];
  return allowedTypes ? allowedTypes.includes(collectiveType) : true;
};

export const hasOptedOutOfFeature = (collective, feature): boolean => {
  const optOutFlag = OPT_OUT_FEATURE_FLAGS[feature];
  return optOutFlag ? get(collective, optOutFlag) === false : false;
};

/**
 * Check if the given feature is activated for collective.
 */
const hasFeature = (collective, feature: FEATURE): boolean => {
  if (!collective) {
    return false;
  }

  // Check type
  if (!isFeatureAllowedForCollectiveType(collective.type, feature)) {
    return false;
  }

  // Check opt-out flags
  return !hasOptedOutOfFeature(collective, feature);
};

export default hasFeature;
