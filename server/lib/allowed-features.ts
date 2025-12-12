import { get, omit } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import FEATURE, { CommercialFeatures } from '../constants/feature';
import { freeFeatures } from '../constants/plans';
import PlatformConstants from '../constants/platform';
import { Forbidden } from '../graphql/errors';
import { Loaders } from '../graphql/loaders';
import { Collective, PlatformSubscription } from '../models';

type FEATURE_ACCESS = 'AVAILABLE' | 'DISABLED' | 'UNSUPPORTED';
enum FEATURE_ACCESS_PARTY {
  EVERYONE = 'EVERYONE',
  HOSTS = 'HOSTS',
  ACTIVE_ORGANIZATIONS = 'ACTIVE_ORGANIZATIONS',
  FIRST_PARTY_HOSTS = 'FIRST_PARTY_HOSTS',
  ACTIVE_ACCOUNTS = 'ACTIVE_ACCOUNTS',
  INDEPENDENT_COLLECTIVES = 'INDEPENDENT_COLLECTIVES',
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
 * Defines features access
 */
const FeaturesAccess: Partial<
  Record<
    FEATURE,
    {
      accountTypes?: readonly CollectiveType[];
      onlyAllowedFor?: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[];
      optIn?: true | 'legacy-pricing' | 'new-pricing';
      /** When the feature is opt-in, this defines who is enabled by default */
      enabledByDefaultFor?: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[];
      /** @deprecated To override the default data.features.${feature} flag. For retro-compatibility. */
      flagOverride?: string;
      /** If the feature is available in a specific country, this defines the country code */
      countries?: string[];
    }
  >
> = {
  [FEATURE.ALIPAY]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.AGREEMENTS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.HOSTS,
  },
  [FEATURE.CHARGE_HOSTING_FEES]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.HOSTS,
  },
  [FEATURE.CHART_OF_ACCOUNTS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.COLLECTIVE_GOALS]: {
    onlyAllowedFor: FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS,
    accountTypes: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.PROJECT],
    optIn: true,
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
  [FEATURE.EXPECTED_FUNDS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.EXPENSE_SECURITY_CHECKS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.HOST_DASHBOARD]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS],
  },
  [FEATURE.FUNDS_GRANTS_MANAGEMENT]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.TAX_FORMS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
    countries: ['US'],
  },
  [FEATURE.VENDORS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
  },
  [FEATURE.OFF_PLATFORM_TRANSACTIONS]: {
    optIn: 'legacy-pricing',
    enabledByDefaultFor: [FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS, FEATURE_ACCESS_PARTY.FIRST_PARTY_HOSTS],
    onlyAllowedFor: [
      FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS,
      FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS,
      FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES,
    ],
    accountTypes: [CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE],
  },
  [FEATURE.PAYPAL_DONATIONS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
    optIn: true,
    flagOverride: 'settings.features.paypalDonations',
  },
  [FEATURE.PAYPAL_PAYOUTS]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
    optIn: true,
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
    optIn: true,
    flagOverride: 'settings.apply',
  },
  [FEATURE.RECURRING_CONTRIBUTIONS]: {
    accountTypes: [CollectiveType.USER, CollectiveType.ORGANIZATION, CollectiveType.COLLECTIVE, CollectiveType.FUND],
  },
  [FEATURE.STRIPE_PAYMENT_INTENT]: {
    optIn: true,
    flagOverride: 'settings.features.stripePaymentIntent',
  },
  [FEATURE.TEAM]: {
    accountTypes: MULTI_ADMIN_ACCOUNT_TYPES,
  },
  [FEATURE.TOP_FINANCIAL_CONTRIBUTORS]: {
    accountTypes: [CollectiveType.COLLECTIVE, CollectiveType.ORGANIZATION, CollectiveType.FUND],
  },
  [FEATURE.TRANSFERWISE]: {
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS, FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES],
    flagOverride: 'settings.features.transferwise',
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
  [FEATURE.KYC]: {
    accountTypes: [CollectiveType.ORGANIZATION],
    onlyAllowedFor: [FEATURE_ACCESS_PARTY.FIRST_PARTY_HOSTS, FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS],
    optIn: true,
  },
} as const;

