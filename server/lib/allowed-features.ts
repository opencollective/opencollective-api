import { get, omit } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import FEATURE from '../constants/feature';
import PlatformConstants from '../constants/platform';
import { Collective } from '../models';

type FEATURE_ACCESS = 'AVAILABLE' | 'DISABLED' | 'UNSUPPORTED';
enum FEATURE_ACCESS_PARTY {
  EVERYONE = 'EVERYONE',
  HOSTS = 'HOSTS',
  ACTIVE_ACCOUNTS = 'ACTIVE_ACCOUNTS',
  ACTIVE_HOSTS = 'ACTIVE_HOSTS',
  PLATFORM_ACCOUNTS = 'PLATFORM_ACCOUNTS',
}

/** Account types that are meant to be administrated by multiple admins */
const MULTI_ADMIN_ACCOUNT_TYPES = [
  CollectiveType.ORGANIZATION,
  CollectiveType.COLLECTIVE,
  CollectiveType.EVENT,
  CollectiveType.FUND,
  CollectiveType.PROJECT,
] as const;

/**
 * A new way to define feature access
 */
const FeaturesAccess: Partial<
  Record<
    FEATURE,
    {
      accountTypes?: readonly CollectiveType[];
      onlyAllowedFor?: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[];
      enabledByDefaultFor?: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[];
      isOptIn?: boolean;
      /** @deprecated To override the default data.features.${feature} flag. For retro-compatibility. */
      flagOverride?: string;
    }
  >
> = {
  [FEATURE.ALIPAY]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_HOSTS,
  },
  [FEATURE.COLLECTIVE_GOALS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS,
    accountTypes: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.PROJECT],
    isOptIn: true,
    flagOverride: 'settings.collectivePage.showGoals',
  },
  [FEATURE.CONTACT_FORM]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS,
    flagOverride: 'settings.features.contactForm',
    accountTypes: [
      CollectiveType.COLLECTIVE,
      CollectiveType.EVENT,
      CollectiveType.ORGANIZATION,
      CollectiveType.FUND,
      CollectiveType.PROJECT,
    ],
  },
  [FEATURE.CONVERSATIONS]: {
    accountTypes: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION],
  },
  [FEATURE.EVENTS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS,
    accountTypes: [CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE],
  },
  [FEATURE.HOST_DASHBOARD]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.HOSTS,
  },
  [FEATURE.OFF_PLATFORM_TRANSACTIONS]: {
    isOptIn: true,
    enabledByDefaultFor: FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS,
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_HOSTS, FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS],
    accountTypes: [CollectiveType.ORGANIZATION],
  },
  [FEATURE.PAYPAL_DONATIONS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_HOSTS,
    isOptIn: true,
    flagOverride: 'settings.features.paypalDonations',
  },
  [FEATURE.PAYPAL_PAYOUTS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_HOSTS,
    isOptIn: true,
    flagOverride: 'settings.features.paypalPayouts',
  },
  [FEATURE.PROJECTS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS,
    accountTypes: [CollectiveType.FUND, CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE],
  },
  [FEATURE.RECEIVE_EXPENSES]: {
    accountTypes: [
      CollectiveType.ORGANIZATION,
      CollectiveType.COLLECTIVE,
      CollectiveType.EVENT,
      CollectiveType.FUND,
      CollectiveType.PROJECT,
    ],
  },
  [FEATURE.RECEIVE_FINANCIAL_CONTRIBUTIONS]: {
    accountTypes: [
      CollectiveType.ORGANIZATION,
      CollectiveType.COLLECTIVE,
      CollectiveType.EVENT,
      CollectiveType.FUND,
      CollectiveType.PROJECT,
    ],
  },
  [FEATURE.RECEIVE_HOST_APPLICATIONS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.HOSTS,
    isOptIn: true,
    flagOverride: 'settings.apply',
  },
  [FEATURE.RECURRING_CONTRIBUTIONS]: {
    accountTypes: [CollectiveType.USER, CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE, CollectiveType.FUND],
  },
  [FEATURE.STRIPE_PAYMENT_INTENT]: {
    isOptIn: true,
    flagOverride: 'settings.features.stripePaymentIntent',
  },
  [FEATURE.TEAM]: {
    accountTypes: MULTI_ADMIN_ACCOUNT_TYPES,
  },
  [FEATURE.TOP_FINANCIAL_CONTRIBUTORS]: {
    accountTypes: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.FUND],
  },
  [FEATURE.TRANSFERWISE]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_HOSTS,
  },
  [FEATURE.UPDATES]: {
    accountTypes: [
      CollectiveType.COLLECTIVE,
      CollectiveType.ORGANIZATION,
      CollectiveType.FUND,
      CollectiveType.PROJECT,
      CollectiveType.EVENT,
    ],
  },
  [FEATURE.USE_EXPENSES]: {
    accountTypes: [
      CollectiveType.ORGANIZATION,
      CollectiveType.COLLECTIVE,
      CollectiveType.EVENT,
      CollectiveType.FUND,
      CollectiveType.PROJECT,
      CollectiveType.USER,
      CollectiveType.VENDOR,
    ],
  },
} as const;

