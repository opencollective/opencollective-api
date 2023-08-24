import { get } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import FEATURE from '../constants/feature';
import { Collective } from '../models';

const HOST_TYPES = [CollectiveType.USER, CollectiveType.ORGANIZATION];

// Please refer to and update https://docs.google.com/spreadsheets/d/15ppKaZJCXBjvY7-AjjCj3w5D-4ebLQdEowynJksgDXE/edit#gid=0
const FeatureAllowedForTypes = {
  [FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS]: [
    CollectiveType.ORGANIZATION,
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ],
  [FEATURE.RECURRING_CONTRIBUTIONS]: [
    CollectiveType.USER,
    CollectiveType.ORGANIZATION,
    CollectiveType.COLLECTIVE,
    CollectiveType.FUND,
  ],
  [FEATURE.RECEIVE_HOST_APPLICATIONS]: HOST_TYPES,
  [FEATURE.HOST_DASHBOARD]: HOST_TYPES,
  [FEATURE.EVENTS]: [CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE],
  [FEATURE.PROJECTS]: [CollectiveType.FUND, CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION],
  [FEATURE.USE_EXPENSES]: [
    CollectiveType.ORGANIZATION,
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ],
  [FEATURE.RECEIVE_EXPENSES]: [
    CollectiveType.ORGANIZATION,
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ],
  [FEATURE.COLLECTIVE_GOALS]: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.PROJECT],
  [FEATURE.TOP_FINANCIAL_CONTRIBUTORS]: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.FUND],
  [FEATURE.CONVERSATIONS]: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION],
  [FEATURE.UPDATES]: [
    CollectiveType.COLLECTIVE,
    CollectiveType.ORGANIZATION,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
    CollectiveType.EVENT,
  ],
  [FEATURE.TEAM]: [
    CollectiveType.ORGANIZATION,
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ],
  [FEATURE.CONTACT_FORM]: [
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.ORGANIZATION,
    CollectiveType.FUND,
    CollectiveType.PROJECT,
  ],
  [FEATURE.TRANSFERWISE]: [CollectiveType.ORGANIZATION],
  [FEATURE.PAYPAL_PAYOUTS]: [CollectiveType.ORGANIZATION],
  [FEATURE.PAYPAL_DONATIONS]: [CollectiveType.ORGANIZATION],
  [FEATURE.ALIPAY]: [CollectiveType.ORGANIZATION],
};

/**
 * A map of paths to retrieve the value of a feature flag from a collective
 */
export const OPT_OUT_FEATURE_FLAGS = {
  [FEATURE.CONTACT_FORM]: 'settings.features.contactForm',
};

export const OPT_IN_FEATURE_FLAGS = {
  [FEATURE.CROSS_CURRENCY_MANUAL_TRANSACTIONS]: 'settings.features.crossCurrencyManualTransactions',
  [FEATURE.COLLECTIVE_GOALS]: 'settings.collectivePage.showGoals',
  [FEATURE.PAYPAL_PAYOUTS]: 'settings.features.paypalPayouts',
  [FEATURE.PAYPAL_DONATIONS]: 'settings.features.paypalDonations',
  [FEATURE.RECEIVE_HOST_APPLICATIONS]: 'settings.apply',
  [FEATURE.EMAIL_NOTIFICATIONS_PANEL]: 'settings.features.emailNotificationsPanel',
  [FEATURE.STRIPE_PAYMENT_INTENT]: 'settings.features.stripePaymentIntent',
};

const FEATURES_ONLY_FOR_HOST_ORGS = new Set([
  FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS,
  FEATURE.USE_EXPENSES,
  FEATURE.RECEIVE_EXPENSES,
  FEATURE.RECEIVE_HOST_APPLICATIONS,
  FEATURE.TOP_FINANCIAL_CONTRIBUTORS,
  FEATURE.COLLECTIVE_GOALS,
  FEATURE.TRANSFERWISE,
  FEATURE.PAYPAL_PAYOUTS,
  FEATURE.PAYPAL_DONATIONS,
  FEATURE.PROJECTS,
  FEATURE.ALIPAY,
  FEATURE.CONTACT_FORM,
  FEATURE.HOST_DASHBOARD,
  FEATURE.EVENTS,
  FEATURE.UPDATES,
  FEATURE.CONVERSATIONS,
]);

const FEATURES_ONLY_FOR_HOST_USERS = new Set([FEATURE.RECEIVE_HOST_APPLICATIONS, FEATURE.HOST_DASHBOARD]);

const FEATURES_ONLY_FOR_ACTIVE_ACCOUNTS = new Set([FEATURE.CONTACT_FORM]);

const FEATURES_ONLY_FOR_ACTIVE_HOSTS = new Set([
  FEATURE.RECEIVE_EXPENSES,
  FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS,
  FEATURE.EVENTS,
]);

/**
 * Returns true if feature is allowed for this collective type, false otherwise.
 */
export const isFeatureAllowedForCollectiveType = (
  collectiveType: CollectiveType,
  feature: FEATURE,
  isHost?: boolean,
): boolean => {
  const allowedTypes = FeatureAllowedForTypes[feature];
  const allowedForType = allowedTypes ? allowedTypes.includes(collectiveType) : true;

  if (!allowedForType) {
    return false;
  }

  // Check if allowed for host orgs but not normal orgs
  if (collectiveType === CollectiveType.ORGANIZATION && FEATURES_ONLY_FOR_HOST_ORGS.has(feature) && !isHost) {
    return false;
  } else if (collectiveType === CollectiveType.USER && FEATURES_ONLY_FOR_HOST_USERS.has(feature) && !isHost) {
    return false;
  }

  return true;
};

export const hasOptedOutOfFeature = (collective: Collective, feature: FEATURE): boolean => {
  const optOutFlag = OPT_OUT_FEATURE_FLAGS[feature];
  return optOutFlag ? get(collective, optOutFlag) === false : false;
};

export const hasOptedInForFeature = (collective: Collective, feature: FEATURE): boolean => {
  const optInFlag = OPT_IN_FEATURE_FLAGS[feature];
  return get(collective, optInFlag) === true;
};

/**
 * If a given feature is allowed for the collective type, check if it is activated for collective.
 */
export const hasFeature = (collective: Collective, feature: FEATURE): boolean => {
  if (!collective) {
    return false;
  } else if (get(collective, `data.features.${FEATURE.ALL}`) === false) {
    return false;
  }

  if (!isFeatureAllowedForCollectiveType(collective.type, feature, collective.isHostAccount)) {
    return false;
  }

  // Features only for active accounts
  if (!collective.isActive && FEATURES_ONLY_FOR_ACTIVE_ACCOUNTS.has(feature)) {
    return false;
  } else if (!collective.isActive && collective.isHostAccount && FEATURES_ONLY_FOR_ACTIVE_HOSTS.has(feature)) {
    return false;
  }

  // Check opt-out flags
  if (feature in OPT_OUT_FEATURE_FLAGS) {
    return !hasOptedOutOfFeature(collective, feature);
  }

  // Check opt-in flags
  if (feature in OPT_IN_FEATURE_FLAGS) {
    return hasOptedInForFeature(collective, feature);
  }

  return get(collective, `data.features.${feature}`, true);
};

export { FEATURE };