/**
 * Returns true if the feature is disabled for the account. This function only checks `collective.data`,
 * use `hasFeature` to properly check a feature activation.
 */
export const isFeatureBlockedForAccount = (collective: Collective, feature: FEATURE | `${FEATURE}`): boolean => {
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
      case FEATURE_ACCESS_PARTY.EVERYONE:
        return true;
      case FEATURE_ACCESS_PARTY.ACTIVE_ACCOUNTS:
        return collective.isActive;
      case FEATURE_ACCESS_PARTY.INDEPENDENT_COLLECTIVES:
        return collective.type === CollectiveType.COLLECTIVE && collective.isHostAccount && collective.isActive;
      case FEATURE_ACCESS_PARTY.FIRST_PARTY_HOSTS:
        return collective.isHostAccount && collective.data?.isFirstPartyHost;
      case FEATURE_ACCESS_PARTY.PLATFORM_ACCOUNTS:
        return PlatformConstants.CurrentPlatformCollectiveIds.includes(collective.id);
      case FEATURE_ACCESS_PARTY.ACTIVE_ORGANIZATIONS:
        return collective.type === CollectiveType.ORGANIZATION && collective.isHostAccount;
      case FEATURE_ACCESS_PARTY.HOSTS:
        return collective.isHostAccount && collective.hasHosting && collective.type === CollectiveType.ORGANIZATION;
    }
  });
};

const loadPLatformSubscription = (collectiveId: number, loaders?: Loaders) => {
  if (loaders) {
    return loaders.PlatformSubscription.currentByCollectiveId.load(collectiveId);
  } else {
    return PlatformSubscription.getCurrentSubscription(collectiveId);
  }
};

const loadHost = async (collective: Collective, loaders?: Loaders): Promise<Collective | null> => {
  if (collective.isHostAccount) {
    return collective;
  } else if (!collective.HostCollectiveId || !collective.isActive) {
    return null;
  } else if (collective.host) {
    return collective.host;
  } else if (loaders) {
    return loaders.Collective.byId.load(collective.HostCollectiveId);
  } else {
    return Collective.findByPk(collective.HostCollectiveId);
  }
};

const isPayingFeature = (feature: FEATURE | `${FEATURE}`): boolean => {
  return (
    (CommercialFeatures as readonly string[]).includes(feature) &&
    !(freeFeatures as readonly string[]).includes(feature)
  );
};

const hasOptInFlag = (
  collective: Collective,
  feature: FEATURE | `${FEATURE}`,
  {
    flagOverride,
    enabledByDefaultFor,
  }: { flagOverride?: string; enabledByDefaultFor?: FEATURE_ACCESS_PARTY | readonly FEATURE_ACCESS_PARTY[] },
): boolean => {
  if (get(collective, `data.features.${feature}`)) {
    return true;
  } else if (flagOverride && get(collective, flagOverride)) {
    return true;
  } else if (enabledByDefaultFor && checkFeatureAccessParty(collective, enabledByDefaultFor)) {
    return true;
  }

  return false;
};

type ErrorReason = 'BLOCKED' | 'PRICING' | 'ACCOUNT_TYPE' | 'NEED_HOST' | 'OPT_IN' | 'REGION';

/**
 * Returns the access level for a feature.
 *
 * @param collective - The collective to check the feature access for.
 * @param feature - The feature to check the access for.
 * @returns The access level for the feature.
 */