/**
 * Returns true if the feature is disabled for the account. This function only checks `collective.data`,
 * use `hasFeature` to properly check a feature activation.
 */
export const isFeatureBlockedForAccount = (collective: Collective, feature: FEATURE): boolean => {
  return (
    get(collective, `data.features.${FEATURE.ALL}`) === false ||
    get(collective, `data.features.${feature}`) === false ||
    get(collective, `data.isSuspended`) === true
  );
};

const checkFeatureAccessParty = (
  collective: Collective,
  parties: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[] | undefined,
): boolean | undefined => {
  if (!parties) {
    return undefined;
  }

  const allParties = Array.isArray(parties) ? parties : [parties];
  return allParties.some(party => {
    switch (party) {
      case 'EVERYONE':
        return true;
      case 'ACTIVE_ACCOUNTS':
        return collective.isActive;
      case 'ACTIVE_HOSTS':
        return (
          collective.isHostAccount &&
          (collective.isActive || (collective.type === CollectiveType.USER && !collective.deactivatedAt)) // `isActive` is not used for host users
        );
      case 'PLATFORM_ACCOUNTS':
        return PlatformConstants.CurrentPlatformCollectiveIds.includes(collective.id);
      case 'HOSTS':
        return collective.isHostAccount;
    }
  });
};

/**
 * Returns the access level for a feature.
 *
 * @param collective - The collective to check the feature access for.
 * @param feature - The feature to check the access for.
 * @returns The access level for the feature.
 */
export const getFeatureAccess = (collective: Collective, feature: FEATURE): FEATURE_ACCESS => {
  if (!collective) {
    return 'UNSUPPORTED';
  } else if (isFeatureBlockedForAccount(collective, feature)) {
    return 'DISABLED';
  }

  // No config => feature is allowed by default
  const featureAccess = FeaturesAccess[feature];
  if (!featureAccess) {
    return 'AVAILABLE';
  }

  // Account types
  if (featureAccess.accountTypes && !featureAccess.accountTypes.includes(collective.type)) {
    return 'UNSUPPORTED';
  }

  // Check opt-out flag
  if (
    get(collective, `data.features.${feature}`) === false ||
    (featureAccess.flagOverride && get(collective, featureAccess.flagOverride) === false)
  ) {
    return 'DISABLED';
  }

  // Check if only allowed for a specific party
  if (featureAccess.onlyAllowedFor && !checkFeatureAccessParty(collective, featureAccess.onlyAllowedFor)) {
    return 'UNSUPPORTED';
  }

  // Check if enabled by default
  if (featureAccess.enabledByDefaultFor && checkFeatureAccessParty(collective, featureAccess.enabledByDefaultFor)) {
    return 'AVAILABLE';
  }

  // Check opt-in flag
  if (
    featureAccess.isOptIn &&
    !get(collective, `data.features.${feature}`) &&
    !(featureAccess.flagOverride && get(collective, featureAccess.flagOverride))
  ) {
    return 'DISABLED';
  }

  return 'AVAILABLE';
};

/**
 * A small wrapper around `getFeatureAccess` to check if a feature is available for a collective.
 */
export const hasFeature = (collective: Collective, feature: FEATURE): boolean => {
  return getFeatureAccess(collective, feature) === 'AVAILABLE';
};

export const getCollectiveFeaturesMap = (collective: Collective) => {
  return Object.fromEntries(
    Object.entries(omit(FEATURE, FEATURE.ALL)).map(([feature]) => [
      feature,
      getFeatureAccess(collective, feature as FEATURE),
    ]),
  ) as Record<Exclude<FEATURE, FEATURE.ALL>, FEATURE_ACCESS>;
};

export { FEATURE };