export const getFeatureAccess = async (
  collective: Collective,
  feature: FEATURE | `${FEATURE}`,
  {
    loaders = null,
  }: {
    /** Pass loader to optimize DB calls when available */
    loaders?: Loaders;
  } = {},
): Promise<{
  access: FEATURE_ACCESS;
  reason: ErrorReason | null;
}> => {
  if (!collective) {
    return { access: 'UNSUPPORTED', reason: null };
  } else if (isFeatureBlockedForAccount(collective, feature)) {
    return { access: 'DISABLED', reason: 'BLOCKED' };
  }

  // Enforce feature config
  const featureAccess = FeaturesAccess[feature];
  if (featureAccess) {
    // Account types
    if (featureAccess.accountTypes && !featureAccess.accountTypes.includes(collective.type)) {
      return { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' };
    }

    // Check opt-out flag
    if (
      get(collective, `data.features.${feature}`) === false ||
      (featureAccess.flagOverride && get(collective, featureAccess.flagOverride) === false)
    ) {
      return { access: 'DISABLED', reason: 'BLOCKED' };
    }

    // Check if only allowed for a specific party
    if (featureAccess.onlyAllowedFor && !checkFeatureAccessParty(collective, featureAccess.onlyAllowedFor)) {
      return { access: 'UNSUPPORTED', reason: 'ACCOUNT_TYPE' };
    }

    // Check general opt-in flag if true (which means, common to all plans)
    if (featureAccess.optIn === true && !hasOptInFlag(collective, feature, featureAccess)) {
      // Check if enabled by default
      if (featureAccess.enabledByDefaultFor && checkFeatureAccessParty(collective, featureAccess.enabledByDefaultFor)) {
        return { access: 'AVAILABLE', reason: null };
      } else {
        return { access: 'DISABLED', reason: 'OPT_IN' };
      }
    }

    // Check countries
    if (featureAccess?.countries && !featureAccess.countries.includes(collective.countryISO)) {
      return { access: 'UNSUPPORTED', reason: 'REGION' };
    }
  }

  // Check pricing
  if (isPayingFeature(feature) && !collective.isPlatformAccount()) {
    const host = await loadHost(collective, loaders);
    if (!host) {
      return { access: 'UNSUPPORTED', reason: 'NEED_HOST' };
    }

    // With legacy plans
    if (host.plan) {
      if (featureAccess?.optIn === 'legacy-pricing' && !hasOptInFlag(collective, feature, featureAccess)) {
        return { access: 'DISABLED', reason: 'OPT_IN' };
      } else {
        return { access: 'AVAILABLE', reason: null }; // Legacy plans don't support feature customization
      }
    }

    // Check if the feature is part of the host plan
    const subscription = await loadPLatformSubscription(collective.id, loaders);
    if (!subscription || !get(subscription, `plan.features.${feature}`)) {
      return { access: 'DISABLED', reason: 'PRICING' };
    } else if (featureAccess?.optIn === 'new-pricing' && !hasOptInFlag(collective, feature, featureAccess)) {
      return { access: 'DISABLED', reason: 'OPT_IN' };
    }
  }

  return { access: 'AVAILABLE', reason: null };
};

/**
 * A small wrapper around `getFeatureAccess` to check if a feature is available for a collective.
 */
export const hasFeature = async (
  collective: Collective,
  feature: FEATURE | `${FEATURE}`,
  { loaders }: { loaders?: Loaders } = {},
): Promise<boolean> => {
  const { access } = await getFeatureAccess(collective, feature, { loaders });
  return access === 'AVAILABLE';
};

export const getErrorMessageFromFeatureAccess = (access: FEATURE_ACCESS, reason: ErrorReason | null): string => {
  switch (access) {
    case 'UNSUPPORTED':
      return 'This feature is not supported for your account';
    case 'DISABLED':
      return reason === 'PRICING'
        ? 'This feature is not available in your current plan'
        : 'This feature is not enabled for your account';
  }
};

/**
 * A wrapper around `getFeatureAccess` that throws the right error (if any) based on the access level.
 */
export const checkFeatureAccess = async (
  collective: Collective,
  feature: FEATURE | `${FEATURE}`,
  { loaders }: { loaders?: Loaders } = {},
): Promise<void> => {
  const { access, reason } = await getFeatureAccess(collective, feature, { loaders });
  const error = getErrorMessageFromFeatureAccess(access, reason);
  if (error) {
    throw new Forbidden(error);
  }
};

export const getFeaturesAccessMap = async (
  collective: Collective,
  { loaders }: { loaders?: Loaders } = {},
): Promise<Record<Exclude<FEATURE, FEATURE.ALL>, { access: FEATURE_ACCESS; reason: ErrorReason | null }>> => {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(omit(FEATURE, FEATURE.ALL)).map(async ([feature]) => [
        feature,
        await getFeatureAccess(collective, feature as FEATURE, { loaders }),
      ]),
    ),
  );
};

export { FEATURE };
